#!/usr/bin/env node
/**
 * chromium-harness.js — Launch Chromium with the real xTap extension and Fake X.
 *
 * Verifies:
 *   1. Chromium launches successfully with the extension
 *   2. The extension loads (popup.html accessible)
 *   3. Fake X page loads under https://x.com:<port>/
 *
 * Usage:
 *   node tests/e2e/chromium-harness.js [--headed] [--port 4443]
 *
 * Requires:
 *   - Extension built via build-test-extension.js
 *   - Fake X server (started automatically as a child process)
 *   - Playwright + Chromium installed (npm install in tests/e2e/)
 */

import { chromium } from 'playwright';
import { fork, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, '.extension-out');
const EXTENSION_ID = 'mhljdmpppgbddpoijmhjnaaondpidjfn';

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

function buildExtension() {
  console.log('[harness] Building test extension...');
  execSync(`node ${join(__dirname, 'build-test-extension.js')}`, {
    stdio: 'inherit',
  });
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error('Extension build failed — no manifest.json in output');
  }
}

function startFakeX(port) {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, 'fake-x.js'), ['--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Fake X server failed to start within 10s'));
      }
    }, 10_000);

    child.on('message', (msg) => {
      if (msg.type === 'ready' && !settled) {
        settled = true;
        clearTimeout(timer);
        console.log(`[harness] Fake X ready on port ${msg.port}`);
        resolve(child);
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Fake X exited with code ${code}`));
      }
    });

    // Forward stdout/stderr for debugging
    child.stdout?.on('data', (d) => process.stdout.write(d));
    child.stderr?.on('data', (d) => process.stderr.write(d));
  });
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

async function run() {
  // 1. Build extension
  buildExtension();

  // 2. Start Fake X
  const fakeX = await startFakeX(port);

  // 3. Create temp user data dir for Chromium
  const userDataDir = mkdtempSync(join(tmpdir(), 'xtap-e2e-'));

  let context;
  try {
    // 4. Launch Chromium with the extension
    // Extensions require headed mode or Chrome's --headless=new (112+).
    // Playwright's headless: true uses the old headless shell which doesn't
    // support extensions, so we always launch headed and use --headless=new
    // explicitly when CI/headless mode is needed.
    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP x.com 127.0.0.1`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
    ];
    if (!headed) {
      launchArgs.push('--headless=new');
    }
    console.log(`[harness] Launching Chromium (${headed ? 'headed' : 'headless=new'})...`);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // always false — extensions need real Chrome, use --headless=new for CI
      args: launchArgs,
      ignoreHTTPSErrors: true,
    });
    console.log('[harness] Chromium launched');

    // 5. Verify extension loaded — access popup.html
    console.log('[harness] Verifying extension...');
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    });
    const popupTitle = await extPage.title();
    // popup.html should exist and be loadable
    console.log(`[harness] Extension popup loaded (title: "${popupTitle}")`);
    await extPage.close();

    // 6. Navigate to Fake X and verify page loads
    console.log(`[harness] Loading Fake X at https://x.com:${port}/...`);
    const page = await context.newPage();
    await page.goto(`https://x.com:${port}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    // Wait for the page's fetch to complete — title changes to "xTap:loaded"
    await page.waitForFunction(
      () => document.title === 'xTap:loaded' || document.title === 'xTap:error',
      { timeout: 15_000 },
    );

    const title = await page.title();
    if (title !== 'xTap:loaded') {
      throw new Error(
        `Fake X page title is "${title}" — expected "xTap:loaded". The extension fetch interception or Fake X replay may have failed.`,
      );
    }
    console.log('[harness] Fake X loaded successfully under x.com');

    // 7. All checks passed
    console.log('\n[harness] ALL CHECKS PASSED');
    console.log('  - Chromium launched successfully');
    console.log(`  - Extension ${EXTENSION_ID} loaded`);
    console.log(`  - Fake X loaded at https://x.com:${port}/`);

  } finally {
    // Cleanup
    if (context) {
      await context.close().catch(() => {});
    }
    fakeX.kill('SIGTERM');
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

run().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`\n[harness] FAILED: ${err.message}`);
  process.exit(1);
});
