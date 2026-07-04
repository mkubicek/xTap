#!/usr/bin/env python3
"""xTap HTTP Daemon — runs as a system service (launchd/systemd/Scheduled Task)."""

import hmac
import json
import os
import platform
import signal
import socket
import sys
import time
import uuid
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from xtap_core import (DEFAULT_OUTPUT_DIR, load_seen_ids, resolve_output_dir,
                       validate_output_dir, write_tweets, write_log,
                       write_dump, test_path,
                       check_ytdlp, start_download, get_download_status,
                       collect_image_jobs, get_image_downloader,
                       validate_tweet_url)

VERSION = '0.24.0'
BIND_HOST = '127.0.0.1'
BIND_PORT = int(os.environ.get('XTAP_DAEMON_PORT', 17381))
MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB (extension caps POSTs via MAX_TWEETS_PER_POST in background.js)
MAX_DRAIN_SIZE = 64 * 1024 * 1024  # cap bytes drained from an oversized request before replying 413
MAX_DRAIN_IDLE_TIMEOUT_S = 0.25  # don't hang on clients that declare a body and send none


def _conn_timeout_s():
    # Per-connection socket timeout (see DaemonHandler.timeout). Default 15s:
    # above the extension's 10s client timeout (HTTP_TIMEOUT_MS) so a legit
    # localhost request is never cut off, and below launchd's ~20s SIGTERM->
    # SIGKILL window so an idle connection can't push shutdown past it. Always
    # finite — bad/<=0 values fall back to the default rather than disabling it
    # (disabling would reintroduce the shutdown-hang this guards against).
    raw = (os.environ.get('XTAP_CONN_TIMEOUT_S') or '').strip()
    if not raw:
        return 15.0
    try:
        value = float(raw)
    except ValueError:
        return 15.0
    return value if value > 0 else 15.0


CONN_TIMEOUT_S = _conn_timeout_s()
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
        with open(XTAP_SECRET, 'r', encoding='utf-8') as f:
            return f.read().strip()
    except FileNotFoundError:
        log_info(f'FATAL: {XTAP_SECRET} not found. Run install.sh first.')
        sys.exit(1)


# Module-level state shared across requests
_token = None
_seen_ids_by_dir = {}
_state_lock = threading.Lock()


class XtapHTTPServer(ThreadingHTTPServer):
    # daemon_threads defaults to True on ThreadingHTTPServer, which makes
    # server_close()'s thread-join a no-op (daemon threads aren't tracked) —
    # an in-flight handler is then killed mid-JSONL-write at interpreter exit.
    # False + block_on_close (default True) makes server_close() actually wait
    # for in-flight writes to finish before the process exits.
    daemon_threads = False


class DaemonHandler(BaseHTTPRequestHandler):
    # Socket timeout for stalled/idle connections. Required by the
    # daemon_threads = False change above: without it, a peer that opens a
    # connection to 127.0.0.1 and never finishes sending its request line/body
    # (a port scanner, a stalled fetch, an unauthenticated slowloris — this is
    # pre-auth, so the token can't gate it) parks a non-daemon handler thread
    # in a blocking read forever. server_close() then blocks joining that
    # thread on shutdown until launchd/systemd escalates to SIGKILL, killing
    # in-flight JSONL writes — the exact failure daemon_threads = False exists
    # to prevent. A socket timeout makes the read raise and the thread exit.
    timeout = CONN_TIMEOUT_S

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
            # Validate token when provided (allows probeHttp to detect stale credentials)
            auth = self.headers.get('Authorization', '')
            if auth and (not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], _token)):
                self._send_json({'ok': False, 'error': 'Unauthorized'}, 401)
                return
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
            # Drain the (bounded) body before replying. An unread request body
            # on a closed HTTP/1.0 socket triggers a TCP RST, which surfaces to
            # the extension's fetch() as a network error rather than a 413 — so
            # the client's batch-splitting recovery never sees the 413 and the
            # oversized batch wedges the queue. Draining lets the 413 arrive
            # cleanly. Capped so a bogus huge Content-Length can't tie us up.
            self._drain_body(min(length, MAX_DRAIN_SIZE))
            self._send_json({'ok': False, 'error': 'Payload too large'}, 413)
            return -1
        return length

    def _drain_body(self, n):
        old_timeout = self.connection.gettimeout()
        self.connection.settimeout(MAX_DRAIN_IDLE_TIMEOUT_S)
        remaining = n
        try:
            while remaining > 0:
                try:
                    chunk = self.rfile.read(min(65536, remaining))
                except socket.timeout:
                    break
                if not chunk:
                    break
                remaining -= len(chunk)
        finally:
            self.connection.settimeout(old_timeout)

    def do_POST(self):
        log_debug(f'POST {self.path} (Content-Length: {self.headers.get("Content-Length", "?")})')

        if not self._check_auth():
            return

        length = self._validate_content_length()
        if length < 0:
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
            # Strict boolean: only `true` enables. Avoids string 'false' / number 1
            # silently turning the feature on.
            image_download = body.get('image_download') is True
            with _state_lock:
                out_dir, seen_ids = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids_by_dir)
                tweets = body.get('tweets', [])
                # Always collect before write_tweets: collect_image_jobs strips
                # unsafe article local_paths from the tweets so traversal paths
                # never land in the JSONL — sanitization must not depend on the
                # image_download toggle.
                pending_images = collect_image_jobs(tweets, out_dir)
                count, dupes = write_tweets(tweets, out_dir, seen_ids)
            queued = 0
            if image_download and pending_images:
                get_image_downloader().enqueue(pending_images, out_dir)
                queued = len(pending_images)
            log_debug(f'  Tweets: {count} written, {dupes} dupes, {queued} images queued -> {out_dir}')
            self._send_json({'ok': True, 'count': count, 'dupes': dupes, 'images_queued': queued})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /tweets: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_log(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            lines = body.get('lines', [])
            with _state_lock:
                out_dir, _ = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids_by_dir)
                # Write under the lock — concurrent appends through separate
                # file objects can interleave mid-line at buffer boundaries.
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
                out_dir, _ = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids_by_dir)
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
            validate_tweet_url(tweet_url)
            with _state_lock:
                out_dir, _ = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids_by_dir)
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
        sys.stdout = open(os.path.join(XTAP_DIR, 'daemon-stdout.log'), 'a', encoding='utf-8')
    if sys.stderr is None:
        sys.stderr = open(os.path.join(XTAP_DIR, 'daemon-stderr.log'), 'a', encoding='utf-8')


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
    global _token

    _setup_stdio()

    _token = load_token()

    # Initialize output directory and seen IDs
    os.makedirs(DEFAULT_OUTPUT_DIR, exist_ok=True)
    _seen_ids_by_dir[DEFAULT_OUTPUT_DIR] = load_seen_ids(DEFAULT_OUTPUT_DIR)

    _log_startup_diagnostics()
    log_info(f'  Seen IDs:   {len(_seen_ids_by_dir[DEFAULT_OUTPUT_DIR])} loaded')

    try:
        server = XtapHTTPServer((BIND_HOST, BIND_PORT), DaemonHandler)
    except OSError as e:
        log_info(f'FATAL: Cannot bind to {BIND_HOST}:{BIND_PORT} — {e}')
        log_info(f'  Is another instance already running?')
        sys.exit(1)

    def shutdown(signum, frame):
        log_info(f'Received signal {signum}, shutting down...')
        # shutdown() must run on a different thread than serve_forever(): the
        # signal handler interrupts the serve_forever thread, and shutdown()
        # blocks until serve_forever exits — calling it inline deadlocks until
        # launchd/systemd escalates to SIGKILL (killing in-flight writes).
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if platform.system() == 'Windows':
        signal.signal(signal.SIGBREAK, shutdown)
    else:
        signal.signal(signal.SIGTERM, shutdown)

    log_info(f'Listening on {BIND_HOST}:{BIND_PORT}')
    server.serve_forever()
    # Join in-flight non-daemon handler threads before exiting so any active
    # JSONL write can finish cleanly.
    server.server_close()
    log_info('Shutdown complete')


if __name__ == '__main__':
    main()
