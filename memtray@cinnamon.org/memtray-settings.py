#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MemTray Settings Dialog (Clean-room GTK3 implementation of MemInfo Settings)
Provides the 5-tab configuration window:
  1. General
  2. Additional
  3. Tray Menu
  4. Display
  5. Themes
Synchronizes directly with Cinnamon's AppletSettings JSON configuration.
"""

import argparse
import glob
import hashlib
import json
import os
import sys

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk, Pango

UUID = "memtray@cinnamon.org"
APPLET_DIR = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(APPLET_DIR, "settings-schema.json")
SPICES_DIR = os.path.expanduser(f"~/.config/cinnamon/spices/{UUID}")
CACHE_DIR = os.path.expanduser("~/.cache/cinnamon-memtray")

BUILTIN_THEMES = {
    "meminfo-dark": {
        "name": "MemInfo Dark (Default)",
        "menu-color-mode": "dark",
        "color-menu-highlight": "#b43434",
        "color-tray-text": "#ffffff",
        "color-tray-bg": "#1e1e1e",
        "color-bar-bg": "#2d2d2d",
        "color-bar-green": "#4caf50",
        "color-bar-yellow": "#d4a017",
        "color-bar-red": "#e53935",
    },
    "meminfo-light": {
        "name": "MemInfo Light",
        "menu-color-mode": "light",
        "color-menu-highlight": "#d9534f",
        "color-tray-text": "#1a1a1a",
        "color-tray-bg": "#f0f0f0",
        "color-bar-bg": "#cfcfcf",
        "color-bar-green": "#2e7d32",
        "color-bar-yellow": "#ef6c00",
        "color-bar-red": "#c62828",
    },
    "matrix-green": {
        "name": "High Contrast Green",
        "menu-color-mode": "dark",
        "color-menu-highlight": "#1b5e20",
        "color-tray-text": "#00e676",
        "color-tray-bg": "#0a0a0a",
        "color-bar-bg": "#142814",
        "color-bar-green": "#00e676",
        "color-bar-yellow": "#ffea00",
        "color-bar-red": "#ff1744",
    },
    "ocean-blue": {
        "name": "Ocean Blue",
        "menu-color-mode": "dark",
        "color-menu-highlight": "#1565c0",
        "color-tray-text": "#e3f2fd",
        "color-tray-bg": "#0d1b2a",
        "color-bar-bg": "#1b263b",
        "color-bar-green": "#29b6f6",
        "color-bar-yellow": "#ffa726",
        "color-bar-red": "#ef5350",
    },
}

DISPLAY_ITEMS = [
    ("menu-color-mode", "Menu - Color Mode", "mode"),
    ("color-menu-highlight", "Menu - Top Processes Highlight Color", "color"),
    ("color-tray-text", "Icon Tray - Text", "color"),
    ("color-tray-bg", "Icon Tray - Background", "color"),
    ("color-bar-bg", "Icon Bar - Background", "color"),
    ("color-bar-green", 'Icon Bar - "Normal / Green"', "color"),
    ("color-bar-yellow", 'Icon Bar - "Yellow"', "color"),
    ("color-bar-red", 'Icon Bar - "Red"', "color"),
]


def parse_rgba(hex_str):
    rgba = Gdk.RGBA()
    if not hex_str or not rgba.parse(hex_str):
        rgba.parse("#ffffff")
    return rgba


def rgba_to_hex(rgba):
    r = int(round(rgba.red * 255))
    g = int(round(rgba.green * 255))
    b = int(round(rgba.blue * 255))
    return f"#{r:02x}{g:02x}{b:02x}"


class ConfigStore:
    def __init__(self, instance_id=None):
        self.instance_id = instance_id
        self.schema = self._load_json(SCHEMA_PATH) or {}
        self.config_files = self._find_config_files()
        self.values = {}
        self._load_values()

    def _load_json(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _find_config_files(self):
        os.makedirs(SPICES_DIR, exist_ok=True)
        if self.instance_id:
            target = os.path.join(SPICES_DIR, f"{self.instance_id}.json")
            if os.path.exists(target):
                return [target]
        files = sorted(glob.glob(os.path.join(SPICES_DIR, "*.json")))
        if files:
            return files
        # Create a default instance file if none exists yet
        default_name = f"{self.instance_id or UUID}.json"
        return [os.path.join(SPICES_DIR, default_name)]

    def _load_values(self):
        # Populate defaults from schema first
        for key, meta in self.schema.items():
            if isinstance(meta, dict) and "default" in meta:
                self.values[key] = meta["default"]

        # Overlay from active instance config file
        if self.config_files and os.path.exists(self.config_files[0]):
            data = self._load_json(self.config_files[0])
            if isinstance(data, dict):
                for key, meta in data.items():
                    if isinstance(meta, dict) and "value" in meta:
                        self.values[key] = meta["value"]

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value

    def save(self):
        os.makedirs(SPICES_DIR, exist_ok=True)
        target_files = sorted(glob.glob(os.path.join(SPICES_DIR, "*.json")))
        if not target_files:
            target_files = self.config_files

        for path in target_files:
            data = self._load_json(path)
            if not isinstance(data, dict):
                data = json.loads(json.dumps(self.schema))

            for key, val in self.values.items():
                if key in data and isinstance(data[key], dict):
                    data[key]["value"] = val
                elif key in self.schema and isinstance(self.schema[key], dict):
                    entry = dict(self.schema[key])
                    entry["value"] = val
                    data[key] = entry

            # Recompute __md5__ if present or leave valid JSON
            serialized = json.dumps(data, indent=4, ensure_ascii=False)
            with open(path, "w", encoding="utf-8") as f:
                f.write(serialized + "\n")

        # Notify running applet via cache trigger file
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            trigger = os.path.join(CACHE_DIR, "refresh-all")
            with open(trigger, "w", encoding="utf-8") as f:
                f.write(str(os.times()))
        except Exception:
            pass


def make_section_header(title):
    vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    label = Gtk.Label()
    label.set_markup(f"<b>{title}</b>")
    label.set_halign(Gtk.Align.START)
    hbox.pack_start(label, False, False, 0)
    sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
    sep.set_valign(Gtk.Align.CENTER)
    hbox.pack_start(sep, True, True, 0)
    vbox.pack_start(hbox, False, False, 0)
    return vbox


class MemTraySettingsWindow(Gtk.Window):
    def __init__(self, store, initial_tab=0):
        super().__init__(title="MemTray Settings")
        self.store = store
        self.set_default_size(490, 420)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_resizable(False)
        self.set_border_width(10)

        try:
            icon_path = os.path.join(APPLET_DIR, "icon.svg")
            if os.path.exists(icon_path):
                self.set_icon_from_file(icon_path)
        except Exception:
            pass

        main_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.add(main_vbox)

        self.notebook = Gtk.Notebook()
        main_vbox.pack_start(self.notebook, True, True, 0)

        # Build the 5 tabs matching MemInfo Settings
        self._build_tab_general()
        self._build_tab_additional()
        self._build_tab_tray_menu()
        self._build_tab_display()
        self._build_tab_themes()

        # Bottom button box: OK, Cancel, Apply
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_box.set_halign(Gtk.Align.END)

        self.btn_ok = Gtk.Button(label="OK")
        self.btn_ok.set_size_request(80, -1)
        self.btn_ok.connect("clicked", self._on_ok_clicked)

        self.btn_cancel = Gtk.Button(label="Cancel")
        self.btn_cancel.set_size_request(80, -1)
        self.btn_cancel.connect("clicked", lambda *_: self.destroy())

        self.btn_apply = Gtk.Button(label="Apply")
        self.btn_apply.set_size_request(80, -1)
        self.btn_apply.connect("clicked", self._on_apply_clicked)

        btn_box.pack_start(self.btn_ok, False, False, 0)
        btn_box.pack_start(self.btn_cancel, False, False, 0)
        btn_box.pack_start(self.btn_apply, False, False, 0)
        main_vbox.pack_start(btn_box, False, False, 0)

        self.show_all()
        if 0 <= initial_tab < 5:
            self.notebook.set_current_page(initial_tab)
        self._update_sensitivity()

    # ------------------------------------------------------------------
    # Tab 1: General
    # ------------------------------------------------------------------
    def _build_tab_general(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_border_width(14)

        self.chk_show_page_file = Gtk.CheckButton(label="Show page file instead of physical memory")
        self.chk_show_page_file.set_active(bool(self.store.get("show-page-file", False)))
        box.pack_start(self.chk_show_page_file, False, False, 0)

        self.chk_show_free = Gtk.CheckButton(label="Show free memory instead of memory usage")
        self.chk_show_free.set_active(bool(self.store.get("show-free-memory", False)))
        box.pack_start(self.chk_show_free, False, False, 0)

        self.chk_show_pct = Gtk.CheckButton(label="Show percentage instead of actual value")
        self.chk_show_pct.set_active(bool(self.store.get("show-percentage", False)))
        self.chk_show_pct.connect("toggled", lambda *_: self._update_sensitivity())
        box.pack_start(self.chk_show_pct, False, False, 0)

        # Warnings section
        box.pack_start(make_section_header("Warnings"), False, False, 4)

        lbl_change = Gtk.Label(label="Change bar color when memory is above a certain value:")
        lbl_change.set_halign(Gtk.Align.START)
        box.pack_start(lbl_change, False, False, 0)

        thresh_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        thresh_box.set_margin_start(16)

        thresh_box.pack_start(Gtk.Label(label="Yellow:"), False, False, 0)
        self.spin_yellow = Gtk.SpinButton.new_with_range(1, 99, 1)
        self.spin_yellow.set_value(float(self.store.get("warn-yellow", 65)))
        thresh_box.pack_start(self.spin_yellow, False, False, 0)
        thresh_box.pack_start(Gtk.Label(label="%"), False, False, 0)

        spacer = Gtk.Label(label="    ")
        thresh_box.pack_start(spacer, False, False, 0)

        thresh_box.pack_start(Gtk.Label(label="Red:"), False, False, 0)
        self.spin_red = Gtk.SpinButton.new_with_range(1, 100, 1)
        self.spin_red.set_value(float(self.store.get("warn-red", 90)))
        self.spin_red.connect("value-changed", self._on_red_value_changed)
        thresh_box.pack_start(self.spin_red, False, False, 0)
        thresh_box.pack_start(Gtk.Label(label="%"), False, False, 0)

        box.pack_start(thresh_box, False, False, 0)

        link_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        link_lbl = Gtk.Label()
        link_lbl.set_markup('Bar colors can be customized in the <a href="themes">Themes section</a>')
        link_lbl.set_halign(Gtk.Align.START)
        link_lbl.connect("activate-link", self._on_themes_link_clicked)
        link_box.pack_start(link_lbl, False, False, 0)
        box.pack_start(link_box, False, False, 2)

        red_val = int(self.spin_red.get_value())
        self.lbl_high_mem = Gtk.Label(label=f"On high memory usage (when memory is above {red_val}%):")
        self.lbl_high_mem.set_halign(Gtk.Align.START)
        box.pack_start(self.lbl_high_mem, False, False, 2)

        grid = Gtk.Grid(column_spacing=28, row_spacing=6)
        grid.set_margin_start(16)

        self.chk_high_notify = Gtk.CheckButton(label="Show a notification")
        self.chk_high_notify.set_active(bool(self.store.get("high-mem-notify", True)))
        grid.attach(self.chk_high_notify, 0, 0, 1, 1)

        self.chk_high_log = Gtk.CheckButton(label="Write to log file")
        self.chk_high_log.set_active(bool(self.store.get("high-mem-log", False)))
        grid.attach(self.chk_high_log, 1, 0, 1, 1)

        self.chk_high_defrag = Gtk.CheckButton(label="Defrag memory")
        self.chk_high_defrag.set_active(bool(self.store.get("high-mem-defrag", True)))
        grid.attach(self.chk_high_defrag, 0, 1, 1, 1)

        self.chk_high_msgbox = Gtk.CheckButton(label="Show a message box")
        self.chk_high_msgbox.set_active(bool(self.store.get("high-mem-msgbox", False)))
        grid.attach(self.chk_high_msgbox, 0, 2, 1, 1)

        box.pack_start(grid, False, False, 0)

        self.notebook.append_page(box, Gtk.Label(label="General"))

    def _on_red_value_changed(self, spin):
        red_val = int(spin.get_value())
        self.lbl_high_mem.set_text(f"On high memory usage (when memory is above {red_val}%):")

    def _on_themes_link_clicked(self, label, uri):
        self.notebook.set_current_page(4)
        return True

    # ------------------------------------------------------------------
    # Tab 2: Additional
    # ------------------------------------------------------------------
    def _build_tab_additional(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_border_width(14)

        box.pack_start(make_section_header("Memory Defragmenter"), False, False, 0)

        defrag_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        defrag_row.set_margin_start(12)
        self.chk_defrag_periodic = Gtk.CheckButton(label="Defrag every")
        self.chk_defrag_periodic.set_active(bool(self.store.get("defrag-periodic", False)))
        self.chk_defrag_periodic.connect("toggled", lambda *_: self._update_sensitivity())
        defrag_row.pack_start(self.chk_defrag_periodic, False, False, 0)

        self.spin_defrag_interval = Gtk.SpinButton.new_with_range(1, 1440, 5)
        self.spin_defrag_interval.set_value(float(self.store.get("defrag-interval", 120)))
        defrag_row.pack_start(self.spin_defrag_interval, False, False, 0)
        defrag_row.pack_start(Gtk.Label(label="minutes"), False, False, 0)
        box.pack_start(defrag_row, False, False, 0)

        hotkey_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        hotkey_row.set_margin_start(12)
        hotkey_row.pack_start(Gtk.Label(label="Defrag hotkey:"), False, False, 0)

        self._hotkey_val = str(self.store.get("defrag-hotkey", "") or "")
        self.entry_hotkey = Gtk.Entry()
        self.entry_hotkey.set_editable(False)
        self.entry_hotkey.set_width_chars(24)
        self.entry_hotkey.set_text(self._hotkey_val if self._hotkey_val else "Nenhum")
        self.entry_hotkey.connect("key-press-event", self._on_hotkey_keypress)
        hotkey_row.pack_start(self.entry_hotkey, False, False, 0)
        box.pack_start(hotkey_row, False, False, 0)

        hint_lbl = Gtk.Label()
        hint_lbl.set_markup('<span size="small" alpha="75%">Press "del" to disable "Play/Stop" hotkey</span>')
        hint_lbl.set_halign(Gtk.Align.START)
        hint_lbl.set_margin_start(110)
        box.pack_start(hint_lbl, False, False, 0)

        # Advanced section
        box.pack_start(make_section_header("Advanced"), False, False, 4)

        rate_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        rate_row.set_margin_start(12)
        rate_row.pack_start(Gtk.Label(label="Tray info refresh rate:"), False, False, 0)
        self.spin_refresh_rate = Gtk.SpinButton.new_with_range(250, 60000, 250)
        self.spin_refresh_rate.set_value(float(self.store.get("refresh-rate", 2000)))
        rate_row.pack_start(self.spin_refresh_rate, False, False, 0)
        rate_row.pack_start(Gtk.Label(label="milliseconds*"), False, False, 0)
        box.pack_start(rate_row, False, False, 0)

        note_lbl = Gtk.Label()
        note_lbl.set_markup('<span size="small" style="italic">* 1000 milliseconds = 1 second</span>')
        note_lbl.set_halign(Gtk.Align.START)
        note_lbl.set_margin_start(16)
        box.pack_start(note_lbl, False, False, 0)

        dbl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        dbl_row.set_margin_start(12)
        dbl_row.pack_start(Gtk.Label(label="Tray double click:"), False, False, 0)
        self.combo_dblclick = Gtk.ComboBoxText()
        self.combo_dblclick.append("task-manager", "Start Task Manager (Default)")
        self.combo_dblclick.append("defrag", "Memory Defragmenter")
        self.combo_dblclick.append("settings", "Settings...")
        self.combo_dblclick.append("none", "Do Nothing")
        self.combo_dblclick.set_active_id(str(self.store.get("tray-double-click", "task-manager")))
        dbl_row.pack_start(self.combo_dblclick, True, True, 0)
        box.pack_start(dbl_row, False, False, 2)

        self.chk_display_off = Gtk.CheckButton(label="Switch off computer's display when workstation is locked")
        self.chk_display_off.set_margin_start(12)
        self.chk_display_off.set_active(bool(self.store.get("display-off-on-lock", True)))
        box.pack_start(self.chk_display_off, False, False, 0)

        self.chk_show_tooltip = Gtk.CheckButton(label="Show current memory information in Icon Tooltip")
        self.chk_show_tooltip.set_margin_start(12)
        self.chk_show_tooltip.set_active(bool(self.store.get("show-tooltip", False)))
        box.pack_start(self.chk_show_tooltip, False, False, 0)

        self.notebook.append_page(box, Gtk.Label(label="Additional"))

    def _on_hotkey_keypress(self, widget, event):
        keyval = event.keyval
        if keyval in (Gdk.KEY_Delete, Gdk.KEY_BackSpace, Gdk.KEY_Escape):
            self._hotkey_val = ""
            self.entry_hotkey.set_text("Nenhum")
            return True

        # Ignore standalone modifier keys
        if keyval in (
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
        ):
            return True

        state = event.state & Gtk.accelerator_get_default_mod_mask()
        accel = Gtk.accelerator_name(keyval, state)
        if accel:
            self._hotkey_val = accel
            self.entry_hotkey.set_text(accel)
        return True

    # ------------------------------------------------------------------
    # Tab 3: Tray Menu
    # ------------------------------------------------------------------
    def _build_tab_tray_menu(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=9)
        box.set_border_width(14)

        box.pack_start(make_section_header("Processes"), False, False, 0)

        self.chk_show_procs = Gtk.CheckButton(label="Show top memory usage processes")
        self.chk_show_procs.set_margin_start(8)
        self.chk_show_procs.set_active(bool(self.store.get("show-top-processes", True)))
        self.chk_show_procs.connect("toggled", lambda *_: self._update_sensitivity())
        box.pack_start(self.chk_show_procs, False, False, 0)

        top_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        top_row.set_margin_start(24)
        top_row.pack_start(Gtk.Label(label="Show the top"), False, False, 0)
        self.spin_top_count = Gtk.SpinButton.new_with_range(1, 30, 1)
        self.spin_top_count.set_value(float(self.store.get("top-processes-count", 10)))
        top_row.pack_start(self.spin_top_count, False, False, 0)
        top_row.pack_start(Gtk.Label(label="processes"), False, False, 0)
        box.pack_start(top_row, False, False, 0)

        disp_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        disp_row.set_margin_start(24)
        disp_row.pack_start(Gtk.Label(label="Display current"), False, False, 0)
        self.combo_proc_mode = Gtk.ComboBoxText()
        self.combo_proc_mode.append("value", "Memory value")
        self.combo_proc_mode.append("percent", "Percentage")
        self.combo_proc_mode.set_active_id(str(self.store.get("process-display-mode", "value")))
        disp_row.pack_start(self.combo_proc_mode, False, False, 0)
        box.pack_start(disp_row, False, False, 0)

        hl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        hl_row.set_margin_start(24)
        self.chk_hl_procs = Gtk.CheckButton(label="Highlight processes with memory value above")
        self.chk_hl_procs.set_active(bool(self.store.get("highlight-processes", True)))
        self.chk_hl_procs.connect("toggled", lambda *_: self._update_sensitivity())
        hl_row.pack_start(self.chk_hl_procs, False, False, 0)

        self.spin_hl_mb = Gtk.SpinButton.new_with_range(10, 65536, 50)
        self.spin_hl_mb.set_value(float(self.store.get("highlight-threshold-mb", 1000)))
        hl_row.pack_start(self.spin_hl_mb, False, False, 0)
        hl_row.pack_start(Gtk.Label(label="MB"), False, False, 0)
        box.pack_start(hl_row, False, False, 0)

        self.chk_proc_name = Gtk.CheckButton(label="Show process name instead of module name")
        self.chk_proc_name.set_margin_start(24)
        self.chk_proc_name.set_active(bool(self.store.get("show-process-name", False)))
        box.pack_start(self.chk_proc_name, False, False, 0)

        self.chk_unify_procs = Gtk.CheckButton(label="Unify the same processes")
        self.chk_unify_procs.set_margin_start(24)
        self.chk_unify_procs.set_active(bool(self.store.get("unify-processes", True)))
        box.pack_start(self.chk_unify_procs, False, False, 0)

        box.pack_start(make_section_header("More"), False, False, 4)

        self.chk_show_dashboard = Gtk.CheckButton(label="Show current memory information dashboard")
        self.chk_show_dashboard.set_margin_start(8)
        self.chk_show_dashboard.set_active(bool(self.store.get("show-dashboard", True)))
        self.chk_show_dashboard.connect("toggled", lambda *_: self._update_sensitivity())
        box.pack_start(self.chk_show_dashboard, False, False, 0)

        self.chk_show_tray_info = Gtk.CheckButton(label="Show what is the value displayed in tray")
        self.chk_show_tray_info.set_margin_start(8)
        self.chk_show_tray_info.set_active(bool(self.store.get("show-tray-value-info", True)))
        box.pack_start(self.chk_show_tray_info, False, False, 0)

        self.notebook.append_page(box, Gtk.Label(label="Tray Menu"))

    # ------------------------------------------------------------------
    # Tab 4: Display
    # ------------------------------------------------------------------
    def _build_tab_display(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_border_width(14)

        box.pack_start(make_section_header("Font"), False, False, 0)

        font_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        font_row.set_margin_start(12)

        self._custom_font_str = str(self.store.get("custom-font", "Sans Bold 9"))
        self.entry_font_preview = Gtk.Entry()
        self.entry_font_preview.set_editable(False)
        self.entry_font_preview.set_alignment(0.5)
        font_row.pack_start(self.entry_font_preview, True, True, 0)

        self.btn_font = Gtk.Button(label="Font...")
        self.btn_font.set_size_request(80, -1)
        self.btn_font.connect("clicked", self._on_choose_font_clicked)
        font_row.pack_start(self.btn_font, False, False, 0)
        box.pack_start(font_row, False, False, 0)

        self.chk_internal_font = Gtk.CheckButton(label="Use internal font for optimized results")
        self.chk_internal_font.set_margin_start(12)
        self.chk_internal_font.set_active(bool(self.store.get("use-internal-font", True)))
        self.chk_internal_font.connect("toggled", lambda *_: self._update_sensitivity())
        box.pack_start(self.chk_internal_font, False, False, 0)

        self.chk_bar_color_font = Gtk.CheckButton(label="Use bar color for font color")
        self.chk_bar_color_font.set_margin_start(12)
        self.chk_bar_color_font.set_active(bool(self.store.get("use-bar-color-for-font", False)))
        box.pack_start(self.chk_bar_color_font, False, False, 0)

        box.pack_start(make_section_header("Appearance"), False, False, 4)

        app_grid = Gtk.Grid(column_spacing=36, row_spacing=8)
        app_grid.set_margin_start(12)

        self.chk_transparent_bg = Gtk.CheckButton(label="Transparent background")
        self.chk_transparent_bg.set_active(bool(self.store.get("transparent-bg", True)))
        app_grid.attach(self.chk_transparent_bg, 0, 0, 1, 1)

        self.chk_bar_bottom = Gtk.CheckButton(label="Bar at bottom")
        self.chk_bar_bottom.set_active(bool(self.store.get("bar-at-bottom", False)))
        app_grid.attach(self.chk_bar_bottom, 1, 0, 1, 1)

        self.chk_opaque_bar = Gtk.CheckButton(label="Opaque bar")
        self.chk_opaque_bar.set_active(bool(self.store.get("opaque-bar", True)))
        app_grid.attach(self.chk_opaque_bar, 0, 1, 1, 1)

        self.chk_show_pct_sign = Gtk.CheckButton(label="Show % sign")
        self.chk_show_pct_sign.set_active(bool(self.store.get("show-percent-sign", False)))
        app_grid.attach(self.chk_show_pct_sign, 1, 1, 1, 1)

        self.chk_standard_bar = Gtk.CheckButton(label="Standard bar")
        self.chk_standard_bar.set_active(bool(self.store.get("standard-bar", False)))
        app_grid.attach(self.chk_standard_bar, 0, 2, 1, 1)

        box.pack_start(app_grid, False, False, 0)

        self.notebook.append_page(box, Gtk.Label(label="Display"))

    def _on_choose_font_clicked(self, _btn):
        dlg = Gtk.FontChooserDialog(title="Select Tray Font", parent=self)
        dlg.set_font(self._custom_font_str)
        resp = dlg.run()
        if resp == Gtk.ResponseType.OK:
            self._custom_font_str = dlg.get_font()
            self._update_sensitivity()
        dlg.destroy()

    # ------------------------------------------------------------------
    # Tab 5: Themes
    # ------------------------------------------------------------------
    def _build_tab_themes(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_border_width(14)

        try:
            self._custom_themes = json.loads(self.store.get("custom-themes-json", "{}") or "{}")
            if not isinstance(self._custom_themes, dict):
                self._custom_themes = {}
        except Exception:
            self._custom_themes = {}

        self._theme_values = {
            "menu-color-mode": str(self.store.get("menu-color-mode", "auto")),
            "color-menu-highlight": str(self.store.get("color-menu-highlight", "#b43434")),
            "color-tray-text": str(self.store.get("color-tray-text", "#ffffff")),
            "color-tray-bg": str(self.store.get("color-tray-bg", "#1e1e1e")),
            "color-bar-bg": str(self.store.get("color-bar-bg", "#2d2d2d")),
            "color-bar-green": str(self.store.get("color-bar-green", "#4caf50")),
            "color-bar-yellow": str(self.store.get("color-bar-yellow", "#d4a017")),
            "color-bar-red": str(self.store.get("color-bar-red", "#e53935")),
        }

        theme_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        theme_row.pack_start(Gtk.Label(label="Theme:"), False, False, 0)
        self.combo_theme = Gtk.ComboBoxText()
        self._populate_theme_combo()
        self.combo_theme.connect("changed", self._on_theme_preset_changed)
        theme_row.pack_start(self.combo_theme, True, True, 0)
        box.pack_start(theme_row, False, False, 0)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_row.set_halign(Gtk.Align.END)
        self.btn_save_theme = Gtk.Button(label="Save As...")
        self.btn_save_theme.set_size_request(95, -1)
        self.btn_save_theme.connect("clicked", self._on_save_theme_clicked)

        self.btn_delete_theme = Gtk.Button(label="Delete")
        self.btn_delete_theme.set_size_request(95, -1)
        self.btn_delete_theme.connect("clicked", self._on_delete_theme_clicked)

        btn_row.pack_start(self.btn_save_theme, False, False, 0)
        btn_row.pack_start(self.btn_delete_theme, False, False, 0)
        box.pack_start(btn_row, False, False, 0)

        lbl_items = Gtk.Label(label="Display Items:")
        lbl_items.set_halign(Gtk.Align.START)
        box.pack_start(lbl_items, False, False, 0)

        split_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)

        # Left list of display items
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_shadow_type(Gtk.ShadowType.IN)
        scrolled.set_size_request(265, 190)

        self.items_list = Gtk.ListBox()
        self.items_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        for key, title, kind in DISPLAY_ITEMS:
            row = Gtk.ListBoxRow()
            row.item_key = key
            row.item_kind = kind
            lbl = Gtk.Label(label=title)
            lbl.set_halign(Gtk.Align.START)
            lbl.set_margin_start(6)
            lbl.set_margin_end(6)
            lbl.set_margin_top(3)
            lbl.set_margin_bottom(3)
            row.add(lbl)
            self.items_list.add(row)

        self.items_list.connect("row-selected", self._on_display_item_selected)
        scrolled.add(self.items_list)
        split_box.pack_start(scrolled, False, False, 0)

        # Right editor area for the selected item
        self.editor_stack = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)

        self.combo_menu_mode = Gtk.ComboBoxText()
        self.combo_menu_mode.append("auto", "Automatic")
        self.combo_menu_mode.append("dark", "Dark")
        self.combo_menu_mode.append("light", "Light")
        self.combo_menu_mode.set_active_id(self._theme_values["menu-color-mode"])
        self.combo_menu_mode.connect("changed", self._on_item_mode_changed)
        self.editor_stack.pack_start(self.combo_menu_mode, False, False, 0)

        self.color_btn_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.color_btn = Gtk.ColorButton()
        self.color_btn.set_size_request(140, 36)
        self.color_btn.connect("color-set", self._on_item_color_set)
        self.color_btn_box.pack_start(self.color_btn, False, False, 0)

        self.lbl_color_hex = Gtk.Label(label="#ffffff")
        self.lbl_color_hex.set_halign(Gtk.Align.START)
        self.color_btn_box.pack_start(self.lbl_color_hex, False, False, 0)
        self.editor_stack.pack_start(self.color_btn_box, False, False, 0)

        split_box.pack_start(self.editor_stack, True, True, 0)
        box.pack_start(split_box, True, True, 0)

        self.notebook.append_page(box, Gtk.Label(label="Themes"))

        first_row = self.items_list.get_row_at_index(0)
        if first_row:
            self.items_list.select_row(first_row)

    def _populate_theme_combo(self):
        active_id = self.combo_theme.get_active_id() or str(self.store.get("theme-preset", "current"))
        self.combo_theme.remove_all()
        self.combo_theme.append("current", "Current Colors")
        for tid, tdata in BUILTIN_THEMES.items():
            self.combo_theme.append(tid, tdata["name"])
        for tid, tdata in self._custom_themes.items():
            self.combo_theme.append(tid, tdata.get("name", tid))
        if not self.combo_theme.set_active_id(active_id):
            self.combo_theme.set_active_id("current")

    def _on_theme_preset_changed(self, combo):
        tid = combo.get_active_id()
        if not tid:
            return
        self.btn_delete_theme.set_sensitive(tid in self._custom_themes)
        preset = BUILTIN_THEMES.get(tid) or self._custom_themes.get(tid)
        if preset:
            for k in self._theme_values:
                if k in preset:
                    self._theme_values[k] = preset[k]
            self.combo_menu_mode.set_active_id(self._theme_values["menu-color-mode"])
            selected_row = self.items_list.get_selected_row()
            if selected_row:
                self._on_display_item_selected(self.items_list, selected_row)

    def _on_display_item_selected(self, _listbox, row):
        if not row:
            return
        if row.item_kind == "mode":
            self.combo_menu_mode.show()
            self.color_btn_box.hide()
            self.combo_menu_mode.set_active_id(self._theme_values["menu-color-mode"])
        else:
            self.combo_menu_mode.hide()
            self.color_btn_box.show()
            hex_col = self._theme_values.get(row.item_key, "#ffffff")
            self.color_btn.set_rgba(parse_rgba(hex_col))
            self.lbl_color_hex.set_text(f"Color: {hex_col.upper()}")

    def _on_item_mode_changed(self, combo):
        val = combo.get_active_id()
        if val:
            self._theme_values["menu-color-mode"] = val

    def _on_item_color_set(self, btn):
        row = self.items_list.get_selected_row()
        if not row or row.item_kind != "color":
            return
        hex_col = rgba_to_hex(btn.get_rgba())
        self._theme_values[row.item_key] = hex_col
        self.lbl_color_hex.set_text(f"Color: {hex_col.upper()}")

    def _on_save_theme_clicked(self, _btn):
        dlg = Gtk.Dialog(
            title="Save Theme As",
            transient_for=self,
            flags=0,
        )
        dlg.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OK, Gtk.ResponseType.OK,
        )
        content = dlg.get_content_area()
        content.set_spacing(8)
        content.set_border_width(10)
        content.pack_start(Gtk.Label(label="Enter a name for the custom theme:"), False, False, 0)
        entry = Gtk.Entry()
        entry.set_text("My Custom Theme")
        content.pack_start(entry, False, False, 0)
        dlg.show_all()

        if dlg.run() == Gtk.ResponseType.OK:
            name = entry.get_text().strip()
            if name:
                slug = "custom-" + hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
                saved = dict(self._theme_values)
                saved["name"] = name
                self._custom_themes[slug] = saved
                self._populate_theme_combo()
                self.combo_theme.set_active_id(slug)
        dlg.destroy()

    def _on_delete_theme_clicked(self, _btn):
        tid = self.combo_theme.get_active_id()
        if tid and tid in self._custom_themes:
            del self._custom_themes[tid]
            self._populate_theme_combo()
            self.combo_theme.set_active_id("current")

    # ------------------------------------------------------------------
    # State Sensitivity & Persistence
    # ------------------------------------------------------------------
    def _update_sensitivity(self):
        # Periodic defrag
        self.spin_defrag_interval.set_sensitive(self.chk_defrag_periodic.get_active())

        # Processes controls
        procs_on = self.chk_show_procs.get_active()
        self.spin_top_count.set_sensitive(procs_on)
        self.combo_proc_mode.set_sensitive(procs_on)
        self.chk_hl_procs.set_sensitive(procs_on)
        self.spin_hl_mb.set_sensitive(procs_on and self.chk_hl_procs.get_active())
        self.chk_proc_name.set_sensitive(procs_on)
        self.chk_unify_procs.set_sensitive(procs_on)

        # Dashboard header
        self.chk_show_tray_info.set_sensitive(self.chk_show_dashboard.get_active())

        # Font preview & button
        use_internal = self.chk_internal_font.get_active()
        self.entry_font_preview.set_text("(Internal Font)" if use_internal else self._custom_font_str)
        self.btn_font.set_sensitive(not use_internal)

        # Show % sign only relevant when showing percentage
        self.chk_show_pct_sign.set_sensitive(self.chk_show_pct.get_active())

        # Delete theme button
        tid = self.combo_theme.get_active_id()
        self.btn_delete_theme.set_sensitive(bool(tid and tid in self._custom_themes))

    def _collect_and_save(self):
        # Tab 1: General
        self.store.set("show-page-file", self.chk_show_page_file.get_active())
        self.store.set("show-free-memory", self.chk_show_free.get_active())
        self.store.set("show-percentage", self.chk_show_pct.get_active())
        self.store.set("warn-yellow", int(self.spin_yellow.get_value()))
        self.store.set("warn-red", int(self.spin_red.get_value()))
        self.store.set("high-mem-notify", self.chk_high_notify.get_active())
        self.store.set("high-mem-log", self.chk_high_log.get_active())
        self.store.set("high-mem-defrag", self.chk_high_defrag.get_active())
        self.store.set("high-mem-msgbox", self.chk_high_msgbox.get_active())

        # Tab 2: Additional
        self.store.set("defrag-periodic", self.chk_defrag_periodic.get_active())
        self.store.set("defrag-interval", int(self.spin_defrag_interval.get_value()))
        self.store.set("defrag-hotkey", self._hotkey_val)
        self.store.set("refresh-rate", int(self.spin_refresh_rate.get_value()))
        self.store.set("tray-double-click", self.combo_dblclick.get_active_id() or "task-manager")
        self.store.set("display-off-on-lock", self.chk_display_off.get_active())
        self.store.set("show-tooltip", self.chk_show_tooltip.get_active())

        # Tab 3: Tray Menu
        self.store.set("show-top-processes", self.chk_show_procs.get_active())
        self.store.set("top-processes-count", int(self.spin_top_count.get_value()))
        self.store.set("process-display-mode", self.combo_proc_mode.get_active_id() or "value")
        self.store.set("highlight-processes", self.chk_hl_procs.get_active())
        self.store.set("highlight-threshold-mb", int(self.spin_hl_mb.get_value()))
        self.store.set("show-process-name", self.chk_proc_name.get_active())
        self.store.set("unify-processes", self.chk_unify_procs.get_active())
        self.store.set("show-dashboard", self.chk_show_dashboard.get_active())
        self.store.set("show-tray-value-info", self.chk_show_tray_info.get_active())

        # Tab 4: Display
        self.store.set("use-internal-font", self.chk_internal_font.get_active())
        self.store.set("custom-font", self._custom_font_str)
        self.store.set("use-bar-color-for-font", self.chk_bar_color_font.get_active())
        self.store.set("transparent-bg", self.chk_transparent_bg.get_active())
        self.store.set("opaque-bar", self.chk_opaque_bar.get_active())
        self.store.set("standard-bar", self.chk_standard_bar.get_active())
        self.store.set("bar-at-bottom", self.chk_bar_bottom.get_active())
        self.store.set("show-percent-sign", self.chk_show_pct_sign.get_active())

        # Tab 5: Themes
        self.store.set("theme-preset", self.combo_theme.get_active_id() or "current")
        self.store.set("custom-themes-json", json.dumps(self._custom_themes))
        for k, v in self._theme_values.items():
            self.store.set(k, v)

        self.store.save()

    def _on_apply_clicked(self, _btn):
        self._collect_and_save()

    def _on_ok_clicked(self, _btn):
        self._collect_and_save()
        self.destroy()


def main():
    parser = argparse.ArgumentParser(description="MemTray Settings Dialog")
    parser.add_argument("--instance-id", default=None, help="Cinnamon applet instance ID")
    parser.add_argument("--tab", type=int, default=0, help="Initial tab index (0-4)")
    args = parser.parse_args()

    store = ConfigStore(instance_id=args.instance_id)
    win = MemTraySettingsWindow(store, initial_tab=args.tab)
    win.connect("destroy", Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    main()
