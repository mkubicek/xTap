/**
 * Tests for transport failure handling and flush in-flight durability.
 * Run with: node --test tests/transport-flush.test.mjs
 *
 * Evaluates background.js in a vm context with mocked chrome APIs
 * (same rig as staging-wal.test.mjs).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dedupTweet } from '../lib/dedup.js';

const bgSource = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

// Strip ESM imports and init block; expose internals via var (added to sandbox)
const testSource = bgSource
  .replace(/^import\b.*$/gm, '')
  .replace(/\/\/ --- Init ---[\s\S]*$/,
    `var _internals = {
      flush, sendToHost, saveState, enqueueTweets,
      readyResolve,
      get buffer() { return buffer; },
      set buffer(v) { buffer = v; },
      get seenIds() { return seenIds; },
      set seenIds(v) { seenIds = v; },
      get imageCheckedIds() { return imageCheckedIds; },
      set imageCheckedIds(v) { imageCheckedIds = v; },
      get imageDownload() { return imageDownload; },
      set imageDownload(v) { imageDownload = v; },
      get sessionCount() { return sessionCount; },
      set sessionCount(v) { sessionCount = v; },
      get allTimeCount() { return allTimeCount; },
      set allTimeCount(v) { allTimeCount = v; },
      get transport() { return transport; },
      set transport(v) { transport = v; },
      set httpToken(v) { httpToken = v; },
      set httpPort(v) { httpPort = v; },
      get traceEvents() { return traceEvents; },
    };`
  );

function createMockStorage() {
  let data = {};
  return {
    get(keys) {
      if (keys === null) return Promise.resolve({ ...data });
      const result = {};
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (k in data) result[k] = data[k];
      return Promise.resolve(result);
    },
    set(items) {
      Object.assign(data, items);
      return Promise.resolve();
    },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
      return Promise.resolve();
    },
    setAccessLevel() { return Promise.resolve(); },
  };
}

function okResponse(body = { ok: true }, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function tick() {
  return new Promise(r => setTimeout(r, 0));
}

function setup() {
  const sessionStore = createMockStorage();
  const localStore = createMockStorage();
  let messageListener = null;
  const fetchHolder = {
    impl: async () => okResponse(),
  };
  const alarms = {
    created: [],
    cleared: [],
    listener: null,
    create(name, info) { this.created.push({ name, info }); },
    clear(name) { this.cleared.push(name); },
    onAlarm: null, // set below so addListener can reach `alarms`
  };
  alarms.onAlarm = { addListener: (fn) => { alarms.listener = fn; } };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    fetch: (...args) => fetchHolder.impl(...args),
    extractTweets: () => [],
    dedupTweet,
    chrome: {
      runtime: {
        getManifest: () => ({}), // no update_url → isDevMode = true
        connectNative() { throw new Error('not available'); },
        onMessage: { addListener(fn) { messageListener = fn; } },
        lastError: null,
      },
      storage: {
        session: sessionStore,
        local: localStore,
      },
      action: {
        setBadgeText() {},
        setBadgeBackgroundColor() {},
      },
      alarms,
    },
  };

  vm.runInNewContext(testSource, sandbox);

  const env = sandbox._internals;
  env.sessionStore = sessionStore;
  env.localStore = localStore;
  env.fetchHolder = fetchHolder;
  env.alarms = alarms;
  env.sendMessage = (msg) => new Promise((resolve) => {
    const returned = messageListener(msg, {}, resolve);
    if (returned !== true) resolve(undefined);
  });
  return env;
}

const photoTweet = (id) => ({
  id,
  text: 'pic',
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg:orig' }],
});

// ---------------------------------------------------------------------------
// Daemon rejection handling
// ---------------------------------------------------------------------------

describe('daemon rejection handling', () => {
  it('a 401 response resets transport so credentials are re-probed', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 'stale-token';
    env.httpPort = 17381;
    // Daemon answers with valid JSON but HTTP 401 (token rotated by reinstall)
    env.fetchHolder.impl = async () => okResponse({ ok: false, error: 'Unauthorized' }, 401);
    env.buffer = [{ id: '1', text: 'one' }];

    await env.flush();

    assert.equal(env.buffer.length, 1, 'batch must be preserved for retry');
    assert.equal(env.transport, 'none',
      'transport must reset on auth failure — otherwise flush retries the same '
      + 'stale token forever and never refreshes via the native host');
  });

  it('a 500 response keeps the batch and keeps the transport', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    env.fetchHolder.impl = async () => okResponse({ ok: false, error: 'disk full' }, 500);
    env.buffer = [{ id: '1', text: 'one' }];

    await env.flush();

    assert.equal(env.buffer.length, 1);
    // Daemon is alive (it answered) — a transient server error is not a
    // transport failure, so no costly reprobe cycle.
    assert.equal(env.transport, 'http');
  });
});

// ---------------------------------------------------------------------------
// Image backfill accounting
// ---------------------------------------------------------------------------

describe('image backfill accounting', () => {
  it('posts backfill duplicates without incrementing capture counters', () => {
    const env = setup();
    env.imageDownload = true;
    env.seenIds = new Set(['1']);

    env.enqueueTweets([photoTweet('1')], 'HomeTimeline');

    assert.equal(env.buffer.length, 1, 'duplicate photo tweet must still reach the daemon');
    assert.equal(env.buffer[0].id, '1');
    assert.equal(env.sessionCount, 0);
    assert.equal(env.allTimeCount, 0);
    assert.ok(env.alarms.created.some(a => a.name === 'xtap-flush'),
      'backfill-only batches still need a flush alarm');

    const event = env.traceEvents.find(e => e.tweetId === '1');
    assert.equal(event.status, 'IMAGE_BACKFILL');
  });

  it('strips the internal backfill marker before POSTing to the daemon', async () => {
    const env = setup();
    env.imageDownload = true;
    env.seenIds = new Set(['1']);
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    let posted = null;
    env.fetchHolder.impl = async (_url, opts) => {
      posted = JSON.parse(opts.body);
      return okResponse({ ok: true });
    };

    env.enqueueTweets([photoTweet('1')], 'HomeTimeline');
    await env.flush();

    assert.equal(posted.tweets.length, 1);
    assert.equal(posted.tweets[0].id, '1');
    assert.equal(posted.tweets[0].__xtap_image_backfill, undefined);
  });

  it('drops image backfill before real buffered tweets when the buffer is full', () => {
    const env = setup();
    env.imageDownload = true;
    env.seenIds = new Set(['1']);
    env.buffer = Array.from({ length: 2000 }, (_, i) => ({ id: `real-${i}`, text: 'real' }));

    env.enqueueTweets([photoTweet('1')], 'HomeTimeline');

    assert.equal(env.buffer.length, 2000);
    assert.equal(env.buffer[0].id, 'real-0');
    assert.equal(env.buffer.some(t => t.id === '1'), false);
    assert.equal(env.imageCheckedIds.has('1'), false,
      'dropped backfill should be retryable later in the same service-worker session');
    assert.ok(env.traceEvents.some(e => e.status === 'BUFFER_OVERFLOW'));
  });

  it('counts fresh captures while image download is enabled', () => {
    const env = setup();
    env.imageDownload = true;

    env.enqueueTweets([photoTweet('1')], 'HomeTimeline');

    assert.equal(env.buffer.length, 1);
    assert.equal(env.sessionCount, 1);
    assert.equal(env.allTimeCount, 1);

    const event = env.traceEvents.find(e => e.tweetId === '1');
    assert.equal(event.status, 'ACCEPTED');
  });

  it('lets one article duplicate enrich a previous non-article capture', () => {
    const env = setup();
    env.imageDownload = true;
    env.seenIds = new Set(['1']);

    env.enqueueTweets([{ ...photoTweet('1'), is_article: true }], 'TweetResultByRestId');

    assert.equal(env.buffer.length, 1);
    assert.equal(env.sessionCount, 1);
    assert.equal(env.allTimeCount, 1);

    const event = env.traceEvents.find(e => e.tweetId === '1');
    assert.equal(event.status, 'ACCEPTED');
  });

  it('deduplicates repeated full article captures after the enrichment write', () => {
    const env = setup();
    env.imageDownload = true;
    env.seenIds = new Set(['1']);

    env.enqueueTweets([{ ...photoTweet('1'), is_article: true }], 'TweetResultByRestId');
    env.enqueueTweets([{ ...photoTweet('1'), is_article: true }], 'TweetResultByRestId');

    assert.equal(env.buffer.length, 1);
    assert.equal(env.sessionCount, 1);
    assert.equal(env.allTimeCount, 1);
    assert.ok(env.traceEvents.some(e => e.tweetId === '1' && e.status === 'DEDUPLICATED'));
  });

  it('clears imageCheckedIds when image download flips from off to on', async () => {
    const env = setup();
    env.imageDownload = false;
    env.imageCheckedIds = new Set(['1', '2']);

    const resp = await env.sendMessage({ type: 'SET_IMAGE_DOWNLOAD', imageDownload: true });

    assert.equal(resp.imageDownload, true);
    assert.equal(env.imageDownload, true);
    assert.equal(env.imageCheckedIds.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Flush in-flight durability
// ---------------------------------------------------------------------------

describe('flush in-flight durability', () => {
  it('keeps the in-flight batch in persisted state until the daemon acks', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    const posted = [];
    let resolveFetch;
    env.fetchHolder.impl = (url, opts) => {
      posted.push(JSON.parse(opts.body).tweets.map(t => t.id));
      return new Promise(r => { resolveFetch = r; });
    };
    env.buffer = [{ id: '1', text: 'one' }];

    const flushP = env.flush();
    await tick();

    // A concurrent GRAPHQL_RESPONSE handler enqueues + persists while the
    // POST is in flight (the common case while scrolling).
    env.enqueueTweets([{ id: '2', text: 'two' }], 'test');
    await env.saveState();

    // If the SW were killed right now, persisted state must still contain
    // tweet 1 — its WAL entry was already cleared and seenIds blocks recapture.
    const persisted = await env.sessionStore.get(null);
    assert.ok(persisted.tweetBuffer.some(t => t.id === '1'),
      'in-flight batch missing from persisted buffer — SW death here loses it');

    // Ack the first POST; subsequent POSTs (draining tweet 2) ack immediately.
    const firstResolve = resolveFetch;
    env.fetchHolder.impl = (url, opts) => {
      posted.push(JSON.parse(opts.body).tweets.map(t => t.id));
      return Promise.resolve(okResponse());
    };
    firstResolve(okResponse());
    await flushP;

    // Drained exactly once each, nothing left behind.
    assert.deepEqual(posted, [['1'], ['2']]);
    assert.equal(env.buffer.length, 0);
    const after = await env.sessionStore.get(null);
    assert.deepEqual(after.tweetBuffer, []);
  });

  it('does not double-send when flush is invoked concurrently', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    let calls = 0;
    const resolvers = [];
    env.fetchHolder.impl = () => { calls++; return new Promise(r => resolvers.push(r)); };
    env.buffer = [{ id: '1', text: 'one' }];

    const p1 = env.flush();
    await tick();
    const p2 = env.flush();
    await tick();

    assert.equal(calls, 1, 'second flush must not re-send the in-flight batch');

    resolvers.forEach(r => r(okResponse()));
    await p1;
    await p2;
    assert.equal(env.buffer.length, 0);
  });

  it('splits a backlog larger than MAX_TWEETS_PER_POST into capped POSTs', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    const posted = [];
    env.fetchHolder.impl = async (url, opts) => {
      posted.push(JSON.parse(opts.body).tweets.length);
      return okResponse();
    };
    env.buffer = Array.from({ length: 250 }, (_, i) => ({ id: String(i), text: 't' }));

    await env.flush();

    assert.deepEqual(posted, [200, 50], 'backlog must drain in <=200-tweet POSTs');
    assert.equal(env.buffer.length, 0);
  });

  it('splits the batch on 413 instead of wedging the queue', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    const posted = [];
    // Daemon accepts at most 2 tweets per POST (simulated byte limit).
    env.fetchHolder.impl = async (url, opts) => {
      const n = JSON.parse(opts.body).tweets.length;
      posted.push(n);
      if (n > 2) return okResponse({ ok: false, error: 'Payload too large' }, 413);
      return okResponse();
    };
    env.buffer = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: 't' }));

    await env.flush();

    assert.equal(env.buffer.length, 0, 'queue must drain despite 413s');
    assert.deepEqual(posted, [5, 2, 2, 1], 'batch must halve on 413, then drain');
  });

  it('drops a single tweet that alone exceeds the body limit', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    env.fetchHolder.impl = async (url, opts) => {
      const ids = JSON.parse(opts.body).tweets.map(t => t.id);
      if (ids.includes('huge')) return okResponse({ ok: false, error: 'Payload too large' }, 413);
      return okResponse();
    };
    env.buffer = [{ id: 'huge', text: 'giant article' }, { id: 'normal', text: 'ok' }];

    await env.flush();

    assert.equal(env.buffer.length, 0);
    const dropped = env.traceEvents.filter(e => e.status === 'DROPPED_OVERSIZED');
    assert.equal(dropped.length, 1, 'oversized tweet must be dropped with a trace event');
    assert.equal(dropped[0].tweetId, 'huge');
  });

  it('keeps buffer order when the send fails mid-scroll', async () => {
    const env = setup();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    let rejectFetch;
    env.fetchHolder.impl = () => new Promise((_, rej) => { rejectFetch = rej; });
    env.buffer = [{ id: '1', text: 'one' }];

    const flushP = env.flush();
    await tick();
    env.enqueueTweets([{ id: '2', text: 'two' }], 'test');

    rejectFetch(new Error('connection refused'));
    await flushP;

    assert.deepEqual(env.buffer.map(t => t.id), ['1', '2']);
  });
});

// ---------------------------------------------------------------------------
// Flush alarm (MV3: setTimeout dies with the SW; chrome.alarms survives)
// ---------------------------------------------------------------------------

describe('flush alarm', () => {
  it('schedules an alarm when tweets are buffered', () => {
    const env = setup();
    env.enqueueTweets([{ id: '1', text: 'one' }], 'test');
    assert.ok(env.alarms.created.some(a => a.name === 'xtap-flush'),
      'buffered tweets need a chrome.alarms backstop — the setTimeout flush '
      + 'timer dies with the service worker');
  });

  it('the alarm listener flushes the restored buffer', async () => {
    const env = setup();
    env.readyResolve();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    let calls = 0;
    env.fetchHolder.impl = async () => { calls++; return okResponse(); };
    env.buffer = [{ id: '1', text: 'one' }];

    assert.ok(env.alarms.listener, 'no onAlarm listener registered at top level');
    env.alarms.listener({ name: 'xtap-flush' });
    await tick();
    await tick();

    assert.equal(calls, 1, 'alarm did not trigger a flush');
    assert.equal(env.buffer.length, 0);
  });

  it('the alarm listener clears the alarm once the buffer is drained', async () => {
    const env = setup();
    env.readyResolve();
    env.transport = 'http';
    env.httpToken = 't';
    env.httpPort = 17381;
    env.buffer = [];

    assert.ok(env.alarms.listener, 'no onAlarm listener registered at top level');
    env.alarms.listener({ name: 'xtap-flush' });
    await tick();
    await tick();

    assert.ok(env.alarms.cleared.includes('xtap-flush'),
      'a drained buffer must clear the alarm so the SW stops being woken');
  });
});
