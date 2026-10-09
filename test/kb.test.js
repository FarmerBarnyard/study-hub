// Tests for the pure helpers in kb.js (routes, filtering, sorting, notebook picker, messages).
//   node test/kb.test.js

var assert = require("assert");
var path = require("path");
var k = require(path.join(__dirname, "..", "kb.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("addresses map to views, and anything odd falls back to the library", function () {
  assert.deepStrictEqual(k.parseRoute(""), { view: "library" });
  assert.deepStrictEqual(k.parseRoute("#/"), { view: "library" });
  assert.deepStrictEqual(k.parseRoute("#/a/ka_abcd1234"), { view: "article", id: "ka_abcd1234" });
  assert.deepStrictEqual(k.parseRoute("#/edit/ka_abcd1234"), { view: "edit", id: "ka_abcd1234" });
  assert.deepStrictEqual(k.parseRoute("#/a/../x"), { view: "library" });
  assert.deepStrictEqual(k.parseRoute("#/a/KA_ABCD1234"), { view: "library" });
  assert.deepStrictEqual(k.parseRoute("#/new"), { view: "new", notes: [], ai: false });
  assert.deepStrictEqual(k.parseRoute("#/new?note=nt_aaaaaaa1&note=nt_aaaaaaa2&note=nt_aaaaaaa1&note=bad&x=1"), { view: "new", notes: ["nt_aaaaaaa1", "nt_aaaaaaa2"], ai: false });
  assert.deepStrictEqual(k.parseRoute("#/new?note=nt_aaaaaaa1&ai=1"), { view: "new", notes: ["nt_aaaaaaa1"], ai: true });
  assert.strictEqual(k.parseRoute("#/new?note=nt_aaaaaaa1&ai=11").ai, false);
  assert.strictEqual(k.parseRoute("#/new?note=nt_aaaaaaa1&bai=1").ai, false);
  assert.strictEqual(k.parseRoute("#/new?" + Array.from({ length: 30 }, function (_, i) { return "note=nt_aaaaaa" + (10 + i); }).join("&")).notes.length, 12);
});

test("relative dates", function () {
  var now = new Date(2026, 9, 8, 15, 0, 0).getTime();
  assert.strictEqual(k.relTime(new Date(2026, 9, 8, 1, 0, 0).getTime(), now), "today");
  assert.strictEqual(k.relTime(new Date(2026, 9, 7, 23, 0, 0).getTime(), now), "yesterday");
  assert.strictEqual(k.relTime(new Date(2026, 9, 3, 9, 0, 0).getTime(), now), "5 days ago");
  assert.strictEqual(k.relTime(new Date(2026, 8, 1, 9, 0, 0).getTime(), now), "1 Sep 2026");
  assert.strictEqual(k.relTime(now + 86400000 * 3, now), "today", "a future date is never shown as ago");
  assert.strictEqual(k.relTime(NaN, now), "");
});

var items = [
  { id: "ka_00000001", title: "SC-300 identity", summary: "Entra roles", tags: ["azure", "identity"], author: "Nathan", minutes: 12, updatedAt: 300, mine: true },
  { id: "ka_00000002", title: "Veeam foundations", summary: "Backup basics", tags: ["backup"], author: "Sam", minutes: 3, updatedAt: 500, mine: false },
  { id: "ka_00000003", title: "Azure networking", summary: "", tags: ["azure"], author: "Sam", minutes: 8, updatedAt: 100, mine: false },
];

test("tags are counted, most used first", function () {
  assert.deepStrictEqual(k.tagCounts(items), [{ tag: "azure", count: 2 }, { tag: "backup", count: 1 }, { tag: "identity", count: 1 }]);
});

test("the list filters by tag, ownership and every word of the search", function () {
  assert.strictEqual(k.filterItems(items, { tag: "azure" }).length, 2);
  assert.strictEqual(k.filterItems(items, { mine: true }).length, 1);
  assert.strictEqual(k.filterItems(items, { q: "sam backup" }).length, 1);
  assert.strictEqual(k.filterItems(items, { q: "ENTRA" })[0].id, "ka_00000001");
  assert.strictEqual(k.filterItems(items, { q: "zzz" }).length, 0);
  assert.strictEqual(k.filterItems(items, { q: "(" }).length, 0, "regular-expression characters are harmless");
  assert.strictEqual(k.filterItems(items, {}).length, 3);
});

test("sorting does not change the list it was given", function () {
  var ids = function (l) { return l.map(function (i) { return i.id.slice(-1); }).join(""); };
  assert.strictEqual(ids(k.sortItems(items, "updated")), "213");
  assert.strictEqual(ids(k.sortItems(items, "title")), "312");
  assert.strictEqual(ids(k.sortItems(items, "short")), "231");
  assert.strictEqual(ids(k.sortItems(items, "long")), "132");
  assert.strictEqual(ids(items), "123");
});

var notebook = [
  { id: "nt_00000001", parent: null, kind: "folder", title: "Knowledgebase", tags: [] },
  { id: "nt_00000002", parent: "nt_00000001", kind: "folder", title: "SC-300", tags: [] },
  { id: "nt_00000003", parent: "nt_00000002", kind: "note", title: "Roles", tags: ["azure"], pii: [], updatedAt: 5 },
  { id: "nt_00000004", parent: null, kind: "note", title: "Loose note", tags: [], pii: ["email"], updatedAt: 9 },
];

test("the note picker lists notes only, with their folders, newest first, and filters by every word", function () {
  var all = k.noteChoices(notebook, "");
  assert.deepStrictEqual(all.map(function (c) { return c.id; }), ["nt_00000004", "nt_00000003"]);
  assert.strictEqual(all[1].path, "Knowledgebase / SC-300");
  assert.deepStrictEqual(all[0].pii, ["email"]);
  assert.strictEqual(k.noteChoices(notebook, "sc-300 roles").length, 1, "the folder name counts");
  assert.strictEqual(k.noteChoices(notebook, "azure").length, 1, "so do tags");
  assert.strictEqual(k.noteChoices(notebook, "folder").length, 0);
});

test("a folder loop cannot hang the path lookup", function () {
  var loop = [{ id: "a", parent: "b", kind: "note", title: "A" }, { id: "b", parent: "a", kind: "folder", title: "B" }];
  assert.ok(k.folderPath(loop, "a").length <= 12);
});

test("error messages are plain, name the problem, and never echo server text", function () {
  assert.ok(/recent sign-in/.test(k.describeError(403, { error: "recent_sign_in_required" })));
  assert.ok(/password or key/.test(k.describeError(422, { error: "secret_detected", field: "body", kind: "aws key" })));
  assert.ok(/reach the server/.test(k.describeError(0, {})));
  assert.ok(/signed out/.test(k.describeError(401, {})));
  var odd = k.describeError(500, { error: "<script>x</script>" });
  assert.ok(odd.indexOf("Something went wrong") === 0);
  assert.strictEqual(k.describePii(["email", "card", "mystery"]), "email addresses, card numbers, mystery");
});


// ---- the AI help as background jobs ----

test("job errors say what to do, with the offline case spelled out", function () {
  assert.ok(/offline/.test(k.describeJobError(503, { error: "ai_unavailable", reason: "engine_offline" })));
  assert.ok(/three AI jobs/.test(k.describeJobError(429, { error: "too_many_jobs" })));
  assert.ok(/allowance/.test(k.describeJobError(429, { error: "rate_limited" })));
  assert.ok(/more passages/.test(k.describeJobError(400, { error: "too_many_units" })));
  assert.strictEqual(k.describeJobError(503, { error: "ai_unavailable" }), k.describeError(503, { error: "ai_unavailable" }), "other errors use the usual wording");
  assert.strictEqual(k.describeJobError(0, null), "Could not reach the server.");
});

test("a rewrite sends at most what one job takes and says how many were left out", function () {
  var todo = [0, 2, 4, 6, 8];
  assert.deepStrictEqual(k.planRewrite(todo, 3), { take: [0, 2, 4], skipped: 2 });
  assert.deepStrictEqual(k.planRewrite(todo, 30), { take: todo, skipped: 0 });
  assert.deepStrictEqual(k.planRewrite(todo), { take: todo, skipped: 0 }, "30 unless told otherwise");
  assert.strictEqual(k.planRewrite(Array.from({ length: 40 }, function (_, i) { return i; })).take.length, 30);
  assert.strictEqual(k.planRewrite(todo, 0).take.length, 5, "a nonsense limit falls back to the default");
});

test("the time left comes from how fast results have arrived, with a sensible first guess", function () {
  var now = 1000000;
  assert.strictEqual(k.jobEtaMs({ total: 4, done: 0, failed: 0 }, now), 4 * 150000);
  assert.strictEqual(k.jobEtaMs({ total: 4, done: 2, failed: 0, startedAt: now - 240000 }, now), 2 * 120000);
  assert.strictEqual(k.jobEtaMs({ total: 4, done: 1, failed: 1, startedAt: now - 200000 }, now), 2 * 100000, "a failed passage counts as time spent");
  assert.strictEqual(k.jobEtaMs({ total: 2, done: 2, failed: 0, startedAt: now - 1 }, now), 0);
});

test("the progress line says what is happening", function () {
  var now = 1000000;
  assert.ok(/Waiting for the AI service/.test(k.jobStatusText({ state: "queued", total: 3 }, "rewrite", now)));
  assert.strictEqual(k.jobStatusText({ state: "running", cancelling: true, total: 3 }, "rewrite", now), "Stopping…");
  assert.ok(/Writing the summary/.test(k.jobStatusText({ state: "running", total: 1 }, "summary", now)));
  var t = k.jobStatusText({ state: "running", total: 5, done: 1, failed: 0, startedAt: now - 120000 }, "rewrite", now);
  assert.ok(/passage 2 of 5/.test(t), t);
  assert.ok(/about 8 minutes left/.test(t), t);
  assert.ok(/passage 5 of 5/.test(k.jobStatusText({ state: "running", total: 5, done: 4, failed: 0, startedAt: now - 1 }, "rewrite", now)));
  assert.ok(/about 1 minute left/.test(k.jobStatusText({ state: "running", total: 5, done: 4, failed: 0, startedAt: now - 60000 }, "rewrite", now)));
});

test("the progress bar always shows a sliver and never overflows", function () {
  assert.strictEqual(k.jobFraction({ total: 0 }), 0.05);
  assert.strictEqual(k.jobFraction({ total: 4, done: 0, failed: 0 }), 0.05);
  assert.strictEqual(k.jobFraction({ total: 4, done: 2, failed: 0 }), 0.5);
  assert.strictEqual(k.jobFraction({ total: 4, done: 3, failed: 2 }), 1);
});

test("polling is quick at first and slower once settled or only queued", function () {
  assert.strictEqual(k.pollDelayMs(1, "running"), 2000);
  assert.strictEqual(k.pollDelayMs(10, "running"), 4000);
  assert.strictEqual(k.pollDelayMs(1, "queued"), 5000);
});

console.log("\n" + passed + " passed");
