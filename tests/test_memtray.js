// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * Unit & Integration Tests for MemTray (Clean-room MemInfo for Cinnamon)
 * Run with: cjs tests/test_memtray.js
 */

imports.searchPath.unshift("memtray@cinnamon.org");
const Memory = imports.memory;
const GLib = imports.gi.GLib;

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, msg) {
    if (actual === expected) {
        passed++;
        print(`  ✓ ${msg}`);
    } else {
        failed++;
        print(`  ✗ ${msg} — Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
    }
}

function assertTrue(cond, msg) {
    if (cond) {
        passed++;
        print(`  ✓ ${msg}`);
    } else {
        failed++;
        print(`  ✗ ${msg} — Condition was false`);
    }
}

print("=== Running MemTray Test Suite ===\n");

// 1. Test /proc/meminfo parsing & Windows MemInfo formatting
print("[1] Testing parseMemInfo & Dashboard formatting...");
const sampleMemInfo = [
    "MemTotal:       33302938 kB",
    "MemFree:         2000000 kB",
    "MemAvailable:    8703365 kB",
    "Buffers:          500000 kB",
    "Cached:          5000000 kB",
    "SwapTotal:      39845888 kB",
    "SwapFree:       35295027 kB"
].join("\n");

let stats = Memory.parseMemInfo(sampleMemInfo, "commit");
assertEqual(stats.ramPercent, 74, "RAM usage percentage calculated accurately");
assertEqual(
    Memory.formatDashboardPair(stats.ramUsed, stats.ramTotal),
    "23,46 GB/31,76 GB",
    "Physical Memory dashboard pair matches MemInfo video format ('23,46 GB/31,76 GB')"
);
assertEqual(
    Memory.formatDashboardPair(stats.pageUsed, stats.pageTotal),
    "27,8 GB/69,76 GB",
    "Page File dashboard pair matches MemInfo video format ('27,8 GB/69,76 GB')"
);

// 2. Test Tray Value Formatting
print("\n[2] Testing Tray Value Formatting...");
assertEqual(
    Memory.formatTrayValue(stats, { showPageFile: false, showFreeMemory: false, showPercentage: false }),
    "23,5",
    "Tray value displays compact 1-decimal GB with comma ('23,5')"
);
assertEqual(
    Memory.formatTrayValue(stats, { showPageFile: false, showFreeMemory: false, showPercentage: true, showPercentSign: false }),
    "74",
    "Tray value in percentage mode without % sign"
);
assertEqual(
    Memory.formatTrayValue(stats, { showPageFile: false, showFreeMemory: false, showPercentage: true, showPercentSign: true }),
    "74%",
    "Tray value in percentage mode with % sign"
);
assertEqual(
    Memory.formatTrayValue(stats, { showPageFile: true, showFreeMemory: false, showPercentage: false }),
    "27,8",
    "Tray value when 'Show page file instead of physical memory' is active ('27,8')"
);

// 3. Test Dashboard Header Text
print("\n[3] Testing Dashboard Header Text...");
assertEqual(
    Memory.getDashboardHeaderText({ showPageFile: false, showFreeMemory: false }),
    "Displaying used physical memory",
    "Default dashboard header matches video ('Displaying used physical memory')"
);
assertEqual(
    Memory.getDashboardHeaderText({ showPageFile: false, showFreeMemory: true }),
    "Displaying free physical memory",
    "Free physical memory dashboard header"
);
assertEqual(
    Memory.getDashboardHeaderText({ showPageFile: true, showFreeMemory: false }),
    "Displaying used page file",
    "Used page file dashboard header"
);

// 4. Test Process Aggregation, Unification, Formatting, and Highlighting
print("\n[4] Testing Process Aggregation, Unification & Highlighting...");
const mockRawProcs = [
    { pid: 101, comm: "vmware-vmx", moduleName: "vmware-vmx", friendlyName: "VMware", rssBytes: Math.round(8.97 * Memory.BYTES_PER_GB), privBytes: Math.round(8.97 * Memory.BYTES_PER_GB), sharedBytes: 0 },
    { pid: 201, comm: "chrome", moduleName: "chrome", friendlyName: "Google Chrome", rssBytes: 1.8 * Memory.BYTES_PER_GB, privBytes: 1.6 * Memory.BYTES_PER_GB, sharedBytes: 0.2 * Memory.BYTES_PER_GB },
    { pid: 202, comm: "chrome", moduleName: "chrome", friendlyName: "Google Chrome", rssBytes: 1.62 * Memory.BYTES_PER_GB, privBytes: 1.42 * Memory.BYTES_PER_GB, sharedBytes: 0.2 * Memory.BYTES_PER_GB },
    { pid: 301, comm: "python3", moduleName: "python3", friendlyName: "Python", rssBytes: 792 * Memory.BYTES_PER_MB, privBytes: 792 * Memory.BYTES_PER_MB, sharedBytes: 0 }
];

let unified = Memory.aggregateProcesses(mockRawProcs, {
    unifyProcesses: true,
    showProcessName: false,
    topCount: 10,
    highlightProcesses: true,
    highlightThresholdMB: 1000,
    processDisplayMode: "value",
    totalRamBytes: stats.ramTotal
});

assertEqual(unified.length, 3, "Unified 4 raw processes into 3 distinct groups");
assertEqual(unified[0].displayName, "vmware-vmx", "Single instance process has no [count] suffix");
assertEqual(unified[0].formattedMemory, "8,97 GB", "Process >= 1 GB formatted in GB ('8,97 GB')");
assertEqual(unified[0].isHighlighted, true, "Process > 1000 MB is flagged for highlight");

assertEqual(unified[1].displayName, "chrome [2]", "Multi-instance process includes [count] suffix ('chrome [2]')");
assertEqual(unified[1].formattedMemory, "3,22 GB", "Unified Chrome memory summed accurately ('3,22 GB')");
assertEqual(unified[1].isHighlighted, true, "Unified process > 1000 MB is flagged for highlight");

assertEqual(unified[2].displayName, "python3", "Third process is python3");
assertEqual(unified[2].formattedMemory, "792 MB", "Process < 1 GB formatted as integer MB ('792 MB')");
assertEqual(unified[2].isHighlighted, false, "Process < 1000 MB is not highlighted");

// 5. Test Warning Threshold Bar Color Selection
print("\n[5] Testing Bar Warning Color Selection...");
const colorOpts = {
    warnYellow: 65,
    warnRed: 90,
    colorBarGreen: "#4caf50",
    colorBarYellow: "#d4a017",
    colorBarRed: "#e53935"
};
assertEqual(Memory.selectBarColor(45, colorOpts), "#4caf50", "Normal usage (<65%) selects Green");
assertEqual(Memory.selectBarColor(73, colorOpts), "#d4a017", "Warning usage (65%-89%) selects Yellow");
assertEqual(Memory.selectBarColor(92, colorOpts), "#e53935", "Critical usage (>=90%) selects Red");

// 6. Live System Integration Test (/proc/meminfo & /proc scan)
print("\n[6] Testing Live System /proc Integration...");
let liveStats = Memory.readMemoryStats("commit");
assertTrue(liveStats.ramTotal > 0, `Live RAM total detected (${Memory.formatGB(liveStats.ramTotal)} GB)`);
let liveProcs = Memory.getTopProcesses({ topCount: 5, unifyProcesses: true, totalRamBytes: liveStats.ramTotal });
assertTrue(liveProcs.length > 0, `Live /proc process scanner found top processes (top #1: ${liveProcs[0].displayName} — ${liveProcs[0].formattedMemory})`);

print(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
    imports.system.exit(1);
}
