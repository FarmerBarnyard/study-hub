// Tests for kb-format.js -- turning notes into an article draft.   node test/kb-format.test.js

var assert = require("assert");
var path = require("path");
var f = require(path.join(__dirname, "..", "kb-format.js"));
var md = require(path.join(__dirname, "..", "markdown.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("a single note keeps its words, drops a heading that repeats the title, and starts sections at ##", function () {
  var d = f.draftFromNotes([{ title: "SC-300", body: "# SC-300\n\nIntro text here.\n\n# Part one\n\nText.\n\n## Detail\n\nMore.", tags: ["Azure"] }]);
  assert.strictEqual(d.title, "SC-300");
  assert.strictEqual(d.body, "Intro text here.\n\n## Part one\n\nText.\n\n### Detail\n\nMore.\n");
  assert.deepStrictEqual(d.tags, ["azure"]);
  assert.strictEqual(d.summary, "Intro text here.");
});

test("several notes become sections in the order given, each under its own ## heading", function () {
  var d = f.draftFromNotes([
    { title: "One", body: "# Heading\n\nAlpha." },
    { title: "Two", body: "Beta.\n\n## Sub\n\nGamma.", tags: ["x", "azure"] },
  ], { title: "Both together" });
  assert.strictEqual(d.title, "Both together");
  assert.strictEqual(d.body, "## One\n\n### Heading\n\nAlpha.\n\n## Two\n\nBeta.\n\n### Sub\n\nGamma.\n");
  assert.deepStrictEqual(d.tags, ["x", "azure"]);
  assert.strictEqual(d.report.sections, 2);
});

test("headings inside code fences are left alone", function () {
  var text = "# Top\n\n```md\n# not a heading\n```\n\n## Next";
  var out = f.shiftHeadings(text, 2);
  assert.strictEqual(out, "## Top\n\n```md\n# not a heading\n```\n\n### Next");
});

test("tidying: blank runs, trailing spaces, empty headings and an unclosed code fence", function () {
  var out = f.cleanBody("\n\nOne  \n\n\n\n\nTwo\n\n##\n\nThree\n\n```js\nlet a = 1;\n\n\n\nlet b = 2;");
  assert.strictEqual(out, "One\n\nTwo\n\nThree\n\n```js\nlet a = 1;\n\n\n\nlet b = 2;\n```\n", "blank lines inside code are kept, and the fence is closed");
  assert.strictEqual(f.cleanBody(""), "");
});

test("[[links]] become plain text unless they name a published article; fenced code is left alone", function () {
  var r = f.flattenLinks("See [[Entra ID]], [[Roles|the roles page]] and [[Veeam]].\n```\n[[also code]]\n```", { "entra id": true });
  assert.strictEqual(r.text, "See [[Entra ID]], the roles page and Veeam.\n```\n[[also code]]\n```");
  assert.deepStrictEqual(r.removed, ["Roles", "Veeam"]);
});

test("the summary is the first real paragraph, cleaned of Markdown and cut at a sentence", function () {
  assert.strictEqual(f.firstParagraph("# H\n\n- a list\n\n> a quote\n\nThe **first** [real](https://e.com) paragraph.\n\nSecond."), "The first real paragraph.");
  assert.strictEqual(f.firstParagraph("```\ncode\n```\n\n![shot](img:im_abcd1234)\n\nhttps://example.com\n\nText after."), "Text after.");
  assert.ok(f.firstParagraph("word ".repeat(100), 60).length <= 61);
  assert.strictEqual(f.firstParagraph(""), "");
  assert.strictEqual(f.firstParagraph("# Only a heading"), "");
});

test("a long first paragraph is cut at a sentence end when there is one", function () {
  var text = "First sentence is short. Second sentence runs on for a while longer than that. Third sentence is the one that gets cut off somewhere.";
  assert.strictEqual(f.firstParagraph(text, 80), "First sentence is short. Second sentence runs on for a while longer than that.");
});

test("the draft reports what is in it", function () {
  var d = f.draftFromNotes([{ title: "T", body: "Words here.\n\n![a](img:im_abcd1234)\n\n```\ncode\n```\n\nhttps://example.com/x\n\n[A page](https://example.com/y)\n\nSee [[Other]]." }]);
  assert.strictEqual(d.report.images, 1);
  assert.strictEqual(d.report.codeBlocks, 1);
  assert.strictEqual(d.report.linkCards, 2);
  assert.deepStrictEqual(d.report.flattenedLinks, ["Other"]);
  assert.ok(d.report.words >= 4);
});

test("tags are merged, lower-cased, de-duplicated and capped at eight", function () {
  var d = f.draftFromNotes([{ title: "A", body: "x", tags: ["One", "one", "a,b", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"] }]);
  assert.strictEqual(d.tags.length, 8);
  assert.strictEqual(d.tags[0], "one");
  assert.ok(d.tags.indexOf("a,b") === -1);
});

test("heading ids are unique within an article", function () {
  var seen = {};
  assert.strictEqual(f.headingId("Set up Entra ID!", seen), "set-up-entra-id");
  assert.strictEqual(f.headingId("Set up Entra ID", seen), "set-up-entra-id-2");
  assert.strictEqual(f.headingId("???", seen), "section");
  assert.strictEqual(f.headingId("日本語 見出し", seen), "日本語-見出し");
});

test("key points from the model go at the top as a callout and replace an earlier set", function () {
  var once = f.withKeyPoints("Body text.\n", ["First", " Second  point ", ""]);
  assert.strictEqual(once, "> [!TIP]\n> **Key points**\n> - First\n> - Second point\n\nBody text.\n");
  var twice = f.withKeyPoints(once, ["Only one"]);
  assert.strictEqual(twice, "> [!TIP]\n> **Key points**\n> - Only one\n\nBody text.\n");
  assert.strictEqual(f.withKeyPoints("Body", []), "Body");
});

test("what a draft produces renders as a callout with the points inside it", function () {
  var body = f.withKeyPoints("Intro.\n", ["Alpha point"]);
  var tree = md.parse(body);
  assert.strictEqual(tree[0].t, "quote");
  assert.strictEqual(tree[0].callout, "TIP");
});

console.log("\n" + passed + " passed");
