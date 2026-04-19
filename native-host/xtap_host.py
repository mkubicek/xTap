#!/usr/bin/env python3
"""xTap Native Messaging Host — token bootstrap for the Chrome/Firefox extension.

This minimal host exists solely to pass the HTTP daemon's auth token to the
browser extension via native messaging.  All tweet/log/dump I/O goes through
the HTTP daemon (xtap_daemon.py).
"""

import json
import os
import struct
import sys
import traceback
from datetime import datetime

XTAP_PORT = int(os.environ.get('XTAP_DAEMON_PORT', 17381))
XTAP_DIR = os.path.expanduser('~/.xtap')
XTAP_SECRET = os.path.join(XTAP_DIR, 'secret')
XTAP_ERROR_LOG = os.path.join(XTAP_DIR, 'host-error.log')

MAX_MESSAGE_BYTES = 1 * 1024 * 1024  # 1 MiB guard


def read_exact(stream, size):
    """Read exactly *size* bytes from *stream*, handling pipe fragmentation."""
    buf = b''
    while len(buf) < size:
        chunk = stream.read(size - len(buf))
        if not chunk:
            raise EOFError('unexpected end of stream')
        buf += chunk
    return buf


def read_message():
    try:
        header = read_exact(sys.stdin.buffer, 4)
    except EOFError:
        raise EOFError('stdin closed')
    length = struct.unpack('<I', header)[0]
    if length > MAX_MESSAGE_BYTES:
        raise ValueError(f'message too large: {length} bytes')
    data = read_exact(sys.stdin.buffer, length)
    return json.loads(data)


def send_message(msg):
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _main():
    while True:
        try:
            msg = read_message()
        except EOFError:
            break
        except Exception as e:
            send_message({'ok': False, 'error': str(e)})
            continue

        if msg.get('type') == 'GET_TOKEN':
            try:
                with open(XTAP_SECRET, 'r') as f:
                    token = f.read().strip()
                send_message({'ok': True, 'token': token, 'port': XTAP_PORT})
            except FileNotFoundError:
                send_message({'ok': False, 'error': 'Daemon not installed (~/.xtap/secret not found)'})
            except Exception as e:
                send_message({'ok': False, 'error': str(e)})
        else:
            send_message({
                'ok': False,
                'error': f'Unsupported message type: {msg.get("type")}. '
                         'All data is handled by the HTTP daemon.'
            })


def main():
    try:
        _main()
    except Exception:
        os.makedirs(XTAP_DIR, exist_ok=True)
        with open(XTAP_ERROR_LOG, 'a') as f:
            f.write(f'\n--- {datetime.now().isoformat()} ---\n')
            f.write(f'Python: {sys.version}\n')
            f.write(f'Script: {os.path.abspath(__file__)}\n')
            f.write(f'sys.path: {sys.path}\n')
            traceback.print_exc(file=f)
        raise


if __name__ == '__main__':
    main()
