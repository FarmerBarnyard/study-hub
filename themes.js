// Themes and personal settings for every barnyard.site page.
//
// What this file owns:
//   - the 18 colour themes (each with a light and a dark set), and the 18
//     page backgrounds the Settings panel offers;
//   - the settings object (theme, light/dark mode, background, density,
//     sidebar, Overview widget layout, Ops board defaults), its validation,
//     and where it is kept;
//   - applying the choice to the page (CSS custom properties and attributes
//     on <html>), before the page paints.
//
// Load it as a plain <script src="themes.js"></script> in <head>, ahead of the
// stylesheet's first paint, so a returning visitor never sees the default
// theme flash. shell.js builds the Settings panel on top of this API.
//
// Where the choice lives:
//   - localStorage "barnyard-settings": everything, per browser.
//   - cookie "bh_prefs" (Domain=.barnyard.site): only the look-and-feel keys,
//     so choosing a theme on one site carries to dashboard/study/campaign/
//     stocks. It holds no identity, only six short preference codes, and every
//     value read back from it is checked against the lists below before use.
//   - the signed-in user's profile (api.barnyard.site/prefs): everything, so it
//     follows the person to any browser. See "saving to the signed-in user's
//     profile" below; BarnyardTheme.sync is its API.
//
// NOTE: like auth-gate.js, this file is hand-copied into each site's repo (none
// has a build step). Keep the copies identical.

(function (root) {
  "use strict";

  var STORAGE_KEY = "barnyard-settings";
  var COOKIE_NAME = "bh_prefs";
  var COOKIE_DOMAIN = ".barnyard.site";
  var COOKIE_MAX_AGE = 31536000; // one year

  // Order matters: every theme below lists its 12 colours in this order.
  var COLOUR_VARS = ["--bg", "--panel", "--panel-2", "--line", "--fg", "--fg-strong", "--fg-dim", "--accent", "--accent-ink", "--accent-soft", "--attn", "--attn-soft"];

  function T(id, name, group, light, dark) {
    return { id: id, name: name, group: group, light: light.split(" "), dark: dark.split(" ") };
  }

  var THEMES = [
    T("cobalt", "Cobalt", "blue", "#f0f2f8 #ffffff #f5f6fa #dcdfec #272e42 #0d1222 #566079 #2849d6 #ffffff rgba(40,73,214,.09) #a05a00 rgba(160,90,0,.10)", "#0c0f15 #131821 #19202b #252d3b #cfd5e2 #f3f5fa #8b94a8 #6c8cff #070d24 rgba(108,140,255,.14) #f0a54a rgba(240,165,74,.13)"),
    T("azure", "Azure", "blue", "#eef4f9 #ffffff #f3f8fc #d3e1ee #233546 #0b1b2b #526a80 #0a68b0 #ffffff rgba(10,104,176,.10) #9a5b00 rgba(154,91,0,.10)", "#091119 #0f1a25 #14212e #1f3244 #c9d9e8 #eef6fd #83a0b8 #3db4ff #021a2c rgba(61,180,255,.13) #f0b45a rgba(240,180,90,.13)"),
    T("ultra", "Ultramarine", "blue", "#f1f0fa #ffffff #f6f5fc #deddf0 #2a2a4a #11112b #5c5c86 #3d3bd1 #ffffff rgba(61,59,209,.09) #9a5b00 rgba(154,91,0,.10)", "#0c0c18 #131324 #1a1a30 #292946 #d0d0ec #f3f3ff #9393bd #8587ff #0d0d38 rgba(133,135,255,.15) #f0b45a rgba(240,180,90,.13)"),
    T("steel", "Steel", "blue", "#eff2f5 #ffffff #f4f6f8 #d9dfe6 #2b3642 #101820 #586878 #35628f #ffffff rgba(53,98,143,.10) #9a5b00 rgba(154,91,0,.10)", "#0d1217 #141b22 #19222b #26323d #cdd6df #f0f4f8 #8a9bab #8fb4da #0b1c2d rgba(143,180,218,.13) #f0b45a rgba(240,180,90,.13)"),
    T("navy", "Navy", "blue", "#edf1f9 #ffffff #f2f5fb #d4dcee #22304d #0a1430 #53628a #1f5fd1 #ffffff rgba(31,95,209,.09) #9a5b00 rgba(154,91,0,.10)", "#060e1d #0c172b #112038 #1c2f4d #c7d4ec #eff4ff #8799be #5aa2ff #031230 rgba(90,162,255,.14) #f0b45a rgba(240,180,90,.13)"),
    T("amber", "Amber", "other", "#f0f3f6 #ffffff #f5f7f9 #dce2e9 #2a3540 #0e1720 #586674 #a85f00 #ffffff rgba(168,95,0,.10) #6446d6 rgba(100,70,214,.09)", "#0b1016 #121920 #172029 #232e3a #ced7e0 #f2f5f8 #8c99a7 #e8a33d #1b1304 rgba(232,163,61,.12) #a891ff rgba(168,145,255,.12)"),
    T("harbour", "Harbour", "other", "#eef4f4 #ffffff #f4f8f8 #d5e2e3 #243438 #0b1a1d #526a70 #0b7c6e #ffffff rgba(11,124,110,.10) #9a5b00 rgba(154,91,0,.10)", "#0a1215 #101a1e #152227 #22343b #cbdadd #f0f6f7 #86a0a6 #3cc4b0 #04201b rgba(60,196,176,.13) #f0b45a rgba(240,180,90,.13)"),
    T("plum", "Plum", "other", "#f4f1f8 #ffffff #f8f6fb #e2dcec #2e2840 #130f20 #615878 #7a3fc8 #ffffff rgba(122,63,200,.09) #9a5b00 rgba(154,91,0,.10)", "#0f0d14 #17141f #1e1a28 #2d2739 #d6d0e2 #f6f3fb #9890aa #b98cf5 #170a2b rgba(185,140,245,.14) #f0b45a rgba(240,180,90,.13)"),
    T("graphite", "Graphite", "other", "#f1f2f3 #ffffff #f6f7f8 #dcdfe2 #2a2e33 #101215 #5a6168 #1b1f24 #ffffff rgba(27,31,36,.07) #6446d6 rgba(100,70,214,.09)", "#0d0e10 #151719 #1b1d20 #2a2d31 #cfd2d6 #f4f5f6 #8e949b #e9ebee #0d0e10 rgba(233,235,238,.10) #a891ff rgba(168,145,255,.12)"),
    T("rose", "Rose", "other", "#f7f0f3 #ffffff #faf5f7 #ead9e0 #3a2a33 #1d1017 #6d5662 #b4306b #ffffff rgba(180,48,107,.09) #9a5b00 rgba(154,91,0,.10)", "#130c10 #1b1217 #23171d #34222b #e0d0d7 #fbf3f6 #a58f99 #f27aa8 #2b0715 rgba(242,122,168,.14) #f0b45a rgba(240,180,90,.13)"),
    T("ember", "Ember", "other", "#f3f1f0 #ffffff #f8f6f5 #e2dcd8 #34302d #181412 #675f5a #b8470f #ffffff rgba(184,71,15,.10) #5b3fd0 rgba(91,63,208,.09)", "#110e0c #191512 #211c18 #322a24 #dcd3cc #f8f3ee #9e9389 #ff8d4d #2a1103 rgba(255,141,77,.14) #b79bff rgba(183,155,255,.13)"),
    T("stone", "Stone", "other", "#eeeeeb #fcfcfb #f4f4f1 #dcdcd6 #34342f #171713 #636359 #4a49c9 #ffffff rgba(74,73,201,.09) #9a5b00 rgba(154,91,0,.10)", "#121210 #1a1a17 #21211d #31312b #d9d9d1 #f6f6f0 #98988c #9a9cff #12123a rgba(154,156,255,.14) #f0b45a rgba(240,180,90,.13)"),
    T("pine", "Pine", "other", "#eef2ef #ffffff #f3f6f4 #d6e0da #243229 #0c1710 #54675a #8a6410 #ffffff rgba(138,100,16,.10) #6446d6 rgba(100,70,214,.09)", "#08110d #0e1914 #13211b #1f3329 #cbd9d0 #eff6f1 #85a090 #dcbc66 #261c03 rgba(220,188,102,.13) #a891ff rgba(168,145,255,.12)"),
    T("arctic", "Arctic", "other", "#eef5f6 #ffffff #f3f8f9 #d2e2e5 #213a40 #0a1c21 #4f6d74 #0a7790 #ffffff rgba(10,119,144,.10) #9a5b00 rgba(154,91,0,.10)", "#081217 #0e1c22 #13262d #1f3841 #c6dde3 #ecf8fb #80a3ad #55d3ea #021e26 rgba(85,211,234,.13) #f0b45a rgba(240,180,90,.13)"),
    T("copper", "Copper", "other", "#f3f0ee #ffffff #f8f5f3 #e3dad4 #3a302a #1b1410 #6b5d53 #9c5527 #ffffff rgba(156,85,39,.10) #5b3fd0 rgba(91,63,208,.09)", "#120e0b #1a1511 #221b16 #34281f #ddd0c4 #f8f1ea #a29080 #d9955a #2a1507 rgba(217,149,90,.14) #b79bff rgba(183,155,255,.13)"),
    T("olive", "Olive", "other", "#f1f2ec #ffffff #f6f7f2 #dfe1d4 #2f3325 #14170c #5e6350 #66701a #ffffff rgba(102,112,26,.11) #6446d6 rgba(100,70,214,.09)", "#0f110a #171a10 #1e2216 #2d3320 #d6dac6 #f5f7ea #9aa384 #bccb5a #1c2204 rgba(188,203,90,.13) #a891ff rgba(168,145,255,.12)"),
    T("orchid", "Orchid", "other", "#f6f0f7 #ffffff #faf5fb #e6d8e8 #36263a #1b0f1f #6a5470 #a2299e #ffffff rgba(162,41,158,.09) #9a5b00 rgba(154,91,0,.10)", "#130b14 #1b111c #231724 #35223a #e2d0e4 #fcf3fd #a98fae #e078dc #2b0829 rgba(224,120,220,.14) #f0b45a rgba(240,180,90,.13)"),
    T("dusk", "Dusk", "other", "#f0eff3 #ffffff #f5f4f8 #dedce7 #2e2c3c #14131e #5d5a73 #a84a1d #ffffff rgba(168,74,29,.10) #4a56c9 rgba(74,86,201,.09)", "#0f0f17 #171722 #1e1e2b #2c2c3d #d3d2e0 #f4f3fb #9291ab #ffb08a #2e1203 rgba(255,176,138,.13) #9fb0ff rgba(159,176,255,.13)")
  ];

  var THEME_GROUPS = [["blue", "Blues"], ["other", "Others"]];

  // The drawing of each background is CSS (.bgx-<id> in shell.css); this list
  // is only the menu.
  var BACKGROUNDS = [
    { id: "plain", name: "Plain", group: "light" }, { id: "glow", name: "Glow", group: "light" }, { id: "mesh", name: "Mesh", group: "light" },
    { id: "aurora", name: "Aurora", group: "light" }, { id: "spotlight", name: "Spotlight", group: "light" }, { id: "horizon", name: "Horizon", group: "light" },
    { id: "dots", name: "Dots", group: "pattern" }, { id: "grid", name: "Grid", group: "pattern" }, { id: "blueprint", name: "Blueprint", group: "pattern" },
    { id: "ledger", name: "Ledger", group: "pattern" }, { id: "stripes", name: "Stripes", group: "pattern" }, { id: "lattice", name: "Lattice", group: "pattern" },
    { id: "scales", name: "Scales", group: "pattern" }, { id: "beams", name: "Beams", group: "pattern" },
    { id: "ripples", name: "Ripples", group: "ring" }, { id: "radar", name: "Radar", group: "ring" }, { id: "contours", name: "Contours", group: "ring" }, { id: "rays", name: "Rays", group: "ring" }
  ];
  var BACKGROUND_GROUPS = [["light", "Soft light"], ["pattern", "Lines and patterns"], ["ring", "Rings and rays"]];

  // The Overview's widgets, in default order. size: 1, 2 or 4 columns.
  var WIDGET_IDS = ["need", "feed", "flight", "market", "weather", "week", "todo", "links"];
  var DEFAULT_WIDGETS = [
    { id: "need", visible: true, size: 2 }, { id: "feed", visible: true, size: 2 }, { id: "flight", visible: true, size: 1 }, { id: "market", visible: true, size: 1 },
    { id: "weather", visible: true, size: 1 }, { id: "week", visible: true, size: 1 }, { id: "todo", visible: true, size: 1 }, { id: "links", visible: true, size: 4 }
  ];

  var MODES = ["light", "dark", "system"];
  var STRENGTHS = ["subtle", "medium", "strong"];
  var DENSITIES = ["comfortable", "compact"];
  var SIDEBARS = ["full", "icons"];
  var OPS_LAYOUTS = ["board", "list"];
  var SIZES = [1, 2, 4];

  function findTheme(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return null; }
  function hasBackground(id) { for (var i = 0; i < BACKGROUNDS.length; i++) if (BACKGROUNDS[i].id === id) return true; return false; }
  function oneOf(list, v, fallback) { return list.indexOf(v) !== -1 ? v : fallback; }

  function defaults() {
    return {
      theme: "amber", mode: "dark", bg: "plain", bgs: "medium", density: "comfortable", sidebar: "full",
      widgets: DEFAULT_WIDGETS.map(function (w) { return { id: w.id, visible: w.visible, size: w.size }; }),
      opsLayout: "board", foldBacklog: null
    };
  }

  // Anything goes in, a valid settings object comes out. Unknown or malformed
  // values fall back to the default for that key; the widget list keeps the
  // viewer's order, drops unknown or repeated ids, and appends any widget a
  // newer version of the page added.
  function normalize(raw) {
    var out = defaults();
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.theme === "string" && findTheme(raw.theme)) out.theme = raw.theme;
    out.mode = oneOf(MODES, raw.mode, out.mode);
    if (typeof raw.bg === "string" && hasBackground(raw.bg)) out.bg = raw.bg;
    out.bgs = oneOf(STRENGTHS, raw.bgs, out.bgs);
    out.density = oneOf(DENSITIES, raw.density, out.density);
    out.sidebar = oneOf(SIDEBARS, raw.sidebar, out.sidebar);
    out.opsLayout = oneOf(OPS_LAYOUTS, raw.opsLayout, out.opsLayout);
    if (typeof raw.foldBacklog === "boolean") out.foldBacklog = raw.foldBacklog;
    if (Array.isArray(raw.widgets)) {
      var seen = {}, list = [];
      for (var i = 0; i < raw.widgets.length; i++) {
        var w = raw.widgets[i];
        if (!w || typeof w.id !== "string" || WIDGET_IDS.indexOf(w.id) === -1 || seen[w.id]) continue;
        seen[w.id] = true;
        list.push({ id: w.id, visible: w.visible !== false, size: SIZES.indexOf(w.size) !== -1 ? w.size : 1 });
      }
      for (var j = 0; j < DEFAULT_WIDGETS.length; j++) {
        if (!seen[DEFAULT_WIDGETS[j].id]) list.push({ id: DEFAULT_WIDGETS[j].id, visible: true, size: DEFAULT_WIDGETS[j].size });
      }
      out.widgets = list;
    }
    return out;
  }

  // ---- the shared look-and-feel cookie --------------------------------------

  var COOKIE_KEYS = { t: "theme", m: "mode", b: "bg", s: "bgs", d: "density", sb: "sidebar" };

  function encodePrefs(settings) {
    var parts = [];
    Object.keys(COOKIE_KEYS).forEach(function (short) { parts.push(short + "=" + encodeURIComponent(settings[COOKIE_KEYS[short]])); });
    return parts.join("&");
  }

  // Returns only the look-and-feel keys that validate; everything else absent.
  function decodePrefs(text) {
    var out = {};
    if (typeof text !== "string" || text.length > 200) return out;
    var probe = {};
    text.split("&").forEach(function (pair) {
      var at = pair.indexOf("=");
      if (at < 1) return;
      var key = pair.slice(0, at), value;
      try { value = decodeURIComponent(pair.slice(at + 1)); } catch (e) { return; }
      if (COOKIE_KEYS[key]) probe[COOKIE_KEYS[key]] = value;
    });
    var checked = normalize(probe), d = defaults();
    Object.keys(probe).forEach(function (k) { if (checked[k] === probe[k]) out[k] = probe[k]; });
    return out;
  }

  // ---- contrast (used by the tests and the Settings panel's swatches) --------

  function hexToRgb(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    return m ? [0, 2, 4].map(function (i) { return parseInt(m[1].substr(i, 2), 16); }) : null;
  }
  function luminance(rgb) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function contrastRatio(a, b) {
    var x = luminance(hexToRgb(a)), y = luminance(hexToRgb(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // ---- storage ---------------------------------------------------------------

  function readStorage() {
    try { var raw = root.localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeStorage(settings) {
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked: the choice lasts for this page view */ }
  }
  function onBarnyardSite() {
    var host = root.location && root.location.hostname;
    return typeof host === "string" && (host === "barnyard.site" || /\.barnyard\.site$/.test(host));
  }
  // Stocks is not a login origin (its generated pages carry no CSP, so the Worker
  // refuses cookie-bearing calls from it): it keeps the cookie-based theme only, and
  // never calls the profile or session routes.
  function mayUseAccount() {
    var host = root.location && root.location.hostname;
    return onBarnyardSite() && !/^stocks\./.test(host);
  }
  function readCookie() {
    try {
      var m = root.document.cookie.match(new RegExp("(?:^|; )" + COOKIE_NAME + "=([^;]*)"));
      return m ? decodePrefs(decodeURIComponent(m[1])) : {};
    } catch (e) { return {}; }
  }
  function writeCookie(settings) {
    if (!onBarnyardSite()) return;
    try {
      root.document.cookie = COOKIE_NAME + "=" + encodeURIComponent(encodePrefs(settings)) +
        "; Domain=" + COOKIE_DOMAIN + "; Path=/; Max-Age=" + COOKIE_MAX_AGE + "; SameSite=Lax; Secure";
    } catch (e) { /* cookies blocked: stays per-site */ }
  }

  // ---- applying --------------------------------------------------------------

  var current = defaults();
  var listeners = [];

  function systemDark() {
    try { return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches); } catch (e) { return false; }
  }
  function isDark(settings) {
    var s = settings || current;
    return s.mode === "system" ? systemDark() : s.mode === "dark";
  }
  function themeColours(settings) {
    var s = settings || current, theme = findTheme(s.theme) || findTheme("amber");
    return isDark(s) ? theme.dark : theme.light;
  }

  function apply(settings) {
    var s = settings || current, el = root.document && root.document.documentElement;
    if (!el) return;
    if (s.mode === "system") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", s.mode);
    // Amber is the stylesheet's own default set, so it needs no overrides.
    var vals = s.theme === "amber" ? null : themeColours(s);
    for (var i = 0; i < COLOUR_VARS.length; i++) {
      if (vals) el.style.setProperty(COLOUR_VARS[i], vals[i]); else el.style.removeProperty(COLOUR_VARS[i]);
    }
    el.setAttribute("data-density", s.density);
    el.setAttribute("data-sidebar", s.sidebar);
    el.setAttribute("data-bg", s.bg);
    el.setAttribute("data-bgs", s.bgs);
  }

  function notify() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](current); } catch (e) { /* one listener must not stop the rest */ } } }

  function load() {
    var saved = normalize(readStorage());
    var fromCookie = readCookie();
    Object.keys(fromCookie).forEach(function (k) { saved[k] = fromCookie[k]; });
    current = saved;
    apply(current);
    return current;
  }

  function set(patch) {
    var merged = {}, k;
    for (k in current) merged[k] = current[k];
    for (k in patch) merged[k] = patch[k];
    current = normalize(merged);
    writeStorage(current);
    writeCookie(current);
    apply(current);
    touchSync();
    notify();
    return current;
  }

  function reset() { return set(defaults()); }

  // ---- saving to the signed-in user's profile -----------------------------------
  //
  // The Worker keeps one copy of the settings per login (GET/PUT/DELETE
  // https://api.barnyard.site/prefs), so the same look loads in any browser.
  // The browser stays the fast path: everything above applies instantly and
  // offline, and nothing here blocks the page. After sign-in we compare the
  // profile with this browser and either upload or adopt:
  //
  //   - the browser's own changes go up about 1.5 s after the last one;
  //   - a profile saved from another browser comes down when this tab starts or
  //     regains focus (at most every 30 s);
  //   - last write wins. A change made here after the profile's last save beats
  //     it; otherwise the profile does;
  //   - the first time an account is seen on this browser, its saved profile
  //     wins over what the browser had (the page offers "Keep this browser's");
  //   - an untouched browser (all defaults) never uploads, so opening a new
  //     browser cannot wipe a profile for the next one;
  //   - signed out, or off barnyard.site, nothing is sent at all.
  //
  // Sync state (revision, which account, unsent changes) is in localStorage
  // "barnyard-sync". It carries no identity beyond a one-way account label.

  var PROFILE_API = "https://api.barnyard.site/prefs";
  var SYNC_KEY = "barnyard-sync";
  var PUSH_DELAY_MS = 1500, RECHECK_MS = 30000, RETRY_MS = 30000, MAX_RETRIES = 5, REQUEST_MS = 8000;

  function sameSettings(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }

  // What to do with the profile the Worker just returned. Pure, so it is tested
  // on its own. -> "none" | "record" | "upload" | "adopt" | "adopt-first" | "forgotten"
  function decideSync(local, state, remote) {
    state = state || {};
    var customised = !sameSettings(local, defaults());
    if (!remote || !remote.exists) {
      if (state.rev) return state.dirty ? "upload" : "forgotten"; // deleted elsewhere
      return state.dirty || customised ? "upload" : "none";
    }
    var theirs = normalize(remote.settings);
    if (state.owner !== remote.owner) return sameSettings(local, theirs) ? "record" : "adopt-first";
    if (remote.rev === state.rev) return state.dirty ? "upload" : "none";
    if (state.dirty && state.changedAt > remote.updatedAt) return "upload";
    return sameSettings(local, theirs) ? "record" : "adopt";
  }

  var syncState = {};
  try { var rawSync = root.localStorage && JSON.parse(root.localStorage.getItem(SYNC_KEY)); if (rawSync && typeof rawSync === "object") syncState = rawSync; } catch (e) { syncState = {}; }
  var syncStatus = "off"; // off | checking | signed-out | unsaved | saving | saved | retrying | error
  var syncListeners = [], adoptListeners = [];
  var syncStarted = false, applyingRemote = false, pushing = false, pushAgain = false, pushTimer = null, retryTimer = null, retries = 0, lastCheck = 0, syncedAt = 0;

  function syncEnabled() { return mayUseAccount() && typeof root.fetch === "function"; }
  function saveSyncState() { try { root.localStorage.setItem(SYNC_KEY, JSON.stringify(syncState)); } catch (e) { /* kept for this page view */ } }
  function setSyncStatus(next) {
    syncStatus = next;
    for (var i = 0; i < syncListeners.length; i++) { try { syncListeners[i](next, syncedAt); } catch (e) { /* one listener must not stop the rest */ } }
  }

  function profileRequest(method, body, keepalive) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    if (keepalive) opts.keepalive = true;
    var timer = null;
    if (typeof root.AbortController === "function") { var ctl = new root.AbortController(); opts.signal = ctl.signal; timer = root.setTimeout(function () { ctl.abort(); }, REQUEST_MS); }
    return root.fetch(PROFILE_API, opts).then(function (res) {
      if (timer) root.clearTimeout(timer);
      return res.json().then(function (json) { return { status: res.status, json: json || {} }; }, function () { return { status: res.status, json: {} }; });
    }, function (err) { if (timer) root.clearTimeout(timer); throw err; });
  }

  function scheduleRetry() {
    root.clearTimeout(retryTimer);
    if (++retries > MAX_RETRIES) { setSyncStatus("error"); return; }
    retryTimer = root.setTimeout(function () { return syncState.dirty ? push() : pull(); }, RETRY_MS);
  }
  function schedulePush() {
    if (syncStatus === "signed-out") return; // nothing to send to; the next pull clears this
    root.clearTimeout(pushTimer);
    pushTimer = root.setTimeout(function () { return push(); }, PUSH_DELAY_MS);
  }

  // Called by set() for a change the person made (never for a profile we applied).
  function touchSync() {
    if (applyingRemote || !syncEnabled()) return;
    syncState.dirty = true;
    syncState.changedAt = Date.now();
    syncState.seq = (syncState.seq || 0) + 1; // tells a save in flight that a later change arrived
    saveSyncState();
    schedulePush();
  }

  function push(keepalive) {
    root.clearTimeout(pushTimer); pushTimer = null;
    if (!syncEnabled() || syncStatus === "signed-out") return Promise.resolve();
    if (pushing) { pushAgain = true; return Promise.resolve(); }
    pushing = true;
    var token = syncState.seq || 0;
    setSyncStatus("saving");
    return profileRequest("PUT", { settings: current }, keepalive).then(function (r) {
      if (r.status === 200) {
        syncState.rev = r.json.rev; syncState.owner = r.json.owner;
        if ((syncState.seq || 0) === token) syncState.dirty = false; else pushAgain = true;
        syncedAt = Date.now(); retries = 0; saveSyncState();
        setSyncStatus("saved");
      } else if (r.status === 401) setSyncStatus("signed-out");
      else if (r.status === 400 || r.status === 413) setSyncStatus("error");
      // The day's quota of saves is used up: retrying cannot help and only burns more of it.
      else if (r.status === 429 && r.json && r.json.error === "daily_limit") setSyncStatus("error");
      else { setSyncStatus("retrying"); scheduleRetry(); }
    }, function () { setSyncStatus("retrying"); scheduleRetry(); }).then(function () {
      pushing = false;
      if (pushAgain) { pushAgain = false; schedulePush(); }
    });
  }

  function pull() {
    if (!syncEnabled()) return Promise.resolve();
    lastCheck = Date.now();
    if (syncStatus === "off") setSyncStatus("checking");
    return profileRequest("GET").then(function (r) {
      if (r.status === 401) { setSyncStatus("signed-out"); return; }
      if (r.status !== 200) { setSyncStatus("retrying"); scheduleRetry(); return; }
      retries = 0;
      var action = decideSync(current, syncState, r.json);
      if (action === "upload") { if (syncStatus === "signed-out") setSyncStatus("checking"); return push(); }
      if (action === "forgotten") { syncState = {}; saveSyncState(); setSyncStatus("unsaved"); return; }
      if (action === "none") { setSyncStatus(r.json.exists ? "saved" : "unsaved"); if (r.json.exists && !syncedAt) syncedAt = r.json.updatedAt; return; }
      var previous = current;
      if (action === "adopt" || action === "adopt-first") {
        applyingRemote = true;
        try { set(normalize(r.json.settings)); } finally { applyingRemote = false; }
      }
      syncState = { rev: r.json.rev, owner: r.json.owner, dirty: false, changedAt: syncState.changedAt || 0, seq: syncState.seq || 0 };
      syncedAt = r.json.updatedAt; saveSyncState();
      setSyncStatus("saved");
      if (action !== "record") {
        for (var i = 0; i < adoptListeners.length; i++) { try { adoptListeners[i]({ first: action === "adopt-first", previous: previous }); } catch (e) { /* ignore */ } }
      }
    }, function () { setSyncStatus("retrying"); scheduleRetry(); });
  }

  function forgetProfile() {
    if (!syncEnabled()) return Promise.resolve(false);
    return profileRequest("DELETE").then(function (r) {
      if (r.status !== 200) return false;
      syncState = {}; saveSyncState(); syncedAt = 0;
      setSyncStatus("unsaved");
      return true;
    }, function () { return false; });
  }

  function startSync() {
    if (syncStarted || !syncEnabled()) return;
    syncStarted = true;
    pull();
    var doc = root.document;
    if (doc && doc.addEventListener) {
      doc.addEventListener("visibilitychange", function () {
        if (doc.visibilityState === "hidden") { if (syncState.dirty) push(true); }
        else if (Date.now() - lastCheck > RECHECK_MS) pull();
      });
    }
  }

  // ---- who is signed in (so a page can hide what someone cannot use) --------------
  //
  // GET api.barnyard.site/auth/session says whether someone is signed in, whether
  // they are the hub owner, and which apps their groups allow. The pages use it
  // only to hide links and widgets that would be dead ends or that show the owner's
  // personal data (the calendar, shortcuts); every route still enforces its own
  // group check, so this is presentation, not security. It fails open: if the
  // session is unknown (signed out, an old Worker, a network error) nothing is hidden.
  //
  //   who = { authenticated: true, owner: true|false|null, apps: ["hub","campaign"]|null }
  //       | { authenticated: false }
  // `owner` is null until the Worker knows who the owner is. A signed-in result is
  // kept in sessionStorage for a minute so moving between pages does not refetch.

  var SESSION_URL = "https://api.barnyard.site/auth/session";
  var SESSION_KEY = "barnyard-session";
  var SESSION_TTL_MS = 60000;
  var who = null, whoListeners = [], whoLoading = false;

  function cleanSession(j) {
    if (!j || j.authenticated !== true) return { authenticated: false };
    var apps = null;
    if (Array.isArray(j.apps)) apps = j.apps.filter(function (a) { return typeof a === "string" && a.length <= 20; }).slice(0, 10);
    return { authenticated: true, owner: j.owner === true ? true : j.owner === false ? false : null, apps: apps };
  }

  // May this person use `app` ("study", "campaign")? Anything unknown is allowed.
  function sessionAllows(session, app) {
    if (!app || !session || !session.authenticated || session.owner === true) return true;
    return !Array.isArray(session.apps) || session.apps.indexOf(app) !== -1;
  }

  // Is this a signed-in person who is definitely not the hub owner?
  function isGuest(session) { return !!session && session.authenticated === true && session.owner === false; }

  function readWhoCache() {
    try {
      var c = JSON.parse(root.sessionStorage.getItem(SESSION_KEY));
      if (c && typeof c.t === "number" && Date.now() - c.t < SESSION_TTL_MS && c.data) return cleanSession(c.data);
    } catch (e) { /* no cache */ }
    return null;
  }
  function setWho(next) {
    who = next;
    for (var i = 0; i < whoListeners.length; i++) { try { whoListeners[i](who); } catch (e) { /* one listener must not stop the rest */ } }
  }

  function loadWho() {
    if (!mayUseAccount() || typeof root.fetch !== "function" || whoLoading) return;
    var cached = readWhoCache();
    if (cached) { setWho(cached); return; }
    whoLoading = true;
    root.fetch(SESSION_URL, { credentials: "include", referrerPolicy: "no-referrer" }).then(function (res) {
      if (res.status === 401) return { authenticated: false };
      if (!res.ok) return null;
      return res.json().then(cleanSession, function () { return null; });
    }).then(function (data) {
      whoLoading = false;
      if (!data) return;
      if (data.authenticated) { try { root.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ t: Date.now(), data: data })); } catch (e) { /* no cache */ } }
      setWho(data);
    }, function () { whoLoading = false; });
  }

  var whoApi = {
    load: loadWho, allows: sessionAllows, isGuest: isGuest, clean: cleanSession,
    get: function () { return who; },
    // fn(session) now if it is already known, and again whenever it changes.
    onChange: function (fn) { whoListeners.push(fn); if (who) { try { fn(who); } catch (e) { /* ignore */ } } }
  };

  var sync = {
    start: startSync, pull: pull, forget: forgetProfile, decide: decideSync,
    flush: function () { return push(); },
    status: function () { return syncStatus; },
    syncedAt: function () { return syncedAt; },
    onStatus: function (fn) { syncListeners.push(fn); },
    onAdopt: function (fn) { adoptListeners.push(fn); }
  };

  var api = {
    THEMES: THEMES, THEME_GROUPS: THEME_GROUPS, BACKGROUNDS: BACKGROUNDS, BACKGROUND_GROUPS: BACKGROUND_GROUPS,
    WIDGET_IDS: WIDGET_IDS, DEFAULT_WIDGETS: DEFAULT_WIDGETS, COLOUR_VARS: COLOUR_VARS,
    defaults: defaults, normalize: normalize, encodePrefs: encodePrefs, decodePrefs: decodePrefs,
    contrastRatio: contrastRatio, findTheme: findTheme, themeColours: themeColours, isDark: isDark,
    load: load, set: set, reset: reset, apply: apply,
    get: function () { return current; },
    onChange: function (fn) { listeners.push(fn); },
    sync: sync,
    who: whoApi
  };

  root.BarnyardTheme = api;
  if (root.document && root.document.documentElement) {
    load();
    // Start the profile sync once the page has had its first paint.
    // Who is signed in is asked at once (a hidden link should not flash first);
    // the profile sync waits a moment so it never competes with the first paint.
    var startLater = function () { loadWho(); root.setTimeout(startSync, 300); };
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", startLater); else startLater();
    if (root.matchMedia) {
      try { root.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { if (current.mode === "system") { apply(current); notify(); } }); } catch (e) { /* older browsers: the next load picks it up */ }
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
