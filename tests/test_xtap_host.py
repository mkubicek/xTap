"""Tests for native-host/xtap_host.py — message framing and startup."""

import io
import json
import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'native-host'))
import xtap_host


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class ChunkedReader:
    """Wraps bytes and yields them in fixed-size chunks to simulate pipe fragmentation."""

    def __init__(self, data: bytes, chunk_size: int = 3):
        self._data = data
        self._pos = 0
        self._chunk_size = chunk_size

    def read(self, n: int) -> bytes:
        actual = min(n, self._chunk_size, len(self._data) - self._pos)
        if actual <= 0:
            return b''
        chunk = self._data[self._pos:self._pos + actual]
        self._pos += actual
        return chunk


def _encode_native_message(obj):
    """Encode a Python object into the Chrome native-messaging wire format."""
    payload = json.dumps(obj).encode('utf-8')
    return struct.pack('<I', len(payload)) + payload


# ---------------------------------------------------------------------------
# read_message / read_exact
# ---------------------------------------------------------------------------

class TestReadMessage:

    def test_handles_chunked_pipe(self, monkeypatch):
        msg = {'type': 'LOG', 'lines': ['hello']}
        raw = _encode_native_message(msg)
        chunked = ChunkedReader(raw, chunk_size=3)
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': chunked})())
        assert xtap_host.read_message() == msg

    def test_invalid_json_raises_value_error(self, monkeypatch):
        payload = b'not json at all'
        raw = struct.pack('<I', len(payload)) + payload
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())
        with pytest.raises(json.JSONDecodeError):
            xtap_host.read_message()

    def test_eof_mid_payload_raises_eoferror(self, monkeypatch):
        # Header claims 100 bytes but only 5 are available
        raw = struct.pack('<I', 100) + b'short'
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())
        with pytest.raises(EOFError):
            xtap_host.read_message()


# ---------------------------------------------------------------------------
# GET_TOKEN without storage init
# ---------------------------------------------------------------------------

class TestGetTokenWithoutStorage:

    def test_get_token_does_not_require_storage_init(self, monkeypatch, tmp_path):
        """GET_TOKEN should succeed even when the output directory is inaccessible."""
        # Create a secret file
        xtap_dir = tmp_path / '.xtap'
        xtap_dir.mkdir()
        secret_file = xtap_dir / 'secret'
        secret_file.write_text('test-token-abc')
        monkeypatch.setattr(xtap_host, 'XTAP_SECRET', str(secret_file))

        # Point DEFAULT_OUTPUT_DIR at a path that doesn't exist and can't be created
        bad_dir = '/nonexistent/readonly/path'
        monkeypatch.setattr('xtap_core.DEFAULT_OUTPUT_DIR', bad_dir)
        # Also patch the local reference imported into xtap_host
        monkeypatch.setattr(xtap_host, 'DEFAULT_OUTPUT_DIR', bad_dir)

        # Build a stdin stream: one GET_TOKEN message, then EOF
        raw = _encode_native_message({'type': 'GET_TOKEN'})
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())

        # Capture stdout
        out_buf = io.BytesIO()
        monkeypatch.setattr('sys.stdout', type('', (), {'buffer': out_buf})())

        xtap_host.main()

        # Parse the response
        out_buf.seek(0)
        resp_len = struct.unpack('<I', out_buf.read(4))[0]
        resp = json.loads(out_buf.read(resp_len))
        assert resp['ok'] is True
        assert resp['token'] == 'test-token-abc'
