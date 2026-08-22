// Basic unit coverage for app.js's pure status-label logic. No build step,
// no package.json -- a plain Node script using only the standard library,
// matching barnyard-hub's test/*.test.js conventions. Run with:
//
//   node test/app.test.js

var assert = require("assert");
var path = require("path");

var app = require(path.join(__dirname, "..", "app.js"));

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// ---- statusClass ----------------------------------------------------------

test("statusClass: \"In progress\" maps to the in-progress class", function () {
  assert.strictEqual(app.statusClass("In progress"), "in-progress");
});

test("statusClass: \"Done\" maps to the done class", function () {
  assert.strictEqual(app.statusClass("Done"), "done");
});

test("statusClass: \"Not started\" and any unrecognized value both fall back to not-started", function () {
  assert.strictEqual(app.statusClass("Not started"), "not-started");
  assert.strictEqual(app.statusClass("Something new"), "not-started");
  assert.strictEqual(app.statusClass(undefined), "not-started");
});

// ---- normalizeCert ---------------------------------------------------------
// Guards against a malformed data.json entry rendering the literal word
// "undefined" (textContent = undefined stringifies to "undefined") or a
// broken href="undefined" Notion link -- see app.js's own comment on this
// function for the failure this was specifically written to catch.

test("normalizeCert: a well-formed entry passes through unchanged", function () {
  var out = app.normalizeCert({
    name: "SC-300",
    fullName: "SC-300: Microsoft Identity and Access Administrator",
    status: "In progress",
    notionUrl: "https://app.notion.com/p/abc123",
    notesUrl: "notes/sc-300.html"
  });
  assert.strictEqual(out.name, "SC-300");
  assert.strictEqual(out.fullName, "SC-300: Microsoft Identity and Access Administrator");
  assert.strictEqual(out.status, "In progress");
  assert.strictEqual(out.notionUrl, "https://app.notion.com/p/abc123");
  assert.strictEqual(out.notesUrl, "notes/sc-300.html");
});

test("normalizeCert: a missing name falls back to a placeholder, not \"undefined\"", function () {
  assert.strictEqual(app.normalizeCert({}).name, "(untitled certification)");
  assert.strictEqual(app.normalizeCert({ name: "" }).name, "(untitled certification)");
  assert.strictEqual(app.normalizeCert(null).name, "(untitled certification)");
});

test("normalizeCert: a non-https notionUrl (or a missing one) is dropped, not passed through as a broken link", function () {
  assert.strictEqual(app.normalizeCert({ name: "X" }).notionUrl, null);
  assert.strictEqual(app.normalizeCert({ name: "X", notionUrl: "" }).notionUrl, null);
  assert.strictEqual(app.normalizeCert({ name: "X", notionUrl: "javascript:alert(1)" }).notionUrl, null);
  assert.strictEqual(app.normalizeCert({ name: "X", notionUrl: 12345 }).notionUrl, null);
});

test("normalizeCert: fullName equal to name is suppressed (no redundant subtitle)", function () {
  assert.strictEqual(app.normalizeCert({ name: "MS-900", fullName: "MS-900" }).fullName, null);
  assert.strictEqual(app.normalizeCert({ name: "MS-900" }).fullName, null);
});

test("normalizeCert: an empty or non-string status/notesUrl is normalized to null, not an empty string", function () {
  var out = app.normalizeCert({ name: "X", status: "", notesUrl: "" });
  assert.strictEqual(out.status, null);
  assert.strictEqual(out.notesUrl, null);
});

console.log(passed + " passed");
