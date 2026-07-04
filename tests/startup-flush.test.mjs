/**
 * Tests for the service-worker startup path in background.js — the Init block
 * that the transport-flush/staging-wal rigs strip out.
 * Run with: node --test tests/startup-flush.test.mjs
 *
 * Runs the FULL source (imports stripped, Init kept) in a vm with pre-seeded
 * storage, and asserts that a buffer restored from a previous session is
 * delivered immediately at startup — without any flush timer or alarm firing.
 * MV3 can kill the SW ~30s after wake, so waiting for the first timer tick
 * risks stranding the restored batch for another session.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dedupTweet } from '../lib/dedup.js';

const bgSource = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const testSource = bgSource.replace(/^import\b.*$/gm, '');

// The Init block must still be present — if the marker moves, this rig would
// silently stop testing the startup path.
assert.ok(bgSource.includes('// --- Init ---'), 'Init marker missing from background.js');

function createMockStorage(initial = {}) {
  let data = { ...initial };
  return {
    get(keys) {
      if (keys === null) return Promise.resolve({ ...data });
      const result = {};
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (k in data) result[k] = data[k];
      return Promise.resolve(result);
    },
    set(items) { Object.assign(data, items); return Promise.resolve(); },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
      return Promise.resolve();
    },
    setAccessLevel() { return Promise.resolve(); },
  };
}

function until(cond, ms = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (cond()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('condition not met in time'));
      setTimeout(poll, 5);
    })();
  });
}

function bootSW({ sessionSeed = {}, localSeed = {} } = {}) {
  const sessionStore = createMockStorage(sessionSeed);
  const localStore = createMockStorage(localSeed);
  const fetches = [];   // { url, method, body }
  const alarms = { created: [], listener: null };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // unref so the SW's recurring flush timer (30-45s, rescheduled forever by
    // scheduleNextFlush in the Init block) can't keep the test process alive.
    setTimeout: (fn, ms) => {
      const t = globalThis.setTimeout(fn, ms);
      if (typeof t?.unref === 'function') t.unref();
      return t;
    },
    clearTimeout: globalThis.clearTimeout,
    Math, JSON, Date, Promise, Set, Map, Array, Object,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    fetch: async (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    extractTweets: () => [],
    dedupTweet,
    chrome: {
      runtime: {
        getManifest: () => ({}), // dev mode -> seenIds/tweetBuffer in session storage
        connectNative() { throw new Error('not available'); },
        onMessage: { addListener() {} },
        lastError: null,
      },
      storage: { session: sessionStore, local: localStore },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      alarms: {
        create(name, info) { alarms.created.push({ name, info }); },
        clear() {},
        onAlarm: { addListener(fn) { alarms.listener = fn; } },
      },
    },
  };

  vm.runInNewContext(testSource, sandbox);
  return { fetches, alarms, sessionStore, localStore };
}

describe('service worker startup', () => {
  it('flushes a restored buffer immediately, before any timer or alarm fires', async () => {
    const sw = bootSW({
      sessionSeed: { tweetBuffer: [{ id: 'restored-1', text: 'from last session' }] },
      localSeed: { httpToken: 'cached-token', httpPort: 17381 },
    });

    // Init chain: restoreState -> initTransport (probes /status with the
    // cached token) -> startup flush POSTs the restored buffer. All of this
    // must happen with zero timer ticks and zero alarm firings.
    await until(() => sw.fetches.some(f => f.url.includes('/tweets')));

    const post = sw.fetches.find(f => f.url.includes('/tweets'));
    const tweets = JSON.parse(post.body).tweets;
    assert.deepEqual(tweets.map(t => t.id), ['restored-1'],
      'the restored batch must be delivered by the startup flush itself');

    assert.ok(sw.fetches.some(f => f.url.includes('/status')),
      'startup must validate the cached token against the daemon first');

    // The alarm backstop must be armed for the restored buffer (in case the
    // startup flush fails and the SW dies before the timer tick).
    assert.ok(sw.alarms.created.some(a => a.name === 'xtap-flush'),
      'a restored buffer must arm the flush alarm backstop');

    // The batch drains and is removed from persisted state after the ack.
    const deadline = Date.now() + 2000;
    let persisted;
    do {
      persisted = await sw.sessionStore.get(['tweetBuffer']);
      if ((persisted.tweetBuffer || []).length === 0) break;
      await new Promise(r => setTimeout(r, 5));
    } while (Date.now() < deadline);
    assert.deepEqual(persisted.tweetBuffer, [],
      'the acked startup batch must leave persisted state');
  });

  it('does not POST tweets at startup when nothing was restored', async () => {
    const sw = bootSW({
      localSeed: { httpToken: 'cached-token', httpPort: 17381 },
    });

    // Let the init chain settle (transport probe happens regardless).
    await until(() => sw.fetches.some(f => f.url.includes('/status')));
    await new Promise(r => setTimeout(r, 50));

    assert.equal(sw.fetches.filter(f => f.url.includes('/tweets')).length, 0,
      'an empty buffer must not trigger a startup POST');
    assert.equal(sw.alarms.created.length, 0,
      'no alarm needed when nothing is buffered');
  });
});
