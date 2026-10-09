// The page shell for every barnyard.site page: sidebar, top bar (search, quick
// light/dark switch, Settings), page-background layer and the Settings panel.
//
// A page supplies only its own content, inside <main id="page" class="content">,
// and says which page it is with <body data-shell="overview|ops|chat|study|kb|campaign|stocks">.
// This script wraps that content in the shell.
//
// A generated page whose body this repo does not author (the Stocks dashboard,
// its ticker pages and its archive) may leave both out: with no #page the
// script wraps everything in <body> (except scripts) in one, and with no
// data-shell it works out the site from the hostname. Such a page loads the
// script with `defer` from <head>, so the whole body exists when it runs.
//
// Load order on a page that authors its own body:
//
//   <head>   themes.js            (applies the saved theme before first paint)
//   <body>   <main id="page">…</main>
//            shell.js             (builds the shell; creates #auth-status)
//            auth-gate.js         (fills #auth-status, so it must come after)
//            …the page's own scripts
//
// Pages add to the shell through window.BarnyardShell:
//   registerTab({ id, title, render(body) })  an extra Settings tab
//   setSearchSource(fn)                       fn() -> [{ title, hint, go() }]
//   setConnection(status)                     show the Live / Reconnecting pill
//   setBadge(n)                               the number on the Ops nav item
//   toast(text)                               a short confirmation
//
// Everything that reaches the page is built with textContent / createElement,
// never innerHTML, and the Settings swatches are coloured through the CSSOM
// (the site's CSP has no 'unsafe-inline' for styles).
//
// NOTE: like auth-gate.js, this file is hand-copied into each site's repo.
// Keep the copies identical.

(function () {
  "use strict";
  if (typeof document === "undefined" || !window.BarnyardTheme) return;
  var Theme = window.BarnyardTheme;

  var HUB = "https://dashboard.barnyard.site/";
  var PAGES = [
    { id: "overview", title: "Overview", group: "", icon: "home", path: "", local: "./" },
    { id: "ops", title: "Ops board", group: "Work", icon: "board", path: "ops.html", local: "ops.html" },
    // ownerOnly: shown only to the hub owner (Theme.who says owner === true), and hidden until that is known.
    // chatOnly: the Claude chat: the owner, and anyone the Worker says may use it (Theme.who says chat === true,
    // which is true for a guest only while the owner has switched guest chats on). Hidden until that is known.
    { id: "chat", title: "Claude", group: "Work", icon: "chat", path: "chat.html", local: "chat.html", chatOnly: true },
    // `app` is the group-backed app a link needs; a signed-in person whose groups
    // do not include it does not see the link (see Theme.who in themes.js).
    { id: "study", title: "Study", group: "Sites", icon: "book", url: "https://study.barnyard.site/", app: "study" },
    { id: "kb", title: "Knowledgebase", group: "Sites", icon: "bulb", url: "https://study.barnyard.site/knowledgebase.html", app: "study" },
    { id: "campaign", title: "Campaign", group: "Sites", icon: "map", url: "https://campaign.barnyard.site/", app: "campaign" },
    { id: "stocks", title: "Stocks", group: "Sites", icon: "chart", url: "https://stocks.barnyard.site/" }
  ];

  var ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
    chat: '<path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2h-7l-5 4v-4H6a2 2 0 01-2-2z"/><path d="M8 9h8M8 12h5"/>',
    book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
    chart: '<path d="M3 20h18"/><path d="M5 15l4-5 4 3 6-8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
    tune: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>'
  };

  function svg(name, extra) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
    s.setAttribute("class", "i" + (extra ? " " + extra : ""));
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    // Static, built-in path data only; no page or server text is ever passed here.
    s.innerHTML = ICONS[name] || "";
    return s;
  }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  var onBarnyard = /(^|\.)barnyard\.site$/.test(location.hostname);
  function pageHref(p) {
    if (p.url) return p.url;
    return onBarnyard ? HUB + p.path : p.local;
  }

  // Which site this is, for pages that do not say (see the header comment).
  function inferCurrent() {
    var host = location.hostname;
    if (/^study\./.test(host)) return "study";
    if (/^campaign\./.test(host)) return "campaign";
    if (/^stocks\./.test(host)) return "stocks";
    if (/(^|\/)ops\.html$/.test(location.pathname)) return "ops";
    if (/(^|\/)chat\.html$/.test(location.pathname)) return "chat";
    return "overview";
  }

  var current = document.body.getAttribute("data-shell") || inferCurrent();
  var tabs = [{ id: "appearance", title: "Appearance", render: appearanceTab }];
  var searchSource = null;
  var els = {};

  // ---- build ---------------------------------------------------------------

  // Which pages this person can use (Theme.who is filled in a moment after load;
  // until it is known, and whenever it cannot be known, every link shows).
  var navLinks = {};
  function pageAllowed(p) {
    // An owner-only page is shown only once the person is known to be the owner (it fails closed, unlike the app links).
    if (p.ownerOnly) { var s = Theme.who && Theme.who.get(); return !!s && s.owner === true; }
    if (p.chatOnly) { var c = Theme.who && Theme.who.get(); return !!c && (c.owner === true || c.chat === true); }
    return !Theme.who || Theme.who.allows(Theme.who.get(), p.app);
  }
  function applyWho() {
    PAGES.forEach(function (p) { if (navLinks[p.id]) navLinks[p.id].hidden = !pageAllowed(p); });
  }

  function build() {
    if (!document.getElementById("bg")) {
      var bg = h("div", "bg bgx-" + Theme.get().bg);
      bg.id = "bg";
      bg.setAttribute("aria-hidden", "true");
      document.body.insertBefore(bg, document.body.firstChild);
    }
    els.bg = document.getElementById("bg");

    var page = document.getElementById("page");
    if (!page) {
      // A generated page with no #page: adopt the whole body (scripts stay
      // where they are, they have already run). Event listeners and ids
      // survive the move, so the page's own scripts keep working.
      page = h("main", "content");
      page.id = "page";
      var kids = Array.prototype.slice.call(document.body.childNodes).filter(function (n) {
        return n !== els.bg && !(n.nodeType === 1 && (n.tagName === "SCRIPT" || n.tagName === "NOSCRIPT"));
      });
      document.body.insertBefore(page, els.bg.nextSibling);
      kids.forEach(function (n) { page.appendChild(n); });
    }

    var app = h("div", "app");
    var side = h("aside", "side");
    side.id = "side";
    var brand = h("a", "brand");
    brand.href = pageHref(PAGES[0]);
    brand.setAttribute("aria-label", "Barnyard home");
    brand.appendChild(h("span", "brand-mark", "B"));
    brand.appendChild(h("span", "brand-name", "Barnyard"));
    side.appendChild(brand);
    var nav = h("nav", "nav");
    nav.setAttribute("aria-label", "Main");
    var lastGroup = null;
    PAGES.forEach(function (p) {
      if (p.group && p.group !== lastGroup) { nav.appendChild(h("div", "nav-group", p.group)); lastGroup = p.group; }
      var a = h("a");
      a.href = pageHref(p);
      a.title = p.title;
      if (p.id === current) a.setAttribute("aria-current", "page");
      a.appendChild(svg(p.icon));
      a.appendChild(h("span", "lbl", p.title));
      if (p.id === "ops") { els.badge = h("span", "badge", "0"); els.badge.hidden = true; a.appendChild(els.badge); }
      var abs = new URL(a.href, location.href);
      if (abs.origin !== location.origin) a.appendChild(svg("ext", "ext"));
      if (p.app || p.ownerOnly || p.chatOnly) navLinks[p.id] = a;
      if (p.ownerOnly || p.chatOnly) a.hidden = !pageAllowed(p);
      nav.appendChild(a);
    });
    side.appendChild(nav);
    var foot = h("div", "side-foot");
    var auth = h("div", "auth-status");
    auth.id = "auth-status";
    foot.appendChild(auth);
    side.appendChild(foot);

    var main = h("div", "main");
    var top = h("header", "top");
    var pg = PAGES.filter(function (p) { return p.id === current; })[0];
    top.appendChild(h("div", "crumb", !pg || pg.id === "overview" ? "Barnyard" : "Barnyard / " + (pg.group || pg.title)));
    top.appendChild(h("div", "top-spacer"));
    top.appendChild(buildSearch());
    els.live = h("span", "live", "Live");
    els.live.hidden = true;
    els.live.id = "live";
    top.appendChild(els.live);
    els.mode = h("button", "icon-btn");
    els.mode.type = "button";
    els.mode.addEventListener("click", function () { Theme.set({ mode: Theme.isDark() ? "light" : "dark" }); });
    top.appendChild(els.mode);
    els.openSettings = h("button", "icon-btn");
    els.openSettings.type = "button";
    els.openSettings.setAttribute("aria-label", "Settings");
    els.openSettings.setAttribute("aria-haspopup", "dialog");
    els.openSettings.appendChild(svg("tune"));
    els.openSettings.addEventListener("click", function () { settingsOpen ? closeSettings() : openSettings(); });
    top.appendChild(els.openSettings);

    main.appendChild(top);
    page.parentNode.insertBefore(app, page);
    app.appendChild(side);
    app.appendChild(main);
    main.appendChild(page);

    els.toast = h("div", "toast");
    els.toast.setAttribute("role", "status");
    document.body.appendChild(els.toast);
    buildSettingsShell();
    syncModeButton();
    Theme.onChange(function () { els.bg.className = "bg bgx-" + Theme.get().bg; syncModeButton(); if (settingsOpen) renderSettings(true); });
    if (Theme.who) Theme.who.onChange(applyWho);
  }

  function syncModeButton() {
    var dark = Theme.isDark();
    clear(els.mode);
    els.mode.appendChild(svg(dark ? "sun" : "moon"));
    els.mode.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }

  // ---- search --------------------------------------------------------------

  function buildSearch() {
    var wrap = h("div", "search");
    wrap.appendChild(svg("search"));
    var input = h("input");
    input.type = "search";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "shell-results");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Jump to a page or an item");
    input.autocomplete = "off";
    var box = h("div", "results");
    box.id = "shell-results";
    box.setAttribute("role", "listbox");
    box.hidden = true;
    wrap.appendChild(input);
    wrap.appendChild(box);
    var idx = -1;

    function close() { box.hidden = true; input.setAttribute("aria-expanded", "false"); idx = -1; }
    function fit() { input.placeholder = window.innerWidth < 860 ? "Search" : "Jump to a page or an item"; }
    function option(label, hint, go) {
      var b = h("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.appendChild(h("span", null, label));
      if (hint) b.appendChild(h("span", "dim", hint));
      b.addEventListener("click", function () { input.value = ""; close(); go(); });
      return b;
    }
    function run() {
      var q = input.value.trim().toLowerCase();
      clear(box);
      idx = -1;
      if (!q) { close(); return; }
      var pages = PAGES.filter(function (p) { return pageAllowed(p) && p.title.toLowerCase().indexOf(q) !== -1; });
      var found = [];
      if (searchSource) {
        try { found = searchSource().filter(function (x) { return x.title.toLowerCase().indexOf(q) !== -1; }).slice(0, 6); } catch (e) { found = []; }
      }
      if (pages.length) {
        box.appendChild(h("div", "grp", "Pages"));
        pages.forEach(function (p) { box.appendChild(option(p.title, "Page", function () { location.href = pageHref(p); })); });
      }
      if (found.length) {
        box.appendChild(h("div", "grp", "Board items"));
        found.forEach(function (x) { box.appendChild(option(x.title, x.hint, x.go)); });
      }
      if (!pages.length && !found.length) box.appendChild(h("div", "none", "Nothing matches “" + input.value.trim() + "”. Try a page name or a word from an item."));
      box.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    input.addEventListener("input", run);
    input.addEventListener("keydown", function (e) {
      var opts = Array.prototype.slice.call(box.querySelectorAll("button"));
      if (e.key === "Escape") { input.value = ""; close(); return; }
      if (!opts.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
        opts.forEach(function (o, n) { o.setAttribute("aria-selected", String(n === idx)); });
        opts[idx].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") { e.preventDefault(); (opts[idx] || opts[0]).click(); }
    });
    document.addEventListener("click", function (e) { if (!wrap.contains(e.target)) close(); });
    window.addEventListener("resize", fit);
    fit();
    return wrap;
  }

  // ---- toast ---------------------------------------------------------------

  var toastTimer = null;
  // toast("Saved") or toast("Marked done", { label: "Undo", run: fn, ms: 10000 }).
  function toast(text, action) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.style.pointerEvents = action ? "auto" : "";
    if (action && typeof action.run === "function") {
      var b = h("button", null, action.label || "Undo");
      b.type = "button";
      b.addEventListener("click", function () { els.toast.classList.remove("show"); els.toast.style.pointerEvents = ""; action.run(); });
      els.toast.appendChild(b);
    }
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); els.toast.style.pointerEvents = ""; }, (action && action.ms) || 2400);
  }

  // ---- saved-profile note (Settings footer) --------------------------------------
  //
  // The sync itself lives in themes.js (BarnyardTheme.sync); this only says what
  // it is doing, offers sign-in when signed out, and lets the person remove the
  // saved profile.

  var LOGIN_URL = "https://api.barnyard.site/auth/login?return_to=";
  var forgetArmed = null;

  function ago(ms) {
    if (!ms) return "";
    var min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
    var d = Math.round(hr / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  function renderSyncNote() {
    var note = els.syncNote, sync = Theme.sync;
    if (!note) return;
    clear(note);
    var status = sync ? sync.status() : "off";
    if (status === "signed-out") {
      note.appendChild(document.createTextNode("Saved in this browser only. "));
      var a = h("a", null, "Sign in");
      a.href = LOGIN_URL + encodeURIComponent(location.href);
      note.appendChild(a);
      note.appendChild(document.createTextNode(" to keep your look on every browser."));
      return;
    }
    var text = {
      off: "Saved in this browser. Look and feel follows you across the sites.",
      checking: "Checking your profile…",
      unsaved: "Signed in. Your next change is saved to your profile.",
      saving: "Saving to your profile…",
      retrying: "Can't reach your profile right now. Retrying…",
      error: "Couldn't save to your profile. This browser keeps your changes."
    }[status];
    if (status === "saved") text = "Saved to your profile" + (sync.syncedAt() ? ", " + ago(sync.syncedAt()) : "") + ". ";
    note.appendChild(document.createTextNode(text || ""));
    if (status === "saved") {
      var b = h("button", "link-btn", forgetArmed ? "Click again to remove" : "Remove saved profile");
      b.type = "button";
      b.addEventListener("click", function () {
        if (!forgetArmed) {
          forgetArmed = setTimeout(function () { forgetArmed = null; renderSyncNote(); }, 4000);
          renderSyncNote();
          return;
        }
        clearTimeout(forgetArmed); forgetArmed = null;
        sync.forget().then(function (ok) { toast(ok ? "Saved profile removed. This browser keeps its look." : "Couldn't remove it. Try again."); });
      });
      note.appendChild(b);
    }
  }

  if (Theme.sync) {
    Theme.sync.onStatus(renderSyncNote);
    // A saved profile replaced this browser's look: say so, and offer the way back.
    Theme.sync.onAdopt(function (info) {
      if (info.first) {
        toast("Loaded your saved look.", { label: "Keep this browser's", ms: 10000, run: function () { Theme.set(info.previous); renderSettings(true); } });
      } else {
        toast("Updated from your other browser.");
      }
      if (settingsOpen) renderSettings(true);
    });
  }

  // ---- Settings panel ------------------------------------------------------

  var settingsOpen = false, activeTab = "appearance", opener = null;

  function buildSettingsShell() {
    var panel = h("aside", "settings");
    panel.id = "settings";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-hidden", "true");
    panel.setAttribute("aria-labelledby", "settings-title");
    var head = h("div", "st-head");
    var title = h("h2", null, "Settings");
    title.id = "settings-title";
    var close = h("button", "icon-btn");
    close.type = "button";
    close.setAttribute("aria-label", "Close settings");
    close.appendChild(svg("x"));
    close.addEventListener("click", closeSettings);
    head.appendChild(title);
    head.appendChild(close);
    els.tabs = h("div", "st-tabs");
    els.tabs.setAttribute("role", "tablist");
    els.tabs.setAttribute("aria-label", "Settings sections");
    els.body = h("div", "st-body");
    var foot = h("div", "st-foot");
    var reset = h("button", "btn btn-sm", "Reset to defaults");
    reset.type = "button";
    reset.addEventListener("click", function () { Theme.reset(); renderSettings(); toast("Settings reset to defaults"); });
    foot.appendChild(reset);
    els.syncNote = h("span", "sync-note");
    els.syncNote.setAttribute("role", "status");
    foot.appendChild(els.syncNote);
    renderSyncNote();
    panel.appendChild(head);
    panel.appendChild(els.tabs);
    panel.appendChild(els.body);
    panel.appendChild(foot);
    document.body.appendChild(panel);
    els.settings = panel;
    els.closeSettings = close;
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && settingsOpen && !document.querySelector("[aria-modal='true'][aria-hidden='false']")) closeSettings(); });
  }

  function openSettings() {
    settingsOpen = true;
    opener = document.activeElement;
    renderSettings();
    els.settings.classList.add("open");
    els.settings.setAttribute("aria-hidden", "false");
    els.closeSettings.focus();
  }
  function closeSettings() {
    settingsOpen = false;
    els.settings.classList.remove("open");
    els.settings.setAttribute("aria-hidden", "true");
    if (opener && opener.focus) opener.focus();
  }

  function renderSettings(keepPlace) {
    var keepScroll = keepPlace ? els.body.scrollTop : 0;
    var active = keepPlace && document.activeElement && els.body.contains(document.activeElement) ? document.activeElement : null;
    var activeName = active && active.name, activeValue = active && active.value;
    clear(els.tabs);
    tabs.forEach(function (t) {
      var b = h("button", null, t.title);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(t.id === activeTab));
      b.addEventListener("click", function () { activeTab = t.id; renderSettings(); });
      els.tabs.appendChild(b);
    });
    clear(els.body);
    var tab = tabs.filter(function (t) { return t.id === activeTab; })[0] || tabs[0];
    tab.render(els.body);
    els.body.scrollTop = keepScroll;
    if (activeName) {
      var again = els.body.querySelector('input[name="' + activeName + '"][value="' + activeValue + '"]') || els.body.querySelector('input[name="' + activeName + '"]:checked');
      if (again) again.focus({ preventScroll: true });
    }
  }

  // Settings controls other tabs reuse.
  function radios(name, legend, hint, options, value, onPick) {
    var fs = h("fieldset");
    fs.appendChild(h("legend", null, legend));
    if (hint) fs.appendChild(h("p", "hint", hint));
    var seg = h("div", "seg");
    options.forEach(function (o) {
      var label = h("label"), input = h("input");
      input.type = "radio";
      input.name = name;
      input.value = o.value;
      input.checked = o.value === value;
      input.addEventListener("change", function () { onPick(o.value); });
      label.appendChild(input);
      label.appendChild(h("span", null, o.title));
      seg.appendChild(label);
    });
    fs.appendChild(seg);
    return fs;
  }
  function toggle(label, checked, onChange) {
    var wrap = h("span", "sw-toggle"), input = h("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.setAttribute("aria-label", label);
    input.checked = checked;
    input.addEventListener("change", function () { onChange(input.checked); });
    wrap.appendChild(input);
    wrap.appendChild(h("i"));
    return wrap;
  }

  function themeTiles(s) {
    var dark = Theme.isDark(s);
    var fs = h("fieldset");
    fs.appendChild(h("legend", null, "Theme"));
    fs.appendChild(h("p", "hint", "Eighteen colour themes. Each has a light and a dark version, so Mode above still applies."));
    Theme.THEME_GROUPS.forEach(function (g) {
      fs.appendChild(h("p", "tile-group", g[1]));
      var grid = h("div", "tiles");
      Theme.THEMES.filter(function (t) { return t.group === g[0]; }).forEach(function (t) {
        var v = dark ? t.dark : t.light, label = h("label", "tile"), input = h("input");
        input.type = "radio";
        input.name = "theme";
        input.value = t.id;
        input.setAttribute("aria-label", t.name);
        input.checked = s.theme === t.id;
        input.addEventListener("change", function () { Theme.set({ theme: t.id }); toast("Theme: " + t.name); });
        var card = h("div", "tile-card");
        var sw = h("div", "swatch");
        sw.style.setProperty("background", v[0]);
        var side = h("div", "s-side"), main = h("div", "s-main"), row = h("div", "s-row");
        side.style.setProperty("background", v[1]);
        side.style.setProperty("border-right", "1px solid " + v[3]);
        for (var k = 0; k < 3; k++) { var bar = h("i"); bar.style.setProperty("background", k === 0 ? v[7] : v[3]); side.appendChild(bar); }
        var l1 = h("i"), l2 = h("i"), b1 = h("b"), dot = h("u");
        l1.style.setProperty("background", v[5]); l2.style.setProperty("background", v[3]);
        b1.style.setProperty("background", v[7]); dot.style.setProperty("background", v[10]);
        row.appendChild(b1); row.appendChild(dot);
        main.appendChild(l1); main.appendChild(l2); main.appendChild(row);
        sw.appendChild(side); sw.appendChild(main);
        var name = h("span", "tile-name");
        name.appendChild(document.createTextNode(t.name));
        name.appendChild(svg("check"));
        card.appendChild(sw); card.appendChild(name);
        label.appendChild(input); label.appendChild(card);
        grid.appendChild(label);
      });
      fs.appendChild(grid);
    });
    return fs;
  }

  function backgroundTiles(s) {
    var fs = h("fieldset");
    fs.appendChild(h("legend", null, "Background"));
    fs.appendChild(h("p", "hint", "Soft patterns behind the page. They follow your theme colours, and Strength turns them down if they get in the way of reading."));
    Theme.BACKGROUND_GROUPS.forEach(function (g) {
      fs.appendChild(h("p", "tile-group", g[1]));
      var grid = h("div", "tiles");
      Theme.BACKGROUNDS.filter(function (b) { return b.group === g[0]; }).forEach(function (b) {
        var label = h("label", "tile"), input = h("input");
        input.type = "radio";
        input.name = "bg";
        input.value = b.id;
        input.setAttribute("aria-label", b.name);
        input.checked = s.bg === b.id;
        input.addEventListener("change", function () { Theme.set({ bg: b.id }); });
        var card = h("div", "tile-card"), name = h("span", "tile-name");
        name.appendChild(document.createTextNode(b.name));
        name.appendChild(svg("check"));
        card.appendChild(h("div", "thumb bgx-" + b.id));
        card.appendChild(name);
        label.appendChild(input); label.appendChild(card);
        grid.appendChild(label);
      });
      fs.appendChild(grid);
    });
    var strength = radios("bgs", "Strength", "", [{ value: "subtle", title: "Subtle" }, { value: "medium", title: "Medium" }, { value: "strong", title: "Strong" }], s.bgs, function (v) { Theme.set({ bgs: v }); });
    strength.firstChild.className = "sub-legend";
    fs.appendChild(strength);
    return fs;
  }

  function appearanceTab(body) {
    var s = Theme.get();
    body.appendChild(radios("mode", "Mode", "Follow your device, or pick one.", [{ value: "light", title: "Light" }, { value: "dark", title: "Dark" }, { value: "system", title: "Match device" }], s.mode, function (v) { Theme.set({ mode: v }); }));
    body.appendChild(themeTiles(s));
    body.appendChild(backgroundTiles(s));
    body.appendChild(radios("density", "Density", "Compact tightens spacing so more fits on screen.", [{ value: "comfortable", title: "Comfortable" }, { value: "compact", title: "Compact" }], s.density, function (v) { Theme.set({ density: v }); }));
    body.appendChild(radios("sidebar", "Sidebar", "Icons only gives the page more room.", [{ value: "full", title: "Full" }, { value: "icons", title: "Icons only" }], s.sidebar, function (v) { Theme.set({ sidebar: v }); }));
  }

  // ---- public API ----------------------------------------------------------

  window.BarnyardShell = {
    registerTab: function (tab) {
      if (!tab || !tab.id || typeof tab.render !== "function") return;
      tabs = tabs.filter(function (t) { return t.id !== tab.id; });
      tabs.push(tab);
      if (settingsOpen) renderSettings(true);
    },
    setSearchSource: function (fn) { searchSource = typeof fn === "function" ? fn : null; },
    setConnection: function (status) {
      if (!els.live) return;
      var labels = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…", offline: "Offline" };
      els.live.hidden = !labels[status];
      els.live.className = "live" + (status === "live" ? "" : " is-" + status);
      els.live.textContent = labels[status] || "";
    },
    setBadge: function (n) {
      if (!els.badge) return;
      els.badge.textContent = String(n);
      els.badge.hidden = !n;
    },
    toast: toast,
    openSettings: openSettings,
    closeSettings: closeSettings,
    controls: { radios: radios, toggle: toggle, svg: svg },
    reflow: function () { if (settingsOpen) renderSettings(true); }
  };

  build();
})();
