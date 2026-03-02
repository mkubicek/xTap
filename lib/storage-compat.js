// Storage API compatibility helpers for callback-only and promise-based
// extension runtimes (Chrome/Firefox variations).

function runtimeFrom(runtimeLike) {
  if (runtimeLike) return runtimeLike;
  return globalThis.chrome?.runtime || null;
}

export function storageGet(area, keys, runtimeLike) {
  const runtime = runtimeFrom(runtimeLike);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const err = runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(value || {});
    };
    try {
      const maybePromise = area.get(keys, finish);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((value) => finish(value)).catch(reject);
      }
    } catch (_firstErr) {
      try {
        const maybePromise = area.get(keys);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((value) => finish(value)).catch(reject);
        } else {
          finish({});
        }
      } catch (err) {
        reject(err);
      }
    }
  });
}

export function storageSet(area, value, runtimeLike) {
  const runtime = runtimeFrom(runtimeLike);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const err = runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    };
    try {
      const maybePromise = area.set(value, finish);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(() => finish()).catch(reject);
      }
    } catch (_firstErr) {
      try {
        const maybePromise = area.set(value);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(() => finish()).catch(reject);
        } else {
          finish();
        }
      } catch (err) {
        reject(err);
      }
    }
  });
}
