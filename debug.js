import { extractTweets } from './lib/tweet-parser.js';

// --- Health polling ---

const hTransport = document.getElementById('h-transport');
const hStatus = document.getElementById('h-status');
const hCapture = document.getElementById('h-capture');
const hSession = document.getElementById('h-session');
const hAlltime = document.getElementById('h-alltime');
const hBuffer = document.getElementById('h-buffer');
const debugToggle = document.getElementById('debug-toggle');
const verboseToggle = document.getElementById('verbose-toggle');

let _daemonToken = null;
let _daemonPort = 17381;
let _outputDir = '';

function refreshHealth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (!resp) { resolve(); return; }
      hTransport.textContent = resp.transport || 'none';
      hStatus.textContent = resp.connected ? 'Connected' : 'Disconnected';
      hStatus.className = resp.connected ? 'status-connected' : 'status-disconnected';
      hCapture.textContent = resp.captureEnabled ? 'Enabled' : 'Paused';
      hSession.textContent = resp.sessionCount.toLocaleString();
      hAlltime.textContent = resp.allTimeCount.toLocaleString();
      hBuffer.textContent = resp.buffered;
      debugToggle.checked = !!resp.debugLogging;
      verboseToggle.checked = !!resp.verboseLogging;
      if (resp.httpToken) _daemonToken = resp.httpToken;
      if (resp.httpPort) _daemonPort = resp.httpPort;
      if (resp.outputDir) _outputDir = resp.outputDir;
      resolve();
    });
  });
}

refreshHealth().then(() => loadViewer());
setInterval(refreshHealth, 5000);

debugToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_DEBUG', debugLogging: debugToggle.checked }, () => {
    refreshHealth();
  });
});

verboseToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_VERBOSE', verboseLogging: verboseToggle.checked }, () => {
    refreshHealth();
  });
});

// --- Capture events ---

const eventsBody = document.getElementById('events-body');
const autoScrollCheckbox = document.getElementById('auto-scroll');
const clearBtn = document.getElementById('clear-events');
const eventsWrap = document.querySelector('.events-wrap');
const traceStorage = chrome.storage.session || chrome.storage.local;
const traceArea = chrome.storage.session ? 'session' : 'local';

let renderedCount = 0;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function renderEvents(events) {
  eventsBody.innerHTML = '';
  renderedCount = 0;
  for (const ev of events) {
    appendEventRow(ev);
  }
}

function appendEventRow(ev) {
  const tr = document.createElement('tr');
  const cells = [formatTime(ev.timestamp), ev.endpoint, ev.tweetId || '—', ev.status, ev.reason || ''];
  for (const text of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  }
  tr.children[3].className = `status-${ev.status}`;
  eventsBody.appendChild(tr);
  renderedCount++;
  if (autoScrollCheckbox.checked) {
    eventsWrap.scrollTop = eventsWrap.scrollHeight;
  }
}

// Load initial events
traceStorage.get(['lastEvents'], (result) => {
  if (result.lastEvents) renderEvents(result.lastEvents);
});

// Live updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === traceArea && changes.lastEvents) {
    const events = changes.lastEvents.newValue || [];
    // Re-render if the new batch has fewer (was trimmed) or is a fresh set
    if (events.length <= renderedCount || events.length === 0) {
      renderEvents(events);
    } else {
      // Append only new events
      const newEvents = events.slice(renderedCount);
      for (const ev of newEvents) {
        appendEventRow(ev);
      }
    }
  }
});

clearBtn.addEventListener('click', () => {
  eventsBody.innerHTML = '';
  renderedCount = 0;
  traceStorage.set({ lastEvents: [] });
});

// --- Tweet Viewer ---

const viewerPanel = document.getElementById('viewer-panel');
const viewerUnavailable = document.getElementById('viewer-unavailable');
const viewerContent = document.getElementById('viewer-content');
const viewerStats = document.getElementById('viewer-stats');
const viewerSearch = document.getElementById('viewer-search');
const viewerDate = document.getElementById('viewer-date');
const viewerAuthor = document.getElementById('viewer-author');
const authorDropdown = document.getElementById('author-dropdown');
const viewerRefresh = document.getElementById('viewer-refresh');
const viewerExport = document.getElementById('viewer-export');
const viewerResults = document.getElementById('viewer-results');
const viewerPagination = document.getElementById('viewer-pagination');

const VIEWER_LIMIT = 100;
let viewerOffset = 0;
let allAuthors = [];
let selectedAuthor = '';

async function daemonFetch(path) {
  let token = _daemonToken;
  let port = _daemonPort;
  if (!token) {
    // Fallback: check storage directly
    const cached = await chrome.storage.local.get(['httpToken', 'httpPort']);
    token = cached.httpToken;
    port = cached.httpPort || 17381;
  }
  if (!token) throw new Error('No daemon token available');
  // Append outputDir if configured
  if (_outputDir && path.includes('?')) {
    path += `&outputDir=${encodeURIComponent(_outputDir)}`;
  } else if (_outputDir) {
    path += `?outputDir=${encodeURIComponent(_outputDir)}`;
  }
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function renderStats(fileStats) {
  const today = new Date().toISOString().slice(0, 10);
  const todayStat = fileStats.find(s => s.date === today);
  const total = fileStats.reduce((sum, s) => sum + s.count, 0);

  viewerStats.innerHTML = '';
  const items = [
    { value: todayStat ? formatCount(todayStat.count) : '0', label: 'Today' },
    { value: formatCount(total), label: 'Total' },
    { value: String(fileStats.length), label: 'Days' },
  ];
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'viewer-stat';
    div.innerHTML = `<div class="stat-value">${item.value}</div><div class="stat-label">${item.label}</div>`;
    viewerStats.appendChild(div);
  }
}

function populateDateDropdown(fileStats) {
  // Keep existing "All dates" option
  viewerDate.innerHTML = '<option value="">All dates</option>';
  for (const s of fileStats) {
    const opt = document.createElement('option');
    opt.value = s.date;
    opt.textContent = `${s.date} (${formatCount(s.count)})`;
    viewerDate.appendChild(opt);
  }
}

function renderTweetCards(tweets) {
  viewerResults.innerHTML = '';
  if (tweets.length === 0) {
    viewerResults.innerHTML = '<div class="viewer-empty">No tweets found.</div>';
    return;
  }
  for (const t of tweets) {
    const card = document.createElement('div');
    card.className = 'tweet-card';

    const author = t.author || {};
    const username = author.username || author.screen_name || '?';
    const capturedTime = relativeTime(t.captured_at);
    const postedTime = relativeTime(t.created_at);
    const timeLabel = [postedTime, capturedTime ? `captured ${capturedTime}` : ''].filter(Boolean).join(' · ');
    const endpoint = t.endpoint || '';
    const text = t.text || t.full_text || '';
    const isLong = text.length > 280;

    let metricsHtml = '';
    const m = t.metrics || {};
    const metrics = [];
    if (m.likes != null) metrics.push(`\u2665 ${formatCount(m.likes)}`);
    if (m.retweets != null) metrics.push(`\u21bb ${formatCount(m.retweets)}`);
    if (m.replies != null) metrics.push(`\ud83d\udcac ${formatCount(m.replies)}`);
    if (m.views != null) metrics.push(`\ud83d\udc41 ${formatCount(m.views)}`);
    if (metrics.length) metricsHtml = `<div class="tweet-card-metrics">${metrics.join('  ')}</div>`;

    card.innerHTML = `
      <div class="tweet-card-header">
        <span><span class="tweet-card-author">@${username}</span> <span class="tweet-card-time">${timeLabel}</span></span>
        ${endpoint ? `<span class="tweet-card-endpoint">${endpoint}</span>` : ''}
      </div>
      <div class="tweet-card-text${isLong ? ' truncated' : ''}">${escapeHtml(text)}</div>
      ${metricsHtml}
    `;
    if (isLong) {
      card.querySelector('.tweet-card-text').addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('expanded');
      });
    }
    viewerResults.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderPagination(offset, limit, totalMatched) {
  viewerPagination.innerHTML = '';
  if (totalMatched === 0) return;

  const from = offset + 1;
  const to = Math.min(offset + limit, totalMatched);
  const info = document.createElement('span');
  info.textContent = `Showing ${from}-${to} of ${totalMatched}`;
  viewerPagination.appendChild(info);

  if (offset > 0) {
    const prev = document.createElement('button');
    prev.className = 'small-btn';
    prev.textContent = 'Prev';
    prev.addEventListener('click', () => {
      viewerOffset = Math.max(0, offset - limit);
      searchTweets();
    });
    viewerPagination.appendChild(prev);
  }

  if (to < totalMatched) {
    const next = document.createElement('button');
    next.className = 'small-btn';
    next.textContent = 'Next';
    next.addEventListener('click', () => {
      viewerOffset = offset + limit;
      searchTweets();
    });
    viewerPagination.appendChild(next);
  }
}

async function searchTweets() {
  const q = viewerSearch.value.trim();
  const date = viewerDate.value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (date) params.set('date', date);
  if (selectedAuthor) params.set('author', selectedAuthor);
  params.set('offset', viewerOffset);
  params.set('limit', VIEWER_LIMIT);

  try {
    const data = await daemonFetch(`/tweets?${params}`);
    renderStats(data.file_stats);
    populateDateDropdown(data.file_stats);
    viewerDate.value = date;
    if (data.authors) {
      allAuthors = data.authors;
    }
    renderTweetCards(data.tweets);
    renderPagination(data.offset, VIEWER_LIMIT, data.total_matched);
  } catch (e) {
    viewerResults.innerHTML = `<div class="viewer-error">Failed to load tweets: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadViewer() {
  // If refreshHealth didn't provide a token, try to obtain one via background
  if (!_daemonToken) {
    try {
      const creds = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_DAEMON_CREDS' }, resolve);
      });
      if (creds?.ok) {
        _daemonToken = creds.token;
        _daemonPort = creds.port;
      }
    } catch { /* ignore */ }
  }
  try {
    const data = await daemonFetch('/tweets?limit=0');
    viewerContent.style.display = '';
    viewerUnavailable.style.display = 'none';
    renderStats(data.file_stats);
    populateDateDropdown(data.file_stats);
    if (data.authors) allAuthors = data.authors;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const hasToday = data.file_stats.some(s => s.date === today);
    if (hasToday) viewerDate.value = today;
    searchTweets();
  } catch (e) {
    console.error('[xTap] Tweet viewer failed:', e);
    viewerContent.style.display = 'none';
    viewerUnavailable.style.display = '';
    viewerUnavailable.textContent = `Tweet viewer error: ${e.message}`;
  }
}

let searchDebounce = null;
viewerSearch.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    viewerOffset = 0;
    searchTweets();
  }, 500);
});

viewerDate.addEventListener('change', () => {
  viewerOffset = 0;
  searchTweets();
});

viewerRefresh.addEventListener('click', () => {
  viewerOffset = 0;
  searchTweets();
});

// Auto-refresh viewer every 15 seconds
setInterval(() => {
  if (viewerContent.style.display !== 'none') searchTweets();
}, 15000);

// --- Author combobox ---

function showAuthorDropdown(filter) {
  const lower = filter.toLowerCase();
  const matches = lower
    ? allAuthors.filter(a => a.toLowerCase().includes(lower))
    : allAuthors;
  authorDropdown.innerHTML = '';
  if (matches.length === 0) {
    authorDropdown.classList.remove('open');
    return;
  }
  for (const name of matches.slice(0, 50)) {
    const div = document.createElement('div');
    div.className = 'author-option';
    div.textContent = `@${name}`;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before click registers
      viewerAuthor.value = `@${name}`;
      selectedAuthor = name;
      authorDropdown.classList.remove('open');
      viewerOffset = 0;
      searchTweets();
    });
    authorDropdown.appendChild(div);
  }
  authorDropdown.classList.add('open');
}

viewerAuthor.addEventListener('focus', () => {
  showAuthorDropdown(viewerAuthor.value.replace(/^@/, ''));
});

viewerAuthor.addEventListener('input', () => {
  const val = viewerAuthor.value.replace(/^@/, '').trim();
  if (!val) {
    selectedAuthor = '';
    authorDropdown.classList.remove('open');
    viewerOffset = 0;
    searchTweets();
    return;
  }
  showAuthorDropdown(val);
});

viewerAuthor.addEventListener('blur', () => {
  // Delay to allow mousedown on option to fire first
  setTimeout(() => authorDropdown.classList.remove('open'), 150);
});

viewerAuthor.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    authorDropdown.classList.remove('open');
    viewerAuthor.blur();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const val = viewerAuthor.value.replace(/^@/, '').trim();
    // If exact match exists, select it
    const match = allAuthors.find(a => a.toLowerCase() === val.toLowerCase());
    if (match) {
      viewerAuthor.value = `@${match}`;
      selectedAuthor = match;
    } else {
      selectedAuthor = val;
    }
    authorDropdown.classList.remove('open');
    viewerOffset = 0;
    searchTweets();
  }
});

viewerExport.addEventListener('click', async () => {
  const q = viewerSearch.value.trim();
  const date = viewerDate.value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (date) params.set('date', date);
  if (selectedAuthor) params.set('author', selectedAuthor);
  params.set('offset', 0);
  params.set('limit', 10000);

  try {
    const data = await daemonFetch(`/tweets?${params}`);
    const lines = data.tweets.map(t => JSON.stringify(t)).join('\n') + '\n';
    const blob = new Blob([lines], { type: 'application/x-jsonlines' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xtap-export${date ? '-' + date : ''}${q ? '-' + q.replace(/\s+/g, '_') : ''}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
});

// --- Parser sandbox ---

const sandboxEndpoint = document.getElementById('sandbox-endpoint');
const sandboxJson = document.getElementById('sandbox-json');
const sandboxRun = document.getElementById('sandbox-run');
const sandboxOutput = document.getElementById('sandbox-output');

sandboxRun.addEventListener('click', () => {
  const endpoint = sandboxEndpoint.value.trim() || 'unknown';
  const raw = sandboxJson.value.trim();
  sandboxOutput.classList.add('visible');
  sandboxOutput.classList.remove('error');

  if (!raw) {
    sandboxOutput.classList.add('error');
    sandboxOutput.textContent = 'Paste JSON above first.';
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    sandboxOutput.classList.add('error');
    sandboxOutput.textContent = `JSON parse error: ${e.message}`;
    return;
  }

  try {
    const tweets = extractTweets(endpoint, data);
    if (tweets.length === 0) {
      sandboxOutput.textContent = 'No tweets extracted.';
    } else {
      sandboxOutput.textContent = `${tweets.length} tweet(s) extracted:\n\n${JSON.stringify(tweets, null, 2)}`;
    }
  } catch (e) {
    sandboxOutput.classList.add('error');
    sandboxOutput.textContent = `Parser error: ${e.message}\n\n${e.stack}`;
  }
});
