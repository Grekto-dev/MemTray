#!/usr/bin/env bash
set -e

# ==============================================================================
# MemTray Cinnamon Applet Installation Script
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="memtray@cinnamon.org"
TARGET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"
BIN_DIR="$HOME/.local/bin"

echo "=== Installing MemTray Cinnamon Applet ($UUID) ==="

# 1. Ensure target directory exists
mkdir -p "$HOME/.local/share/cinnamon/applets"

# 2. Copy or update applet files
if [ -d "$TARGET_DIR" ]; then
    echo "Updating existing installation in $TARGET_DIR..."
    rm -rf "$TARGET_DIR"
fi

mkdir -p "$TARGET_DIR"
cp -r "$SCRIPT_DIR/$UUID/"* "$TARGET_DIR/"
chmod +x "$TARGET_DIR/memtray-settings.py" "$TARGET_DIR/memtray-about.py"

echo "✓ Applet files installed to $TARGET_DIR"

# 3. Install CLI control tool
mkdir -p "$BIN_DIR"
cp "$SCRIPT_DIR/bin/cinnamon-memtray-ctl" "$BIN_DIR/"
chmod +x "$BIN_DIR/cinnamon-memtray-ctl"
echo "✓ CLI utility 'cinnamon-memtray-ctl' installed to $BIN_DIR"

echo ""
echo "=== Installation completed successfully! ==="
echo ""
echo "Next steps to activate MemTray in Cinnamon:"
echo "1. Open Cinnamon Settings -> Applets (or run: cinnamon-settings applets)"
echo "2. Find 'MemTray' in the Manage tab and click '+' to add it to your panel"
echo "3. Right-click or left-click the MemTray icon in the taskbar to open the MemInfo menu!"
echo ""
