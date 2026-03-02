import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, '../manifest.firefox.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('Firefox manifest uses background scripts mode', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background);
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.background.service_worker, undefined);
});

test('Firefox manifest declares expected Gecko metadata', () => {
  const gecko = manifest.browser_specific_settings?.gecko;
  assert.ok(gecko);
  assert.equal(gecko.id, 'xtap@mkubicek.dev');
  assert.equal(gecko.strict_min_version, '128.0');
});

test('Firefox manifest keeps native messaging and site permissions', () => {
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.host_permissions.includes('*://*.x.com/*'));
  assert.ok(manifest.host_permissions.includes('*://*.twitter.com/*'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));
});
