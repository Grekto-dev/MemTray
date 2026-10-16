// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * MemTray - Clean-room Memory & Process Monitoring Engine
 *
 * Reads /proc/meminfo and /proc/[pid]/* to provide:
 * - Physical Memory (RAM) & Page File (Swap / Commit) statistics
 * - Top memory-consuming processes with unification, friendly names, and icon lookup
 * - MemInfo-compatible number and dashboard formatting
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const ByteArray = imports.byteArray;

var PAGE_SIZE = 4096;
var BYTES_PER_MB = 1048576;
var BYTES_PER_GB = 1073741824;

/**
 * Converts a Uint8Array / ByteArray to string safely in GJS.
 */
function bytesToString(bytes) {
    if (!bytes) return "";
    if (typeof bytes === 'string') return bytes;
    try {
        return ByteArray.toString(bytes);
    } catch (e) {
        try {
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e2) {
            return String(bytes);
        }
    }
}

/**
 * Formats a byte value in GB matching MemInfo's style:
 * - Up to 2 decimal places
 * - Strips trailing zero in 2nd decimal place (e.g. 27.80 -> "27,8", 23.46 -> "23,46")
 * - Uses comma ',' decimal separator
 */
function formatGB(bytes, fixedDecimals = null) {
    let gb = Math.max(0, bytes) / BYTES_PER_GB;
    if (fixedDecimals !== null) {
        return gb.toFixed(fixedDecimals).replace('.', ',');
    }
    let str = gb.toFixed(2);
    if (str.endsWith('0') && !str.endsWith('.00')) {
        str = str.slice(0, -1);
    }
    return str.replace('.', ',');
}

/**
 * Formats a pair of byte values for the dashboard: "23,46 GB/31,76 GB"
 */
function formatDashboardPair(currentBytes, totalBytes) {
    return `${formatGB(currentBytes)} GB/${formatGB(totalBytes)} GB`;
}

/**
 * Formats the compact text shown inside the tray icon:
 * - Percentage mode: "73" or "73%"
 * - Value mode: "23,7" (for >= 0.1 GB), integer for >= 100 GB, or MB if < 0.1 GB
 */
function formatTrayValue(memStats, options = {}) {
    let showPageFile = Boolean(options.showPageFile);
    let showFreeMemory = Boolean(options.showFreeMemory);
    let showPercentage = Boolean(options.showPercentage);
    let showPercentSign = Boolean(options.showPercentSign);

    let usedBytes = showPageFile ? memStats.pageUsed : memStats.ramUsed;
    let freeBytes = showPageFile ? memStats.pageFree : memStats.ramFree;
    let usedPct = showPageFile ? memStats.pagePercent : memStats.ramPercent;

    if (showPercentage) {
        let pct = showFreeMemory ? Math.max(0, 100 - usedPct) : usedPct;
        return showPercentSign ? `${pct}%` : `${pct}`;
    }

    let targetBytes = showFreeMemory ? freeBytes : usedBytes;
    let gb = targetBytes / BYTES_PER_GB;
    if (gb >= 100) {
        return `${Math.round(gb)}`;
    }
    if (gb >= 10) {
        return gb.toFixed(1).replace('.', ',');
    }
    if (gb >= 0.01 || targetBytes === 0) {
        return gb.toFixed(2).replace('.', ',');
    }
    return `${Math.max(1, Math.round(targetBytes / BYTES_PER_MB))}`;
}

/**
 * Returns the active bar fill ratio (0.0 to 1.0) and percentage (0 to 100)
 * based on whether physical memory or page file is selected.
 */
function getActiveUsagePercent(memStats, options = {}) {
    let showPageFile = Boolean(options.showPageFile);
    let pct = showPageFile ? memStats.pagePercent : memStats.ramPercent;
    return Math.max(0, Math.min(100, pct));
}

/**
 * Returns the dashboard header text describing what value is displayed in the tray.
 */
function getDashboardHeaderText(options = {}) {
    let showPageFile = Boolean(options.showPageFile);
    let showFreeMemory = Boolean(options.showFreeMemory);

    if (showPageFile) {
        return showFreeMemory
            ? "Displaying free page file"
            : "Displaying used page file";
    }
    return showFreeMemory
        ? "Displaying free physical memory"
        : "Displaying used physical memory";
}

/**
 * Formats an individual process's memory usage for the tray menu:
 * - "value": "8,97 GB" (if >= 1 GB) or "792 MB" (if < 1 GB)
 * - "percent": "28,2%"
 */
function formatProcessMemory(bytes, totalRamBytes, displayMode = "value") {
    if (displayMode === "percent") {
        let pct = totalRamBytes > 0 ? (bytes / totalRamBytes) * 100 : 0;
        return `${pct.toFixed(1).replace('.', ',')}%`;
    }
    if (bytes >= BYTES_PER_GB) {
        return `${formatGB(bytes)} GB`;
    }
    let mb = Math.max(1, Math.round(bytes / BYTES_PER_MB));
    return `${mb} MB`;
}

/**
 * Parses /proc/meminfo content into structured memory & page file statistics.
 *
 * @param {string} content Raw text from /proc/meminfo
 * @param {string} pageFileMode "commit" (RAM + Swap, Windows Page File style) or "swap" (Swap only)
 */
function parseMemInfo(content, pageFileMode = "commit") {
    let values = {};
    if (content && typeof content === 'string') {
        let lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            let key = line.substring(0, colonIdx).trim();
            let rest = line.substring(colonIdx + 1).trim();
            let num = parseInt(rest, 10);
            if (!isNaN(num)) {
                // /proc/meminfo values are in kB (1024 bytes)
                values[key] = num * 1024;
            }
        }
    }

    let ramTotal = values.MemTotal || 0;
    let ramAvailable = values.MemAvailable;
    if (ramAvailable === undefined) {
        let free = values.MemFree || 0;
        let buffers = values.Buffers || 0;
        let cached = values.Cached || 0;
        let sreclaimable = values.SReclaimable || 0;
        let shmem = values.Shmem || 0;
        ramAvailable = Math.max(0, free + buffers + cached + sreclaimable - shmem);
    }

    let ramUsed = Math.max(0, ramTotal - ramAvailable);
    let ramFree = Math.max(0, ramAvailable);
    let ramPercent = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;

    let swapTotal = values.SwapTotal || 0;
    let swapFree = values.SwapFree || 0;
    let swapUsed = Math.max(0, swapTotal - swapFree);
    let swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

    // In Windows MemInfo, "Page File" represents total system Commit Charge (RAM + Pagefile)
    // We support both Windows-style Commit Charge ("commit") and pure Linux Swap ("swap").
    let pageTotal, pageUsed, pageFree, pagePercent;
    if (pageFileMode === "swap" && swapTotal > 0) {
        pageTotal = swapTotal;
        pageUsed = swapUsed;
        pageFree = swapFree;
        pagePercent = swapPercent;
    } else {
        pageTotal = ramTotal + swapTotal;
        pageUsed = ramUsed + swapUsed;
        pageFree = Math.max(0, pageTotal - pageUsed);
        pagePercent = pageTotal > 0 ? Math.round((pageUsed / pageTotal) * 100) : 0;
    }

    return {
        ramTotal,
        ramUsed,
        ramFree,
        ramPercent,
        swapTotal,
        swapUsed,
        swapFree,
        swapPercent,
        pageTotal,
        pageUsed,
        pageFree,
        pagePercent,
        buffers: values.Buffers || 0,
        cached: values.Cached || 0,
        shared: values.Shmem || 0
    };
}

/**
 * Reads current memory statistics from /proc/meminfo.
 */
function readMemoryStats(pageFileMode = "commit") {
    try {
        let [ok, bytes] = GLib.file_get_contents("/proc/meminfo");
        if (ok && bytes) {
            return parseMemInfo(bytesToString(bytes), pageFileMode);
        }
    } catch (e) {
        // Ignore read error
    }
    return parseMemInfo("", pageFileMode);
}

/**
 * Extracts clean module/binary name from /proc/[pid]/comm and /proc/[pid]/cmdline.
 */
function extractModuleName(comm, cmdlineBytes) {
    let baseComm = (comm || "").trim();
    if (cmdlineBytes && cmdlineBytes.length > 0) {
        // cmdline args are NUL-separated
        let firstNull = -1;
        for (let i = 0; i < cmdlineBytes.length; i++) {
            if (cmdlineBytes[i] === 0) {
                firstNull = i;
                break;
            }
        }
        let arg0Bytes = firstNull >= 0 ? cmdlineBytes.slice(0, firstNull) : cmdlineBytes;
        let arg0 = bytesToString(arg0Bytes).trim();
        if (arg0) {
            // Handle cases like "/usr/bin/python3 script.py" or "/app/extra/chrome --type=zygote"
            let firstToken = arg0.split(/\s+/)[0];
            let slashIdx = firstToken.lastIndexOf('/');
            let base = slashIdx >= 0 ? firstToken.substring(slashIdx + 1) : firstToken;
            // Ignore generic wrapper names if comm is more specific
            if (base && base !== "sh" && base !== "bash" && base !== "env" && !base.startsWith("-")) {
                return base;
            }
        }
    }
    return baseComm || "unknown";
}

/**
 * Desktop application metadata cache for resolving friendly process names and icons.
 */
class AppMetadataResolver {
    constructor() {
        this._byKey = {};
        this._lastRefresh = 0;
        this._initFallbackMap();
    }

    _initFallbackMap() {
        this._fallbackIcons = {
            "chrome": { icon: "google-chrome", friendlyName: "Google Chrome" },
            "google-chrome": { icon: "google-chrome", friendlyName: "Google Chrome" },
            "google-chrome-stable": { icon: "google-chrome", friendlyName: "Google Chrome" },
            "chromium": { icon: "chromium-browser", friendlyName: "Chromium" },
            "firefox": { icon: "firefox", friendlyName: "Firefox" },
            "firefox-bin": { icon: "firefox", friendlyName: "Firefox" },
            "cinnamon": { icon: "cinnamon", friendlyName: "Cinnamon Desktop" },
            "nemo": { icon: "nemo", friendlyName: "Nemo File Manager" },
            "nemo-desktop": { icon: "nemo", friendlyName: "Nemo Desktop" },
            "vlc": { icon: "vlc", friendlyName: "VLC media player" },
            "code": { icon: "com.visualstudio.code", friendlyName: "Visual Studio Code" },
            "antigravity": { icon: "utilities-terminal", friendlyName: "Antigravity IDE" },
            "language_server": { icon: "applications-development", friendlyName: "Language Server" },
            "python": { icon: "applications-development", friendlyName: "Python" },
            "python3": { icon: "applications-development", friendlyName: "Python 3" },
            "node": { icon: "applications-development", friendlyName: "Node.js" },
            "xorg": { icon: "video-display", friendlyName: "Xorg Display Server" },
            "xwayland": { icon: "video-display", friendlyName: "Xwayland" },
            "mintupdate": { icon: "mintupdate", friendlyName: "Update Manager" },
            "mintreport-tray": { icon: "mintreport", friendlyName: "System Reports" },
            "gnome-system-monitor": { icon: "utilities-system-monitor", friendlyName: "System Monitor" },
            "gnome-terminal-server": { icon: "utilities-terminal", friendlyName: "Terminal" },
            "bash": { icon: "utilities-terminal", friendlyName: "Bash Shell" },
            "zsh": { icon: "utilities-terminal", friendlyName: "Zsh Shell" },
            "docker": { icon: "applications-system", friendlyName: "Docker" },
            "containerd": { icon: "applications-system", friendlyName: "Containerd" }
        };
    }

    refreshIfNeeded() {
        let now = GLib.get_monotonic_time();
        // Refresh at most once every 60 seconds
        if (this._lastRefresh > 0 && (now - this._lastRefresh) < 60000000) {
            return;
        }
        this._lastRefresh = now;
        try {
            let apps = Gio.AppInfo.get_all();
            for (let i = 0; i < apps.length; i++) {
                let app = apps[i];
                let name = app.get_display_name() || app.get_name();
                let gicon = app.get_icon();
                let exec = app.get_executable();
                if (exec) {
                    let slash = exec.lastIndexOf('/');
                    let base = (slash >= 0 ? exec.substring(slash + 1) : exec).toLowerCase();
                    if (base && !this._byKey[base]) {
                        this._byKey[base] = { friendlyName: name, gicon: gicon };
                    }
                }
                let id = app.get_id();
                if (id) {
                    let cleanId = id.replace(/\.desktop$/i, '').toLowerCase();
                    if (!this._byKey[cleanId]) {
                        this._byKey[cleanId] = { friendlyName: name, gicon: gicon };
                    }
                }
            }
        } catch (e) {
            // Ignore desktop database enumeration errors
        }
    }

    resolve(moduleName, comm) {
        this.refreshIfNeeded();
        let candidates = [
            (moduleName || "").toLowerCase(),
            (comm || "").toLowerCase(),
            (moduleName || "").toLowerCase().replace(/-bin$/, '')
        ];

        for (let i = 0; i < candidates.length; i++) {
            let key = candidates[i];
            if (!key) continue;
            if (this._byKey[key]) {
                return {
                    friendlyName: this._byKey[key].friendlyName || moduleName,
                    gicon: this._byKey[key].gicon || null,
                    iconName: this._fallbackIcons[key] ? this._fallbackIcons[key].icon : "application-x-executable"
                };
            }
            if (this._fallbackIcons[key]) {
                return {
                    friendlyName: this._fallbackIcons[key].friendlyName || moduleName,
                    gicon: null,
                    iconName: this._fallbackIcons[key].icon
                };
            }
        }

        return {
            friendlyName: moduleName || comm || "unknown",
            gicon: null,
            iconName: "application-x-executable"
        };
    }
}

/**
 * Unifies and sorts a raw list of process records according to MemInfo settings.
 *
 * Each raw record: { pid, comm, moduleName, friendlyName, rssBytes, privBytes, sharedBytes, gicon, iconName }
 *
 * @param {Array} rawProcesses
 * @param {Object} options
 *   - unifyProcesses {boolean} (default true): group processes with the same key
 *   - showProcessName {boolean} (default false): use friendlyName instead of moduleName
 *   - topCount {number} (default 10): number of top processes to return
 *   - highlightProcesses {boolean} (default true): whether to mark processes above threshold
 *   - highlightThresholdMB {number} (default 1000): threshold in MB
 *   - processDisplayMode {string} ("value" | "percent")
 *   - totalRamBytes {number}
 */
function aggregateProcesses(rawProcesses, options = {}) {
    let unify = options.unifyProcesses !== undefined ? Boolean(options.unifyProcesses) : true;
    let showProcessName = Boolean(options.showProcessName);
    let topCount = Math.max(1, Math.min(50, parseInt(options.topCount, 10) || 10));
    let highlightProcesses = options.highlightProcesses !== undefined ? Boolean(options.highlightProcesses) : true;
    let highlightThresholdMB = parseFloat(options.highlightThresholdMB);
    if (isNaN(highlightThresholdMB)) highlightThresholdMB = 1000;
    let highlightThresholdBytes = highlightThresholdMB * BYTES_PER_MB;
    let displayMode = options.processDisplayMode || "value";
    let totalRamBytes = options.totalRamBytes || 0;

    let items = [];

    if (unify) {
        let groups = new Map();
        for (let i = 0; i < rawProcesses.length; i++) {
            let p = rawProcesses[i];
            let baseLabel = showProcessName
                ? (p.friendlyName || p.moduleName || p.comm)
                : (p.moduleName || p.comm);
            let groupKey = baseLabel.toLowerCase();

            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    name: baseLabel,
                    moduleName: p.moduleName || p.comm,
                    friendlyName: p.friendlyName || baseLabel,
                    count: 1,
                    pids: [p.pid],
                    privSum: p.privBytes,
                    maxShared: p.sharedBytes,
                    rssSum: p.rssBytes,
                    gicon: p.gicon || null,
                    iconName: p.iconName || "application-x-executable"
                });
            } else {
                let g = groups.get(groupKey);
                g.count += 1;
                g.pids.push(p.pid);
                g.privSum += p.privBytes;
                if (p.sharedBytes > g.maxShared) {
                    g.maxShared = p.sharedBytes;
                }
                g.rssSum += p.rssBytes;
                if (!g.gicon && p.gicon) {
                    g.gicon = p.gicon;
                }
            }
        }

        groups.forEach((g) => {
            // Accurate working set for unified processes: sum of private pages + shared pages once
            let effectiveBytes = g.count === 1 ? g.rssSum : (g.privSum + g.maxShared);
            let displayName = g.count > 1 ? `${g.name} [${g.count}]` : g.name;
            items.push({
                displayName,
                baseName: g.name,
                count: g.count,
                pids: g.pids,
                memoryBytes: effectiveBytes,
                memoryMB: effectiveBytes / BYTES_PER_MB,
                formattedMemory: formatProcessMemory(effectiveBytes, totalRamBytes, displayMode),
                isHighlighted: highlightProcesses && (effectiveBytes >= highlightThresholdBytes),
                gicon: g.gicon,
                iconName: g.iconName
            });
        });
    } else {
        for (let i = 0; i < rawProcesses.length; i++) {
            let p = rawProcesses[i];
            let baseLabel = showProcessName
                ? (p.friendlyName || p.moduleName || p.comm)
                : (p.moduleName || p.comm);
            let effectiveBytes = p.rssBytes;
            items.push({
                displayName: baseLabel,
                baseName: baseLabel,
                count: 1,
                pids: [p.pid],
                memoryBytes: effectiveBytes,
                memoryMB: effectiveBytes / BYTES_PER_MB,
                formattedMemory: formatProcessMemory(effectiveBytes, totalRamBytes, displayMode),
                isHighlighted: highlightProcesses && (effectiveBytes >= highlightThresholdBytes),
                gicon: p.gicon || null,
                iconName: p.iconName || "application-x-executable"
            });
        }
    }

    items.sort((a, b) => b.memoryBytes - a.memoryBytes);
    return items.slice(0, topCount);
}

const _defaultResolver = new AppMetadataResolver();

/**
 * Scans /proc for running user/system processes and returns the top memory consumers.
 */
function getTopProcesses(options = {}, resolver = _defaultResolver) {
    let rawProcesses = [];
    try {
        let procDir = Gio.File.new_for_path("/proc");
        let enumerator = procDir.enumerate_children(
            "standard::name,standard::type",
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            let pidStr = info.get_name();
            if (!/^\d+$/.test(pidStr)) continue;

            try {
                let [okStatm, statmBytes] = GLib.file_get_contents(`/proc/${pidStr}/statm`);
                if (!okStatm || !statmBytes) continue;

                let statmStr = bytesToString(statmBytes).trim();
                let parts = statmStr.split(/\s+/);
                if (parts.length < 3) continue;

                let residentPages = parseInt(parts[1], 10);
                let sharedPages = parseInt(parts[2], 10);
                if (isNaN(residentPages) || residentPages <= 0) continue;

                let rssBytes = residentPages * PAGE_SIZE;
                let sharedBytes = Math.max(0, (isNaN(sharedPages) ? 0 : sharedPages) * PAGE_SIZE);
                let privBytes = Math.max(0, rssBytes - sharedBytes);

                let [okComm, commBytes] = GLib.file_get_contents(`/proc/${pidStr}/comm`);
                let comm = okComm && commBytes ? bytesToString(commBytes).trim() : "";
                if (!comm) continue;

                let cmdlineBytes = null;
                try {
                    let [okCmd, cBytes] = GLib.file_get_contents(`/proc/${pidStr}/cmdline`);
                    if (okCmd) cmdlineBytes = cBytes;
                } catch (eCmd) {
                    // Ignore cmdline read errors
                }

                let moduleName = extractModuleName(comm, cmdlineBytes);
                let meta = resolver ? resolver.resolve(moduleName, comm) : {
                    friendlyName: moduleName,
                    gicon: null,
                    iconName: "application-x-executable"
                };

                rawProcesses.push({
                    pid: parseInt(pidStr, 10),
                    comm: comm,
                    moduleName: moduleName,
                    friendlyName: meta.friendlyName,
                    rssBytes: rssBytes,
                    privBytes: privBytes,
                    sharedBytes: sharedBytes,
                    gicon: meta.gicon,
                    iconName: meta.iconName
                });
            } catch (eProc) {
                // Process may have exited mid-scan
            }
        }
        enumerator.close(null);
    } catch (e) {
        // Fallback if /proc enumeration fails
    }

    return aggregateProcesses(rawProcesses, options);
}

/**
 * Parses a CSS/hex/rgb color string into [r, g, b, a] floats (0.0 to 1.0).
 */
function parseColor(colorStr, fallback = [1, 1, 1, 1]) {
    if (!colorStr || typeof colorStr !== 'string') {
        return fallback;
    }
    let s = colorStr.trim();

    if (s.startsWith('#')) {
        let hex = s.substring(1);
        if (hex.length === 3) {
            let r = parseInt(hex[0] + hex[0], 16) / 255;
            let g = parseInt(hex[1] + hex[1], 16) / 255;
            let b = parseInt(hex[2] + hex[2], 16) / 255;
            return [r, g, b, 1.0];
        }
        if (hex.length === 6 || hex.length === 8) {
            let r = parseInt(hex.substring(0, 2), 16) / 255;
            let g = parseInt(hex.substring(2, 4), 16) / 255;
            let b = parseInt(hex.substring(4, 6), 16) / 255;
            let a = hex.length === 8 ? (parseInt(hex.substring(6, 8), 16) / 255) : 1.0;
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                return [r, g, b, isNaN(a) ? 1.0 : a];
            }
        }
    }

    let rgbaMatch = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (rgbaMatch) {
        let r = Math.min(255, Math.max(0, parseFloat(rgbaMatch[1]))) / 255;
        let g = Math.min(255, Math.max(0, parseFloat(rgbaMatch[2]))) / 255;
        let b = Math.min(255, Math.max(0, parseFloat(rgbaMatch[3]))) / 255;
        let a = rgbaMatch[4] !== undefined ? Math.min(1, Math.max(0, parseFloat(rgbaMatch[4]))) : 1.0;
        return [r, g, b, a];
    }

    return fallback;
}

/**
 * Selects the active bar color (Green, Yellow, or Red) based on usage percentage and warning thresholds.
 */
function selectBarColor(usagePercent, settings = {}) {
    let yellowThreshold = settings.warnYellow !== undefined ? Number(settings.warnYellow) : 65;
    let redThreshold = settings.warnRed !== undefined ? Number(settings.warnRed) : 90;

    let colorGreen = settings.colorBarGreen || "#78ff78";
    let colorYellow = settings.colorBarYellow || "#ffffb8";
    let colorRed = settings.colorBarRed || "#ff6464";

    if (usagePercent >= redThreshold) {
        return colorRed;
    }
    if (usagePercent >= yellowThreshold) {
        return colorYellow;
    }
    return colorGreen;
}

var exported = {
    BYTES_PER_MB,
    BYTES_PER_GB,
    formatGB,
    formatDashboardPair,
    formatTrayValue,
    getActiveUsagePercent,
    getDashboardHeaderText,
    formatProcessMemory,
    parseMemInfo,
    readMemoryStats,
    extractModuleName,
    aggregateProcesses,
    getTopProcesses,
    parseColor,
    selectBarColor
};

if (typeof module !== 'undefined') {
    module.exports = exported;
}

