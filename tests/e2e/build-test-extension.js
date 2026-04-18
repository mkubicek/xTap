#!/usr/bin/env node
/**
 * build-test-extension.js
 *
 * Copies the real xTap extension into a test-specific output directory and
 * injects a deterministic "key" field into manifest.json so that Chrome
 * always assigns the same stable extension ID when loading it unpacked.
 *
 * Usage:
 *   node tests/e2e/build-test-extension.js [--out <dir>] [--print-id]
 *
 * Defaults:
 *   --out   tests/e2e/.extension-out
 */

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// --- Configuration -----------------------------------------------------------

const PEM_PATH = join(__dirname, 'test-extension.pem');

// Files/dirs that make up the real extension (relative to repo root)
const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'content-main.js',
  'content-bridge.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'debug.html',
  'debug.css',
  'debug.js',
  'lib',
  'icons',
];

// --- Helpers -----------------------------------------------------------------

/** Extract DER-encoded public key from a PEM private key, return as Buffer. */
function extractPublicKeyDER(pemPath) {
  const der = execSync(
    `openssl rsa -in "${pemPath}" -pubout -outform DER 2>/dev/null`,
  );
  return der; // Buffer
}

/** Compute Chrome extension ID from DER public key bytes. */
function computeExtensionId(derBuf) {
  const hash = createHash('sha256').update(derBuf).digest('hex');
  const HEX = '0123456789abcdef';
  const ALPHA = 'abcdefghijklmnop';
  return hash
    .slice(0, 32)
    .split('')
    .map((c) => ALPHA[HEX.indexOf(c)])
    .join('');
}

// --- Main --------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let outDir = join(__dirname, '.extension-out');
  let printId = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outDir = resolve(args[++i]);
    } else if (args[i] === '--print-id') {
      printId = true;
    }
  }

  if (!existsSync(PEM_PATH)) {
    console.error(`Error: PEM key not found at ${PEM_PATH}`);
    process.exit(1);
  }

  // 1. Extract public key and compute extension ID
  const derBuf = extractPublicKeyDER(PEM_PATH);
  const publicKeyBase64 = derBuf.toString('base64');
  const extensionId = computeExtensionId(derBuf);

  if (printId) {
    process.stdout.write(extensionId);
    return;
  }

  // 2. Copy extension files into outDir
  mkdirSync(outDir, { recursive: true });

  for (const entry of EXTENSION_FILES) {
    const src = join(REPO_ROOT, entry);
    const dst = join(outDir, entry);
    if (!existsSync(src)) {
      console.warn(`Warning: ${entry} not found, skipping`);
      continue;
    }
    cpSync(src, dst, { recursive: true, force: true });
  }

  // 3. Inject "key" into manifest.json
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.key = publicKeyBase64;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Extension built to: ${outDir}`);
  console.log(`Extension ID:       ${extensionId}`);
  console.log(`Public key injected into manifest.json`);
}

main();
