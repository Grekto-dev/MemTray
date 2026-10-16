# MemTray (`memtray@cinnamon.org`)

**MemTray** is a clean-room implementation of the classic Windows **MemInfo** tray monitor for the **Cinnamon Desktop** taskbar.

It renders a live, customizable memory gauge and numeric readout directly in your Cinnamon panel and opens a rich popup menu (on right-click or left-click) displaying real-time physical memory, page file (swap / commit), top memory-consuming processes, a memory defragmenter, and a 5-tab settings window.

---

## Features

### 1. Live Taskbar Gauge & Readout
- **Dynamic Cairo + PangoCairo Tray Widget**:
  - **Vertical Left Gauge + Value** (default classic MemInfo layout, e.g. `[ || 23,7 ]`) or **Horizontal Bottom Bar** (`Bar at bottom`).
  - Displays either **Physical Memory (RAM)** or **Page File (Swap / Virtual Commit)**.
  - Displays either **Used Memory** or **Free Memory**.
  - Displays either **Actual Value** (`GB`/`MB`) or **Percentage** (`73` or `73%`).
  - Automatic bar color transitions based on configurable **Yellow** (default `65%`) and **Red** (default `90%`) warning thresholds.

### 2. Popup Menu (Right-Click / Left-Click)
- **Start Task Manager**: Launches `gnome-system-monitor` (or your configured task manager).
- **Memory Information Dashboard**:
  - Header line indicating what value is displayed in the tray (`Displaying used physical memory`, etc.).
  - `Memory Usage` (`%`)
  - `Physical Memory` (`Used GB/Total GB`)
  - `Page File` (`Used GB/Total GB`)
- **Top Memory Usage Processes**:
  - Lists the top `N` memory-consuming processes (default `10`).
  - **Unify the same processes**: Groups multiple instances of the same executable and shows `[count]` (e.g., `chrome [17]`, `python3 [4]`) with accurately aggregated memory.
  - **High-Usage Highlighting**: Highlights processes exceeding a configurable MB threshold (default `1000 MB`) with a customizable highlight bar color (`#b43434`).
  - **Application Icons & Friendly Names**: Resolves desktop application icons and supports toggling between binary module names and friendly process names.
  - **Click to Terminate**: Clicking a process row opens a confirmation dialog to gracefully terminate it (`SIGTERM`).
- **Memory Defragmenter**: Syncs filesystems and reclaims kernel caches (`drop_caches`), reporting the freed memory in a desktop notification.
- **Settings... / About... / Exit**: Direct access to the 5-tab `MemTray Settings` window, `About` dialog, and applet removal.

### 3. Five-Tab Settings Window (`MemTray Settings`)
Includes both native Cinnamon Applet Settings integration (`settings-schema.json`) and a standalone GTK3 **MemTray Settings** window (`memtray-settings.py`) replicating all 5 tabs of MemInfo:
1. **General**: Physical vs. Page File, Used vs. Free, Value vs. Percentage, Yellow/Red warning thresholds, and High Memory actions (Notification, Log file, Auto-defrag, Message box).
2. **Additional**: Periodic Memory Defragmenter timer, global Defrag Hotkey, refresh rate (ms), tray double-click action, DPMS screen-off on workstation lock, and icon tooltip toggle.
3. **Tray Menu**: Top process count, Memory Value vs. Percentage display, `> X MB` highlight threshold, process name vs. module name, process unification, and dashboard visibility toggles.
4. **Display**: Internal optimized font vs. custom font picker, use bar color for font color, transparent background, opaque bar, standard bar, bar at bottom, and `%` sign toggle.
5. **Themes**: Built-in and custom user-saved color themes (`Save As...` / `Delete`) plus granular color pickers for `Menu - Color Mode`, `Menu - Top Processes Highlight Color`, `Icon Tray - Text`, `Icon Tray - Background`, `Icon Bar - Background`, `Icon Bar - "Normal / Green"`, `Icon Bar - "Yellow"`, and `Icon Bar - "Red"`.

---

## Installation

```bash
git clone https://github.com/Grekto-dev/MemTray.git
cd MemTray
make install
```

Then enable **MemTray** in **Cinnamon Settings -> Applets**, or via CLI.

---

## CLI Control (`cinnamon-memtray-ctl`)

```bash
# Print current RAM, Page File, and Top 10 unified processes in terminal
cinnamon-memtray-ctl status

# Trigger immediate tray refresh
cinnamon-memtray-ctl refresh

# Trigger Memory Defragmenter
cinnamon-memtray-ctl defrag

# Open the 5-tab MemTray Settings dialog
cinnamon-memtray-ctl settings
```

---

## Running Tests

```bash
make test
```

---

## License

GNU General Public License v3.0 (GPL-3.0).
