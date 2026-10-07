// Basic unit coverage for app.js's pure status-label logic. No build step,
// no package.json -- a plain Node script using only the standard library,
// matching barnyard-hub's test/*.test.js conventions. Run with:
//
//   node test/app.test.js

var assert = require("assert");
var path = require("path");

// app.js's loadCachedNotes/saveCachedNotes reference `window.localStorage`
// directly (it's a browser-only file with no other DOM dependency at
// module-load time) -- this minimal in-memory shim lets those two pure-ish
// functions run under plain Node without pulling in a real DOM library.
// Must be set before app.js's functions are CALLED (not before require() --
// nothing at module-load time touches `window`), so this runs first either
// way for clarity.
function makeMockLocalStorage() {
  var store = Object.create(null);
  return {
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem: function (key, value) {
      store[key] = String(value);
    },
    removeItem: function (key) {
      delete store[key];
    }
  };
}
global.window = { localStorage: makeMockLocalStorage() };

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
    notesUrl: "notes/sc-300.html",
    slug: "sc-300"
  });
  assert.strictEqual(out.name, "SC-300");
  assert.strictEqual(out.fullName, "SC-300: Microsoft Identity and Access Administrator");
  assert.strictEqual(out.status, "In progress");
  assert.strictEqual(out.notionUrl, "https://app.notion.com/p/abc123");
  assert.strictEqual(out.notesUrl, "notes/sc-300.html");
  assert.strictEqual(out.slug, "sc-300");
});

test("normalizeCert: a slug must be lowercase-alphanumeric-hyphen only, matching the Worker's allowlist key format", function () {
  assert.strictEqual(app.normalizeCert({ name: "X", slug: "sc-300" }).slug, "sc-300");
  assert.strictEqual(app.normalizeCert({ name: "X" }).slug, null);
  assert.strictEqual(app.normalizeCert({ name: "X", slug: "" }).slug, null);
  assert.strictEqual(app.normalizeCert({ name: "X", slug: "SC-300" }).slug, null);
  assert.strictEqual(app.normalizeCert({ name: "X", slug: "sc 300" }).slug, null);
  assert.strictEqual(app.normalizeCert({ name: "X", slug: "../secrets" }).slug, null);
  assert.strictEqual(app.normalizeCert({ name: "X", slug: 300 }).slug, null);
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

// ---- friendlyGenerateError -------------------------------------------------
// A 2026-08-23 review found the original code displayed raw err.message
// directly, producing broken/tautological/blame-the-user copy for several
// real failure paths (a stuttering "Couldn't generate...: couldn't generate
// revision notes right now.", and an abort timeout phrased as if the user
// did something wrong). These cases are the ones that review traced by hand.

test("friendlyGenerateError: an AbortError (the 65s client timeout) gets a specific, non-blaming message", function () {
  var err = new Error("The user aborted a request");
  err.name = "AbortError";
  assert.strictEqual(
    app.friendlyGenerateError(err),
    "Generation took longer than expected and timed out. Try again."
  );
});

test("friendlyGenerateError: a TypeError (network failure, CSP block, offline) gets a connectivity message, not \"Failed to fetch\"", function () {
  assert.strictEqual(
    app.friendlyGenerateError(new TypeError("Failed to fetch")),
    "Couldn't reach the notes service. Check your connection and try again."
  );
});

test("friendlyGenerateError: the Worker's own informative 400/422 messages pass through, composed once (not stuttered)", function () {
  assert.strictEqual(
    app.friendlyGenerateError(new Error("unknown certification")),
    "Couldn't generate revision notes: unknown certification."
  );
  assert.strictEqual(
    app.friendlyGenerateError(new Error("not enough content in Notion yet to generate notes")),
    "Couldn't generate revision notes: not enough content in Notion yet to generate notes."
  );
});

test("friendlyGenerateError: any other message (a generic Worker 502, a malformed-response guard) gets one fixed fallback, not echoed verbatim", function () {
  assert.strictEqual(
    app.friendlyGenerateError(new Error("couldn't generate revision notes right now")),
    "Couldn't generate revision notes right now. Try again in a moment."
  );
  assert.strictEqual(
    app.friendlyGenerateError(new Error("malformed response")),
    "Couldn't generate revision notes right now. Try again in a moment."
  );
  assert.strictEqual(app.friendlyGenerateError(undefined), "Couldn't generate revision notes right now. Try again in a moment.");
});

// ---- loadCachedNotes / saveCachedNotes ------------------------------------
// Backed by the in-memory localStorage shim set up at the top of this file.

test("saveCachedNotes + loadCachedNotes: a fresh round-trip returns the same sections", function () {
  var sections = [{ heading: "A", items: ["one", "two"] }];
  app.saveCachedNotes("sc-300", sections);
  var out = app.loadCachedNotes("sc-300");
  assert.notStrictEqual(out, null);
  assert.deepStrictEqual(out.sections, sections);
  assert.strictEqual(typeof out.generatedAt, "string");
});

test("loadCachedNotes: cache entries are isolated per slug", function () {
  app.saveCachedNotes("az-900", [{ heading: "AZ-900 only", items: ["x"] }]);
  var az900 = app.loadCachedNotes("az-900");
  var sc300 = app.loadCachedNotes("sc-300"); // written by the previous test
  assert.notStrictEqual(az900, null);
  assert.notStrictEqual(sc300, null);
  assert.notStrictEqual(az900.sections[0].heading, sc300.sections[0].heading);
});

test("loadCachedNotes: missing, corrupted, or empty-sections entries all return null rather than throwing", function () {
  assert.strictEqual(app.loadCachedNotes("no-such-slug"), null);
  window.localStorage.setItem("study-hub-notes:broken", "{not valid json");
  assert.strictEqual(app.loadCachedNotes("broken"), null);
  window.localStorage.setItem("study-hub-notes:empty", JSON.stringify({ v: 1, sections: [], generatedAt: new Date().toISOString() }));
  assert.strictEqual(app.loadCachedNotes("empty"), null);
});

test("loadCachedNotes: a schema-version mismatch is rejected (forward-compat guard for a future shape change)", function () {
  window.localStorage.setItem(
    "study-hub-notes:old-version",
    JSON.stringify({ v: 0, sections: [{ heading: "A", items: ["x"] }], generatedAt: new Date().toISOString() })
  );
  assert.strictEqual(app.loadCachedNotes("old-version"), null);
});

test("loadCachedNotes: an entry older than the 30-day max age is treated as expired", function () {
  var old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  window.localStorage.setItem(
    "study-hub-notes:stale",
    JSON.stringify({ v: 1, sections: [{ heading: "A", items: ["x"] }], generatedAt: old })
  );
  assert.strictEqual(app.loadCachedNotes("stale"), null);

  var recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  window.localStorage.setItem(
    "study-hub-notes:fresh",
    JSON.stringify({ v: 1, sections: [{ heading: "A", items: ["x"] }], generatedAt: recent })
  );
  assert.notStrictEqual(app.loadCachedNotes("fresh"), null);
});

// ---- describeSync ----------------------------------------------------------
// The page flags a Notion snapshot that has gone stale, because an old list
// reads exactly like a current one.

test("describeSync: a recent snapshot is a plain date, not flagged", function () {
  var s = app.describeSync("2026-10-01", new Date(2026, 9, 7, 12, 0, 0).getTime());
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.days, 6);
  assert.ok(/^Last synced from Notion on /.test(s.text));
});

test("describeSync: 14 days or older is flagged and says how old", function () {
  var now = new Date(2026, 9, 7, 12, 0, 0).getTime();
  assert.strictEqual(app.describeSync("2026-09-24", now).stale, false, "13 days is still fine");
  var s = app.describeSync("2026-09-23", now);
  assert.strictEqual(s.stale, true);
  assert.strictEqual(s.days, 14);
  assert.ok(/^Notion sync is 14 days old \(last synced /.test(s.text));
  assert.strictEqual(app.describeSync("2026-08-23", now).days, 45);
});

test("describeSync: today and a future date count as zero days, an odd value is shown as-is and never flagged", function () {
  var now = new Date(2026, 9, 7, 23, 59, 0).getTime();
  assert.strictEqual(app.describeSync("2026-10-07", now).days, 0);
  assert.strictEqual(app.describeSync("2026-12-25", now).days, 0);
  var odd = app.describeSync("last Tuesday", now);
  assert.strictEqual(odd.stale, false);
  assert.strictEqual(odd.days, null);
  assert.strictEqual(odd.text, "Last synced from Notion: last Tuesday");
});
console.log(passed + " passed");
