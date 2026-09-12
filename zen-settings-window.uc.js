// ==UserScript==
// @name        Zen Settings Window
// @description Replaces Zen's Settings action with a standalone settings window.
// @include     main
// ==/UserScript==

(() => {
  "use strict";

  const CONTROLLER_KEY = "__zenSettingsWindowMod";
  const WINDOW_NAME = "zen-settings-window";
  const SETTINGS_URI = "about:preferences";
  const SETTINGS_CSS_URI = "chrome://sine/content/zen-settings-window/preferences.css";
  const DEBUG_OS_PREF = "extensions.zen-settings-window.debug.os";

  if (window[CONTROLLER_KEY]) {
    window[CONTROLLER_KEY].destroy();
  }

  const log = (...args) => {
    console.log("[Zen Settings Window]", ...args);
    try {
      Services.console.logStringMessage(`[Zen Settings Window] ${args.join(" ")}`);
    } catch (error) {}
  };

  function getDebugOS() {
    try {
      const value = Services.prefs.getStringPref(DEBUG_OS_PREF, "auto");
      return ["windows", "macos", "linux"].includes(value) ? value : "auto";
    } catch (error) {
      return "auto";
    }
  }

  function getEffectiveOS() {
    const debugOS = getDebugOS();
    return debugOS === "auto" ? getHostOS() : debugOS;
  }

  function getHostOS() {
    try {
      const os = Services.appinfo.OS;
      if (os === "WINNT") {
        return "windows";
      }
      if (os === "Darwin") {
        return "macos";
      }
      return "linux";
    } catch (error) {
      return "windows";
    }
  }

  function injectHostTransparency(doc) {
    if (doc.getElementById("zen-settings-window-host-css")) {
      return;
    }
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "zen-settings-window-host-css";
    style.textContent = `
      :root[zen-settings-window-host],
      :root[zen-settings-window-host] body,
      :root[zen-settings-window-host] #main-window,
      :root[zen-settings-window-host] #browser,
      :root[zen-settings-window-host] #appcontent,
      :root[zen-settings-window-host] #tabbrowser-tabbox,
      :root[zen-settings-window-host] #tabbrowser-tabpanels,
      :root[zen-settings-window-host] tabpanels,
      :root[zen-settings-window-host] browser,
      :root[zen-settings-window-host] .browserSidebarContainer,
      :root[zen-settings-window-host] .browserStack {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
      }

      :root[zen-settings-window-host] {
        --zen-main-browser-background: transparent !important;
        --zen-themed-toolbar-bg-transparent: transparent !important;
        --tabpanel-background-color: transparent !important;
      }

      :root[zen-settings-window-host][zen-settings-window-os="windows"] {
        --zen-settings-window-native-radius: 8px;
        --zen-settings-window-native-control-radius: 4px;
        --zen-settings-window-native-font: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      }

      :root[zen-settings-window-host][zen-settings-window-os="macos"] {
        --zen-settings-window-native-radius: 10px;
        --zen-settings-window-native-control-radius: 7px;
        --zen-settings-window-native-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      }

      :root[zen-settings-window-host][zen-settings-window-os="linux"] {
        --zen-settings-window-native-radius: 10px;
        --zen-settings-window-native-control-radius: 6px;
        --zen-settings-window-native-font: system-ui, "Cantarell", "Ubuntu", sans-serif;
      }

      :root[zen-settings-window-host] #browser {
        padding: 0 !important;
      }

      :root[zen-settings-window-host] #tabbrowser-tabpanels .browserSidebarContainer browser[transparent="true"] {
        background: none !important;
      }
    `;
    doc.documentElement.appendChild(style);
  }

  class ZenSettingsWindowMod {
    constructor(win) {
      this.window = win;
      this.document = win.document;
      this.openSettingsWindow = this.openSettingsWindow.bind(this);
      this.patchZenLibrarySettingsButton = this.patchZenLibrarySettingsButton.bind(this);
      this.handleZenLibrarySettingsButton = this.handleZenLibrarySettingsButton.bind(this);
      this.libraryShadowObservers = new WeakMap();
      this.libraryShadowObserverSet = new Set();
    }

    init() {
      log("loaded");
      this.registerPreferencesStylesheet();
      this.patchOpenPreferences();
      for (const delay of [250, 750, 1500, 3000]) {
        this.window.setTimeout(() => this.patchOpenPreferences(), delay);
      }
      this.patchGlobalActions();
      this.installPanelClickFallback();
      this.installZenLibraryButtonPatch();
      this.window.addEventListener("unload", () => this.destroy(), { once: true });
    }

    registerPreferencesStylesheet() {
      try {
        const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(
          Ci.nsIStyleSheetService
        );
        const uri = Services.io.newURI(SETTINGS_CSS_URI);
        this.settingsStylesheetURI = uri;
        this.settingsStyleSheetService = sss;
        if (!sss.sheetRegistered(uri, sss.USER_SHEET)) {
          sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
        }
      } catch (error) {
        log("Could not register preferences stylesheet", error);
      }
    }

    patchOpenPreferences() {
      if (typeof this.window.openPreferences !== "function") {
        return;
      }
      if (this.window.openPreferences.__zenSettingsWindowPatched) {
        return;
      }
      this.originalOpenPreferences = this.window.openPreferences;
      this.window.openPreferences = (...args) => {
        log("openPreferences intercepted", JSON.stringify({ args }));
        this.openSettingsWindow();
        return undefined;
      };
      this.window.openPreferences.__zenSettingsWindowPatched = true;
      log("openPreferences patched");
    }

    patchGlobalActions() {
      try {
        const mod = ChromeUtils.importESModule("resource:///modules/ZenUBActionsProvider.sys.mjs");
        const action = mod.globalActions?.find(item => item.l10nId === "zen-action-settings");
        if (!action || action.__zenSettingsWindowOriginalCommand) {
          return;
        }
        action.__zenSettingsWindowOriginalCommand = action.command;
        action.command = () => this.openSettingsWindow();
        this.patchedAction = action;
      } catch (error) {
        log("Could not patch Zen global settings action", error);
      }
    }

    installPanelClickFallback() {
      const patchNode = node => {
        if (!node || node.__zenSettingsWindowPatched) {
          return;
        }
        if (node.getAttribute?.("data-l10n-id") !== "zen-action-settings") {
          return;
        }
        node.__zenSettingsWindowPatched = true;
        const handler = event => {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.openSettingsWindow();
        };
        node.addEventListener("command", handler, true);
        node.addEventListener("click", handler, true);
      };

      this.document.querySelectorAll?.('[data-l10n-id="zen-action-settings"]').forEach(patchNode);
      this.observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            patchNode(node);
            node.querySelectorAll?.('[data-l10n-id="zen-action-settings"]').forEach(patchNode);
          }
        }
      });
      this.observer.observe(this.document.documentElement, { childList: true, subtree: true });
    }

    installZenLibraryButtonPatch() {
      this.patchZenLibrarySettingsButton();
      this.libraryObserver = new MutationObserver(() => this.patchZenLibrarySettingsButton());
      this.libraryObserver.observe(this.document.documentElement, { childList: true, subtree: true });
    }

    patchZenLibrarySettingsButton() {
      const libraries = this.document.querySelectorAll?.("zen-library") || [];
      for (const library of libraries) {
        const root = library.shadowRoot;
        if (!root) {
          continue;
        }

        this.patchZenLibraryShadowRoot(root);
        if (!this.libraryShadowObservers.has(root)) {
          const observer = new MutationObserver(() => this.patchZenLibraryShadowRoot(root));
          observer.observe(root, { childList: true, subtree: true });
          this.libraryShadowObservers.set(root, observer);
          this.libraryShadowObserverSet.add(observer);
        }
      }
    }

    patchZenLibraryShadowRoot(root) {
      const button = root.querySelector?.(".sidebar-button-donate[data-id='donate']");
      if (!button || button.__zenSettingsWindowLibraryButtonPatched) {
        return;
      }

      button.__zenSettingsWindowLibraryButtonPatched = true;
      button.dataset.id = "settings";
      button.classList.add("sidebar-button-settings-window");
      button.setAttribute("tooltiptext", "Open Settings");
      button.setAttribute("aria-label", "Open Settings");
      button.style.setProperty("list-style-image", 'url("chrome://browser/skin/settings.svg")', "important");
      button.addEventListener("command", this.handleZenLibrarySettingsButton, true);
      button.addEventListener("click", this.handleZenLibrarySettingsButton, true);
    }

    handleZenLibrarySettingsButton(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openSettingsWindow();
      this.window.gZenLibrary?.close?.();
    }

    openSettingsWindow() {
      if (this.settingsWindow && !this.settingsWindow.closed) {
        this.settingsWindow.focus();
        return;
      }

      const features =
        "chrome,popup,dialog=no,titlebar=yes,toolbar=no,menubar=no,location=no,status=no," +
        "resizable=yes,minimizable=yes,width=940,height=760,centerscreen";
      const settingsWindow = Services.ww.openWindow(
        this.window,
        "chrome://browser/content/browser.xhtml",
        WINDOW_NAME,
        features,
        null
      );
      this.settingsWindow = settingsWindow;
      settingsWindow.addEventListener("load", () => this.initializeSettingsWindow(settingsWindow), {
        once: true,
      });
    }

    initializeSettingsWindow(settingsWindow) {
      const doc = settingsWindow.document;
      const effectiveOS = getEffectiveOS();
      const debugOS = getDebugOS();
      doc.title = "Zen Settings";
      doc.documentElement.setAttribute("zen-settings-window-host", "true");
      doc.documentElement.setAttribute("zen-settings-window-os", effectiveOS);
      if (debugOS !== "auto") {
        doc.documentElement.setAttribute("zen-settings-window-debug-os", debugOS);
      } else {
        doc.documentElement.removeAttribute("zen-settings-window-debug-os");
      }
      doc.documentElement.setAttribute("windowsmica", "true");
      doc.documentElement.setAttribute("transparent", "true");
      doc.documentElement.style.setProperty("background", "transparent", "important");
      doc.documentElement.style.setProperty("--zen-main-browser-background", "transparent", "important");
      doc.documentElement.style.setProperty("--tabpanel-background-color", "transparent", "important");
      injectHostTransparency(doc);

      for (const id of [
        "navigator-toolbox",
        "TabsToolbar",
        "titlebar",
        "sidebar-box",
        "sidebar-splitter",
        "statuspanel",
        "tabbrowser-tabs",
      ]) {
        doc.getElementById(id)?.style?.setProperty("display", "none", "important");
      }

      try {
        Services.prefs.setBoolPref("widget.windows.mica", true);
        Services.prefs.setBoolPref("widget.transparent-windows", true);
        Services.prefs.setBoolPref("browser.tabs.allow_transparent_browser", true);
        Services.prefs.setIntPref("widget.windows.mica.toplevel-backdrop", 2);
        Services.prefs.setBoolPref("zen.theme.acrylic-elements", true);
      } catch (error) {
        log("Could not enable Mica preferences", error);
      }

      this.loadNativePreferences(settingsWindow);
      settingsWindow.focus();
    }

    loadNativePreferences(settingsWindow) {
      const run = attempt => {
        const browser = settingsWindow.gBrowser?.selectedBrowser;
        if (!browser) {
          if (attempt < 80) {
            settingsWindow.setTimeout(() => run(attempt + 1), 100);
          }
          return;
        }

        try {
          browser.setAttribute("transparent", "true");
          browser.style?.setProperty("background", "transparent", "important");
          browser.style?.setProperty("background-color", "transparent", "important");
          browser.loadURI(Services.io.newURI(SETTINGS_URI), {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          });
          browser.addEventListener("pageshow", () => this.applyPreferencesDebug(browser), true);
          settingsWindow.setTimeout(() => this.applyPreferencesDebug(browser), 800);
          log("native about:preferences loaded");
        } catch (error) {
          log("Could not load native about:preferences", error);
        }
      };
      run(0);
    }

    applyPreferencesDebug(browser) {
      try {
        const mm = browser.messageManager;
        if (!mm) {
          return;
        }
        const debugOS = getDebugOS();
        const effectiveOS = getEffectiveOS();
        const script = `
          (() => {
            const DEBUG_OS = ${JSON.stringify(debugOS)};
            const EFFECTIVE_OS = ${JSON.stringify(effectiveOS)};
            const CSS_URI = ${JSON.stringify(SETTINGS_CSS_URI)};
            function apply() {
              if (!String(content.location.href).startsWith("about:preferences")) {
                return;
              }
              const root = content.document.documentElement;
              root.setAttribute("zen-settings-window-content", "true");
              root.setAttribute("zen-settings-window-os", EFFECTIVE_OS);
              if (DEBUG_OS && DEBUG_OS !== "auto") {
                root.setAttribute("zen-settings-window-debug-os", DEBUG_OS);
              } else {
                root.removeAttribute("zen-settings-window-debug-os");
              }
              if (!content.document.getElementById("zen-settings-window-css")) {
                const link = content.document.createElement("link");
                link.id = "zen-settings-window-css";
                link.rel = "stylesheet";
                link.href = CSS_URI;
                root.appendChild(link);
              }
            }
            addEventListener("DOMContentLoaded", apply, true);
            addEventListener("pageshow", apply, true);
            apply();
          })();
        `;
        mm.loadFrameScript(
          `data:application/javascript;charset=utf-8,${encodeURIComponent(script)}`,
          false
        );
      } catch (error) {
        log("Could not install preferences debug hook", error);
      }
    }

    destroy() {
      this.observer?.disconnect();
      this.libraryObserver?.disconnect();
      for (const observer of this.libraryShadowObserverSet || []) {
        observer.disconnect();
      }
      this.libraryShadowObserverSet?.clear();
      if (this.patchedAction?.__zenSettingsWindowOriginalCommand) {
        this.patchedAction.command = this.patchedAction.__zenSettingsWindowOriginalCommand;
        delete this.patchedAction.__zenSettingsWindowOriginalCommand;
      }
      if (this.originalOpenPreferences) {
        this.window.openPreferences = this.originalOpenPreferences;
      }
      delete this.window[CONTROLLER_KEY];
    }
  }

  const controller = new ZenSettingsWindowMod(window);
  window[CONTROLLER_KEY] = controller;
  controller.init();
})();
