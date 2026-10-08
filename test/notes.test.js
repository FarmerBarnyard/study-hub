// Tests for the pure helpers in notes.js (tree, list editing, slash menu, triggers).
//   node test/notes.test.js

var assert = require("assert");
var path = require("path");
var n = require(path.join(__dirname, "..", "notes.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function item(id, title, kind, parent) { return { id: id, title: title, kind: kind || "note", parent: parent || null }; }

test("the tree puts folders first, sorts naturally, and files orphans at the top", function () {
  var t = n.buildTree([
    item("nt_00000001", "Note 10"), item("nt_00000002", "Note 2"), item("nt_00000003", "Zeta", "folder"),
    item("nt_00000004", "Inside", "note", "nt_00000003"), item("nt_00000005", "Orphan", "note", "nt_missing1"),
    item("nt_00000006", "Under a note", "note", "nt_00000001"),
  ]);
  assert.deepStrictEqual(t.children[""].map(function (i) { return i.title; }), ["Zeta", "Note 2", "Note 10", "Orphan", "Under a note"]);
  assert.deepStrictEqual(t.children["nt_00000003"].map(function (i) { return i.title; }), ["Inside"]);
});

test("a folder's subtree includes everything beneath it", function () {
  var t = n.buildTree([item("nt_aaaaaaa1", "A", "folder"), item("nt_aaaaaaa2", "B", "folder", "nt_aaaaaaa1"), item("nt_aaaaaaa3", "C", "note", "nt_aaaaaaa2"), item("nt_aaaaaaa4", "D")]);
  assert.deepStrictEqual(n.subtreeIds(t, "nt_aaaaaaa1").sort(), ["nt_aaaaaaa1", "nt_aaaaaaa2", "nt_aaaaaaa3"]);
});

test("Enter continues a bullet, a numbered item and a task; an empty item ends the list", function () {
  var r = n.listEnter("- one", 5);
  assert.strictEqual(r.text, "- one\n- ");
  assert.strictEqual(r.caret, 8);
  assert.strictEqual(n.listEnter("9. nine", 7).text, "9. nine\n10. ");
  assert.strictEqual(n.listEnter("  - [x] done", 12).text, "  - [x] done\n  - [ ] ");
  assert.strictEqual(n.listEnter("- a\n- ", 6).text, "- a\n");
  assert.strictEqual(n.listEnter("plain text", 10), null);
  assert.strictEqual(n.listEnter("> quote", 7).text, "> quote\n> ");
  assert.strictEqual(n.listEnter("> ", 2).text, "");
});

test("Enter in the middle of a list item splits it", function () {
  var r = n.listEnter("- abcdef", 5);
  assert.strictEqual(r.text, "- abc\n- def");
});

test("wrapping keeps the selection, or inserts a placeholder", function () {
  var r = n.wrapSelection("say hello now", 4, 9, "**", "**", "x");
  assert.strictEqual(r.text, "say **hello** now");
  assert.strictEqual(r.text.slice(r.selStart, r.selEnd), "hello");
  var p = n.wrapSelection("", 0, 0, "`", "`", "code");
  assert.strictEqual(p.text, "`code`");
  assert.strictEqual(p.text.slice(p.selStart, p.selEnd), "code");
});

test("line prefixes toggle on and off across several lines", function () {
  var on = n.prefixLines("a\nb\nc", 0, 3, "- ");
  assert.strictEqual(on.text, "- a\n- b\nc");
  var off = n.prefixLines(on.text, 0, on.selEnd, "- ");
  assert.strictEqual(off.text, "a\nb\nc");
});

test("the slash menu filters by id or label", function () {
  assert.ok(n.slashMatches("").length > 10);
  assert.deepStrictEqual(n.slashMatches("h2").map(function (c) { return c.id; }), ["h2"]);
  assert.ok(n.slashMatches("call").every(function (c) { return /callout/i.test(c.label); }));
  assert.strictEqual(n.slashMatches("zzzz").length, 0);
});

test("a slash at the start of a line, or an open [[, is a trigger; mid-line slashes are not", function () {
  assert.deepStrictEqual(n.triggerAt("text\n/hea", 9), { kind: "slash", query: "hea", from: 5, to: 9 });
  assert.strictEqual(n.triggerAt("a / b", 3), null);
  assert.strictEqual(n.triggerAt("http://x", 8), null);
  assert.deepStrictEqual(n.triggerAt("see [[Az", 8), { kind: "wiki", query: "Az", from: 4, to: 8 });
  assert.strictEqual(n.triggerAt("see [[Done]] and", 16), null);
});

test("downloaded file names are safe", function () {
  assert.strictEqual(n.fileNameFor("SC-300: Identity / Access?"), "SC-300 Identity Access.md");
  assert.strictEqual(n.fileNameFor(""), "note.md");
  assert.strictEqual(n.fileNameFor("..\\..\\x"), ".. .. x.md");
});

test("ticking a to-do in the preview changes the right Markdown line, skipping code", function () {
  var text = "- [ ] one\n- [x] two\n\n```\n- [ ] not a task\n```\n\n1. [ ] three\n> - [ ] four";
  assert.strictEqual(n.toggleTask(text, 0).split("\n")[0], "- [x] one");
  assert.strictEqual(n.toggleTask(text, 1).split("\n")[1], "- [ ] two");
  assert.strictEqual(n.toggleTask(text, 2).split("\n")[7], "1. [x] three", "the task inside the code fence is not counted");
  assert.strictEqual(n.toggleTask(text, 3).split("\n")[8], "> - [x] four");
  assert.strictEqual(n.toggleTask(text, 4), null);
  assert.strictEqual(n.toggleTask("no tasks here", 0), null);
});

test("word count and reading time", function () {
  assert.deepStrictEqual(n.textStats(""), { words: 0, minutes: 0 });
  assert.strictEqual(n.textStats("one two three").words, 3);
  assert.strictEqual(n.textStats("word ".repeat(440)).minutes, 2);
  assert.strictEqual(n.textStats("a ```\nlots of code words here\n``` b").words, 2, "fenced code is not counted");
});

test("the breadcrumb lists the folders above an item, outermost first, and survives a loop", function () {
  var t = n.buildTree([item("nt_00000001", "A", "folder"), item("nt_00000002", "B", "folder", "nt_00000001"), item("nt_00000003", "C", "note", "nt_00000002")]);
  assert.deepStrictEqual(n.crumbPath(t, "nt_00000003").map(function (f) { return f.title; }), ["A", "B"]);
  assert.deepStrictEqual(n.crumbPath(t, "nt_00000001"), []);
  var loop = { byId: { x: { id: "x", parent: "y" }, y: { id: "y", parent: "x" } } };
  assert.ok(n.crumbPath(loop, "x").length <= 12);
});

test("quick find: every word must match; starts-with and whole words rank first; empty query lists the newest", function () {
  var items = [
    { id: "a", title: "Microsoft Entra roles", kind: "note", updatedAt: 1 },
    { id: "b", title: "Entra ID basics", kind: "note", updatedAt: 3 },
    { id: "c", title: "Pre-Entranced", kind: "note", updatedAt: 9 },
    { id: "d", title: "Other", kind: "note", updatedAt: 5 },
  ];
  // b starts with it; a and c tie (word starts with it), so the newer one (c) comes first
  assert.deepStrictEqual(n.rankFind(items, "entra", 10).map(function (i) { return i.id; }), ["b", "c", "a"]);
  assert.deepStrictEqual(n.rankFind(items, "entra roles", 10).map(function (i) { return i.id; }), ["a"]);
  assert.deepStrictEqual(n.rankFind(items, "", 2).map(function (i) { return i.id; }), ["c", "d"]);
  assert.deepStrictEqual(n.rankFind(items, "zzz", 5), []);
  assert.strictEqual(n.rankFind(items, "(", 5).length, 0, "regular-expression characters in a query are harmless");
});

console.log("\n" + passed + " passed");
