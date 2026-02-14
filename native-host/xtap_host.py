#!/usr/bin/env python3
"""xTap Native Messaging Host — receives tweets from the Chrome extension and appends to JSONL."""

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


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    while True:
        msg = read_message()
        if msg is None:
            break

        tweets = msg.get('tweets', [])

        # Use per-message outputDir if provided, otherwise fall back to default
        msg_dir = msg.get('outputDir', '').strip()
        if msg_dir:
            out_dir = os.path.expanduser(msg_dir)
        else:
            out_dir = OUTPUT_DIR
        os.makedirs(out_dir, exist_ok=True)
        out_file = os.path.join(out_dir, f'tweets-{date.today().isoformat()}.jsonl')

        count = 0
        with open(out_file, 'a') as f:
            for tweet in tweets:
                f.write(json.dumps(tweet, ensure_ascii=False) + '\n')
                count += 1

        send_message({'ok': True, 'count': count})


if __name__ == '__main__':
    main()
