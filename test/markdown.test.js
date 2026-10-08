// Tests for markdown.js -- the safe renderer behind notes.html. Plain Node, no
// dependencies, same style as app.test.js:   node test/markdown.test.js

var assert = require("assert");
var path = require("path");
var md = require(path.join(__dirname, "..", "markdown.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

// A tiny DOM that records what was built and prints it as HTML, so the tests can
// see exactly what a note turns into -- and that text never becomes markup.
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function makeDoc() {
  function node(name) {
    var n = { name: name, kids: [], attrs: {}, className: "", textContent: "", crossOrigin: "" };
    n.appendChild = function (c) { n.kids.push(c); return c; };
    n.setAttribute = function (k, v) { n.attrs[k] = String(v); };
    return n;
  }
  function html(n) {
    if (n.text !== undefined) return esc(n.text);
    var a = "";
    if (n.className) a += ' class="' + esc(n.className) + '"';
    if (n.crossOrigin) a += ' crossorigin="' + esc(n.crossOrigin) + '"';
    Object.keys(n.attrs).forEach(function (k) { a += " " + k + '="' + esc(n.attrs[k]) + '"'; });
    var inner = n.textContent ? esc(n.textContent) : n.kids.map(html).join("");
    if (n.name === "#frag") return inner;
    if (n.name === "br" || n.name === "hr" || n.name === "img" || n.name === "input") return "<" + n.name + a + ">";
    return "<" + n.name + a + ">" + inner + "</" + n.name + ">";
  }
  return {
    createElement: node,
    createTextNode: function (t) { return { text: t, appendChild: function () {} }; },
    createDocumentFragment: function () { return node("#frag"); },
    html: html,
  };
}
var CX = {
  imageUrl: function (id) { return "https://api.barnyard.site/notebook/image?id=" + id; },
  findNote: function (t) { return t.toLowerCase() === "azure ad" ? "nt_abcd1234" : null; },
};
function render(src, cx) {
  var doc = makeDoc();
  return doc.html(md.toDom(md.parse(src), doc, cx || CX));
}

test("headings, paragraphs and the usual inline marks", function () {
  assert.strictEqual(render("# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code`."),
    "<h1>Title</h1><p>Some <strong>bold</strong>, <em>italic</em>, <del>gone</del> and <code>code</code>.</p>");
});

test("a single newline inside a paragraph is kept as a line break", function () {
  assert.strictEqual(render("one\ntwo"), "<p>one<br>two</p>");
});

test("snake_case words and lone asterisks are not emphasis", function () {
  assert.strictEqual(render("use my_variable_name and 2 * 3 * 4"), "<p>use my_variable_name and 2 * 3 * 4</p>");
});

test("text is never markup: tags and entities come out as text", function () {
  var out = render("<script>alert(1)</script> <img src=x onerror=alert(1)> &lt;b&gt;");
  assert.ok(out.indexOf("<script") === -1 && out.indexOf("<img") === -1);
  assert.ok(out.indexOf("&lt;script&gt;alert(1)&lt;/script&gt;") !== -1);
});

test("only http, https and mailto links are live; javascript: and data: are plain text", function () {
  assert.ok(render("[ok](https://example.com/a?b=1)").indexOf('href="https://example.com/a?b=1"') !== -1);
  assert.ok(render("[mail](mailto:a@b.co)").indexOf('href="mailto:a@b.co"') !== -1);
  ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>", "vbscript:x", "//evil.example", "file:///etc/passwd", "/relative", "https://user:pw@evil.example/"].forEach(function (u) {
    var out = render("[click](" + u + ")");
    assert.ok(out.indexOf("href") === -1, u + " must not become a link: " + out);
    assert.ok(out.indexOf("click") !== -1);
  });
});

test("external links open safely", function () {
  var out = render("[x](https://example.com)");
  assert.ok(out.indexOf('rel="noopener noreferrer nofollow"') !== -1 && out.indexOf('target="_blank"') !== -1);
});

test("a bare web address inside text becomes a link without its trailing punctuation", function () {
  var out = render("See https://example.com/docs, then stop.");
  assert.ok(out.indexOf('href="https://example.com/docs"') !== -1);
  assert.ok(out.indexOf("</a>, then stop.") !== -1);
});

test("a web address alone on a line becomes a link card showing host and path only", function () {
  var out = render("https://www.learn.microsoft.com/en-us/entra/identity");
  assert.ok(out.indexOf('class="linkcard"') !== -1);
  assert.ok(out.indexOf("learn.microsoft.com") !== -1 && out.indexOf("/en-us/entra/identity") !== -1);
  assert.ok(out.indexOf("<img") === -1, "the page is never fetched, so there is no preview image");
  assert.ok(render("text https://example.com").indexOf("linkcard") === -1);
});

test("notebook images load from the Worker with the login cookie; other images become links", function () {
  var out = render("![Diagram](img:im_abcd1234)");
  assert.ok(out.indexOf('crossorigin="use-credentials"') !== -1);
  assert.ok(out.indexOf('src="https://api.barnyard.site/notebook/image?id=im_abcd1234"') !== -1);
  var ext = render("![x](https://tracker.example/pixel.png)");
  assert.ok(ext.indexOf("<img") === -1 && ext.indexOf("href") !== -1, "no third-party image is ever requested");
  assert.ok(render("![x](img:im_BAD)").indexOf("<img") === -1);
  assert.ok(render("![x](img:im_abcd1234)", {}).indexOf("<img") === -1, "no image URL builder -> no image");
});

test("[[wiki links]] point at an existing note, or show as missing", function () {
  var out = render("See [[Azure AD]] and [[azure ad|the directory]] and [[Nothing here]].");
  assert.ok(out.indexOf('href="#nt_abcd1234"') !== -1 && out.indexOf('data-note="nt_abcd1234"') !== -1);
  assert.ok(out.indexOf(">the directory<") !== -1);
  assert.ok(out.indexOf('class="wiki missing"') !== -1);
});

test("lists: bullets, numbers with a start, nesting and tasks", function () {
  assert.strictEqual(render("- a\n- b\n  - c\n- d"), "<ul><li><p>a</p></li><li><p>b</p><ul><li><p>c</p></li></ul></li><li><p>d</p></li></ul>");
  assert.ok(render("3. x\n4. y").indexOf('<ol start="3">') !== -1);
  var tasks = render("- [ ] todo\n- [x] done");
  assert.ok(tasks.indexOf('class="tasks"') !== -1 && tasks.indexOf("checked") !== -1 && tasks.indexOf("disabled") !== -1);
});

test("a table keeps its header, rows and alignment; short rows are padded", function () {
  var out = render("| A | B |\n|:--|--:|\n| 1 | 2 |\n| 3 |");
  assert.ok(out.indexOf("<th data-align=\"left\">A</th>") !== -1 && out.indexOf("<th data-align=\"right\">B</th>") !== -1);
  assert.ok(out.indexOf("<td data-align=\"left\">1</td>") !== -1);
  assert.strictEqual((out.match(/<tr>/g) || []).length, 3);
  assert.strictEqual(out.indexOf("style="), -1, "no inline styles (the page CSP forbids them)");
});

test("code fences keep their text exactly, including markup-like text", function () {
  var out = render("```js\nconst a = '<b>*x*</b>';\n```");
  assert.ok(out.indexOf("<pre><code data-lang=\"js\">const a = '&lt;b&gt;*x*&lt;/b&gt;';</code></pre>") !== -1, out);
  assert.ok(render("~~~\n# not a heading\n~~~").indexOf("<h1>") === -1);
  assert.ok(render("```\nunclosed").indexOf("unclosed") !== -1);
});

test("quotes and callouts", function () {
  assert.strictEqual(render("> quoted\n> more"), "<blockquote><p>quoted<br>more</p></blockquote>");
  var c = render("> [!WARNING] Careful\n> second line");
  assert.ok(c.indexOf('class="callout callout-warning"') !== -1 && c.indexOf(">Warning<") !== -1 && c.indexOf("Careful") !== -1 && c.indexOf("second line") !== -1);
});

test("a horizontal rule", function () {
  assert.strictEqual(render("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
});

test("backslash escapes show the character literally", function () {
  assert.strictEqual(render("\\*not italic\\* and \\[x\\]"), "<p>*not italic* and [x]</p>");
});

test("hostile or huge input cannot hang or crash the renderer", function () {
  var t0 = Date.now();
  [new Array(5000).join("*"), new Array(5000).join("[["), new Array(3000).join("> "), new Array(3000).join("- "),
    new Array(2000).join("`"), new Array(3000).join("**a "), new Array(40).join("  - x\n"), "x".repeat(30000) + "**a"].forEach(function (s) {
    render(s);
  });
  assert.ok(Date.now() - t0 < 5000, "took " + (Date.now() - t0) + " ms");
});

test("collect lists the note titles and images a note refers to", function () {
  var found = md.collect(md.parse("See [[A]] and [[B|b]] ![x](img:im_abcd1234)\n\n- [[A]]\n\n| t |\n|---|\n| [[C]] |"));
  assert.deepStrictEqual(found.wiki, ["A", "B", "C"]);
  assert.deepStrictEqual(found.images, ["im_abcd1234"]);
});

test("safeUrl accepts only plain absolute web and mail addresses", function () {
  assert.strictEqual(md.safeUrl("https://example.com"), "https://example.com/");
  assert.strictEqual(md.safeUrl("  http://example.com/a b  "), null);
  assert.strictEqual(md.safeUrl("https://exa\u0000mple.com"), null);
  assert.strictEqual(md.safeUrl(null), null);
});

console.log("\n" + passed + " passed");
