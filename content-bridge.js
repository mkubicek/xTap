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

  // The MAIN world script normally runs within milliseconds; if the beacon
  // hasn't appeared after the full window, it never will (injection blocked)
  // — stop polling instead of spinning for the lifetime of the tab.
  const BEACON_RETRY_MS = 50;
  const BEACON_MAX_ATTEMPTS = 200; // ~10s
  let beaconAttempts = 0;

  function findBeacon() {
    const meta = document.querySelector('meta[name="__cfg"]');
    if (meta) {
      const eventName = meta.content;
      meta.remove(); // Clean up — no trace left in DOM
      start(eventName);
    } else if (++beaconAttempts < BEACON_MAX_ATTEMPTS) {
      // MAIN world script hasn't run yet, retry. setTimeout, not rAF —
      // rAF callbacks never fire in hidden/background tabs, which would
      // drop every event until the tab becomes visible.
      setTimeout(findBeacon, BEACON_RETRY_MS);
    }
  }

  if (document.documentElement) {
    findBeacon();
  } else {
    document.addEventListener('DOMContentLoaded', findBeacon, { once: true });
  }
})();
