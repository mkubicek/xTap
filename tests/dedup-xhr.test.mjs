/**
 * Tests for issue #10: undefined dedup poisoning + XHR listener stacking.
 * Run with: node --test tests/dedup-xhr.test.mjs
 *
 * Bug 1 tests import the production dedupTweet() from lib/dedup.js.
 * Bug 2 tests evaluate the production content-main.js IIFE via vm.runInNewContext
 * with mocked browser globals so the real patching code is exercised.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dedupTweet } from '../lib/dedup.js';

// ---------------------------------------------------------------------------
// Bug 1: seenIds dedup with missing tweet IDs — tests production dedupTweet()
// ---------------------------------------------------------------------------

describe('dedupTweet (Bug 1: undefined poisoning)', () => {
  it('returns true for a tweet with missing id (enqueue it)', () => {
    const seenIds = new Set();
    assert.equal(dedupTweet({ text: 'no id' }, seenIds), true);
    assert.ok(!seenIds.has(undefined), 'seenIds must not contain undefined');
  });

  it('enqueues multiple no-id tweets (none treated as dupes)', () => {
    const seenIds = new Set();
    assert.equal(dedupTweet({ text: 'first' }, seenIds), true);
    assert.equal(dedupTweet({ text: 'second' }, seenIds), true);
    assert.equal(dedupTweet({ text: 'third' }, seenIds), true);
    assert.ok(!seenIds.has(undefined));
  });

  it('deduplicates tweets that have an id', () => {
    const seenIds = new Set();
    assert.equal(dedupTweet({ id: '1', text: 'first' }, seenIds), true);
    assert.equal(dedupTweet({ id: '1', text: 'dupe' }, seenIds), false);
    assert.equal(dedupTweet({ id: '2', text: 'second' }, seenIds), true);
  });

  it('does not deduplicate article tweets even with same id', () => {
    const seenIds = new Set();
    assert.equal(dedupTweet({ id: '1', text: 'stub' }, seenIds), true);
    assert.equal(dedupTweet({ id: '1', text: 'full article', is_article: true }, seenIds), true);
  });

  it('respects pre-existing seenIds', () => {
    const seenIds = new Set(['1', '2']);
    assert.equal(dedupTweet({ id: '1', text: 'seen' }, seenIds), false);
    assert.equal(dedupTweet({ id: '3', text: 'new' }, seenIds), true);
  });

  it('handles a mix of id and no-id tweets', () => {
    const seenIds = new Set();
    assert.equal(dedupTweet({ id: '1', text: 'has id' }, seenIds), true);
    assert.equal(dedupTweet({ text: 'no id' }, seenIds), true);
    assert.equal(dedupTweet({ id: '1', text: 'dupe' }, seenIds), false);
    assert.equal(dedupTweet({ text: 'another no id' }, seenIds), true);
    assert.equal(dedupTweet({ id: '2', text: 'new id' }, seenIds), true);
    assert.ok(!seenIds.has(undefined));
    assert.ok(seenIds.has('1'));
    assert.ok(seenIds.has('2'));
  });
});

// ---------------------------------------------------------------------------
// Image backfill bypass: re-emit duplicates with photos so newly-enabled
// auto-image-download can fetch media for already-scraped tweets. Once per
// session per tweet ID, gated by imageCheckedIds.
// ---------------------------------------------------------------------------

const photoTweet = (id) => ({
  id,
  text: 'pic',
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg:orig' }],
});

describe('dedupTweet (image-backfill bypass)', () => {
  it('lets a duplicate photo tweet through once when imageBackfill is on', () => {
    const seenIds = new Set(['1']);
    const imageCheckedIds = new Set();
    const opts = { imageBackfill: true, imageCheckedIds };
    assert.equal(dedupTweet(photoTweet('1'), seenIds, opts), true,
      'first duplicate with photos should pass through for backfill');
    assert.ok(imageCheckedIds.has('1'),
      'tweet must be marked as image-checked so we do not re-forward');
  });

  it('blocks the same duplicate photo tweet on the second pass', () => {
    const seenIds = new Set(['1']);
    const imageCheckedIds = new Set();
    const opts = { imageBackfill: true, imageCheckedIds };
    assert.equal(dedupTweet(photoTweet('1'), seenIds, opts), true);
    assert.equal(dedupTweet(photoTweet('1'), seenIds, opts), false,
      'second pass should be deduplicated again');
  });

  it('does not bypass dedup for duplicates without photo media', () => {
    const seenIds = new Set(['1']);
    const imageCheckedIds = new Set();
    const opts = { imageBackfill: true, imageCheckedIds };
    assert.equal(dedupTweet({ id: '1', text: 'no media' }, seenIds, opts), false);
    assert.equal(
      dedupTweet({ id: '1', text: 'video', media: [{ type: 'video' }] }, seenIds, opts),
      false,
      'video-only tweets are not handled by the image pipeline'
    );
    assert.ok(!imageCheckedIds.has('1'));
  });

  it('does not bypass when imageBackfill is off (default)', () => {
    const seenIds = new Set(['1']);
    assert.equal(dedupTweet(photoTweet('1'), seenIds), false);
    assert.equal(
      dedupTweet(photoTweet('1'), seenIds, { imageBackfill: false, imageCheckedIds: new Set() }),
      false
    );
  });

  it('marks first-seen photo tweets in imageCheckedIds', () => {
    const seenIds = new Set();
    const imageCheckedIds = new Set();
    const opts = { imageBackfill: true, imageCheckedIds };
    assert.equal(dedupTweet(photoTweet('42'), seenIds, opts), true);
    assert.ok(seenIds.has('42'));
    assert.ok(imageCheckedIds.has('42'),
      'first-seen photo tweets must also be tracked so the next view does not re-forward');
  });

  it('does not require imageCheckedIds when imageBackfill is off', () => {
    const seenIds = new Set();
    assert.equal(dedupTweet({ id: '1', text: 'first' }, seenIds), true);
    assert.equal(dedupTweet({ id: '1', text: 'dupe' }, seenIds), false);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: XHR listener stacking — evaluates production content-main.js via vm
// ---------------------------------------------------------------------------

const contentMainCode = readFileSync(
  new URL('../content-main.js', import.meta.url), 'utf8'
);

/**
 * Build a minimal browser-like environment for the content-main.js IIFE.
 * Returns the mock globals and a `dispatched` array that collects every
 * CustomEvent dispatched to document.
 */
function createBrowserEnv() {
  const dispatched = [];

  function CustomEvent(name, opts) {
    this.type = name;
    this.detail = opts?.detail;
  }

  const document = {
    createElement: () => ({ name: '', content: '' }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    dispatchEvent(event) {
      if (event.detail) dispatched.push(JSON.parse(event.detail));
    },
  };

  function XMLHttpRequest() {
    this._listeners = {};
    this.responseText = '';
  }
  XMLHttpRequest.prototype.addEventListener = function (event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  };
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};

  const window = { fetch: async () => ({}) };
  const location = { origin: 'https://x.com' };

  return { document, CustomEvent, XMLHttpRequest, window, location, dispatched };
}

/** Fire the 'load' event on a mock XHR instance. */
function fireLoad(xhr, responseText) {
  xhr.responseText = responseText;
  for (const fn of (xhr._listeners?.load || [])) fn.call(xhr);
}

describe('XHR listener stacking — production content-main.js (Bug 2)', () => {
  it('single-use XHR emits exactly one event', () => {
    const env = createBrowserEnv();
    runInNewContext(contentMainCode, { ...env, console });

    const xhr = new env.XMLHttpRequest();
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail'
    );
    fireLoad(xhr, JSON.stringify({ data: {} }));
    assert.equal(env.dispatched.length, 1);
  });

  it('reused XHR (multiple open calls) emits exactly one event per load', () => {
    const env = createBrowserEnv();
    runInNewContext(contentMainCode, { ...env, console });

    const xhr = new env.XMLHttpRequest();
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail'
    );
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/graphql/def/UserTweets'
    );
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/graphql/ghi/HomeTimeline'
    );
    fireLoad(xhr, JSON.stringify({ data: {} }));
    assert.equal(env.dispatched.length, 1,
      'should dispatch exactly once despite 3 open() calls');
  });

  it('reused XHR uses the latest URL', () => {
    const env = createBrowserEnv();
    runInNewContext(contentMainCode, { ...env, console });

    const xhr = new env.XMLHttpRequest();
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail'
    );
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/graphql/def/UserTweets'
    );
    fireLoad(xhr, JSON.stringify({ data: {} }));
    assert.equal(env.dispatched.length, 1);
    assert.ok(env.dispatched[0].url.includes('/def/UserTweets'),
      'should use the URL from the latest open() call');
  });

  it('different XHR instances each get their own listener', () => {
    const env = createBrowserEnv();
    runInNewContext(contentMainCode, { ...env, console });

    const xhr1 = new env.XMLHttpRequest();
    const xhr2 = new env.XMLHttpRequest();
    env.XMLHttpRequest.prototype.open.call(
      xhr1, 'GET', 'https://x.com/i/api/graphql/abc/TweetDetail'
    );
    env.XMLHttpRequest.prototype.open.call(
      xhr2, 'GET', 'https://x.com/i/api/graphql/def/UserTweets'
    );
    fireLoad(xhr1, JSON.stringify({ data: {} }));
    fireLoad(xhr2, JSON.stringify({ data: {} }));
    assert.equal(env.dispatched.length, 2);
  });

  it('non-GraphQL URLs are ignored', () => {
    const env = createBrowserEnv();
    runInNewContext(contentMainCode, { ...env, console });

    const xhr = new env.XMLHttpRequest();
    env.XMLHttpRequest.prototype.open.call(
      xhr, 'GET', 'https://x.com/i/api/2/timeline'
    );
    fireLoad(xhr, JSON.stringify({ data: {} }));
    assert.equal(env.dispatched.length, 0);
  });
});
