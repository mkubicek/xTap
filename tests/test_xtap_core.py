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

    def test_non_string_returns_empty(self):
        assert xtap_core._date_prefix(12345) == ''


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


# ---------------------------------------------------------------------------
# write_log
# ---------------------------------------------------------------------------


class TestWriteLog:
    def test_basic_write(self, tmp_path):
        count = xtap_core.write_log(['line one', 'line two'], str(tmp_path))
        assert count == 2
        files = list(tmp_path.glob('debug-*.log'))
        assert len(files) == 1
        content = files[0].read_text()
        assert 'line one\n' in content
        assert 'line two\n' in content

    def test_appends(self, tmp_path):
        xtap_core.write_log(['first'], str(tmp_path))
        xtap_core.write_log(['second'], str(tmp_path))
        files = list(tmp_path.glob('debug-*.log'))
        lines = files[0].read_text().strip().split('\n')
        assert len(lines) == 2

    def test_empty_list(self, tmp_path):
        count = xtap_core.write_log([], str(tmp_path))
        assert count == 0


# ---------------------------------------------------------------------------
# write_dump
# ---------------------------------------------------------------------------


class TestWriteDump:
    def test_basic_write(self, tmp_path):
        path = xtap_core.write_dump('test.json', '{"key": "value"}', str(tmp_path))
        assert os.path.exists(path)
        assert (tmp_path / 'test.json').read_text() == '{"key": "value"}'

    def test_overwrites_existing(self, tmp_path):
        xtap_core.write_dump('test.json', 'old', str(tmp_path))
        xtap_core.write_dump('test.json', 'new', str(tmp_path))
        assert (tmp_path / 'test.json').read_text() == 'new'


# ---------------------------------------------------------------------------
# test_path
# ---------------------------------------------------------------------------


class TestTestPath:
    def test_writable_dir(self, tmp_path):
        xtap_core.test_path(str(tmp_path))  # should not raise

    def test_creates_dir(self, tmp_path):
        new_dir = str(tmp_path / 'sub' / 'dir')
        xtap_core.test_path(new_dir)
        assert os.path.isdir(new_dir)

    def test_no_leftover_file(self, tmp_path):
        xtap_core.test_path(str(tmp_path))
        assert not (tmp_path / '.xtap-write-test').exists()


# ---------------------------------------------------------------------------
# get_download_status
# ---------------------------------------------------------------------------


class TestGetDownloadStatus:
    def test_unknown_id(self):
        result = xtap_core.get_download_status('nonexistent-id')
        assert result == {'status': 'unknown'}

    def test_known_download(self):
        xtap_core._downloads['test-dl'] = {
            'status': 'downloading',
            'progress': 50.0,
            'path': None,
            'error': None,
        }
        result = xtap_core.get_download_status('test-dl')
        assert result['status'] == 'downloading'
        assert result['progress'] == 50.0
        # Clean up
        del xtap_core._downloads['test-dl']

    def test_completed_download(self):
        xtap_core._downloads['test-done'] = {
            'status': 'done',
            'progress': 100,
            'path': '/tmp/video.mp4',
            'error': None,
        }
        result = xtap_core.get_download_status('test-done')
        assert result['status'] == 'done'
        assert result['path'] == '/tmp/video.mp4'
        del xtap_core._downloads['test-done']


# ---------------------------------------------------------------------------
# get_file_stats
# ---------------------------------------------------------------------------


class TestGetFileStats:
    def test_empty_dir(self, tmp_path):
        assert xtap_core.get_file_stats(str(tmp_path)) == []

    def test_single_file(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(json.dumps({'id': '1'}) + '\n' + json.dumps({'id': '2'}) + '\n')
        stats = xtap_core.get_file_stats(str(tmp_path))
        assert len(stats) == 1
        assert stats[0] == {'date': '2024-03-10', 'count': 2}

    def test_multiple_files_sorted_newest_first(self, tmp_path):
        (tmp_path / 'tweets-2024-01-01.jsonl').write_text(json.dumps({'id': '1'}) + '\n')
        (tmp_path / 'tweets-2024-03-15.jsonl').write_text(
            json.dumps({'id': '2'}) + '\n' + json.dumps({'id': '3'}) + '\n'
        )
        (tmp_path / 'tweets-2024-02-10.jsonl').write_text(json.dumps({'id': '4'}) + '\n')
        stats = xtap_core.get_file_stats(str(tmp_path))
        assert len(stats) == 3
        assert stats[0]['date'] == '2024-03-15'
        assert stats[1]['date'] == '2024-02-10'
        assert stats[2]['date'] == '2024-01-01'

    def test_blank_lines_not_counted(self, tmp_path):
        f = tmp_path / 'tweets-2024-01-01.jsonl'
        f.write_text(json.dumps({'id': '1'}) + '\n\n\n' + json.dumps({'id': '2'}) + '\n')
        stats = xtap_core.get_file_stats(str(tmp_path))
        assert stats[0]['count'] == 2

    def test_non_matching_files_ignored(self, tmp_path):
        (tmp_path / 'debug-2024-01-01.log').write_text('line\n')
        assert xtap_core.get_file_stats(str(tmp_path)) == []


# ---------------------------------------------------------------------------
# read_tweets
# ---------------------------------------------------------------------------


class TestReadTweets:
    def test_basic_read(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(json.dumps({'id': '1', 'text': 'hello'}) + '\n'
                     + json.dumps({'id': '2', 'text': 'world'}) + '\n')
        tweets, scanned, matched = xtap_core.read_tweets(str(tmp_path))
        assert len(tweets) == 2
        assert scanned == 2
        assert matched == 2

    def test_query_filter_case_insensitive(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(json.dumps({'id': '1', 'text': 'Hello World'}) + '\n'
                     + json.dumps({'id': '2', 'text': 'goodbye'}) + '\n')
        tweets, scanned, matched = xtap_core.read_tweets(str(tmp_path), q='hello')
        assert len(tweets) == 1
        assert tweets[0]['text'] == 'Hello World'
        assert scanned == 2
        assert matched == 1

    def test_date_filter(self, tmp_path):
        (tmp_path / 'tweets-2024-03-10.jsonl').write_text(
            json.dumps({'id': '1', 'text': 'day1'}) + '\n')
        (tmp_path / 'tweets-2024-03-11.jsonl').write_text(
            json.dumps({'id': '2', 'text': 'day2'}) + '\n')
        tweets, scanned, matched = xtap_core.read_tweets(
            str(tmp_path), date_filter='2024-03-11')
        assert len(tweets) == 1
        assert tweets[0]['text'] == 'day2'

    def test_offset_limit(self, tmp_path):
        # Tweets with timestamps so sorting is deterministic
        lines = [json.dumps({'id': str(i), 'text': f't{i}',
                             'created_at': f'2024-03-10T{10+i:02d}:00:00.000Z'})
                 for i in range(10)]
        (tmp_path / 'tweets-2024-03-10.jsonl').write_text('\n'.join(lines) + '\n')
        tweets, scanned, matched = xtap_core.read_tweets(
            str(tmp_path), offset=3, limit=2)
        assert len(tweets) == 2
        assert matched == 10
        # Sorted newest-first: ids 9,8,7,6,5... offset=3 skips 9,8,7
        assert tweets[0]['id'] == '6'
        assert tweets[1]['id'] == '5'

    def test_malformed_json_skipped(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text('not json\n' + json.dumps({'id': '1', 'text': 'ok'}) + '\n')
        tweets, scanned, matched = xtap_core.read_tweets(str(tmp_path))
        assert len(tweets) == 1
        assert tweets[0]['id'] == '1'

    def test_empty_dir(self, tmp_path):
        tweets, scanned, matched = xtap_core.read_tweets(str(tmp_path))
        assert tweets == []
        assert scanned == 0
        assert matched == 0

    def test_blank_lines_skipped(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text('\n' + json.dumps({'id': '1'}) + '\n\n')
        tweets, scanned, matched = xtap_core.read_tweets(str(tmp_path))
        assert len(tweets) == 1
        assert scanned == 1

    def test_author_filter(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(
            json.dumps({'id': '1', 'author': {'username': 'alice'}, 'text': 'hi'}) + '\n'
            + json.dumps({'id': '2', 'author': {'username': 'bob'}, 'text': 'yo'}) + '\n'
        )
        tweets, scanned, matched = xtap_core.read_tweets(
            str(tmp_path), author='alice')
        assert len(tweets) == 1
        assert tweets[0]['author']['username'] == 'alice'
        assert scanned == 2
        assert matched == 1

    def test_author_filter_exact_match(self, tmp_path):
        """Author 'al' should NOT match 'alice'."""
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(
            json.dumps({'id': '1', 'author': {'username': 'alice'}}) + '\n'
        )
        tweets, _, matched = xtap_core.read_tweets(str(tmp_path), author='al')
        assert matched == 0


# ---------------------------------------------------------------------------
# get_authors
# ---------------------------------------------------------------------------


class TestGetAuthors:
    def test_empty_dir(self, tmp_path):
        assert xtap_core.get_authors(str(tmp_path)) == []

    def test_extracts_unique_authors(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(
            json.dumps({'id': '1', 'author': {'username': 'bob'}}) + '\n'
            + json.dumps({'id': '2', 'author': {'username': 'alice'}}) + '\n'
            + json.dumps({'id': '3', 'author': {'username': 'bob'}}) + '\n'
        )
        authors = xtap_core.get_authors(str(tmp_path))
        assert authors == ['alice', 'bob']

    def test_date_filter(self, tmp_path):
        (tmp_path / 'tweets-2024-03-10.jsonl').write_text(
            json.dumps({'id': '1', 'author': {'username': 'alice'}}) + '\n')
        (tmp_path / 'tweets-2024-03-11.jsonl').write_text(
            json.dumps({'id': '2', 'author': {'username': 'bob'}}) + '\n')
        authors = xtap_core.get_authors(str(tmp_path), date_filter='2024-03-11')
        assert authors == ['bob']

    def test_case_insensitive_sort(self, tmp_path):
        f = tmp_path / 'tweets-2024-03-10.jsonl'
        f.write_text(
            json.dumps({'id': '1', 'author': {'username': 'Zoe'}}) + '\n'
            + json.dumps({'id': '2', 'author': {'username': 'alice'}}) + '\n'
        )
        authors = xtap_core.get_authors(str(tmp_path))
        assert authors == ['alice', 'Zoe']
