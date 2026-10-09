// Cache tags (tools/stamp-assets.js): every script and stylesheet link in a page names its file by
// content (chat.js?v=3fa91c07), so a deploy is never hidden behind Cloudflare's multi-hour cache.
//
//   node test/cache-tags.test.js

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var stamp = require(path.join(__dirname, "..", "tools", "stamp-assets.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function tempSite(files) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
  Object.keys(files).forEach(function (n) { fs.writeFileSync(path.join(dir, n), files[n]); });
  return dir;
}

test("the real pages carry the current hash of every script and stylesheet they load (run tools/stamp-assets.js if this fails)", function () {
  var r = stamp.run(root, false);
  assert.ok(r.pages >= 3, "found the pages");
  assert.deepStrictEqual(r.missing, [], "every linked file exists");
  assert.deepStrictEqual(r.stale.map(function (l) { return l.page + ": " + l.file + " (" + l.stamped + " should be " + l.wanted + ")"; }), []);
});

test("a link is stamped with the first 8 hex digits of its file's hash, and re-stamping changes nothing", function () {
  var dir = tempSite({ "a.js": "var a = 1;\n", "b.css": "p{}\n", "x.html": '<link rel="stylesheet" href="b.css"><script src="a.js"></script>\n' });
  var first = stamp.run(dir, true);
  assert.strictEqual(first.stale.length, 2);
  var html = fs.readFileSync(path.join(dir, "x.html"), "utf8");
  assert.ok(/href="b\.css\?v=[0-9a-f]{8}"/.test(html) && /src="a\.js\?v=[0-9a-f]{8}"/.test(html), html);
  assert.strictEqual(stamp.run(dir, true).stale.length, 0, "a second run has nothing to do");
  assert.strictEqual(fs.readFileSync(path.join(dir, "x.html"), "utf8"), html);
});

test("changing a file changes its stamp, and only that file's", function () {
  var dir = tempSite({ "a.js": "1", "b.js": "2", "x.html": '<script src="a.js"></script><script src="b.js"></script>' });
  stamp.run(dir, true);
  var before = fs.readFileSync(path.join(dir, "x.html"), "utf8");
  fs.writeFileSync(path.join(dir, "a.js"), "changed");
  var check = stamp.run(dir, false);
  assert.deepStrictEqual(check.stale.map(function (l) { return l.file; }), ["a.js"]);
  stamp.run(dir, true);
  var after = fs.readFileSync(path.join(dir, "x.html"), "utf8");
  assert.notStrictEqual(after, before);
  assert.strictEqual(/b\.js\?v=([0-9a-f]+)/.exec(after)[1], /b\.js\?v=([0-9a-f]+)/.exec(before)[1]);
});

test("line endings do not change a hash, so Windows and GitHub agree", function () {
  var dir = tempSite({ "lf.js": "a\nb\n", "crlf.js": "a\r\nb\r\n" });
  assert.strictEqual(stamp.hashOf(path.join(dir, "lf.js")), stamp.hashOf(path.join(dir, "crlf.js")));
});

test("a page keeps its own line endings when it is re-stamped", function () {
  var dir = tempSite({ "a.js": "x", "x.html": '<script src="a.js"></script>\r\n<p>hi</p>\r\n' });
  stamp.run(dir, true);
  var html = fs.readFileSync(path.join(dir, "x.html"), "utf8");
  assert.ok(html.indexOf("\r\n") > 0 && !/[^\r]\n/.test(html), "still CRLF throughout");
});

test("only same-folder scripts and stylesheets are touched; web addresses, images and missing files are left alone", function () {
  var dir = tempSite({ "a.js": "x", "x.html": '<script src="https://example.com/lib.js"></script><img src="logo.png"><script src="a.js"></script><script src="gone.js"></script>' });
  var r = stamp.run(dir, true);
  var html = fs.readFileSync(path.join(dir, "x.html"), "utf8");
  assert.ok(html.indexOf('src="https://example.com/lib.js"') >= 0);
  assert.ok(html.indexOf('src="logo.png"') >= 0);
  assert.ok(html.indexOf('src="gone.js"') >= 0, "a missing file is reported, not invented");
  assert.deepStrictEqual(r.missing, [{ page: "x.html", file: "gone.js" }]);
});

test("a stale stamp is reported with what it should be", function () {
  var dir = tempSite({ "a.js": "x", "x.html": '<script src="a.js?v=deadbeef"></script>' });
  var r = stamp.run(dir, false);
  assert.strictEqual(r.stale[0].stamped, "deadbeef");
  assert.strictEqual(r.stale[0].wanted, stamp.hashOf(path.join(dir, "a.js")));
});

console.log("\n" + passed + " tests passed");
