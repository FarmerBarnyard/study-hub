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

console.log(passed + " passed");
