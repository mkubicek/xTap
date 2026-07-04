#!/usr/bin/env node
// Generates manifest.firefox.json from manifest.json.
// Run as part of release to keep a single source of truth for version,
// permissions, and content scripts.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// Firefox MV3 uses background.scripts instead of service_worker
delete manifest.background.service_worker;
manifest.background.scripts = ['background.js'];

// Gecko-specific metadata
manifest.browser_specific_settings = {
  gecko: {
    id: 'xtap@mkubicek.dev',
    strict_min_version: '128.0'
  }
};

// Optional output path override (used by tests to diff without overwriting)
const outPath = process.argv[2] || path.join(root, 'manifest.firefox.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Generated ${outPath}`);
