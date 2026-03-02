#!/bin/bash
# xTap — installer for the native messaging host and HTTP daemon (macOS / Linux).
# Usage:
#   ./install.sh <extension-id> [chrome|firefox]
#   ./install.sh firefox [extension-id]

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Error: Do not run this script with sudo. It installs to user-level paths."
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "Usage:"
  echo "  $0 <extension-id> [chrome|firefox]"
  echo "  $0 firefox [extension-id]"
  echo ""
  echo "Chrome ID: chrome://extensions (Developer mode)"
  echo "Firefox ID default: xtap@mkubicek.dev (from manifest.firefox.json)"
  exit 1
fi

BROWSER="chrome"
EXT_ID=""
if [ "$1" = "chrome" ] || [ "$1" = "firefox" ]; then
  BROWSER="$1"
  EXT_ID="${2:-}"
else
  EXT_ID="$1"
  if [ $# -ge 2 ]; then
    BROWSER="$2"
  fi
fi

if [ "$BROWSER" != "chrome" ] && [ "$BROWSER" != "firefox" ]; then
  echo "Error: browser must be 'chrome' or 'firefox'"
  exit 1
fi

if [ "$BROWSER" = "firefox" ] && [ -z "$EXT_ID" ]; then
  EXT_ID="xtap@mkubicek.dev"
fi

if [ -z "$EXT_ID" ]; then
  echo "Error: extension ID is required for Chrome installs."
  echo "Find it at chrome://extensions (enable Developer mode)."
  exit 1
fi

HOST_NAME="com.xtap.host"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="${SCRIPT_DIR}/xtap_host.py"

OS="$(uname)"
case "$OS" in
  Darwin)
    if [ "$BROWSER" = "firefox" ]; then
      TARGET_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    else
      TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    fi
    ;;
  Linux)
    if [ "$BROWSER" = "firefox" ]; then
      TARGET_DIR="$HOME/.mozilla/native-messaging-hosts"
    else
      TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    fi
    ;;
  *)
    echo "Error: Unsupported OS '$OS'. Use install.ps1 on Windows."
    exit 1
    ;;
esac
MANIFEST_PATH="${TARGET_DIR}/${HOST_NAME}.json"

# Verify python3
PYTHON_PATH="$(command -v python3 2>/dev/null || true)"
if [ -z "$PYTHON_PATH" ]; then
  echo "Error: python3 is required but not found in PATH"
  exit 1
fi

# Make host executable
chmod +x "$HOST_PATH"

# Create target directory
mkdir -p "$TARGET_DIR"

# Write native messaging manifest
if [ "$BROWSER" = "firefox" ]; then
  cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "xTap native messaging host — writes captured tweets to JSONL",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_extensions": ["${EXT_ID}"]
}
EOF
else
  cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "xTap native messaging host — writes captured tweets to JSONL",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF
fi

echo "Installed native messaging host manifest to:"
echo "  $MANIFEST_PATH"
echo ""
echo "Browser: $BROWSER"
echo "Host script: $HOST_PATH"
echo "Extension ID: $EXT_ID"

# --- macOS: install HTTP daemon via launchd ---
if [ "$OS" = "Darwin" ]; then
  DAEMON_PATH="${SCRIPT_DIR}/xtap_daemon.py"
  XTAP_DIR="$HOME/.xtap"
  XTAP_SECRET="${XTAP_DIR}/secret"
  PLIST_LABEL="com.xtap.daemon"
  PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
  PLIST_TEMPLATE="${SCRIPT_DIR}/com.xtap.daemon.plist"

  chmod +x "$DAEMON_PATH"

  # Create ~/.xtap/ with restricted permissions
  mkdir -p "$XTAP_DIR"
  chmod 700 "$XTAP_DIR"

  # Generate auth token if not exists
  if [ ! -f "$XTAP_SECRET" ]; then
    python3 -c "import secrets; print(secrets.token_urlsafe(32))" > "$XTAP_SECRET"
    chmod 600 "$XTAP_SECRET"
    echo "Generated auth token: $XTAP_SECRET"
  else
    echo "Auth token already exists: $XTAP_SECRET"
  fi

  # Unload existing daemon if loaded (ignore errors)
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  # Wait for the service to fully unload before re-bootstrapping
  for i in 1 2 3 4 5; do
    launchctl print "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || break
    sleep 0.5
  done

  # Capture user's PATH so the daemon can find yt-dlp and other tools
  USER_PATH="$PATH"

  # Substitute plist template
  mkdir -p "$HOME/Library/LaunchAgents"
  sed \
    -e "s|__PYTHON_PATH__|${PYTHON_PATH}|g" \
    -e "s|__DAEMON_PATH__|${DAEMON_PATH}|g" \
    -e "s|__HOME_DIR__|${HOME}|g" \
    -e "s|__PATH__|${USER_PATH}|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"

  # Load daemon
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

  echo ""
  echo "HTTP daemon installed:"
  echo "  Plist: $PLIST_DEST"
  echo "  Daemon: $DAEMON_PATH"
  echo "  Listening on: 127.0.0.1:17381"
  echo "  Logs: ${XTAP_DIR}/daemon-stderr.log"
fi

# --- Linux: install HTTP daemon via systemd user service ---
if [ "$OS" = "Linux" ]; then
  DAEMON_PATH="${SCRIPT_DIR}/xtap_daemon.py"
  XTAP_DIR="$HOME/.xtap"
  XTAP_SECRET="${XTAP_DIR}/secret"
  SERVICE_NAME="com.xtap.daemon"
  SERVICE_TEMPLATE="${SCRIPT_DIR}/${SERVICE_NAME}.service"
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_DEST="${SERVICE_DIR}/${SERVICE_NAME}.service"

  chmod +x "$DAEMON_PATH"

  # Create ~/.xtap/ with restricted permissions
  mkdir -p "$XTAP_DIR"
  chmod 700 "$XTAP_DIR"

  # Generate auth token if not exists
  if [ ! -f "$XTAP_SECRET" ]; then
    python3 -c "import secrets; print(secrets.token_urlsafe(32))" > "$XTAP_SECRET"
    chmod 600 "$XTAP_SECRET"
    echo "Generated auth token: $XTAP_SECRET"
  else
    echo "Auth token already exists: $XTAP_SECRET"
  fi

  # Capture user's PATH so the daemon can find yt-dlp and other tools
  USER_PATH="$PATH"

  # Substitute service template
  mkdir -p "$SERVICE_DIR"
  sed \
    -e "s|__PYTHON_PATH__|${PYTHON_PATH}|g" \
    -e "s|__DAEMON_PATH__|${DAEMON_PATH}|g" \
    -e "s|__HOME_DIR__|${HOME}|g" \
    -e "s|__PATH__|${USER_PATH}|g" \
    "$SERVICE_TEMPLATE" > "$SERVICE_DEST"

  # Reload and enable
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"

  echo ""
  echo "HTTP daemon installed:"
  echo "  Service: $SERVICE_DEST"
  echo "  Daemon: $DAEMON_PATH"
  echo "  Listening on: 127.0.0.1:17381"
  echo ""
  echo "Useful commands:"
  echo "  systemctl --user status $SERVICE_NAME"
  echo "  journalctl --user -u $SERVICE_NAME -f"
fi

echo ""
echo "Output directory (set XTAP_OUTPUT_DIR to change):"
echo "  ${XTAP_OUTPUT_DIR:-$HOME/Downloads/xtap}"
