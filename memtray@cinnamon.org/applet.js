// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * MemTray Applet for Cinnamon Desktop
 * Clean-room implementation of Windows MemInfo for the Cinnamon taskbar.
 *
 * Features:
 * - Pixel-accurate 16x16 MemInfo tray icon with horizontal top/bottom bar (segmented Standard Bar or continuous bar)
 *   and exact 4x9 internal pixel bitmap font
 * - Right-click & left-click MemInfo popup menu with live dashboard & top processes
 * - Process unification (e.g. chrome [17]), desktop icon resolution, and >X MB row highlighting
 * - Memory Defragmenter (manual, periodic, hotkey, and high-memory triggered)
 * - High memory warning notifications, log file writer, and message box alerts
 * - 5-tab MemInfo Settings dialog (General, Additional, Tray Menu, Display, Themes)
 */

const Applet = imports.ui.applet;
const cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const ModalDialog = imports.ui.modalDialog;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;

let Memory;
try {
    Memory = require('./memory');
} catch (e) {
    Memory = imports.memory;
}

const UUID = "memtray@cinnamon.org";

/**
 * Exact 4x9 pixel bitmap glyphs extracted from Windows MemInfo's internal tray font.
 * Note: Both '.' and ',' render as a 1px bottom dot so 3 digits + decimal separator
 * occupy 4 + 1 + 4 + 1 + 1 + 1 + 4 = 16 pixels (exact fit in a 16x16 tray icon).
 */
const INTERNAL_GLYPHS = {
    "0": [
        ".##.",
        "#..#",
        "#..#",
        "#..#",
        "#..#",
        "#..#",
        "#..#",
        "#..#",
        ".##."
    ],
    "1": [
        "..#.",
        ".##.",
        "..#.",
        "..#.",
        "..#.",
        "..#.",
        "..#.",
        "..#.",
        ".###"
    ],
    "2": [
        "###.",
        "...#",
        "...#",
        "...#",
        ".##.",
        "#...",
        "#...",
        "#...",
        ".###"
    ],
    "3": [
        "###.",
        "...#",
        "...#",
        "...#",
        ".##.",
        "...#",
        "...#",
        "...#",
        "###."
    ],
    "4": [
        "#..#",
        "#..#",
        "#..#",
        "#..#",
        "####",
        "...#",
        "...#",
        "...#",
        "...#"
    ],
    "5": [
        ".###",
        "#...",
        "#...",
        "#...",
        ".##.",
        "...#",
        "...#",
        "...#",
        "###."
    ],
    "6": [
        ".##.",
        "#...",
        "#...",
        "#...",
        "###.",
        "#..#",
        "#..#",
        "#..#",
        ".##."
    ],
    "7": [
        "####",
        "...#",
        "...#",
        "..#.",
        "..#.",
        "..#.",
        ".#..",
        ".#..",
        ".#.."
    ],
    "8": [
        ".##.",
        "#..#",
        "#..#",
        "#..#",
        ".##.",
        "#..#",
        "#..#",
        "#..#",
        ".##."
    ],
    "9": [
        ".##.",
        "#..#",
        "#..#",
        "#..#",
        ".###",
        "...#",
        "...#",
        "...#",
        ".##."
    ],
    ".": [
        ".",
        ".",
        ".",
        ".",
        ".",
        ".",
        ".",
        ".",
        "#"
    ],
    ",": [
        ".",
        ".",
        ".",
        ".",
        ".",
        ".",
        ".",
        ".",
        "#"
    ],
    "%": [
        "##..#",
        "##..#",
        "...#.",
        "..#..",
        "..#..",
        ".#...",
        "#..##",
        "#..##",
        "....."
    ]
};

const BUILTIN_THEMES = {
    "meminfo-dark": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#b43434",
        "color-tray-text": "#ffffff",
        "color-tray-bg": "#000000",
        "color-bar-bg": "#787878",
        "color-bar-green": "#78ff78",
        "color-bar-yellow": "#ffffb8",
        "color-bar-red": "#ff6464"
    },
    "meminfo-mono": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#b43434",
        "color-tray-text": "#ffffff",
        "color-tray-bg": "#000000",
        "color-bar-bg": "#747474",
        "color-bar-green": "#ffffff",
        "color-bar-yellow": "#ffffb8",
        "color-bar-red": "#ff6464"
    },
    "meminfo-light": {
        "menu-color-mode": "light",
        "color-menu-highlight": "#d9534f",
        "color-tray-text": "#1a1a1a",
        "color-tray-bg": "#f0f0f0",
        "color-bar-bg": "#b0b0b0",
        "color-bar-green": "#2e7d32",
        "color-bar-yellow": "#ef6c00",
        "color-bar-red": "#c62828"
    },
    "matrix-green": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#1b5e20",
        "color-tray-text": "#00e676",
        "color-tray-bg": "#0a0a0a",
        "color-bar-bg": "#264d26",
        "color-bar-green": "#00e676",
        "color-bar-yellow": "#ffea00",
        "color-bar-red": "#ff1744"
    },
    "ocean-blue": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#1565c0",
        "color-tray-text": "#e3f2fd",
        "color-tray-bg": "#0d1b2a",
        "color-bar-bg": "#415a77",
        "color-bar-green": "#29b6f6",
        "color-bar-yellow": "#ffa726",
        "color-bar-red": "#ef5350"
    }
};

/**
 * Pixel-accurate Cairo canvas widget rendering the MemInfo tray icon:
 * - Horizontal bar at top (default) or bottom (when "Bar at bottom" is checked)
 * - Standard bar ON: 5-segment discrete block bar (matching MemInfoTray.png)
 * - Standard bar OFF: continuous solid bar with subtle top-row shading (matching reference video)
 * - Internal font ON: exact 4x9 pixel bitmap font on a 16x16 grid
 * - Internal font OFF: PangoCairo custom font below/above horizontal bar
 */
class MemTrayCanvas {
    constructor(panelHeight = 40) {
        this.actor = new St.DrawingArea({
            style_class: 'memtray-canvas',
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._panelHeight = panelHeight || 40;
        this._text = "0,00";
        this._usagePercent = 0;

        this._options = {
            useInternalFont: true,
            customFont: "Sans Bold 8",
            useBarColorForFont: false,
            transparentBg: true,
            opaqueBar: true,
            standardBar: false,
            barAtBottom: false,
            colorTrayText: "#ffffff",
            colorTrayBg: "#000000",
            colorBarBg: "#787878",
            activeBarColor: "#78ff78"
        };

        this._pixelScale = 1;
        this._logicalWidth = 16;
        this._logicalHeight = 16;
        this._measuredWidth = 16;
        this._measuredHeight = 16;

        this.actor.set_size(16, 16);
        this.actor.connect('repaint', this._onRepaint.bind(this));
    }

    setPanelHeight(panelHeight) {
        this._panelHeight = panelHeight || 40;
        this._recalcSize();
        this.actor.queue_repaint();
    }

    updateState(text, usagePercent, options) {
        this._text = String(text !== undefined && text !== null ? text : "0,00");
        this._usagePercent = Math.max(0, Math.min(100, Number(usagePercent) || 0));
        if (options) {
            Object.assign(this._options, options);
        }
        this._recalcSize();
        this.actor.queue_repaint();
    }

    _getBitmapGlyphs(text) {
        let glyphs = [];
        for (let i = 0; i < text.length; i++) {
            let ch = text[i];
            if (INTERNAL_GLYPHS[ch]) {
                glyphs.push(INTERNAL_GLYPHS[ch]);
            }
        }
        return glyphs;
    }

    _recalcSize() {
        // Use integer pixel scaling (1x = 16x16 for standard panels up to 52px, 2x = 32x32 for HiDPI panels)
        this._pixelScale = this._panelHeight >= 56 ? 2 : 1;

        if (this._options.useInternalFont) {
            let glyphs = this._getBitmapGlyphs(this._text);
            let bitmapW = 16;
            if (glyphs.length > 0) {
                let totalGlyphW = 0;
                for (let i = 0; i < glyphs.length; i++) {
                    totalGlyphW += glyphs[i][0].length;
                }
                totalGlyphW += Math.max(0, glyphs.length - 1);
                bitmapW = Math.max(16, totalGlyphW);
            }
            this._logicalWidth = bitmapW;
            this._logicalHeight = 16;
            this._measuredWidth = this._logicalWidth * this._pixelScale;
            this._measuredHeight = this._logicalHeight * this._pixelScale;
        } else {
            // Custom Pango font mode
            let approxW = Math.max(20, this._text.length * 7 + 4);
            let approxH = Math.max(18, Math.min(28, this._panelHeight - 6));
            try {
                let pangoCtx = this.actor.get_pango_context();
                if (pangoCtx) {
                    let layout = Pango.Layout.new(pangoCtx);
                    let desc = Pango.FontDescription.from_string(this._options.customFont || "Sans Bold 8");
                    layout.set_font_description(desc);
                    layout.set_text(this._text, -1);
                    let [pw, ph] = layout.get_pixel_size();
                    if (pw > 0) approxW = Math.max(18, pw + 2);
                    if (ph > 0) approxH = Math.max(16, ph + 6);
                }
            } catch (e) {}
            this._measuredWidth = approxW;
            this._measuredHeight = approxH;
        }

        this.actor.set_size(this._measuredWidth, this._measuredHeight);
    }

    _onRepaint(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        cr.save();

        let barAlpha = this._options.opaqueBar ? 1.0 : 0.65;
        let troughCol = Memory.parseColor(this._options.colorBarBg, [0.47, 0.47, 0.47, 1.0]);
        let fillCol = Memory.parseColor(this._options.activeBarColor, [0.47, 1.0, 0.47, 1.0]);
        let textColStr = this._options.useBarColorForFont
            ? this._options.activeBarColor
            : this._options.colorTrayText;
        let textCol = Memory.parseColor(textColStr, [1.0, 1.0, 1.0, 1.0]);
        let ratio = this._usagePercent / 100.0;

        if (this._options.useInternalFont) {
            // Crisp pixel-aligned 16x16 rendering (no subpixel antialiasing blur)
            cr.setAntialias(cairo.Antialias.NONE);
            let scale = this._pixelScale || 1;
            let lw = this._logicalWidth || 16;
            let lh = 16;
            let offsetX = Math.floor((w - lw * scale) / 2);
            let offsetY = Math.floor((h - lh * scale) / 2);

            cr.translate(offsetX, offsetY);
            cr.scale(scale, scale);

            // 1. Optional non-transparent background
            if (!this._options.transparentBg) {
                let bg = Memory.parseColor(this._options.colorTrayBg, [0.0, 0.0, 0.0, 1.0]);
                cr.setSourceRGBA(bg[0], bg[1], bg[2], bg[3]);
                cr.rectangle(0, 0, lw, lh);
                cr.fill();
            }

            // 2. Determine vertical coordinates for Horizontal Bar and Bitmap Digits
            // Default (barAtBottom == false): Bar at top (y=0..3), 3px gap (y=4..6), Digits at bottom (y=7..15)
            // When barAtBottom == true: Digits at top (y=0..8), 3px gap (y=9..11), Bar at bottom (y=12..15)
            let barY = this._options.barAtBottom ? 12 : 0;
            let textY = this._options.barAtBottom ? 0 : 7;

            this._drawPixelHorizontalBar(cr, 0, barY, lw, 4, ratio, troughCol, fillCol, barAlpha);
            this._drawPixelBitmapText(cr, 0, textY, lw, textCol);
        } else {
            // Custom Font mode (PangoCairo) with Horizontal Bar at top (default) or bottom
            if (!this._options.transparentBg) {
                let bg = Memory.parseColor(this._options.colorTrayBg, [0.0, 0.0, 0.0, 1.0]);
                cr.setSourceRGBA(bg[0], bg[1], bg[2], bg[3]);
                cr.rectangle(0, 0, w, h);
                cr.fill();
            }

            let barH = 4;
            let barY = this._options.barAtBottom ? (h - barH) : 0;
            let textAvailY = this._options.barAtBottom ? 0 : (barH + 2);
            let textAvailH = Math.max(8, h - barH - 2);

            cr.setAntialias(cairo.Antialias.NONE);
            this._drawPixelHorizontalBar(cr, 0, barY, w, barH, ratio, troughCol, fillCol, barAlpha);

            cr.setAntialias(cairo.Antialias.DEFAULT);
            let layout = PangoCairo.create_layout(cr);
            try {
                layout.set_font_description(Pango.FontDescription.from_string(this._options.customFont || "Sans Bold 8"));
            } catch (e) {
                layout.set_font_description(Pango.FontDescription.from_string("Sans Bold 8"));
            }
            layout.set_text(this._text, -1);
            let [tw, th] = layout.get_pixel_size();
            let tx = Math.max(0, Math.round((w - tw) / 2));
            let ty = textAvailY + Math.round((textAvailH - th) / 2);

            cr.setSourceRGBA(textCol[0], textCol[1], textCol[2], textCol[3]);
            cr.moveTo(tx, ty);
            PangoCairo.show_layout(cr, layout);
        }

        cr.restore();
        cr.$dispose();
    }

    /**
     * Draws the horizontal memory bar at (x, y) with width `w` and height `h` (4px):
     * - Standard bar ON: 5 segmented blocks with 1px gaps (matching MemInfoTray.png)
     * - Standard bar OFF: continuous solid bar with subtle top-row shading (matching reference video)
     */
    _drawPixelHorizontalBar(cr, x, y, w, h, ratio, troughCol, fillCol, barAlpha) {
        if (this._options.standardBar) {
            // Segmented Standard Bar (exact match to MemInfoTray.png: 15px wide across 5 blocks)
            let barW = Math.min(w, 15);
            let startX = x + Math.floor((w - barW) / 2);
            let filledCols = Math.round(barW * ratio);

            for (let col = 0; col < barW; col++) {
                // 1px vertical gap every 3rd pixel (columns 2, 5, 8, 11)
                if (col === 2 || col === 5 || col === 8 || col === 11) {
                    continue;
                }
                if (col < filledCols) {
                    cr.setSourceRGBA(fillCol[0], fillCol[1], fillCol[2], barAlpha);
                } else {
                    cr.setSourceRGBA(troughCol[0], troughCol[1], troughCol[2], barAlpha);
                }
                cr.rectangle(startX + col, y, 1, h);
                cr.fill();
            }
        } else {
            // Non-standard continuous horizontal bar (exact match to reference video)
            let fillW = Math.round(w * ratio);

            // Unfilled right portion (trough)
            if (fillW < w) {
                cr.setSourceRGBA(troughCol[0] * 0.88, troughCol[1] * 0.88, troughCol[2] * 0.88, barAlpha);
                cr.rectangle(x + fillW, y, w - fillW, 1);
                cr.fill();

                cr.setSourceRGBA(troughCol[0], troughCol[1], troughCol[2], barAlpha);
                cr.rectangle(x + fillW, y + 1, w - fillW, Math.max(1, h - 1));
                cr.fill();
            }

            // Filled left portion (active usage)
            if (fillW > 0) {
                cr.setSourceRGBA(fillCol[0] * 0.88, fillCol[1] * 0.88, fillCol[2] * 0.88, barAlpha);
                cr.rectangle(x, y, fillW, 1);
                cr.fill();

                cr.setSourceRGBA(fillCol[0], fillCol[1], fillCol[2], barAlpha);
                cr.rectangle(x, y + 1, fillW, Math.max(1, h - 1));
                cr.fill();
            }
        }
    }

    /**
     * Draws the 4x9 pixel bitmap glyphs onto the 16x16 logical canvas.
     */
    _drawPixelBitmapText(cr, areaX, areaY, areaW, textCol) {
        let glyphs = this._getBitmapGlyphs(this._text);
        if (glyphs.length === 0) return;

        let totalW = 0;
        for (let i = 0; i < glyphs.length; i++) {
            totalW += glyphs[i][0].length;
        }
        totalW += Math.max(0, glyphs.length - 1);

        let curX = areaX + Math.max(0, Math.floor((areaW - totalW) / 2));
        cr.setSourceRGBA(textCol[0], textCol[1], textCol[2], textCol[3]);

        for (let gIdx = 0; gIdx < glyphs.length; gIdx++) {
            let glyph = glyphs[gIdx];
            let gw = glyph[0].length;
            for (let r = 0; r < glyph.length; r++) {
                let rowStr = glyph[r];
                for (let c = 0; c < gw; c++) {
                    if (rowStr[c] === '#') {
                        cr.rectangle(curX + c, areaY + r, 1, 1);
                    }
                }
            }
            curX += gw + 1;
        }
        cr.fill();
    }
}

/**
 * Custom Menu Item Row matching Windows MemInfo's popup menu layout:
 * [16x16 Icon / Spacer] [Left Label (expands)] [Right Value (optional)]
 */
class MemTrayMenuRow extends PopupMenu.PopupBaseMenuItem {
    constructor(labelText, valueText = null, options = {}) {
        super({
            reactive: Boolean(options.reactive),
            activate: Boolean(options.reactive),
            hover: Boolean(options.reactive),
            style_class: options.reactive
                ? 'memtray-menu-row memtray-menu-row-interactive'
                : 'memtray-menu-row'
        });

        this._iconBin = new St.Bin({
            style_class: 'memtray-icon-cell',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });

        if (options.gicon) {
            this._icon = new St.Icon({
                gicon: options.gicon,
                icon_size: 16,
                icon_type: St.IconType.FULLCOLOR
            });
            this._iconBin.set_child(this._icon);
        } else if (options.iconPath) {
            let file = Gio.File.new_for_path(options.iconPath);
            if (file.query_exists(null)) {
                this._icon = new St.Icon({
                    gicon: new Gio.FileIcon({ file: file }),
                    icon_size: 16,
                    icon_type: St.IconType.FULLCOLOR
                });
                this._iconBin.set_child(this._icon);
            }
        } else if (options.iconName) {
            this._icon = new St.Icon({
                icon_name: options.iconName,
                icon_size: 16,
                icon_type: options.symbolic ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR
            });
            this._iconBin.set_child(this._icon);
        }

        this.addActor(this._iconBin, { expand: false, span: 1, align: St.Align.START });

        this._label = new St.Label({
            text: labelText || "",
            style_class: options.isHeader ? 'memtray-row-header' : 'memtray-row-label',
            y_align: Clutter.ActorAlign.CENTER
        });
        this.addActor(this._label, { expand: true, span: 1, align: St.Align.START });

        if (valueText !== null && valueText !== undefined) {
            this._valueLabel = new St.Label({
                text: String(valueText),
                style_class: 'memtray-row-value',
                y_align: Clutter.ActorAlign.CENTER
            });
            this.addActor(this._valueLabel, { expand: false, span: 1, align: St.Align.END });
        }

        if (options.highlightColor) {
            this.actor.set_style(
                `background-color: ${options.highlightColor}; color: #ffffff; border-radius: 2px; margin: 1px 3px;`
            );
            this._label.set_style('color: #ffffff;');
            if (this._valueLabel) {
                this._valueLabel.set_style('color: #ffffff;');
            }
        }
    }

    setLabelText(text) {
        this._label.set_text(text || "");
    }

    setValueText(text) {
        if (this._valueLabel) {
            this._valueLabel.set_text(String(text));
        }
    }
}

/**
 * Main MemTray Applet Class
 */
class MemTrayApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.metadata = metadata;
        this._uuid = metadata.uuid || UUID;
        this._appletPath = metadata.path || (GLib.get_home_dir() + `/.local/share/cinnamon/applets/${UUID}`);
        this._orientation = orientation;
        this._panel_height = panel_height;
        this.instance_id = instance_id;

        this._refreshTimerId = 0;
        this._defragTimerId = 0;
        this._lastHighMemTriggerTime = 0;
        this._hotkeyId = `memtray-defrag-${this.instance_id}`;
        this._screensaverSubId = 0;
        this._fileMonitor = null;
        this._fileMonitorId = 0;

        this._headerRow = null;
        this._usageRow = null;
        this._physRow = null;
        this._pageRow = null;

        this.actor.add_style_class_name('memtray-applet');

        // 1. Tray Canvas Widget (16x16 pixel-accurate MemInfo icon)
        this._canvas = new MemTrayCanvas(panel_height);
        this.actor.add_actor(this._canvas.actor);

        // 2. Main MemInfo Popup Menu (opens on right-click OR single left-click)
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        // 3. Initialize Settings
        this._initSettings();

        // 4. Setup remote refresh file monitor & screensaver lock listener
        this._setupFileMonitor();
        this._setupScreensaverListener();

        // 5. Initial update
        this.on_settings_changed();
        this.update(true);
    }

    _initSettings() {
        this.settings = new Settings.AppletSettings(this, this._uuid, this.instance_id);

        // Tab 1: General
        this.settings.bind("show-page-file", "show_page_file", this.on_settings_changed.bind(this));
        this.settings.bind("show-free-memory", "show_free_memory", this.on_settings_changed.bind(this));
        this.settings.bind("show-percentage", "show_percentage", this.on_settings_changed.bind(this));
        this.settings.bind("warn-yellow", "warn_yellow", this.on_settings_changed.bind(this));
        this.settings.bind("warn-red", "warn_red", this.on_settings_changed.bind(this));
        this.settings.bind("high-mem-notify", "high_mem_notify", this.on_settings_changed.bind(this));
        this.settings.bind("high-mem-log", "high_mem_log", this.on_settings_changed.bind(this));
        this.settings.bind("high-mem-defrag", "high_mem_defrag", this.on_settings_changed.bind(this));
        this.settings.bind("high-mem-msgbox", "high_mem_msgbox", this.on_settings_changed.bind(this));

        // Tab 2: Additional
        this.settings.bind("defrag-periodic", "defrag_periodic", this.on_settings_changed.bind(this));
        this.settings.bind("defrag-interval", "defrag_interval", this.on_settings_changed.bind(this));
        this.settings.bind("defrag-hotkey", "defrag_hotkey", this._updateHotkey.bind(this));
        this.settings.bind("refresh-rate", "refresh_rate", this.on_settings_changed.bind(this));
        this.settings.bind("tray-double-click", "tray_double_click", this.on_settings_changed.bind(this));
        this.settings.bind("display-off-on-lock", "display_off_on_lock", this.on_settings_changed.bind(this));
        this.settings.bind("show-tooltip", "show_tooltip", this.on_settings_changed.bind(this));
        this.settings.bind("page-file-mode", "page_file_mode", this.on_settings_changed.bind(this));
        this.settings.bind("task-manager-cmd", "task_manager_cmd", this.on_settings_changed.bind(this));

        // Tab 3: Tray Menu
        this.settings.bind("show-top-processes", "show_top_processes", this.on_settings_changed.bind(this));
        this.settings.bind("top-processes-count", "top_processes_count", this.on_settings_changed.bind(this));
        this.settings.bind("process-display-mode", "process_display_mode", this.on_settings_changed.bind(this));
        this.settings.bind("highlight-processes", "highlight_processes", this.on_settings_changed.bind(this));
        this.settings.bind("highlight-threshold-mb", "highlight_threshold_mb", this.on_settings_changed.bind(this));
        this.settings.bind("show-process-name", "show_process_name", this.on_settings_changed.bind(this));
        this.settings.bind("unify-processes", "unify_processes", this.on_settings_changed.bind(this));
        this.settings.bind("show-dashboard", "show_dashboard", this.on_settings_changed.bind(this));
        this.settings.bind("show-tray-value-info", "show_tray_value_info", this.on_settings_changed.bind(this));

        // Tab 4: Display
        this.settings.bind("use-internal-font", "use_internal_font", this.on_settings_changed.bind(this));
        this.settings.bind("custom-font", "custom_font", this.on_settings_changed.bind(this));
        this.settings.bind("use-bar-color-for-font", "use_bar_color_for_font", this.on_settings_changed.bind(this));
        this.settings.bind("transparent-bg", "transparent_bg", this.on_settings_changed.bind(this));
        this.settings.bind("opaque-bar", "opaque_bar", this.on_settings_changed.bind(this));
        this.settings.bind("standard-bar", "standard_bar", this.on_settings_changed.bind(this));
        this.settings.bind("bar-at-bottom", "bar_at_bottom", this.on_settings_changed.bind(this));
        this.settings.bind("show-percent-sign", "show_percent_sign", this.on_settings_changed.bind(this));

        // Tab 5: Themes
        this.settings.bind("theme-preset", "theme_preset", this._onThemePresetChanged.bind(this));
        this.settings.bind("menu-color-mode", "menu_color_mode", this.on_settings_changed.bind(this));
        this.settings.bind("color-menu-highlight", "color_menu_highlight", this.on_settings_changed.bind(this));
        this.settings.bind("color-tray-text", "color_tray_text", this.on_settings_changed.bind(this));
        this.settings.bind("color-tray-bg", "color_tray_bg", this.on_settings_changed.bind(this));
        this.settings.bind("color-bar-bg", "color_bar_bg", this.on_settings_changed.bind(this));
        this.settings.bind("color-bar-green", "color_bar_green", this.on_settings_changed.bind(this));
        this.settings.bind("color-bar-yellow", "color_bar_yellow", this.on_settings_changed.bind(this));
        this.settings.bind("color-bar-red", "color_bar_red", this.on_settings_changed.bind(this));
        this.settings.bind("custom-themes-json", "custom_themes_json", this.on_settings_changed.bind(this));
    }

    _onThemePresetChanged() {
        let preset = BUILTIN_THEMES[this.theme_preset];
        if (!preset && this.custom_themes_json) {
            try {
                let customMap = JSON.parse(this.custom_themes_json);
                if (customMap && customMap[this.theme_preset]) {
                    preset = customMap[this.theme_preset];
                }
            } catch (e) {}
        }
        if (preset) {
            this.menu_color_mode = preset["menu-color-mode"] || this.menu_color_mode;
            this.color_menu_highlight = preset["color-menu-highlight"] || this.color_menu_highlight;
            this.color_tray_text = preset["color-tray-text"] || this.color_tray_text;
            this.color_tray_bg = preset["color-tray-bg"] || this.color_tray_bg;
            this.color_bar_bg = preset["color-bar-bg"] || this.color_bar_bg;
            this.color_bar_green = preset["color-bar-green"] || this.color_bar_green;
            this.color_bar_yellow = preset["color-bar-yellow"] || this.color_bar_yellow;
            this.color_bar_red = preset["color-bar-red"] || this.color_bar_red;
        }
        this.on_settings_changed();
    }

    on_settings_changed() {
        this._updateHotkey();
        this._scheduleRefreshTimer();
        this._scheduleDefragTimer();
        this.update(true);
    }

    on_open_classic_settings_pressed() {
        this._openClassicSettingsDialog();
    }

    on_defrag_button_pressed() {
        this.runMemoryDefragmenter(true);
    }

    /**
     * Toggles the main MemInfo popup menu safely:
     * Builds items BEFORE opening so hovered items are never destroyed while the menu is open.
     */
    _toggleMainPopupMenu() {
        if (this.menu.isOpen) {
            this.menu.close();
        } else {
            this._applyMenuTheme();
            this._rebuildPopupMenu();
            this.menu.open(true);
        }
    }

    /**
     * Button handling:
     * - Right-click (button 3): opens the MemInfo popup menu
     * - Left-click (button 1):
     *     - Single click: toggles the MemInfo popup menu
     *     - Double click: executes the configured "Tray double click" action (e.g. Start Task Manager)
     * - Middle-click (button 2): triggers Memory Defragmenter
     */
    _onButtonPressEvent(actor, event) {
        if (!this._applet_enabled) {
            return false;
        }

        let panelEditMode = global.settings.get_boolean('panel-edit-mode');
        if (panelEditMode) {
            return super._onButtonPressEvent(actor, event);
        }

        let button = event.get_button();
        let clickCount = event.get_click_count ? event.get_click_count() : 1;

        if (button === 3) {
            if (this._applet_context_menu && this._applet_context_menu.isOpen) {
                this._applet_context_menu.toggle();
            }
            this._toggleMainPopupMenu();
            return true;
        }

        if (button === 1) {
            if (clickCount >= 2) {
                if (this.menu.isOpen) {
                    this.menu.close();
                }
                this._handleDoubleClickAction();
                return true;
            }

            this._toggleMainPopupMenu();
            return true;
        }

        if (button === 2) {
            this.runMemoryDefragmenter(true);
            return true;
        }

        return super._onButtonPressEvent(actor, event);
    }

    _handleDoubleClickAction() {
        let action = this.tray_double_click || "task-manager";
        if (action === "task-manager") {
            this._launchTaskManager();
        } else if (action === "defrag") {
            this.runMemoryDefragmenter(true);
        } else if (action === "settings") {
            this._openClassicSettingsDialog();
        }
    }

    _applyMenuTheme() {
        let mode = this.menu_color_mode || "auto";
        let useDark = true;
        if (mode === "light") {
            useDark = false;
        } else if (mode === "dark") {
            useDark = true;
        } else {
            try {
                let gtkTheme = Main.themeManager ? (global.settings.get_string("gtk-theme") || "") : "";
                useDark = !gtkTheme.toLowerCase().includes("light");
            } catch (e) {
                useDark = true;
            }
        }

        this.menu.actor.remove_style_class_name('memtray-menu-dark');
        this.menu.actor.remove_style_class_name('memtray-menu-light');
        this.menu.actor.add_style_class_name(useDark ? 'memtray-menu-dark' : 'memtray-menu-light');
    }

    _rebuildPopupMenu() {
        this.menu.removeAll();
        this._headerRow = null;
        this._usageRow = null;
        this._physRow = null;
        this._pageRow = null;

        let memStats = this._lastMemStats || Memory.readMemoryStats(this.page_file_mode || "commit");

        // 1. Start Task Manager
        let taskMgrItem = new MemTrayMenuRow("Start Task Manager", null, {
            reactive: true,
            iconName: "utilities-system-monitor"
        });
        taskMgrItem.connect('activate', () => {
            this.menu.close();
            this._launchTaskManager();
        });
        this.menu.addMenuItem(taskMgrItem);

        // 2. Dashboard Section
        if (this.show_dashboard !== false) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (this.show_tray_value_info !== false) {
                let headerText = Memory.getDashboardHeaderText({
                    showPageFile: this.show_page_file,
                    showFreeMemory: this.show_free_memory
                });
                this._headerRow = new MemTrayMenuRow(headerText, null, {
                    reactive: false,
                    isHeader: true
                });
                this.menu.addMenuItem(this._headerRow);
            }

            let activePct = Memory.getActiveUsagePercent(memStats, {
                showPageFile: this.show_page_file
            });
            this._usageRow = new MemTrayMenuRow("Memory Usage", `${activePct}%`, {
                reactive: false
            });
            this.menu.addMenuItem(this._usageRow);

            let physBytes = this.show_free_memory ? memStats.ramFree : memStats.ramUsed;
            this._physRow = new MemTrayMenuRow(
                "Physical Memory",
                Memory.formatDashboardPair(physBytes, memStats.ramTotal),
                { reactive: false }
            );
            this.menu.addMenuItem(this._physRow);

            let pageBytes = this.show_free_memory ? memStats.pageFree : memStats.pageUsed;
            this._pageRow = new MemTrayMenuRow(
                "Page File",
                Memory.formatDashboardPair(pageBytes, memStats.pageTotal),
                { reactive: false }
            );
            this.menu.addMenuItem(this._pageRow);
        }

        // 3. Top Memory Usage Processes Section
        if (this.show_top_processes !== false) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            let topProcs = Memory.getTopProcesses({
                unifyProcesses: this.unify_processes !== false,
                showProcessName: Boolean(this.show_process_name),
                topCount: this.top_processes_count || 10,
                highlightProcesses: this.highlight_processes !== false,
                highlightThresholdMB: this.highlight_threshold_mb !== undefined ? this.highlight_threshold_mb : 1000,
                processDisplayMode: this.process_display_mode || "value",
                totalRamBytes: memStats.ramTotal
            });

            let highlightColor = this.color_menu_highlight || "#b43434";

            for (let i = 0; i < topProcs.length; i++) {
                let proc = topProcs[i];
                let procRow = new MemTrayMenuRow(proc.displayName, proc.formattedMemory, {
                    reactive: true,
                    gicon: proc.gicon,
                    iconName: proc.iconName || "application-x-executable",
                    highlightColor: proc.isHighlighted ? highlightColor : null
                });
                procRow.connect('activate', () => {
                    this.menu.close();
                    this._promptProcessAction(proc);
                });
                this.menu.addMenuItem(procRow);
            }
        }

        // 4. Bottom Actions Section
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let defragIconPath = this._appletPath + "/icons/memtray-defrag-symbolic.svg";
        let defragItem = new MemTrayMenuRow("Memory Defragmenter", null, {
            reactive: true,
            iconPath: defragIconPath,
            iconName: "view-refresh-symbolic",
            symbolic: true
        });
        defragItem.connect('activate', () => {
            this.menu.close();
            this.runMemoryDefragmenter(true);
        });
        this.menu.addMenuItem(defragItem);

        let settingsItem = new MemTrayMenuRow("Settings...", null, {
            reactive: true,
            iconName: "preferences-system-symbolic",
            symbolic: true
        });
        settingsItem.connect('activate', () => {
            this.menu.close();
            this._openClassicSettingsDialog();
        });
        this.menu.addMenuItem(settingsItem);

        let aboutItem = new MemTrayMenuRow("About...", null, {
            reactive: true
        });
        aboutItem.connect('activate', () => {
            this.menu.close();
            this._openAboutDialog();
        });
        this.menu.addMenuItem(aboutItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let exitItem = new MemTrayMenuRow("Exit", null, {
            reactive: true,
            iconName: "window-close-symbolic",
            symbolic: true
        });
        exitItem.connect('activate', (_actor, event) => {
            this.menu.close();
            this.confirmRemoveApplet(event);
        });
        this.menu.addMenuItem(exitItem);
    }

    /**
     * Updates only the non-reactive dashboard text labels in-place when the menu is open,
     * preserving key_focus and hover state on all menu items.
     */
    _updateOpenMenuDashboard(memStats) {
        if (this._usageRow) {
            let activePct = Memory.getActiveUsagePercent(memStats, {
                showPageFile: this.show_page_file
            });
            this._usageRow.setValueText(`${activePct}%`);
        }
        if (this._physRow) {
            let physBytes = this.show_free_memory ? memStats.ramFree : memStats.ramUsed;
            this._physRow.setValueText(Memory.formatDashboardPair(physBytes, memStats.ramTotal));
        }
        if (this._pageRow) {
            let pageBytes = this.show_free_memory ? memStats.pageFree : memStats.pageUsed;
            this._pageRow.setValueText(Memory.formatDashboardPair(pageBytes, memStats.pageTotal));
        }
    }

    _promptProcessAction(proc) {
        let pidsStr = proc.pids.slice(0, 8).join(", ") + (proc.pids.length > 8 ? "..." : "");
        let msg = `Process: ${proc.displayName}\nMemory Usage: ${proc.formattedMemory}\nPID(s): ${pidsStr}\n\nDo you want to terminate this process?`;
        let dialog = new ModalDialog.ConfirmDialog(msg, () => {
            for (let i = 0; i < proc.pids.length; i++) {
                try {
                    Util.spawnCommandLine(`kill -15 ${proc.pids[i]}`);
                } catch (e) {}
            }
            Mainloop.timeout_add(500, () => {
                this.update(true);
                return false;
            });
        });
        dialog.open();
    }

    /**
     * Periodic tray update
     */
    update(_force = false) {
        if (!this._applet_enabled) return;

        let memStats = Memory.readMemoryStats(this.page_file_mode || "commit");
        this._lastMemStats = memStats;

        let usagePercent = Memory.getActiveUsagePercent(memStats, {
            showPageFile: this.show_page_file
        });

        let trayText = Memory.formatTrayValue(memStats, {
            showPageFile: this.show_page_file,
            showFreeMemory: this.show_free_memory,
            showPercentage: this.show_percentage,
            showPercentSign: this.show_percent_sign
        });

        let activeBarColor = Memory.selectBarColor(usagePercent, {
            warnYellow: this.warn_yellow !== undefined ? this.warn_yellow : 65,
            warnRed: this.warn_red !== undefined ? this.warn_red : 90,
            colorBarGreen: this.color_bar_green || "#78ff78",
            colorBarYellow: this.color_bar_yellow || "#ffffb8",
            colorBarRed: this.color_bar_red || "#ff6464"
        });

        this._canvas.updateState(trayText, usagePercent, {
            useInternalFont: this.use_internal_font !== false,
            customFont: this.custom_font || "Sans Bold 8",
            useBarColorForFont: Boolean(this.use_bar_color_for_font),
            transparentBg: this.transparent_bg !== false,
            opaqueBar: this.opaque_bar !== false,
            standardBar: Boolean(this.standard_bar),
            barAtBottom: Boolean(this.bar_at_bottom),
            colorTrayText: this.color_tray_text || "#ffffff",
            colorTrayBg: this.color_tray_bg || "#000000",
            colorBarBg: this.color_bar_bg || "#787878",
            activeBarColor: activeBarColor
        });

        // Update Tooltip if enabled
        if (this.show_tooltip) {
            let physPair = Memory.formatDashboardPair(memStats.ramUsed, memStats.ramTotal);
            let pagePair = Memory.formatDashboardPair(memStats.pageUsed, memStats.pageTotal);
            let tooltipText =
                `MemTray — Memory Usage: ${usagePercent}%\n` +
                `Physical Memory: ${physPair}\n` +
                `Page File: ${pagePair}`;
            this.set_applet_tooltip(tooltipText);
        } else {
            this.set_applet_tooltip("");
        }

        // Update dashboard numbers in-place if menu is open (never destroy hovered actors!)
        if (this.menu && this.menu.isOpen) {
            this._updateOpenMenuDashboard(memStats);
        }

        // Check High Memory Warning Threshold
        this._checkHighMemoryThreshold(usagePercent, memStats);
    }

    _checkHighMemoryThreshold(usagePercent, memStats) {
        let redThreshold = this.warn_red !== undefined ? Number(this.warn_red) : 90;
        if (usagePercent < redThreshold) {
            return;
        }

        let nowSec = Math.floor(GLib.get_monotonic_time() / 1000000);
        if (this._lastHighMemTriggerTime > 0 && (nowSec - this._lastHighMemTriggerTime) < 120) {
            return;
        }
        this._lastHighMemTriggerTime = nowSec;

        let summary = `Memory usage is at ${usagePercent}% (${Memory.formatDashboardPair(memStats.ramUsed, memStats.ramTotal)})`;

        if (this.high_mem_notify) {
            Main.notify("MemTray — High Memory Warning", summary);
        }

        if (this.high_mem_log) {
            this._writeHighMemoryLog(usagePercent, memStats);
        }

        if (this.high_mem_defrag) {
            this.runMemoryDefragmenter(false);
        }

        if (this.high_mem_msgbox) {
            let dlg = new ModalDialog.NotifyDialog(`MemTray Warning\n\n${summary}`);
            dlg.open();
        }
    }

    _writeHighMemoryLog(usagePercent, memStats) {
        try {
            let logDir = GLib.get_user_data_dir() + "/memtray";
            GLib.mkdir_with_parents(logDir, 0o755);
            let logPath = logDir + "/memtray.log";
            let now = GLib.DateTime.new_now_local().format("%Y-%m-%d %H:%M:%S");
            let line = `[${now}] HIGH MEMORY (${usagePercent}%): Physical=${Memory.formatDashboardPair(memStats.ramUsed, memStats.ramTotal)}, PageFile=${Memory.formatDashboardPair(memStats.pageUsed, memStats.pageTotal)}\n`;

            let file = Gio.File.new_for_path(logPath);
            let stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write(line, null);
            stream.close(null);
        } catch (e) {
            global.logWarning("[MemTray] Failed to write high memory log: " + e.message);
        }
    }

    /**
     * Memory Defragmenter:
     * Syncs filesystems and drops reclaimable kernel caches (pagecache, dentries, inodes).
     */
    runMemoryDefragmenter(interactive = true) {
        let beforeStats = Memory.readMemoryStats(this.page_file_mode || "commit");
        let beforeUsed = beforeStats.ramUsed;

        let finishDefrag = () => {
            let afterStats = Memory.readMemoryStats(this.page_file_mode || "commit");
            let freedBytes = Math.max(0, beforeUsed - afterStats.ramUsed);
            let freedMB = (freedBytes / Memory.BYTES_PER_MB).toFixed(1).replace('.', ',');
            this.update(true);
            if (interactive) {
                Main.notify(
                    "MemTray — Memory Defragmenter",
                    `Memory optimization complete. Freed ${freedMB} MB (Current usage: ${afterStats.ramPercent}%).`
                );
            }
        };

        let nonInteractiveCmd = `sh -c "sync; sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || true"`;
        Util.spawnCommandLineAsyncIO(nonInteractiveCmd, (_stdout, _stderr, _exitCode) => {
            let checkStats = Memory.readMemoryStats(this.page_file_mode || "commit");
            let freedSoFar = beforeUsed - checkStats.ramUsed;
            if (!interactive || freedSoFar > 5 * Memory.BYTES_PER_MB) {
                finishDefrag();
                return;
            }
            let pkexecCmd = `sh -c "pkexec sh -c 'sync && echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || sync"`;
            Util.spawnCommandLineAsyncIO(pkexecCmd, () => {
                finishDefrag();
            });
        });
    }

    _launchTaskManager() {
        let customCmd = (this.task_manager_cmd || "").trim();
        let cmd = customCmd || "gnome-system-monitor";
        let fallbackScript = `sh -c "${cmd} || gnome-system-monitor || xfce4-taskmanager || ksysguard || mate-system-monitor || x-terminal-emulator -e htop"`;
        try {
            Util.spawnCommandLine(fallbackScript);
        } catch (e) {
            global.logError("[MemTray] Failed to launch Task Manager: " + e.message);
        }
    }

    _openClassicSettingsDialog(tab = 0) {
        let scriptPath = `${this._appletPath}/memtray-settings.py`;
        if (GLib.file_test(scriptPath, GLib.FileTest.EXISTS)) {
            Util.spawnCommandLine(`python3 "${scriptPath}" --instance-id "${this.instance_id}" --tab ${tab}`);
        } else {
            this.configureApplet(tab);
        }
    }

    _openAboutDialog() {
        let scriptPath = `${this._appletPath}/memtray-about.py`;
        if (GLib.file_test(scriptPath, GLib.FileTest.EXISTS)) {
            Util.spawnCommandLine(`python3 "${scriptPath}"`);
        } else {
            this.openAbout();
        }
    }

    _scheduleRefreshTimer() {
        this._removeRefreshTimer();
        let rateMs = Math.max(250, Math.min(60000, parseInt(this.refresh_rate, 10) || 2000));
        this._refreshTimerId = Mainloop.timeout_add(rateMs, () => {
            this.update();
            return true;
        });
    }

    _removeRefreshTimer() {
        if (this._refreshTimerId) {
            Mainloop.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
    }

    _scheduleDefragTimer() {
        this._removeDefragTimer();
        if (!this.defrag_periodic) {
            return;
        }
        let minutes = Math.max(1, parseInt(this.defrag_interval, 10) || 120);
        let intervalSec = minutes * 60;
        this._defragTimerId = Mainloop.timeout_add_seconds(intervalSec, () => {
            this.runMemoryDefragmenter(false);
            return true;
        });
    }

    _removeDefragTimer() {
        if (this._defragTimerId) {
            Mainloop.source_remove(this._defragTimerId);
            this._defragTimerId = 0;
        }
    }

    _updateHotkey() {
        try {
            Main.keybindingManager.removeHotKey(this._hotkeyId);
        } catch (e) {}

        if (this.defrag_hotkey && typeof this.defrag_hotkey === 'string') {
            let cleaned = this.defrag_hotkey.trim();
            if (cleaned && cleaned !== "Nenhum" && cleaned !== "::") {
                try {
                    Main.keybindingManager.addHotKey(this._hotkeyId, cleaned, () => {
                        this.runMemoryDefragmenter(true);
                    });
                } catch (e) {
                    global.logWarning("[MemTray] Failed to bind defrag hotkey: " + e.message);
                }
            }
        }
    }

    _setupFileMonitor() {
        try {
            let cacheDir = GLib.get_user_cache_dir() + "/cinnamon-memtray";
            let dirFile = Gio.File.new_for_path(cacheDir);
            if (!dirFile.query_exists(null)) {
                dirFile.make_directory_with_parents(null);
            }
            this._fileMonitor = dirFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._fileMonitorId = this._fileMonitor.connect('changed', (_monitor, file) => {
                let name = file.get_basename();
                if (name === `refresh-${this.instance_id}` || name === 'refresh-all') {
                    this.update(true);
                } else if (name === 'defrag') {
                    this.runMemoryDefragmenter(true);
                }
            });
        } catch (e) {
            global.logWarning("[MemTray] File monitor setup failed: " + e.message);
        }
    }

    _cleanupFileMonitor() {
        if (this._fileMonitor) {
            if (this._fileMonitorId) {
                this._fileMonitor.disconnect(this._fileMonitorId);
                this._fileMonitorId = 0;
            }
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }
    }

    _setupScreensaverListener() {
        try {
            this._screensaverSubId = Gio.DBus.session.signal_subscribe(
                null,
                "org.cinnamon.ScreenSaver",
                "ActiveChanged",
                "/org/cinnamon/ScreenSaver",
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    if (!this.display_off_on_lock) return;
                    let [isLocked] = params.deep_unpack();
                    if (isLocked) {
                        Mainloop.timeout_add_seconds(1, () => {
                            Util.spawnCommandLine("xset dpms force off");
                            return false;
                        });
                    }
                }
            );
        } catch (e) {
            // Ignore DBus subscription error
        }
    }

    _cleanupScreensaverListener() {
        if (this._screensaverSubId) {
            try {
                Gio.DBus.session.signal_unsubscribe(this._screensaverSubId);
            } catch (e) {}
            this._screensaverSubId = 0;
        }
    }

    on_panel_height_changed() {
        this._panel_height = this.panel ? this.panel.height : 40;
        this._canvas.setPanelHeight(this._panel_height);
        this.update(true);
    }

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        this.update(true);
    }

    on_applet_removed_from_panel() {
        this._removeRefreshTimer();
        this._removeDefragTimer();
        this._cleanupFileMonitor();
        this._cleanupScreensaverListener();
        try {
            Main.keybindingManager.removeHotKey(this._hotkeyId);
        } catch (e) {}
        if (this.settings) {
            this.settings.finalize();
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new MemTrayApplet(metadata, orientation, panel_height, instance_id);
}
