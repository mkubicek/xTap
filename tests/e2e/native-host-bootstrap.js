#!/usr/bin/env node
/**
 * native-host-bootstrap.js — Setup/teardown for E2E tests.
 *
 * Ensures a daemon auth token exists, starts the HTTP daemon, and
 * verifies the daemon is responding. By default, does NOT install
 * the Chrome native host manifest (the E2E test injects the token
 * via chrome.storage.local, bypassing native messaging entirely).
 *
 * Pass --with-manifest to also install the native host manifest and
 * wrapper for testing the native messaging pipeline. This overwrites
 * the user's real manifest (backed up and restored on teardown).
 *
 * Usage:
 *   node tests/e2e/native-host-bootstrap.js             # default: --setup
 *   node tests/e2e/native-host-bootstrap.js --setup
 *   node tests/e2e/native-host-bootstrap.js --setup --with-manifest
 *   node tests/e2e/native-host-bootstrap.js --teardown
 *   node tests/e2e/native-host-bootstrap.js --verify
 */

import { spawnSync, spawn, execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, unlinkSync, openSync, closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOST_NAME = 'com.xtap.host';
const DAEMON_PORT = parseInt(process.env.XTAP_DAEMON_PORT || '17382', 10);
const XTAP_DIR = join(homedir(), '.xtap');
const SECRET_PATH = join(XTAP_DIR, 'secret');
const PEM_PATH = join(__dirname, 'certs', 'test-extension.pem');
const HOST_PY = join(REPO_ROOT, 'native-host', 'xtap_host.py');
const DAEMON_PY = join(REPO_ROOT, 'native-host', 'xtap_daemon.py');

// E2E-specific paths — avoid clobbering user's real wrapper
const WRAPPER_PATH = join(XTAP_DIR, 'xtap_host_wrapper_e2e.sh');
const PID_FILE = join(XTAP_DIR, 'e2e-daemon.pid');
const DAEMON_LOG = join(XTAP_DIR, 'e2e-daemon.log');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getManifestDir() {
  const os = platform();
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support',
      'Google', 'Chrome', 'NativeMessagingHosts');
  }
  if (os === 'linux') {
    return join(homedir(), '.config', 'google-chrome',
      'NativeMessagingHosts');
  }
  throw new Error(`Unsupported platform: ${os}`);
}

const MANIFEST_PATH = join(getManifestDir(), `${HOST_NAME}.json`);
const BACKUP_PATH = MANIFEST_PATH + '.e2e-backup';

function computeExtensionId() {
  const der = execSync(
    `openssl rsa -in "${PEM_PATH}" -pubout -outform DER 2>/dev/null`,
  );
  const hash = createHash('sha256').update(der).digest('hex');
  const HEX = '0123456789abcdef';
  const ALPHA = 'abcdefghijklmnop';
  return hash
    .slice(0, 32)
    .split('')
    .map((c) => ALPHA[HEX.indexOf(c)])
    .join('');
}

function findPython() {
  const r = spawnSync('which', ['python3']);
  if (r.status !== 0) throw new Error('python3 not found in PATH');
  return r.stdout.toString().trim();
}

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isDaemonUp() {
  try {
    const res = await httpGetJson(`http://127.0.0.1:${DAEMON_PORT}/status`);
    return res && res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await isDaemonUp()) return true;
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function ensureToken() {
  mkdirSync(XTAP_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(SECRET_PATH)) {
    console.log(`  token: reusing ${SECRET_PATH}`);
    return;
  }
  const r = spawnSync('python3', [
    '-c', 'import secrets; print(secrets.token_urlsafe(32))',
  ]);
  if (r.status !== 0) throw new Error('Failed to generate token');
  writeFileSync(SECRET_PATH, r.stdout.toString().trim() + '\n', {
    mode: 0o600,
  });
  console.log(`  token: generated ${SECRET_PATH}`);
}

function installWrapper() {
  const pythonPath = findPython();
  const script = [
    '#!/bin/sh',
    '# xTap E2E test wrapper — generated by native-host-bootstrap.js',
    `exec "${pythonPath}" "${HOST_PY}" "$@"`,
    '',
  ].join('\n');
  writeFileSync(WRAPPER_PATH, script, { mode: 0o755 });
  console.log(`  wrapper: ${WRAPPER_PATH}`);
}

function installManifest(extensionId) {
  mkdirSync(getManifestDir(), { recursive: true });

  // Back up existing manifest (once — don't overwrite a previous backup)
  if (existsSync(MANIFEST_PATH) && !existsSync(BACKUP_PATH)) {
    copyFileSync(MANIFEST_PATH, BACKUP_PATH);
    console.log(`  manifest: backed up existing → ${BACKUP_PATH}`);
  }

  writeFileSync(
    MANIFEST_PATH,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'xTap native messaging host — E2E test configuration',
        path: WRAPPER_PATH,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`  manifest: ${MANIFEST_PATH}`);
}

async function ensureDaemon() {
  if (await isDaemonUp()) {
    console.log(`  daemon: already running on :${DAEMON_PORT}`);
    return false; // we did not start it
  }

  const pythonPath = findPython();
  mkdirSync(XTAP_DIR, { recursive: true });

  const logFd = openSync(DAEMON_LOG, 'a');
  const child = spawn(pythonPath, [DAEMON_PY], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: { ...process.env, XTAP_LOG_LEVEL: 'debug', XTAP_DAEMON_PORT: String(DAEMON_PORT) },
  });
  child.unref();
  closeSync(logFd);

  writeFileSync(PID_FILE, child.pid + '\n');
  console.log(`  daemon: started PID ${child.pid} (log: ${DAEMON_LOG})`);

  if (!(await waitForDaemon())) {
    let tail = '(no log)';
    if (existsSync(DAEMON_LOG)) {
      tail = readFileSync(DAEMON_LOG, 'utf8').split('\n').slice(-10).join('\n');
    }
    throw new Error(`Daemon failed to start within 8 s.\nRecent log:\n${tail}`);
  }
  console.log(`  daemon: ready on :${DAEMON_PORT}`);
  return true; // we started it
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

function verifyManifest(extensionId) {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  }
  const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const origin = `chrome-extension://${extensionId}/`;
  if (!m.allowed_origins?.includes(origin)) {
    throw new Error(`Manifest missing origin ${origin}`);
  }
  console.log(`  manifest: OK`);
}

function verifyNativeHost() {
  // Simulate native messaging protocol: 4-byte LE length + JSON payload
  // Spawn through the installed wrapper (not HOST_PY directly) so we verify
  // the wrapper script, manifest path, and python invocation end-to-end.
  const payload = Buffer.from(JSON.stringify({ type: 'GET_TOKEN' }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);

  if (!existsSync(WRAPPER_PATH)) {
    throw new Error(`Wrapper not found: ${WRAPPER_PATH}`);
  }

  const result = spawnSync(WRAPPER_PATH, [], {
    input: Buffer.concat([header, payload]),
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Native host spawn failed: ${result.error.message}`);
  }

  const out = result.stdout;
  if (!out || out.length < 4) {
    throw new Error(`Native host returned ${out ? out.length : 0} bytes`);
  }

  const len = out.readUInt32LE(0);
  const resp = JSON.parse(out.subarray(4, 4 + len).toString('utf8'));

  if (!resp.ok) throw new Error(`Native host: ${resp.error}`);
  if (resp.port !== DAEMON_PORT) {
    throw new Error(`Port mismatch: ${resp.port} != ${DAEMON_PORT}`);
  }

  console.log(
    `  native host: OK (token ${resp.token.length} chars, port ${resp.port})`,
  );
}

async function verifyDaemon() {
  const res = await httpGetJson(`http://127.0.0.1:${DAEMON_PORT}/status`);
  if (!res.ok) {
    throw new Error(`Daemon /status not ok: ${JSON.stringify(res)}`);
  }
  console.log(`  daemon: OK (v${res.version} on :${DAEMON_PORT})`);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function teardown() {
  console.log('[teardown]');

  // Stop daemon if we started it (PID file present)
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  daemon: stopped PID ${pid}`);
    } catch (e) {
      console.log(`  daemon: PID ${pid} already gone`);
    }
    unlinkSync(PID_FILE);
  }

  // Restore original manifest from backup, or remove test-only manifest
  // (only present if --with-manifest was used during setup)
  if (existsSync(BACKUP_PATH)) {
    copyFileSync(BACKUP_PATH, MANIFEST_PATH);
    unlinkSync(BACKUP_PATH);
    console.log(`  manifest: restored from backup`);
  } else if (existsSync(MANIFEST_PATH)) {
    try {
      const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      if (m.description?.includes('E2E test')) {
        unlinkSync(MANIFEST_PATH);
        console.log(`  manifest: removed test manifest`);
      }
    } catch { /* leave it */ }
  }

  // Remove E2E wrapper (only present if --with-manifest was used)
  if (existsSync(WRAPPER_PATH)) {
    unlinkSync(WRAPPER_PATH);
    console.log(`  wrapper: removed`);
  }

  console.log('[teardown] done');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function setup(withManifest = false) {
  const extensionId = computeExtensionId();
  console.log(`[setup] extension ID: ${extensionId}\n`);

  ensureToken();
  if (withManifest) {
    installWrapper();
    installManifest(extensionId);
  }
  await ensureDaemon();

  console.log('\n[verify]');
  if (withManifest) {
    verifyManifest(extensionId);
    verifyNativeHost();
  }
  await verifyDaemon();

  console.log(`\n[setup] done — daemon ready for E2E tests${withManifest ? ' (native host manifest installed)' : ''}`);
}

async function verify(withManifest = false) {
  const extensionId = computeExtensionId();
  console.log('[verify]');
  if (withManifest) {
    verifyManifest(extensionId);
    verifyNativeHost();
  }
  await verifyDaemon();
  console.log('[verify] all checks passed');
}

const cmd = process.argv[2] || '--setup';
const withManifest = process.argv.includes('--with-manifest');
try {
  if (cmd === '--setup') await setup(withManifest);
  else if (cmd === '--teardown') teardown();
  else if (cmd === '--verify') await verify(withManifest);
  else {
    console.error(`Unknown command: ${cmd}`);
    console.error(
      'Usage: node native-host-bootstrap.js [--setup|--teardown|--verify] [--with-manifest]',
    );
    process.exit(1);
  }
} catch (e) {
  console.error(`\nFATAL: ${e.message}`);
  process.exit(1);
}
