// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * MemTray Applet for Cinnamon Desktop
 * Clean-room implementation of Windows MemInfo for the Cinnamon taskbar.
 *
 * Features:
 * - Dynamic Cairo/PangoCairo tray gauge icon (vertical left bar or horizontal bottom bar)
 * - Right-click & left-click MemInfo popup menu with live dashboard & top processes
 * - Process unification (e.g. chrome [17]), desktop icon resolution, and >X MB row highlighting
 * - Memory Defragmenter (manual, periodic, hotkey, and high-memory triggered)
 * - High memory warning notifications, log file writer, and message box alerts
 * - 5-tab MemInfo Settings dialog (General, Additional, Tray Menu, Display, Themes)
 */

const Applet = imports.ui.applet;
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

const BUILTIN_THEMES = {
    "meminfo-dark": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#b43434",
        "color-tray-text": "#ffffff",
        "color-tray-bg": "#1e1e1e",
        "color-bar-bg": "#2d2d2d",
        "color-bar-green": "#4caf50",
        "color-bar-yellow": "#d4a017",
        "color-bar-red": "#e53935"
    },
    "meminfo-light": {
        "menu-color-mode": "light",
        "color-menu-highlight": "#d9534f",
        "color-tray-text": "#1a1a1a",
        "color-tray-bg": "#f0f0f0",
        "color-bar-bg": "#cfcfcf",
        "color-bar-green": "#2e7d32",
        "color-bar-yellow": "#ef6c00",
        "color-bar-red": "#c62828"
    },
    "matrix-green": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#1b5e20",
        "color-tray-text": "#00e676",
        "color-tray-bg": "#0a0a0a",
        "color-bar-bg": "#142814",
        "color-bar-green": "#00e676",
        "color-bar-yellow": "#ffea00",
        "color-bar-red": "#ff1744"
    },
    "ocean-blue": {
        "menu-color-mode": "dark",
        "color-menu-highlight": "#1565c0",
        "color-tray-text": "#e3f2fd",
        "color-tray-bg": "#0d1b2a",
        "color-bar-bg": "#1b263b",
        "color-bar-green": "#29b6f6",
        "color-bar-yellow": "#ffa726",
        "color-bar-red": "#ef5350"
    }
};

/**
 * Custom Cairo + PangoCairo canvas widget rendering the MemInfo tray icon:
 * - Vertical bar on left + value text on right (default, as in Windows MemInfo)
 * - Or value text on top + horizontal bar at bottom (when "Bar at bottom" is enabled)
 */
const MemTrayCanvas = GObject.registerClass({
    GTypeName: 'MemTrayCanvas',
}, class MemTrayCanvas extends St.DrawingArea {
    _init(panelHeight = 28) {
        super._init({
            style_class: 'memtray-canvas',
            reactive: false,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._panelHeight = panelHeight || 28;
        this._text = "0,0";
        this._usagePercent = 0;

        this._options = {
            useInternalFont: true,
            customFont: "Sans Bold 9",
            useBarColorForFont: false,
            transparentBg: true,
            opaqueBar: true,
            standardBar: false,
            barAtBottom: false,
            colorTrayText: "#ffffff",
            colorTrayBg: "#1e1e1e",
            colorBarBg: "#2d2d2d",
            activeBarColor: "#4caf50"
        };

        this._measuredWidth = 42;
        this._measuredHeight = Math.max(18, Math.min(26, this._panelHeight - 4));

        this.connect('repaint', this._onRepaint.bind(this));
    }

    setPanelHeight(panelHeight) {
        this._panelHeight = panelHeight || 28;
        this._recalcSize();
        this.queue_relayout();
        this.queue_repaint();
    }

    updateState(text, usagePercent, options) {
        this._text = String(text !== undefined && text !== null ? text : "0,0");
        this._usagePercent = Math.max(0, Math.min(100, Number(usagePercent) || 0));
        if (options) {
            Object.assign(this._options, options);
        }
        this._recalcSize();
        this.queue_relayout();
        this.queue_repaint();
    }

    _getFontDescription() {
        let fontStr = "Sans Bold 9.5";
        if (!this._options.useInternalFont && this._options.customFont) {
            fontStr = this._options.customFont;
        } else {
            let fontSizePt = Math.max(8, Math.min(11, Math.round((this._panelHeight - 6) * 0.42 * 10) / 10));
            fontStr = `Sans Bold ${fontSizePt}`;
        }
        try {
            return Pango.FontDescription.from_string(fontStr);
        } catch (e) {
            return Pango.FontDescription.from_string("Sans Bold 9.5");
        }
    }

    _recalcSize() {
        let h = Math.max(18, Math.min(28, this._panelHeight - 4));
        this._measuredHeight = h;

        // Estimate text width accurately using Pango context if available
        let charCount = Math.max(2, this._text.length);
        let approxTextW = Math.ceil(charCount * 7.2) + 4;
        try {
            let pangoCtx = this.get_pango_context();
            if (pangoCtx) {
                let layout = Pango.Layout.new(pangoCtx);
                layout.set_font_description(this._getFontDescription());
                layout.set_text(this._text, -1);
                let [pw, _ph] = layout.get_pixel_size();
                if (pw > 0) {
                    approxTextW = pw + 4;
                }
            }
        } catch (e) {
            // Fallback to approximate width
        }

        if (this._options.barAtBottom) {
            this._measuredWidth = Math.max(26, approxTextW + 6);
        } else {
            // Left vertical bar (6px) + 4px gap + text width + 4px padding
            this._measuredWidth = Math.max(32, 6 + 4 + approxTextW + 4);
        }
    }

    vfunc_get_preferred_width(_forHeight) {
        return [this._measuredWidth, this._measuredWidth];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [this._measuredHeight, this._measuredHeight];
    }

    _onRepaint(_area) {
        let cr = this.get_context();
        let [w, h] = this.get_surface_size();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        cr.save();

        // 1. Optional Tray Background
        if (!this._options.transparentBg) {
            let bg = Memory.parseColor(this._options.colorTrayBg, [0.12, 0.12, 0.12, 1.0]);
            cr.setSourceRGBA(bg[0], bg[1], bg[2], bg[3]);
            this._drawRoundedRect(cr, 0, 0, w, h, 3);
            cr.fill();
        }

        let barAlpha = this._options.opaqueBar ? 1.0 : 0.6;
        let troughCol = Memory.parseColor(this._options.colorBarBg, [0.18, 0.18, 0.18, 1.0]);
        let fillCol = Memory.parseColor(this._options.activeBarColor, [0.30, 0.69, 0.31, 1.0]);
        let textColStr = this._options.useBarColorForFont
            ? this._options.activeBarColor
            : this._options.colorTrayText;
        let textCol = Memory.parseColor(textColStr, [1.0, 1.0, 1.0, 1.0]);

        let ratio = this._usagePercent / 100.0;

        // Prepare Pango layout for crisp text rendering
        let layout = PangoCairo.create_layout(cr);
        layout.set_font_description(this._getFontDescription());
        layout.set_text(this._text, -1);
        let [textW, textH] = layout.get_pixel_size();

        if (this._options.barAtBottom) {
            // Horizontal bar at the bottom, text centered above
            let barH = 4;
            let barY = h - barH - 1;
            let barX = 2;
            let barW = Math.max(8, w - 4);

            this._drawGaugeBar(cr, barX, barY, barW, barH, ratio, troughCol, fillCol, barAlpha, false);

            let textX = Math.max(1, Math.round((w - textW) / 2));
            let availH = Math.max(10, barY - 1);
            let textY = Math.max(0, Math.round((availH - textH) / 2));

            cr.setSourceRGBA(textCol[0], textCol[1], textCol[2], textCol[3]);
            cr.moveTo(textX, textY);
            PangoCairo.show_layout(cr, layout);
        } else {
            // Vertical bar on the left, text on the right (Classic MemInfo Tray Layout)
            let barW = 6;
            let barPadY = 2;
            let barX = 2;
            let barY = barPadY;
            let barH = Math.max(10, h - barPadY * 2);

            this._drawGaugeBar(cr, barX, barY, barW, barH, ratio, troughCol, fillCol, barAlpha, true);

            let textAreaX = barX + barW + 4;
            let textAreaW = Math.max(10, w - textAreaX - 1);
            let textX = textAreaX + Math.max(0, Math.round((textAreaW - textW) / 2));
            let textY = Math.round((h - textH) / 2);

            cr.setSourceRGBA(textCol[0], textCol[1], textCol[2], textCol[3]);
            cr.moveTo(textX, textY);
            PangoCairo.show_layout(cr, layout);
        }

        cr.restore();
        cr.$dispose();
    }

    _drawGaugeBar(cr, x, y, w, h, ratio, troughCol, fillCol, barAlpha, isVertical) {
        if (this._options.standardBar) {
            // Standard smooth progress bar
            let r = Math.min(w, h) / 2;
            cr.setSourceRGBA(troughCol[0], troughCol[1], troughCol[2], 0.75 * barAlpha);
            this._drawRoundedRect(cr, x, y, w, h, r);
            cr.fill();

            if (ratio > 0) {
                cr.setSourceRGBA(fillCol[0], fillCol[1], fillCol[2], barAlpha);
                if (isVertical) {
                    let fillH = Math.max(2, Math.round(h * ratio));
                    this._drawRoundedRect(cr, x, y + h - fillH, w, fillH, r);
                } else {
                    let fillW = Math.max(2, Math.round(w * ratio));
                    this._drawRoundedRect(cr, x, y, fillW, h, r);
                }
                cr.fill();
            }
        } else {
            // Classic MemInfo bordered gauge meter
            cr.setSourceRGBA(troughCol[0], troughCol[1], troughCol[2], 0.92 * barAlpha);
            cr.rectangle(x, y, w, h);
            cr.fill();

            if (ratio > 0) {
                cr.setSourceRGBA(fillCol[0], fillCol[1], fillCol[2], barAlpha);
                if (isVertical) {
                    let innerH = Math.max(1, h - 2);
                    let fillH = Math.max(1, Math.round(innerH * ratio));
                    cr.rectangle(x + 1, y + 1 + (innerH - fillH), Math.max(1, w - 2), fillH);
                } else {
                    let innerW = Math.max(1, w - 2);
                    let fillW = Math.max(1, Math.round(innerW * ratio));
                    cr.rectangle(x + 1, y + 1, fillW, Math.max(1, h - 2));
                }
                cr.fill();
            }

            // Crisp 1px border frame
            cr.setLineWidth(1.0);
            cr.setSourceRGBA(0.55, 0.55, 0.55, 0.7 * barAlpha);
            cr.rectangle(x + 0.5, y + 0.5, w - 1, h - 1);
            cr.stroke();
        }
    }

    _drawRoundedRect(cr, x, y, w, h, r) {
        if (w <= 0 || h <= 0) return;
        r = Math.min(r, w / 2, h / 2);
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.arc(x + w - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(x + w - r, y + h - r, r, 0, 0.5 * Math.PI);
        cr.arc(x + r, y + h - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }
});

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
        this._singleClickTimeoutId = 0;
        this._lastHighMemTriggerTime = 0;
        this._hotkeyId = `memtray-defrag-${this.instance_id}`;
        this._screensaverSubId = 0;
        this._fileMonitor = null;
        this._fileMonitorId = 0;

        this.actor.add_style_class_name('memtray-applet');

        // 1. Tray Canvas Widget
        this._canvas = new MemTrayCanvas(panel_height);
        this.actor.add_actor(this._canvas);

        // 2. Main MemInfo Popup Menu (opens on right-click OR single left-click)
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._applyMenuTheme();
                this._rebuildPopupMenu();
            }
        });

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
     * Button handling:
     * - Right-click (button 3): opens the MemInfo popup menu (unless in Panel Edit Mode, where Cinnamon context menu is shown)
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
            // Right-click opens the rich MemInfo popup menu just like on Windows!
            if (this._applet_context_menu && this._applet_context_menu.isOpen) {
                this._applet_context_menu.toggle();
            }
            this.menu.toggle();
            return true;
        }

        if (button === 1) {
            if (clickCount >= 2) {
                if (this._singleClickTimeoutId) {
                    Mainloop.source_remove(this._singleClickTimeoutId);
                    this._singleClickTimeoutId = 0;
                }
                if (this.menu.isOpen) {
                    this.menu.close();
                }
                this._handleDoubleClickAction();
                return true;
            }

            this.menu.toggle();
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
            // Automatic: inspect current GTK/Cinnamon theme name
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
                let headerRow = new MemTrayMenuRow(headerText, null, {
                    reactive: false,
                    isHeader: true
                });
                this.menu.addMenuItem(headerRow);
            }

            let activePct = Memory.getActiveUsagePercent(memStats, {
                showPageFile: this.show_page_file
            });
            let usageRow = new MemTrayMenuRow("Memory Usage", `${activePct}%`, {
                reactive: false
            });
            this.menu.addMenuItem(usageRow);

            let physBytes = this.show_free_memory ? memStats.ramFree : memStats.ramUsed;
            let physRow = new MemTrayMenuRow(
                "Physical Memory",
                Memory.formatDashboardPair(physBytes, memStats.ramTotal),
                { reactive: false }
            );
            this.menu.addMenuItem(physRow);

            let pageBytes = this.show_free_memory ? memStats.pageFree : memStats.pageUsed;
            let pageRow = new MemTrayMenuRow(
                "Page File",
                Memory.formatDashboardPair(pageBytes, memStats.pageTotal),
                { reactive: false }
            );
            this.menu.addMenuItem(pageRow);
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
            colorBarGreen: this.color_bar_green || "#4caf50",
            colorBarYellow: this.color_bar_yellow || "#d4a017",
            colorBarRed: this.color_bar_red || "#e53935"
        });

        this._canvas.updateState(trayText, usagePercent, {
            useInternalFont: this.use_internal_font !== false,
            customFont: this.custom_font || "Sans Bold 9",
            useBarColorForFont: Boolean(this.use_bar_color_for_font),
            transparentBg: this.transparent_bg !== false,
            opaqueBar: this.opaque_bar !== false,
            standardBar: Boolean(this.standard_bar),
            barAtBottom: Boolean(this.bar_at_bottom),
            colorTrayText: this.color_tray_text || "#ffffff",
            colorTrayBg: this.color_tray_bg || "#1e1e1e",
            colorBarBg: this.color_bar_bg || "#2d2d2d",
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

        // Rebuild menu live if currently open
        if (this.menu && this.menu.isOpen) {
            this._rebuildPopupMenu();
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
        // Cooldown of 120 seconds between automatic high-memory triggers
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

        // First try passwordless sudo / non-interactive sync + cache drop
        let nonInteractiveCmd = `sh -c "sync; sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || true"`;
        Util.spawnCommandLineAsyncIO(nonInteractiveCmd, (_stdout, _stderr, _exitCode) => {
            let checkStats = Memory.readMemoryStats(this.page_file_mode || "commit");
            let freedSoFar = beforeUsed - checkStats.ramUsed;
            if (!interactive || freedSoFar > 5 * Memory.BYTES_PER_MB) {
                finishDefrag();
                return;
            }
            // If manual click and passwordless sudo wasn't configured, try pkexec or finish cleanly
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
        this._panel_height = this.panel ? this.panel.height : 28;
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
