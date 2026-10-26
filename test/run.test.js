// Tests for the pure helpers in run.js (the public run-link page) and the run-link helpers in kb.js.
//   node test/run.test.js

var assert = require("assert");
var path = require("path");
var r = require(path.join(__dirname, "..", "run.js"));
var k = require(path.join(__dirname, "..", "kb.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var TOKEN = "rl_" + "A1b2C3d4".repeat(4);

test("the token comes only from the address fragment, and only when it is the right shape", function () {
  assert.strictEqual(r.tokenFromHash("#" + TOKEN), TOKEN);
  assert.strictEqual(r.tokenFromHash(TOKEN), TOKEN);
  assert.strictEqual(r.tokenFromHash("#rl_short"), null);
  assert.strictEqual(r.tokenFromHash("#" + TOKEN + "x"), null);
  assert.strictEqual(r.tokenFromHash("#/a/ka_abcd1234"), null);
  assert.strictEqual(r.tokenFromHash(""), null);
});

var plan = [
  { t: "h", level: 2, text: "Phase 1" },
  { t: "step", id: "s1", text: "Do the first thing", depth: 0 },
  { t: "step", id: "s2", text: "Do the second thing", depth: 0 },
  { t: "email", id: "e1", name: "Notice", to: "all@{{domain}}", subject: "Moving on {{cutover date}}", body: "Hi,\n\nOn {{ cutover date }} we move. Ask {{contact}}." },
  { t: "step", id: "s3", text: "Third", depth: 1 },
];

test("placeholders are found once each, in the order first used, and spacing inside the braces does not matter", function () {
  assert.deepStrictEqual(r.fieldsOf(plan), ["domain", "cutover date", "contact"]);
  assert.deepStrictEqual(r.fieldsOf([{ t: "step", id: "s1", text: "{{not an email}}" }]), []);
});

test("templates are filled from the details; what is still empty stays visible as {{name}}", function () {
  var f = { "cutover date": "Friday 7 November", domain: "example.org" };
  assert.strictEqual(r.fillTemplate("Moving on {{cutover date}}", f), "Moving on Friday 7 November");
  assert.strictEqual(r.fillTemplate("On {{  cutover date  }} ask {{contact}}", f), "On Friday 7 November ask {{contact}}");
  assert.strictEqual(r.fillTemplate("{{domain}}", { domain: "" }), "{{domain}}");
  assert.deepStrictEqual(r.missingFor(plan[3], f), ["contact"]);
  assert.deepStrictEqual(r.missingFor(plan[3], { domain: "a", "cutover date": "b", contact: "c" }), []);
});

test("the mail link is built from the filled email, and left out when it is too long or the address is unusable", function () {
  var f = { "cutover date": "7 Nov", domain: "example.org", contact: "Jane" };
  var u = r.mailtoUrl(plan[3], f);
  assert.ok(u.indexOf("mailto:all%40example.org?subject=") === 0, u);
  assert.ok(u.indexOf(encodeURIComponent("Moving on 7 Nov")) !== -1);
  assert.ok(u.indexOf("%0D%0A%0D%0A") !== -1, "line breaks become CRLF");
  var unfilled = r.mailtoUrl(plan[3], {});
  assert.ok(unfilled.indexOf("mailto:?subject=") === 0, "an address that still has {{domain}} in it is dropped, not sent wrong");
  var huge = { t: "email", name: "x", to: "", subject: "s", body: "word ".repeat(600) };
  assert.strictEqual(r.mailtoUrl(huge, {}), null);
});

test("progress counts ticked steps only", function () {
  assert.deepStrictEqual(r.progress(plan, {}), { done: 0, total: 3, pct: 0 });
  assert.deepStrictEqual(r.progress(plan, { s1: { d: 5 }, s2: { d: 0, n: "note only" }, s3: { d: 9 } }), { done: 2, total: 3, pct: 67 });
  assert.deepStrictEqual(r.progress([], {}), { done: 0, total: 0, pct: 0 });
  assert.strictEqual(r.stepsOf(plan).length, 3);
});

test("wording: expiry, errors", function () {
  var now = 1000000000000;
  assert.strictEqual(r.expiryText(null, now), "This link does not expire; whoever prepared it can switch it off.");
  assert.strictEqual(r.expiryText(now - 1, now), "This link has expired.");
  assert.strictEqual(r.expiryText(now + 3 * 3600000, now), "This link works for another 3 hours.");
  assert.strictEqual(r.expiryText(now + 60000, now), "This link works for another 1 hour.");
  assert.strictEqual(r.expiryText(now + 5 * 86400000, now), "This link works for another 5 days.");
  assert.ok(/switched off/.test(r.errorText("run_revoked")));
  assert.ok(/expired/.test(r.errorText("run_expired")));
  assert.ok(/valid/.test(r.errorText("not_found")));
  assert.ok(/reach the server/.test(r.errorText(undefined, 0)));
  assert.ok(r.FATAL.not_found && r.FATAL.run_revoked && r.FATAL.run_expired && !r.FATAL.rate_limited);
});

test("which articles get a Run links button, and the link a person is handed", function () {
  assert.strictEqual(k.isSop({ title: "SOP: Migrating", tags: [], category: "other" }), true);
  assert.strictEqual(k.isSop({ title: "Rotate keys", tags: ["SOP"], category: "other" }), true);
  assert.strictEqual(k.isSop({ title: "Rotate keys", tags: [], category: "runbooks" }), true);
  assert.strictEqual(k.isSop({ title: "SC-300 notes", tags: ["azure"], category: "certifications" }), false);
  assert.strictEqual(k.runLinkUrl("https://study.barnyard.site/", TOKEN), "https://study.barnyard.site/run.html#" + TOKEN);
});

test("run lines say how far along, and for how long", function () {
  var now = 1000000000000;
  assert.strictEqual(k.runLine({ status: "live", done: 3, steps: 10, expiresAt: now + 6 * 86400000 }, now), "Live · 3 of 10 steps · works for 6 more days");
  assert.strictEqual(k.runLine({ status: "live", done: 10, steps: 10, completedAt: now, expiresAt: null }, now), "Complete · 10 of 10 steps · does not expire");
  assert.strictEqual(k.runLine({ status: "revoked", done: 1, steps: 10, expiresAt: null }, now), "Switched off · 1 of 10 steps");
  assert.strictEqual(k.runLine({ status: "expired", done: 1, steps: 10, expiresAt: now - 5 }, now), "Expired · 1 of 10 steps");
  assert.ok(/```email/.test(k.EMAIL_TEMPLATE) && /\{\{date\}\}/.test(k.EMAIL_TEMPLATE));
});

test("the send box counts addresses the way the Worker will, without repeats", function () {
  assert.strictEqual(r.countAddresses(""), 0);
  assert.strictEqual(r.countAddresses("a@x.org"), 1);
  assert.strictEqual(r.countAddresses("a@x.org, B@x.org; a@X.org\n c@y.org"), 3);
  assert.strictEqual(r.countAddresses(" , ;; "), 0);
});

test("send failures are explained in plain words and never repeat what the server said", function () {
  assert.ok(/Fill in these details first: contact, domain\./.test(r.sendErrorText("details_missing", { details: ["contact", "domain"] })));
  assert.ok(/refused to send from that mailbox/.test(r.sendErrorText("send_failed", { reason: "forbidden" })));
  assert.ok(/secret may have expired/.test(r.sendErrorText("send_failed", { reason: "auth" })));
  assert.ok(/recent sign-in/.test(r.sendErrorText("recent_sign_in_required")));
  assert.ok(/more than 25/.test(r.sendErrorText("too_many_recipients")));
  assert.ok(/reach the server/.test(r.sendErrorText(undefined, {}, 0)));
  assert.ok(!/AADSTS|stack/.test(r.sendErrorText("send_failed", { reason: "weird", message: "AADSTS70011" })));
});

console.log(passed + " passed");
