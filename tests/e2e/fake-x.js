#!/usr/bin/env node
/**
 * fake-x.js — Tiny HTTPS Fake X replay server for E2E testing.
 *
 * Serves a minimal page that triggers a GraphQL fetch, and returns
 * fixture-backed responses so the real xTap extension captures them.
 *
 * Usage:
 *   node tests/e2e/fake-x.js [--port 4443] [--fixture-dir path]
 *
 * The server generates a self-signed cert on first run (stored in tests/e2e/certs/).
 * Chrome must be launched with --host-resolver-rules="MAP x.com 127.0.0.1"
 * and --ignore-certificate-errors so that https://x.com:<port>/ reaches this server.
 */

import { createServer } from 'node:https';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let port = 4443;
let fixtureDir = join(__dirname, '..', 'fixtures', 'sanitized', 'timeline-basic');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
  if (args[i] === '--fixture-dir' && args[i + 1]) fixtureDir = resolve(args[++i]);
}

// ---------------------------------------------------------------------------
// Self-signed certificate
// ---------------------------------------------------------------------------

const CERT_DIR = join(__dirname, 'certs');
const CERT_PATH = join(CERT_DIR, 'fake-x.crt');
const KEY_PATH = join(CERT_DIR, 'fake-x.key');

function ensureCerts() {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) return;
  mkdirSync(CERT_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 ` +
      `-keyout "${KEY_PATH}" -out "${CERT_PATH}" ` +
      `-days 3650 -nodes -subj "/CN=x.com" ` +
      `-addext "subjectAltName=DNS:x.com,DNS:twitter.com,DNS:*.x.com,DNS:*.twitter.com"`,
  );
}

ensureCerts();

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const fixtureManifest = JSON.parse(
  readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'),
);
const fixturePayload = readFileSync(
  join(fixtureDir, fixtureManifest.files.fixture),
);
const fixtureEndpoint = fixtureManifest.endpoint; // e.g. "HomeTimeline"

// ---------------------------------------------------------------------------
// Minimal HTML page
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Home / X</title></head>
<body>
<div id="react-root">
  <main role="main"><div>Timeline placeholder</div></main>
</div>
<script>
// Issue a GraphQL fetch that the real xTap extension will intercept.
// The URL shape must contain /i/api/graphql/ so content-main.js picks it up.
fetch('/i/api/graphql/FakeReplayHash/${fixtureEndpoint}?variables=%7B%7D&features=%7B%7D', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-twitter-active-user': 'yes' },
  body: JSON.stringify({ variables: {}, features: {} })
})
  .then(function(r) { return r.json(); })
  .then(function() { document.title = 'xTap:loaded'; })
  .catch(function(e) { document.title = 'xTap:error'; console.error('[fake-x]', e); });
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTPS server
// ---------------------------------------------------------------------------

const server = createServer(
  { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) },
  (req, res) => {
    const url = req.url || '/';

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': '*',
      });
      res.end();
      return;
    }

    // GraphQL fixture replay
    if (url.includes('/i/api/graphql/')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(fixturePayload);
      return;
    }

    // Everything else: serve the minimal page
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  },
);

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-x] HTTPS server listening on https://127.0.0.1:${port}`);
  console.log(`[fake-x] Fixture: ${fixtureManifest.scenario} (${fixtureManifest.tweet_count} tweets, endpoint: ${fixtureEndpoint})`);
  console.log(`[fake-x] Launch Chrome with:`);
  console.log(`  --host-resolver-rules="MAP x.com 127.0.0.1" --ignore-certificate-errors`);
  console.log(`  Then navigate to https://x.com:${port}/`);

  // Signal readiness for programmatic consumers
  if (process.send) process.send({ type: 'ready', port });
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
