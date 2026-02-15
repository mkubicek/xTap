#!/bin/bash
# xTap — installer for the native messaging host and HTTP daemon (macOS / Linux).
# Usage: ./install.sh <chrome-extension-id>

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo "  Find your extension ID at chrome://extensions (enable Developer mode)"
  exit 1
fi

EXT_ID="$1"
HOST_NAME="com.xtap.host"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="${SCRIPT_DIR}/xtap_host.py"

OS="$(uname)"
case "$OS" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
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
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "xTap native messaging host — writes captured tweets to JSONL",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF

echo "Installed native messaging host manifest to:"
echo "  $MANIFEST_PATH"
echo ""
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

  # Substitute plist template
  mkdir -p "$HOME/Library/LaunchAgents"
  sed \
    -e "s|__PYTHON_PATH__|${PYTHON_PATH}|g" \
    -e "s|__DAEMON_PATH__|${DAEMON_PATH}|g" \
    -e "s|__HOME_DIR__|${HOME}|g" \
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

echo ""
echo "Output directory (set XTAP_OUTPUT_DIR to change):"
echo "  ${XTAP_OUTPUT_DIR:-$HOME/Downloads/xtap}"
