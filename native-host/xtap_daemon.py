#!/usr/bin/env python3
"""xTap HTTP Daemon — runs as a system service (launchd/systemd/Scheduled Task)."""

import json
import os
import platform
import signal
import sys
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler

from xtap_core import (DEFAULT_OUTPUT_DIR, load_seen_ids, resolve_output_dir,
                       write_tweets, write_log, write_dump, test_path,
                       check_ytdlp, start_download, get_download_status)

VERSION = '0.15.0'
BIND_HOST = '127.0.0.1'
BIND_PORT = 17381
XTAP_DIR = os.path.expanduser('~/.xtap')
XTAP_SECRET = os.path.join(XTAP_DIR, 'secret')


def load_token():
    try:
        with open(XTAP_SECRET, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        print(f'FATAL: {XTAP_SECRET} not found. Run install.sh first.', file=sys.stderr)
        sys.exit(1)


# Module-level state shared across requests
_token = None
_seen_ids = set()
_custom_dirs = set()


class DaemonHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log to stderr (captured by launchd)
        print(f'{self.client_address[0]} - {format % args}', file=sys.stderr)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def _check_auth(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or auth[7:] != _token:
            self._send_json({'ok': False, 'error': 'Unauthorized'}, 401)
            return False
        return True

    def do_GET(self):
        if self.path == '/status':
            self._send_json({'ok': True, 'version': VERSION})
            return
        self._send_json({'ok': False, 'error': 'Not found'}, 404)

    def do_POST(self):
        if not self._check_auth():
            return

        try:
            body = self._read_json()
        except (json.JSONDecodeError, ValueError) as e:
            self._send_json({'ok': False, 'error': f'Invalid JSON: {e}'}, 400)
            return

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

    def _handle_tweets(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
            tweets = body.get('tweets', [])
            count, dupes = write_tweets(tweets, out_dir, _seen_ids)
            self._send_json({'ok': True, 'count': count, 'dupes': dupes})
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_log(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
            lines = body.get('lines', [])
            logged = write_log(lines, out_dir)
            self._send_json({'ok': True, 'logged': logged})
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_dump(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
            filename = body.get('filename', 'dump.json')
            content = body.get('content', '')
            path = write_dump(filename, content, out_dir)
            self._send_json({'ok': True, 'path': path})
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_test_path(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            if not msg_dir:
                self._send_json({'ok': False, 'error': 'outputDir is required'}, 400)
                return
            out_dir = os.path.expanduser(msg_dir)
            test_path(out_dir)
            self._send_json({'ok': True, 'type': 'TEST_PATH'})
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_check_ytdlp(self, body):
        available = check_ytdlp()
        self._send_json({'ok': True, 'available': available})

    def _handle_download_video(self, body):
        try:
            tweet_url = body.get('tweetUrl', '')
            direct_url = body.get('directUrl', '')
            post_date = body.get('postDate', '')
            msg_dir = body.get('outputDir', '').strip()
            out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR, _seen_ids, _custom_dirs)
            download_id = str(uuid.uuid4())
            start_download(download_id, tweet_url, direct_url, out_dir, post_date)
            self._send_json({'ok': True, 'downloadId': download_id})
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_download_status(self, body):
        download_id = body.get('downloadId', '')
        status = get_download_status(download_id)
        self._send_json({'ok': True, **status})


def _setup_stdio():
    """Redirect stdio to log files when running under pythonw (no console)."""
    if sys.stderr is not None and sys.stdout is not None:
        return
    os.makedirs(XTAP_DIR, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(os.path.join(XTAP_DIR, 'daemon-stdout.log'), 'a')
    if sys.stderr is None:
        sys.stderr = open(os.path.join(XTAP_DIR, 'daemon-stderr.log'), 'a')


def main():
    global _token, _seen_ids

    _setup_stdio()

    _token = load_token()

    # Initialize output directory and seen IDs
    os.makedirs(DEFAULT_OUTPUT_DIR, exist_ok=True)
    _seen_ids = load_seen_ids(DEFAULT_OUTPUT_DIR)

    server = HTTPServer((BIND_HOST, BIND_PORT), DaemonHandler)

    def shutdown(signum, frame):
        print(f'Received signal {signum}, shutting down...', file=sys.stderr)
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    if platform.system() == 'Windows':
        signal.signal(signal.SIGBREAK, shutdown)
    else:
        signal.signal(signal.SIGTERM, shutdown)

    print(f'xTap daemon v{VERSION} listening on {BIND_HOST}:{BIND_PORT}', file=sys.stderr)
    server.serve_forever()


if __name__ == '__main__':
    main()
