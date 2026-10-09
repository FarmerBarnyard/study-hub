// Stamps every local script and stylesheet link in the site's pages with ?v=<a short hash of that file>.
//
// Why: Cloudflare keeps static files (scripts, stylesheets) for hours, so after a deploy a visitor
// can keep running yesterday's script until the cache runs out. A page's own address is not cached
// that long, so if the link inside it names the file by its content (chat.js?v=3fa91c07), a changed
// file is a new address and is fetched at once, and an unchanged file stays cached.
//
//   node tools/stamp-assets.js           rewrite the pages so every link carries its file's current hash
//   node tools/stamp-assets.js --check   change nothing; exit 1 listing any link that is missing or stale
//
// Run it after changing any script or stylesheet. test/cache-tags.test.js fails when it was forgotten.
// The hash ignores line endings, so it is the same on Windows (CRLF checkouts) and on GitHub (LF).

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

// A same-folder script or stylesheet: src="x.js" or href="x.css", with or without an old stamp.
var LINK = /\b(src|href)="([A-Za-z0-9_\-.]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g;

function hashOf(file) {
  var text = fs.readFileSync(file, "utf8").split("\r\n").join("\n");
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

// Returns {html, links:[{page, file, stamped, wanted}], missing:[file]} for one page's text.
function stampPage(html, root, pageName) {
  var links = [], missing = [];
  var out = html.replace(LINK, function (whole, attr, name) {
    var full = path.join(root, name);
    if (!fs.existsSync(full)) { missing.push(name); return whole; }
    var wanted = hashOf(full);
    var had = /\?v=([0-9a-f]+)"$/.exec(whole);
    links.push({ page: pageName, file: name, stamped: had ? had[1] : null, wanted: wanted });
    return attr + '="' + name + "?v=" + wanted + '"';
  });
  return { html: out, links: links, missing: missing };
}

// Every .html page in the folder. write=false only reports. -> {stale:[...], missing:[...], pages:n}
function run(root, write) {
  var stale = [], missing = [], pages = 0;
  fs.readdirSync(root).filter(function (f) { return /\.html$/.test(f); }).forEach(function (page) {
    var file = path.join(root, page);
    var original = fs.readFileSync(file, "utf8");
    var crlf = original.indexOf("\r\n") >= 0;
    var r = stampPage(original.split("\r\n").join("\n"), root, page);
    pages++;
    r.links.forEach(function (l) { if (l.stamped !== l.wanted) stale.push(l); });
    r.missing.forEach(function (m) { missing.push({ page: page, file: m }); });
    if (write && r.html !== original.split("\r\n").join("\n")) fs.writeFileSync(file, crlf ? r.html.split("\n").join("\r\n") : r.html);
  });
  return { stale: stale, missing: missing, pages: pages };
}

module.exports = { hashOf: hashOf, stampPage: stampPage, run: run, LINK: LINK };

if (require.main === module) {
  var check = process.argv.indexOf("--check") !== -1;
  var root = path.join(__dirname, "..");
  var result = run(root, !check);
  result.missing.forEach(function (m) { console.log("missing file for " + m.page + ": " + m.file); });
  if (check) {
    result.stale.forEach(function (l) { console.log(l.page + ": " + l.file + " is " + (l.stamped ? "stamped " + l.stamped : "not stamped") + ", should be " + l.wanted); });
    if (result.stale.length || result.missing.length) { console.log("Run: node tools/stamp-assets.js"); process.exit(1); }
    console.log("All " + result.pages + " pages are stamped.");
  } else {
    console.log("Stamped " + result.pages + " pages (" + result.stale.length + " links updated).");
  }
}
