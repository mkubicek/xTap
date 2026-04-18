#!/usr/bin/env node
/**
 * Deterministic anonymization tool for xTap raw GraphQL captures.
 *
 * Usage:
 *   node tests/fixtures/tools/sanitize.mjs <raw-capture.json> [scenario-name]
 *
 * Reads a raw capture envelope { endpoint, data } and produces:
 *   - sanitized/[scenario]/fixture.json   — anonymized GraphQL response
 *   - sanitized/[scenario]/expected.jsonl  — golden parser output
 *   - sanitized/[scenario]/manifest.json   — scenario metadata
 *
 * All remapping is deterministic (keyed hash) so repeated runs produce
 * identical output from the same input.
 *
 * Anonymization scope:
 *   - Tweet/user IDs, handles, display names  → deterministic remap
 *   - Tweet text, note-tweet text             → synthetic replacement
 *   - User bios/descriptions                  → synthetic replacement
 *   - Card titles, descriptions, string_value → synthetic replacement
 *   - Article titles, preview_text            → synthetic replacement
 *   - Translation text (grok translations)    → synthetic replacement
 *   - All pbs.twimg.com / video.twimg.com URLs → placeholder URLs
 *   - All twitter.com / x.com handle-URLs      → anonymized handles
 *   - Affiliate / business-label descriptions   → generic labels
 *   - Birdwatch destination URLs               → redacted
 *   - Feedback actions (urls, prompts)          → redacted
 *   - Profile images, banners, media, card_img  → placeholder URLs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, '..');

// Import the real tweet parser so we can generate expected output
import { extractTweets } from '../../../lib/tweet-parser.js';

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

const SEED = 'xtap-fixture-seed-v1';

function hashHex(input) {
  return createHash('sha256').update(SEED + ':' + input).digest('hex');
}

function hashDecimal(input, length = 18) {
  const hex = hashHex(input);
  return BigInt('0x' + hex).toString(10).slice(0, length);
}

function hashTag(input, length = 8) {
  return hashHex(input).slice(0, length);
}

// ---------------------------------------------------------------------------
// Deterministic synthetic text generator
// ---------------------------------------------------------------------------

const WORDS = [
  'alpha', 'beta', 'gamma', 'delta', 'echo', 'foxtrot', 'grid', 'haze',
  'ionic', 'jade', 'kite', 'lunar', 'mesa', 'node', 'orbit', 'prism',
  'quartz', 'relay', 'solar', 'terra', 'ultra', 'vortex', 'wave', 'xenon',
  'yield', 'zonal', 'apex', 'bloom', 'core', 'drift', 'flux', 'glyph',
  'helix', 'index', 'joule', 'kraft', 'logic', 'micro', 'nexus', 'optic',
  'pulse', 'query', 'ratio', 'sigma', 'trace', 'unity', 'valve', 'widen',
];

/** Generate deterministic synthetic prose from a seed string. */
function syntheticText(seed, targetLen) {
  const hex = hashHex('syntext:' + seed);
  const words = [];
  let len = 0;
  for (let i = 0; len < targetLen && i < hex.length; i += 2) {
    const idx = parseInt(hex.slice(i, i + 2), 16) % WORDS.length;
    const w = words.length === 0
      ? WORDS[idx].charAt(0).toUpperCase() + WORDS[idx].slice(1)
      : WORDS[idx];
    words.push(w);
    len += w.length + 1;
    // Add sentence breaks
    if (words.length % 8 === 0) {
      words[words.length - 1] += '.';
    }
  }
  let result = words.join(' ');
  if (!result.endsWith('.')) result += '.';
  return result;
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

class Sanitizer {
  constructor() {
    this.tweetIds = new Map();
    this.userIds = new Map();
    this.handles = new Map();
    this.displayNames = new Map();
  }

  remapTweetId(id) {
    if (!id) return id;
    if (!this.tweetIds.has(id)) {
      this.tweetIds.set(id, hashDecimal('tweet:' + id, 19));
    }
    return this.tweetIds.get(id);
  }

  remapUserId(id) {
    if (!id) return id;
    if (!this.userIds.has(id)) {
      this.userIds.set(id, hashDecimal('user:' + id, 12));
    }
    return this.userIds.get(id);
  }

  remapHandle(handle) {
    if (!handle) return handle;
    if (!this.handles.has(handle)) {
      this.handles.set(handle, 'user_' + hashTag('handle:' + handle));
    }
    return this.handles.get(handle);
  }

  remapDisplayName(name) {
    if (!name) return name;
    if (!this.displayNames.has(name)) {
      this.displayNames.set(name, 'User ' + hashTag('name:' + name, 6));
    }
    return this.displayNames.get(name);
  }

  // -------------------------------------------------------------------------
  // URL sanitizers
  // -------------------------------------------------------------------------

  sanitizeTwimgUrl(url) {
    if (!url) return url;
    const tag = hashTag('twimg:' + url, 12);
    if (url.includes('video.twimg.com')) {
      return `https://video.twimg.com/sanitized/${tag}.mp4`;
    }
    const ext = url.match(/\.(jpg|png|gif|webp)/)?.[1] || 'jpg';
    return `https://pbs.twimg.com/sanitized/${tag}.${ext}`;
  }

  sanitizeTcoUrl(url) {
    if (!url) return url;
    return 'https://t.co/SAN_' + hashTag('tco:' + url, 8);
  }

  sanitizeExpandedUrl(url) {
    if (!url) return url;
    return `https://example.com/sanitized/${hashTag('expanded:' + url, 10)}`;
  }

  sanitizeDisplayUrl(url) {
    if (!url) return url;
    return `example.com/san_${hashTag('display:' + url, 10)}`;
  }

  /** Replace handles and status IDs in twitter.com / x.com URLs. */
  sanitizeTwitterUrl(url) {
    const PASSTHROUGH = new Set(['i', 'home', 'search', 'settings', 'explore', 'notifications']);
    // Remap handles
    let out = url.replace(
      /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})(?=\/|[^A-Za-z0-9_]|$)/g,
      (match, handle) => PASSTHROUGH.has(handle) ? match : match.replace(handle, this.remapHandle(handle))
    );
    // Remap /status/<id> segments
    out = out.replace(/\/status\/(\d{10,})/g, (match, id) => '/status/' + this.remapTweetId(id));
    // Remap /article/<id> segments
    out = out.replace(/\/article\/(\d{10,})/g, (match, id) => '/article/' + this.remapTweetId(id));
    return out;
  }

  // -------------------------------------------------------------------------
  // Tree walker
  // -------------------------------------------------------------------------

  sanitize(node, ctx = {}) {
    if (node === null || node === undefined) return node;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      return node.map(item => this.sanitize(item, ctx));
    }

    const typename = node.__typename;
    let c = { ...ctx };
    if (typename === 'Tweet') c.inTweet = true;
    if (typename === 'User') c.inUser = true;

    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = this.sanitizeField(key, value, c);
    }
    return result;
  }

  sanitizeField(key, value, ctx) {
    // --- Tweet ID fields ---
    if (isTweetIdField(key) && typeof value === 'string')
      return this.remapTweetId(value);

    // --- User ID fields ---
    if (isUserIdField(key) && typeof value === 'string')
      return this.remapUserId(value);

    // --- rest_id: context-dependent ---
    if (key === 'rest_id' && typeof value === 'string') {
      // Card rest_id is a URL, not an ID
      if (value.startsWith('http')) return this.sanitizeTcoUrl(value);
      return ctx.inUser ? this.remapUserId(value) : this.remapTweetId(value);
    }

    // --- id_str: context-dependent ---
    if (key === 'id_str' && typeof value === 'string') {
      if (ctx.inMention) return this.remapUserId(value);
      return ctx.inUser ? this.remapUserId(value) : this.remapTweetId(value);
    }

    // --- Handles ---
    if ((key === 'screen_name' || key === 'in_reply_to_screen_name') && typeof value === 'string')
      return this.remapHandle(value);

    // --- Display names (user objects and mention objects) ---
    if (key === 'name' && typeof value === 'string' && (ctx.inUser || ctx.inMention))
      return this.remapDisplayName(value);

    // --- PROSE: full tweet text → synthetic replacement ---
    if (key === 'full_text' && typeof value === 'string')
      return syntheticText(value, Math.min(value.length, 200));

    // --- PROSE: note_tweet text → synthetic replacement ---
    if (key === 'text' && typeof value === 'string' && ctx.inNoteTweet)
      return syntheticText(value, Math.min(value.length, 300));

    // --- PROSE: user description / bio (but not affiliate label descriptions) ---
    if (key === 'description' && typeof value === 'string' && !ctx.inLabel)
      return value.length === 0 ? '' : syntheticText('bio:' + value, Math.min(value.length, 120));

    // --- PROSE: affiliate/business label description (org names) ---
    if (key === 'description' && typeof value === 'string' && ctx.inLabel)
      return 'Organization ' + hashTag('org:' + value, 6);

    // --- PROSE: card string_value (titles, descriptions, alt text) ---
    if (key === 'string_value' && typeof value === 'string') {
      // Domain names are structural, not PII
      if (ctx.inCardDomain) return 'example.com';
      return value.length === 0 ? '' : syntheticText('card:' + value, Math.min(value.length, 150));
    }

    // --- PROSE: article title and preview_text ---
    if ((key === 'title' || key === 'preview_text') && typeof value === 'string')
      return syntheticText('article:' + value, Math.min(value.length, 120));

    // --- PROSE: translation text (grok_translated_post_with_availability) ---
    if (key === 'translation' && typeof value === 'string')
      return syntheticText('translation:' + value, Math.min(value.length, 200));

    // --- PROSE: feedback confirmation/prompt ---
    if ((key === 'confirmation' || key === 'prompt') && typeof value === 'string')
      return 'Sanitized feedback text.';

    // --- URL: feedbackUrl → redact ---
    if (key === 'feedbackUrl' && typeof value === 'string')
      return '/sanitized/feedback';

    // --- URL: birdwatch destinationUrl ---
    if (key === 'destinationUrl' && typeof value === 'string')
      return '/sanitized/birdwatch';

    // --- URL: anything on pbs.twimg.com or video.twimg.com ---
    if (key === 'url' && typeof value === 'string' && value.includes('twimg.com'))
      return this.sanitizeTwimgUrl(value);
    if (key === 'image_url' && typeof value === 'string' && value.includes('twimg.com'))
      return this.sanitizeTwimgUrl(value);
    if (key === 'profile_image_url_https' && typeof value === 'string')
      return this.sanitizeTwimgUrl(value);
    if (key === 'profile_banner_url' && typeof value === 'string')
      return value === '' ? '' : this.sanitizeTwimgUrl(value);
    if (key === 'media_url_https' && typeof value === 'string')
      return this.sanitizeTwimgUrl(value);
    if (key === 'original_img_url' && typeof value === 'string')
      return this.sanitizeTwimgUrl(value);

    // --- URL: t.co links ---
    if (key === 'url' && typeof value === 'string' && value.startsWith('https://t.co/'))
      return this.sanitizeTcoUrl(value);

    // --- URL: expanded_url ---
    if (key === 'expanded_url' && typeof value === 'string')
      return this.sanitizeExpandedUrl(value);

    // --- URL: display_url ---
    if (key === 'display_url' && typeof value === 'string')
      return this.sanitizeDisplayUrl(value);

    // --- URL: twitter.com/handle or x.com/handle in display/expanded ---
    if ((key === 'display' || key === 'expanded') && typeof value === 'string' &&
        (value.includes('x.com/') || value.includes('twitter.com/')))
      return this.sanitizeTwitterUrl(value);

    // --- URL: card_url string_value ---
    if (key === 'card_url' && typeof value === 'string')
      return this.sanitizeTcoUrl(value);

    // --- URL: any remaining url field with twitter.com / x.com ---
    if (key === 'url' && typeof value === 'string' &&
        (value.includes('twitter.com/') || value.includes('x.com/')))
      return this.sanitizeTwitterUrl(value);

    // --- URL: vanity_url ---
    if (key === 'vanity_url' && typeof value === 'string')
      return 'example.com';

    // --- entryId — contains tweet IDs ---
    if (key === 'entryId' && typeof value === 'string')
      return value.replace(/(\d{10,})/g, m => this.remapTweetId(m));

    // --- sortIndex ---
    if (key === 'sortIndex' && typeof value === 'string')
      return this.remapTweetId(value);

    // --- edit_tweet_ids ---
    if (key === 'edit_tweet_ids' && Array.isArray(value))
      return value.map(id => this.remapTweetId(id));

    // --- pinned_tweet_ids_str ---
    if (key === 'pinned_tweet_ids_str' && Array.isArray(value))
      return value.map(id => this.remapTweetId(id));

    // --- allTweetIds in conversationMetadata ---
    if (key === 'allTweetIds' && Array.isArray(value))
      return value.map(id => this.remapTweetId(id));

    // --- source_status_id_str / source_user_id_str ---
    if (key === 'source_status_id_str' && typeof value === 'string')
      return this.remapTweetId(value);
    if (key === 'source_user_id_str' && typeof value === 'string')
      return this.remapUserId(value);

    // --- Video variants URLs ---
    if (key === 'variants' && Array.isArray(value)) {
      return value.map(v => {
        if (v?.url && typeof v.url === 'string')
          return { ...v, url: this.sanitizeTwimgUrl(v.url) };
        return this.sanitize(v, ctx);
      });
    }

    // --- user_mentions array → set mention context ---
    if (key === 'user_mentions' && Array.isArray(value))
      return value.map(m => this.sanitize(m, { ...ctx, inMention: true }));

    // --- note_tweet — set context ---
    if (key === 'note_tweet' || key === 'note_tweet_results')
      return this.sanitize(value, { ...ctx, inNoteTweet: true });

    // --- affiliates_highlighted_label — set label context ---
    if (key === 'affiliates_highlighted_label')
      return this.sanitize(value, { ...ctx, inLabel: true });

    // --- profile_bio — set context ---
    if (key === 'profile_bio')
      return this.sanitize(value, { ...ctx, inProfileBio: true });

    // --- symbol tag info (cashtag company names) ---
    if (key === 'tag' && typeof value === 'object' && value?.info)
      return this.sanitize(value, { ...ctx, inSymbolInfo: true });

    // --- card binding_values domain key → set context ---
    if (key === 'domain')
      return this.sanitize(value, { ...ctx, inCardDomain: true });

    // --- location in user context ---
    if (key === 'location' && typeof value === 'string' && ctx.inUser)
      return 'Somewhere';

    // --- Base64 id (User/Article node id) ---
    if (key === 'id' && typeof value === 'string' && value.match(/^[A-Za-z0-9+/=]{20,}$/))
      return 'SANITIZED_' + hashTag('b64id:' + value, 12);

    // --- controllerData (opaque base64 blobs) ---
    if (key === 'controllerData' && typeof value === 'string')
      return 'SANITIZED_CONTROLLER_DATA';

    // --- cashtag info.name (company names like "Salesforce Inc") ---
    if (key === 'name' && typeof value === 'string' && ctx.inSymbolInfo)
      return 'Company ' + hashTag('company:' + value, 6);

    // --- action_metadata ---
    if (key === 'action_metadata' && typeof value === 'string')
      return 'SANITIZED';

    // Recurse
    return this.sanitize(value, ctx);
  }
}

// ---------------------------------------------------------------------------
// Field classification
// ---------------------------------------------------------------------------

const TWEET_ID_FIELDS = new Set([
  'in_reply_to_status_id_str', 'quoted_status_id_str',
  'conversation_id_str', 'quoted_status_id',
  'initial_tweet_id', 'media_id',
]);

const USER_ID_FIELDS = new Set([
  'user_id_str', 'in_reply_to_user_id_str',
]);

function isTweetIdField(key) { return TWEET_ID_FIELDS.has(key); }
function isUserIdField(key) { return USER_ID_FIELDS.has(key); }

// ---------------------------------------------------------------------------
// Post-process: global scrub of any leaked identifiers
// ---------------------------------------------------------------------------

function globalScrub(fixtureStr, sanitizer) {
  let out = fixtureStr;

  // Scrub handles (longest first to avoid partial matches)
  const handles = [...sanitizer.handles.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [orig, repl] of handles) {
    const esc = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'g'), repl);
  }

  // Scrub display names
  const names = [...sanitizer.displayNames.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [orig, repl] of names) {
    out = out.replaceAll(orig, repl);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node sanitize.mjs <raw-capture.json> [scenario-name]');
    console.error('');
    console.error('The raw capture should be a JSON file with:');
    console.error('  { "endpoint": "HomeTimeline", "data": { ... } }');
    process.exit(1);
  }

  const rawPath = resolve(args[0]);
  const scenario = args[1] || 'timeline-basic';
  const outDir = join(FIXTURES_ROOT, 'sanitized', scenario);

  if (!existsSync(rawPath)) {
    console.error(`Raw capture not found: ${rawPath}`);
    process.exit(1);
  }

  console.log(`Reading raw capture: ${rawPath}`);
  const rawJson = JSON.parse(readFileSync(rawPath, 'utf8'));

  const endpoint = rawJson.endpoint;
  const rawData = rawJson.data;

  if (!endpoint || !rawData) {
    console.error('Raw capture must have { "endpoint": "...", "data": { ... } }');
    process.exit(1);
  }

  console.log(`Endpoint: ${endpoint}`);
  mkdirSync(outDir, { recursive: true });

  // --- Sanitize ---
  const sanitizer = new Sanitizer();
  const sanitizedData = sanitizer.sanitize(rawData);
  console.log(`Remapped: ${sanitizer.tweetIds.size} tweet IDs, ${sanitizer.userIds.size} user IDs, ${sanitizer.handles.size} handles, ${sanitizer.displayNames.size} names`);

  // Global scrub for any remaining leaks
  let fixtureStr = globalScrub(JSON.stringify(sanitizedData, null, 2), sanitizer);
  const sanitizedDataClean = JSON.parse(fixtureStr);

  // --- Write fixture ---
  const fixturePath = join(outDir, 'fixture.json');
  writeFileSync(fixturePath, fixtureStr + '\n');
  console.log(`Wrote: ${fixturePath}`);

  // --- Generate expected JSONL ---
  const tweets = extractTweets(endpoint, sanitizedDataClean);
  console.log(`Parser extracted ${tweets.length} tweets`);

  const fixedCapturedAt = '2025-01-01T00:00:00.000Z';
  for (const tweet of tweets) {
    tweet.source_endpoint = endpoint;
    tweet.captured_at = fixedCapturedAt;
  }

  const expectedPath = join(outDir, 'expected.jsonl');
  const jsonl = tweets.map(t => JSON.stringify(t)).join('\n') + '\n';
  writeFileSync(expectedPath, jsonl);
  console.log(`Wrote: ${expectedPath} (${tweets.length} lines)`);

  // --- Write manifest ---
  const manifest = {
    scenario,
    endpoint,
    description: `Basic ${endpoint} timeline capture with standard tweet types`,
    files: { fixture: 'fixture.json', expected: 'expected.jsonl' },
    tweet_count: tweets.length,
    remap_stats: {
      tweet_ids: sanitizer.tweetIds.size,
      user_ids: sanitizer.userIds.size,
      handles: sanitizer.handles.size,
      display_names: sanitizer.displayNames.size,
    },
    notes: 'Generated by sanitize.mjs. All prose content replaced with synthetic text. All identifiers deterministically remapped.',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote: manifest.json`);

  // --- Write/overwrite scenario README ---
  const readmePath = join(outDir, 'README.md');
  writeFileSync(readmePath, `# ${scenario}

## Scenario

Basic timeline capture from a \`${endpoint}\` response exercising the core
xTap tweet parsing pipeline.

## What it covers

- Timeline instruction parsing (TimelineAddEntries)
- Single tweet items (TimelineTimelineItem)
- Conversation modules (TimelineTimelineModule)
- Tweet normalization (author, text, metrics, media, URLs, mentions)
- Reply chains, quote tweets, retweets
- Note tweets (long-form posts)
- Article stubs
- Card embeds
- Cursor entries (skipped by parser)

## Raw input

Generated from a real passive \`${endpoint}\` capture placed in
\`tests/fixtures/private-raw/\`. The raw capture is gitignored and not
included in the repository.

## Anonymization

All content is fully anonymized, not just pseudonymized:

- ${sanitizer.tweetIds.size} tweet IDs deterministically remapped
- ${sanitizer.userIds.size} user IDs deterministically remapped
- ${sanitizer.handles.size} screen names / handles remapped to \`user_<hash>\`
- ${sanitizer.displayNames.size} display names remapped to \`User <hash>\`
- All tweet text and note-tweet text replaced with synthetic prose
- All user bios / descriptions replaced with synthetic prose
- All card titles, descriptions, and alt text replaced with synthetic prose
- All article titles and preview text replaced with synthetic prose
- All pbs.twimg.com and video.twimg.com URLs replaced with placeholder URLs
- All twitter.com and x.com URLs have handles and status IDs remapped
- Affiliate / business-label org names replaced with \`Organization <hash>\`
- Birdwatch URLs, feedback URLs, controller data, base64 IDs all redacted

Anonymization preserves graph relationships: reply-to, quote, conversation,
and author references remain internally consistent.

## Invariants

- \`fixture.json\` fed to \`extractTweets("${endpoint}", data)\` must produce
  exactly ${tweets.length} tweets matching \`expected.jsonl\`
- All \`in_reply_to\`, \`quoted_tweet_id\`, and \`conversation_id\` values that
  reference tweets in the fixture use the same remapped IDs
- Author IDs and handles are consistent across all tweets by the same user
- No original handles, display names, tweet IDs, or searchable prose remain
`);
  console.log(`Wrote: README.md`);

  // --- Verify determinism ---
  console.log('\nVerifying determinism...');
  const sanitizer2 = new Sanitizer();
  const s2 = sanitizer2.sanitize(rawData);
  const fixtureStr2 = globalScrub(JSON.stringify(s2, null, 2), sanitizer2);

  if (fixtureStr === fixtureStr2) {
    console.log('✓ Deterministic: second run produces identical output');
  } else {
    console.error('✗ Non-deterministic output detected!');
    process.exit(1);
  }

  const tweets2 = extractTweets(endpoint, JSON.parse(fixtureStr2));
  for (const t of tweets2) { t.source_endpoint = endpoint; t.captured_at = fixedCapturedAt; }
  const jsonl2 = tweets2.map(t => JSON.stringify(t)).join('\n') + '\n';
  if (jsonl === jsonl2) {
    console.log('✓ Expected JSONL is stable across runs');
  } else {
    console.error('✗ Expected JSONL differs between runs!');
    process.exit(1);
  }

  // --- Verify no leaks ---
  const twimgLeaks = (fixtureStr.match(/pbs\.twimg\.com\/profile_images\/[^s]/g) || []).length;
  const cardImgLeaks = (fixtureStr.match(/pbs\.twimg\.com\/card_img/g) || []).length;
  if (twimgLeaks || cardImgLeaks) {
    console.warn(`⚠ Remaining twimg leaks: ${twimgLeaks} profile_images, ${cardImgLeaks} card_img`);
  } else {
    console.log('✓ No raw twimg.com URLs remain');
  }

  // Check for raw status IDs in permalink URLs
  const rawStatusIds = fixtureStr.match(/\/status\/(\d{10,})/g) || [];
  const unleakedStatuses = rawStatusIds.filter(m => {
    const id = m.replace('/status/', '');
    return !sanitizer.tweetIds.has(id); // not a raw (pre-remap) ID means it's already remapped
  });
  // All status IDs in the output should be remapped values, not raw values
  const rawIdSet = new Set(sanitizer.tweetIds.keys());
  const leakedStatuses = rawStatusIds.filter(m => rawIdSet.has(m.replace('/status/', '')));
  if (leakedStatuses.length) {
    console.warn(`⚠ ${leakedStatuses.length} raw status IDs leaked in URLs`);
  } else {
    console.log('✓ No raw status IDs in URLs');
  }

  // --- Verify no prose leaks in text-bearing fields ---
  console.log('\nVerifying no prose leaks in text-bearing fields...');
  const PROSE_FIELDS = new Set([
    'full_text', 'translation', 'preview_text', 'title',
  ]);
  // Fields that are prose when non-empty and not a structural constant
  const PROSE_FIELDS_CONDITIONAL = new Set([
    'description', 'string_value',
  ]);
  // Fields that are prose only when long (short values like "en" are structural)
  const PROSE_FIELDS_LONG = new Set([
    'text',
  ]);
  // text is only prose in note_tweet context, but we check it everywhere
  // and accept structural values
  const STRUCTURAL_VALUES = new Set([
    '', 'example.com', 'Somewhere', 'Sanitized feedback text.', 'none',
  ]);

  const wordBankSet = new Set(WORDS);

  /** Returns true if text is synthetic (all tokens from the word bank). */
  function isSynthetic(text) {
    // Strip trailing period and split on whitespace/periods
    const tokens = text.replace(/\.$/, '').split(/[\s.]+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(t => wordBankSet.has(t.toLowerCase()));
  }

  /** Returns true if text looks like a known sanitized pattern. */
  function isSanitizedPattern(text) {
    if (STRUCTURAL_VALUES.has(text)) return true;
    if (/^Organization [0-9a-f]+$/.test(text)) return true;
    if (/^Company [0-9a-f]+$/.test(text)) return true;
    if (/^User [0-9a-f]+$/.test(text)) return true;
    if (/^user_[0-9a-f]+$/.test(text)) return true;
    if (/^SANITIZED/.test(text)) return true;
    if (/^\/sanitized\//.test(text)) return true;
    if (/^https?:\/\/(pbs\.twimg\.com|video\.twimg\.com)\/sanitized\//.test(text)) return true;
    if (/^https?:\/\/t\.co\/SAN_/.test(text)) return true;
    if (/^https?:\/\/example\.com\/sanitized\//.test(text)) return true;
    if (/^example\.com\/san_/.test(text)) return true;
    return false;
  }

  const proseLeaks = [];

  function checkProseLeaks(node, path = '') {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => checkProseLeaks(item, `${path}[${i}]`));
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        const fieldPath = path ? `${path}.${key}` : key;
        if (PROSE_FIELDS.has(key)) {
          if (!isSynthetic(value) && !isSanitizedPattern(value)) {
            proseLeaks.push({ field: key, path: fieldPath, sample: value.slice(0, 80) });
          }
        } else if (PROSE_FIELDS_CONDITIONAL.has(key) && value.length > 0) {
          if (!isSynthetic(value) && !isSanitizedPattern(value)) {
            proseLeaks.push({ field: key, path: fieldPath, sample: value.slice(0, 80) });
          }
        } else if (PROSE_FIELDS_LONG.has(key) && value.length > 30) {
          if (!isSynthetic(value) && !isSanitizedPattern(value)) {
            proseLeaks.push({ field: key, path: fieldPath, sample: value.slice(0, 80) });
          }
        }
      }
      if (typeof value === 'object') {
        checkProseLeaks(value, path ? `${path}.${key}` : key);
      }
    }
  }

  checkProseLeaks(sanitizedDataClean);

  if (proseLeaks.length) {
    console.error(`✗ ${proseLeaks.length} prose leak(s) detected in text-bearing fields:`);
    for (const leak of proseLeaks) {
      console.error(`  ${leak.field} at ${leak.path}: "${leak.sample}"`);
    }
    process.exit(1);
  } else {
    console.log(`✓ All text-bearing fields contain only synthetic/sanitized content`);
  }

  console.log('\nDone. Sanitized fixture pack written to:', outDir);
}

main();
