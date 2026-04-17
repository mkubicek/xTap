"""Tests for native-host/xtap_daemon.py — request hardening (issue #7)."""

import json
import os
import sys
import threading

import pytest
import urllib.request
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'native-host'))
import xtap_core
import xtap_daemon


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

TEST_TOKEN = 'test-token-for-daemon'


@pytest.fixture(autouse=True)
def _set_module_token():
    """Inject a known token into the daemon module for all tests."""
    old = xtap_daemon._token
    xtap_daemon._token = TEST_TOKEN
    yield
    xtap_daemon._token = old


@pytest.fixture()
def daemon_url():
    """Start DaemonHandler on an ephemeral port and return its base URL."""
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(('127.0.0.1', 0), xtap_daemon.DaemonHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f'http://127.0.0.1:{port}'
    server.shutdown()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post(base_url, path='/', body=None, token=None, headers=None):
    """Send a POST request and return (status, parsed_json)."""
    data = json.dumps(body).encode() if body is not None else b''
    req = urllib.request.Request(f'{base_url}{path}', data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    if token is not None:
        req.add_header('Authorization', f'Bearer {token}')
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    # Content-Length is set automatically by urllib from data
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _raw_post(base_url, path='/', raw_body=b'', token=None, content_length=None):
    """Send a POST with explicit Content-Length control."""
    req = urllib.request.Request(f'{base_url}{path}', data=raw_body, method='POST')
    req.add_header('Content-Type', 'application/json')
    if token is not None:
        req.add_header('Authorization', f'Bearer {token}')
    if content_length is not None:
        req.add_header('Content-Length', str(content_length))
    # Remove auto-set Content-Length so our override takes effect
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


# ---------------------------------------------------------------------------
# Tests — Content-Length validation
# ---------------------------------------------------------------------------

class TestContentLengthValidation:

    def test_missing_content_length(self, daemon_url):
        """POST without Content-Length should return 400."""
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert 'Missing Content-Length' in body['error']
        conn.close()

    def test_non_numeric_content_length(self, daemon_url):
        """Non-numeric Content-Length should return 400."""
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', 'abc')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert 'Invalid Content-Length' in body['error']
        conn.close()

    def test_negative_content_length(self, daemon_url):
        """Negative Content-Length should return 400."""
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', '-1')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert 'negative' in body['error'].lower()
        conn.close()

    def test_oversized_content_length(self, daemon_url):
        """Content-Length exceeding MAX_BODY_SIZE should return 413."""
        import http.client
        huge_length = xtap_daemon.MAX_BODY_SIZE + 1
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(huge_length))
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 413
        assert 'too large' in body['error'].lower()
        conn.close()


# ---------------------------------------------------------------------------
# Tests — Auth
# ---------------------------------------------------------------------------

class TestAuth:

    def test_unauthorized_request_rejected(self, daemon_url):
        """POST without token should return 401."""
        status, body = _post(daemon_url, '/tweets', body={'tweets': []})
        assert status == 401
        assert body['error'] == 'Unauthorized'

    def test_wrong_token_rejected(self, daemon_url):
        """POST with wrong token should return 401."""
        status, body = _post(daemon_url, '/tweets', body={'tweets': []}, token='wrong-token')
        assert status == 401
        assert body['error'] == 'Unauthorized'

    def test_content_length_checked_before_auth(self, daemon_url):
        """Oversized request should be rejected with 413 even without auth."""
        import http.client
        huge_length = xtap_daemon.MAX_BODY_SIZE + 1
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(huge_length))
        # No Authorization header
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        # Should get 413, not 401
        assert resp.status == 413
        conn.close()


# ---------------------------------------------------------------------------
# Tests — Normal authorized request
# ---------------------------------------------------------------------------

class TestAuthorizedRequest:

    def test_status_endpoint(self, daemon_url):
        """GET /status should work (no auth, no body)."""
        req = urllib.request.Request(f'{daemon_url}/status')
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read())
        assert resp.status == 200
        assert body['ok'] is True
        assert 'version' in body

    def test_valid_post_succeeds(self, daemon_url):
        """An authorized POST /tweets with valid body should succeed."""
        import tempfile
        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xtap-test-')
        try:
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [{'id': '1', 'text': 'hello'}]},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['ok'] is True
            assert body['count'] == 1
        finally:
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_zero_content_length_post(self, daemon_url):
        """POST with Content-Length: 0 exercises _read_json returning {}."""
        import http.client
        port = int(daemon_url.rsplit(':', 1)[1])
        conn = http.client.HTTPConnection('127.0.0.1', port)
        # Use /check-ytdlp which ignores the body — avoids output-dir issues
        conn.putrequest('POST', '/check-ytdlp')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', '0')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 200
        assert body['ok'] is True
        conn.close()

    def test_dump_rejects_dotdot_filename(self, daemon_url):
        """POST /dump with '..' filename should return 400."""
        status, body = _post(
            daemon_url, '/dump',
            body={'filename': '..', 'content': 'x'},
            token=TEST_TOKEN,
        )
        assert status == 400
        assert 'Invalid dump filename' in body['error']


# ---------------------------------------------------------------------------
# Tests — Concurrency (issue #8)
# ---------------------------------------------------------------------------

class TestConcurrency:

    def test_status_responsive_during_slow_tweets(self, daemon_url):
        """GET /status should respond promptly while a slow /tweets is in progress."""
        import shutil
        import tempfile
        import time
        from unittest.mock import patch
        import concurrent.futures

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xtap-test-')

        slow_entered = threading.Event()
        original_write_tweets = xtap_daemon.write_tweets

        def slow_write_tweets(tweets, out_dir, seen_ids):
            slow_entered.set()
            time.sleep(1.0)
            return original_write_tweets(tweets, out_dir, seen_ids)

        try:
            with patch.object(xtap_daemon, 'write_tweets', side_effect=slow_write_tweets):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    # Fire off the slow /tweets request
                    tweets_future = pool.submit(
                        _post, daemon_url, '/tweets',
                        {'outputDir': out_dir, 'tweets': [{'id': '1', 'text': 'hi'}]},
                        TEST_TOKEN,
                    )

                    # Wait until the slow handler has started
                    assert slow_entered.wait(timeout=5), 'slow write_tweets never entered'

                    # Now /status should respond quickly
                    t0 = time.monotonic()
                    req = urllib.request.Request(f'{daemon_url}/status')
                    with urllib.request.urlopen(req, timeout=2) as resp:
                        status_body = json.loads(resp.read())
                    elapsed = time.monotonic() - t0

                    assert status_body['ok'] is True
                    assert elapsed < 0.5, f'/status took {elapsed:.2f}s — blocked by slow /tweets'

                    # Let the tweets request finish
                    tweets_status, tweets_body = tweets_future.result(timeout=5)
                    assert tweets_status == 200
                    assert tweets_body['ok'] is True
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_download_status_coherent(self):
        """get_download_status never returns partial state (e.g. status=done with path=None)."""
        import time

        download_id = 'coherence-test'
        errors = []
        stop = threading.Event()

        # Seed initial state
        with xtap_core._downloads_lock:
            xtap_core._downloads[download_id] = {
                'status': 'downloading',
                'progress': 0,
                'path': None,
                'error': None,
            }

        def reader():
            while not stop.is_set():
                s = xtap_core.get_download_status(download_id)
                if s['status'] == 'done' and s['path'] is None:
                    errors.append(f'Incoherent: status=done but path=None')
                if s['status'] == 'error' and s['error'] is None:
                    errors.append(f'Incoherent: status=error but error=None')

        def writer():
            for i in range(200):
                with xtap_core._downloads_lock:
                    xtap_core._downloads[download_id].update(
                        progress=i, status='done', path='/tmp/video.mp4')
                with xtap_core._downloads_lock:
                    xtap_core._downloads[download_id].update(
                        progress=0, status='downloading', path=None, error=None)
            stop.set()

        readers = [threading.Thread(target=reader) for _ in range(4)]
        for r in readers:
            r.start()
        writer_t = threading.Thread(target=writer)
        writer_t.start()

        writer_t.join(timeout=5)
        stop.set()
        for r in readers:
            r.join(timeout=2)

        # Clean up
        with xtap_core._downloads_lock:
            del xtap_core._downloads[download_id]

        assert not errors, f'Found incoherent reads: {errors[:5]}'
