const statusEl = document.getElementById('status');
const sessionEl = document.getElementById('session-count');
const alltimeEl = document.getElementById('alltime-count');
const toggleBtn = document.getElementById('toggle');
const outputDirInput = document.getElementById('output-dir');
const saveDirBtn = document.getElementById('save-dir');
const debugToggle = document.getElementById('debug-toggle');

function render(state) {
  sessionEl.textContent = state.sessionCount.toLocaleString();
  alltimeEl.textContent = state.allTimeCount.toLocaleString();

  if (state.connected) {
    statusEl.textContent = 'Saving to disk';
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Native host not connected';
    statusEl.className = 'status disconnected';
  }

  if (state.captureEnabled) {
    toggleBtn.textContent = 'Pause';
    toggleBtn.className = 'capturing';
  } else {
    toggleBtn.textContent = 'Resume';
    toggleBtn.className = 'paused';
  }

  if (state.outputDir) {
    outputDirInput.value = state.outputDir;
  }

  debugToggle.checked = !!state.debugLogging;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response) render(response);
  });
}

toggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (response) => {
    if (response) refresh();
  });
});

saveDirBtn.addEventListener('click', () => {
  const dir = outputDirInput.value.trim();
  chrome.runtime.sendMessage({ type: 'SET_OUTPUT_DIR', outputDir: dir }, () => {
    saveDirBtn.textContent = 'Saved!';
    setTimeout(() => { saveDirBtn.textContent = 'Save'; }, 1500);
  });
});

debugToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_DEBUG', debugLogging: debugToggle.checked }, () => {
    refresh();
  });
});

refresh();
