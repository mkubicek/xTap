<p align="center">
  <img src="icons/icon128.png" alt="xTap logo" width="96" />
</p>

<h1 align="center">xTap</h1>

<p align="center">
  <strong>Passively capture tweets as you browse X/Twitter</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#is-this-safe-to-use">Stealth</a> &middot;
  <a href="#output-format">Output Format</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/chrome-MV3-green" alt="Chrome MV3" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT License" />
  <a href="https://codecov.io/gh/mkubicek/xTap"><img src="https://codecov.io/gh/mkubicek/xTap/graph/badge.svg" alt="codecov" /></a>
</p>

---

xTap is a Chrome extension that silently intercepts the GraphQL API responses X/Twitter already sends to your browser and saves every tweet you encounter as structured JSONL. No scraping, no extra requests — just a tap on the data already flowing through.

## Features

- **Zero footprint** — no additional network requests; captures what Chrome already receives
- **Structured output** — each tweet saved as a clean JSON object with author, metrics, media, and more
- **Article support** — long-form X articles are captured with full text, inline image references, and Draft.js block structure
- **Video download** — download videos from tweets using yt-dlp (or direct MP4 fallback) via the extension popup. Requires the HTTP daemon. **Note:** unlike passive capture, video downloads make additional network requests to X and are not stealth.
- **Pause / resume** — click the extension icon to toggle capture on the fly
- **Live counter** — badge on the extension icon shows tweets captured this session
- **Multi-tab aware** — multiple X tabs feed into the same service worker with shared deduplication
- **Debug logging** — optional toggle to write timestamped service worker logs to a date-rotated file
- **Cross-platform** — works on macOS, Linux, and Windows

## How It Works

```
        X/Twitter GraphQL responses
                    │
                    ▼
     ┌────────────────────────────┐
     │     content-main.js        │  MAIN world
     │    patches fetch & XHR     │
     └──────────────┬─────────────┘
                    │ CustomEvent (random name)
                    ▼
     ┌────────────────────────────┐
     │     content-bridge.js      │  ISOLATED world
     │   relays to service worker │
     └──────────────┬─────────────┘
                    │ chrome.runtime.sendMessage
                    ▼
     ┌────────────────────────────┐
     │     background.js          │  Service worker
     │   parse, dedup, batch      │
     └──────────┬─────────┬───────┘
                │         │
          HTTP  │         │ native messaging
      (primary) │         │ (token bootstrap
                │         │  + data fallback)
                ▼         ▼
     ┌──────────────┐  ┌──────────────┐
     │ xtap_daemon  │  │ xtap_host.py │
     │ (HTTP)       │  │ (stdio)      │
     └──────┬───────┘  └──────┬───────┘
            │                 │
            ▼                 ▼
       tweets-YYYY-MM-DD.jsonl
```

1. A MAIN world content script patches `fetch` and `XMLHttpRequest.open()` to observe GraphQL responses as they arrive
2. Payloads are relayed via a random-named `CustomEvent` to an ISOLATED world bridge, which forwards them to the service worker
3. The service worker parses, normalizes, deduplicates, and batches tweets
4. Batches are sent to disk via one of two transports:
   - **HTTP daemon**: a standalone `xtap_daemon.py` process on `127.0.0.1:17381`, managed by launchd (macOS), systemd (Linux), or Scheduled Task (Windows). On macOS, it runs outside Chrome's TCC sandbox and can write to protected paths like `~/Documents` and iCloud Drive
   - **Native messaging**: `xtap_host.py` over Chrome's stdio protocol — used at startup to retrieve the daemon's auth token (`GET_TOKEN`), and as a data transport fallback if HTTP is unavailable

## Is This Safe to Use?

X is [rolling out stricter detection for automation and bots](https://x.com/nikitabier/status/2022496540275937525). The key line: *"If a human is not tapping on the screen, the account and all associated accounts will likely be suspended."*

**xTap is not a bot.** It doesn't post, like, follow, scroll, or make any API calls on your behalf. It sits in the background and reads the responses X already sent to your browser while *you* browse normally. From X's server-side perspective, your account looks identical to any other user — because you *are* a normal user. There is no extra traffic to detect.

The risk of automation enforcement applies to tools that *act* as you (auto-liking, auto-following, automated scrolling, headless browsers). xTap does none of that. It's the equivalent of keeping DevTools open and saving the Network tab — just automated into structured JSONL.

### Stealth Measures

Even though passive interception is inherently low-risk, xTap avoids leaving unnecessary traces:

- **No extra network requests** — only reads responses the browser already received; nothing to spot in a network log
- **Native-looking API patches** — `fetch` and `XMLHttpRequest.prototype.open` are patched with `toString()` overrides that return `[native code]`, passing the most common runtime integrity checks
- **No expando properties** — XHR URL tracking uses a `WeakMap` instead of attaching properties to the XHR instance, which would be trivially detectable
- **Random event channel** — the MAIN↔ISOLATED world bridge uses a `CustomEvent` with a per-page-load random name; the `<meta>` beacon that communicates the name is removed immediately after the bridge reads it
- **Zero DOM footprint** — no injected UI, no page modifications; everything lives in the popup and service worker
- **Zero console output in page context** — all logging happens in the service worker and parser, which run outside the page's JavaScript environment
- **Minimal permissions** — only `storage` and `nativeMessaging`; no `webRequest`, no host permissions beyond `x.com` / `twitter.com` / `127.0.0.1`
- **Jittered flush timing** — batches are flushed on a randomized interval to avoid a clockwork-regular pattern

These measures don't make detection impossible — a determined page script could still compare prototype references or probe for patched behavior — but they avoid the low-hanging signals that fingerprinting scripts typically check. More importantly, there's nothing to detect server-side because xTap generates zero network activity of its own.

## Installation

### Requirements

| | Requirement |
|---|---|
| **Browser** | Google Chrome |
| **Runtime** | Python 3 |
| **OS** | macOS, Linux, or Windows |
| [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#installation) (optional) | For best-quality video downloads |

### 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `xtap/` directory
4. Copy the **extension ID** shown on the card

### 2. Install the native host

<details>
<summary><strong>macOS</strong></summary>

```bash
cd native-host
./install.sh <your-extension-id>
```

This installs the native messaging host and an HTTP daemon (`xtap_daemon.py`) that runs via launchd. The daemon runs independently of Chrome's process tree and has its own TCC permissions, so it can write to protected paths like `~/Documents` and iCloud Drive. The installer captures your current `PATH` so the daemon can find tools like `yt-dlp`.

The extension automatically detects the daemon and uses it as the primary transport, falling back to native messaging if unavailable.

</details>

<details>
<summary><strong>Linux</strong></summary>

```bash
cd native-host
./install.sh <your-extension-id>
```

This installs the native messaging host and an HTTP daemon (`xtap_daemon.py`) that runs as a systemd user service. The daemon enables video downloads and provides the same HTTP transport as macOS.

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
cd native-host
.\install.ps1 <your-extension-id>
```

This installs the native messaging host and an HTTP daemon (`xtap_daemon.py`) as a Windows Scheduled Task that starts at logon. The daemon enables video downloads and provides the same HTTP transport as macOS/Linux.

</details>

### 3. Browse X

Open [x.com](https://x.com) and browse normally. The badge counter on the extension icon shows how many tweets have been captured this session. Click the icon to see stats and pause/resume capture.

> **After updating the extension:** If you reload xTap at `chrome://extensions`, you must also hard-reload any open X tabs (`Cmd+Shift+R` / `Ctrl+Shift+R`). The content scripts that intercept API responses are injected at page load — stale scripts from before the update won't connect to the new service worker.

### Upgrading from a previous version

After updating the extension files:
1. Re-run the installer (`install.sh` on macOS/Linux, `install.ps1` on Windows) — this updates the daemon's PATH (required for yt-dlp support) and picks up new Python code
2. Reload the extension at `chrome://extensions`
3. Hard-reload any open X tabs (`Cmd+Shift+R` / `Ctrl+Shift+R`)

If you previously installed xTap before v0.13.0 on macOS, re-running `install.sh` is **required** for video download support — the daemon needs an updated launchd configuration to find yt-dlp on your PATH. On Linux and Windows, the daemon is new in this version — running the installer will set it up automatically.

## Configuration

### Output directory

The easiest way to change where tweets are saved is through the extension popup — click the xTap icon and enter your preferred path in the **Output directory** field.

Alternatively, set the `XTAP_OUTPUT_DIR` environment variable before launching Chrome:

```bash
export XTAP_OUTPUT_DIR="$HOME/Documents/xtap-data"
```

| Setting | Default | Description |
|---|---|---|
| Popup "Output directory" | *(empty — uses default)* | Overrides the output path per-session |
| `XTAP_OUTPUT_DIR` env var | `~/Downloads/xtap` | Fallback when no popup setting is configured |
| Debug logging toggle | Off | Writes service worker logs to `debug-YYYY-MM-DD.log` in the output directory |
| Discovery mode toggle | Off | Logs endpoint response shapes and can dump full JSON responses to disk |

> **macOS note:** On macOS, the HTTP daemon (installed via `install.sh`) runs outside Chrome's TCC sandbox and can write to protected paths like `~/Documents` and iCloud Drive after a one-time macOS permission prompt. If the daemon is unavailable and the extension falls back to native messaging, protected paths will fail with a permission error — `~/Downloads` is the safe default in that case.

## Output Format

Output is written to daily files (`tweets-YYYY-MM-DD.jsonl`). Each line is a self-contained JSON object:

```jsonc
{
  "id": "1234567890",
  "url": "https://x.com/handle/status/1234567890",
  "created_at": "2024-01-01T00:00:00.000Z",
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
    "likes": 10,
    "retweets": 5,
    "replies": 2,
    "views": 1000,
    "bookmarks": 1,
    "quotes": 0
  },
  "media": [],
  "urls": [],
  "hashtags": [],
  "mentions": [],
  "in_reply_to": null,
  "quoted_tweet_id": null,
  "conversation_id": "1234567890",
  "is_retweet": false,
  "retweeted_tweet_id": null,
  "is_subscriber_only": false,          // true for subscriber-only tweets
  "is_article": true,                   // present only for long-form articles
  "article": {                          // present only for long-form articles
    "title": "Article Title",
    "text": "Rendered plain text with ![img](media/<id>/file.png) refs",
    "blocks": [],                       // raw Draft.js content_state blocks
    "media": [{                         // article image references
      "id": "...",
      "url": "https://pbs.twimg.com/...",  // original CDN URL
      "filename": "image.png",
      "local_path": "media/<tweet_id>/image.png",
      "width": 1200,
      "height": 800
    }]
  },
  "source_endpoint": "HomeTimeline",    // which GraphQL endpoint
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

For regular tweets, `is_article` and `article` are absent. For articles, `text` contains a markdown-style rendering of the article with inline image references pointing to `media/<tweet_id>/`.

## Project Structure

```
xTap/
├── manifest.json              # Chrome MV3 extension manifest
├── background.js              # Service worker — parsing, dedup, transport
├── content-main.js            # MAIN world — patches fetch/XHR, emits events
├── content-bridge.js          # ISOLATED world — relays events to service worker
├── popup.html/js/css          # Extension popup UI
├── icons/                     # Extension icons
├── lib/                       # Shared utilities
└── native-host/
    ├── xtap_core.py              # Shared file I/O logic
    ├── xtap_host.py              # Native messaging host (Python, stdio)
    ├── xtap_daemon.py            # HTTP daemon
    ├── com.xtap.daemon.plist     # launchd plist template (macOS)
    ├── com.xtap.daemon.service   # systemd unit template (Linux)
    ├── install.sh                # Installer for macOS / Linux
    ├── install.ps1               # Installer for Windows
    ├── xtap_host.bat             # Windows native host wrapper
    └── xtap_daemon.bat           # Windows daemon wrapper
```

## Development

After modifying extension files (`background.js`, `lib/`, `content-*.js`, `popup.*`), reload the extension at `chrome://extensions` and hard-reload any open X tabs.

After modifying Python host files (`xtap_core.py`, `xtap_host.py`, `xtap_daemon.py`), the native host picks up changes on next Chrome restart. To restart the HTTP daemon immediately:

**macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.xtap.daemon   # restart
launchctl bootout gui/$(id -u)/com.xtap.daemon         # stop
launchctl print gui/$(id -u)/com.xtap.daemon           # status
tail -f ~/.xtap/daemon-stderr.log                       # logs
```

**Linux (systemd):**
```bash
systemctl --user restart com.xtap.daemon               # restart
systemctl --user stop com.xtap.daemon                  # stop
systemctl --user status com.xtap.daemon                # status
journalctl --user -u com.xtap.daemon -f               # logs
```

**Windows (Scheduled Task, PowerShell):**
```powershell
Stop-ScheduledTask -TaskName xTapDaemon; Start-ScheduledTask -TaskName xTapDaemon  # restart
Stop-ScheduledTask -TaskName xTapDaemon                 # stop
Get-ScheduledTask -TaskName xTapDaemon                  # status
Get-Content ~\.xtap\daemon-stderr.log -Tail 50 -Wait   # logs
```

## Testing

```bash
python3 -m pytest tests/test_xtap_core.py -v
node --test tests/tweet-parser.test.mjs
```

CI runs these on every push to `main` with coverage uploaded to [Codecov](https://codecov.io/gh/mkubicek/xTap).

## License

[MIT](LICENSE) — use it however you like.
