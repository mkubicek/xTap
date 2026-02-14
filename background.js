// xTap — Service Worker (background)
import { extractTweets } from './lib/tweet-parser.js';

const NATIVE_HOST = 'com.xtap.host';
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_SEEN_IDS = 50_000;

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

// --- Batching & flushing ---

function scheduledFlush() {
  if (buffer.length > 0 || logBuffer.length > 0) flush();
}

function flushLogs() {
  if (logBuffer.length === 0 || !nativePort) return;
  const lines = logBuffer.splice(0);
  try {
    const message = { type: 'LOG', lines };
    if (outputDir) message.outputDir = outputDir;
    nativePort.postMessage(message);
  } catch (e) {
    _origError('[xTap] Log send failed:', e);
  }
}

function flush() {
  if (buffer.length === 0 && logBuffer.length === 0) return;

  if (!nativePort) connectNative();

  if (buffer.length > 0 && nativePort) {
    const batch = buffer.splice(0);
    try {
      const message = { tweets: batch };
      if (outputDir) message.outputDir = outputDir;
      nativePort.postMessage(message);
    } catch (e) {
      console.error('[xTap] Send failed, buffering tweets back:', e);
      buffer.unshift(...batch);
      nativePort = null;
    }
  } else if (buffer.length > 0) {
    console.warn('[xTap] No native host connection, tweets buffered:', buffer.length);
  }

  if (debugLogging) flushLogs();
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
      connected: nativePort !== null,
      buffered: buffer.length,
      outputDir,
      debugLogging
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
    if (newDir && nativePort) {
      // Ask native host to test-write before accepting
      const listener = (resp) => {
        if (resp.type !== 'TEST_PATH') return;
        nativePort.onMessage.removeListener(listener);
        if (resp.ok) {
          outputDir = newDir;
          chrome.storage.local.set({ outputDir });
          sendResponse({ outputDir });
        } else {
          sendResponse({ error: resp.error || 'Cannot write to that directory' });
        }
      };
      nativePort.onMessage.addListener(listener);
      nativePort.postMessage({ type: 'TEST_PATH', outputDir: newDir });
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

restoreState().then(() => {
  updateBadge();
  connectNative();
  function scheduleNextFlush() {
    const jitter = Math.random() * FLUSH_INTERVAL_MS * 0.5;
    flushTimer = setTimeout(() => { scheduledFlush(); scheduleNextFlush(); }, FLUSH_INTERVAL_MS + jitter);
  }
  scheduleNextFlush();
  console.log('[xTap] Service worker started');
});
