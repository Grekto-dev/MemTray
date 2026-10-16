# Makefile for MemTray Cinnamon Applet
UUID = memtray@cinnamon.org
APPLET_DIR = $(HOME)/.local/share/cinnamon/applets/$(UUID)
BIN_DIR = $(HOME)/.local/bin

.PHONY: all install uninstall test status settings

all:
	@echo "MemTray Cinnamon Applet ($(UUID))"
	@echo "Run 'make install' to install the applet to $(APPLET_DIR)"
	@echo "Run 'make test' to run unit & integration tests"

install:
	@chmod +x install.sh
	@./install.sh

uninstall:
	@echo "Uninstalling $(UUID)..."
	@rm -rf $(APPLET_DIR)
	@rm -f $(BIN_DIR)/cinnamon-memtray-ctl
	@echo "Uninstallation complete."

test:
	@cjs tests/test_memtray.js

status:
	@./bin/cinnamon-memtray-ctl status

settings:
	@python3 $(UUID)/memtray-settings.py
