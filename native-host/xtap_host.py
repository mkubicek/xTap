#!/usr/bin/env python3
"""xTap Native Messaging Host — receives tweets from the Chrome extension and appends to JSONL."""

import glob
import json
import os
import struct
import sys
from datetime import date

OUTPUT_DIR = os.environ.get('XTAP_OUTPUT_DIR', os.path.expanduser('~/Downloads/xtap'))


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


def load_seen_ids(out_dir):
    """Build a set of tweet IDs from all existing JSONL files in the output directory."""
    seen = set()
    for path in glob.glob(os.path.join(out_dir, 'tweets-*.jsonl')):
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    tweet_id = json.loads(line).get('id')
                    if tweet_id:
                        seen.add(tweet_id)
                except (json.JSONDecodeError, KeyError):
                    continue
    return seen


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    seen_ids = load_seen_ids(OUTPUT_DIR)

    while True:
        msg = read_message()
        if msg is None:
            break

        try:
            _handle_message(msg, seen_ids)
        except Exception as e:
            send_message({'ok': False, 'error': str(e)})


def _handle_message(msg, seen_ids):
    # Resolve output directory
    msg_dir = msg.get('outputDir', '').strip()
    if msg_dir:
        out_dir = os.path.expanduser(msg_dir)
        os.makedirs(out_dir, exist_ok=True)
        if out_dir != OUTPUT_DIR and not hasattr(_handle_message, '_custom_dirs'):
            _handle_message._custom_dirs = set()
        if out_dir != OUTPUT_DIR and out_dir not in getattr(_handle_message, '_custom_dirs', set()):
            seen_ids.update(load_seen_ids(out_dir))
            _handle_message._custom_dirs.add(out_dir)
    else:
        out_dir = OUTPUT_DIR

    # Handle path test
    if msg.get('type') == 'TEST_PATH':
        test_file = os.path.join(out_dir, '.xtap-write-test')
        with open(test_file, 'w') as f:
            f.write('ok')
        os.remove(test_file)
        send_message({'ok': True, 'type': 'TEST_PATH'})
        return

    # Handle log messages
    if msg.get('type') == 'LOG':
        log_file = os.path.join(out_dir, f'debug-{date.today().isoformat()}.log')
        with open(log_file, 'a') as f:
            for line in msg.get('lines', []):
                f.write(line + '\n')
        send_message({'ok': True, 'logged': len(msg.get('lines', []))})
        return

    # Handle tweet messages
    tweets = msg.get('tweets', [])
    out_file = os.path.join(out_dir, f'tweets-{date.today().isoformat()}.jsonl')

    count = 0
    dupes = 0
    with open(out_file, 'a') as f:
        for tweet in tweets:
            tid = tweet.get('id')
            if tid and tid in seen_ids:
                dupes += 1
                continue
            if tid:
                seen_ids.add(tid)
            f.write(json.dumps(tweet, ensure_ascii=False) + '\n')
            count += 1

    send_message({'ok': True, 'count': count, 'dupes': dupes})


if __name__ == '__main__':
    main()
