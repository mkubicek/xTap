#!/usr/bin/env node
/**
 * golden-jsonl-test.js — End-to-end golden-path JSONL assertion.
 *
 * Runs the full xTap pipeline offline:
 *   Fake X (HTTPS) → real extension → HTTP daemon → JSONL on disk
 *
 * Note: Playwright's bundled Chromium does not support native messaging, so
 * the test injects the daemon HTTP token directly into chrome.storage.local.
 * The extension's reprobeTransport() storage fallback picks it up.
 *
 * Then compares the JSONL output against the expected.jsonl golden files
 * from all discovered fixture scenarios in tests/fixtures/sanitized/.
 *
 * Usage:
 *   node tests/e2e/golden-jsonl-test.js [--headed] [--port 4443]
 *
 * Prerequisites:
 *   - npm install in tests/e2e/
 *   - python3 on PATH
 *   - openssl on PATH (for cert generation)
 */

import { chromium } from 'playwright';
import { fork, execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync,
  readFileSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, '.extension-out');
const EXTENSION_ID = 'mhljdmpppgbddpoijmhjnaaondpidjfn';
const SANITIZED_DIR = join(__dirname, '..', 'fixtures', 'sanitized');
const BOOTSTRAP = join(__dirname, 'native-host-bootstrap.js');
const E2E_DAEMON_PORT = 17382;

// Discover all fixture scenarios
const scenarios = readdirSync(SANITIZED_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(SANITIZED_DIR, d.name, 'manifest.json')))
  .map(d => {
    const dir = join(SANITIZED_DIR, d.name);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return { name: d.name, dir, manifest };
  });

if (scenarios.length === 0) {
  console.error('[golden-jsonl] No fixture scenarios found');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let headed = false;
let port = 4443;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--headed') headed = true;
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) { console.log(`[golden-jsonl] ${msg}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


function buildExtension() {
  log('Building test extension...');
  execSync(`node ${join(__dirname, 'build-test-extension.js')}`, {
    stdio: 'inherit',
  });
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error('Extension build failed — no manifest.json in output');
  }
}

function startFakeX(fxPort, fixtureDir) {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, 'fake-x.js'), ['--port', String(fxPort), '--fixture-dir', fixtureDir], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Fake X server failed to start within 10 s'));
      }
    }, 10_000);

    child.on('message', msg => {
      if (msg.type === 'ready' && !settled) {
        settled = true;
        clearTimeout(timer);
        log(`Fake X ready on :${msg.port}`);
        resolve(child);
      }
    });

    child.on('error', err => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
    child.on('exit', code => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Fake X exited with code ${code}`)); }
    });

    child.stdout?.on('data', d => process.stdout.write(d));
    child.stderr?.on('data', d => process.stderr.write(d));
  });
}

/**
 * Poll a directory for a tweets-*.jsonl file with at least `minLines` records.
 * Returns the array of parsed tweet objects, or null on timeout.
 */
async function pollForJsonl(dir, minLines, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(
        f => f.startsWith('tweets-') && f.endsWith('.jsonl'),
      );
      for (const f of files) {
        try {
          const content = readFileSync(join(dir, f), 'utf8').trim();
          if (!content) continue;
          const lines = content.split('\n');
          if (lines.length >= minLines) {
            const parsed = lines.map(l => JSON.parse(l));
            log(`Found ${lines.length} records in ${f}`);
            return parsed;
          }
        } catch {
          // Partial write — daemon still flushing, retry next poll
        }
      }
    }
    await sleep(1_000);
  }
  return null;
}

/**
 * Stable JSON serialization with recursively sorted keys.
 * Ensures two objects with the same data but different key order compare equal.
 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Compare actual tweet output against expected golden output.
 * Ignores `captured_at` (varies per run). Both arrays sorted by id.
 */
function compareJsonl(actual, expected) {
  const strip = arr =>
    [...arr]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(t => {
        const copy = { ...t };
        delete copy.captured_at;
        return copy;
      });

  const a = strip(actual);
  const e = strip(expected);

  if (a.length !== e.length) {
    return {
      pass: false,
      message: `Record count mismatch: got ${a.length}, expected ${e.length}`,
    };
  }

  const diffs = [];
  for (let i = 0; i < e.length; i++) {
    const aStr = stableStringify(a[i]);
    const eStr = stableStringify(e[i]);
    if (aStr !== eStr) {
      diffs.push({ id: e[i].id, expected: e[i], actual: a[i] });
    }
  }

  if (diffs.length > 0) {
    const first = diffs[0];
    return {
      pass: false,
      message:
        `${diffs.length} tweet(s) differ. First diff at id ${first.id}:\n` +
        `  expected: ${JSON.stringify(first.expected)}\n` +
        `  actual:   ${JSON.stringify(first.actual)}`,
    };
  }

  return { pass: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  // 1. Create an isolated output directory under $HOME (passes daemon validation)
  mkdirSync(join(homedir(), '.xtap'), { recursive: true });
  const outputDir = mkdtempSync(join(homedir(), '.xtap', 'e2e-output-'));
  log(`Output dir: ${outputDir}`);

  // All setup steps live inside try so that teardown runs even if setup
  // fails partway (e.g. Fake X port conflict after bootstrap installed the
  // native host manifest and started the daemon).
  let bootstrapRan = false;
  let fakeX;
  let userDataDir;
  let context;
  let passed = false;
  try {
    // 2. Tell the daemon to use our output dir and E2E port, then bootstrap
    process.env.XTAP_OUTPUT_DIR = outputDir;
    process.env.XTAP_DAEMON_PORT = String(E2E_DAEMON_PORT);
    log('Running native-host bootstrap...');
    bootstrapRan = true;  // set before --setup so teardown runs on partial failure
    execSync(`node "${BOOTSTRAP}" --setup`, { stdio: 'inherit' });

    // 3. Build extension
    buildExtension();

    // 4. Create temp Chrome user-data dir
    userDataDir = mkdtempSync(join(tmpdir(), 'xtap-e2e-'));

    // 5. Launch Chromium with the extension
    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP x.com 127.0.0.1`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
    ];
    if (!headed) launchArgs.push('--headless=new');

    log(`Launching Chromium (${headed ? 'headed' : 'headless'})...`);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: launchArgs,
      ignoreHTTPSErrors: true,
    });
    log('Chromium launched');

    // Listen for service worker console output (debugging transport issues)
    context.on('serviceworker', sw => {
      sw.on('console', msg => {
        const text = msg.text();
        if (text.includes('[xTap]')) log(`SW: ${text}`);
      });
    });
    // Also capture already-registered workers
    for (const sw of context.serviceWorkers()) {
      sw.on('console', msg => {
        const text = msg.text();
        if (text.includes('[xTap]')) log(`SW: ${text}`);
      });
    }

    // 6. Verify extension is loaded and inject HTTP token
    //    Native messaging requires system Chrome manifest paths; Playwright's
    //    bundled Chromium may not find them. Inject the token directly via
    //    chrome.storage.local so the extension can reach the daemon.
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    });
    log('Extension loaded');

    const token = readFileSync(join(homedir(), '.xtap', 'secret'), 'utf8').trim();
    await extPage.evaluate(async ({ token, port }) => {
      await chrome.storage.local.set({ httpToken: token, httpPort: port });
    }, { token, port: E2E_DAEMON_PORT });
    log(`Injected HTTP token into extension storage (port ${E2E_DAEMON_PORT})`);
    await extPage.close();

    // 7. Run each scenario: start Fake X, navigate, poll, compare
    let cumulativeTweets = 0;
    for (const scenario of scenarios) {
      log(`--- Scenario: ${scenario.name} ---`);

      fakeX = await startFakeX(port, scenario.dir);

      const page = await context.newPage();
      await page.goto(`https://x.com:${port}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

      await page.waitForFunction(
        () => document.title === 'xTap:loaded' || document.title === 'xTap:error',
        { timeout: 15_000 },
      );
      const title = await page.title();
      if (title !== 'xTap:loaded') {
        throw new Error(
          `[${scenario.name}] Page title is "${title}" — extension interception failed`,
        );
      }
      log('Extension captured GraphQL response');

      // Poll for JSONL output (flush timer is ~30-45 s)
      const expectedCount = cumulativeTweets + scenario.manifest.tweet_count;
      log(`Waiting for ${expectedCount} cumulative tweets in JSONL output (up to 60 s)...`);

      const actual = await pollForJsonl(outputDir, expectedCount, 60_000);
      if (!actual) {
        const contents = existsSync(outputDir) ? readdirSync(outputDir) : [];
        throw new Error(
          `[${scenario.name}] No JSONL with ${expectedCount}+ records after 60 s. ` +
          `Output dir: [${contents.join(', ')}]`,
        );
      }

      // Compare only this scenario's tweets (slice off previous scenarios)
      const scenarioActual = actual.slice(cumulativeTweets);
      const expectedJsonl = join(scenario.dir, scenario.manifest.files.expected);
      const expectedLines = readFileSync(expectedJsonl, 'utf8').trim().split('\n');
      const expected = expectedLines.map(l => JSON.parse(l));

      const result = compareJsonl(scenarioActual, expected);
      if (!result.pass) {
        throw new Error(`[${scenario.name}] Golden JSONL mismatch: ${result.message}`);
      }

      log(`PASS ${scenario.name} — ${scenarioActual.length} tweets match golden output`);
      cumulativeTweets = actual.length;

      await page.close();
      fakeX.kill('SIGTERM');
      await new Promise(resolve => fakeX.once('exit', resolve));
      fakeX = null;
    }

    passed = true;

  } finally {
    // Cleanup — each step is guarded so later cleanup runs even if earlier fails
    if (context) await context.close().catch(() => {});
    if (fakeX) fakeX.kill('SIGTERM');

    if (bootstrapRan) {
      log('Tearing down native host...');
      try {
        execSync(`node "${BOOTSTRAP}" --teardown`, { stdio: 'inherit' });
      } catch {}
    }

    if (userDataDir) {
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
  }

  return passed;
}

run()
  .then(ok => process.exit(ok ? 0 : 1))
  .catch(err => {
    console.error(`\n[golden-jsonl] FATAL: ${err.message}`);
    process.exit(1);
  });
