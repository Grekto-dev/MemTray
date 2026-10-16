#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MemTray About Dialog
Displays information about MemTray (Clean-room MemInfo for Cinnamon).
"""

import os
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GdkPixbuf, Gtk

APPLET_DIR = os.path.dirname(os.path.abspath(__file__))


def main():
    dlg = Gtk.AboutDialog()
    dlg.set_program_name("MemTray")
    dlg.set_version("1.0.0")
    dlg.set_comments(
        "Clean-room implementation of Windows MemInfo for the Cinnamon Desktop taskbar.\n\n"
        "Features live physical memory & page file monitoring, top memory-consuming "
        "processes with automatic unification and high-usage highlighting, memory "
        "defragmenter, threshold warnings, and customizable color themes."
    )
    dlg.set_website("https://github.com/Grekto-dev/MemTray")
    dlg.set_website_label("GitHub Repository (Grekto-dev/MemTray)")
    dlg.set_authors(["Pedro (Grekto-dev)"])
    dlg.set_license_type(Gtk.License.GPL_3_0)

    icon_path = os.path.join(APPLET_DIR, "icon.svg")
    if os.path.exists(icon_path):
        try:
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(icon_path, 64, 64)
            dlg.set_logo(pixbuf)
        except Exception:
            pass

    dlg.run()
    dlg.destroy()


if __name__ == "__main__":
    main()
