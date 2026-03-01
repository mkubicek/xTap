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

function refreshHealth() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    if (!resp) return;
    hTransport.textContent = resp.transport || 'none';
    hStatus.textContent = resp.connected ? 'Connected' : 'Disconnected';
    hStatus.className = resp.connected ? 'status-connected' : 'status-disconnected';
    hCapture.textContent = resp.captureEnabled ? 'Enabled' : 'Paused';
    hSession.textContent = resp.sessionCount.toLocaleString();
    hAlltime.textContent = resp.allTimeCount.toLocaleString();
    hBuffer.textContent = resp.buffered;
    debugToggle.checked = !!resp.debugLogging;
    verboseToggle.checked = !!resp.verboseLogging;
  });
}

refreshHealth();
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
  tr.innerHTML = `
    <td>${formatTime(ev.timestamp)}</td>
    <td>${ev.endpoint}</td>
    <td>${ev.tweetId || '—'}</td>
    <td class="status-${ev.status}">${ev.status}</td>
    <td>${ev.reason || ''}</td>
  `;
  eventsBody.appendChild(tr);
  renderedCount++;
  if (autoScrollCheckbox.checked) {
    eventsWrap.scrollTop = eventsWrap.scrollHeight;
  }
}

// Load initial events
chrome.storage.session.get(['lastEvents'], (result) => {
  if (result.lastEvents) renderEvents(result.lastEvents);
});

// Live updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.lastEvents) {
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
  chrome.storage.session.set({ lastEvents: [] });
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
