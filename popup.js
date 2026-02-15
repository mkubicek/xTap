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
    const mode = state.transport === 'http' ? ' (HTTP daemon)' : ' (Native host)';
    statusEl.textContent = 'Saving to disk' + mode;
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Not connected';
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
  saveDirBtn.textContent = '...';
  saveDirBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'SET_OUTPUT_DIR', outputDir: dir }, (resp) => {
    saveDirBtn.disabled = false;
    if (resp?.error) {
      saveDirBtn.textContent = 'Error';
      saveDirBtn.classList.add('error');
      outputDirInput.title = resp.error;
    } else {
      saveDirBtn.textContent = 'Saved!';
      saveDirBtn.classList.remove('error');
      outputDirInput.title = '';
    }
    setTimeout(() => { saveDirBtn.textContent = 'Save'; }, 2000);
  });
});

debugToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_DEBUG', debugLogging: debugToggle.checked }, () => {
    refresh();
  });
});

refresh();
