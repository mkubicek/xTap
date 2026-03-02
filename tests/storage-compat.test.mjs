import test from 'node:test';
import assert from 'node:assert/strict';
import { storageGet, storageSet } from '../lib/storage-compat.js';

function makeRuntime() {
  return { lastError: null };
}

test('storageGet supports callback-style areas', async () => {
  const runtime = makeRuntime();
  const area = {
    get(_keys, cb) {
      cb({ seenIds: ['1', '2'] });
    }
  };
  const value = await storageGet(area, ['seenIds'], runtime);
  assert.deepEqual(value, { seenIds: ['1', '2'] });
});

test('storageGet supports promise-style areas', async () => {
  const runtime = makeRuntime();
  const area = {
    get() {
      return Promise.resolve({ captureEnabled: true });
    }
  };
  const value = await storageGet(area, ['captureEnabled'], runtime);
  assert.deepEqual(value, { captureEnabled: true });
});

test('storageGet falls back to get(keys) when get(keys, cb) throws', async () => {
  const runtime = makeRuntime();
  const area = {
    get(keys, cb) {
      if (typeof cb === 'function') throw new Error('callback not supported');
      assert.deepEqual(keys, ['allTimeCount']);
      return Promise.resolve({ allTimeCount: 42 });
    }
  };
  const value = await storageGet(area, ['allTimeCount'], runtime);
  assert.deepEqual(value, { allTimeCount: 42 });
});

test('storageGet rejects when runtime.lastError is set', async () => {
  const runtime = makeRuntime();
  const area = {
    get(_keys, cb) {
      runtime.lastError = { message: 'get failed' };
      cb({});
      runtime.lastError = null;
    }
  };
  await assert.rejects(storageGet(area, ['x'], runtime), /get failed/);
});

test('storageSet supports callback-style areas', async () => {
  const runtime = makeRuntime();
  let saved = null;
  const area = {
    set(value, cb) {
      saved = value;
      cb();
    }
  };
  await storageSet(area, { debugLogging: true }, runtime);
  assert.deepEqual(saved, { debugLogging: true });
});

test('storageSet supports promise-style areas', async () => {
  const runtime = makeRuntime();
  let saved = null;
  const area = {
    set(value) {
      saved = value;
      return Promise.resolve();
    }
  };
  await storageSet(area, { outputDir: '/tmp/x' }, runtime);
  assert.deepEqual(saved, { outputDir: '/tmp/x' });
});

test('storageSet falls back to set(value) when set(value, cb) throws', async () => {
  const runtime = makeRuntime();
  let saved = null;
  const area = {
    set(value, cb) {
      if (typeof cb === 'function') throw new Error('callback not supported');
      saved = value;
      return Promise.resolve();
    }
  };
  await storageSet(area, { httpToken: 'abc' }, runtime);
  assert.deepEqual(saved, { httpToken: 'abc' });
});

test('storageSet rejects when runtime.lastError is set', async () => {
  const runtime = makeRuntime();
  const area = {
    set(_value, cb) {
      runtime.lastError = { message: 'set failed' };
      cb();
      runtime.lastError = null;
    }
  };
  await assert.rejects(storageSet(area, { k: 1 }, runtime), /set failed/);
});
