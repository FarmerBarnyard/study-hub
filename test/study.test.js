// Coverage for study.js's pure helpers (the link the person types, what to say when the server
// refuses, how a stored lab is cleaned before it is drawn, readiness, the quiz and flashcard logic,
// the Markdown saved to the notebook) and for how the page is wired.
//
//   node test/study.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var S = require(path.join(__dirname, "..", "study.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("a typed link becomes an https address, or nothing", function () {
  assert.strictEqual(S.normalizeLink("https://learn.microsoft.com/training/modules/x/"), "https://learn.microsoft.com/training/modules/x/");
  assert.strictEqual(S.normalizeLink("  learn.microsoft.com/en-us/training/modules/x  "), "https://learn.microsoft.com/en-us/training/modules/x");
  assert.strictEqual(S.normalizeLink("http://learn.microsoft.com/x"), "");
  assert.strictEqual(S.normalizeLink("javascript:alert(1)"), "");
  assert.strictEqual(S.normalizeLink("two words"), "");
  assert.strictEqual(S.normalizeLink("localhost"), "");
  assert.strictEqual(S.normalizeLink(""), "");
  assert.strictEqual(S.normalizeLink(null), "");
  assert.strictEqual(S.normalizeLink("https://learn.microsoft.com/" + new Array(520).join("a")), "");
});

test("each refusal is said in plain words, and only a missing login offers the log in button", function () {
  assert.deepStrictEqual(S.errorText(null, 401), { text: "Log in to make a study lab.", login: true });
  assert.match(S.errorText("host_not_allowed", 400).text, /isn’t on the list/);
  assert.match(S.errorText("daily_limit", 429).text, /today’s allowance/);
  assert.match(S.errorText("disabled", 410).text, /switched off/);
  assert.match(S.errorText("source_too_thin", 422).text, /summary page/);
  assert.strictEqual(S.errorText("recent_sign_in_required", 403).login, true);
  assert.strictEqual(S.errorText("host_not_allowed", 400).login, false);
  assert.match(S.errorText(null, 403).text, /isn’t set up for Study/);
  assert.match(S.errorText(null, 0).text, /reach the server/);
  assert.strictEqual(S.errorText("<script>", 500).text, "That didn’t work. Try again.", "server text is never shown");
});

var RAW = {
  id: "0123abcd", title: "Describe Azure architecture", url: "https://learn.microsoft.com/x", host: "learn.microsoft.com", pages: 4, truncated: false, at: 5, failed: [],
  notes: [{ heading: "Regions", items: ["A region is a set of datacenters", "Pairs are 300 miles apart"] }, { heading: "Groups", items: ["One group per resource"] }],
  quiz: [0, 1, 2, 3].map(function (n) { return { question: "Q" + n, choices: ["a", "b", "c", "d"], answer: n % 4, why: "because " + n }; }),
  flashcards: [{ front: "Region?", back: "Datacenters" }, { front: "AZ?", back: "Separate datacenter" }, { front: "Pair?", back: "Two regions" }],
  traps: [{ mistake: "Global admin", fix: "Use the narrowest role" }],
  checklist: [{ heading: "Week 1", items: ["Explain regions", "Create a group"] }, { heading: "Week 2", items: ["Assign a role"] }],
  labs: [{ title: "Create a group", objective: "Make a group", minutes: 20, needs: ["Entra ID Free", "User Administrator"], steps: [{ text: "Sign in to the Entra admin center", check: "You see the dashboard" }, { text: "Open Groups > All groups" }, { text: "Select New group", check: "" }], cleanup: "Delete the group", exam: "Group management" }],
  notes_parts: { 1: true, 3: true }
};

test("a stored or returned lab is cleaned before it is drawn: odd shapes are dropped, never trusted", function () {
  var set = S.cleanSet(RAW);
  assert.strictEqual(set.title, "Describe Azure architecture");
  assert.strictEqual(set.notes.length, 2);
  assert.strictEqual(set.quiz.length, 4);
  assert.strictEqual(S.cleanSet(null), null);
  assert.strictEqual(S.cleanSet({}), null);
  assert.strictEqual(S.cleanSet(Object.assign({}, RAW, { id: "../../x" })), null, "the id is a short hex string");
  assert.strictEqual(S.cleanSet({ id: "0123abcd", title: "T" }), null, "a lab with nothing in it is not a lab");
  var dirty = S.cleanSet(Object.assign({}, RAW, {
    url: "javascript:alert(1)", title: "T\u0000itle",
    quiz: [{ question: "ok", choices: ["a", "b", "c", "d"], answer: 9, why: "" }, { question: "ok", choices: ["a", "b", "c"], answer: 0 }, { question: "good", choices: ["a", "b", "c", "d"], answer: 2, why: "w" }, "x", null],
    notes: [{ heading: "H", items: [] }, { heading: "", items: ["x"] }, { heading: "<img onerror=x>", items: ["<b>bold</b>"] }],
    failed: ["quiz", "<script>"]
  }));
  assert.strictEqual(dirty.url, "", "only https links are kept");
  assert.strictEqual(dirty.title, "T itle");
  assert.deepStrictEqual(dirty.quiz.map(function (q) { return q.question; }), ["good"]);
  assert.strictEqual(dirty.notes[0].heading, "<img onerror=x>", "text is kept as text, to be shown with textContent");
  assert.deepStrictEqual(dirty.failed, ["quiz"]);
});

test("stored progress is cleaned too", function () {
  assert.deepStrictEqual(S.cleanProgress(null), S.emptyProgress());
  var p = S.cleanProgress({ notes: { 0: true, 1: false, "x y": true }, known: { 2: true }, check: { "0:1": true, "<b>": true }, best: { pct: 80, right: 8, total: 10 }, tab: "quiz" });
  assert.deepStrictEqual(p.notes, { 0: true });
  assert.deepStrictEqual(p.check, { "0:1": true });
  assert.deepStrictEqual(p.best, { pct: 80, right: 8, total: 10 });
  assert.strictEqual(p.tab, "quiz");
  assert.strictEqual(S.cleanProgress({ best: { pct: 500, right: 1, total: 1 }, tab: "evil" }).best, null);
  assert.strictEqual(S.cleanProgress({ tab: "evil" }).tab, "overview");
});

test("readiness counts each part that exists, by its weight", function () {
  var set = S.cleanSet(RAW), p = S.emptyProgress();
  var r0 = S.readiness(set, p);
  assert.strictEqual(r0.pct, 0);
  assert.deepStrictEqual(r0.parts.map(function (x) { return x.text; }), ["Notes 0/2", "Lab steps 0/3", "Quiz best —", "Cards 0/3 known", "Checklist 0/3"]);
  p.notes = { 0: true, 1: true }; p.best = { pct: 100, right: 4, total: 4 }; p.known = { 0: true, 1: true, 2: true }; p.check = { "0:0": true, "0:1": true, "1:0": true }; p.labs = { "0:0": true, "0:1": true, "0:2": true };
  assert.strictEqual(S.readiness(set, p).pct, 100);
  p.known = {}; p.check = {}; p.labs = {};
  assert.strictEqual(S.readiness(set, p).pct, 50, "notes (25) and quiz (25) done, the rest not");
  var notesOnly = S.cleanSet({ id: "0123abcd", title: "T", notes: RAW.notes });
  assert.strictEqual(S.readiness(notesOnly, { notes: { 0: true }, known: {}, check: {}, best: null }).pct, 50, "only the parts that were made count");
});

test("the tab rail has an overview and one tab for each kind that was made", function () {
  assert.deepStrictEqual(S.tabsFor(S.cleanSet(RAW)).map(function (t) { return t.key; }), ["overview", "notes", "labs", "quiz", "flashcards", "traps", "checklist"]);
  assert.deepStrictEqual(S.tabsFor(S.cleanSet({ id: "0123abcd", title: "T", quiz: RAW.quiz })).map(function (t) { return t.key; }), ["overview", "quiz"]);
});

test("shuffling keeps every card once; the card list can show only those still being learned", function () {
  var order = S.shuffled(10, function () { return 0.3; });
  assert.deepStrictEqual(order.slice().sort(function (a, b) { return a - b; }), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepStrictEqual(S.cardList([2, 0, 1], { 0: true }, true), [2, 1]);
  assert.deepStrictEqual(S.cardList([2, 0, 1], { 0: true }, false), [2, 0, 1]);
});

test("a quiz run is scored in the order the questions were asked", function () {
  var qs = S.cleanSet(RAW).quiz;                       // answers 0,1,2,3
  var o = S.quizOutcome(qs, [3, 2, 1, 0], [3, 2, 0, null]);
  assert.deepStrictEqual(o, { right: 2, total: 4, pct: 50 });
  assert.strictEqual(S.verdict(90), "ready on this set");
  assert.strictEqual(S.verdict(75), "close: review the misses");
  assert.strictEqual(S.verdict(40), "keep studying the notes");
  assert.deepStrictEqual(S.quizOutcome(qs, [], []), { right: 0, total: 0, pct: 0 });
});

test("the saved note holds every kind that was made", function () {
  var md = S.toMarkdown(S.cleanSet(RAW));
  assert.match(md, /^# Describe Azure architecture\n\nSource: https:\/\/learn\.microsoft\.com\/x\n/);
  assert.match(md, /## Notes\n\n### Regions\n\n- A region is a set of datacenters/);
  assert.match(md, /## Flashcards\n\n- \*\*Region\?\*\* — Datacenters/);
  assert.match(md, /## Practice questions\n\n1\. Q0\n   - a\) a\n/);
  assert.match(md, /   - \*\*Answer: a\.\*\* because 0/);
  assert.match(md, /## Traps\n\n- \*\*Global admin\*\* — Use the narrowest role/);
  assert.match(md, /## Checklist\n\n### Week 1\n\n- \[ \] Explain regions\n- \[ \] Create a group/);
  var notesOnly = S.toMarkdown(S.cleanSet({ id: "0123abcd", title: "T", notes: RAW.notes }));
  assert.ok(notesOnly.indexOf("## Flashcards") === -1 && notesOnly.indexOf("Source:") === -1);
});

test("the source line says where it came from and what could not be made", function () {
  assert.strictEqual(S.sourceLine({ host: "learn.microsoft.com", pages: 4, truncated: true, failed: [] }), "From learn.microsoft.com · 4 pages read · only the start of a long page was used");
  assert.strictEqual(S.sourceLine({ host: "docs.aws.amazon.com", pages: 1, failed: ["quiz", "traps"] }), "From docs.aws.amazon.com · couldn’t make quiz, traps");
  assert.strictEqual(S.sourceLine({ pages: 1, failed: [] }), "");
});

test("a module's units are read teaching units first, and a big course is covered module by module", function () {
  var m1 = ["a/1-introduction/", "a/2-x/", "a/3-y/", "a/4-z/"], m2 = ["b/1-introduction/", "b/2-p/"], m3 = [];
  assert.deepStrictEqual(S.unitOrder(m1), ["a/2-x/", "a/3-y/", "a/4-z/", "a/1-introduction/"]);
  assert.deepStrictEqual(S.unitOrder(null), []);
  assert.deepStrictEqual(S.interleaveUnits([m1, m2, m3], 60, 5), ["a/2-x/", "b/2-p/", "a/3-y/", "b/1-introduction/", "a/4-z/", "a/1-introduction/"], "the first of every module, then the second of every module, ...");
  assert.deepStrictEqual(S.interleaveUnits([m1, m2], 3, 5), ["a/2-x/", "b/2-p/", "a/3-y/"], "when the room runs out every module has had its turn");
  assert.deepStrictEqual(S.interleaveUnits([m1, m2], 60, 1), ["a/2-x/", "b/2-p/"], "and no module gives more than its limit");
  assert.deepStrictEqual(S.interleaveUnits([m1, m1], 60, 5).length, 4, "no repeats");
  assert.deepStrictEqual(S.interleaveUnits(null, 5, 5), []);
});

test("every reason a part can fail for has a plain sentence, and only the ones that doom every part stop the rest", function () {
  ["rate_limited", "busy", "auth", "credit", "model", "too_long", "cut_off", "bad_output", "timeout", "unreachable", "bad_request"].forEach(function (r) {
    assert.ok(S.reasonText(r).length > 20, r);
    assert.ok(!/undefined|\[object/.test(S.reasonText(r)), r);
  });
  assert.match(S.reasonText("credit"), /out of credit/);
  assert.match(S.reasonText("rate_limited"), /minute/);
  assert.match(S.reasonText("auth"), /ANTHROPIC_API_KEY/);
  assert.strictEqual(S.reasonText("<script>"), "Claude couldn’t write that part. Try again.", "an unknown reason is never shown as it came");
  ["auth", "credit", "model", "too_long", "bad_request"].forEach(function (r) { assert.strictEqual(S.FATAL_REASONS[r], true, r); });
  ["rate_limited", "busy", "cut_off", "bad_output", "timeout", "unreachable"].forEach(function (r) { assert.ok(!S.FATAL_REASONS[r], r); });
});

test("hands-on labs are cleaned, counted in readiness, and saved with the lab as Markdown", function () {
  var set = S.cleanSet(RAW);
  assert.strictEqual(set.labs.length, 1);
  assert.deepStrictEqual(set.labs[0].steps[0], { text: "Sign in to the Entra admin center", check: "You see the dashboard" });
  assert.strictEqual(set.labs[0].minutes, 20);
  assert.strictEqual(S.labStepsTotal(set), 3);
  var bad = S.cleanSet(Object.assign({}, RAW, { labs: [{ title: "Two steps", steps: [{ text: "a" }, { text: "b" }] }, { title: "", steps: [{ text: "a" }, { text: "b" }, { text: "c" }] }, null, { title: "Ok", minutes: 99999, needs: "x", steps: [{ text: "a" }, { text: "b" }, { text: "c" }, { nope: 1 }] }] }));
  assert.deepStrictEqual(bad.labs.map(function (l) { return [l.title, l.minutes, l.needs.length, l.steps.length]; }), [["Ok", 0, 0, 3]], "a lab needs a title and at least three steps");
  var p = S.emptyProgress(); p.labs = { "0:0": true, "0:1": true, "<b>": true };
  assert.deepStrictEqual(S.cleanProgress(p).labs, { "0:0": true, "0:1": true });
  var r = S.readiness(set, S.cleanProgress(p));
  assert.ok(r.parts.some(function (x) { return x.key === "labs" && x.text === "Lab steps 2/3"; }));
  var md = S.toMarkdown(set);
  assert.match(md, /## Hands-on labs\n\n### Create a group \(about 20 minutes\)\n\nMake a group\n\n\*\*You need:\*\*\n\n- Entra ID Free\n- User Administrator\n\n1\. Sign in to the Entra admin center \*\(You should see: You see the dashboard\)\*\n2\. Open Groups > All groups\n3\. Select New group/);
  assert.match(md, /\*\*Clean up:\*\* Delete the group/);
  assert.match(md, /\*\*Why it matters for the exam:\*\* Group management/);
  assert.deepStrictEqual(S.tabsFor(set).map(function (t) { return t.key; }).slice(0, 3), ["overview", "notes", "labs"]);
});

test("the notes come in three passes: the page asks for each, and knows which a lab is missing", function () {
  assert.deepStrictEqual(S.writeTasks(["notes", "quiz", "traps", "labs"]).map(function (t) { return t.key; }), ["traps", "labs", "quiz", "notes:1", "notes:2", "notes:3"], "the smallest part first, the notes last");
  assert.deepStrictEqual(S.writeTasks(["notes"]).map(function (t) { return t.part; }), [1, 2, 3]);
  assert.deepStrictEqual(S.writeTasks(["flashcards"]), [{ key: "flashcards", kind: "flashcards", part: 1 }]);
  assert.deepStrictEqual(S.writeTasks([]), []);
  assert.deepStrictEqual(S.missingNoteParts(S.cleanSet(RAW)), [2], "passes 1 and 3 exist, pass 2 does not");
  assert.deepStrictEqual(S.missingNoteParts(S.cleanSet({ id: "0123abcd", title: "T", quiz: RAW.quiz })), [1, 2, 3], "no notes at all");
  assert.deepStrictEqual(S.missingNoteParts(S.cleanSet({ id: "0123abcd", title: "T", notes: RAW.notes })), [], "an older lab with notes counts as complete");
  assert.deepStrictEqual(S.missingKinds(S.cleanSet({ id: "0123abcd", title: "T", notes: RAW.notes })), ["labs", "quiz", "flashcards", "traps", "checklist"], "notes are handled by their passes");
});

test("a module's exercises are read first, then the teaching units, the introduction last", function () {
  var u = ["m/1-introduction/", "m/2-explain/", "m/3-exercise-create-group/", "m/4-more/", "m/5-exercise-assign-roles/"];
  assert.deepStrictEqual(S.unitOrder(u), ["m/3-exercise-create-group/", "m/5-exercise-assign-roles/", "m/2-explain/", "m/4-more/", "m/1-introduction/"]);
});

test("a lab says which parts it does not have yet", function () {
  assert.deepStrictEqual(S.missingKinds(S.cleanSet(RAW)), []);
  assert.deepStrictEqual(S.missingKinds(S.cleanSet({ id: "0123abcd", title: "T", notes: RAW.notes, traps: RAW.traps })), ["labs", "quiz", "flashcards", "checklist"]);
});

test("a lab is made in steps: plan, read pages, write each part, then open the saved lab", function () {
  var js = fs.readFileSync(path.join(__dirname, "..", "study.js"), "utf8").replace(/\/\/.*$/gm, "");
  ["/study/plan", "/study/page", "/study/make", "/notebook/lab?id="].forEach(function (r) { assert.ok(js.indexOf(r) > -1, r); });
  assert.ok(js.indexOf("/study/generate") === -1, "the one-shot route is gone");
  assert.ok(/interleaveUnits/.test(js) && /text_budget/.test(js), "a course is covered evenly and reading stops when the lab is full");
  assert.ok(/READ_AT_ONCE/.test(js) && /MAKE_TIMEOUT_MS/.test(js), "pages are read a few at a time; a part may take minutes");
  assert.ok(/retryKind/.test(js), "a part that failed can be written again");
  assert.ok(/pool\(tasks\.slice\(1\), 3\)/.test(js), "no more than three parts are written at once");
  assert.ok(/"traps", "checklist", "flashcards", "labs", "quiz", "notes"/.test(js), "the smallest part goes first so the others can read the cached source");
  assert.match(S.errorText("source_too_thin", 422).text, /summary page/);
  assert.match(S.errorText("source_expired", 404).text, /Generate it again/);
});

test("labs and progress live on the server: no browser storage, only the notebook's lab routes", function () {
  var js = fs.readFileSync(path.join(__dirname, "..", "study.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(js), "nothing is kept in the browser");
  ["/notebook/labs", "/notebook/lab?id=", "/notebook/lab-progress"].forEach(function (route) { assert.ok(js.indexOf(route) > -1, route); });
  assert.ok(/method[^;]*"DELETE"|"DELETE", "\/notebook\/lab/.test(js), "a lab can be deleted");
  assert.ok(/keepalive/.test(js), "progress is sent as the page is closed");
  assert.ok(/labs_full/.test(js), "a library that is full says so");
  assert.strictEqual(typeof S.hashId, "undefined");
  assert.strictEqual(typeof S.libraryAdd, "undefined");
});

test("the page is wired: strict CSP, no inline script or style, no innerHTML, and every control the script needs exists", function () {
  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  var js = fs.readFileSync(path.join(__dirname, "..", "study.js"), "utf8");
  assert.match(html, /Content-Security-Policy[^>]*default-src 'self'[^>]*connect-src 'self' https:\/\/api\.barnyard\.site/);
  assert.ok(!/unsafe-inline/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline script");
  assert.ok(!/\sstyle="/i.test(html), "no inline style");
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|outerHTML/.test(js.replace(/\/\/.*$/gm, "")), "model-written text only goes in as text");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(js), "styles are set through the style object, which the CSP allows");
  var ids = js.match(/\$\("([a-z-]+)"\)/g).map(function (m) { return m.slice(3, -2); });
  ids.filter(function (id) { return id !== "sl-flip"; }).forEach(function (id) { assert.ok(html.indexOf('id="' + id + '"') > -1, "index.html has #" + id); });   // (#sl-flip is made by the script, for each card)
  assert.ok(html.indexOf('data-shell="study"') > -1);
  assert.ok(html.indexOf("certifications.html") > -1, "the old certification list is still one click away");
});

test("the certification list and the notes each have a page of their own, with the right tab lit", function () {
  var certs = fs.readFileSync(path.join(__dirname, "..", "certifications.html"), "utf8");
  var notes = fs.readFileSync(path.join(__dirname, "..", "notes.html"), "utf8");
  assert.ok(certs.indexOf('id="ongoing-list"') > -1 && certs.indexOf("app.js") > -1);
  assert.ok(certs.indexOf('data-shell="study"') > -1);
  assert.ok(notes.indexOf('data-shell="notes"') > -1);
});

console.log("\n" + passed + " passed");
