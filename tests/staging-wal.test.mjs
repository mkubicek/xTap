/**
 * Tests for WAL staging, buffer persistence, and buffer overflow (issue #9).
 * Run with: node --test tests/staging-wal.test.mjs
 *
 * Evaluates background.js in a vm context with mocked chrome APIs
 * to test the actual staging, recovery, and buffer logic.
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
      stagePayload, clearStagedPayload, recoverStagedPayloads,
      saveState, restoreState, enqueueTweets,
      stagingStorage, seenIdsStorage,
      get buffer() { return buffer; },
      set buffer(v) { buffer = v; },
      get seenIds() { return seenIds; },
      set seenIds(v) { seenIds = v; },
      get traceEvents() { return traceEvents; },
      MAX_BUFFER_SIZE,
    };`
  );

function createMockStorage(opts = {}) {
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
      if (opts.throwOnSet) return Promise.reject(new Error('QuotaExceededError'));
      if (opts.throwOnStagingWrite && Object.keys(items).some(k => k.startsWith('stg_')))
        return Promise.reject(new Error('QuotaExceededError'));
      if (opts.throwOnStateWrite && ('seenIds' in items || 'tweetBuffer' in items))
        return Promise.reject(new Error('QuotaExceededError'));
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

/**
 * Create a fresh background.js environment with mocked chrome APIs.
 * Returns the exposed internals (with live getters/setters) plus storage mocks.
 */
function setup(opts = {}) {
  const sessionStore = createMockStorage(opts.sessionOpts);
  const localStore = createMockStorage(opts.localOpts);

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    fetch: async () => ({ json: async () => ({}) }),
    extractTweets: opts.extractTweets || (() => []),
    dedupTweet,
    chrome: {
      runtime: {
        getManifest: () => ({}), // no update_url → isDevMode = true
        connectNative() { throw new Error('not available'); },
        onMessage: { addListener() {} },
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
    },
  };

  vm.runInNewContext(testSource, sandbox);

  // Return internals directly (not spread) to preserve getters/setters
  const env = sandbox._internals;
  env.sessionStore = sessionStore;
  env.localStore = localStore;
  return env;
}

// ---------------------------------------------------------------------------
// stagePayload + clearStagedPayload
// ---------------------------------------------------------------------------

describe('stagePayload + clearStagedPayload', () => {
  it('round-trip: stage writes key, clear removes it', async () => {
    const env = setup();
    const key = await env.stagePayload('HomeTimeline', { foo: 1 });
    assert.ok(key);
    assert.ok(key.startsWith('stg_'));

    const stored = await env.stagingStorage().get(null);
    assert.ok(stored[key]);
    assert.equal(stored[key].endpoint, 'HomeTimeline');

    await env.clearStagedPayload(key);
    const after = await env.stagingStorage().get(null);
    assert.equal(after[key], undefined);
  });

  it('clear(null) is a no-op', async () => {
    const env = setup();
    await env.clearStagedPayload(null); // must not throw
  });

  it('returns null on quota error', async () => {
    const env = setup({ sessionOpts: { throwOnStagingWrite: true } });
    const key = await env.stagePayload('HomeTimeline', { foo: 1 });
    assert.equal(key, null);
  });

  it('emits STAGE_FAILED trace event on quota error', async () => {
    const env = setup({ sessionOpts: { throwOnStagingWrite: true } });
    await env.stagePayload('HomeTimeline', { foo: 1 });
    const failEvents = env.traceEvents.filter(e => e.status === 'STAGE_FAILED');
    assert.equal(failEvents.length, 1);
    assert.equal(failEvents[0].endpoint, 'HomeTimeline');
  });
});

// ---------------------------------------------------------------------------
// recoverStagedPayloads
// ---------------------------------------------------------------------------

describe('recoverStagedPayloads', () => {
  it('processes staged payloads and enqueues tweets', async () => {
    const tweets = [
      { id: '1', text: 'tweet 1' },
      { id: '2', text: 'tweet 2' },
      { id: '3', text: 'tweet 3' },
    ];
    const env = setup({
      extractTweets: (_ep, data) => data?.tweets || [],
    });

    await env.stagePayload('HomeTimeline', { tweets: [tweets[0]] });
    await env.stagePayload('UserTweets', { tweets: [tweets[1]] });
    await env.stagePayload('TweetDetail', { tweets: [tweets[2]] });

    await env.recoverStagedPayloads();

    assert.equal(env.buffer.length, 3);
    assert.equal(env.buffer[0].id, '1');
    assert.equal(env.buffer[1].id, '2');
    assert.equal(env.buffer[2].id, '3');

    // All staging keys should be cleared
    const stored = await env.stagingStorage().get(null);
    const stgKeys = Object.keys(stored).filter(k => k.startsWith('stg_'));
    assert.equal(stgKeys.length, 0);
  });

  it('dedup: skips tweets already in seenIds', async () => {
    const env = setup({
      extractTweets: (_ep, data) => data?.tweets || [],
    });

    env.seenIds = new Set(['1']);

    await env.stagePayload('HomeTimeline', {
      tweets: [{ id: '1', text: 'dupe' }, { id: '2', text: 'new' }],
    });

    await env.recoverStagedPayloads();

    assert.equal(env.buffer.length, 1);
    assert.equal(env.buffer[0].id, '2');
  });

  it('discards entries older than 24h', async () => {
    const env = setup({
      extractTweets: (_ep, data) => data?.tweets || [],
    });

    const oldKey = 'stg_1000_0';
    await env.stagingStorage().set({
      [oldKey]: {
        endpoint: 'HomeTimeline',
        data: { tweets: [{ id: '1', text: 'old' }] },
        stagedAt: Date.now() - 25 * 60 * 60 * 1000,
      },
    });

    await env.recoverStagedPayloads();

    assert.equal(env.buffer.length, 0);
    const stored = await env.stagingStorage().get(null);
    assert.equal(stored[oldKey], undefined);
  });

  it('clears key even on parse error', async () => {
    const env = setup({
      extractTweets: () => { throw new Error('parse fail'); },
    });

    const key = await env.stagePayload('HomeTimeline', { foo: 'bad' });
    await env.recoverStagedPayloads();

    const stored = await env.stagingStorage().get(null);
    assert.equal(stored[key], undefined);
    assert.equal(env.buffer.length, 0);
  });

  it('keeps WAL entry when saveState fails', async () => {
    const env = setup({
      extractTweets: (_ep, data) => data?.tweets || [],
      sessionOpts: { throwOnStateWrite: true },
    });

    // Stage works (stg_* keys aren't blocked by throwOnStateWrite)
    await env.stagePayload('HomeTimeline', {
      tweets: [{ id: '1', text: 'tweet 1' }],
    });

    await env.recoverStagedPayloads();

    // Tweet is in in-memory buffer
    assert.equal(env.buffer.length, 1);
    assert.equal(env.buffer[0].id, '1');

    // WAL entry is retained (saveState failed → recovery kept it)
    const stored = await env.stagingStorage().get(null);
    const stgKeys = Object.keys(stored).filter(k => k.startsWith('stg_'));
    assert.equal(stgKeys.length, 1);
  });
});

// ---------------------------------------------------------------------------
// saveState / restoreState buffer persistence
// ---------------------------------------------------------------------------

describe('saveState / restoreState buffer persistence', () => {
  it('round-trip: saves and restores buffer + seenIds', async () => {
    const env = setup();

    env.buffer = [{ id: '1', text: 'buffered' }, { id: '2', text: 'also buffered' }];
    env.seenIds = new Set(['1', '2', '3']);

    await env.saveState();

    env.buffer = [];
    env.seenIds = new Set();

    await env.restoreState();

    assert.equal(env.buffer.length, 2);
    assert.equal(env.buffer[0].id, '1');
    assert.equal(env.buffer[1].id, '2');
    assert.ok(env.seenIds.has('1'));
    assert.ok(env.seenIds.has('2'));
    assert.ok(env.seenIds.has('3'));
  });

  it('returns false on storage error (coupled write)', async () => {
    const env = setup({ sessionOpts: { throwOnStateWrite: true } });

    env.buffer = [{ id: '1', text: 'buffered' }];
    env.seenIds = new Set(['1']);

    const ok = await env.saveState();
    assert.equal(ok, false);

    // Neither seenIds nor buffer should be in storage
    env.buffer = [];
    env.seenIds = new Set();
    await env.restoreState();
    assert.equal(env.buffer.length, 0);
    assert.equal(env.seenIds.size, 0);
  });

  it('returns true on success', async () => {
    const env = setup();
    env.buffer = [{ id: '1', text: 'buffered' }];
    const ok = await env.saveState();
    assert.equal(ok, true);
  });
});

// ---------------------------------------------------------------------------
// Buffer overflow
// ---------------------------------------------------------------------------

describe('buffer overflow', () => {
  it('drops oldest tweets when over MAX_BUFFER_SIZE', () => {
    const env = setup();

    // Pre-fill buffer to MAX_BUFFER_SIZE - 1
    env.buffer = Array.from({ length: env.MAX_BUFFER_SIZE - 1 }, (_, i) => ({
      id: `pre${i}`, text: `pre ${i}`,
    }));

    // Enqueue 2 more → total MAX_BUFFER_SIZE + 1 → overflow drops 1 oldest
    env.enqueueTweets([
      { id: 'new1', text: 'new 1' },
      { id: 'new2', text: 'new 2' },
    ], 'test');

    assert.equal(env.buffer.length, env.MAX_BUFFER_SIZE);
    assert.equal(env.buffer[0].id, 'pre1'); // pre0 was dropped
    assert.equal(env.buffer[env.buffer.length - 1].id, 'new2');
    assert.equal(env.buffer[env.buffer.length - 2].id, 'new1');
  });

  it('emits BUFFER_OVERFLOW trace event', () => {
    const env = setup();

    env.buffer = Array.from({ length: env.MAX_BUFFER_SIZE }, (_, i) => ({
      id: `pre${i}`, text: `pre ${i}`,
    }));

    env.enqueueTweets([{ id: 'overflow', text: 'overflow' }], 'test');

    const overflowEvents = env.traceEvents.filter(e => e.status === 'BUFFER_OVERFLOW');
    assert.equal(overflowEvents.length, 1);
    assert.ok(overflowEvents[0].reason.includes('dropped 1'));
  });
});
