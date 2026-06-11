// xTap — ISOLATED world bridge script
// Listens for CustomEvents from the MAIN world content script and
// forwards them to the service worker via chrome.runtime.sendMessage().
(function () {
  'use strict';

  // The MAIN world script creates a <meta name="__cfg"> with the random event name.
  // We poll for it since the MAIN script may not have run yet.
  function start(eventName) {
    document.addEventListener(eventName, (e) => {
      try {
        const payload = JSON.parse(e.detail);
        chrome.runtime.sendMessage({
          type: 'GRAPHQL_RESPONSE',
          url: payload.url,
          endpoint: payload.endpoint,
          data: payload.data
        });
      } catch (_) {}
    });
  }

  function findBeacon() {
    const meta = document.querySelector('meta[name="__cfg"]');
    if (meta) {
      const eventName = meta.content;
      meta.remove(); // Clean up — no trace left in DOM
      start(eventName);
    } else {
      // MAIN world script hasn't run yet, retry. setTimeout, not rAF —
      // rAF callbacks never fire in hidden/background tabs, which would
      // drop every event until the tab becomes visible.
      setTimeout(findBeacon, 50);
    }
  }

  if (document.documentElement) {
    findBeacon();
  } else {
    document.addEventListener('DOMContentLoaded', findBeacon, { once: true });
  }
})();
