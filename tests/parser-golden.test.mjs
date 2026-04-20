/**
 * Golden-file parser test — runs extractTweets against every fixture scenario
 * and compares output to expected.jsonl with field-level diff reporting.
 *
 * Run with: node --test tests/parser-golden.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTweets } from '../lib/tweet-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANITIZED_DIR = join(__dirname, 'fixtures', 'sanitized');

// Discover all scenario directories with a manifest.json
const scenarios = readdirSync(SANITIZED_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => {
    const dir = join(SANITIZED_DIR, d.name);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      return { name: d.name, dir, manifest };
    } catch { return null; }
  })
  .filter(Boolean);

if (scenarios.length === 0) {
  throw new Error('No fixture scenarios found in ' + SANITIZED_DIR);
}

// ---------------------------------------------------------------------------
// Field-level diff utility
// ---------------------------------------------------------------------------

function fieldDiffs(expected, actual, prefix = '') {
  const diffs = [];
  const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const e = expected[key];
    const a = actual[key];
    if (e === a) continue;
    if (e && a && typeof e === 'object' && typeof a === 'object' && !Array.isArray(e) && !Array.isArray(a)) {
      diffs.push(...fieldDiffs(e, a, path));
    } else if (JSON.stringify(e) !== JSON.stringify(a)) {
      diffs.push({ path, expected: e, actual: a });
    }
    if (diffs.length >= 5) break; // cap to keep output readable
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parser golden scenarios', () => {
  for (const { name, dir, manifest } of scenarios) {
    it(name, () => {
      const fixture = JSON.parse(readFileSync(join(dir, manifest.files.fixture), 'utf8'));
      const expectedLines = readFileSync(join(dir, manifest.files.expected), 'utf8').trim().split('\n');
      const expected = expectedLines.map(l => JSON.parse(l));

      const actual = extractTweets(manifest.endpoint, fixture);
      // source_endpoint is set by the caller (service worker), not by extractTweets
      for (const t of actual) t.source_endpoint = manifest.endpoint;

      // Strip captured_at (time-dependent) and sort by id for stable comparison
      const strip = tweets => tweets
        .map(t => { const { captured_at, ...rest } = t; return rest; })
        .sort((a, b) => a.id.localeCompare(b.id));

      const exp = strip(expected);
      const act = strip(actual);

      // Count check
      assert.equal(act.length, exp.length,
        `Tweet count mismatch: expected ${exp.length}, got ${act.length}`);

      // Per-tweet field-level comparison
      for (let i = 0; i < exp.length; i++) {
        const diffs = fieldDiffs(exp[i], act[i]);
        if (diffs.length > 0) {
          const detail = diffs.map(d =>
            `  ${d.path}\n    expected: ${JSON.stringify(d.expected)}\n    actual:   ${JSON.stringify(d.actual)}`
          ).join('\n');
          assert.fail(`${name} | tweet ${exp[i].id}\n${detail}`);
        }
      }
    });
  }
});
