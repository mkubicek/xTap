# AGENTS.md - xTap

## What This Is

xTap is a browser extension (Chrome + Firefox) that passively captures tweets from X/Twitter by intercepting GraphQL API responses the browser already receives. No scraping, no extra requests — just structured JSONL output of what the user sees.

**Repo:** github.com/mkubicek/xTap
**License:** MIT (public repo)

## Architecture

```
content-main.js (MAIN world)
  │  Patches fetch() + XHR.open() to intercept GraphQL responses
  │  Emits CustomEvent with random per-page name
  ▼
content-bridge.js (ISOLATED world)
  │  Reads event name from <meta> tag, listens, relays
  │  Removes <meta> immediately after reading
  ▼
background.js (Service Worker, ES module)
  │  Parses tweet data via lib/tweet-parser.js
  │  Deduplicates (Set of seen IDs, max 50k; session storage in dev, local in prod)
  │  Batches (50 tweets or 30–45s jittered flush)
  │  Debug logging: intercepts console.log/warn/error, sends to host
  │  Transport: HTTP daemon only (reprobes on failure with 30s cooldown)
  ▼
┌─── HTTP transport ─────────────────────────────────────────────┐
│ xtap_daemon.py (127.0.0.1:17381)                               │
│   Managed by launchd (macOS), systemd (Linux), Scheduled Task  │
│   (Windows). Bearer token auth from ~/.xtap/secret             │
│   Endpoints: GET /status, POST /tweets, /log, /test-path,     │
│   /check-ytdlp, /download-video, /download-status             │
└────────────────────────────────────────────────────────────────┘
┌─── Native messaging (token bootstrap only) ───────────────────┐
│ xtap_host.py (Python, stdio)                                   │
│   Browser native messaging protocol (Chrome/Firefox)           │
│   Serves GET_TOKEN to bootstrap HTTP transport                 │
│   Crashes logged to ~/.xtap/host-error.log                    │
└────────────────────────────────────────────────────────────────┘
  │  xtap_daemon.py uses shared logic from xtap_core.py
  ▼
tweets-YYYY-MM-DD.jsonl  (daily rotation)
debug-YYYY-MM-DD.log     (when debug logging enabled)
```

### Key Design Decisions

- **Two content scripts (MAIN + ISOLATED):** MV3 requires this split. MAIN world can patch browser APIs but can't use chrome.runtime. ISOLATED world bridges the gap.
- **Random event channel:** The CustomEvent name is generated per page load (`'_' + Math.random().toString(36).slice(2)`) and passed via a `<meta>` tag that's immediately removed. Avoids predictable DOM markers.
- **HTTP-only transport:** All data flows through the HTTP daemon (`xtap_daemon.py`), managed by launchd (macOS), systemd (Linux), or Scheduled Task (Windows). On macOS, it runs outside browser TCC sandboxes, allowing writes to protected paths. If the daemon goes down, tweets are buffered in memory and the extension reprobes every 30 seconds until the daemon recovers.
- **Token bootstrap via native messaging:** On first run, the extension connects to `xtap_host.py` via native messaging to request `GET_TOKEN` (reads `~/.xtap/secret`). The token is cached in `chrome.storage.local` for subsequent HTTP requests. The native host handles nothing else — all data goes through HTTP.
- **Shared core logic:** `xtap_core.py` contains all file I/O logic (load seen IDs, resolve output dir, write tweets/logs, test path), used by `xtap_daemon.py`.
- **Environment detection:** `isDevMode = !chrome.runtime.getManifest().update_url` — packed CWS extensions have `update_url`, unpacked don't. Used to switch seenIds storage between session (dev) and local (production).
- **Volatile dev cache:** In dev mode (unpacked), `seenIds` is stored in `chrome.storage.session`, which clears on extension reload. This eliminates the need to manually clear storage during development. Production behavior is unchanged (persisted to `chrome.storage.local`).
- **Dedup in service worker:** Multiple tabs feed the same service worker. `seenIds` Set (max 50,000, FIFO eviction) prevents duplicates. In production, persisted to `chrome.storage.local` across sessions; in dev mode, uses volatile `chrome.storage.session`. Both host and daemon also load seen IDs from existing JSONL files on startup.
- **Jittered flush:** Batch flush uses `setTimeout` with randomized interval (30s base + up to 50% jitter = 30–45s), re-randomized each cycle. Avoids clockwork-regular patterns.
- **Path validation:** When the user sets a custom output directory, the service worker sends a `TEST_PATH` request to the HTTP daemon, which attempts `makedirs` + write/delete of a temp file before accepting the path.
- **Error resilience:** The native host logs crashes to `~/.xtap/host-error.log` with Python version and traceback. The HTTP daemon returns error status codes and logs startup diagnostics (Python version, output dir, token status). When the daemon is unreachable, the extension shows a red "!" badge and buffers tweets until the next successful reprobe (30s cooldown). The popup auto-refreshes every 2 seconds to reflect transport state changes.
- **Daemon debug logging:** Set `XTAP_LOG_LEVEL=debug` to get per-request logging (method, path, duration, tweet counts, tracebacks). Configured via environment variable in the service template (launchd/systemd). Re-run `install.sh` after changing.

## Stealth Constraints

**These are non-negotiable. xTap must remain completely passive.**

1. **Zero extra network requests** — never fetch, POST, or call any X/Twitter endpoint. The extension only reads responses the browser already received.
2. **Native-looking patches** — `toString()` on patched `fetch` returns `'function fetch() { [native code] }'`. `XHR.open` toString returns the original native string. `fetch.name` is set to `'fetch'` via `Object.defineProperty`.
3. **No expando properties** — XHR URL tracking uses a `WeakMap`, never attaches properties to instances.
4. **No DOM footprint** — no injected elements, no visible page modifications. The only transient artifact is the `<meta name="__cfg">` tag, removed within milliseconds by the bridge script.
5. **No console output in page context** — all logging happens in the service worker, which runs outside the page's JavaScript environment.
6. **Minimal permissions** — only `storage` and `nativeMessaging`. Host permissions scoped to `x.com`, `twitter.com`, and `127.0.0.1` (local daemon only). No `webRequest`, no `tabs`, no `scripting`, no web-accessible resources. The debug dashboard is an internal extension page (`chrome-extension://` origin), not a web-accessible resource.
7. **Random event channel** — per-page-load name, meta tag removed immediately after reading.
8. **Only `open()` patched on XHR** — `send()` is not patched, so non-GraphQL XHR calls have clean stack traces.

**Any change that adds network requests to X/Twitter domains must be rejected.**

## File Structure

```
xTap/
├── manifest.json              # Chrome MV3 manifest (permissions: storage, nativeMessaging)
├── manifest.firefox.json      # Firefox MV3 manifest (generated — do not edit)
├── background.js              # Service worker (ES module) - transport, parsing, dedup
├── content-main.js            # MAIN world - fetch/XHR patching
├── content-bridge.js          # ISOLATED world - event relay
├── popup.html/js/css          # Extension popup (stats, pause/resume, output dir)
├── debug.html/js/css          # Debug dashboard (live events, transport health, debug/discovery toggles, parser sandbox)
├── icons/                     # Extension icons (16, 48, 128)
├── lib/
│   └── tweet-parser.js        # GraphQL response → normalized tweet objects
└── native-host/
    ├── xtap_core.py              # Shared file I/O logic (used by host + daemon)
    ├── xtap_host.py              # Native messaging host — token bootstrap only (Python, stdio)
    ├── xtap_daemon.py            # HTTP daemon (127.0.0.1:17381)
    ├── com.xtap.daemon.plist     # launchd plist template (macOS)
    ├── com.xtap.daemon.service   # systemd unit template (Linux)
    ├── com.xtap.host.json        # Native messaging host manifest (Chrome)
    ├── com.xtap.host.firefox.json # Native messaging host manifest (Firefox)
    ├── install.sh                # macOS/Linux installer (+ daemon)
    ├── install.ps1               # Windows installer (+ daemon)
    ├── xtap_host.bat             # Windows native host wrapper
    └── xtap_daemon.bat           # Windows daemon wrapper
```

## Supported Endpoints

The tweet parser (`lib/tweet-parser.js`) has known instruction paths for:

`HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`

`TweetResultByRestId` is also handled — it returns a single tweet (not a timeline) and is only processed when the tweet contains article data (long-form posts). This avoids duplicating tweets already captured from timeline endpoints.

Unknown endpoints fall back to a recursive search for `instructions[]` arrays (max depth 5). Non-tweet endpoints are filtered in `background.js` via `IGNORED_ENDPOINTS`.

## Output Schema

Each JSONL line contains:

```jsonc
{
  "id": "1234567890",
  "url": "https://x.com/handle/status/1234567890",
  "created_at": "2024-01-01T00:00:00.000Z",       // ISO 8601
  "author": {
    "id": "987654321",
    "username": "handle",
    "display_name": "Display Name",
    "verified": false,
    "is_blue_verified": true,
    "follower_count": 1234
  },
  "text": "Full tweet text...",
  "lang": "en",
  "metrics": {
    "likes": 10, "retweets": 5, "replies": 2,
    "views": 1000, "bookmarks": 1, "quotes": 0
  },
  "media": [{"type": "photo|video|animated_gif", "url": "...", "alt_text": "...", "duration_ms": 1234}],
  "urls": [{"display": "...", "expanded": "...", "shortened": "..."}],
  "hashtags": ["tag"],
  "mentions": [{"id": "...", "username": "..."}],
  "in_reply_to": null,
  "quoted_tweet_id": null,
  "conversation_id": "1234567890",
  "is_retweet": false,
  "retweeted_tweet_id": null,
  "is_subscriber_only": false,
  "is_article": true,                   // only for long-form articles
  "article": {                          // only for long-form articles
    "title": "Article Title",
    "text": "Rendered plain text with ![img](media/<id>/file.png) refs",
    "blocks": [],                       // raw Draft.js content_state blocks
    "media": [{
      "id": "...",
      "url": "https://pbs.twimg.com/...",
      "filename": "image.png",
      "local_path": "media/<tweet_id>/image.png",
      "width": 1200, "height": 800
    }]
  },
  "source_endpoint": "HomeTimeline",
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

Notes: `media[].duration_ms` only present for videos. `views` may be `null`. For retweets, `text` contains the full original tweet text (not the truncated `RT @user:` form). For articles, `is_article` and `article` are present — `article.text` is a markdown rendering with inline `![](media/<id>/file)` image refs, `article.blocks` preserves the raw Draft.js structure, and `article.media[]` lists images with CDN URLs and local paths (assuming `media/<tweet_id>/` layout). Article tweets bypass dedup so the enriched version (from `TweetResultByRestId`) replaces the stub captured from timeline endpoints.

## Known Issues

### macOS TCC (Transparency, Consent, and Control)

On macOS, native messaging hosts can inherit browser TCC sandbox restrictions. After browser restarts, writes to protected paths (`~/Documents`, iCloud Drive, etc.) can fail with `PermissionError`.

**Solution:** The HTTP daemon (`xtap_daemon.py`) runs via launchd, independent of the browser process tree. It has its own TCC entitlements and can write to protected paths after a one-time macOS permission prompt. The daemon is the sole data transport — if it's not running, the extension buffers tweets and shows an error.

### Tombstone tweets

X sometimes returns `TimelineTweet` entries where `tweet_results.result` is missing (deleted/suspended tweets). These are skipped by the parser. Since no ID is extracted, they don't enter `seenIds` — if the tweet later appears with full data, it will be captured.

## Development Notes

- **No build step** — plain JS, no bundler, no transpilation. Load and go.
- **Testing:** `python3 -m pytest tests/ -v && node --test tests/*.test.mjs`. Run after every change. CI runs these on every push to main with coverage uploaded to Codecov. For manual browser testing, load unpacked in Chrome (`chrome://extensions`) or as a temporary add-on in Firefox (`about:debugging#/runtime/this-firefox`) using `manifest.firefox.json`. Chrome extension IDs vary per install; Firefox uses the fixed Gecko ID in `manifest.firefox.json`. Use the matching installer mode (`install.sh ... chrome|firefox`, `install.ps1 -Browser chrome|firefox`).
- **Parser golden test (fast, use for iteration):** `node --test tests/parser-golden.test.mjs` — runs `extractTweets` against all fixture scenarios in `tests/fixtures/sanitized/*/` and compares to golden `expected.jsonl`. Sub-second, reports field-level diffs on failure. Use this as the inner loop when modifying the parser.
- **E2E test (slow, CI gate):** `cd tests/e2e && npm test` — launches Chromium + real extension + daemon + Fake X server. Auto-discovers all scenarios in `tests/fixtures/sanitized/`. Full pipeline integration proof.
- **Fixtures:** Parser fixture packs live under `tests/fixtures/`. Keep raw captures in `tests/fixtures/private-raw/` only (gitignored) and commit only sanitized packs from `tests/fixtures/sanitized/`. The anonymization methodology and review checklist are documented in `tests/fixtures/FIXTURES.md`.
- **Adding a fixture from a dump:** Discovery mode auto-dumps the first response per endpoint per session to the output dir as `dump-{endpoint}-{timestamp}.json` (in `{ endpoint, data }` envelope format). Feed directly to the sanitizer: `node tests/fixtures/tools/sanitize.mjs <dump-file> <scenario-name>`. This produces `tests/fixtures/sanitized/<scenario-name>/` with fixture.json, expected.jsonl, and manifest.json. Both parser and E2E tests pick it up automatically.
- **Workflow for supporting a new endpoint:** (1) Human enables discovery mode and browses X normally — dumps appear automatically for every endpoint, (2) run `node tests/fixtures/tools/sanitize.mjs <dump-file> <scenario-name>`, (3) run `node --test tests/parser-golden.test.mjs` — if it fails, the parser doesn't handle this endpoint yet, (4) fix the parser in `lib/tweet-parser.js`, (5) re-run parser test until green (ms feedback loop), (6) regenerate expected: re-run sanitize.mjs (overwrites).
- **Debugging:** Enable "Debug logging to file" in the debug dashboard (popup → "Debug Dashboard"). Logs write to `debug-YYYY-MM-DD.log` in the output directory. Service worker console is visible in each browser's extension debugger. The debug dashboard also shows live capture events with accept/dedup/error status, transport health, and a parser sandbox for testing `extractTweets` against raw JSON.
- **Dev mode seenIds:** In dev mode, `seenIds` uses `chrome.storage.session` when available (volatile — clears on extension reload). If session storage APIs are unavailable, it safely falls back to `chrome.storage.local`.
- **tweet-parser.js** is the most fragile file — it handles multiple GraphQL response shapes and X changes their API schema without notice. The recursive fallback (`findInstructionsRecursive`) catches many new endpoint shapes automatically, but field-level changes to tweet objects will need manual updates to `normalizeTweet()`.
- **Service worker module:** `background.js` is loaded as an ES module (`"type": "module"` in manifest). It imports `tweet-parser.js` directly.
- **HTTP daemon:** `xtap_daemon.py` binds `127.0.0.1:17381`. Auth token stored at `~/.xtap/secret` (mode 600). Managed by launchd (macOS: `launchctl kickstart -k gui/$(id -u)/com.xtap.daemon`), systemd (Linux: `systemctl --user restart com.xtap.daemon`), or Scheduled Task (Windows: `Stop-ScheduledTask -TaskName xTapDaemon; Start-ScheduledTask -TaskName xTapDaemon`). Logs: macOS/Windows at `~/.xtap/daemon-stderr.log`, Linux via `journalctl --user -u com.xtap.daemon`.
- **Transport debugging:** The popup shows connection status and auto-refreshes every 2s. When transport is unavailable, the popup and debug dashboard show an actionable error message. Service worker console logs transport selection at startup and reprobe attempts. Daemon startup diagnostics are always logged to `~/.xtap/daemon-stderr.log`; set `XTAP_LOG_LEVEL=debug` for request-level detail.
- **Release checklist:** (1) Bump `manifest.json` version, (2) bump `native-host/xtap_daemon.py` `VERSION`, (3) run `node scripts/build-firefox-manifest.js` to regenerate `manifest.firefox.json`. The manifest test validates version parity, so CI will catch a forgotten regeneration. (4) If any new files were added to the extension or native-host, **update the file list in `.github/workflows/release.yml`** — the release zip uses an explicit list, not a glob, so new files will be silently missing from releases if not added.
- **Firefox manifest:** `manifest.firefox.json` is generated from `manifest.json` — never edit it directly. The generator script (`scripts/build-firefox-manifest.js`) swaps `service_worker` → `scripts` and adds Gecko metadata.

## Contributing

- Keep it simple. No build tools, no frameworks, no dependencies beyond Python 3 stdlib.
- Run `python3 -m pytest tests/ -v && node --test tests/*.test.mjs` before submitting changes.
- Every change must maintain zero network footprint. This is the core promise.
- Stealth constraints are non-negotiable — review the list above before submitting changes.
- **Update README.md and AGENTS.md after every relevant change** — new features, changed behavior, new config options, output format changes, new endpoints, architectural changes, etc. Both files must stay in sync with the code.
