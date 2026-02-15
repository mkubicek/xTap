# AGENTS.md - xTap

## What This Is

xTap is a Chrome extension that passively captures tweets from X/Twitter by intercepting GraphQL API responses the browser already receives. No scraping, no extra requests — just structured JSONL output of what the user sees.

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
  │  Deduplicates (Set of seen IDs, max 50k, persisted to chrome.storage.local)
  │  Batches (50 tweets or 30–45s jittered flush)
  │  Debug logging: intercepts console.log/warn/error, sends to host
  │  Transport abstraction: tries HTTP daemon first, falls back to native messaging
  ▼
┌─── HTTP transport (macOS) ──────────────────────────────────────┐
│ xtap_daemon.py (127.0.0.1:17381, launchd)                      │
│   Runs outside Chrome's process tree — has own TCC permissions  │
│   Bearer token auth from ~/.xtap/secret                         │
│   Endpoints: GET /status, POST /tweets, /log, /test-path        │
└─────────────────────────────────────────────────────────────────┘
┌─── Native messaging (fallback / Linux / Windows) ───────────────┐
│ xtap_host.py (Python, stdio)                                    │
│   Chrome native messaging protocol                              │
│   Also serves GET_TOKEN to bootstrap HTTP transport              │
└─────────────────────────────────────────────────────────────────┘
  │  Both use shared logic from xtap_core.py
  ▼
tweets-YYYY-MM-DD.jsonl  (daily rotation)
debug-YYYY-MM-DD.log     (when debug logging enabled)
```

### Key Design Decisions

- **Two content scripts (MAIN + ISOLATED):** Chrome MV3 requires this split. MAIN world can patch browser APIs but can't use chrome.runtime. ISOLATED world bridges the gap.
- **Random event channel:** The CustomEvent name is generated per page load (`'_' + Math.random().toString(36).slice(2)`) and passed via a `<meta>` tag that's immediately removed. Avoids predictable DOM markers.
- **Dual transport (HTTP + native messaging):** On macOS, a launchd-managed HTTP daemon (`xtap_daemon.py`) runs independently of Chrome's TCC sandbox, allowing writes to protected paths. The extension tries HTTP first, falls back to native messaging. On Linux/Windows, only native messaging is used.
- **Token bootstrap:** On first run with the daemon installed, the extension connects to the native host once to request `GET_TOKEN`, which reads `~/.xtap/secret`. The token is cached in `chrome.storage.local` and used for subsequent HTTP requests. The native port is then disconnected.
- **Shared core logic:** `xtap_core.py` contains all file I/O logic (load seen IDs, resolve output dir, write tweets/logs, test path), used by both `xtap_host.py` and `xtap_daemon.py`.
- **Dedup in service worker:** Multiple tabs feed the same service worker. `seenIds` Set (max 50,000, FIFO eviction) prevents duplicates. Persisted to `chrome.storage.local` across sessions. Both host and daemon also load seen IDs from existing JSONL files on startup.
- **Jittered flush:** Batch flush uses `setTimeout` with randomized interval (30s base + up to 50% jitter = 30–45s), re-randomized each cycle. Avoids clockwork-regular patterns.
- **Path validation:** When the user sets a custom output directory, the service worker sends a `TEST_PATH` message (via HTTP or native), which attempts `makedirs` + write/delete of a temp file before accepting the path.
- **Error resilience:** The native host wraps per-message handling in try/except and responds with `{ok: false, error: "..."}` instead of crashing. The HTTP daemon returns error status codes. The service worker tracks rapid disconnects to detect crash loops and auto-falls back from HTTP to native on failure.

## Stealth Constraints

**These are non-negotiable. xTap must remain completely passive.**

1. **Zero extra network requests** — never fetch, POST, or call any X/Twitter endpoint. The extension only reads responses the browser already received.
2. **Native-looking patches** — `toString()` on patched `fetch` returns `'function fetch() { [native code] }'`. `XHR.open` toString returns the original native string. `fetch.name` is set to `'fetch'` via `Object.defineProperty`.
3. **No expando properties** — XHR URL tracking uses a `WeakMap`, never attaches properties to instances.
4. **No DOM footprint** — no injected elements, no visible page modifications. The only transient artifact is the `<meta name="__cfg">` tag, removed within milliseconds by the bridge script.
5. **No console output in page context** — all logging happens in the service worker, which runs outside the page's JavaScript environment.
6. **Minimal permissions** — only `storage` and `nativeMessaging`. Host permissions scoped to `x.com`, `twitter.com`, and `127.0.0.1` (local daemon only). No `webRequest`, no `tabs`, no `scripting`, no web-accessible resources.
7. **Random event channel** — per-page-load name, meta tag removed immediately after reading.
8. **Only `open()` patched on XHR** — `send()` is not patched, so non-GraphQL XHR calls have clean stack traces.

**Any change that adds network requests to X/Twitter domains must be rejected.**

## File Structure

```
xTap/
├── manifest.json              # MV3 manifest (permissions: storage, nativeMessaging)
├── background.js              # Service worker (ES module) - transport, parsing, dedup
├── content-main.js            # MAIN world - fetch/XHR patching
├── content-bridge.js          # ISOLATED world - event relay
├── popup.html/js/css          # Extension popup (stats, pause/resume, output dir, debug toggle)
├── icons/                     # Extension icons (16, 48, 128)
├── lib/
│   └── tweet-parser.js        # GraphQL response → normalized tweet objects
└── native-host/
    ├── xtap_core.py           # Shared file I/O logic (used by host + daemon)
    ├── xtap_host.py           # Native messaging host (Python, stdio protocol)
    ├── xtap_daemon.py         # HTTP daemon (macOS, launchd, 127.0.0.1:17381)
    ├── com.xtap.daemon.plist  # launchd plist template
    ├── com.xtap.host.json     # Native messaging host manifest
    ├── install.sh             # macOS/Linux installer (+ daemon on macOS)
    ├── install.ps1            # Windows installer
    └── xtap_host.bat          # Windows Python wrapper
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

On macOS, Chrome's native messaging host inherits Chrome's TCC sandbox. After Chrome restarts, writes to protected paths (`~/Documents`, iCloud Drive, etc.) can fail with `PermissionError`.

**Solution:** The HTTP daemon (`xtap_daemon.py`) runs via launchd, independent of Chrome's process tree. It has its own TCC entitlements and can write to protected paths after a one-time macOS permission prompt. The extension automatically uses the daemon when available, falling back to native messaging otherwise.

If falling back to native messaging, `~/Downloads/xtap` is the safe default (no TCC required). The path validation feature catches permission errors at save time.

### Tombstone tweets

X sometimes returns `TimelineTweet` entries where `tweet_results.result` is missing (deleted/suspended tweets). These are skipped by the parser. Since no ID is extracted, they don't enter `seenIds` — if the tweet later appears with full data, it will be captured.

## Development Notes

- **No build step** — plain JS, no bundler, no transpilation. Load and go.
- **Testing:** Load unpacked at `chrome://extensions` with Developer mode. The extension ID changes per install — update `com.xtap.host.json` and re-run the install script.
- **Debugging:** Enable "Debug logging to file" in the popup. Logs write to `debug-YYYY-MM-DD.log` in the output directory. Service worker console is also visible at `chrome://extensions` → xTap → "Inspect views: service worker".
- **tweet-parser.js** is the most fragile file — it handles multiple GraphQL response shapes and X changes their API schema without notice. The recursive fallback (`findInstructionsRecursive`) catches many new endpoint shapes automatically, but field-level changes to tweet objects will need manual updates to `normalizeTweet()`.
- **Service worker module:** `background.js` is loaded as an ES module (`"type": "module"` in manifest). It imports `tweet-parser.js` directly.
- **HTTP daemon (macOS):** `xtap_daemon.py` binds `127.0.0.1:17381`. Auth token stored at `~/.xtap/secret` (mode 600). Logs at `~/.xtap/daemon-stderr.log`. Manage with `launchctl`: `launchctl kickstart -k gui/$(id -u)/com.xtap.daemon` to restart, `launchctl bootout gui/$(id -u)/com.xtap.daemon` to stop.
- **Transport debugging:** The popup shows "(HTTP daemon)" or "(Native host)" next to the status. Service worker console logs which transport was selected at startup.

## Contributing

- Keep it simple. No build tools, no frameworks, no dependencies beyond Python 3 stdlib.
- Every change must maintain zero network footprint. This is the core promise.
- Stealth constraints are non-negotiable — review the list above before submitting changes.
- **Update README.md and AGENTS.md after every relevant change** — new features, changed behavior, new config options, output format changes, new endpoints, architectural changes, etc. Both files must stay in sync with the code.
