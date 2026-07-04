import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const chromeManifestPath = path.join(root, 'manifest.json');
const firefoxManifestPath = path.join(root, 'manifest.firefox.json');

// Regenerate into a temp file — never overwrite the checked-in manifest,
// otherwise a stale commit can't be detected (it would be silently fixed
// locally while the release zip ships the stale file).
const tmpOut = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'xtap-manifest-')),
  'manifest.firefox.json'
);
execFileSync('node', [path.join(root, 'scripts', 'build-firefox-manifest.js'), tmpOut]);

const generated = fs.readFileSync(tmpOut, 'utf8');
const checkedIn = fs.readFileSync(firefoxManifestPath, 'utf8');

const chrome = JSON.parse(fs.readFileSync(chromeManifestPath, 'utf8'));
const firefox = JSON.parse(checkedIn);

test('checked-in manifest.firefox.json is up to date', () => {
  assert.equal(checkedIn, generated,
    'manifest.firefox.json is stale — run: node scripts/build-firefox-manifest.js');
});

test('Firefox manifest uses background scripts instead of service_worker', () => {
  assert.equal(firefox.manifest_version, 3);
  assert.deepEqual(firefox.background.scripts, ['background.js']);
  assert.equal(firefox.background.type, 'module');
  assert.equal(firefox.background.service_worker, undefined);
});

test('Firefox manifest declares Gecko metadata', () => {
  const gecko = firefox.browser_specific_settings?.gecko;
  assert.ok(gecko);
  assert.equal(gecko.id, 'xtap@mkubicek.dev');
  assert.equal(gecko.strict_min_version, '128.0');
});

test('Firefox manifest preserves permissions from Chrome manifest', () => {
  assert.deepEqual(firefox.permissions, chrome.permissions);
  assert.deepEqual(firefox.host_permissions, chrome.host_permissions);
});

test('manifest permissions stay within stealth allowlist', () => {
  const allowedPermissions = ['alarms', 'nativeMessaging', 'storage'];
  const allowedHosts = ['*://*.twitter.com/*', '*://*.x.com/*', 'http://127.0.0.1/*'];
  for (const manifest of [chrome, firefox]) {
    assert.deepEqual([...manifest.permissions].sort(), allowedPermissions);
    assert.deepEqual([...manifest.host_permissions].sort(), allowedHosts);
    assert.ok(!manifest.permissions.includes('webRequest'));
    assert.ok(!manifest.permissions.includes('tabs'));
    assert.ok(!manifest.permissions.includes('scripting'));
  }
});

test('Firefox manifest version matches Chrome manifest', () => {
  assert.equal(firefox.version, chrome.version);
});

test('Firefox manifest preserves content scripts from Chrome manifest', () => {
  assert.deepEqual(firefox.content_scripts, chrome.content_scripts);
});

test('Chrome manifest does not have browser_specific_settings', () => {
  assert.equal(chrome.browser_specific_settings, undefined);
});
