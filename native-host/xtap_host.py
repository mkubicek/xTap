#!/usr/bin/env python3
"""xTap Native Messaging Host — receives tweets from the Chrome extension and appends to JSONL."""

import json
import os
import struct
import sys

from xtap_core import DEFAULT_OUTPUT_DIR, load_seen_ids, resolve_output_dir, write_tweets, write_log, test_path

XTAP_PORT = 17381
XTAP_DIR = os.path.expanduser('~/.xtap')
XTAP_SECRET = os.path.join(XTAP_DIR, 'secret')


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack('<I', raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data)


def send_message(msg):
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    out_dir = DEFAULT_OUTPUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    seen_ids = load_seen_ids(out_dir)
    custom_dirs = set()

    while True:
        msg = read_message()
        if msg is None:
            break

        try:
            _handle_message(msg, out_dir, seen_ids, custom_dirs)
        except Exception as e:
            send_message({'ok': False, 'error': str(e)})


def _handle_message(msg, default_dir, seen_ids, custom_dirs):
    # Handle GET_TOKEN: return daemon auth token for HTTP transport bootstrap
    if msg.get('type') == 'GET_TOKEN':
        try:
            with open(XTAP_SECRET, 'r') as f:
                token = f.read().strip()
            send_message({'ok': True, 'token': token, 'port': XTAP_PORT})
        except FileNotFoundError:
            send_message({'ok': False, 'error': 'Daemon not installed (~/.xtap/secret not found)'})
        return

    # Resolve output directory
    msg_dir = msg.get('outputDir', '').strip()
    out_dir = resolve_output_dir(msg_dir, default_dir, seen_ids, custom_dirs)

    # Handle path test
    if msg.get('type') == 'TEST_PATH':
        test_path(out_dir)
        send_message({'ok': True, 'type': 'TEST_PATH'})
        return

    # Handle log messages
    if msg.get('type') == 'LOG':
        lines = msg.get('lines', [])
        logged = write_log(lines, out_dir)
        send_message({'ok': True, 'logged': logged})
        return

    # Handle tweet messages
    tweets = msg.get('tweets', [])
    count, dupes = write_tweets(tweets, out_dir, seen_ids)
    send_message({'ok': True, 'count': count, 'dupes': dupes})


if __name__ == '__main__':
    main()
