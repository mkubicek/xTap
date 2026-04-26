"""xTap Core — shared file I/O logic used by both native host and HTTP daemon."""

import glob
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from urllib.parse import urlparse


DEFAULT_OUTPUT_DIR = os.environ.get('XTAP_OUTPUT_DIR', os.path.expanduser('~/Downloads/xtap'))

# Allowed roots for outputDir validation: user's home + DEFAULT_OUTPUT_DIR
# (the latter covers XTAP_OUTPUT_DIR pointing outside home, e.g. /data/xtap)
_ALLOWED_ROOTS = tuple(dict.fromkeys([
    os.path.realpath(os.path.expanduser('~')),
    os.path.realpath(DEFAULT_OUTPUT_DIR),
]))


def validate_output_dir(path):
    """Validate that a resolved path is under an allowed root directory.

    Args:
        path: The path to validate (should already be expanduser'd).

    Returns:
        The realpath-resolved path.

    Raises:
        ValueError: If the path resolves outside all allowed roots.
    """
    resolved = os.path.realpath(path)
    for root in _ALLOWED_ROOTS:
        # Append os.sep so '/home/userX' doesn't match root '/home/user'
        if resolved == root or resolved.startswith(root + os.sep):
            return resolved
    raise ValueError(
        f'outputDir resolves outside allowed directories: {resolved}'
    )


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


def resolve_output_dir(msg_dir, default_dir, seen_ids, custom_dirs):
    """Resolve output directory from message, loading seen IDs for new custom dirs.

    Returns the resolved output directory path.
    """
    if msg_dir:
        out_dir = validate_output_dir(os.path.expanduser(msg_dir))
        os.makedirs(out_dir, exist_ok=True)
        if out_dir != default_dir and out_dir not in custom_dirs:
            seen_ids.update(load_seen_ids(out_dir))
            custom_dirs.add(out_dir)
    else:
        out_dir = default_dir
    return out_dir


def write_tweets(tweets, out_dir, seen_ids):
    """Write tweets to JSONL, deduplicating against seen_ids. Returns (count, dupes)."""
    out_file = os.path.join(out_dir, f'tweets-{date.today().isoformat()}.jsonl')
    count = 0
    dupes = 0
    with open(out_file, 'a') as f:
        for tweet in tweets:
            tid = tweet.get('id')
            if tid and tid in seen_ids and not tweet.get('is_article'):
                dupes += 1
                continue
            if tid:
                seen_ids.add(tid)
            f.write(json.dumps(tweet, ensure_ascii=False) + '\n')
            count += 1
    return count, dupes


def write_log(lines, out_dir):
    """Append debug log lines to daily log file. Returns logged count."""
    log_file = os.path.join(out_dir, f'debug-{date.today().isoformat()}.log')
    with open(log_file, 'a') as f:
        for line in lines:
            f.write(line + '\n')
    return len(lines)


def write_dump(filename, content, out_dir):
    """Write a raw JSON dump file for discovery/debugging."""
    # Strip path components — only the basename is allowed
    safe_name = os.path.basename(filename)
    if not safe_name or safe_name in ('.', '..'):
        raise ValueError(f'Invalid dump filename: {filename!r}')
    dump_file = os.path.join(out_dir, safe_name)
    with open(dump_file, 'w') as f:
        f.write(content)
    return dump_file


def test_path(out_dir):
    """Test that we can write to the output directory. Raises on failure."""
    os.makedirs(out_dir, exist_ok=True)
    test_file = os.path.join(out_dir, f'.xtap-write-test-{threading.get_ident()}')
    try:
        with open(test_file, 'w') as f:
            f.write('ok')
    finally:
        try:
            os.remove(test_file)
        except FileNotFoundError:
            pass


# --- Video download ---

_ytdlp_path = None
_ytdlp_checked = False
_downloads = {}
_downloads_lock = threading.Lock()


def check_ytdlp():  # pragma: no cover
    """Check if yt-dlp is available on PATH. Cached after first call."""
    global _ytdlp_path, _ytdlp_checked
    if not _ytdlp_checked:
        _ytdlp_path = shutil.which('yt-dlp')
        _ytdlp_checked = True
    return _ytdlp_path is not None


def get_download_status(download_id):
    """Return current state of a download."""
    with _downloads_lock:
        info = _downloads.get(download_id)
        if not info:
            return {'status': 'unknown'}
        return {
            'status': info['status'],
            'progress': info.get('progress'),
            'path': info.get('path'),
            'error': info.get('error'),
        }


def _date_prefix(post_date):
    """Convert ISO date string to yyyy.mm.dd prefix, or empty string on failure."""
    if not post_date:
        return ''
    try:
        # Handle both "2024-01-15T12:34:56.000Z" and "2024-01-15"
        dt = post_date[:10].replace('-', '.')
        return dt + '_'
    except Exception:
        return ''


def download_direct(direct_url, tweet_id, video_dir, post_date=''):  # pragma: no cover
    """Download video via direct CDN URL. Returns the file path."""
    os.makedirs(video_dir, exist_ok=True)
    prefix = _date_prefix(post_date)
    filename = f'{prefix}{tweet_id}.mp4'
    filepath = os.path.join(video_dir, filename)
    tmp_path = filepath + '.part'
    urllib.request.urlretrieve(direct_url, tmp_path)
    os.replace(tmp_path, filepath)
    return filepath


def start_download(download_id, tweet_url, direct_url, out_dir, post_date=''):  # pragma: no cover
    """Start a background download. Returns immediately; poll get_download_status()."""
    video_dir = os.path.join(out_dir, 'videos')
    os.makedirs(video_dir, exist_ok=True)

    with _downloads_lock:
        _downloads[download_id] = {
            'status': 'downloading',
            'progress': None,
            'path': None,
            'error': None,
        }

    def run():
        try:
            if check_ytdlp():
                _download_with_ytdlp(download_id, tweet_url, video_dir, post_date)
            elif direct_url:
                with _downloads_lock:
                    _downloads[download_id]['progress'] = 0
                # Extract tweet ID from URL
                m = re.search(r'/status/(\d+)', tweet_url)
                tweet_id = m.group(1) if m else download_id
                path = download_direct(direct_url, tweet_id, video_dir, post_date)
                with _downloads_lock:
                    _downloads[download_id].update(
                        progress=100, status='done', path=path)
            else:
                with _downloads_lock:
                    _downloads[download_id].update(
                        status='error',
                        error='yt-dlp not found and no direct URL available')
        except Exception as e:
            with _downloads_lock:
                _downloads[download_id].update(
                    status='error', error=str(e))

    t = threading.Thread(target=run, daemon=True)
    t.start()


class _YtdlpProgress:
    """Parse yt-dlp stdout and scale progress across multiple HLS streams.

    Call feed(line) for each stripped stdout line.  Read .progress for the
    current 0-100 value and .final_path for the last detected output path.
    """

    _progress_re = re.compile(r'(\d+\.?\d*)%')
    _format_re = re.compile(r'Downloading \d+ format\(s\): (.+)')

    def __init__(self):
        self.total_streams = 1
        self.stream_index = 0
        self.dest_count = 0
        self.progress = 0.0
        self.final_path = None

    def feed(self, line: str):
        # Detect multi-stream downloads by counting '+' in format string
        # ("Downloading 1 format(s): hls-707+hls-audio" -> 2 streams)
        if line.startswith('[info]'):
            fm = self._format_re.search(line)
            if fm:
                self.total_streams = max(1, fm.group(1).count('+') + 1)

        # Parse progress percentage, scaled across streams.
        # Exclude Destination / already-downloaded lines so a tweet title
        # containing "%" (e.g. "100% agree") doesn't poison progress.
        if line.startswith('[download]') and 'Destination:' not in line and 'has already been downloaded' not in line:
            m = self._progress_re.search(line)
            if m:
                raw_pct = float(m.group(1))
                pct = min((self.stream_index * 100 + raw_pct) / self.total_streams, 100.0)
                # Never report backward progress (safety net if stream
                # count detection is wrong or yt-dlp format changes)
                if pct >= self.progress:
                    self.progress = pct

        # Capture output filename from [download] or [Merger] lines
        if 'Destination:' in line:
            self.dest_count += 1
            if self.dest_count > self.total_streams:
                # More streams than the format line indicated (or format
                # line was missing).  Recalibrate so the monotonic guard
                # doesn't lock progress at 100% for the rest of the download.
                self.total_streams = self.dest_count
                self.progress = min(
                    self.progress,
                    (self.dest_count - 1) * 100.0 / self.total_streams)
            self.stream_index = min(self.dest_count - 1, self.total_streams - 1)
            self.final_path = line.split('Destination:', 1)[1].strip()
        elif 'has already been downloaded' in line:
            self.dest_count += 1
            if self.dest_count > self.total_streams:
                self.total_streams = self.dest_count
            self.stream_index = min(self.dest_count - 1, self.total_streams - 1)
            # Count cached stream as complete for progress
            pct = min((self.stream_index + 1) * 100.0 / self.total_streams, 100.0)
            if pct >= self.progress:
                self.progress = pct
            # "[download] <path> has already been downloaded"
            part = line.split(']', 1)[1].strip() if ']' in line else line
            self.final_path = part.replace(' has already been downloaded', '').strip()
        elif '[Merger]' in line and 'Merging formats into' in line:
            self.final_path = line.split('Merging formats into "', 1)[1].rstrip('"').strip() if '"' in line else self.final_path


def _download_with_ytdlp(download_id, tweet_url, video_dir, post_date=''):  # pragma: no cover
    """Download using yt-dlp with progress parsing.

    Downloads into a .downloading/ staging subdirectory so partial files
    are not visible in video_dir until the download is fully complete.
    """
    staging_dir = os.path.join(video_dir, '.downloading')
    os.makedirs(staging_dir, exist_ok=True)
    prefix = _date_prefix(post_date)
    # Pin the tweet status ID in the filename rather than relying on %(id)s,
    # which some yt-dlp Twitter sub-extractors (amplify/broadcast/card) fill
    # with a media or broadcast ID instead of the tweet ID.
    m = re.search(r'/status/(\d+)', tweet_url)
    id_part = m.group(1) if m else '%(id)s'
    output_template = os.path.join(staging_dir, prefix + '%(title)s [' + id_part + '].%(ext)s')
    cmd = [
        _ytdlp_path,
        '--newline', '--progress',
        '--cookies-from-browser', 'chrome',
        '-o', output_template,
        tweet_url,
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    tracker = _YtdlpProgress()
    last_lines = []
    for line in proc.stdout:
        line = line.strip()
        if line:
            last_lines.append(line)
            if len(last_lines) > 20:
                last_lines.pop(0)
            print(f'[yt-dlp] {line}', file=sys.stderr)
        tracker.feed(line)
        with _downloads_lock:
            _downloads[download_id]['progress'] = tracker.progress
    proc.wait()
    if proc.returncode != 0:
        # Include yt-dlp's error output in the exception
        error_lines = [l for l in last_lines if 'ERROR' in l]
        detail = error_lines[-1] if error_lines else (last_lines[-1] if last_lines else '')
        raise RuntimeError(f'yt-dlp failed: {detail}' if detail else f'yt-dlp exited with code {proc.returncode}')
    # Move completed file from staging dir to final video_dir
    final_path = tracker.final_path
    if final_path and os.path.isfile(final_path):
        dest_path = os.path.join(video_dir, os.path.basename(final_path))
        shutil.move(final_path, dest_path)
        final_path = dest_path
    with _downloads_lock:
        _downloads[download_id].update(
            progress=100, status='done', path=final_path)


# --- Image download ---

# Strip a trailing :orig / :large / :medium etc. suffix Twitter appends to media URLs.
_TWIMG_SIZE_SUFFIX_RE = re.compile(r':(orig|large|medium|small|thumb|tiny)$')

# Twitter snowflake IDs are numeric; reject anything else to block path traversal.
_TWEET_ID_RE = re.compile(r'^[0-9]+$')

# Only fetch from these CDN hosts. Anything else (including redirects) is rejected.
ALLOWED_IMAGE_HOSTS = frozenset({'pbs.twimg.com'})


def _env_int(name, default):
    """Parse an int env var, falling back to default on missing/empty/invalid."""
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f'[xtap:image] invalid {name}={raw!r}, using {default}', file=sys.stderr)
        return default


def _env_float(name, default):
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f'[xtap:image] invalid {name}={raw!r}, using {default}', file=sys.stderr)
        return default


def _photo_filename(url):
    """Extract the CDN filename from a pbs.twimg.com photo URL.

    Returns the basename without any trailing :size suffix, or None if the URL
    has no usable filename or contains traversal components.
    """
    if not url:
        return None
    cleaned = _TWIMG_SIZE_SUFFIX_RE.sub('', url)
    path = urlparse(cleaned).path or cleaned
    name = os.path.basename(path)
    if not name or name in ('.', '..'):
        return None
    # Reject anything with path separators or that would still resolve to a
    # parent directory after basename (defense in depth).
    if '/' in name or '\\' in name or name.startswith('.'):
        return None
    return name


def _is_safe_rel_path(out_dir, rel_path):
    """Verify joining rel_path with out_dir stays under out_dir.

    Catches absolute paths (`/etc/...`), traversal (`../foo`), and Windows
    drive-letter paths.
    """
    if not rel_path or os.path.isabs(rel_path):
        return False
    out_real = os.path.realpath(out_dir)
    candidate = os.path.realpath(os.path.join(out_real, rel_path))
    try:
        return os.path.commonpath([out_real, candidate]) == out_real
    except ValueError:  # pragma: no cover — Windows-only: different drives
        return False


def collect_image_jobs(tweets, out_dir):
    """Compute the list of image download jobs for a batch of tweets.

    For top-level photo media the rel_path is derived by convention
    (`media/<tweet_id>/<cdn_filename>`) — the JSONL never carries a
    redundant `local_path` field for these. Consumers who need the path
    can reconstruct it from `id` + `basename(url)`.

    Article media items (under `tweet.article.media[]`) already have
    `local_path` set by the JS parser because that path is also embedded
    in the article's rendered Markdown text (`![](media/<id>/file.png)`).
    Those entries are validated here but not mutated; if the supplied
    `local_path` would escape `out_dir`, the field is stripped so the
    unsafe path never lands in the JSONL.

    Path components are validated against `out_dir`: tweet IDs must match
    [0-9]+, filenames must be plain basenames, and the final resolved
    path must stay under `out_dir`. Anything that fails validation is
    skipped.

    Returns: list of {tweet_id, url, rel_path} ready for the downloader.
    """
    pending = []
    for tweet in tweets:
        tweet_id = tweet.get('id')
        if not tweet_id or not isinstance(tweet_id, str) or not _TWEET_ID_RE.match(tweet_id):
            continue

        # Top-level photo media (regular tweets) — derived path, no mutation.
        for item in tweet.get('media') or []:
            if not isinstance(item, dict) or item.get('type') != 'photo':
                continue
            url = item.get('url')
            filename = _photo_filename(url)
            if not filename:
                continue
            rel_path = f'media/{tweet_id}/{filename}'
            if not _is_safe_rel_path(out_dir, rel_path):
                continue
            pending.append({'tweet_id': tweet_id, 'url': url, 'rel_path': rel_path})

        # Article media — local_path crosses the trust boundary in the
        # request body, so re-validate it here.
        article = tweet.get('article') or {}
        for item in article.get('media') or []:
            if not isinstance(item, dict):
                continue
            url = item.get('url')
            rel_path = item.get('local_path')
            if not url or not isinstance(rel_path, str):
                continue
            if not _is_safe_rel_path(out_dir, rel_path):
                # Strip the unsafe path so it doesn't end up in the JSONL.
                item.pop('local_path', None)
                continue
            pending.append({'tweet_id': tweet_id, 'url': url, 'rel_path': rel_path})

    return pending


_image_downloader = None
_image_downloader_lock = threading.Lock()


def get_image_downloader():
    """Lazily construct the singleton ImageDownloader."""
    global _image_downloader
    with _image_downloader_lock:
        if _image_downloader is None:
            _image_downloader = ImageDownloader()
        return _image_downloader


def reset_image_downloader():
    """Reset the singleton (test-only — leaks the previous worker thread)."""
    global _image_downloader
    with _image_downloader_lock:
        _image_downloader = None


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Treat any redirect as an error so we never fetch beyond the allowlisted host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f'redirect to {newurl} blocked', headers, fp)


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())


class ImageDownloader:
    """Single background-thread image downloader with hardened HTTP fetch.

    - One worker, one queue. Per-job cost is small so a single thread is fine
      and avoids hammering the CDN.
    - Idempotent: if the destination file already exists, skip the network call
      and log status='exists'.
    - URL hostname is checked against ALLOWED_IMAGE_HOSTS before every request.
      Redirects are blocked entirely (so an attacker can't 302 us off-allowlist).
    - Per-file size cap (XTAP_MAX_FILE_MB, default 50) bounds disk impact even
      for adversarial responses. Optional cumulative cap via XTAP_MAX_MEDIA_MB.
    - 429 responses trigger exponential backoff (capped at MAX_BACKOFF_S).
      Other HTTP errors and network failures log status='error'.
    """

    DEFAULT_DELAY_MS = 100
    DEFAULT_MAX_FILE_MB = 50
    USER_AGENT = 'xTap/1.0 (+https://github.com/mkubicek/xTap)'
    MAX_BACKOFF_S = 30
    REQUEST_TIMEOUT_S = 30
    CHUNK_SIZE = 64 * 1024

    def __init__(self):
        self.queue = queue.Queue()
        self.delay_s = max(0.0, _env_int('XTAP_IMAGE_DELAY_MS', self.DEFAULT_DELAY_MS) / 1000.0)
        max_total_mb = _env_float('XTAP_MAX_MEDIA_MB', 0.0)
        self.max_bytes = int(max_total_mb * 1024 * 1024) if max_total_mb > 0 else None
        max_file_mb = _env_float('XTAP_MAX_FILE_MB', float(self.DEFAULT_MAX_FILE_MB))
        self.max_file_bytes = int(max_file_mb * 1024 * 1024) if max_file_mb > 0 else None
        self._bytes_lock = threading.Lock()
        self.bytes_downloaded = 0
        self._last_request_at = 0.0
        self._thread = threading.Thread(target=self._run, daemon=True, name='xtap-image-downloader')
        self._thread.start()

    def enqueue(self, jobs, out_dir):
        """Enqueue a batch of pending downloads against the given output dir."""
        for job in jobs:
            self.queue.put((job, out_dir))

    def _run(self):
        while True:
            try:
                job, out_dir = self.queue.get()
            except Exception:  # pragma: no cover — only fires at interpreter shutdown
                continue
            try:
                self._process(job, out_dir)
            except Exception as e:  # pragma: no cover — defensive
                print(f'[xtap:image] worker exception: {e}', file=sys.stderr)
            finally:
                self.queue.task_done()

    def _process(self, job, out_dir):
        tweet_id = job['tweet_id']
        url = job['url']
        rel_path = job['rel_path']

        # Re-validate the rel_path defensively: enqueue() is exported and a
        # future caller could skip inject_image_local_paths.
        if not _is_safe_rel_path(out_dir, rel_path):
            self._log(out_dir, tweet_id, url, rel_path, 'error:unsafe_path', 0)
            return

        dest_path = os.path.join(out_dir, rel_path)

        if os.path.exists(dest_path):
            self._log(out_dir, tweet_id, url, dest_path, 'exists', os.path.getsize(dest_path))
            return

        if not _is_allowed_url(url):
            self._log(out_dir, tweet_id, url, dest_path, 'error:host_not_allowed', 0)
            return

        if self.max_bytes is not None:
            with self._bytes_lock:
                over_quota = self.bytes_downloaded >= self.max_bytes
            if over_quota:
                self._log(out_dir, tweet_id, url, dest_path, 'skipped:quota', 0)
                return

        # Simple rate limiter: enforce delay_s between requests.
        if self.delay_s > 0:
            wait = self.delay_s - (time.monotonic() - self._last_request_at)
            if wait > 0:
                time.sleep(wait)

        size, err = self._download(url, dest_path)
        self._last_request_at = time.monotonic()

        if err:
            self._log(out_dir, tweet_id, url, dest_path, f'error:{err}', 0)
            return

        with self._bytes_lock:
            self.bytes_downloaded += size
        self._log(out_dir, tweet_id, url, dest_path, 'ok', size)

    def _download(self, url, dest_path):
        """Download to a .part file and rename atomically. Returns (bytes, error)."""
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        tmp_path = dest_path + '.part'
        backoff = 1.0
        attempts = 0
        while True:
            attempts += 1
            req = urllib.request.Request(url, headers={'User-Agent': self.USER_AGENT})
            try:
                with _NO_REDIRECT_OPENER.open(req, timeout=self.REQUEST_TIMEOUT_S) as resp:
                    # Reject up-front when Content-Length advertises an oversize body.
                    if self.max_file_bytes is not None:
                        cl = resp.headers.get('Content-Length')
                        if cl and cl.isdigit() and int(cl) > self.max_file_bytes:
                            return 0, 'too_large'
                    written = 0
                    with open(tmp_path, 'wb') as f:
                        while True:
                            chunk = resp.read(self.CHUNK_SIZE)
                            if not chunk:
                                break
                            written += len(chunk)
                            if self.max_file_bytes is not None and written > self.max_file_bytes:
                                _safe_unlink(tmp_path)
                                return 0, 'too_large'
                            f.write(chunk)
                size = os.path.getsize(tmp_path)
                os.replace(tmp_path, dest_path)
                return size, None
            except urllib.error.HTTPError as e:
                _safe_unlink(tmp_path)
                if e.code == 429 and backoff <= self.MAX_BACKOFF_S and attempts < 4:
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                return 0, f'http_{e.code}'
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                _safe_unlink(tmp_path)
                return 0, type(e).__name__

    def _log(self, out_dir, tweet_id, url, dest_path, status, size):
        try:
            local_path = os.path.relpath(dest_path, out_dir)
        except ValueError:  # pragma: no cover — Windows-only: different drives
            local_path = dest_path
        entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'tweet_id': tweet_id,
            'url': url,
            'local_path': local_path,
            'status': status,
            'bytes': size,
        }
        manifest_path = os.path.join(out_dir, 'media-manifest.jsonl')
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(manifest_path, 'a') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        except OSError as e:
            print(f'[xtap:image] manifest write failed: {e}', file=sys.stderr)


def _is_allowed_url(url):
    """True iff url is https and the hostname is in ALLOWED_IMAGE_HOSTS."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
    except ValueError:  # pragma: no cover — urlparse rarely raises in practice
        return False
    if parsed.scheme != 'https':
        return False
    host = (parsed.hostname or '').lower()
    return host in ALLOWED_IMAGE_HOSTS


def _safe_unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass
