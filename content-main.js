// xTap — MAIN world content script
// Intercepts X/Twitter GraphQL API responses via fetch and XMLHttpRequest.
// Dispatches a CustomEvent to relay data to the ISOLATED world bridge script.
(function () {
  'use strict';

  const GRAPHQL_PATTERN = '/i/api/graphql/';
  const EVENT_NAME = '_' + Math.random().toString(36).slice(2);
  const beacon = document.createElement('meta');
  beacon.name = '__cfg';
  beacon.content = EVENT_NAME;
  (document.head || document.documentElement).appendChild(beacon);

  const xhrUrls = new WeakMap();
  const xhrPatched = new WeakSet();

  function extractEndpoint(url) {
    try {
      const path = new URL(url, location.origin).pathname;
      const parts = path.split('/');
      const gqlIdx = parts.indexOf('graphql');
      return (gqlIdx >= 0 && parts[gqlIdx + 2]) ? parts[gqlIdx + 2] : 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  function dispatchData(url, data) {
    const endpoint = extractEndpoint(url);
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: JSON.stringify({ url, endpoint, data })
    }));
  }

  // --- Patch fetch ---
  const originalFetch = window.fetch;
  const patchedFetch = async function fetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
      if (url && url.includes(GRAPHQL_PATTERN)) {
        const clone = response.clone();
        clone.json().then(data => dispatchData(url, data)).catch(() => {});
      }
    } catch (_) {}
    return response;
  };
  patchedFetch.toString = () => 'function fetch() { [native code] }';
  Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
  window.fetch = patchedFetch;

  // --- Patch XMLHttpRequest ---
  // Only patch open() to attach a load listener for GraphQL URLs.
  // send() is NOT patched, so non-GraphQL XHR calls have a clean stack trace.
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeOpenStr = nativeOpen.toString();

  const patchedOpen = function open(method, url, ...rest) {
    const urlStr = (typeof url === 'string') ? url : url?.toString();
    if (urlStr && urlStr.includes(GRAPHQL_PATTERN)) {
      xhrUrls.set(this, urlStr);
      if (!xhrPatched.has(this)) {
        xhrPatched.add(this);
        this.addEventListener('load', function () {
          try {
            const data = JSON.parse(this.responseText);
            dispatchData(xhrUrls.get(this), data);
          } catch (_) {}
        });
      }
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
  patchedOpen.toString = () => nativeOpenStr;

  XMLHttpRequest.prototype.open = patchedOpen;
})();
