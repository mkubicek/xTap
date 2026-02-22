"""Tests for native-host/xtap_core.py"""

import json
import os
import sys

import pytest

# Import module under test
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'native-host'))
import xtap_core


# ---------------------------------------------------------------------------
# _date_prefix
# ---------------------------------------------------------------------------


class TestDatePrefix:
    def test_iso_datetime(self):
        assert xtap_core._date_prefix('2024-01-15T12:34:56.000Z') == '2024.01.15_'

    def test_date_only(self):
        assert xtap_core._date_prefix('2024-01-15') == '2024.01.15_'

    def test_empty_string(self):
        assert xtap_core._date_prefix('') == ''

    def test_none(self):
        assert xtap_core._date_prefix(None) == ''


# ---------------------------------------------------------------------------
# load_seen_ids
# ---------------------------------------------------------------------------


class TestLoadSeenIds:
    def test_empty_dir(self, tmp_path):
        assert xtap_core.load_seen_ids(str(tmp_path)) == set()

    def test_single_file(self, tmp_path):
        f = tmp_path / 'tweets-2024-01-15.jsonl'
        f.write_text(
            json.dumps({'id': '111', 'text': 'a'}) + '\n'
            + json.dumps({'id': '222', 'text': 'b'}) + '\n'
        )
        assert xtap_core.load_seen_ids(str(tmp_path)) == {'111', '222'}

    def test_multiple_files(self, tmp_path):
        (tmp_path / 'tweets-2024-01-15.jsonl').write_text(
            json.dumps({'id': '111'}) + '\n'
        )
        (tmp_path / 'tweets-2024-01-16.jsonl').write_text(
            json.dumps({'id': '222'}) + '\n'
        )
        assert xtap_core.load_seen_ids(str(tmp_path)) == {'111', '222'}

    def test_bad_json_skipped(self, tmp_path):
        f = tmp_path / 'tweets-2024-01-15.jsonl'
        f.write_text('not json\n' + json.dumps({'id': '111'}) + '\n')
        assert xtap_core.load_seen_ids(str(tmp_path)) == {'111'}

    def test_missing_id_not_added(self, tmp_path):
        f = tmp_path / 'tweets-2024-01-15.jsonl'
        f.write_text(json.dumps({'text': 'no id'}) + '\n')
        assert xtap_core.load_seen_ids(str(tmp_path)) == set()

    def test_non_matching_filenames_ignored(self, tmp_path):
        (tmp_path / 'debug-2024-01-15.log').write_text(
            json.dumps({'id': '999'}) + '\n'
        )
        assert xtap_core.load_seen_ids(str(tmp_path)) == set()

    def test_blank_lines_skipped(self, tmp_path):
        f = tmp_path / 'tweets-2024-01-15.jsonl'
        f.write_text('\n' + json.dumps({'id': '111'}) + '\n\n')
        assert xtap_core.load_seen_ids(str(tmp_path)) == {'111'}


# ---------------------------------------------------------------------------
# write_tweets
# ---------------------------------------------------------------------------


class TestWriteTweets:
    def test_basic_write(self, tmp_path):
        seen = set()
        tweets = [{'id': '1', 'text': 'a'}, {'id': '2', 'text': 'b'}]
        count, dupes = xtap_core.write_tweets(tweets, str(tmp_path), seen)
        assert count == 2
        assert dupes == 0
        # Verify file has 2 lines
        files = list(tmp_path.glob('tweets-*.jsonl'))
        assert len(files) == 1
        lines = files[0].read_text().strip().split('\n')
        assert len(lines) == 2

    def test_dedup_against_seen(self, tmp_path):
        seen = {'1'}
        tweets = [{'id': '1', 'text': 'a'}, {'id': '2', 'text': 'b'}]
        count, dupes = xtap_core.write_tweets(tweets, str(tmp_path), seen)
        assert count == 1
        assert dupes == 1

    def test_seen_ids_mutated(self, tmp_path):
        seen = set()
        tweets = [{'id': '1', 'text': 'a'}]
        xtap_core.write_tweets(tweets, str(tmp_path), seen)
        assert '1' in seen

    def test_consecutive_calls_dedup(self, tmp_path):
        seen = set()
        xtap_core.write_tweets([{'id': '1', 'text': 'a'}], str(tmp_path), seen)
        count, dupes = xtap_core.write_tweets([{'id': '1', 'text': 'a'}], str(tmp_path), seen)
        assert count == 0
        assert dupes == 1

    def test_article_bypasses_dedup(self, tmp_path):
        seen = {'1'}
        tweets = [{'id': '1', 'text': 'article', 'is_article': True}]
        count, dupes = xtap_core.write_tweets(tweets, str(tmp_path), seen)
        assert count == 1
        assert dupes == 0

    def test_tweet_without_id_written(self, tmp_path):
        seen = set()
        tweets = [{'text': 'no id'}]
        count, dupes = xtap_core.write_tweets(tweets, str(tmp_path), seen)
        assert count == 1
        assert dupes == 0
        # Should not add None to seen_ids
        assert None not in seen
        assert len(seen) == 0

    def test_appends_to_existing_file(self, tmp_path):
        seen = set()
        xtap_core.write_tweets([{'id': '1', 'text': 'a'}], str(tmp_path), seen)
        xtap_core.write_tweets([{'id': '2', 'text': 'b'}], str(tmp_path), seen)
        files = list(tmp_path.glob('tweets-*.jsonl'))
        lines = files[0].read_text().strip().split('\n')
        assert len(lines) == 2

    def test_unicode_preserved(self, tmp_path):
        seen = set()
        tweets = [{'id': '1', 'text': 'Hello \u4e16\u754c \U0001f30d'}]
        xtap_core.write_tweets(tweets, str(tmp_path), seen)
        files = list(tmp_path.glob('tweets-*.jsonl'))
        content = files[0].read_text()
        assert '\u4e16\u754c' in content
        assert '\U0001f30d' in content  # not escaped


# ---------------------------------------------------------------------------
# resolve_output_dir
# ---------------------------------------------------------------------------


class TestResolveOutputDir:
    def test_falsy_msg_dir(self, tmp_path):
        default = str(tmp_path / 'default')
        result = xtap_core.resolve_output_dir('', default, set(), set())
        assert result == default

    def test_none_msg_dir(self, tmp_path):
        default = str(tmp_path / 'default')
        result = xtap_core.resolve_output_dir(None, default, set(), set())
        assert result == default

    def test_custom_dir_created(self, tmp_path):
        custom = str(tmp_path / 'custom')
        seen = set()
        custom_dirs = set()
        result = xtap_core.resolve_output_dir(custom, '/default', seen, custom_dirs)
        assert result == custom
        assert os.path.isdir(custom)
        assert custom in custom_dirs

    def test_custom_dir_no_reload(self, tmp_path):
        custom = str(tmp_path / 'custom')
        os.makedirs(custom)
        seen = set()
        custom_dirs = set()
        # First call adds to custom_dirs
        xtap_core.resolve_output_dir(custom, '/default', seen, custom_dirs)
        assert custom in custom_dirs
        # Second call — custom_dirs already has it, load_seen_ids not called again
        old_size = len(custom_dirs)
        xtap_core.resolve_output_dir(custom, '/default', seen, custom_dirs)
        assert len(custom_dirs) == old_size

    def test_tilde_expansion(self, tmp_path):
        seen = set()
        custom_dirs = set()
        result = xtap_core.resolve_output_dir('~/xtap-test-dir', '/default', seen, custom_dirs)
        expected = os.path.expanduser('~/xtap-test-dir')
        assert result == expected
        # Clean up
        if os.path.isdir(expected):
            os.rmdir(expected)

    def test_custom_dir_loads_seen_ids(self, tmp_path):
        custom = str(tmp_path / 'custom')
        os.makedirs(custom)
        (tmp_path / 'custom' / 'tweets-2024-01-15.jsonl').write_text(
            json.dumps({'id': '999'}) + '\n'
        )
        seen = set()
        custom_dirs = set()
        xtap_core.resolve_output_dir(custom, '/default', seen, custom_dirs)
        assert '999' in seen
