// Coverage for study.js's pure helpers (the link the person types, what to say when the server
// refuses, the quiz score, the Markdown saved to the notebook) and for how the page is wired.
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
  assert.deepStrictEqual(S.errorText(null, 401), { text: "Log in to make revision material.", login: true });
  assert.match(S.errorText("host_not_allowed", 400).text, /isn’t on the list/);
  assert.match(S.errorText("daily_limit", 429).text, /today’s allowance/);
  assert.match(S.errorText("disabled", 410).text, /switched off/);
  assert.match(S.errorText("source_too_thin", 422).text, /not enough text/);
  assert.strictEqual(S.errorText("recent_sign_in_required", 403).login, true);
  assert.strictEqual(S.errorText("host_not_allowed", 400).login, false);
  assert.match(S.errorText(null, 403).text, /isn’t set up for Study/);
  assert.match(S.errorText(null, 0).text, /reach the server/);
  assert.strictEqual(S.errorText("<script>", 500).text, "That didn’t work. Try again.", "server text is never shown");
});

test("the quiz score counts only what was answered", function () {
  var qs = [{ answer: 0 }, { answer: 2 }, { answer: 3 }];
  assert.deepStrictEqual(S.scoreQuiz(qs, {}), { answered: 0, correct: 0, total: 3 });
  assert.deepStrictEqual(S.scoreQuiz(qs, { 0: 0, 1: 1 }), { answered: 2, correct: 1, total: 3 });
  assert.strictEqual(S.scoreText(S.scoreQuiz(qs, {})), "Pick an answer for each question.");
  assert.strictEqual(S.scoreText(S.scoreQuiz(qs, { 0: 0, 1: 1 })), "1 of 2 correct so far (3 questions).");
  assert.strictEqual(S.scoreText(S.scoreQuiz(qs, { 0: 0, 1: 2, 2: 3 })), "3 of 3 correct.");
});

var RESULT = {
  title: "Describe Azure architecture",
  source: { host: "learn.microsoft.com", pages: 4, truncated: true },
  notes: [{ heading: "Regions", items: ["A region is a set of datacenters", "Pairs are 300 miles apart"] }],
  flashcards: [{ front: "Region?", back: "Datacenters in a perimeter" }],
  quiz: [{ question: "Which is a region pair?", choices: ["East/West", "A/B", "C/D", "E/F"], answer: 0, why: "Pairs are in the same geography." }],
  failed: []
};

test("the saved note holds every kind that was made, with the answers marked", function () {
  var md = S.toMarkdown(RESULT, "https://learn.microsoft.com/x");
  assert.match(md, /^# Describe Azure architecture\n\nSource: https:\/\/learn\.microsoft\.com\/x\n/);
  assert.match(md, /## Notes\n\n### Regions\n\n- A region is a set of datacenters\n- Pairs are 300 miles apart/);
  assert.match(md, /## Flashcards\n\n- \*\*Region\?\*\* — Datacenters in a perimeter/);
  assert.match(md, /## Practice questions\n\n1\. Which is a region pair\?\n   - a\) East\/West\n   - b\) A\/B/);
  assert.match(md, /   - \*\*Answer: a\.\*\* Pairs are in the same geography\./);
  var onlyNotes = S.toMarkdown({ title: "T", notes: RESULT.notes }, "");
  assert.ok(onlyNotes.indexOf("## Flashcards") === -1 && onlyNotes.indexOf("Source:") === -1);
});

test("the source line says where it came from and what could not be made", function () {
  assert.strictEqual(S.sourceLine(RESULT), "From learn.microsoft.com · 4 pages read · only the start of a long page was used");
  assert.strictEqual(S.sourceLine({ source: { host: "docs.aws.amazon.com", pages: 1 }, failed: ["quiz", "flashcards"] }), "From docs.aws.amazon.com · couldn’t make practice questions or flashcards");
  assert.strictEqual(S.sourceLine({}), "");
});

test("the page is wired: strict CSP, no inline script or style, no innerHTML, and every control the script needs exists", function () {
  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  var js = fs.readFileSync(path.join(__dirname, "..", "study.js"), "utf8");
  assert.match(html, /Content-Security-Policy[^>]*default-src 'self'[^>]*connect-src 'self' https:\/\/api\.barnyard\.site/);
  assert.ok(!/unsafe-inline/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline script");
  assert.ok(!/\sstyle="/i.test(html), "no inline style");
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(js.replace(/\/\/.*$/gm, "")), "model-written text only goes in as text");
  var ids = js.match(/\$\("([a-z-]+)"\)/g).map(function (m) { return m.slice(3, -2); });
  ids.forEach(function (id) { assert.ok(html.indexOf('id="' + id + '"') > -1, "index.html has #" + id); });
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
