// xTap — Service Worker (background)
import { extractTweets } from './lib/tweet-parser.js';
import { dedupTweet } from './lib/dedup.js';

const NATIVE_HOST = 'com.xtap.host';
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_SEEN_IDS = 50_000;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_BUFFER_SIZE = 2000;

let captureEnabled = true;
let buffer = [];
let flushTimer = null;
let seenIds = new Set();
let sessionCount = 0;
let allTimeCount = 0;
let outputDir = '';
let debugLogging = false;
let verboseLogging = false;
let logBuffer = [];
const isDevMode = !chrome.runtime.getManifest().update_url;
const hasSessionStorage = !!chrome.storage.session;
const traceStorage = chrome.storage.session || chrome.storage.local;
let stageSeq = 0;
let _saveChain = Promise.resolve();
let readyResolve;
const ready = new Promise(r => { readyResolve = r; });

// --- Recent tweets cache (for video download lookup) ---
const MAX_RECENT_TWEETS = 1000;
const recentTweets = new Map();
// tweetId → downloadId for in-progress downloads (so popup can resume polling)
const activeDownloads = new Map();

// --- Transport state ---
// 'http' | 'none'
let transport = 'none';
let httpToken = null;
let httpPort = null;

// --- State persistence ---

function seenIdsStorage() {
  return (isDevMode && hasSessionStorage) ? chrome.storage.session : chrome.storage.local;
}

// Staging uses session whenever available (ephemeral — cleared on browser restart).
// seenIdsStorage() uses session only in dev mode. In production, seenIds goes to
// local for persistence while WAL entries stay in session (they only need to survive
// SW suspension, not browser restart). Firefox without session falls back to local.
function stagingStorage() {
  return hasSessionStorage ? chrome.storage.session : chrome.storage.local;
}

async function stagePayload(endpoint, data) {
  const key = `stg_${Date.now()}_${stageSeq++}`;
  try {
    await stagingStorage().set({ [key]: { endpoint, data, stagedAt: Date.now() } });
    return key;
  } catch (e) {
    console.warn('[xTap] Failed to stage payload (quota?):', e.message);
    emitTraceEvent({ timestamp: Date.now(), endpoint, tweetId: null, status: 'STAGE_FAILED', reason: e.message });
    return null;
  }
}

async function clearStagedPayload(key) {
  if (!key) return;
  try {
    await stagingStorage().remove(key);
  } catch (e) {
    console.warn('[xTap] Failed to clear staged payload:', e.message);
  }
}

async function recoverStagedPayloads() {
  let store;
  try {
    store = await stagingStorage().get(null);
  } catch (e) {
    console.warn('[xTap] Failed to read staging storage for recovery:', e.message);
    return;
  }
  const keys = Object.keys(store).filter(k => k.startsWith('stg_')).sort((a, b) => {
    const [, tsA, seqA] = a.split('_');
    const [, tsB, seqB] = b.split('_');
    return (tsA - tsB) || (seqA - seqB);
  });
  if (keys.length === 0) return;

  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  let recoveredCount = 0;

  for (const key of keys) {
    const entry = store[key];
    let produced = false;
    try {
      if (!entry || !entry.data || (entry.stagedAt && now - entry.stagedAt > TTL)) {
        await clearStagedPayload(key);
        continue;
      }
      const tweets = extractTweets(entry.endpoint, entry.data);
      for (const t of tweets) t.source_endpoint = entry.endpoint;
      if (tweets.length > 0) {
        enqueueTweets(tweets, entry.endpoint);
        recoveredCount += tweets.length;
        produced = true;
      }
    } catch (e) {
      console.warn(`[xTap] Recovery parse error for ${key}:`, e.message);
    }
    // Persist buffer before clearing WAL entry — if SW dies mid-recovery,
    // already-cleared entries must have their tweets in durable storage.
    // If saveState fails, keep the WAL entry for retry on next startup.
    if (produced && !(await saveState())) continue;
    await clearStagedPayload(key);
  }

  if (recoveredCount > 0) {
    emitTraceEvent({ timestamp: Date.now(), endpoint: 'recovery', tweetId: null, status: 'RECOVERY_COMPLETE', reason: `recovered ${recoveredCount} tweets from ${keys.length} staged payloads` });
    console.log(`[xTap] Recovery: ${recoveredCount} tweets from ${keys.length} staged payloads`);
  }
}

// Serialized via _saveChain so concurrent callers can't interleave writes
// (back-to-back handlers would otherwise race, and an earlier snapshot could
// land after a later one, rolling back buffered tweets).  Returns true on
// success, false on storage error — callers gate WAL clears on this.
function saveState() {
  const p = _saveChain.then(() => _saveStateImpl());
  _saveChain = p.catch(() => {});
  return p;
}

async function _saveStateImpl() {
  // seenIds and tweetBuffer are coupled in one write so a quota failure
  // loses both rather than persisting seenIds without the buffer (which
  // would create ghost-dedup entries that permanently block those tweets).
  const seenArr = [...seenIds].slice(-MAX_SEEN_IDS);
  try {
    if (isDevMode && hasSessionStorage) {
      await Promise.all([
        chrome.storage.session.set({ seenIds: seenArr, tweetBuffer: buffer }),
        chrome.storage.local.set({ allTimeCount, captureEnabled }),
      ]);
    } else {
      await chrome.storage.local.set({ seenIds: seenArr, tweetBuffer: buffer, allTimeCount, captureEnabled });
    }
    return true;
  } catch (e) {
    console.warn('[xTap] Failed to persist state:', e.message);
    return false;
  }
}

async function restoreState() {
  const [seenStored, stored] = await Promise.all([
    seenIdsStorage().get(['seenIds', 'tweetBuffer']),
    chrome.storage.local.get(['allTimeCount', 'captureEnabled', 'outputDir', 'debugLogging', 'verboseLogging']),
  ]);
  if (seenStored.seenIds) seenIds = new Set(seenStored.seenIds.filter(Boolean));
  if (Array.isArray(seenStored.tweetBuffer)) buffer = seenStored.tweetBuffer;
  if (typeof stored.allTimeCount === 'number') allTimeCount = stored.allTimeCount;
  if (typeof stored.captureEnabled === 'boolean') captureEnabled = stored.captureEnabled;
  if (typeof stored.outputDir === 'string') outputDir = stored.outputDir;
  if (typeof stored.debugLogging === 'boolean') debugLogging = stored.debugLogging;
  if (typeof stored.verboseLogging === 'boolean') verboseLogging = stored.verboseLogging;
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

// AbortSignal.timeout may not exist in all MV3 runtimes (e.g. older Firefox)
function makeTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms); // timer self-clears when SW terminates
  return controller.signal;
}

async function probeHttp(port, token) {
  try {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(`http://127.0.0.1:${port}/status`, {
      headers,
      signal: makeTimeoutSignal(3000)
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
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
      resolve(value);
    }
    const timer = setTimeout(() => finish(null), 5000);
    port.onMessage.addListener((msg) => {
      if (msg.ok && msg.token) {
        finish({ token: msg.token, port: msg.port });
      } else {
        finish(null);
      }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[xTap] Native host disconnected:', err.message);
      finish(null);
    });
    try {
      port.postMessage({ type: 'GET_TOKEN' });
    } catch {
      finish(null);
    }
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

  // 3. No transport available
  transport = 'none';
  console.warn('[xTap] No transport available — daemon may not be running');
  updateTransportBadge();
}

// --- Unified send ---

async function sendToHost(msg) {
  if (transport !== 'http') {
    console.warn('[xTap] No transport available, message dropped');
    return null;
  }

  let path, body;
  if (msg.type === 'TEST_PATH') {
    path = '/test-path';
    body = { outputDir: msg.outputDir };
  } else if (msg.type === 'LOG') {
    path = '/log';
    body = { lines: msg.lines };
    if (msg.outputDir) body.outputDir = msg.outputDir;
  } else if (msg.type === 'DUMP') {
    path = '/dump';
    body = { filename: msg.filename, content: msg.content };
    if (msg.outputDir) body.outputDir = msg.outputDir;
  } else if (msg.type === 'CHECK_YTDLP') {
    path = '/check-ytdlp';
    body = {};
  } else if (msg.type === 'DOWNLOAD_VIDEO') {
    path = '/download-video';
    body = { tweetUrl: msg.tweetUrl, directUrl: msg.directUrl, postDate: msg.postDate };
    if (msg.outputDir) body.outputDir = msg.outputDir;
  } else if (msg.type === 'DOWNLOAD_STATUS') {
    path = '/download-status';
    body = { downloadId: msg.downloadId };
  } else {
    path = '/tweets';
    body = { tweets: msg.tweets };
    if (msg.outputDir) body.outputDir = msg.outputDir;
  }

  try {
    return await httpFetch('POST', path, body);
  } catch (e) {
    console.error('[xTap] HTTP send failed:', e.message);
    transport = 'none';
    updateTransportBadge();
    return null;
  }
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

let lastReprobe = 0;
const REPROBE_COOLDOWN_MS = 30_000;

async function reprobeTransport() {
  const now = Date.now();
  if (now - lastReprobe < REPROBE_COOLDOWN_MS) return false;
  lastReprobe = now;
  console.log('[xTap] Re-probing HTTP daemon...');
  // Try cached credentials first (fast path)
  if (httpToken && httpPort) {
    const alive = await probeHttp(httpPort, httpToken);
    if (alive) {
      transport = 'http';
      updateBadge();
      console.log('[xTap] HTTP daemon recovered (cached token)');
      return true;
    }
  }
  // Try getting a fresh token via native host
  const result = await getTokenViaNative();
  if (result) {
    const alive = await probeHttp(result.port, result.token);
    if (alive) {
      httpToken = result.token;
      httpPort = result.port;
      transport = 'http';
      await chrome.storage.local.set({ httpToken, httpPort });
      updateBadge();
      console.log('[xTap] HTTP daemon recovered (fresh token)');
      return true;
    }
  }
  // Fallback: check chrome.storage.local (token may have been written by
  // a prior session or injected externally for testing)
  const stored = await chrome.storage.local.get(['httpToken', 'httpPort']);
  if (stored.httpToken && stored.httpPort) {
    const alive = await probeHttp(stored.httpPort, stored.httpToken);
    if (alive) {
      httpToken = stored.httpToken;
      httpPort = stored.httpPort;
      transport = 'http';
      updateBadge();
      console.log('[xTap] HTTP daemon recovered (stored token)');
      return true;
    }
  }
  return false;
}

async function flush() {
  if (buffer.length === 0 && logBuffer.length === 0) return;

  if (transport === 'none') {
    if (!(await reprobeTransport())) return;
  }

  if (buffer.length > 0) {
    const batch = buffer.splice(0);
    const message = { tweets: batch };
    if (outputDir) message.outputDir = outputDir;

    try {
      const resp = await sendToHost(message);
      if (!resp || !resp.ok) {
        console.error('[xTap] Host rejected tweets:', resp?.error || 'no response');
        buffer.unshift(...batch);
        await saveState();
      } else {
        await saveState();
      }
    } catch (e) {
      console.error('[xTap] Send failed, buffering tweets back:', e);
      buffer.unshift(...batch);
      await saveState();
    }
  }

  if (debugLogging) await flushLogs();
}

// --- Trace events ---

const MAX_TRACE_EVENTS = 50;
let traceEvents = [];
let traceFlushTimer = null;

function emitTraceEvent(event) {
  traceEvents.push(event);
  if (traceEvents.length > MAX_TRACE_EVENTS) {
    traceEvents = traceEvents.slice(-MAX_TRACE_EVENTS);
  }
  if (!traceFlushTimer) {
    traceFlushTimer = setTimeout(() => {
      traceFlushTimer = null;
      traceStorage.set({ lastEvents: traceEvents });
    }, 500);
  }
}

function enqueueTweets(tweets, endpoint = 'unknown') {
  let newCount = 0;
  for (const tweet of tweets) {
    // Always cache for video lookup (even dupes — updates with latest data)
    if (tweet.id) {
      recentTweets.set(tweet.id, tweet);
      // FIFO eviction
      if (recentTweets.size > MAX_RECENT_TWEETS) {
        const oldest = recentTweets.keys().next().value;
        recentTweets.delete(oldest);
      }
    }

    if (!dedupTweet(tweet, seenIds)) {
      emitTraceEvent({ timestamp: Date.now(), endpoint, tweetId: tweet.id, status: 'DEDUPLICATED', reason: 'seenIds' });
      continue;
    }
    buffer.push(tweet);
    newCount++;
    emitTraceEvent({ timestamp: Date.now(), endpoint, tweetId: tweet.id, status: 'ACCEPTED', reason: null });
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

  if (buffer.length > MAX_BUFFER_SIZE) {
    const overflow = buffer.length - MAX_BUFFER_SIZE;
    buffer.splice(0, overflow);
    console.warn(`[xTap] Buffer overflow: dropped ${overflow} oldest tweets (cap: ${MAX_BUFFER_SIZE})`);
    emitTraceEvent({ timestamp: Date.now(), endpoint, tweetId: null, status: 'BUFFER_OVERFLOW', reason: `dropped ${overflow}` });
  }
}

// --- Badge ---

function updateBadge() {
  if (transport === 'none') return; // don't overwrite error badge
  const text = sessionCount > 0 ? String(sessionCount) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#1D9BF0' });
}

function updateTransportBadge() {
  if (transport === 'none') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#E0245E' });
  }
}

// --- Verbose logging (discovery mode) ---

function summarizeShape(obj, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth) return typeof obj === 'object' && obj !== null ? (Array.isArray(obj) ? '[…]' : '{…}') : typeof obj;
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${obj.length}× ${summarizeShape(obj[0], depth + 1, maxDepth)}]`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const entries = keys.slice(0, 12).map(k => `${k}: ${summarizeShape(obj[k], depth + 1, maxDepth)}`);
    if (keys.length > 12) entries.push(`…+${keys.length - 12} more`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof obj === 'string') return obj.length > 80 ? `str(${obj.length})` : JSON.stringify(obj);
  return String(obj);
}

function verboseLog(endpoint, data) {
  if (!verboseLogging) return;
  const shape = summarizeShape(data);
  console.log(`[xTap:verbose] ${endpoint} response shape: ${shape}`);

  // Dump full JSON to file for reverse engineering.
  // Configure via console:
  //   chrome.storage.local.set({verboseDumpIds: ['1234567890']})   — dump responses containing these IDs
  //   chrome.storage.local.set({verboseDumpEndpoint: 'TweetDetail'}) — dump all responses for this endpoint
  // Dumps are written to <outputDir>/dump-<endpoint>-<timestamp>.json
  chrome.storage.local.get(['verboseDumpIds', 'verboseDumpEndpoint'], (cfg) => {
    let shouldDump = false;
    let reason = '';

    if (cfg.verboseDumpEndpoint === endpoint) {
      shouldDump = true;
      reason = `endpoint=${endpoint}`;
    }
    if (!shouldDump && cfg.verboseDumpIds?.length) {
      const json = JSON.stringify(data);
      for (const id of cfg.verboseDumpIds) {
        if (json.includes(id)) {
          shouldDump = true;
          reason = `id=${id}`;
          break;
        }
      }
    }

    if (shouldDump) {
      const ts = Date.now();
      const filename = `dump-${endpoint}-${ts}.json`;
      const content = JSON.stringify(data, null, 2);
      sendToHost({ type: 'DUMP', filename, content, outputDir: outputDir || undefined });
      console.log(`[xTap:dump] ${endpoint} (${reason}) → ${filename} (${content.length} chars)`);
    }
  });
}

// --- Message handling ---

// Endpoints that use /i/api/graphql/ but never contain tweets
const IGNORED_ENDPOINTS = new Set([
  'DataSaverMode', 'getAltTextPromptPreference', 'useDirectCallSetupQuery',
  'XChatDmSettingsQuery', 'useTotalAdCampaignsForUserQuery', 'useStoryTopicQuery',
  'useSubscriptionsPaymentFailureQuery', 'PinnedTimelines', 'ExploreSidebar',
  'SidebarUserRecommendations', 'useFetchProductSubscriptionsQuery',
  'ExplorePage', 'UserByScreenName',
  'ProfileSpotlightsQuery', 'useFetchProfileSections_canViewExpandedProfileQuery',
  'UserSuperFollowTweets', 'NotificationsTimeline', 'AuthenticatePeriscope',
  'BookmarkFoldersSlice', 'EditBookmarkFolder', 'fetchPostQuery',
  'useReadableMessagesSnapshotMutation', 'UsersByRestIds',
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GRAPHQL_RESPONSE') {
    if (IGNORED_ENDPOINTS.has(msg.endpoint)) return;
    (async () => {
      await ready;
      verboseLog(msg.endpoint, msg.data);
      if (!captureEnabled) return;
      // Stage after ready + captureEnabled so we never WAL payloads that
      // arrived while capture was off, and recovery can replay unconditionally.
      // Staging after ready also means recovery completes before any handler
      // can stage — no concurrent-mutation race.
      const stageKey = await stagePayload(msg.endpoint, msg.data);
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
          enqueueTweets(tweets, msg.endpoint);
          // Only clear WAL after state is durably persisted — if saveState
          // fails, the WAL entry stays for recovery on next startup.
          if (await saveState()) await clearStagedPayload(stageKey);
        } else {
          await clearStagedPayload(stageKey);
        }
        // Flush after WAL commit so buffer.splice in flush() can't race with
        // the persist-then-clear sequence above.
        if (buffer.length >= BATCH_SIZE) flush();
      } catch (e) {
        console.error(`[xTap] Parse error for ${msg.endpoint}:`, e, '| data keys:', Object.keys(msg.data || {}).join(', '));
        emitTraceEvent({ timestamp: Date.now(), endpoint: msg.endpoint, tweetId: null, status: 'PARSER_ERROR', reason: e.message });
        await clearStagedPayload(stageKey);
      }
    })();
    return;
  }

  if (msg.type === 'GET_STATUS') {
    (async () => {
      await ready;
      sendResponse({
        captureEnabled,
        sessionCount,
        allTimeCount,
        connected: transport !== 'none',
        buffered: buffer.length,
        outputDir,
        debugLogging,
        verboseLogging,
        transport,
        transportError: transport === 'none'
          ? 'Daemon not running. Check ~/.xtap/daemon-stderr.log'
          : null,
      });
    })();
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

  if (msg.type === 'SET_VERBOSE') {
    verboseLogging = !!msg.verboseLogging;
    chrome.storage.local.set({ verboseLogging });
    console.log(`[xTap] Verbose logging ${verboseLogging ? 'enabled' : 'disabled'}`);
    sendResponse({ verboseLogging });
    return true;
  }

  if (msg.type === 'SET_OUTPUT_DIR') {
    const newDir = msg.outputDir || '';
    if (newDir && transport === 'http') {
      sendToHost({ type: 'TEST_PATH', outputDir: newDir }).then((resp) => {
        if (resp?.ok) {
          outputDir = newDir;
          chrome.storage.local.set({ outputDir });
          sendResponse({ outputDir });
        } else {
          sendResponse({ error: resp?.error || 'Cannot write to that directory' });
        }
      }).catch((e) => {
        sendResponse({ error: e.message });
      });
    } else if (newDir && transport === 'none') {
      sendResponse({ error: 'Daemon not running' });
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

  if (msg.type === 'CHECK_VIDEO') {
    const tweet = recentTweets.get(msg.tweetId);
    if (!tweet || !tweet.media || tweet.media.length === 0) {
      sendResponse({ hasVideo: false });
      return true;
    }
    const videoMedia = tweet.media.find(m => m.type === 'video' || m.type === 'animated_gif');
    if (!videoMedia) {
      sendResponse({ hasVideo: false });
      return true;
    }
    sendResponse({
      hasVideo: true,
      tweetUrl: tweet.url || `https://x.com/i/status/${msg.tweetId}`,
      directUrl: videoMedia.url || null,
      mediaType: videoMedia.type,
      durationMs: videoMedia.duration_ms || null,
      postDate: tweet.created_at || null,
      activeDownloadId: activeDownloads.get(msg.tweetId) || null,
    });
    return true;
  }

  if (msg.type === 'CHECK_YTDLP') {
    (async () => {
      try {
        const resp = await sendToHost({ type: 'CHECK_YTDLP' });
        sendResponse(resp || { ok: false, error: 'No transport' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_VIDEO') {
    (async () => {
      try {
        const resp = await sendToHost({
          type: 'DOWNLOAD_VIDEO',
          tweetUrl: msg.tweetUrl,
          directUrl: msg.directUrl,
          postDate: msg.postDate,
          outputDir: outputDir || undefined,
        });
        // Track active download so popup can resume polling after close/reopen
        if (resp?.ok && resp.downloadId && msg.tweetId) {
          activeDownloads.set(msg.tweetId, resp.downloadId);
        }
        sendResponse(resp || { ok: false, error: 'No transport' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_STATUS') {
    (async () => {
      try {
        const resp = await sendToHost({
          type: 'DOWNLOAD_STATUS',
          downloadId: msg.downloadId,
        });
        // Clean up finished downloads from active map
        if (resp?.status === 'done' || resp?.status === 'error') {
          for (const [tid, did] of activeDownloads) {
            if (did === msg.downloadId) { activeDownloads.delete(tid); break; }
          }
        }
        sendResponse(resp || { ok: false, error: 'No transport' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// --- Init ---

if (typeof chrome.storage.session?.setAccessLevel === 'function') {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
}

// Graceful degradation: if restoreState fails (e.g. storage unavailable), continue
// with defaults so the extension still captures tweets.
restoreState().catch((e) => {
  console.error('[xTap] Failed to restore state:', e);
}).then(async () => {
  await recoverStagedPayloads();
  readyResolve();
  updateBadge();
  await initTransport();
  function scheduleNextFlush() {
    const jitter = Math.random() * FLUSH_INTERVAL_MS * 0.5;
    flushTimer = setTimeout(() => { scheduledFlush(); scheduleNextFlush(); }, FLUSH_INTERVAL_MS + jitter);
  }
  scheduleNextFlush();
  const seenStorageLabel = (isDevMode && hasSessionStorage) ? 'session' : 'local';
  console.log(`[xTap] Service worker started (${isDevMode ? 'dev' : 'production'} mode, seenIds in ${seenStorageLabel} storage)`);
});
