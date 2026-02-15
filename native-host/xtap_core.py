"""xTap Core — shared file I/O logic used by both native host and HTTP daemon."""

import glob
import json
import os
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
            if tid and tid in seen_ids:
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


def test_path(out_dir):
    """Test that we can write to the output directory. Raises on failure."""
    os.makedirs(out_dir, exist_ok=True)
    test_file = os.path.join(out_dir, '.xtap-write-test')
    with open(test_file, 'w') as f:
        f.write('ok')
    os.remove(test_file)
