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
from datetime import date


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


def check_ytdlp():
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


def download_direct(direct_url, tweet_id, video_dir, post_date=''):
    """Download video via direct CDN URL. Returns the file path."""
    os.makedirs(video_dir, exist_ok=True)
    prefix = _date_prefix(post_date)
    filename = f'{prefix}{tweet_id}.mp4'
    filepath = os.path.join(video_dir, filename)
    urllib.request.urlretrieve(direct_url, filepath)
    return filepath


def start_download(download_id, tweet_url, direct_url, out_dir, post_date=''):
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


def _download_with_ytdlp(download_id, tweet_url, video_dir, post_date=''):
    """Download using yt-dlp with progress parsing."""
    prefix = _date_prefix(post_date)
    output_template = os.path.join(video_dir, prefix + '%(title)s [%(id)s].%(ext)s')
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
    _downloads[download_id]['progress'] = 100
    _downloads[download_id]['status'] = 'done'
    _downloads[download_id]['path'] = final_path
