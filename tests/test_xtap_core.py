"""Tests for native-host/xtap_core.py"""

import json
import os
import sys
import threading

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

    def test_custom_dir_created(self, tmp_path, monkeypatch):
        monkeypatch.setattr(xtap_core, '_ALLOWED_ROOTS', (os.path.realpath(str(tmp_path)),))
        custom = str(tmp_path / 'custom')
        seen = set()
        custom_dirs = set()
        result = xtap_core.resolve_output_dir(custom, '/default', seen, custom_dirs)
        assert os.path.realpath(result) == os.path.realpath(custom)
        assert os.path.isdir(result)

    def test_custom_dir_no_reload(self, tmp_path, monkeypatch):
        monkeypatch.setattr(xtap_core, '_ALLOWED_ROOTS', (os.path.realpath(str(tmp_path)),))
        custom = str(tmp_path / 'custom')
        os.makedirs(custom)
        seen = set()
        custom_dirs = set()
        # First call adds to custom_dirs
        result = xtap_core.resolve_output_dir(custom, '/default', seen, custom_dirs)
        assert result in custom_dirs
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

    def test_custom_dir_loads_seen_ids(self, tmp_path, monkeypatch):
        monkeypatch.setattr(xtap_core, '_ALLOWED_ROOTS', (os.path.realpath(str(tmp_path)),))
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
# validate_output_dir
# ---------------------------------------------------------------------------


class TestValidateOutputDir:

    def test_path_under_home_allowed(self):
        home = os.path.expanduser('~')
        result = xtap_core.validate_output_dir(os.path.join(home, 'some', 'subdir'))
        assert result.startswith(os.path.realpath(home))

    def test_home_itself_allowed(self):
        home = os.path.expanduser('~')
        result = xtap_core.validate_output_dir(home)
        assert result == os.path.realpath(home)

    def test_traversal_outside_home_rejected(self):
        with pytest.raises(ValueError, match='outside allowed directories'):
            xtap_core.validate_output_dir('/etc/cron.d/evil')

    def test_dot_dot_traversal_rejected(self):
        home = os.path.expanduser('~')
        with pytest.raises(ValueError, match='outside allowed directories'):
            # Enough '..' to escape home
            xtap_core.validate_output_dir(os.path.join(home, '..', '..', 'tmp', 'pwned'))

    def test_absolute_path_outside_home_rejected(self):
        with pytest.raises(ValueError, match='outside allowed directories'):
            xtap_core.validate_output_dir('/tmp/pwned')

    def test_resolve_output_dir_rejects_traversal(self):
        with pytest.raises(ValueError, match='outside allowed directories'):
            xtap_core.resolve_output_dir('/etc/evil', '/default', set(), set())

    def test_default_output_dir_allowed(self):
        result = xtap_core.validate_output_dir(xtap_core.DEFAULT_OUTPUT_DIR)
        assert result == os.path.realpath(xtap_core.DEFAULT_OUTPUT_DIR)


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

    def test_traversal_filename_stripped(self, tmp_path):
        path = xtap_core.write_dump('../../.ssh/authorized_keys', 'data', str(tmp_path))
        # Traversal stripped — writes to out_dir/authorized_keys
        assert path == os.path.join(str(tmp_path), 'authorized_keys')
        assert (tmp_path / 'authorized_keys').read_text() == 'data'

    def test_absolute_filename_stripped(self, tmp_path):
        path = xtap_core.write_dump('/etc/cron.d/evil', 'data', str(tmp_path))
        # Should write to out_dir/evil, not /etc/cron.d/evil
        assert path == os.path.join(str(tmp_path), 'evil')
        assert (tmp_path / 'evil').read_text() == 'data'

    def test_empty_filename_rejected(self, tmp_path):
        with pytest.raises(ValueError, match='Invalid dump filename'):
            xtap_core.write_dump('', 'data', str(tmp_path))

    def test_dot_filename_rejected(self, tmp_path):
        with pytest.raises(ValueError, match='Invalid dump filename'):
            xtap_core.write_dump('.', 'data', str(tmp_path))

    def test_dotdot_filename_rejected(self, tmp_path):
        with pytest.raises(ValueError, match='Invalid dump filename'):
            xtap_core.write_dump('..', 'data', str(tmp_path))


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
        leftover = [f for f in os.listdir(str(tmp_path)) if f.startswith('.xtap-write-test')]
        assert leftover == [], f'Sentinel not cleaned up: {leftover}'

    def test_cleanup_tolerates_missing_sentinel(self, tmp_path, monkeypatch):
        """test_path should not raise if the sentinel is already removed (race)."""
        original_remove = os.remove

        def remove_twice(path):
            original_remove(path)
            # Simulate a concurrent removal — file is already gone
            original_remove(path)

        monkeypatch.setattr(os, 'remove', remove_twice)
        xtap_core.test_path(str(tmp_path))  # should not raise


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
# _YtdlpProgress
# ---------------------------------------------------------------------------


def _feed_lines(lines):
    """Helper: feed a list of lines into a fresh _YtdlpProgress tracker."""
    t = xtap_core._YtdlpProgress()
    history = []
    for line in lines:
        t.feed(line)
        history.append(t.progress)
    return t, history


class TestYtdlpProgressSingleStream:
    def test_basic_progress(self):
        t, h = _feed_lines([
            '[info] 123: Downloading 1 format(s): hls-707',
            '[download] Destination: /tmp/video.mp4',
            '[download]   0.0%',
            '[download]  50.0%',
            '[download] 100.0%',
        ])
        assert t.progress == 100.0
        assert t.final_path == '/tmp/video.mp4'

    def test_defaults_to_single_stream(self):
        """No format line at all — total_streams stays 1."""
        t, h = _feed_lines([
            '[download] Destination: /tmp/video.mp4',
            '[download]  50.0%',
            '[download] 100.0%',
        ])
        assert t.progress == 100.0


class TestYtdlpProgressMultiStream:
    def test_two_stream_scaling(self):
        """Two HLS streams: progress should go 0->50->100, not 0->100->0->100."""
        t, h = _feed_lines([
            '[info] 123: Downloading 2 format(s): hls-707+hls-audio',
            '[download] Destination: /tmp/video.mp4',
            '[download]   0.0%',
            '[download]  50.0%',
            '[download] 100.0%',
            '[download] Destination: /tmp/audio.m4a',
            '[download]   0.0%',
            '[download]  50.0%',
            '[download] 100.0%',
            '[Merger] Merging formats into "/tmp/final.mp4"',
        ])
        assert t.progress == 100.0
        assert t.final_path == '/tmp/final.mp4'
        # After stream 1 completes, progress should be 50%, not 100%
        assert h[4] == 50.0  # stream 1 at 100% raw -> 50% scaled

    def test_progress_never_decreases(self):
        """Monotonic guard: progress must never go backward."""
        t, _ = _feed_lines([
            '[info] 123: Downloading 2 format(s): hls-707+hls-audio',
            '[download] Destination: /tmp/video.mp4',
            '[download]  80.0%',
            '[download]  30.0%',  # yt-dlp quirk: lower than previous
        ])
        assert t.progress == 40.0  # 80% of first stream = 40% overall

    def test_three_streams(self):
        t, _ = _feed_lines([
            '[info] 123: Downloading 3 format(s): hls-707+hls-audio+hls-subs',
            '[download] Destination: /tmp/a.mp4',
            '[download] 100.0%',
            '[download] Destination: /tmp/b.m4a',
            '[download] 100.0%',
            '[download] Destination: /tmp/c.vtt',
            '[download] 100.0%',
        ])
        # Each stream is 1/3: after stream 1=33.3, stream 2=66.7, stream 3=100
        assert t.progress == 100.0


class TestYtdlpProgressCachedStreams:
    def test_cached_stream_counts_as_complete(self):
        t, h = _feed_lines([
            '[info] 123: Downloading 2 format(s): hls-707+hls-audio',
            '[download] /tmp/video.mp4 has already been downloaded',
            '[download] Destination: /tmp/audio.m4a',
            '[download]  50.0%',
            '[download] 100.0%',
        ])
        assert h[1] == 50.0  # cached stream = 50% (1 of 2 done)
        assert t.progress == 100.0
        assert t.final_path == '/tmp/audio.m4a'

    def test_both_streams_cached(self):
        t, _ = _feed_lines([
            '[info] 123: Downloading 2 format(s): hls-707+hls-audio',
            '[download] /tmp/video.mp4 has already been downloaded',
            '[download] /tmp/audio.m4a has already been downloaded',
        ])
        assert t.progress == 100.0


class TestYtdlpProgressRecalibration:
    def test_unexpected_extra_stream(self):
        """Format line says 1 stream, but 2 Destination lines appear."""
        t, h = _feed_lines([
            '[download] Destination: /tmp/video.mp4',
            '[download] 100.0%',
            '[download] Destination: /tmp/audio.m4a',  # surprise!
            '[download]   0.0%',
            '[download]  50.0%',
            '[download] 100.0%',
        ])
        # After recalibration to 2 streams, should reach 100%
        assert t.progress == 100.0
        assert t.total_streams == 2

    def test_recalibration_rewinds_progress(self):
        """When a surprise stream appears, progress rewinds to correct value."""
        t, h = _feed_lines([
            '[download] Destination: /tmp/video.mp4',
            '[download] 100.0%',  # thinks it's done: 100%
        ])
        assert t.progress == 100.0
        # Now a second stream appears
        t.feed('[download] Destination: /tmp/audio.m4a')
        assert t.progress == 50.0  # recalibrated: 1 of 2 done
        assert t.total_streams == 2

    def test_unexpected_cached_after_live(self):
        """Live stream finishes, then a cached stream appears unexpectedly."""
        t, _ = _feed_lines([
            '[download] Destination: /tmp/video.mp4',
            '[download] 100.0%',
            '[download] /tmp/audio.m4a has already been downloaded',
        ])
        assert t.progress == 100.0  # both done


class TestYtdlpProgressPoisoning:
    def test_percent_in_tweet_title_ignored(self):
        """A tweet title containing '%' must not affect progress."""
        t, h = _feed_lines([
            '[info] 123: Downloading 1 format(s): hls-707',
            '[download] Destination: /tmp/100% agree [123].mp4',
            '[download]  25.0%',
        ])
        assert t.progress == 25.0  # not 100

    def test_non_download_line_with_percent(self):
        """Lines not starting with [download] are ignored for progress."""
        t, _ = _feed_lines([
            '[info] 123: 100% of something',
            '[download] Destination: /tmp/video.mp4',
            '[download]  10.0%',
        ])
        assert t.progress == 10.0

    def test_already_downloaded_line_with_percent(self):
        """'has already been downloaded' lines don't trigger progress regex."""
        t, _ = _feed_lines([
            '[info] 123: Downloading 2 format(s): hls-707+hls-audio',
            '[download] /tmp/50% off [123].mp4 has already been downloaded',
            '[download] Destination: /tmp/audio.m4a',
            '[download]  60.0%',
        ])
        # Cached stream = 50% (1 of 2), then 60% of stream 2 = 80% overall
        assert t.progress == 80.0


class TestYtdlpProgressMerger:
    def test_merger_updates_final_path(self):
        t, _ = _feed_lines([
            '[info] 123: Downloading 2 format(s): hls-707+hls-audio',
            '[download] Destination: /tmp/video.mp4',
            '[download] 100.0%',
            '[download] Destination: /tmp/audio.m4a',
            '[download] 100.0%',
            '[Merger] Merging formats into "/tmp/final.mp4"',
        ])
        assert t.final_path == '/tmp/final.mp4'


# ---------------------------------------------------------------------------
# _photo_filename / collect_image_jobs
# ---------------------------------------------------------------------------


class TestPhotoFilename:
    def test_strips_orig_suffix(self):
        assert xtap_core._photo_filename(
            'https://pbs.twimg.com/media/HGK3a3qbAAADTqD.jpg:orig'
        ) == 'HGK3a3qbAAADTqD.jpg'

    def test_strips_large_suffix(self):
        assert xtap_core._photo_filename(
            'https://pbs.twimg.com/media/abc.png:large'
        ) == 'abc.png'

    def test_strips_all_known_size_suffixes(self):
        # All Twitter image size suffixes — leaving any unstripped would put
        # a colon in the filename, which is illegal on NTFS.
        for suffix in ('orig', 'large', 'medium', 'small', 'thumb', 'tiny'):
            assert xtap_core._photo_filename(
                f'https://pbs.twimg.com/media/abc.jpg:{suffix}'
            ) == 'abc.jpg', f'failed for :{suffix}'

    def test_no_suffix(self):
        assert xtap_core._photo_filename(
            'https://pbs.twimg.com/media/abc.jpg'
        ) == 'abc.jpg'

    def test_empty_returns_none(self):
        assert xtap_core._photo_filename('') is None
        assert xtap_core._photo_filename(None) is None

    def test_url_with_no_path(self):
        assert xtap_core._photo_filename('https://pbs.twimg.com/') is None


class TestCollectImageJobs:
    def test_returns_jobs_for_photos_without_mutating_jsonl(self, tmp_path):
        tweets = [{
            'id': '123',
            'media': [
                {'type': 'photo', 'url': 'https://pbs.twimg.com/media/abc.jpg:orig'},
            ],
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        # Top-level photo media is NOT mutated — the path is convention-derived
        # and consumers can reconstruct it from id + basename(url).
        assert 'local_path' not in tweets[0]['media'][0]
        assert pending == [{
            'tweet_id': '123',
            'url': 'https://pbs.twimg.com/media/abc.jpg:orig',
            'rel_path': 'media/123/abc.jpg',
        }]

    def test_skips_video_media(self, tmp_path):
        tweets = [{
            'id': '123',
            'media': [
                {'type': 'video', 'url': 'https://video.twimg.com/foo.mp4'},
            ],
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []
        assert 'local_path' not in tweets[0]['media'][0]

    def test_skips_tweet_without_id(self, tmp_path):
        tweets = [{'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/x.jpg'}]}]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []

    def test_handles_missing_media(self, tmp_path):
        tweets = [{'id': '123'}, {'id': '456', 'media': []}]
        assert xtap_core.collect_image_jobs(tweets, str(tmp_path)) == []

    def test_enqueues_article_media(self, tmp_path):
        tweets = [{
            'id': '999',
            'media': [],
            'is_article': True,
            'article': {
                'media': [
                    {
                        'url': 'https://pbs.twimg.com/media/HGxr957a0AAzHOk.jpg',
                        'local_path': 'media/999/HGxr957a0AAzHOk.jpg',
                    },
                    {
                        'url': 'https://pbs.twimg.com/media/HGxr2u5a8AANAOy.jpg',
                        'local_path': 'media/999/HGxr2u5a8AANAOy.jpg',
                    },
                ],
            },
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert [p['rel_path'] for p in pending] == [
            'media/999/HGxr957a0AAzHOk.jpg',
            'media/999/HGxr2u5a8AANAOy.jpg',
        ]

    def test_skips_article_media_without_local_path(self, tmp_path):
        tweets = [{
            'id': '999',
            'article': {'media': [{'url': 'https://pbs.twimg.com/media/x.jpg'}]},
        }]
        assert xtap_core.collect_image_jobs(tweets, str(tmp_path)) == []

    def test_skips_photo_without_url(self, tmp_path):
        tweets = [{'id': '123', 'media': [{'type': 'photo', 'url': None}]}]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []
        assert 'local_path' not in tweets[0]['media'][0]

    def test_rejects_non_numeric_tweet_id(self, tmp_path):
        tweets = [{
            'id': '../../etc',
            'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/x.jpg'}],
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []
        assert 'local_path' not in tweets[0]['media'][0]

    def test_rejects_article_local_path_with_traversal(self, tmp_path):
        tweets = [{
            'id': '999',
            'article': {'media': [{
                'url': 'https://pbs.twimg.com/media/x.jpg',
                'local_path': '../../../../etc/passwd',
            }]},
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []
        # Unsafe local_path is stripped so the JSONL doesn't carry it.
        assert 'local_path' not in tweets[0]['article']['media'][0]

    def test_rejects_article_local_path_absolute(self, tmp_path):
        tweets = [{
            'id': '999',
            'article': {'media': [{
                'url': 'https://pbs.twimg.com/media/x.jpg',
                'local_path': '/etc/passwd',
            }]},
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []
        assert 'local_path' not in tweets[0]['article']['media'][0]

    def test_rejects_photo_filename_with_traversal_basename(self, tmp_path):
        # Forged URL whose basename is ".."
        tweets = [{
            'id': '123',
            'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/..'}],
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []
        assert 'local_path' not in tweets[0]['media'][0]

    def test_top_level_photo_unsafe_rel_path_skipped(self, tmp_path, monkeypatch):
        # Force _is_safe_rel_path to reject so we exercise the top-level skip
        # branch (it is otherwise unreachable because tweet_id and filename
        # are validated upstream).
        monkeypatch.setattr(xtap_core, '_is_safe_rel_path', lambda _o, _r: False)
        tweets = [{
            'id': '123',
            'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/abc.jpg'}],
        }]
        pending = xtap_core.collect_image_jobs(tweets, str(tmp_path))
        assert pending == []

    def test_skips_non_dict_article_media_item(self, tmp_path):
        tweets = [{
            'id': '999',
            'article': {'media': ['not-a-dict', 42, None]},
        }]
        # Must not raise on non-dict items.
        assert xtap_core.collect_image_jobs(tweets, str(tmp_path)) == []


class TestPhotoFilenameHardening:
    def test_basename_strip_traversal(self):
        # urlparse + basename collapses path segments, but our explicit
        # regex/blocklist must still reject these for defense in depth.
        assert xtap_core._photo_filename('https://pbs.twimg.com/media/..') is None
        assert xtap_core._photo_filename('https://pbs.twimg.com/media/.') is None
        assert xtap_core._photo_filename('https://pbs.twimg.com/.hidden.jpg') is None

    def test_safe_rel_path_blocks_absolute(self, tmp_path):
        assert xtap_core._is_safe_rel_path(str(tmp_path), '/etc/passwd') is False

    def test_safe_rel_path_blocks_traversal(self, tmp_path):
        assert xtap_core._is_safe_rel_path(str(tmp_path), '../../etc/passwd') is False

    def test_safe_rel_path_allows_normal(self, tmp_path):
        assert xtap_core._is_safe_rel_path(str(tmp_path), 'media/123/abc.jpg') is True


class TestUrlAllowlist:
    def test_allows_pbs_twimg(self):
        assert xtap_core._is_allowed_url('https://pbs.twimg.com/media/x.jpg') is True

    def test_blocks_other_host(self):
        assert xtap_core._is_allowed_url('https://evil.example.com/x.jpg') is False

    def test_blocks_http_scheme(self):
        assert xtap_core._is_allowed_url('http://pbs.twimg.com/media/x.jpg') is False

    def test_blocks_file_scheme(self):
        assert xtap_core._is_allowed_url('file:///etc/passwd') is False

    def test_blocks_metadata_ip(self):
        assert xtap_core._is_allowed_url('http://169.254.169.254/latest/meta-data/') is False

    def test_blocks_none_or_empty(self):
        assert xtap_core._is_allowed_url(None) is False
        assert xtap_core._is_allowed_url('') is False


class TestEnvParsing:
    def test_env_int_falls_back_on_garbage(self, monkeypatch):
        monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', 'foo')
        assert xtap_core._env_int('XTAP_IMAGE_DELAY_MS', 100) == 100

    def test_env_int_uses_value_when_valid(self, monkeypatch):
        monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', '250')
        assert xtap_core._env_int('XTAP_IMAGE_DELAY_MS', 100) == 250

    def test_env_int_falls_back_on_empty(self, monkeypatch):
        monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', '')
        assert xtap_core._env_int('XTAP_IMAGE_DELAY_MS', 100) == 100

    def test_env_float_falls_back_on_garbage(self, monkeypatch):
        monkeypatch.setenv('XTAP_MAX_FILE_MB', 'big')
        assert xtap_core._env_float('XTAP_MAX_FILE_MB', 50.0) == 50.0


# ---------------------------------------------------------------------------
# ImageDownloader
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, body, content_length=None):
        import io
        self._buf = io.BytesIO(body)
        self.headers = {}
        if content_length is not None:
            self.headers['Content-Length'] = str(content_length)

    def read(self, n=-1):
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _wait_for_queue(downloader, timeout=5):
    """Block until the downloader's worker has drained its queue."""
    deadline = __import__('time').monotonic() + timeout
    while downloader.queue.unfinished_tasks > 0:
        if __import__('time').monotonic() > deadline:
            raise AssertionError('downloader queue did not drain')
        __import__('time').sleep(0.02)


def _patch_opener(monkeypatch, fake_open):
    """Replace the download opener with a fake. fake_open(req, timeout=) -> response."""
    class _FakeOpener:
        def open(self, req, timeout=None):
            return fake_open(req, timeout=timeout)
    monkeypatch.setattr(xtap_core, '_NO_REDIRECT_OPENER', _FakeOpener())


@pytest.fixture
def downloader(monkeypatch):
    """A fresh ImageDownloader with no rate-limit delay and no singleton state."""
    monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', '0')
    monkeypatch.delenv('XTAP_MAX_MEDIA_MB', raising=False)
    monkeypatch.delenv('XTAP_MAX_FILE_MB', raising=False)
    xtap_core.reset_image_downloader()
    return xtap_core.ImageDownloader()


class TestImageDownloader:
    def test_successful_download(self, downloader, tmp_path, monkeypatch):
        body = b'\x89PNG\r\n' + b'x' * 100
        opens = []

        def fake_open(req, timeout=None):
            opens.append(req.full_url)
            return _FakeResponse(body)

        _patch_opener(monkeypatch, fake_open)
        downloader.enqueue([{
            'tweet_id': '1',
            'url': 'https://pbs.twimg.com/media/abc.jpg:orig',
            'rel_path': 'media/1/abc.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        dest = tmp_path / 'media' / '1' / 'abc.jpg'
        assert dest.read_bytes() == body
        assert opens == ['https://pbs.twimg.com/media/abc.jpg:orig']
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'ok'
        assert entries[0]['bytes'] == len(body)
        assert entries[0]['tweet_id'] == '1'

    def test_idempotent_skip_existing(self, downloader, tmp_path, monkeypatch):
        dest_dir = tmp_path / 'media' / '1'
        dest_dir.mkdir(parents=True)
        (dest_dir / 'abc.jpg').write_bytes(b'cached-bytes')

        called = []
        def fake_open(req, timeout=None):
            called.append(req.full_url)
            return _FakeResponse(b'should-not-run')

        _patch_opener(monkeypatch, fake_open)
        downloader.enqueue([{
            'tweet_id': '1',
            'url': 'https://pbs.twimg.com/media/abc.jpg:orig',
            'rel_path': 'media/1/abc.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert called == []
        assert (dest_dir / 'abc.jpg').read_bytes() == b'cached-bytes'
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'exists'

    def test_404_logs_error(self, downloader, tmp_path, monkeypatch):
        import urllib.error
        def fake_open(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 404, 'Not Found', {}, None)
        _patch_opener(monkeypatch, fake_open)
        downloader.enqueue([{
            'tweet_id': '2',
            'url': 'https://pbs.twimg.com/media/missing.jpg:orig',
            'rel_path': 'media/2/missing.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert not (tmp_path / 'media' / '2' / 'missing.jpg').exists()
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:http_404'

    def test_429_retries_then_succeeds(self, downloader, tmp_path, monkeypatch):
        """After two 429s the third attempt succeeds, file lands on disk."""
        import urllib.error
        attempts = {'n': 0}
        body = b'\x89PNGsuccess'

        def fake_open(req, timeout=None):
            attempts['n'] += 1
            if attempts['n'] < 3:
                raise urllib.error.HTTPError(req.full_url, 429, 'Too Many', {}, None)
            return _FakeResponse(body)

        # Don't actually sleep through the backoff in tests.
        monkeypatch.setattr(xtap_core.time, 'sleep', lambda s: None)
        _patch_opener(monkeypatch, fake_open)
        downloader.enqueue([{
            'tweet_id': '10',
            'url': 'https://pbs.twimg.com/media/rate.jpg',
            'rel_path': 'media/10/rate.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert attempts['n'] == 3
        assert (tmp_path / 'media' / '10' / 'rate.jpg').read_bytes() == body
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'ok'

    def test_429_gives_up_after_max_attempts(self, downloader, tmp_path, monkeypatch):
        """Persistent 429 returns error:http_429 after attempt 4."""
        import urllib.error
        attempts = {'n': 0}

        def fake_open(req, timeout=None):
            attempts['n'] += 1
            raise urllib.error.HTTPError(req.full_url, 429, 'Too Many', {}, None)

        monkeypatch.setattr(xtap_core.time, 'sleep', lambda s: None)
        _patch_opener(monkeypatch, fake_open)
        downloader.enqueue([{
            'tweet_id': '11',
            'url': 'https://pbs.twimg.com/media/rate.jpg',
            'rel_path': 'media/11/rate.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        # 3 retries (attempts < 4 in source) means 4 total tries.
        assert attempts['n'] == 4
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:http_429'

    def test_quota_skips(self, downloader, tmp_path, monkeypatch):
        # Pre-set bytes_downloaded above the cap so the next job hits 'skipped:quota'.
        downloader.max_bytes = 100
        downloader.bytes_downloaded = 200
        called = []
        _patch_opener(monkeypatch, lambda *a, **kw: called.append(1) or _FakeResponse(b''))
        downloader.enqueue([{
            'tweet_id': '3',
            'url': 'https://pbs.twimg.com/media/q.jpg',
            'rel_path': 'media/3/q.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert called == []
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'skipped:quota'

    def test_atomic_partial_cleanup_on_error(self, downloader, tmp_path, monkeypatch):
        import urllib.error
        def fake_open(req, timeout=None):
            raise urllib.error.URLError('connection refused')
        _patch_opener(monkeypatch, fake_open)
        downloader.enqueue([{
            'tweet_id': '4',
            'url': 'https://pbs.twimg.com/media/x.jpg',
            'rel_path': 'media/4/x.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        media_dir = tmp_path / 'media' / '4'
        if media_dir.exists():
            assert list(media_dir.iterdir()) == []

    def test_blocks_non_allowlisted_host(self, downloader, tmp_path, monkeypatch):
        called = []
        _patch_opener(monkeypatch, lambda *a, **kw: called.append(1) or _FakeResponse(b''))
        downloader.enqueue([{
            'tweet_id': '5',
            'url': 'https://evil.example.com/x.jpg',
            'rel_path': 'media/5/x.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert called == []
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:host_not_allowed'

    def test_blocks_metadata_ip(self, downloader, tmp_path, monkeypatch):
        called = []
        _patch_opener(monkeypatch, lambda *a, **kw: called.append(1) or _FakeResponse(b''))
        downloader.enqueue([{
            'tweet_id': '6',
            'url': 'http://169.254.169.254/latest/meta-data/',
            'rel_path': 'media/6/meta',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert called == []
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:host_not_allowed'

    def test_rejects_unsafe_rel_path_at_worker(self, downloader, tmp_path, monkeypatch):
        called = []
        _patch_opener(monkeypatch, lambda *a, **kw: called.append(1) or _FakeResponse(b''))
        # Even if a future caller skips collect_image_jobs, the worker
        # rejects an unsafe rel_path before any FS or network work.
        downloader.enqueue([{
            'tweet_id': '7',
            'url': 'https://pbs.twimg.com/media/x.jpg',
            'rel_path': '../../etc/passwd',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        assert called == []
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:unsafe_path'
        # Nothing was created outside out_dir.
        assert not (tmp_path / '..' / 'etc').exists()

    def test_aborts_oversize_response(self, tmp_path, monkeypatch):
        monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', '0')
        monkeypatch.setenv('XTAP_MAX_FILE_MB', '0.0001')  # ~104 bytes
        xtap_core.reset_image_downloader()
        dl = xtap_core.ImageDownloader()
        big = b'x' * 5000
        _patch_opener(monkeypatch, lambda *a, **kw: _FakeResponse(big))
        dl.enqueue([{
            'tweet_id': '8',
            'url': 'https://pbs.twimg.com/media/big.jpg',
            'rel_path': 'media/8/big.jpg',
        }], str(tmp_path))
        _wait_for_queue(dl)
        assert not (tmp_path / 'media' / '8' / 'big.jpg').exists()
        assert not (tmp_path / 'media' / '8' / 'big.jpg.part').exists()
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:too_large'

    def test_rejects_oversize_via_content_length(self, tmp_path, monkeypatch):
        monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', '0')
        monkeypatch.setenv('XTAP_MAX_FILE_MB', '0.0001')
        xtap_core.reset_image_downloader()
        dl = xtap_core.ImageDownloader()
        # Server claims a huge body up-front — we reject without reading it.
        _patch_opener(monkeypatch, lambda *a, **kw: _FakeResponse(b'', content_length=10_000_000))
        dl.enqueue([{
            'tweet_id': '9',
            'url': 'https://pbs.twimg.com/media/huge.jpg',
            'rel_path': 'media/9/huge.jpg',
        }], str(tmp_path))
        _wait_for_queue(dl)
        entries = [json.loads(l) for l in (tmp_path / 'media-manifest.jsonl').read_text().splitlines()]
        assert entries[0]['status'] == 'error:too_large'

    def test_redirect_handler_raises_for_redirect(self, monkeypatch):
        """The custom HTTPRedirectHandler must turn redirects into errors."""
        import urllib.error
        h = xtap_core._NoRedirectHandler()
        # Build a fake request and assert HTTPError is raised on redirect attempt.
        req = urllib.request.Request('https://pbs.twimg.com/media/x.jpg')
        with pytest.raises(urllib.error.HTTPError):
            h.redirect_request(req, None, 302, 'Found', {}, 'https://evil.example.com/x.jpg')


class TestImageDownloaderRateLimit:
    def test_sleeps_to_enforce_inter_request_delay(self, tmp_path, monkeypatch):
        monkeypatch.setenv('XTAP_IMAGE_DELAY_MS', '50')
        xtap_core.reset_image_downloader()
        dl = xtap_core.ImageDownloader()
        sleeps = []
        # Pretend we just made a request right now so the next job has to wait.
        dl._last_request_at = 1000.0
        monkeypatch.setattr(xtap_core.time, 'monotonic', lambda: 1000.0)
        monkeypatch.setattr(xtap_core.time, 'sleep', lambda s: sleeps.append(s))
        _patch_opener(monkeypatch, lambda *a, **kw: _FakeResponse(b'x'))
        dl.enqueue([{
            'tweet_id': '20',
            'url': 'https://pbs.twimg.com/media/r.jpg',
            'rel_path': 'media/20/r.jpg',
        }], str(tmp_path))
        _wait_for_queue(dl)
        # The worker should have called time.sleep with ~delay_s seconds.
        assert any(s > 0 for s in sleeps), f'expected positive sleep, got {sleeps}'


class TestImageDownloaderManifest:
    def test_manifest_write_oserror_swallowed(self, downloader, tmp_path, monkeypatch, capsys):
        # Simulate a failing manifest write: open() raises PermissionError.
        real_open = open

        def fake_open(path, *args, **kwargs):
            if str(path).endswith('media-manifest.jsonl'):
                raise PermissionError('read-only filesystem')
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr('builtins.open', fake_open)
        _patch_opener(monkeypatch, lambda *a, **kw: _FakeResponse(b'data'))
        downloader.enqueue([{
            'tweet_id': '21',
            'url': 'https://pbs.twimg.com/media/m.jpg',
            'rel_path': 'media/21/m.jpg',
        }], str(tmp_path))
        _wait_for_queue(downloader)
        # Must not crash the worker. Stderr captures the warning line.
        captured = capsys.readouterr()
        assert 'manifest write failed' in captured.err


class TestImageDownloaderSingleton:
    def test_get_returns_same_instance(self, monkeypatch):
        xtap_core.reset_image_downloader()
        a = xtap_core.get_image_downloader()
        b = xtap_core.get_image_downloader()
        assert a is b
        xtap_core.reset_image_downloader()
