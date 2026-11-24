// Themes and personal settings for every barnyard.site page.
//
// What this file owns:
//   - the 18 colour themes (each with a light and a dark set), the 18
//     page backgrounds and the page looks (structure, type and wording) the
//     Settings panel offers;
//   - the settings object (theme, look, light/dark mode, background, density,
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
//     stocks. It holds no identity, only seven short preference codes, and every
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

  // ---- the page looks ---------------------------------------------------------------------------------------------
  // A look is how the pages are laid out and worded: structure, type, icons, wording. It sits UNDER the colour theme,
  // background, density and sidebar, which apply on top of every look. docs/looks.md is the author guide.
  //
  // THE REGISTRY: one entry per line, in id order after Original, a comment line between entries so that two people adding
  // looks in parallel never edit neighbouring lines (git then merges them with no conflict). A person adding a look edits
  // ONLY the line of their look here, plus their own files in look-layers/. Fields:
  //   id         short slug (a-z, 0-9, -), the saved value and the file names look-layers/<id>.css and <id>.js
  //   name, blurb  what the Settings gallery shows
  //   group      a family for the author guide: original | documents | apps | maps | text
  //   installed  true once look-layers/<id>.css is built and merged; false = drawn but not built (shown, not selectable)
  //   renderer   true if the look needs its own markup for some pages (look-layers/<id>.js registers renderers, see below)
  //   v, jv      cache versions of the .css and .js: tools/stamp-assets.js rewrites them from the files; never edit by hand
  //   sketch     the gallery preview: rectangles in percent, "x,y,w,h,tone;" with tone p panel, q panel-2, l line, a accent,
  //              d fg-dim, s fg-strong, n needs-you; drawn in the theme's own colours (no image files)
  // A saved look that is unknown, or not installed, reads as Original (never an error).
  var LOOKS = [
    // ----
    { id: "original", name: "Original", blurb: "The look the dashboard has today.", group: "original", installed: true, renderer: false, v: "00000000", jv: "00000000", sketch: "0,0,22,100,p;28,10,30,34,q;62,10,30,34,q;28,52,64,38,q;31,15,14,3,s;65,15,14,3,s" },
    // ----
    { id: "classic-desktop", name: "Classic Desktop", blurb: "A 2000s desktop application with window frames.", group: "apps", installed: true, renderer: false, v: "df45d759", jv: "00000000", sketch: "2,2,96,96,q;2,2,96,8,a;2,11,96,5,q;4,19,26,70,p;32,19,64,32,l;34,22,60,26,p;32,55,64,34,l;34,58,60,28,p;2,92,96,5,q" },
    // ----
    { id: "day-line", name: "Day Line", blurb: "Everything placed on a time line.", group: "maps", installed: false, renderer: true, v: "00000000", jv: "00000000", sketch: "18,6,2,88,l;14,18,10,6,a;26,19,60,2,d;14,42,10,6,d;26,43,50,2,d;14,66,10,6,d;26,67,64,2,d;8,56,76,2,n" },
    // ----
    { id: "drawing-register", name: "Drawing Register", blurb: "A framed drawing sheet with ruled schedules.", group: "documents", installed: true, renderer: false, v: "84a15fd5", jv: "00000000", sketch: "4,4,92,92,l;6,6,88,88,p;58,74,36,20,q;60,78,32,2,d;60,85,22,2,d;10,12,50,3,s;10,26,44,2,d;10,38,50,2,d" },
    // ----
    { id: "grid-9", name: "Grid 9", blurb: "A strict Swiss grid: one typeface, hairline rules.", group: "maps", installed: false, renderer: true, v: "00000000", jv: "00000000", sketch: "0,0,100,2,l;4,8,92,18,s;4,34,28,2,d;36,34,28,2,d;68,34,28,2,d;4,44,28,22,q;36,44,28,22,q;68,44,28,22,q;4,74,92,2,l" },
    // ----
    { id: "lab-book", name: "Lab Book", blurb: "A ruled notebook page with index tabs on the edge.", group: "documents", installed: true, renderer: false, v: "9cbda9b9", jv: "00000000", sketch: "0,0,100,100,p;14,0,2,100,n;20,14,72,2,l;20,30,72,2,l;20,46,72,2,l;20,62,72,2,l;20,78,72,2,l;22,8,30,3,s" },
    // ----
    { id: "lines", name: "Lines", blurb: "A transit map of your systems and projects.", group: "maps", installed: false, renderer: true, v: "00000000", jv: "00000000", sketch: "6,26,88,5,s;6,56,88,5,a;6,82,60,5,d;14,22,10,12,q;42,22,10,12,q;72,22,10,12,q;24,52,10,12,q;60,52,10,12,q" },
    // ----
    { id: "mailroom", name: "Mailroom", blurb: "An email client: folders, a list, a reading pane.", group: "apps", installed: true, renderer: false, v: "33c4cdd9", jv: "00000000", sketch: "0,0,18,100,q;3,10,12,3,s;3,18,12,2,d;3,24,12,2,d;3,30,12,2,d;18,0,1,100,l;21,8,24,3,s;21,16,24,2,d;21,26,24,3,s;21,34,24,2,d;21,44,24,3,s;50,0,1,100,l;55,10,36,5,s;55,22,38,2,d;55,30,34,2,d;55,40,30,2,d" },
    // ----
    { id: "paper-terminal", name: "Paper Terminal", blurb: "A text-mode screen in paper and ink, no neon.", group: "text", installed: true, renderer: false, v: "9c69b8bc", jv: "00000000", sketch: "1,1,98,98,l;3,3,94,94,p;3,3,18,94,l;5,6,14,3,s;5,12,14,3,d;5,18,14,3,d;24,6,40,3,s;24,13,72,34,l;26,15,68,30,p;24,51,72,40,l;26,53,68,36,p" },
    // ----
    { id: "plain-window", name: "Plain Window", blurb: "A native admin tool: a list pane, ruled blocks, system type.", group: "apps", installed: true, renderer: false, v: "b42949f7", jv: "00000000", sketch: "0,0,22,100,q;3,10,16,5,s;3,20,16,2,d;3,26,16,2,d;3,32,16,2,d;26,6,40,6,l;26,18,70,2,d;26,26,70,14,p;26,44,70,14,p;26,62,70,14,p" },
    // ----
    { id: "poster", name: "Poster", blurb: "One big sentence over a plain ruled list.", group: "documents", installed: true, renderer: false, v: "9a3fc0cd", jv: "00000000", sketch: "6,4,60,3,s;72,4,22,3,d;4,10,92,1,s;8,20,76,12,s;8,36,50,4,d;4,50,92,2,s;8,58,60,5,s;4,68,92,1,l;8,74,50,5,s;4,84,92,1,l" },
    // ----
    { id: "prompt", name: "Prompt", blurb: "Command first: type what you want.", group: "text", installed: true, renderer: false, v: "88c12ea0", jv: "00000000", sketch: "8,4,60,3,d;8,12,84,10,q;12,15,40,4,s;8,26,84,1,l;8,34,60,3,s;8,42,84,1,l;8,48,70,3,d;8,56,84,1,l;8,62,50,3,d;8,70,84,1,l;8,76,60,3,d;8,84,84,1,l" },
    // ----
    { id: "raw", name: "Raw", blurb: "Deliberately plain: browser-default HTML.", group: "documents", installed: true, renderer: false, v: "71a44121", jv: "00000000", sketch: "6,6,88,5,s;6,22,60,2,s;6,32,70,2,s;6,42,40,2,s;6,56,88,3,l;6,70,88,3,l" },
    // ----
    { id: "run-sheet", name: "Run Sheet", blurb: "A printed day sheet, with times down the side.", group: "documents", installed: true, renderer: false, v: "462fc2e9", jv: "00000000", sketch: "6,6,12,88,q;24,12,70,2,d;24,26,70,2,d;24,38,46,8,a;24,40,70,2,d;24,54,70,2,d;24,68,70,2,d;24,82,70,2,d" },
    // ----
    { id: "sheet", name: "Sheet", blurb: "A spreadsheet workbook with tabs and a formula bar.", group: "apps", installed: true, renderer: false, v: "b7c7e03a", jv: "00000000", sketch: "0,0,100,8,q;0,9,100,5,q;0,14,100,2,l;0,24,100,2,l;0,34,100,2,l;0,44,100,2,l;0,54,100,2,l;0,64,100,2,l;25,9,1,81,l;50,9,1,81,l;75,9,1,81,l;4,17,16,4,s;30,17,16,4,d;55,27,16,4,a;0,92,100,8,q;4,94,12,4,s;20,94,12,4,d" },
    // ----
    { id: "shift-log", name: "Shift Log", blurb: "A text-first hand-over log: one column, no cards.", group: "documents", installed: true, renderer: false, v: "8b0b800e", jv: "00000000", sketch: "20,8,60,5,s;14,24,3,3,a;20,24,60,2,d;20,34,52,2,d;20,44,60,2,d;20,54,44,2,d;20,68,60,2,d;20,78,36,2,d" },
    // ----
    { id: "switchboard", name: "Switchboard", blurb: "Titled panes with a top tab strip.", group: "apps", installed: true, renderer: false, v: "1ffe6748", jv: "00000000", sketch: "0,0,100,9,s;3,2,10,5,a;16,2,10,5,p;28,2,10,5,p;4,14,44,6,s;4,20,44,30,p;52,14,44,6,s;52,20,44,30,p;4,56,44,6,s;4,62,44,32,p;52,56,44,6,s;52,62,44,32,p" },
    // ----
    { id: "wiki", name: "Wiki", blurb: "A living runbook: page tree, article, contents.", group: "documents", installed: true, renderer: false, v: "a6e95a46", jv: "00000000", sketch: "0,0,22,100,q;3,10,14,3,s;5,18,12,2,d;5,24,12,2,d;5,30,12,2,d;5,36,12,2,d;26,8,50,6,s;26,16,60,1,l;26,24,60,3,d;26,34,60,3,d;26,44,50,3,d;26,52,60,1,l;26,60,60,3,d;26,70,40,3,d" }
    // ----
  ];
  var LOOK_STATES = [["installed", "Installed"], ["designed", "Designed, not built yet"]];
  var LOOK_GROUPS = ["original", "documents", "apps", "maps", "text"];
  var TONES = { p: "--panel", q: "--panel-2", l: "--line", a: "--accent", d: "--fg-dim", s: "--fg-strong", n: "--attn" };
  var SKETCH = /^(?:\d{1,3},\d{1,3},\d{1,3},\d{1,3},[pqladsn])(?:;\d{1,3},\d{1,3},\d{1,3},\d{1,3},[pqladsn]){0,19}$/;
  var LAYER_DIR = "/look-layers/";   // root-absolute: every site serves its own copy of the layers at its own root
  var LOOK_GIVE_UP_MS = 3000;        // if a layer cannot be fetched the page shows anyway, as Original

  function findLook(id) { for (var i = 0; i < LOOKS.length; i++) if (LOOKS[i].id === id) return LOOKS[i]; return null; }
  // "x,y,w,h,t;..." -> [{x, y, w, h, tone, colour}] in percent, or [] when it is not well formed.
  function parseSketch(text) {
    if (typeof text !== "string" || !SKETCH.test(text)) return [];
    return text.split(";").map(function (r) { var p = r.split(","); return { x: +p[0], y: +p[1], w: +p[2], h: +p[3], tone: p[4], colour: TONES[p[4]] }; });
  }
  // The gallery's two sections: installed looks (selectable) and looks that are only drawn so far.
  function lookSections() {
    return LOOK_STATES.map(function (s) {
      return { key: s[0], title: s[1], looks: LOOKS.filter(function (l) { return (l.installed ? "installed" : "designed") === s[0]; }) };
    }).filter(function (s) { return s.looks.length; });
  }

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
      theme: "amber", look: "original", mode: "dark", bg: "plain", bgs: "medium", density: "comfortable", sidebar: "full",
      widgets: DEFAULT_WIDGETS.map(function (w) { return { id: w.id, visible: w.visible, size: w.size }; }),
      board: null, boardSets: null,
      opsLayout: "board", foldBacklog: null
    };
  }

  // The Overview board's tile places: null (never customised) or {v: 1, tiles: [{id, x, y, w, h}]} on a
  // 12-column grid. Only the shape is checked here (an id that looks like a tile id, each once, whole numbers on the
  // grid, at most 16 tiles); board-layout.js settles overlaps and size limits when the Overview reads it back. Ids
  // are not limited to WIDGET_IDS: a tile a page registers for itself (tile-kit.js) is saved in the board only.
  function whole(n, lo, hi) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi; }
  function normalizeBoard(raw) {
    if (!raw || typeof raw !== "object" || raw.v !== 1 || !Array.isArray(raw.tiles)) return null;
    var seen = {}, tiles = [];
    for (var i = 0; i < raw.tiles.length && tiles.length < 16; i++) {
      var t = raw.tiles[i];
      if (!t || typeof t.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(t.id) || seen[t.id]) continue;
      if (!whole(t.w, 1, 12) || !whole(t.x, 0, 11) || t.x + t.w > 12 || !whole(t.h, 1, 40) || !whole(t.y, 0, 399)) continue;
      seen[t.id] = true;
      tiles.push({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h });
    }
    return tiles.length ? { v: 1, tiles: tiles } : null;
  }

  // Named Overview layouts, one per kind of screen: null (none saved) or
  // {v: 1, layouts: [{id, name, tiles: [{id, x, y, w, h}]}], pick: {wide, standard, compact}}: at most four layouts, and
  // a pick that names one of them, or null for the standard arrangement (board-layout.js explains it). Only the shape is
  // checked here; board-layout.js settles overlaps and sizes when the Overview reads it back.
  function normalizeBoardSets(raw) {
    if (!raw || typeof raw !== "object" || raw.v !== 1 || !Array.isArray(raw.layouts)) return null;
    var seen = {}, layouts = [];
    for (var i = 0; i < raw.layouts.length && layouts.length < 4; i++) {
      var l = raw.layouts[i];
      if (!l || typeof l !== "object" || typeof l.id !== "string" || !/^[a-z0-9]{1,12}$/.test(l.id) || seen[l.id]) continue;
      var name = typeof l.name === "string" ? l.name.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24).trim() : "";
      var board = normalizeBoard({ v: 1, tiles: l.tiles });
      if (!name || !board) continue;
      seen[l.id] = true;
      layouts.push({ id: l.id, name: name, tiles: board.tiles });
    }
    if (!layouts.length) return null;
    var pick = {};
    ["wide", "standard", "compact"].forEach(function (c) { var p = raw.pick && raw.pick[c]; pick[c] = typeof p === "string" && seen[p] ? p : null; });
    return { v: 1, layouts: layouts, pick: pick };
  }

  // Anything goes in, a valid settings object comes out. Unknown or malformed
  // values fall back to the default for that key; the widget list keeps the
  // viewer's order, drops unknown or repeated ids, and appends any widget a
  // newer version of the page added.
  function normalize(raw) {
    var out = defaults();
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.theme === "string" && findTheme(raw.theme)) out.theme = raw.theme;
    // A look that is unknown, or drawn but not built yet, reads as Original (never an error).
    if (typeof raw.look === "string" && findLook(raw.look) && findLook(raw.look).installed) out.look = raw.look;
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
    out.board = normalizeBoard(raw.board);
    out.boardSets = normalizeBoardSets(raw.boardSets);
    return out;
  }

  // ---- the shared look-and-feel cookie --------------------------------------

  var COOKIE_KEYS = { t: "theme", l: "look", m: "mode", b: "bg", s: "bgs", d: "density", sb: "sidebar" };

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
    applyLook(s.look);
  }

  // ---- a look's layer ------------------------------------------------------------------------------------------------
  // Sets data-look on <html> and, for any look but Original, fetches that look's layer once: look-layers/<id>.css and, when
  // the registry says renderer: true, look-layers/<id>.js (which registers its page renderers). Original loads nothing, so the
  // current look is byte for byte what it was. Until the layer has loaded (or failed, or 3 seconds have passed)
  // data-look-pending hides the body (shell.css), so a returning visitor never sees the Original layout flash first. A layer
  // that cannot load leaves the page showing as Original: every look rule is scoped to html[data-look="<id>"] and nothing
  // else depends on it.
  var fetched = {}, waiting = 0, readyCallbacks = [], rendererTable = {};
  function lookSettled() {
    var el = root.document && root.document.documentElement;
    if (waiting > 0) return;
    if (el) el.removeAttribute("data-look-pending");
    var cbs = readyCallbacks; readyCallbacks = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) { /* one callback must not stop the rest */ } }
  }
  function fetchLayer(doc, kind, entry) {
    var el = kind === "css" ? doc.createElement("link") : doc.createElement("script");
    var done = false;
    var finish = function () { if (done) return; done = true; waiting--; lookSettled(); };
    if (kind === "css") { el.rel = "stylesheet"; el.href = LAYER_DIR + entry.id + ".css?v=" + entry.v; }
    else { el.src = LAYER_DIR + entry.id + ".js?v=" + entry.jv; el.async = true; }
    el.addEventListener("load", finish);
    el.addEventListener("error", finish);
    waiting++;
    doc.head.appendChild(el);
    root.setTimeout(finish, LOOK_GIVE_UP_MS);
  }
  function applyLook(look) {
    var doc = root.document, el = doc && doc.documentElement;
    if (!el) return;
    var entry = findLook(look);
    if (!entry || !entry.installed) entry = findLook("original");
    el.setAttribute("data-look", entry.id);
    if (entry.id === "original") { if (waiting === 0) el.removeAttribute("data-look-pending"); lookSettled(); return; }
    if (fetched[entry.id] || !doc.head || typeof doc.createElement !== "function") return;
    fetched[entry.id] = true;
    el.setAttribute("data-look-pending", "1");
    fetchLayer(doc, "css", entry);
    if (entry.renderer) fetchLayer(doc, "js", entry);
  }
  // A look that needs its own markup for a page (renderer: true) registers one function per page from its look-layers/<id>.js:
  //   BarnyardTheme.look.register("grid-9", "overview", function (model, mount) { ... draw into mount ... });
  // and the page's own script, where it draws, asks `var r = BarnyardTheme.look.renderer("overview")` and calls r(model, mount)
  // instead of its default drawing when r is not null. whenReady(fn) runs fn once the look's layer has loaded (at once for Original).
  function registerRenderer(lookId, pageId, fn) {
    if (typeof lookId !== "string" || typeof pageId !== "string" || typeof fn !== "function") return;
    (rendererTable[lookId] = rendererTable[lookId] || {})[pageId] = fn;
  }
  function rendererFor(pageId) {
    var table = rendererTable[current.look];
    return table && typeof table[pageId] === "function" ? table[pageId] : null;
  }
  function whenLookReady(fn) { if (typeof fn !== "function") return; if (waiting === 0) fn(); else readyCallbacks.push(fn); }

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
  //   who = { authenticated: true, owner: true|false|null, apps: ["hub","campaign"]|null, chat: true|false }
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
    // chat: may this person use the Claude chat (a display hint for the nav; the Worker still checks every request)
    var out = { authenticated: true, owner: j.owner === true ? true : j.owner === false ? false : null, apps: apps, chat: j.chat === true };
    // permissions: what the owner's Users page leaves this person ("ops.view", "assets.view" ...). Only kept when the Worker
    // sent a list; a page then hides what the list lacks. access: "owner" | "active" | "suspended" | "expired".
    if (Array.isArray(j.permissions)) out.permissions = j.permissions.filter(function (p) { return typeof p === "string" && p.length <= 64; }).slice(0, 200);
    if (j.access && typeof j.access.status === "string" && /^(owner|active|suspended|expired)$/.test(j.access.status)) out.access = j.access.status;
    return out;
  }

  // May this person use the area named by `perm` (for example "ops.view")? The owner always; anyone when the Worker sent no list
  // (an older Worker, or the list is unknown), so nothing is hidden by mistake. Presentation only: the Worker refuses the request.
  function sessionPermits(session, perm) {
    if (!perm || !session || !session.authenticated || session.owner === true) return true;
    if (!Array.isArray(session.permissions)) return true;
    return session.permissions.indexOf(perm) !== -1;
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
    load: loadWho, allows: sessionAllows, permits: sessionPermits, isGuest: isGuest, clean: cleanSession,
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

  // The Worker's free daily storage allowance can run out (it renews at 00:00 UTC, 08:00 Perth). Every call to the
  // API then answers 503 {"error":"daily_limit_reached"}; this notices that on any page and shows one calm line,
  // instead of an error on every tile. Nothing else about the page's own fetch handling changes.
  function showLimit() {
    var doc = root.document;
    if (!doc || !doc.body || doc.getElementById("barnyard-limit-banner")) return;
    var bar = doc.createElement("div");
    bar.id = "barnyard-limit-banner";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:sticky;top:0;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:8px 16px;font:14px/1.4 system-ui,sans-serif;text-align:center;background:#f6e7bf;color:#3b2a00;border-bottom:1px solid #d9bd73";
    var text = doc.createElement("span");
    text.textContent = "The free daily limit of the Worker's storage was reached. It renews at 08:00 Perth, and nothing is lost.";
    var close = doc.createElement("button");
    close.type = "button";
    close.textContent = "Dismiss";
    close.style.cssText = "font:inherit;padding:2px 10px;border:1px solid #8a6a1f;background:transparent;color:inherit;border-radius:6px;cursor:pointer";
    close.addEventListener("click", function () { if (bar.parentNode) bar.parentNode.removeChild(bar); });
    bar.appendChild(text);
    bar.appendChild(close);
    doc.body.insertBefore(bar, doc.body.firstChild);
  }

  function watchLimit(onLimit) {
    var realFetch = root.fetch;
    if (typeof realFetch !== "function" || realFetch.__barnyardLimitWatch) return;
    var wrapped = function () {
      return realFetch.apply(root, arguments).then(function (res) {
        try {
          if (res && res.status === 503 && typeof res.url === "string" && res.url.indexOf("https://api.barnyard.site/") === 0) {
            res.clone().json().then(function (j) { if (j && j.error === "daily_limit_reached") (onLimit || showLimit)(); }, function () { /* not JSON */ });
          }
        } catch (e) { /* the page's own handling goes on */ }
        return res;
      });
    };
    wrapped.__barnyardLimitWatch = true;
    root.fetch = wrapped;
  }

  var api = {
    THEMES: THEMES, THEME_GROUPS: THEME_GROUPS, BACKGROUNDS: BACKGROUNDS, BACKGROUND_GROUPS: BACKGROUND_GROUPS,
    LOOKS: LOOKS, LOOK_GROUPS: LOOK_GROUPS, LOOK_STATES: LOOK_STATES, LAYER_DIR: LAYER_DIR, findLook: findLook, parseSketch: parseSketch, lookSections: lookSections,
    look: { register: registerRenderer, renderer: rendererFor, whenReady: whenLookReady },
    WIDGET_IDS: WIDGET_IDS, DEFAULT_WIDGETS: DEFAULT_WIDGETS, COLOUR_VARS: COLOUR_VARS,
    defaults: defaults, normalize: normalize, encodePrefs: encodePrefs, decodePrefs: decodePrefs,
    contrastRatio: contrastRatio, findTheme: findTheme, themeColours: themeColours, isDark: isDark,
    load: load, set: set, reset: reset, apply: apply,
    get: function () { return current; },
    onChange: function (fn) { listeners.push(fn); },
    sync: sync,
    who: whoApi,
    _limit: { watch: watchLimit, show: showLimit }
  };

  root.BarnyardTheme = api;
  if (root.document && root.document.documentElement) {
    watchLimit();
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
