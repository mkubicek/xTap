"""Tests for native-host/xtap_daemon.py — request hardening (issue #7)."""

import json
import os
import platform
import signal
import socket
import subprocess
import sys
import threading
import time

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


@pytest.fixture(autouse=True)
def _isolate_default_output_dir(tmp_path, monkeypatch):
    """Point the daemon's default output dir at a tmp dir. resolve_output_dir
    lazily loads seen IDs for it, and tests must never touch the user's real
    ~/Downloads/xtap (slow with a large archive; blocked by macOS TCC in
    sandboxed runs)."""
    default = tmp_path / 'default-out'
    default.mkdir()
    monkeypatch.setattr(xtap_daemon, 'DEFAULT_OUTPUT_DIR', str(default))
    monkeypatch.setattr(xtap_daemon, '_seen_ids_by_dir', {})


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

    def test_oversized_body_drained_so_413_arrives_cleanly(self, daemon_url, monkeypatch):
        """An actual over-limit body (not just the header) must still get a
        parseable 413 — the daemon drains the body so the socket close doesn't
        RST the upload mid-stream and surface as a network error instead."""
        import http.client
        monkeypatch.setattr(xtap_daemon, 'MAX_BODY_SIZE', 1000)
        payload = b'{"tweets":[' + b'0' * 4000 + b']}'  # well over 1000
        port = int(daemon_url.rsplit(':', 1)[1])
        conn = http.client.HTTPConnection('127.0.0.1', port)
        conn.request('POST', '/tweets', body=payload,
                     headers={'Content-Type': 'application/json',
                              'Authorization': f'Bearer {TEST_TOKEN}'})
        resp = conn.getresponse()  # must not raise (no RST)
        body = json.loads(resp.read())
        assert resp.status == 413
        assert 'too large' in body['error'].lower()
        conn.close()


class TestServerShutdownConfig:
    def test_handler_threads_not_daemonized(self):
        """daemon_threads must be False so server_close() joins in-flight
        handlers instead of the OS killing them mid-write at exit."""
        assert xtap_daemon.XtapHTTPServer.daemon_threads is False


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

    def test_auth_checked_before_oversized_body_drain(self, daemon_url, monkeypatch):
        """Unauthenticated oversized requests must not force body draining."""
        import http.client
        drained = []
        monkeypatch.setattr(
            xtap_daemon.DaemonHandler,
            '_drain_body',
            lambda _self, n: drained.append(n))
        huge_length = xtap_daemon.MAX_BODY_SIZE + 1
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(huge_length))
        # No Authorization header
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 401
        assert body['error'] == 'Unauthorized'
        assert drained == []
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

    def test_tweets_image_download_flag_enqueues(self, daemon_url, monkeypatch):
        """When image_download=true, photo media should be enqueued."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xtap-test-')
        captured = []

        class _Fake:
            def enqueue(self, jobs, where):
                captured.append((list(jobs), where))

        monkeypatch.setattr(xtap_daemon, 'get_image_downloader', lambda: _Fake())
        try:
            tweet = {
                'id': '42',
                'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/HGK.jpg:orig'}],
            }
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [tweet], 'image_download': True},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['ok'] is True
            assert body['images_queued'] == 1
            assert len(captured) == 1
            jobs, where = captured[0]
            assert where == os.path.realpath(out_dir)
            assert jobs[0]['rel_path'] == 'media/42/HGK.jpg'
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_tweets_no_flag_does_not_enqueue(self, daemon_url, monkeypatch):
        """Without image_download flag, the downloader is not invoked and
        local_path is NOT injected (keeps JSONL clean for users who don't
        opt in, and matches the golden-fixture E2E test expectations)."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xtap-test-')
        called = []
        monkeypatch.setattr(xtap_daemon, 'get_image_downloader', lambda: called.append(1))
        try:
            tweet = {
                'id': '43',
                'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/HGK.jpg:orig'}],
            }
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [tweet]},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['images_queued'] == 0
            assert called == []
            files = [p for p in os.listdir(out_dir) if p.startswith('tweets-')]
            assert len(files) == 1
            line = open(os.path.join(out_dir, files[0])).readline()
            # local_path NOT present when image_download is off.
            assert 'local_path' not in line
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_tweets_string_truthy_does_not_enable(self, daemon_url, monkeypatch):
        """image_download must be the literal True — string 'false' or 1 must NOT enable."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xtap-test-')
        called = []
        monkeypatch.setattr(xtap_daemon, 'get_image_downloader', lambda: called.append(1))
        try:
            tweet = {
                'id': '44',
                'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/x.jpg'}],
            }
            for bad in ['false', 1, 'true', [1]]:
                status, body = _post(
                    daemon_url, '/tweets',
                    body={'outputDir': out_dir, 'tweets': [tweet], 'image_download': bad},
                    token=TEST_TOKEN,
                )
                assert status == 200
                assert body['images_queued'] == 0, f'truthy {bad!r} should not enable'
            assert called == []
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_dump_rejects_dotdot_filename(self, daemon_url):
        """POST /dump with '..' filename should return 400."""
        status, body = _post(
            daemon_url, '/dump',
            body={'filename': '..', 'content': 'x'},
            token=TEST_TOKEN,
        )
        assert status == 400
        assert 'Invalid dump filename' in body['error']


class TestDownloadVideo:
    def test_rejects_offsite_tweet_url_before_starting_download(self, daemon_url, monkeypatch):
        called = []
        monkeypatch.setattr(
            xtap_daemon,
            'start_download',
            lambda *args, **kwargs: called.append((args, kwargs)))

        status, body = _post(
            daemon_url, '/download-video',
            body={
                'tweetUrl': 'http://169.254.169.254/latest/meta-data/',
                'directUrl': '',
            },
            token=TEST_TOKEN,
        )

        assert status == 400
        assert body['ok'] is False
        assert 'tweetUrl' in body['error']
        assert called == []


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


# ---------------------------------------------------------------------------
# Tests — signal shutdown (the handler must not deadlock serve_forever)
# ---------------------------------------------------------------------------

class TestSignalShutdown:

    @pytest.mark.skipif(platform.system() == 'Windows', reason='POSIX signals only')
    def test_sigterm_exits_promptly(self, tmp_path):
        """server.shutdown() invoked directly inside a signal handler runs on
        the same thread as serve_forever() and deadlocks — launchd/systemd
        then SIGKILLs mid-write. The daemon must exit cleanly within 5s."""
        port = _free_port()
        (tmp_path / '.xtap').mkdir()
        (tmp_path / '.xtap' / 'secret').write_text('test-token')
        env = {**os.environ,
               'HOME': str(tmp_path),
               'XTAP_DAEMON_PORT': str(port),
               'XTAP_OUTPUT_DIR': str(tmp_path / 'out')}
        daemon_py = os.path.join(
            os.path.dirname(os.path.abspath(xtap_daemon.__file__)), 'xtap_daemon.py')
        proc = subprocess.Popen([sys.executable, daemon_py], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                text=True)
        stderr_lines = []
        threading.Thread(
            target=lambda: stderr_lines.extend(proc.stderr), daemon=True).start()
        try:
            deadline = time.time() + 10
            while not any('Listening' in line for line in stderr_lines):
                if proc.poll() is not None:
                    pytest.fail(f'daemon exited early: {"".join(stderr_lines)}')
                if time.time() > deadline:
                    pytest.fail(f'daemon never started: {"".join(stderr_lines)}')
                time.sleep(0.05)

            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pytest.fail('daemon did not exit within 5s of SIGTERM (shutdown deadlock)')
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

    @pytest.mark.skipif(platform.system() == 'Windows', reason='POSIX signals only')
    def test_idle_connection_does_not_block_shutdown(self, tmp_path):
        """A peer that opens a connection but never sends a request parks a
        non-daemon handler thread; with daemon_threads=False, server_close()
        joins it on shutdown. Without a socket timeout on DaemonHandler that
        join blocks until launchd/systemd SIGKILLs mid-write. The handler
        timeout must let the idle thread expire so shutdown still completes."""
        port = _free_port()
        (tmp_path / '.xtap').mkdir()
        (tmp_path / '.xtap' / 'secret').write_text('test-token')
        env = {**os.environ,
               'HOME': str(tmp_path),
               'XTAP_DAEMON_PORT': str(port),
               'XTAP_OUTPUT_DIR': str(tmp_path / 'out'),
               # Short so the test is fast; the real default is 15s.
               'XTAP_CONN_TIMEOUT_S': '2'}
        daemon_py = os.path.join(
            os.path.dirname(os.path.abspath(xtap_daemon.__file__)), 'xtap_daemon.py')
        proc = subprocess.Popen([sys.executable, daemon_py], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                text=True)
        stderr_lines = []
        threading.Thread(
            target=lambda: stderr_lines.extend(proc.stderr), daemon=True).start()
        idle = None
        try:
            deadline = time.time() + 10
            while not any('Listening' in line for line in stderr_lines):
                if proc.poll() is not None:
                    pytest.fail(f'daemon exited early: {"".join(stderr_lines)}')
                if time.time() > deadline:
                    pytest.fail(f'daemon never started: {"".join(stderr_lines)}')
                time.sleep(0.05)

            # Open a connection and send nothing — the handler thread blocks in
            # readline() waiting for a request line that never comes.
            idle = socket.create_connection(('127.0.0.1', port), timeout=5)
            time.sleep(0.2)  # let the daemon accept + spawn the handler thread

            proc.send_signal(signal.SIGTERM)
            try:
                # 2s conn timeout + generous margin for the shutdown join.
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pytest.fail('idle connection blocked shutdown past the socket '
                            'timeout — DaemonHandler.timeout is not taking effect')
        finally:
            if idle is not None:
                idle.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def _free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------
# Tests — article local_path sanitization must not depend on image toggle
# ---------------------------------------------------------------------------

class TestArticlePathSanitization:

    def test_unsafe_local_path_stripped_without_image_download(
            self, daemon_url, tmp_path, monkeypatch):
        """Traversal-laden article local_path values must be stripped from the
        JSONL even when image_download is off — downstream consumers join
        out_dir + local_path."""
        monkeypatch.setattr(xtap_core, '_ALLOWED_ROOTS',
                            (os.path.realpath(str(tmp_path)),))
        out_dir = str(tmp_path / 'out')
        body = {
            'outputDir': out_dir,
            'tweets': [{
                'id': '777000777',
                'text': 'article',
                'is_article': True,
                'article': {
                    'text': 'before\n![evil](../../../../etc/evil.jpg)\nafter',
                    'media': [{
                        'url': 'https://pbs.twimg.com/media/abc.jpg',
                        'local_path': '../../../../etc/evil.jpg',
                    }],
                },
            }],
        }
        status, resp = _post(daemon_url, '/tweets', body, token=TEST_TOKEN)
        assert status == 200
        assert resp['ok'] is True
        files = list((tmp_path / 'out').glob('tweets-*.jsonl'))
        assert len(files) == 1
        line = json.loads(files[0].read_text(encoding='utf-8').strip())
        assert 'local_path' not in line['article']['media'][0]
        assert '../../../../etc/evil.jpg' not in line['article']['text']
        assert 'before' in line['article']['text']
        assert 'after' in line['article']['text']
