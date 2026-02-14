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
  <a href="#staying-under-the-radar">Stealth</a> &middot;
  <a href="#output-format">Output Format</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/chrome-MV3-green" alt="Chrome MV3" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT License" />
</p>

---

xTap is a Chrome extension that silently intercepts the GraphQL API responses X/Twitter already sends to your browser and saves every tweet you encounter as structured JSONL. No scraping, no extra requests — just a tap on the data already flowing through.

## Features

- **Zero footprint** — no additional network requests; captures what Chrome already receives
- **Structured output** — each tweet saved as a clean JSON object with author, metrics, media, and more
- **Pause / resume** — click the extension icon to toggle capture on the fly
- **Live counter** — badge on the extension icon shows tweets captured this session
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
     └──────────────┬─────────────┘
                    │ native messaging
                    ▼
     ┌────────────────────────────┐
     │     xtap_host.py           │  Python
     │     append JSONL           │
     └──────────────┬─────────────┘
                    │
                    ▼
             tweets.jsonl
```

1. A MAIN world content script patches `fetch` and `XMLHttpRequest.open()` to observe GraphQL responses as they arrive
2. Payloads are relayed via a random-named `CustomEvent` to an ISOLATED world bridge, which forwards them to the service worker
3. The service worker parses, normalizes, deduplicates, and batches tweets
4. Batches are sent over Chrome native messaging to a Python host that appends each tweet as a JSON line to disk

## Staying Under the Radar

xTap is designed to be passive and hard to distinguish from normal browser activity:

- **No extra network requests** — only reads responses the browser already received; nothing to spot in a network log
- **Native-looking API patches** — `fetch` and `XMLHttpRequest.prototype.open` are patched with `toString()` overrides that return `[native code]`, passing the most common runtime integrity checks
- **No expando properties** — XHR URL tracking uses a `WeakMap` instead of attaching properties to the XHR instance, which would be trivially detectable
- **Random event channel** — the MAIN↔ISOLATED world bridge uses a `CustomEvent` with a per-page-load random name; the `<meta>` beacon that communicates the name is removed immediately after the bridge reads it
- **Zero console output in page context** — all logging happens in the service worker and parser, which run outside the page's JavaScript environment
- **Minimal permissions** — only `storage` and `nativeMessaging`; no `webRequest`, no host permissions beyond `x.com` / `twitter.com`

These measures don't make detection impossible — a determined page script could still compare prototype references or probe for patched behavior — but they avoid the low-hanging signals that fingerprinting scripts typically check.

## Installation

### Requirements

| | Requirement |
|---|---|
| **Browser** | Google Chrome |
| **Runtime** | Python 3 |
| **OS** | macOS, Linux, or Windows |

### 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `xtap/` directory
4. Copy the **extension ID** shown on the card

### 2. Install the native messaging host

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
cd native-host
./install.sh <your-extension-id>
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
cd native-host
.\install.ps1 <your-extension-id>
```

</details>

### 3. Browse X

Open [x.com](https://x.com) and browse normally. The badge counter on the extension icon shows how many tweets have been captured this session. Click the icon to see stats and pause/resume capture.

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

## Output Format

Each line in `tweets.jsonl` is a self-contained JSON object:

```jsonc
{
  "id": "1234567890",
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
  "source_endpoint": "HomeTimeline",    // which GraphQL endpoint
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

## Project Structure

```
xTap/
├── manifest.json          # Chrome MV3 extension manifest
├── background.js          # Service worker — parsing, dedup, native messaging
├── content-main.js        # MAIN world — patches fetch/XHR, emits events
├── content-bridge.js      # ISOLATED world — relays events to service worker
├── popup.html/js/css      # Extension popup UI
├── icons/                 # Extension icons
├── lib/                   # Shared utilities
└── native-host/
    ├── xtap_host.py       # Native messaging host (Python)
    ├── install.sh         # Installer for macOS / Linux
    ├── install.ps1        # Installer for Windows
    └── xtap_host.bat      # Windows Python wrapper
```

## License

[MIT](LICENSE) — use it however you like.
