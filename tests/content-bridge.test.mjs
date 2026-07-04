/**
 * Tests for content-bridge.js — beacon polling, give-up bound, and event relay.
 * Run with: node --test tests/content-bridge.test.mjs
 *
 * Evaluates the bridge in a vm context with a stubbed document, fake timers,
 * and a recorded chrome.runtime.sendMessage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridgeSource = readFileSync(new URL('../content-bridge.js', import.meta.url), 'utf8');

const BEACON_MAX_ATTEMPTS = 200; // mirrors content-bridge.js

function setup({ meta = null, documentElement = {} } = {}) {
  const state = {
    meta,               // set to an object to make the beacon findable
    metaRemoved: false,
    listeners: {},      // eventName -> [handlers]
    scheduled: [],      // pending fake-timer callbacks: {fn, ms}
    sent: [],           // chrome.runtime.sendMessage payloads
    rafCalls: 0,
  };

  const document = {
    documentElement,
    querySelector(sel) {
      assert.equal(sel, 'meta[name="__cfg"]');
      if (!state.meta) return null;
      return {
        content: state.meta.content,
        remove() { state.metaRemoved = true; },
      };
    },
    addEventListener(name, handler) {
      (state.listeners[name] ||= []).push(handler);
    },
  };

  const sandbox = {
    document,
    chrome: { runtime: { sendMessage: (msg) => state.sent.push(msg) } },
    // Fake timers: collect callbacks; tests drain them explicitly.
    setTimeout(fn, ms) { state.scheduled.push({ fn, ms }); return state.scheduled.length; },
    // rAF must NOT be used — it never fires in hidden/background tabs.
    requestAnimationFrame() { state.rafCalls++; },
    JSON,
  };

  vm.runInNewContext(bridgeSource, sandbox);
  return state;
}

// Run every currently-scheduled timer once (new timers queue for the next round).
function drainOnce(state) {
  const batch = state.scheduled.splice(0);
  for (const { fn } of batch) fn();
  return batch.length;
}

describe('beacon discovery', () => {
  it('finds the beacon immediately, removes the meta tag, and relays events', () => {
    const state = setup({ meta: { content: 'evt-abc' } });

    assert.equal(state.metaRemoved, true, 'the meta tag must leave no DOM trace');
    assert.equal(state.scheduled.length, 0, 'no retry needed when the beacon is present');
    assert.ok(state.listeners['evt-abc'], 'bridge must listen on the beacon event name');

    state.listeners['evt-abc'][0]({
      detail: JSON.stringify({ url: 'https://x.com/i/api/graphql/X/HomeTimeline', endpoint: 'HomeTimeline', data: { a: 1 } }),
    });
    // JSON round-trip: the message object is created inside the vm realm, so
    // a direct deepEqual would fail on cross-realm prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(state.sent)), [{
      type: 'GRAPHQL_RESPONSE',
      url: 'https://x.com/i/api/graphql/X/HomeTimeline',
      endpoint: 'HomeTimeline',
      data: { a: 1 },
    }]);
  });

  it('retries via setTimeout (not rAF) and finds the beacon on a later attempt', () => {
    const state = setup();
    assert.equal(state.scheduled.length, 1, 'a miss must schedule exactly one retry');
    assert.equal(state.scheduled[0].ms, 50, 'retry interval is BEACON_RETRY_MS');
    assert.equal(state.rafCalls, 0,
      'rAF callbacks never fire in hidden tabs — polling must use setTimeout');

    drainOnce(state);           // miss #2
    state.meta = { content: 'evt-late' };
    drainOnce(state);           // finds it
    assert.ok(state.listeners['evt-late'], 'beacon found on retry must start the bridge');
    assert.equal(state.scheduled.length, 0, 'no further polling after the beacon is found');
  });

  it('gives up after BEACON_MAX_ATTEMPTS instead of polling forever', () => {
    const state = setup();
    let totalRetries = 1; // the initial miss already scheduled one
    for (let round = 0; round < BEACON_MAX_ATTEMPTS + 10 && state.scheduled.length > 0; round++) {
      totalRetries += drainOnce(state);
    }
    // Initial call misses and schedules retry 1; retries 1..199 miss and
    // schedule the next; retry 199 pushes beaconAttempts to 200, which stops.
    assert.equal(totalRetries - 1, BEACON_MAX_ATTEMPTS - 1,
      'polling must stop at the attempt bound');
    assert.equal(state.scheduled.length, 0, 'no timer may remain after give-up');
    assert.deepEqual(Object.keys(state.listeners), [],
      'no event listener without a beacon');
  });

  it('ignores malformed event payloads without throwing', () => {
    const state = setup({ meta: { content: 'evt-x' } });
    state.listeners['evt-x'][0]({ detail: 'not json {' });
    assert.deepEqual(state.sent, [], 'malformed payloads are dropped silently');
  });

  it('waits for DOMContentLoaded when documentElement is not ready', () => {
    const state = setup({ documentElement: null });
    assert.equal(state.scheduled.length, 0, 'no polling before the document exists');
    assert.ok(state.listeners['DOMContentLoaded'], 'must defer to DOMContentLoaded');

    state.meta = { content: 'evt-dcl' };
    state.listeners['DOMContentLoaded'][0]();
    assert.ok(state.listeners['evt-dcl'], 'polling starts once the document is ready');
  });
});
