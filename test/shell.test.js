// Coverage for the shared shell files hand-copied from barnyard-hub: themes.js (the 18 themes, the settings object, the shared
// look-and-feel cookie) and for the rules the shell must keep: every theme is
// readable, every background has CSS, and the pages stay inside a CSP with no
// inline scripts or styles and no remote resources.
//
//   node test/themes.test.js
//
// Same pattern as the other tests here: plain Node, standard library only.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var Theme = require(path.join(root, "themes.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

var HEX = /^#[0-9a-f]{6}$/i;
var RGBA = /^rgba\(\d+,\d+,\d+,\.?\d+\)$/;

test("there are 18 themes and 18 backgrounds, each id unique", function () {
  assert.strictEqual(Theme.THEMES.length, 18);
  assert.strictEqual(Theme.BACKGROUNDS.length, 18);
  assert.strictEqual(new Set(Theme.THEMES.map(function (t) { return t.id; })).size, 18);
  assert.strictEqual(new Set(Theme.BACKGROUNDS.map(function (b) { return b.id; })).size, 18);
});

test("every theme has twelve well-formed colours in light and dark", function () {
  Theme.THEMES.forEach(function (t) {
    ["light", "dark"].forEach(function (mode) {
      var v = t[mode];
      assert.strictEqual(v.length, 12, t.id + " " + mode + " has 12 colours");
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 10].forEach(function (i) { assert.ok(HEX.test(v[i]), t.id + " " + mode + " colour " + i + " is a hex colour: " + v[i]); });
      [9, 11].forEach(function (i) { assert.ok(RGBA.test(v[i]), t.id + " " + mode + " colour " + i + " is rgba(): " + v[i]); });
    });
  });
});

test("every theme is readable: text, accent, button and needs-you colours all reach 4.5:1", function () {
  var checks = [["main text on page", 4, 0], ["main text on panel", 4, 1], ["muted text on panel", 6, 1], ["accent on panel", 7, 1], ["button text on accent", 8, 7], ["needs-you on panel", 10, 1]];
  Theme.THEMES.forEach(function (t) {
    ["light", "dark"].forEach(function (mode) {
      checks.forEach(function (c) {
        var ratio = Theme.contrastRatio(t[mode][c[1]], t[mode][c[2]]);
        assert.ok(ratio >= 4.5, t.id + " " + mode + ": " + c[0] + " is " + ratio.toFixed(2) + ":1");
      });
    });
  });
});

test("every background except Plain has a .bgx-<id> rule in shell.css", function () {
  var css = read("shell.css");
  Theme.BACKGROUNDS.forEach(function (b) {
    if (b.id === "plain") return;
    assert.ok(css.indexOf(".bgx-" + b.id + " {") !== -1, "missing .bgx-" + b.id);
  });
});

test("theme and background groups cover every entry", function () {
  var themeGroups = Theme.THEME_GROUPS.map(function (g) { return g[0]; });
  Theme.THEMES.forEach(function (t) { assert.ok(themeGroups.indexOf(t.group) !== -1, t.id + " has a known group"); });
  var bgGroups = Theme.BACKGROUND_GROUPS.map(function (g) { return g[0]; });
  Theme.BACKGROUNDS.forEach(function (b) { assert.ok(bgGroups.indexOf(b.group) !== -1, b.id + " has a known group"); });
});

test("normalize: junk becomes the defaults", function () {
  var d = Theme.defaults();
  assert.deepStrictEqual(Theme.normalize(null), d);
  assert.deepStrictEqual(Theme.normalize("dark"), d);
  assert.deepStrictEqual(Theme.normalize({ theme: "nope", mode: "purple", bg: "../x", bgs: 9, density: [], sidebar: {}, opsLayout: "grid", foldBacklog: "yes" }), d);
});

test("normalize: valid choices are kept", function () {
  var s = Theme.normalize({ theme: "navy", mode: "light", bg: "mesh", bgs: "strong", density: "compact", sidebar: "icons", opsLayout: "list", foldBacklog: false });
  assert.strictEqual(s.theme, "navy");
  assert.strictEqual(s.mode, "light");
  assert.strictEqual(s.bg, "mesh");
  assert.strictEqual(s.bgs, "strong");
  assert.strictEqual(s.density, "compact");
  assert.strictEqual(s.sidebar, "icons");
  assert.strictEqual(s.opsLayout, "list");
  assert.strictEqual(s.foldBacklog, false);
});

test("normalize: the widget list keeps order, drops unknown and repeated ids, and appends new widgets", function () {
  var s = Theme.normalize({ widgets: [{ id: "todo", visible: false, size: 4 }, { id: "bogus", visible: true, size: 1 }, { id: "need", visible: true, size: 3 }, { id: "todo", visible: true, size: 1 }, null, { id: "week" }] });
  assert.deepStrictEqual(s.widgets.slice(0, 3).map(function (w) { return w.id; }), ["todo", "need", "week"]);
  assert.strictEqual(s.widgets[0].visible, false);
  assert.strictEqual(s.widgets[0].size, 4);
  assert.strictEqual(s.widgets[1].size, 1, "an invalid size falls back to Small");
  assert.strictEqual(s.widgets.length, Theme.WIDGET_IDS.length, "every widget is present exactly once");
  assert.strictEqual(new Set(s.widgets.map(function (w) { return w.id; })).size, Theme.WIDGET_IDS.length);
});

test("normalize does not share state with the defaults", function () {
  var a = Theme.normalize({}), b = Theme.normalize({});
  a.widgets[0].visible = false;
  assert.strictEqual(b.widgets[0].visible, true);
  assert.strictEqual(Theme.defaults().widgets[0].visible, true);
});

test("cookie: look-and-feel keys round-trip", function () {
  var s = Theme.normalize({ theme: "orchid", mode: "system", bg: "radar", bgs: "subtle", density: "compact", sidebar: "icons" });
  var back = Theme.decodePrefs(Theme.encodePrefs(s));
  assert.deepStrictEqual(back, { theme: "orchid", mode: "system", bg: "radar", bgs: "subtle", density: "compact", sidebar: "icons" });
});

test("cookie: anything that does not validate is ignored, and layout keys never travel", function () {
  assert.deepStrictEqual(Theme.decodePrefs("t=evil&m=dark&b=nope&s=huge&d=compact&sb=wide&x=1"), { mode: "dark", density: "compact" });
  assert.deepStrictEqual(Theme.decodePrefs("t=%E0%A4%A"), {});
  assert.deepStrictEqual(Theme.decodePrefs(""), {});
  assert.deepStrictEqual(Theme.decodePrefs(null), {});
  assert.deepStrictEqual(Theme.decodePrefs(new Array(300).join("t=navy&")), {}, "an oversized value is refused outright");
  var encoded = Theme.encodePrefs(Theme.normalize({ opsLayout: "list", foldBacklog: true }));
  assert.ok(encoded.indexOf("opsLayout") === -1 && encoded.indexOf("widgets") === -1, "layout keys stay out of the cookie");
});

test("the pages keep to the CSP: no inline scripts, handlers or styles, and nothing remote", function () {
  ["index.html"].forEach(function (file) {
    var html = read(file);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), file + " has an inline script");
    assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<meta[^>]*>/gi, "")), file + " has an inline event handler");
    assert.ok(!/\sstyle\s*=/i.test(html), file + " has a style attribute");
    assert.ok(!/<style[\s>]/i.test(html), file + " has a style element");
  });
  ["shell.css", "style.css"].forEach(function (file) {
    var css = read(file);
    assert.ok(!/@import/.test(css), file + " imports another stylesheet");
    var urls = css.match(/url\(([^)]*)\)/g) || [];
    urls.forEach(function (u) { assert.ok(/url\("fonts\/[a-z0-9-]+\.woff2"\)/.test(u), file + " references something other than a bundled font: " + u); });
  });
});

test("shell.js and themes.js only assign innerHTML in the shell's icon helper, from its own static table", function () {
  var assigns = function (file) { return (read(file).match(/\.innerHTML\s*=/g) || []).length; };
  assert.strictEqual(assigns("shell.js"), 1);
  assert.strictEqual(assigns("themes.js"), 0);
  assert.ok(/s\.innerHTML = ICONS\[name\]/.test(read("shell.js")), "the one assignment is the icon table lookup");
});
test("the bundled fonts exist and are woff2", function () {
  var css = read("shell.css"), files = css.match(/fonts\/[a-z0-9-]+\.woff2/g) || [];
  assert.ok(files.length >= 6);
  files.forEach(function (f) {
    var buf = fs.readFileSync(path.join(root, f));
    assert.strictEqual(buf.slice(0, 4).toString("latin1"), "wOF2", f + " is a woff2 file");
  });
});

console.log("\n" + passed + " tests passed");
