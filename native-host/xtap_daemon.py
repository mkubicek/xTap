#!/usr/bin/env python3
"""xTap HTTP Daemon — runs as a system service (launchd/systemd/Scheduled Task)."""

import hmac
import json
import os
import platform
import signal
import sys
import time
import uuid
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from xtap_core import (DEFAULT_OUTPUT_DIR, load_seen_ids, resolve_output_dir,
                       validate_output_dir, write_tweets, write_log,
                       write_dump, test_path,
                       check_ytdlp, start_download, get_download_status)

VERSION = '0.19.1'
BIND_HOST = '127.0.0.1'
BIND_PORT = 17381
MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB
XTAP_DIR = os.path.expanduser('~/.xtap')
XTAP_SECRET = os.path.join(XTAP_DIR, 'secret')

# Log level: 'info' (default) or 'debug'
LOG_LEVEL = os.environ.get('XTAP_LOG_LEVEL', 'info').lower()


def log_info(msg):
    print(msg, file=sys.stderr)


def log_debug(msg):
    if LOG_LEVEL == 'debug':
        print(f'[DEBUG] {msg}', file=sys.stderr)


def load_token():
    try:
        with open(XTAP_SECRET, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        log_info(f'FATAL: {XTAP_SECRET} not found. Run install.sh first.')
        sys.exit(1)


# Module-level state shared across requests
_token = None
_seen_ids = set()
_custom_dirs = set()
_state_lock = threading.Lock()


class DaemonHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log to stderr (captured by launchd/systemd)
        log_info(f'{self.client_address[0]} - {format % args}')

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)
        log_debug(f'  -> {status} ({len(body)} bytes)')

    def _read_json(self, length):
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def _check_auth(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], _token):
            log_debug(f'  Auth failed (header {"present" if auth else "missing"})')
            self._send_json({'ok': False, 'error': 'Unauthorized'}, 401)
            return False
        return True

    def do_GET(self):
        log_debug(f'GET {self.path}')
        if self.path == '/status':
            self._send_json({'ok': True, 'version': VERSION})
            return
        self._send_json({'ok': False, 'error': 'Not found'}, 404)

    def _validate_content_length(self):
        """Validate Content-Length header. Returns length or -1 on error (response already sent)."""
        raw = self.headers.get('Content-Length')
        if raw is None:
            self._send_json({'ok': False, 'error': 'Missing Content-Length header'}, 400)
            return -1
        try:
            length = int(raw)
        except ValueError:
            self._send_json({'ok': False, 'error': f'Invalid Content-Length: {raw!r}'}, 400)
            return -1
        if length < 0:
            self._send_json({'ok': False, 'error': 'Content-Length must not be negative'}, 400)
            return -1
        if length > MAX_BODY_SIZE:
            self._send_json({'ok': False, 'error': 'Payload too large'}, 413)
            return -1
        return length

    def do_POST(self):
        log_debug(f'POST {self.path} (Content-Length: {self.headers.get("Content-Length", "?")})')

        length = self._validate_content_length()
        if length < 0:
            return

        if not self._check_auth():
            return

        try:
            body = self._read_json(length)
        except (json.JSONDecodeError, ValueError) as e:
            self._send_json({'ok': False, 'error': f'Invalid JSON: {e}'}, 400)
            return

        t0 = time.monotonic()
        if self.path == '/tweets':
            self._handle_tweets(body)
        elif self.path == '/log':
            self._handle_log(body)
        elif self.path == '/dump':
            self._handle_dump(body)
        elif self.path == '/test-path':
            self._handle_test_path(body)
        elif self.path == '/check-ytdlp':
            self._handle_check_ytdlp(body)
        elif self.path == '/download-video':
            self._handle_download_video(body)
        elif self.path == '/download-status':
            self._handle_download_status(body)
        else:
            self._send_json({'ok': False, 'error': 'Not found'}, 404)
        elapsed = (time.monotonic() - t0) * 1000
        log_debug(f'  Completed in {elapsed:.1f}ms')

    def _handle_tweets(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            with _state_lock:
                out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
                tweets = body.get('tweets', [])
                count, dupes = write_tweets(tweets, out_dir, _seen_ids)
            log_debug(f'  Tweets: {count} written, {dupes} dupes -> {out_dir}')
            self._send_json({'ok': True, 'count': count, 'dupes': dupes})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /tweets: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_log(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            with _state_lock:
                out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
            lines = body.get('lines', [])
            logged = write_log(lines, out_dir)
            self._send_json({'ok': True, 'logged': logged})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /log: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_dump(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            with _state_lock:
                out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
                filename = body.get('filename', 'dump.json')
                content = body.get('content', '')
                path = write_dump(filename, content, out_dir)
            self._send_json({'ok': True, 'path': path})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /dump: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_test_path(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            if not msg_dir:
                self._send_json({'ok': False, 'error': 'outputDir is required'}, 400)
                return
            out_dir = validate_output_dir(os.path.expanduser(msg_dir))
            test_path(out_dir)
            self._send_json({'ok': True, 'type': 'TEST_PATH'})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /test-path: {e}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_check_ytdlp(self, body):
        available = check_ytdlp()
        log_debug(f'  yt-dlp available: {available}')
        self._send_json({'ok': True, 'available': available})

    def _handle_download_video(self, body):
        try:
            tweet_url = body.get('tweetUrl', '')
            direct_url = body.get('directUrl', '')
            post_date = body.get('postDate', '')
            msg_dir = body.get('outputDir', '').strip()
            with _state_lock:
                out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
            download_id = str(uuid.uuid4())
            start_download(download_id, tweet_url, direct_url, out_dir, post_date)
            log_debug(f'  Download started: {download_id} -> {tweet_url}')
            self._send_json({'ok': True, 'downloadId': download_id})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /download-video: {e}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_download_status(self, body):
        download_id = body.get('downloadId', '')
        status = get_download_status(download_id)
        self._send_json({'ok': True, **status})


def _format_exc():
    import traceback
    return traceback.format_exc().replace('\n', ' | ')


def _setup_stdio():
    """Redirect stdio to log files when running under pythonw (no console)."""
    if sys.stderr is not None and sys.stdout is not None:
        return
    os.makedirs(XTAP_DIR, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(os.path.join(XTAP_DIR, 'daemon-stdout.log'), 'a')
    if sys.stderr is None:
        sys.stderr = open(os.path.join(XTAP_DIR, 'daemon-stderr.log'), 'a')


def _log_startup_diagnostics():
    """Log system and configuration info on startup."""
    log_info(f'xTap daemon v{VERSION}')
    log_info(f'  Python:     {sys.version.split(chr(10))[0]}')
    log_info(f'  Executable: {sys.executable}')
    log_info(f'  Script:     {os.path.abspath(__file__)}')
    log_info(f'  Platform:   {platform.system()} {platform.release()}')
    log_info(f'  Output dir: {DEFAULT_OUTPUT_DIR}')
    log_info(f'  Token:      loaded ({len(_token)} chars)')
    log_info(f'  Log level:  {LOG_LEVEL}')

    # Check output dir writability
    try:
        test_path(DEFAULT_OUTPUT_DIR)
        log_info(f'  Output dir: writable')
    except Exception as e:
        log_info(f'  Output dir: NOT writable ({e})')

    # Check yt-dlp
    ytdlp = check_ytdlp()
    log_info(f'  yt-dlp:     {"available" if ytdlp else "not found"}')


def main():
    global _token, _seen_ids

    _setup_stdio()

    _token = load_token()

    # Initialize output directory and seen IDs
    os.makedirs(DEFAULT_OUTPUT_DIR, exist_ok=True)
    _seen_ids = load_seen_ids(DEFAULT_OUTPUT_DIR)

    _log_startup_diagnostics()
    log_info(f'  Seen IDs:   {len(_seen_ids)} loaded')

    try:
        server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), DaemonHandler)
    except OSError as e:
        log_info(f'FATAL: Cannot bind to {BIND_HOST}:{BIND_PORT} — {e}')
        log_info(f'  Is another instance already running?')
        sys.exit(1)

    def shutdown(signum, frame):
        log_info(f'Received signal {signum}, shutting down...')
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    if platform.system() == 'Windows':
        signal.signal(signal.SIGBREAK, shutdown)
    else:
        signal.signal(signal.SIGTERM, shutdown)

    log_info(f'Listening on {BIND_HOST}:{BIND_PORT}')
    server.serve_forever()


if __name__ == '__main__':
    main()
