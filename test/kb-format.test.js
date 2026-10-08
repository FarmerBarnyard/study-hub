// Tests for kb-format.js -- turning notes into an article draft.   node test/kb-format.test.js

var assert = require("assert");
var path = require("path");
var f = require(path.join(__dirname, "..", "kb-format.js"));
var md = require(path.join(__dirname, "..", "markdown.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("a single note keeps its words, drops a heading that repeats the title, and starts sections at ##", function () {
  var d = f.draftFromNotes([{ title: "SC-300", body: "# SC-300\n\nIntro text here that is long enough to be a summary.\n\n# Part one\n\nText.\n\n## Detail\n\nMore.", tags: ["Azure"] }]);
  assert.strictEqual(d.title, "SC-300");
  assert.strictEqual(d.body, "Intro text here that is long enough to be a summary.\n\n## Part one\n\nText.\n\n### Detail\n\nMore.\n");
  assert.deepStrictEqual(d.tags, ["azure"]);
  assert.strictEqual(d.summary, "Intro text here that is long enough to be a summary.");
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

test("the summary prefers a real paragraph, skips picture captions and short stubs", function () {
  var long = "This paragraph is long enough to say something useful about the topic.";
  assert.strictEqual(f.summaryOf("Image 1: The Shared Responsibility Model\n\nShort.\n\n" + long), long);
  assert.strictEqual(f.summaryOf("Intro paragraph with a list straight after it that runs long enough\n- one two three four five six seven\n"), "Intro paragraph with a list straight after it that runs long enough");
});

test("with no paragraph it uses a list item, then says what the article covers, then whatever is there", function () {
  assert.strictEqual(f.summaryOf("## A\n\n- Always keep three copies of important data offsite\n- b\n"), "Always keep three copies of important data offsite");
  assert.strictEqual(f.summaryOf("## Users\n\n- a\n\n## Groups\n\n- b\n\n## Roles\n\n- c\n\n## Licences\n\n- d"), "Covers Users, Groups and Roles and more.");
  assert.strictEqual(f.summaryOf("## Users\n\n- a\n\n## Groups\n\n- b"), "Covers Users and Groups.");
  assert.strictEqual(f.summaryOf("Short line.\n"), "Short line.");
  assert.strictEqual(f.summaryOf("# Only a heading"), "");
  assert.strictEqual(f.summaryOf(""), "");
});

test("a to-do list is not mistaken for prose and its boxes are dropped from the text", function () {
  assert.strictEqual(f.summaryOf("- [ ] Revise the identity governance chapter before the exam\n- [x] done"), "Revise the identity governance chapter before the exam");
});

// ---- rewriting passage by passage ------------------------------------------------------------

function wordsIn(s) { return (s.match(/[A-Za-z0-9']+/g) || []).length; }
var PARA = "Entra ID is the identity service for Microsoft cloud apps, and it holds users, groups and devices for a tenant. ";
var ARTICLE = [
  "## Overview", PARA.repeat(2).trim(),
  "```powershell\nGet-MgUser -All\n\nGet-MgGroup\n```",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "![shot](img:im_abcd1234)",
  "https://learn.microsoft.com/en-us/entra/",
  "> [!TIP]\n> **Key points**\n> - one two three four five six seven eight nine ten eleven twelve",
  "Short line here.",
  "## Roles",
  "- Global administrator can manage every setting in the tenant and assign other roles\n- User administrator can create and manage users and groups but not reset every admin password\n- Helpdesk administrator can reset passwords for non-administrators and invalidate refresh tokens for them\n- Billing administrator can make purchases and manage subscriptions and support tickets for the organisation\n- Security administrator can read security reports and manage policies for sign-in risk and conditional access across the tenant\n- Reports reader can view sign-in reports and usage reports but cannot change any setting or any user in the directory",
].join("\n\n") + "\n";

test("an article is split into units that join back to exactly the same text", function () {
  var units = f.splitForAi(ARTICLE);
  assert.strictEqual(f.joinUnits(units), ARTICLE);
  assert.strictEqual(f.joinUnits(f.splitForAi("")), "");
});

test("only prose is marked for rewriting: headings, code, tables, pictures, cards, quotes and short lines are kept", function () {
  var units = f.splitForAi(ARTICLE);
  units.filter(function (u) { return !u.ai; }).forEach(function (u) {
    assert.ok(/^(#|```|\||!\[|https:|>|Short)/.test(u.text), "kept as written: " + u.text.slice(0, 30));
  });
  units.filter(function (u) { return u.ai; }).forEach(function (u) {
    assert.ok(!/^(#|```|\||!\[|>)/.test(u.text));
    assert.ok(wordsIn(u.text) <= 90 + 20, "a unit is at most about 90 words: " + wordsIn(u.text));
  });
  assert.ok(units.some(function (u) { return u.ai; }));
});

test("long paragraphs split at sentences and long lists between items, each unit knowing its heading", function () {
  var para = f.splitForAi("## Intro\n\n" + PARA.repeat(12).trim() + "\n");
  var ai = para.filter(function (u) { return u.ai; });
  assert.ok(ai.length >= 2, "a 200-word paragraph becomes several units");
  ai.forEach(function (u) { assert.strictEqual(u.heading, "Intro"); assert.ok(/[.]$/.test(u.text), "cut at a sentence end"); });
  assert.strictEqual(ai[0].sep, " ");
  assert.strictEqual(ai[ai.length - 1].sep, "\n\n");
  var roles = f.splitForAi(ARTICLE).filter(function (u) { return u.ai && u.heading === "Roles"; });
  assert.ok(roles.length >= 2 && roles[0].sep === "\n", "a list is cut between items");
  roles.forEach(function (u) { assert.ok(u.text.split("\n").every(function (l) { return /^- /.test(l); })); });
});

test("code, links, images, addresses and [[links]] are swapped for markers and come back exactly", function () {
  var p = f.protect("Run `Get-MgUser -All` then see [the docs](https://e.com/x) and https://example.com/a and ![s](img:im_abcd1234) and [[Other]].");
  assert.strictEqual(p.tokens.length, 5);
  assert.ok(p.text.indexOf("Get-MgUser") === -1 && p.text.indexOf("example.com") === -1);
  assert.ok(/⟦1⟧/.test(p.text));
  assert.strictEqual(f.restore(p.text, p.tokens), "Run `Get-MgUser -All` then see [the docs](https://e.com/x) and https://example.com/a and ![s](img:im_abcd1234) and [[Other]].");
  assert.strictEqual(f.protect("plain words").tokens.length, 0);
});

test("a rewrite that loses, repeats or invents a marker is refused", function () {
  var tokens = ["`a`", "`b`"];
  assert.strictEqual(f.restore("uses ⟦1⟧ and ⟦2⟧", tokens), "uses `a` and `b`");
  assert.strictEqual(f.restore("uses ⟦1⟧ only", tokens), null, "lost");
  assert.strictEqual(f.restore("⟦1⟧ ⟦1⟧ ⟦2⟧", tokens), null, "repeated");
  assert.strictEqual(f.restore("⟦1⟧ ⟦2⟧ ⟦3⟧", tokens), null, "invented");
});

test("a rewrite is accepted only if it is plausibly the same passage", function () {
  var orig = "The user administrator role can create and manage users and groups in the tenant but cannot reset passwords for every administrator account.";
  assert.strictEqual(f.acceptRewrite(orig, "A user administrator creates and manages users and groups, though not the passwords of every administrator account in the tenant."), true);
  assert.strictEqual(f.acceptRewrite(orig, "Admins manage users."), false, "far shorter");
  assert.strictEqual(f.acceptRewrite(orig, orig + " " + orig + " " + orig), false, "far longer");
  assert.strictEqual(f.acceptRewrite(orig, "## New heading\n" + orig), false, "adds a heading");
  assert.strictEqual(f.acceptRewrite(orig, "```\n" + orig + "\n```"), false, "adds a code fence");
  assert.strictEqual(f.acceptRewrite(orig, orig + " ⟦1⟧"), false, "a marker is left over");
  assert.strictEqual(f.acceptRewrite(orig, ""), false);
  assert.strictEqual(f.acceptRewrite(orig, null), false);
});

test("replacing a unit's text rebuilds an article that keeps everything else byte for byte", function () {
  var units = f.splitForAi(ARTICLE);
  var i = units.findIndex(function (u) { return u.ai && u.heading === "Overview"; });
  units[i].text = "REWRITTEN overview text that stands in for the model's answer.";
  var out = f.joinUnits(units);
  assert.ok(out.indexOf("REWRITTEN overview") !== -1);
  assert.ok(out.indexOf("```powershell\nGet-MgUser -All\n\nGet-MgGroup\n```") !== -1, "code with its blank line is untouched");
  assert.ok(out.indexOf("![shot](img:im_abcd1234)") !== -1 && out.indexOf("| a | b |") !== -1);
});

console.log("\n" + passed + " passed");
