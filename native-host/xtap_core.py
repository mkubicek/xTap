"""xTap Core — shared file I/O logic used by both native host and HTTP daemon."""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
from datetime import date, datetime, timezone


DEFAULT_OUTPUT_DIR = os.environ.get('XTAP_OUTPUT_DIR', os.path.expanduser('~/Downloads/xtap'))


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
        out_dir = os.path.expanduser(msg_dir)
        os.makedirs(out_dir, exist_ok=True)
        if out_dir != default_dir and out_dir not in custom_dirs:
            seen_ids.update(load_seen_ids(out_dir))
            custom_dirs.add(out_dir)
    else:
        out_dir = default_dir
    return out_dir


def get_file_stats(out_dir):
    """Glob tweets-*.jsonl, return list of {date, count} dicts sorted newest-first."""
    stats = []
    for path in glob.glob(os.path.join(out_dir, 'tweets-*.jsonl')):
        basename = os.path.basename(path)
        # Extract date from tweets-YYYY-MM-DD.jsonl
        m = re.match(r'tweets-(\d{4}-\d{2}-\d{2})\.jsonl$', basename)
        if not m:
            continue
        with open(path, 'r') as f:
            count = sum(1 for line in f if line.strip())
        stats.append({'date': m.group(1), 'count': count})
    stats.sort(key=lambda s: s['date'], reverse=True)
    return stats


_USERNAME_RE = re.compile(r'"username"\s*:\s*"([^"]+)"')


def get_authors(out_dir, date_filter=None):
    """Extract unique author usernames from JSONL files via regex (no JSON parsing).

    Returns sorted list of usernames.
    """
    pattern = (f'tweets-{date_filter}.jsonl' if date_filter
               else 'tweets-*.jsonl')
    paths = glob.glob(os.path.join(out_dir, pattern))
    authors = set()
    for path in paths:
        with open(path, 'r') as f:
            for line in f:
                m = _USERNAME_RE.search(line)
                if m:
                    authors.add(m.group(1))
    return sorted(authors, key=str.lower)


def read_tweets(out_dir, q=None, date_filter=None, author=None,
                offset=0, limit=100):
    """Read tweets from JSONL files. Returns (tweets_list, total_scanned, total_matched).

    Optionally filter to a single date file. If q is set, do case-insensitive
    substring match on the raw line before JSON-parsing (fast path).
    If author is set, match against "username": "value" in the raw line.
    Results sorted by created_at descending (newest first).
    """
    pattern = (f'tweets-{date_filter}.jsonl' if date_filter
               else 'tweets-*.jsonl')
    paths = glob.glob(os.path.join(out_dir, pattern))
    q_lower = q.lower() if q else None
    author_needle = f'"username": "{author}"' if author else None

    matched = []
    total_scanned = 0

    for path in paths:
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total_scanned += 1
                if q_lower and q_lower not in line.lower():
                    continue
                if author_needle and author_needle not in line:
                    continue
                try:
                    matched.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    matched.sort(key=lambda t: t.get('captured_at') or t.get('created_at') or '', reverse=True)
    total_matched = len(matched)
    tweets = matched[offset:offset + limit]

    return tweets, total_scanned, total_matched


def write_tweets(tweets, out_dir, seen_ids):
    """Write tweets to JSONL, deduplicating against seen_ids. Returns (count, dupes)."""
    out_file = os.path.join(out_dir, f'tweets-{date.today().isoformat()}.jsonl')
    count = 0
    dupes = 0
    now = datetime.now(timezone.utc).isoformat()
    with open(out_file, 'a') as f:
        for tweet in tweets:
            tid = tweet.get('id')
            if tid and tid in seen_ids and not tweet.get('is_article'):
                dupes += 1
                continue
            if tid:
                seen_ids.add(tid)
            record = {**tweet, 'captured_at': now}
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
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
    dump_file = os.path.join(out_dir, filename)
    with open(dump_file, 'w') as f:
        f.write(content)
    return dump_file


def test_path(out_dir):
    """Test that we can write to the output directory. Raises on failure."""
    os.makedirs(out_dir, exist_ok=True)
    test_file = os.path.join(out_dir, '.xtap-write-test')
    with open(test_file, 'w') as f:
        f.write('ok')
    os.remove(test_file)


# --- Video download ---

_ytdlp_path = None
_ytdlp_checked = False
_downloads = {}


def check_ytdlp():  # pragma: no cover
    """Check if yt-dlp is available on PATH. Cached after first call."""
    global _ytdlp_path, _ytdlp_checked
    if not _ytdlp_checked:
        _ytdlp_path = shutil.which('yt-dlp')
        _ytdlp_checked = True
    return _ytdlp_path is not None


def get_download_status(download_id):
    """Return current state of a download."""
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
                _downloads[download_id]['progress'] = 0
                # Extract tweet ID from URL
                m = re.search(r'/status/(\d+)', tweet_url)
                tweet_id = m.group(1) if m else download_id
                path = download_direct(direct_url, tweet_id, video_dir, post_date)
                _downloads[download_id]['progress'] = 100
                _downloads[download_id]['status'] = 'done'
                _downloads[download_id]['path'] = path
            else:
                _downloads[download_id]['status'] = 'error'
                _downloads[download_id]['error'] = 'yt-dlp not found and no direct URL available'
        except Exception as e:
            _downloads[download_id]['status'] = 'error'
            _downloads[download_id]['error'] = str(e)

    t = threading.Thread(target=run, daemon=True)
    t.start()


def _download_with_ytdlp(download_id, tweet_url, video_dir, post_date=''):  # pragma: no cover
    """Download using yt-dlp with progress parsing.

    Downloads into a .downloading/ staging subdirectory so partial files
    are not visible in video_dir until the download is fully complete.
    """
    staging_dir = os.path.join(video_dir, '.downloading')
    os.makedirs(staging_dir, exist_ok=True)
    prefix = _date_prefix(post_date)
    output_template = os.path.join(staging_dir, prefix + '%(title)s [%(id)s].%(ext)s')
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
    progress_re = re.compile(r'(\d+\.?\d*)%')
    final_path = None
    last_lines = []
    for line in proc.stdout:
        line = line.strip()
        if line:
            last_lines.append(line)
            if len(last_lines) > 20:
                last_lines.pop(0)
            print(f'[yt-dlp] {line}', file=sys.stderr)
        # Parse progress percentage
        m = progress_re.search(line)
        if m:
            _downloads[download_id]['progress'] = float(m.group(1))
        # Capture output filename from [download] or [Merger] lines
        if 'Destination:' in line:
            final_path = line.split('Destination:', 1)[1].strip()
        elif 'has already been downloaded' in line:
            # "[download] <path> has already been downloaded"
            part = line.split(']', 1)[1].strip() if ']' in line else line
            final_path = part.replace(' has already been downloaded', '').strip()
        elif '[Merger]' in line and 'Merging formats into' in line:
            final_path = line.split('Merging formats into "', 1)[1].rstrip('"').strip() if '"' in line else final_path
    proc.wait()
    if proc.returncode != 0:
        # Include yt-dlp's error output in the exception
        error_lines = [l for l in last_lines if 'ERROR' in l]
        detail = error_lines[-1] if error_lines else (last_lines[-1] if last_lines else '')
        raise RuntimeError(f'yt-dlp failed: {detail}' if detail else f'yt-dlp exited with code {proc.returncode}')
    # Move completed file from staging dir to final video_dir
    if final_path and os.path.isfile(final_path):
        dest_path = os.path.join(video_dir, os.path.basename(final_path))
        shutil.move(final_path, dest_path)
        final_path = dest_path
    _downloads[download_id]['progress'] = 100
    _downloads[download_id]['status'] = 'done'
    _downloads[download_id]['path'] = final_path
