/**
 * Tests for issue #10: undefined dedup poisoning + XHR listener stacking
 * Run with: node --test tests/dedup-xhr.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Bug 1: seenIds dedup with missing tweet IDs
//
// We replicate the enqueueTweets dedup logic here since background.js is a
// service worker module with chrome.* dependencies that can't be imported
// directly.
// ---------------------------------------------------------------------------

/**
 * Minimal replica of the enqueueTweets dedup logic (post-fix).
 * Returns { buffer, seenIds } after processing.
 */
function enqueueTweets(tweets, seenIds = new Set()) {
  const buffer = [];
  for (const tweet of tweets) {
    if (tweet.id && seenIds.has(tweet.id) && !tweet.is_article) {
      continue;
    }
    if (tweet.id) seenIds.add(tweet.id);
    buffer.push(tweet);
  }
  return { buffer, seenIds };
}

describe('enqueueTweets dedup (Bug 1: undefined poisoning)', () => {
  it('enqueues a tweet with a missing id', () => {
    const { buffer, seenIds } = enqueueTweets([{ text: 'no id' }]);
    assert.equal(buffer.length, 1);
    assert.equal(buffer[0].text, 'no id');
    assert.ok(!seenIds.has(undefined), 'seenIds must not contain undefined');
  });

  it('enqueues multiple tweets with missing ids (not treated as dupes)', () => {
    const { buffer, seenIds } = enqueueTweets([
      { text: 'first no-id' },
      { text: 'second no-id' },
      { text: 'third no-id' },
    ]);
    assert.equal(buffer.length, 3);
    assert.ok(!seenIds.has(undefined));
  });

  it('still deduplicates tweets that have an id', () => {
    const { buffer } = enqueueTweets([
      { id: '1', text: 'first' },
      { id: '1', text: 'dupe' },
      { id: '2', text: 'second' },
    ]);
    assert.equal(buffer.length, 2);
    assert.equal(buffer[0].id, '1');
    assert.equal(buffer[1].id, '2');
  });

  it('does not deduplicate article tweets even with same id', () => {
    const { buffer } = enqueueTweets([
      { id: '1', text: 'stub' },
      { id: '1', text: 'full article', is_article: true },
    ]);
    assert.equal(buffer.length, 2);
  });

  it('respects pre-existing seenIds', () => {
    const seenIds = new Set(['1', '2']);
    const { buffer } = enqueueTweets([
      { id: '1', text: 'already seen' },
      { id: '3', text: 'new' },
    ], seenIds);
    assert.equal(buffer.length, 1);
    assert.equal(buffer[0].id, '3');
  });

  it('handles a mix of id and no-id tweets', () => {
    const { buffer, seenIds } = enqueueTweets([
      { id: '1', text: 'has id' },
      { text: 'no id' },
      { id: '1', text: 'dupe' },
      { text: 'another no id' },
      { id: '2', text: 'new id' },
    ]);
    assert.equal(buffer.length, 4);
    assert.ok(!seenIds.has(undefined));
    assert.ok(seenIds.has('1'));
    assert.ok(seenIds.has('2'));
  });
});

// ---------------------------------------------------------------------------
// Bug 2: XHR listener stacking on reused instances
//
// We replicate the patching logic with a minimal XHR-like object to verify
// that reused instances only get one listener.
// ---------------------------------------------------------------------------

describe('XHR listener stacking (Bug 2)', () => {
  // Minimal XHR stub
  class FakeXHR {
    constructor() {
      this._listeners = {};
    }
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    }
    _fireLoad() {
      for (const fn of (this._listeners.load || [])) fn.call(this);
    }
  }

  /**
   * Replica of the patched open() logic (post-fix).
   */
  function makePatchedOpen() {
    const xhrUrls = new WeakMap();
    const xhrPatched = new WeakSet();
    const dispatched = [];

    function patchedOpen(xhr, method, url) {
      const GRAPHQL_PATTERN = '/i/api/graphql/';
      const urlStr = (typeof url === 'string') ? url : url?.toString();
      if (urlStr && urlStr.includes(GRAPHQL_PATTERN)) {
        xhrUrls.set(xhr, urlStr);
        if (!xhrPatched.has(xhr)) {
          xhrPatched.add(xhr);
          xhr.addEventListener('load', function () {
            dispatched.push(xhrUrls.get(this));
          });
        }
      }
    }
    return { patchedOpen, dispatched };
  }

  it('single-use XHR emits exactly one event', () => {
    const { patchedOpen, dispatched } = makePatchedOpen();
    const xhr = new FakeXHR();
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail');
    xhr._fireLoad();
    assert.equal(dispatched.length, 1);
  });

  it('reused XHR (multiple open calls) emits exactly one event per load', () => {
    const { patchedOpen, dispatched } = makePatchedOpen();
    const xhr = new FakeXHR();
    // Simulate reuse: call open() 3 times on the same instance
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail');
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/graphql/def/UserTweets');
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/graphql/ghi/HomeTimeline');
    xhr._fireLoad();
    assert.equal(dispatched.length, 1, 'should only dispatch once despite 3 open() calls');
  });

  it('reused XHR uses the latest URL', () => {
    const { patchedOpen, dispatched } = makePatchedOpen();
    const xhr = new FakeXHR();
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail');
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/graphql/def/UserTweets');
    xhr._fireLoad();
    assert.equal(dispatched.length, 1);
    assert.ok(dispatched[0].includes('/def/UserTweets'), 'should use the URL from the latest open() call');
  });

  it('different XHR instances each get their own listener', () => {
    const { patchedOpen, dispatched } = makePatchedOpen();
    const xhr1 = new FakeXHR();
    const xhr2 = new FakeXHR();
    patchedOpen(xhr1, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail');
    patchedOpen(xhr2, 'GET', 'https://x.com/i/api/graphql/def/UserTweets');
    xhr1._fireLoad();
    xhr2._fireLoad();
    assert.equal(dispatched.length, 2);
  });

  it('non-GraphQL URLs are ignored', () => {
    const { patchedOpen, dispatched } = makePatchedOpen();
    const xhr = new FakeXHR();
    patchedOpen(xhr, 'GET', 'https://x.com/i/api/2/timeline');
    xhr._fireLoad();
    assert.equal(dispatched.length, 0);
  });
});
