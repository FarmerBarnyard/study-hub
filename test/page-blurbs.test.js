// No page carries an explanatory blurb under its title or in a footer: a page's title is followed straight by its content.
// A paragraph right after a page title (inside the page-head block), a page footer paragraph, and the old footer/lede classes
// all fail this test. Functional text (empty states, notices, field hints) is unaffected: it is not in those places.
//
//   node test/page-blurbs.test.js
//
// Plain Node, standard library only.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var pages = fs.readdirSync(root).filter(function (f) { return /\.html$/.test(f) && f !== "prototype-wotc-style.html"; });

// Pages whose text is a notice by design (the privacy page, the shared read-only view's own frozen-copy notice).
var EXEMPT = { "privacy.html": true, "view.html": true };

test("there are pages to check", function () { assert.ok(pages.length >= 3, "found " + pages.length + " pages"); });

test("no paragraph follows a page title inside the page-head block", function () {
  var bad = [];
  pages.forEach(function (f) {
    if (EXEMPT[f]) return;
    var html = fs.readFileSync(path.join(root, f), "utf8");
    var re = /<div class="page-head">\s*<div>\s*<h1[^>]*>[^<]*<\/h1>\s*<p[\s>]/;
    if (re.test(html)) bad.push(f);
  });
  assert.deepStrictEqual(bad, [], "a blurb is back under the title in: " + bad.join(", "));
});

test("no page has a blurb footer", function () {
  var bad = [];
  pages.forEach(function (f) {
    if (EXEMPT[f]) return;
    var html = fs.readFileSync(path.join(root, f), "utf8");
    if (/class="[^"]*\b(hub-footer|study-footer)\b/.test(html)) bad.push(f);
  });
  assert.deepStrictEqual(bad, [], "a footer blurb is back in: " + bad.join(", "));
});

console.log(passed + " passed");
