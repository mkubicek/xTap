// xTap — Service Worker (background)
import { extractTweets } from './lib/tweet-parser.js';

const NATIVE_HOST = 'com.xtap.host';
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_SEEN_IDS = 50_000;
const HTTP_TIMEOUT_MS = 10_000;

let captureEnabled = true;
let nativePort = null;
let buffer = [];
let flushTimer = null;
let seenIds = new Set();
let sessionCount = 0;
let allTimeCount = 0;
let outputDir = '';
let debugLogging = false;
let logBuffer = [];

// --- Transport state ---
// 'http' | 'native' | 'none'
let transport = 'none';
let httpToken = null;
let httpPort = null;

// --- State persistence ---

async function saveState() {
  await chrome.storage.local.set({
    seenIds: [...seenIds].slice(-MAX_SEEN_IDS),
    allTimeCount,
    captureEnabled
  });
}

async function restoreState() {
  const stored = await chrome.storage.local.get(['seenIds', 'allTimeCount', 'captureEnabled', 'outputDir', 'debugLogging']);
  if (stored.seenIds) seenIds = new Set(stored.seenIds);
  if (typeof stored.allTimeCount === 'number') allTimeCount = stored.allTimeCount;
  if (typeof stored.captureEnabled === 'boolean') captureEnabled = stored.captureEnabled;
  if (typeof stored.outputDir === 'string') outputDir = stored.outputDir;
  if (typeof stored.debugLogging === 'boolean') debugLogging = stored.debugLogging;
}

// --- Debug logging ---

const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;

function debugLog(level, args) {
  if (!debugLogging) return;
  const ts = new Date().toISOString();
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push(`${ts} [${level}] ${text}`);
}

console.log = (...args) => { _origLog(...args); debugLog('LOG', args); };
console.warn = (...args) => { _origWarn(...args); debugLog('WARN', args); };
console.error = (...args) => { _origError(...args); debugLog('ERROR', args); };

// --- HTTP transport ---

async function httpFetch(method, path, body) {
  const url = `http://127.0.0.1:${httpPort}${path}`;
  const opts = { method, headers: {} };
  if (httpToken) {
    opts.headers['Authorization'] = `Bearer ${httpToken}`;
  }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  opts.signal = controller.signal;
  try {
    const resp = await fetch(url, opts);
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function probeHttp(port, token) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await resp.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function getTokenViaNative() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      port.disconnect();
      resolve(null);
    }, 5000);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      port.disconnect();
      if (msg.ok && msg.token) {
        resolve({ token: msg.token, port: msg.port });
      } else {
        resolve(null);
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      resolve(null);
    });
    port.postMessage({ type: 'GET_TOKEN' });
  });
}

async function initTransport() {
  // 1. Check cached token
  const cached = await chrome.storage.local.get(['httpToken', 'httpPort']);
  if (cached.httpToken && cached.httpPort) {
    const alive = await probeHttp(cached.httpPort, cached.httpToken);
    if (alive) {
      httpToken = cached.httpToken;
      httpPort = cached.httpPort;
      transport = 'http';
      console.log('[xTap] Using HTTP transport (cached token)');
      return;
    }
  }

  // 2. Try to get token from native host
  const result = await getTokenViaNative();
  if (result) {
    const alive = await probeHttp(result.port, result.token);
    if (alive) {
      httpToken = result.token;
      httpPort = result.port;
      transport = 'http';
      await chrome.storage.local.set({ httpToken, httpPort });
      console.log('[xTap] Using HTTP transport (token from native host)');
      return;
    }
  }

  // 3. Fall back to native messaging
  connectNative();
  if (nativePort) {
    transport = 'native';
    console.log('[xTap] Using native messaging transport');
  } else {
    transport = 'none';
    console.warn('[xTap] No transport available');
  }
}

// --- Native messaging ---

let disconnectCount = 0;
let lastDisconnect = 0;

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'unknown';
      const now = Date.now();
      disconnectCount++;
      const rapid = (now - lastDisconnect) < 5000;
      lastDisconnect = now;
      if (rapid) {
        console.error(`[xTap] Native host disconnected rapidly (${disconnectCount}x): ${err} — possible crash loop`);
      } else {
        console.warn(`[xTap] Native host disconnected: ${err}`);
      }
      nativePort = null;
    });
    nativePort.onMessage.addListener((msg) => {
      if (!msg.ok && msg.error) {
        console.error(`[xTap] Host error: ${msg.error}`);
      } else if (msg.count !== undefined) {
        console.log(`[xTap] Host wrote ${msg.count} tweets`);
        disconnectCount = 0;
      }
    });
    console.log('[xTap] Connected to native host');
  } catch (e) {
    console.error('[xTap] Failed to connect native host:', e);
    nativePort = null;
  }
}

// --- Unified send ---

async function sendToHost(msg) {
  if (transport === 'http') {
    try {
      let path, body;
      if (msg.type === 'TEST_PATH') {
        path = '/test-path';
        body = { outputDir: msg.outputDir };
      } else if (msg.type === 'LOG') {
        path = '/log';
        body = { lines: msg.lines };
        if (msg.outputDir) body.outputDir = msg.outputDir;
      } else {
        path = '/tweets';
        body = { tweets: msg.tweets };
        if (msg.outputDir) body.outputDir = msg.outputDir;
      }
      const resp = await httpFetch('POST', path, body);
      return resp;
    } catch (e) {
      console.warn('[xTap] HTTP send failed, falling back to native:', e.message);
      // Fall back to native
      transport = 'native';
      connectNative();
      // Fall through to native send below
    }
  }

  if (transport === 'native' || nativePort) {
    if (!nativePort) connectNative();
    if (nativePort) {
      try {
        nativePort.postMessage(msg);
        return null; // native messaging is fire-and-forget for non-response messages
      } catch (e) {
        console.error('[xTap] Native send failed:', e);
        nativePort = null;
        return null;
      }
    }
  }

  console.warn('[xTap] No transport available, message dropped');
  return null;
}

// --- Batching & flushing ---

function scheduledFlush() {
  if (buffer.length > 0 || logBuffer.length > 0) flush();
}

async function flushLogs() {
  if (logBuffer.length === 0) return;
  if (transport === 'none') return;
  const lines = logBuffer.splice(0);
  const message = { type: 'LOG', lines };
  if (outputDir) message.outputDir = outputDir;
  await sendToHost(message);
}

async function flush() {
  if (buffer.length === 0 && logBuffer.length === 0) return;

  if (transport === 'none') {
    // Try to establish a transport
    connectNative();
    if (nativePort) transport = 'native';
  }

  if (buffer.length > 0) {
    const batch = buffer.splice(0);
    const message = { tweets: batch };
    if (outputDir) message.outputDir = outputDir;

    try {
      const resp = await sendToHost(message);
      if (resp && !resp.ok) {
        console.error('[xTap] Host rejected tweets:', resp.error);
      }
    } catch (e) {
      console.error('[xTap] Send failed, buffering tweets back:', e);
      buffer.unshift(...batch);
    }
  }

  if (debugLogging) await flushLogs();
}

function enqueueTweets(tweets) {
  let newCount = 0;
  for (const tweet of tweets) {
    if (seenIds.has(tweet.id)) continue;
    seenIds.add(tweet.id);
    buffer.push(tweet);
    newCount++;
  }

  // FIFO eviction if seenIds grows too large
  if (seenIds.size > MAX_SEEN_IDS) {
    const arr = [...seenIds];
    seenIds = new Set(arr.slice(arr.length - MAX_SEEN_IDS));
  }

  const dupeCount = tweets.length - newCount;
  if (dupeCount > 0) {
    console.log(`[xTap] Dedup: ${newCount} new, ${dupeCount} duplicates skipped (seenIds: ${seenIds.size})`);
  }

  sessionCount += newCount;
  allTimeCount += newCount;
  updateBadge();
  saveState();

  if (buffer.length >= BATCH_SIZE) flush();
}

// --- Badge ---

function updateBadge() {
  const text = sessionCount > 0 ? String(sessionCount) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#1D9BF0' });
}

// --- Message handling ---

// Endpoints that use /i/api/graphql/ but never contain tweets
const IGNORED_ENDPOINTS = new Set([
  'DataSaverMode', 'getAltTextPromptPreference', 'useDirectCallSetupQuery',
  'XChatDmSettingsQuery', 'useTotalAdCampaignsForUserQuery', 'useStoryTopicQuery',
  'useSubscriptionsPaymentFailureQuery', 'PinnedTimelines', 'ExploreSidebar',
  'SidebarUserRecommendations', 'useFetchProductSubscriptionsQuery',
  'TweetResultByRestId', 'ExplorePage', 'UserByScreenName',
  'ProfileSpotlightsQuery', 'useFetchProfileSections_canViewExpandedProfileQuery',
  'UserSuperFollowTweets', 'NotificationsTimeline', 'AuthenticatePeriscope',
  'BookmarkFoldersSlice', 'EditBookmarkFolder', 'fetchPostQuery',
  'useReadableMessagesSnapshotMutation', 'UsersByRestIds',
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GRAPHQL_RESPONSE') {
    if (!captureEnabled) return;
    if (IGNORED_ENDPOINTS.has(msg.endpoint)) return;
    try {
      const tweets = extractTweets(msg.endpoint, msg.data);
      for (const t of tweets) t.source_endpoint = msg.endpoint;
      if (tweets.length > 0) {
        const missingAuthor = tweets.filter(t => !t.author?.username).length;
        const missingText = tweets.filter(t => !t.text).length;
        let warn = '';
        if (missingAuthor > 0) warn += ` | ${missingAuthor} missing username`;
        if (missingText > 0) warn += ` | ${missingText} missing text`;
        console.log(`[xTap] ${msg.endpoint}: ${tweets.length} tweets${warn}`);
        enqueueTweets(tweets);
      }
    } catch (e) {
      console.error(`[xTap] Parse error for ${msg.endpoint}:`, e, '| data keys:', Object.keys(msg.data || {}).join(', '));
    }
    return;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      captureEnabled,
      sessionCount,
      allTimeCount,
      connected: transport !== 'none',
      buffered: buffer.length,
      outputDir,
      debugLogging,
      transport
    });
    return true;
  }

  if (msg.type === 'SET_DEBUG') {
    debugLogging = !!msg.debugLogging;
    chrome.storage.local.set({ debugLogging });
    if (debugLogging) {
      console.log('[xTap] Debug logging enabled');
    } else {
      logBuffer = [];
    }
    sendResponse({ debugLogging });
    return true;
  }

  if (msg.type === 'SET_OUTPUT_DIR') {
    const newDir = msg.outputDir || '';
    if (newDir && transport !== 'none') {
      sendToHost({ type: 'TEST_PATH', outputDir: newDir }).then((resp) => {
        if (transport === 'http' && resp) {
          // HTTP transport returns response directly
          if (resp.ok) {
            outputDir = newDir;
            chrome.storage.local.set({ outputDir });
            sendResponse({ outputDir });
          } else {
            sendResponse({ error: resp.error || 'Cannot write to that directory' });
          }
        } else if (transport === 'native') {
          // Native transport: set up listener for response
          const listener = (nativeResp) => {
            if (nativeResp.type !== 'TEST_PATH') return;
            nativePort.onMessage.removeListener(listener);
            if (nativeResp.ok) {
              outputDir = newDir;
              chrome.storage.local.set({ outputDir });
              sendResponse({ outputDir });
            } else {
              sendResponse({ error: nativeResp.error || 'Cannot write to that directory' });
            }
          };
          if (nativePort) {
            nativePort.onMessage.addListener(listener);
          } else {
            sendResponse({ error: 'No transport available' });
          }
        } else {
          sendResponse({ error: 'No transport available' });
        }
      }).catch((e) => {
        sendResponse({ error: e.message });
      });
    } else {
      outputDir = newDir;
      chrome.storage.local.set({ outputDir });
      sendResponse({ outputDir });
    }
    return true;
  }

  if (msg.type === 'TOGGLE_CAPTURE') {
    captureEnabled = !captureEnabled;
    saveState();
    sendResponse({ captureEnabled });
    return true;
  }
});

// --- Init ---

restoreState().then(async () => {
  updateBadge();
  await initTransport();
  function scheduleNextFlush() {
    const jitter = Math.random() * FLUSH_INTERVAL_MS * 0.5;
    flushTimer = setTimeout(() => { scheduledFlush(); scheduleNextFlush(); }, FLUSH_INTERVAL_MS + jitter);
  }
  scheduleNextFlush();
  console.log('[xTap] Service worker started');
});
