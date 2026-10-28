// The page shell for every barnyard.site page: sidebar, top bar (search, quick
// light/dark switch, Settings), page-background layer and the Settings panel.
//
// A page supplies only its own content, inside <main id="page" class="content">,
// and says which page it is with <body data-shell="overview|ops|vuln|calendar|monitor|chat|study|kb|campaign|stocks">.
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
//   openSettings(tabId?)                      open Settings, on that tab when it exists
//   palette.open() / close()                  the command palette (Ctrl+K or Cmd+K on every page)
//   palette.registerCommands(fn)              fn() -> [{ title, hint, keywords, run }]: commands a page adds to the palette
//
// The command palette jumps to any page the person may use (the same permission rules as the sidebar, so a tab the
// owner hid from them never appears), changes the look (mode, theme, spacing), and, on the hub for its owner, files a
// to-do or an Ops proposal and searches the Ops board, Notebook and Knowledgebase. That search is ONE request per
// settled query: at least three letters, 450 ms after the last key, answered from a 60 second cache when the same words
// were asked a moment ago, and at most ten a minute. Nothing is sent while the palette is closed.
//
// Everything that reaches the page is built with textContent / createElement,
// never innerHTML, and the Settings swatches are coloured through the CSSOM
// (the site's CSP has no 'unsafe-inline' for styles).
//
// NOTE: like auth-gate.js, this file is hand-copied into each site's repo.
// Keep the copies identical.

(function () {
  "use strict";

  // ---- command palette: the parts that need no page (tested in test/palette.test.js) ----------------------
  var Logic = paletteLogic();
  function paletteLogic() {
    var HUB_ORIGIN = "https://dashboard.barnyard.site", API = "https://api.barnyard.site";
    var SERVER_MIN = 3, DEBOUNCE_MS = 450, CACHE_MS = 60000, CACHE_MAX = 30, PER_MINUTE = 10, SHOW_MAX = 6;

    function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim(); }

    // How well `text` answers the query, 0 (not at all) to 100 (the same words).
    function score(query, text) {
      var q = norm(query), t = norm(text);
      if (!q) return 1;
      if (!t) return 0;
      if (t === q) return 100;
      if (t.indexOf(q) === 0) return 80;
      if (t.indexOf(" " + q) !== -1) return 60;
      var words = q.split(" ");
      if (words.length > 1 && words.every(function (w) { return (" " + t).indexOf(" " + w) !== -1; })) return 50;
      if (t.indexOf(q) !== -1) return 40;
      if (q.length <= 6 && q.indexOf(" ") === -1 && t.charAt(0) === q.charAt(0)) {   // letters in order from the first: "ovw" finds "Overview"
        var i = 0;
        for (var k = 0; k < t.length && i < q.length; k++) if (t.charAt(k) === q.charAt(i)) i++;
        if (i === q.length) return 20;
      }
      return 0;
    }

    // The items that answer the query, best first (ties keep their order); an empty query keeps them all in order.
    function rank(items, query, limit) {
      var scored = [];
      (items || []).forEach(function (it, n) {
        var s = Math.max(score(query, it.title), it.keywords ? score(query, it.keywords) - 10 : 0);
        if (s > 0) scored.push([s, n, it]);
      });
      scored.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
      return scored.slice(0, limit || SHOW_MAX).map(function (x) { return x[2]; });
    }

    // Only links the Worker could have made: a page of the hub, or the study site. -> an absolute address, or "".
    function safeHref(href) {
      var h = String(href == null ? "" : href);
      if (/^[a-z-]{1,24}\.html(#[A-Za-z0-9_\/-]{1,60})?$/.test(h)) return HUB_ORIGIN + "/" + h;
      if (/^https:\/\/study\.barnyard\.site\/(notes|knowledgebase)\.html#[A-Za-z0-9_\/-]{1,60}$/.test(h)) return h;
      return "";
    }

    // A search answer, kept to what the palette shows: [{ title, items: [{ title, hint, href }] }], every link checked.
    function cleanGroups(data) {
      var out = [];
      (data && Array.isArray(data.groups) ? data.groups : []).slice(0, 4).forEach(function (g) {
        if (!g || g.skipped || g.error || !Array.isArray(g.items)) return;
        var items = [];
        g.items.slice(0, SHOW_MAX).forEach(function (x) {
          var href = x && safeHref(x.href);
          if (href && x.title) items.push({ title: String(x.title).slice(0, 120), hint: String(x.hint || "").slice(0, 40), href: href });
        });
        if (items.length) out.push({ title: String(g.title || "Results").slice(0, 40), items: items });
      });
      return out;
    }

    // What "add this" sends, per kind -> { path, body, done } or null when there is nothing to file or it is too long.
    function capture(kind, text) {
      var t = String(text == null ? "" : text).replace(/\r\n/g, "\n").trim();
      if (!t) return null;
      var first = t.split("\n")[0].replace(/\s+/g, " ").trim();
      if (kind === "todo") {
        if (!first || t.length > 4200) return null;
        var body = { title: first.slice(0, 200) };
        if (t.length > body.title.length) body.notes = t.slice(0, 4000);
        return { path: "/planner/task", body: body, done: "To-do added" };
      }
      if (kind === "proposal") {
        var title = first.slice(0, 120).trim();
        if (!title || t.length > 6000) return null;
        var p = { title: title, lane: "backlog", category: "other", proposal: true };
        if (t.length > title.length) p.details = t;
        return { path: "/ops/items", body: p, done: "Proposal added for you to approve" };
      }
      return null;
    }

    // A small time-limited memory of search answers, keyed by the words asked.
    function makeCache(now) {
      var clock = now || Date.now, rows = {}, keys = [];
      return {
        get: function (q) { var r = rows[q]; if (!r) return null; if (clock() - r.at > CACHE_MS) { delete rows[q]; keys = keys.filter(function (k) { return k !== q; }); return null; } return r.value; },
        set: function (q, value) {
          if (!rows[q]) keys.push(q);
          rows[q] = { at: clock(), value: value };
          while (keys.length > CACHE_MAX) delete rows[keys.shift()];
        }
      };
    }

    // At most `max` takes in any `windowMs`.
    function makeLimiter(max, windowMs, now) {
      var clock = now || Date.now, stamps = [];
      return { take: function () { var t = clock(); stamps = stamps.filter(function (s) { return t - s < windowMs; }); if (stamps.length >= max) return false; stamps.push(t); return true; } };
    }

    return {
      norm: norm, score: score, rank: rank, safeHref: safeHref, cleanGroups: cleanGroups, capture: capture, makeCache: makeCache, makeLimiter: makeLimiter,
      HUB_ORIGIN: HUB_ORIGIN, API: API, SERVER_MIN: SERVER_MIN, DEBOUNCE_MS: DEBOUNCE_MS, CACHE_MS: CACHE_MS, CACHE_MAX: CACHE_MAX, PER_MINUTE: PER_MINUTE, SHOW_MAX: SHOW_MAX
    };
  }

  if (typeof document === "undefined" || !window.BarnyardTheme) {
    if (typeof module !== "undefined" && module.exports) module.exports = Logic;
    return;
  }
  var Theme = window.BarnyardTheme;

  var HUB = "https://dashboard.barnyard.site/";
  var PAGES = [
    // perm: the permission the owner's Users page can take away ("ops.view"); a link is hidden when the signed-in person's
    // permissions list exists and lacks it (presentation only: the Worker refuses the request).
    { id: "overview", title: "Overview", group: "", icon: "home", path: "", local: "./", perm: "overview.view" },
    { id: "ops", title: "Ops board", group: "Work", icon: "board", path: "ops.html", local: "ops.html", perm: "ops.view" },
    { id: "vuln", title: "Vulnerabilities", group: "Work", icon: "shield", path: "vulnerabilities.html", local: "vulnerabilities.html", perm: "vuln.view" },
    // ownerOnly: shown only to the hub owner (Theme.who says owner === true), and hidden until that is known.
    { id: "calendar", title: "Calendar", group: "Work", icon: "calendar", path: "calendar.html", local: "calendar.html", ownerOnly: true, perm: "calendar.view" },
    { id: "monitor", title: "Monitoring", group: "Work", icon: "pulse", path: "monitoring.html", local: "monitoring.html", ownerOnly: true, perm: "monitoring.view" },
    { id: "users", title: "Users", group: "Work", icon: "people", path: "users.html", local: "users.html", ownerOnly: true, perm: "users.view" },
    // chatOnly: the Claude chat: the owner, and anyone the Worker says may use it (Theme.who says chat === true,
    // which is true for a guest only while the owner has switched guest chats on). Hidden until that is known.
    { id: "chat", title: "Claude", group: "Work", icon: "chat", path: "chat.html", local: "chat.html", chatOnly: true, perm: "chat.view" },
    // `app` is the group-backed app a link needs; a signed-in person whose groups
    // do not include it does not see the link (see Theme.who in themes.js).
    { id: "study", title: "Study", group: "Sites", icon: "book", url: "https://study.barnyard.site/", app: "study", perm: "study.view" },
    { id: "notes", title: "Notes", group: "Sites", icon: "note", url: "https://study.barnyard.site/notes.html", app: "study", perm: "notebook.view" },
    { id: "kb", title: "Knowledgebase", group: "Sites", icon: "bulb", url: "https://study.barnyard.site/knowledgebase.html", app: "study", perm: "kb.view" },
    { id: "campaign", title: "Campaign", group: "Sites", icon: "map", url: "https://campaign.barnyard.site/", app: "campaign", perm: "campaign.view" },
    { id: "stocks", title: "Stocks", group: "Sites", icon: "chart", url: "https://stocks.barnyard.site/", perm: "stocks.view" }
  ];

  var ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
    chat: '<path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2h-7l-5 4v-4H6a2 2 0 01-2-2z"/><path d="M8 9h8M8 12h5"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17.5 14.2c2.3.2 3.9 1.7 4.3 4.3"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6z"/><path d="M12 8v4.5M12 15.5v.01"/>',
    note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
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
    if (/(^|\/)vulnerabilities\.html$/.test(location.pathname)) return "vuln";
    if (/(^|\/)calendar\.html$/.test(location.pathname)) return "calendar";
    if (/(^|\/)monitoring\.html$/.test(location.pathname)) return "monitor";
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
    // The owner's Users page can take an area away from one person (their permissions list lacks it).
    if (p.perm && Theme.who && Theme.who.permits && !Theme.who.permits(Theme.who.get(), p.perm)) return false;
    // An owner-only page is shown only once the person is known to be the owner (it fails closed, unlike the app links).
    if (p.ownerOnly) { var s = Theme.who && Theme.who.get(); return !!s && s.owner === true; }
    if (p.chatOnly) { var c = Theme.who && Theme.who.get(); return !!c && (c.owner === true || c.chat === true); }
    return !Theme.who || Theme.who.allows(Theme.who.get(), p.app);
  }
  function applyWho() {
    PAGES.forEach(function (p) { if (navLinks[p.id]) navLinks[p.id].hidden = !pageAllowed(p); });
    // A group heading with nothing visible under it is hidden too.
    var navEl = document.querySelector(".nav");
    if (navEl) {
      var heading = null, any = false;
      var close = function () { if (heading) heading.hidden = !any; };
      Array.prototype.forEach.call(navEl.children, function (c) {
        if (c.classList.contains("nav-group")) { close(); heading = c; any = false; }
        else if (!c.hidden) any = true;
      });
      close();
    }
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
      if (p.app || p.ownerOnly || p.chatOnly || p.perm) navLinks[p.id] = a;
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
    var hint = h("kbd", "pal-key", /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl K");
    hint.setAttribute("aria-hidden", "true");
    hint.title = "Open the command palette";
    wrap.appendChild(hint);
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

  // ---- command palette (Ctrl+K / Cmd+K) ----------------------------------------------------------------------

  var palette = { el: null, input: null, list: null, status: null, items: [], idx: 0, mode: null, opener: null, open: false, busy: false, extra: [],
    server: { q: "", state: "idle", groups: [] }, timer: null, ctrl: null, cache: Logic.makeCache(), limiter: Logic.makeLimiter(Logic.PER_MINUTE, 60000) };

  // The server-backed parts work on the hub's own origin only (the Worker's /hub, /planner and /ops answer nothing else).
  function onHubOrigin() { return location.origin === Logic.HUB_ORIGIN; }
  function signedInOwner() { var s = Theme.who && Theme.who.get(); return !!s && s.owner === true; }
  function mayUse(perm) { return !(Theme.who && Theme.who.permits && !Theme.who.permits(Theme.who.get(), perm)); }

  function paletteCommands(typed) {
    var list = [];
    if (onHubOrigin() && signedInOwner()) {
      if (mayUse("calendar.view")) list.push({ group: "Add", title: "Add a to-do", hint: "Calendar", keywords: "task todo new", ask: "todo", prompt: "What needs doing? Press Enter to add it." });
      if (mayUse("ops.view")) list.push({ group: "Add", title: "Add an Ops proposal", hint: "Ops board", keywords: "idea suggestion new", ask: "proposal", prompt: "Describe the idea. The first line is the title. Press Enter to add it." });
    }
    PAGES.filter(pageAllowed).forEach(function (p) {
      list.push({ group: "Go to", title: p.title, hint: p.group || "Page", keywords: "open " + p.id, run: function () { location.href = pageHref(p); } });
    });
    list.push({ group: "Actions", title: Theme.isDark() ? "Switch to light mode" : "Switch to dark mode", hint: "Appearance", keywords: "theme mode dark light", run: function () { Theme.set({ mode: Theme.isDark() ? "light" : "dark" }); } });
    list.push({ group: "Actions", title: Theme.get().density === "compact" ? "Use comfortable spacing" : "Use compact spacing", hint: "Appearance", keywords: "density", run: function () { Theme.set({ density: Theme.get().density === "compact" ? "comfortable" : "compact" }); } });
    list.push({ group: "Actions", title: "Open settings", hint: "Appearance", keywords: "preferences theme background", run: function () { openSettings(); } });
    palette.extra.forEach(function (fn) {
      var got = [];
      try { got = fn() || []; } catch (e) { got = []; }
      got.forEach(function (c) { if (c && c.title && typeof c.run === "function") list.push({ group: "Actions", title: String(c.title), hint: c.hint ? String(c.hint) : "", keywords: c.keywords ? String(c.keywords) : "", run: c.run }); });
    });
    if (typed) {   // eighteen themes would crowd the empty list, so they appear once the person types
      Theme.THEMES.forEach(function (t) { list.push({ group: "Themes", title: "Theme: " + t.name, hint: "Appearance", keywords: "colour color look", run: function () { Theme.set({ theme: t.id }); toast("Theme: " + t.name); } }); });
    }
    return list;
  }

  var PALETTE_GROUPS = ["Add", "Go to", "Actions", "Themes"];

  function paletteRows() {
    var q = palette.input.value;
    if (palette.mode) return [];
    var typed = !!Logic.norm(q);
    var all = paletteCommands(typed), rows = [];
    PALETTE_GROUPS.forEach(function (g) {
      var inGroup = all.filter(function (c) { return c.group === g; });
      Logic.rank(inGroup, q, typed ? Logic.SHOW_MAX : 20).forEach(function (c) { rows.push(c); });
    });
    if (searchSource && typed) {
      var found = [];
      try { found = searchSource(); } catch (e) { found = []; }
      Logic.rank(found, q, Logic.SHOW_MAX).forEach(function (x) { rows.push({ group: "On this page", title: x.title, hint: x.hint || "", run: x.go }); });
    }
    var sv = palette.server;
    if (sv.q === Logic.norm(q)) {
      sv.groups.forEach(function (g) { g.items.forEach(function (x) { rows.push({ group: g.title, title: x.title, hint: x.hint, run: function () { location.href = x.href; } }); }); });
    }
    return rows;
  }

  function paletteNote(text) { var n = h("div", "pal-note", text); return n; }

  function paletteDraw() {
    if (!palette.open) return;
    var list = palette.list;
    clear(list);
    var q = palette.input.value;
    palette.items = [];
    if (palette.mode) {
      var text = q.trim(), b = h("button", "pal-row");
      b.type = "button";
      b.setAttribute("role", "option");
      b.id = "pal-opt-0";
      b.setAttribute("aria-selected", "true");
      b.appendChild(h("span", "pal-title", text ? "Add “" + (text.length > 70 ? text.slice(0, 70) + "…" : text) + "”" : palette.mode.prompt));
      b.appendChild(h("span", "dim", text ? "Enter" : ""));
      if (text) b.addEventListener("click", function () { paletteSubmit(); });
      list.appendChild(b);
      palette.items = text ? [{ run: paletteSubmit }] : [];
      palette.idx = 0;
      palette.input.setAttribute("aria-activedescendant", "pal-opt-0");
      paletteAnnounce(text ? "Press Enter to add." : palette.mode.prompt);
      return;
    }
    var rows = paletteRows(), lastGroup = null;
    if (palette.idx >= rows.length) palette.idx = Math.max(0, rows.length - 1);
    rows.forEach(function (row, n) {
      if (row.group !== lastGroup) { list.appendChild(h("div", "pal-grp", row.group)); lastGroup = row.group; }
      var b2 = h("button", "pal-row");
      b2.type = "button";
      b2.id = "pal-opt-" + n;
      b2.setAttribute("role", "option");
      b2.setAttribute("aria-selected", String(n === palette.idx));
      b2.appendChild(h("span", "pal-title", row.title));
      if (row.hint) b2.appendChild(h("span", "dim", row.hint));
      b2.addEventListener("click", function () { paletteRun(row); });
      b2.addEventListener("mousemove", function () { if (palette.idx !== n) { palette.idx = n; paletteMark(); } });
      list.appendChild(b2);
    });
    palette.items = rows;
    var sv = palette.server, asked = Logic.norm(q);
    if (sv.q === asked && sv.state === "loading") list.appendChild(paletteNote("Searching the Ops board, Notebook and Knowledgebase…"));
    else if (sv.q === asked && sv.state === "error") list.appendChild(paletteNote("Couldn't search just now."));
    else if (sv.q === asked && sv.state === "limited") list.appendChild(paletteNote("You're searching quickly. Wait a few seconds and try again."));
    if (!rows.length && !(sv.q === asked && sv.state !== "done")) {
      list.appendChild(paletteNote(asked ? "Nothing matches “" + q.trim() + "”." + (paletteServerOk() && asked.length < Logic.SERVER_MIN ? " Type " + (Logic.SERVER_MIN - asked.length) + " more letter" + (Logic.SERVER_MIN - asked.length === 1 ? "" : "s") + " to search your notes and items." : "") : "Type a page, an action or a word to search for."));
    }
    palette.input.setAttribute("aria-activedescendant", rows.length ? "pal-opt-" + palette.idx : "");
    paletteAnnounce(rows.length ? rows.length + (rows.length === 1 ? " result" : " results") : "No results");
  }

  function paletteAnnounce(text) { if (palette.status) palette.status.textContent = text; }

  function paletteMark() {
    var opts = palette.list.querySelectorAll(".pal-row");
    Array.prototype.forEach.call(opts, function (o, n) { o.setAttribute("aria-selected", String(n === palette.idx)); });
    if (opts[palette.idx]) { opts[palette.idx].scrollIntoView({ block: "nearest" }); palette.input.setAttribute("aria-activedescendant", opts[palette.idx].id); }
  }

  function paletteServerOk() { return onHubOrigin() && signedInOwner(); }

  // One search request per settled query; the cache and the per-minute limit stop a burst of typing becoming a burst of requests.
  function paletteSearchSoon() {
    clearTimeout(palette.timer);
    if (palette.ctrl) { palette.ctrl.abort(); palette.ctrl = null; }
    var asked = Logic.norm(palette.input.value);
    if (palette.mode || !paletteServerOk() || asked.length < Logic.SERVER_MIN || asked.length > 100) { palette.server = { q: "", state: "idle", groups: [] }; return; }
    var hit = palette.cache.get(asked);
    if (hit) { palette.server = { q: asked, state: "done", groups: hit }; return; }
    palette.timer = setTimeout(function () {
      if (!palette.open || Logic.norm(palette.input.value) !== asked) return;
      if (!palette.limiter.take()) { palette.server = { q: asked, state: "limited", groups: [] }; paletteDraw(); return; }
      palette.server = { q: asked, state: "loading", groups: [] };
      paletteDraw();
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      palette.ctrl = ctrl;
      fetch(Logic.API + "/hub/search?q=" + encodeURIComponent(asked), { credentials: "include", referrerPolicy: "no-referrer", signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { if (!r.ok) throw new Error("http"); return r.json(); })
        .then(function (d) {
          var groups = Logic.cleanGroups(d);
          palette.cache.set(asked, groups);
          if (Logic.norm(palette.input.value) === asked) { palette.server = { q: asked, state: "done", groups: groups }; paletteDraw(); }
        }, function (err) {
          if (err && err.name === "AbortError") return;
          if (Logic.norm(palette.input.value) === asked) { palette.server = { q: asked, state: "error", groups: [] }; paletteDraw(); }
        });
    }, Logic.DEBOUNCE_MS);
  }

  function paletteRun(row) {
    if (!row) return;
    if (row.ask) { paletteEnterMode(row); return; }
    paletteClose(false);
    try { if (typeof row.run === "function") row.run(); } catch (e) { toast("That didn't work. Try again."); }
  }

  function paletteEnterMode(row) {
    palette.mode = { kind: row.ask, prompt: row.prompt, title: row.title };
    palette.input.value = "";
    palette.input.placeholder = row.title + "…";
    paletteSearchSoon();
    paletteDraw();
  }
  function paletteLeaveMode() {
    palette.mode = null;
    palette.input.value = "";
    palette.input.placeholder = "Go to a page, run an action, or search";
    palette.idx = 0;
    paletteDraw();
  }

  function paletteSubmit() {
    if (!palette.mode || palette.busy) return;
    var req = Logic.capture(palette.mode.kind, palette.input.value);
    if (!req) { toast(palette.input.value.trim() ? "That is too long to add here." : "Type something first."); return; }
    palette.busy = true;
    fetch(Logic.API + req.path, { method: "POST", credentials: "include", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) })
      .then(function (r) {
        palette.busy = false;
        if (r.ok) { paletteClose(true); toast(req.done); return; }
        toast(r.status === 401 || r.status === 403 ? "Sign in again to add this." : "Couldn't add it. Try again.");
      }, function () { palette.busy = false; toast("Couldn't reach the server. Try again."); });
  }

  function paletteBuild() {
    var back = h("div", "pal-back");
    back.hidden = true;
    var box = h("div", "pal");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-hidden", "true");
    box.setAttribute("aria-label", "Command palette");
    var input = h("input", "pal-input");
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "pal-list");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Command palette");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Go to a page, run an action, or search";
    var list = h("div", "pal-list");
    list.id = "pal-list";
    list.setAttribute("role", "listbox");
    var status = h("div", "sr-only");
    status.setAttribute("aria-live", "polite");
    var foot = h("div", "pal-foot dim", "↑↓ to move · Enter to choose · Esc to close");
    box.appendChild(input);
    box.appendChild(list);
    box.appendChild(foot);
    box.appendChild(status);
    back.appendChild(box);
    document.body.appendChild(back);
    palette.el = back; palette.box = box; palette.input = input; palette.list = list; palette.status = status;

    back.addEventListener("mousedown", function (e) { if (e.target === back) paletteClose(true); });
    input.addEventListener("input", function () { palette.idx = 0; paletteSearchSoon(); paletteDraw(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (palette.mode) paletteLeaveMode(); else paletteClose(true); return; }
      if (e.key === "Tab") { e.preventDefault(); return; }   // the palette is one control: Tab keeps focus in the box
      if (e.key === "Enter") { e.preventDefault(); if (palette.mode) paletteSubmit(); else paletteRun(palette.items[palette.idx]); return; }
      if (!palette.items.length || palette.mode) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        palette.idx = (palette.idx + (e.key === "ArrowDown" ? 1 : -1) + palette.items.length) % palette.items.length;
        paletteMark();
      } else if (e.key === "Home" || e.key === "End") {
        if (input.value) return;
        e.preventDefault();
        palette.idx = e.key === "Home" ? 0 : palette.items.length - 1;
        paletteMark();
      }
    });
  }

  function paletteOpen() {
    if (palette.open) return;
    if (!palette.el) paletteBuild();
    palette.open = true;
    palette.opener = document.activeElement;
    palette.mode = null; palette.idx = 0; palette.busy = false;
    palette.server = { q: "", state: "idle", groups: [] };
    palette.input.value = "";
    palette.input.placeholder = "Go to a page, run an action, or search";
    palette.el.hidden = false;
    palette.box.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("pal-open");
    paletteDraw();
    palette.input.focus();
  }
  function paletteClose(refocus) {
    if (!palette.open) return;
    clearTimeout(palette.timer);
    if (palette.ctrl) { palette.ctrl.abort(); palette.ctrl = null; }
    palette.open = false;
    palette.el.hidden = true;
    palette.box.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("pal-open");
    if (refocus && palette.opener && palette.opener.focus) { try { palette.opener.focus(); } catch (e) { /* the opener may be gone */ } }
  }

  // Ctrl+K or Cmd+K anywhere. A page that has its own use for the key (the Notebook's quick find, an editor's link command)
  // has already handled and cancelled the event by the time it reaches the window, and keeps it.
  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== "k") return;
    e.preventDefault();
    palette.open ? paletteClose(true) : paletteOpen();
  });
  if (Theme.who) Theme.who.onChange(function () { if (palette.open && !palette.mode) paletteDraw(); });

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

  function openSettings(tabId) {
    if (typeof tabId === "string" && tabs.some(function (t) { return t.id === tabId; })) activeTab = tabId;
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
    palette: {
      open: paletteOpen,
      close: function () { paletteClose(true); },
      registerCommands: function (fn) { if (typeof fn === "function" && palette.extra.indexOf(fn) === -1) palette.extra.push(fn); }
    },
    openSettings: openSettings,
    closeSettings: closeSettings,
    controls: { radios: radios, toggle: toggle, svg: svg },
    reflow: function () { if (settingsOpen) renderSettings(true); }
  };

  build();
})();
