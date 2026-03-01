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
let verboseLogging = false;
let logBuffer = [];
const isDevMode = !chrome.runtime.getManifest().update_url;
let readyResolve;
const ready = new Promise(r => { readyResolve = r; });

// --- Recent tweets cache (for video download lookup) ---
const MAX_RECENT_TWEETS = 1000;
const recentTweets = new Map();
// tweetId → downloadId for in-progress downloads (so popup can resume polling)
const activeDownloads = new Map();

// --- Transport state ---
// 'http' | 'native' | 'none'
let transport = 'none';
let httpToken = null;
let httpPort = null;

// --- State persistence ---

function seenIdsStorage() {
  return isDevMode ? chrome.storage.session : chrome.storage.local;
}

async function saveState() {
  const seenData = { seenIds: [...seenIds].slice(-MAX_SEEN_IDS) };
  if (isDevMode) {
    await Promise.all([
      chrome.storage.session.set(seenData),
      chrome.storage.local.set({ allTimeCount, captureEnabled }),
    ]);
  } else {
    await chrome.storage.local.set({ ...seenData, allTimeCount, captureEnabled });
  }
}

async function restoreState() {
  const [seenStored, stored] = await Promise.all([
    seenIdsStorage().get(['seenIds']),
    chrome.storage.local.get(['allTimeCount', 'captureEnabled', 'outputDir', 'debugLogging', 'verboseLogging']),
  ]);
  if (seenStored.seenIds) seenIds = new Set(seenStored.seenIds);
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
    port.onDisconnect.addListener(() => finish(null));
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
      chrome.storage.session.set({ lastEvents: traceEvents });
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

    // Article tweets bypass dedup — they enrich a previously captured stub
    if (seenIds.has(tweet.id) && !tweet.is_article) {
      emitTraceEvent({ timestamp: Date.now(), endpoint, tweetId: tweet.id, status: 'DEDUPLICATED', reason: 'seenIds' });
      continue;
    }
    seenIds.add(tweet.id);
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
  saveState();

  if (buffer.length >= BATCH_SIZE) flush();
}

// --- Badge ---

function updateBadge() {
  const text = sessionCount > 0 ? String(sessionCount) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#1D9BF0' });
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
    (async () => {
      await ready;
      verboseLog(msg.endpoint, msg.data);
      if (!captureEnabled) return;
      if (IGNORED_ENDPOINTS.has(msg.endpoint)) {
        if (verboseLogging) console.log(`[xTap:verbose] ${msg.endpoint} (ignored)`);
        return;
      }
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
        }
      } catch (e) {
        console.error(`[xTap] Parse error for ${msg.endpoint}:`, e, '| data keys:', Object.keys(msg.data || {}).join(', '));
        emitTraceEvent({ timestamp: Date.now(), endpoint: msg.endpoint, tweetId: null, status: 'PARSER_ERROR', reason: e.message });
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
        transport
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

chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

restoreState().then(async () => {
  readyResolve();
  updateBadge();
  await initTransport();
  function scheduleNextFlush() {
    const jitter = Math.random() * FLUSH_INTERVAL_MS * 0.5;
    flushTimer = setTimeout(() => { scheduledFlush(); scheduleNextFlush(); }, FLUSH_INTERVAL_MS + jitter);
  }
  scheduleNextFlush();
  console.log(`[xTap] Service worker started (${isDevMode ? 'dev' : 'production'} mode, seenIds in ${isDevMode ? 'session' : 'local'} storage)`);
});
