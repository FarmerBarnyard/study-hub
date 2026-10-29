// A run link's page (run.html): the checklist of one run of a Standard Operating Procedure, shared by
// everyone who holds the link. There is NO login here on purpose -- the link (run.html#rl_...) is the
// credential, so the token lives in the address fragment (never sent to a server by the browser, never in a
// referrer) and is posted in the body to api.barnyard.site/run/* (see ClaudeRepo cloudflare-worker README,
// "Run links"). The page only ever asks for the three things the Worker allows: open the run, tick or untick a
// step (with a short note and a first name), and fill in a detail used by the email templates.
//
// What is shown comes from the snapshot taken when the link was made (headings, context, steps, email
// templates) and is drawn with markdown.js (DOM nodes only, no innerHTML), so nothing in a procedure or a
// note can inject script or style.
//
// Plain script, no build step. Under Node only the pure helpers are exported (for test/run.test.js); the page
// code runs when a `document` exists.
(function (root) {
  "use strict";

  var API = "https://api.barnyard.site/run";
  var POLL_MS = 15000;
  var SAVE_MS = 700;
  var NAME_KEY = "barnyard-run-name";
  var TOKEN = /^rl_[A-Za-z0-9_-]{32}$/;
  var PLACEHOLDER = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;
  var MAILTO_MAX = 1800;     // longer than this and "Open in email" is not offered (mail apps cut long links); Copy always works

  // ------------------------------------------------------------ pure helpers

  // "#rl_xxxxx" -> the token, or null.
  function tokenFromHash(hash) {
    var h = String(hash || "").replace(/^#/, "");
    return TOKEN.test(h) ? h : null;
  }

  function keyOf(raw) { return String(raw).replace(/\s+/g, " "); }

  // The distinct {{placeholders}} the plan's emails use, in order of first use.
  function fieldsOf(plan) {
    var out = [];
    (plan || []).forEach(function (b) {
      if (b.t !== "email") return;
      [b.to, b.subject, b.body].forEach(function (part) {
        String(part || "").replace(PLACEHOLDER, function (m, k) { k = keyOf(k); if (out.indexOf(k) === -1) out.push(k); return m; });
      });
    });
    return out;
  }

  // Put the filled-in details into a template text; a detail not yet filled stays as {{name}} so it is easy to spot.
  function fillTemplate(text, fields) {
    fields = fields || {};
    return String(text || "").replace(PLACEHOLDER, function (m, k) {
      k = keyOf(k);
      return Object.prototype.hasOwnProperty.call(fields, k) && fields[k] ? fields[k] : "{{" + k + "}}";
    });
  }

  // Details one email still needs.
  function missingFor(email, fields) {
    var need = fieldsOf([email]);
    return need.filter(function (k) { return !(fields && fields[k]); });
  }

  var ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
  // -> a mailto: link for the filled-in email, or null when it is too long or has an unusable address.
  function mailtoUrl(email, fields) {
    var to = fillTemplate(email.to, fields).split(/[,;]\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (to.some(function (a) { return !ADDRESS.test(a); })) to = [];
    var subject = fillTemplate(email.subject, fields);
    var body = fillTemplate(email.body, fields).replace(/\r?\n/g, "\r\n");
    var url = "mailto:" + to.map(encodeURIComponent).join(",") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    return url.length > MAILTO_MAX ? null : url;
  }

  function stepsOf(plan) { return (plan || []).filter(function (b) { return b.t === "step"; }); }

  // -> { done, total, pct }
  function progress(plan, state) {
    var steps = stepsOf(plan);
    var done = steps.filter(function (s) { return state && state[s.id] && state[s.id].d; }).length;
    return { done: done, total: steps.length, pct: steps.length ? Math.round(done / steps.length * 100) : 0 };
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function clock(ts) {
    if (!Number.isFinite(ts)) return "";
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes();
    return d.getDate() + " " + MONTHS[d.getMonth()] + ", " + (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  // "This link works until ..." / "...for another 3 days" / "does not expire".
  function expiryText(expiresAt, now) {
    if (expiresAt === null || expiresAt === undefined) return "This link does not expire; whoever prepared it can switch it off.";
    var left = expiresAt - (Number.isFinite(now) ? now : Date.now());
    if (left <= 0) return "This link has expired.";
    var hours = Math.ceil(left / 3600000);
    if (hours < 48) return "This link works for another " + hours + " hour" + (hours === 1 ? "" : "s") + ".";
    return "This link works for another " + Math.ceil(left / 86400000) + " days.";
  }

  var ERRORS = {
    not_found: "This link isn't valid. Check you copied all of it, or ask whoever sent it for a new one.",
    run_revoked: "This link has been switched off by whoever prepared it. Ask them for a new one.",
    run_expired: "This link has expired. Ask whoever prepared it for a new one.",
    rate_limited: "Too many changes at once. Wait a minute and try again.",
    secret_detected: "That looks like a password or key, which must not be written here.",
    step_invalid: "That step no longer exists in this run.",
    field_invalid: "That detail isn't used by this run's emails.",
  };
  function errorText(code, status) {
    if (ERRORS[code]) return ERRORS[code];
    if (status === 0) return "Couldn't reach the server. Check your connection.";
    return "Something went wrong. Try again in a moment.";
  }
  var FATAL = { not_found: 1, run_revoked: 1, run_expired: 1 };

  // ---- sending an email (the owner and people who may publish; the Worker: /kb/run/send) ----

  // How many addresses are in the box (split on commas, semicolons and line breaks, without repeats).
  function countAddresses(text) {
    var seen = {}, n = 0;
    String(text || "").split(/[,;\n]+/).forEach(function (p) {
      p = p.trim().toLowerCase();
      if (p && !seen[p]) { seen[p] = 1; n++; }
    });
    return n;
  }

  var SEND_FAILED = {
    forbidden: "Microsoft refused to send from that mailbox. Ask your admin to check the app's access to it.",
    auth: "Microsoft rejected the app's sign-in. The app's secret may have expired.",
    throttled: "Microsoft is limiting sends right now. Wait a few minutes and try again.",
    bad_request: "Microsoft didn't accept that email. Check the addresses.",
    unavailable: "Microsoft isn't answering. Try again in a moment.",
    not_configured: "Sending isn't set up yet.",
  };
  var SEND_ERRORS = {
    recent_sign_in_required: "For safety, sending needs a recent sign-in. Sign in to the study site again, then reload this page.",
    details_missing: "Fill in the details above first",
    no_recipients: "Add at least one address to send to.",
    recipient_invalid: "One of the addresses isn't valid.",
    too_many_recipients: "That's more than 25 addresses. Split it into two sends.",
    send_limit: "Today's sending allowance for everyone is used up. It starts again tomorrow.",
    already_sent: "This email was already sent.",
    send_not_configured: "Sending isn't set up yet.",
    run_revoked: "This link has been switched off.",
    run_expired: "This link has expired.",
    forbidden: "Only people who can publish in the Knowledgebase can send from here.",
    unauthenticated: "You are signed out. Sign in to the study site again, then reload this page.",
  };
  function sendErrorText(code, json, status) {
    json = json || {};
    if (code === "details_missing" && json.details && json.details.length) return "Fill in these details first: " + json.details.join(", ") + ".";
    if (code === "send_failed") return SEND_FAILED[json.reason] || "The email couldn't be sent. Try again in a moment.";
    if (code === "send_limit_person") {
      var left = typeof json.left === "number" ? json.left : 0;
      return "That would go over your own limit for today. " + (left > 0 ? "You can send to " + left + (left === 1 ? " more address" : " more addresses") + " today." : "You have no addresses left today.") + " It starts again tomorrow.";
    }
    if (SEND_ERRORS[code]) return SEND_ERRORS[code];
    if (status === 0) return "Couldn't reach the server. Check your connection.";
    return "The email couldn't be sent. Try again in a moment.";
  }

  var api = {
    countAddresses: countAddresses, sendErrorText: sendErrorText,
    tokenFromHash: tokenFromHash, fieldsOf: fieldsOf, fillTemplate: fillTemplate, missingFor: missingFor, mailtoUrl: mailtoUrl,
    stepsOf: stepsOf, progress: progress, expiryText: expiryText, errorText: errorText, clock: clock, FATAL: FATAL,
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  if (typeof document === "undefined") return;

  // ------------------------------------------------------------ the page

  var md = root.BarnyardMarkdown;
  var $ = function (id) { return document.getElementById(id); };
  function el(name, cls, parent, txt) {
    var e = document.createElement(name);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function btn(label, cls, parent, onclick) {
    var b = el("button", cls || "btn", parent, label);
    b.type = "button";
    if (onclick) b.addEventListener("click", onclick);
    return b;
  }

  var token = tokenFromHash(location.hash);
  var run = null;            // the last answer from the server
  var rows = {};             // step id -> { box, who, noteBtn, noteIn, noteShow }
  var fieldInputs = {};      // placeholder -> input
  var mailViews = [];        // [{ email, subj, to, body, hint, mail }]
  var saveTimers = {};
  var busy = 0;
  var pollTimer = null;

  function post(path, body) {
    body.token = token;
    return fetch(API + path, {
      method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j || {} }; });
    }, function () { return { status: 0, json: {} }; });
  }

  function say(text, bad) {
    var n = $("run-msg");
    n.textContent = text || "";
    n.hidden = !text;
    n.className = "run-msg" + (bad ? " run-bad" : "");
    if (text && !bad) setTimeout(function () { if (n.textContent === text) { n.hidden = true; } }, 2500);
  }

  function stop(message) {
    if (pollTimer) clearInterval(pollTimer);
    $("run").hidden = true;
    var g = $("run-gate");
    g.hidden = false;
    $("run-gate-msg").textContent = message;
  }

  function myName() {
    var v = $("run-name").value.trim();
    return v.slice(0, 40);
  }
  function loadName() {
    try { var v = root.localStorage.getItem(NAME_KEY); if (v) $("run-name").value = v.slice(0, 40); } catch (e) { /* private window: no memory, still works */ }
  }
  function saveName() { try { root.localStorage.setItem(NAME_KEY, myName()); } catch (e) { /* as above */ } }

  function copy(text, label) {
    function done(ok) { say(ok ? label + " copied" : "Couldn't copy. Select the text and copy it by hand.", !ok); }
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text; t.setAttribute("readonly", ""); t.className = "sr-only";
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      t.remove(); done(ok);
    }
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }

  function markdown(text, parent, cls) {
    var box = el("div", cls || "md", parent);
    box.appendChild(md.toDom(md.parse(text), document, {}));
    return box;
  }

  // ---- building the page once from the plan

  function build() {
    var plan = run.plan;
    var body = $("run-body");
    clear(body);
    rows = {}; mailViews = [];
    var n = 0;
    plan.forEach(function (b) {
      if (b.t === "h") {
        el(b.level <= 2 ? "h2" : "h3", "run-h", body, b.text);
      } else if (b.t === "md") {
        markdown(b.text, body, "md run-context");
      } else if (b.t === "step") {
        n++;
        var li = el("div", "run-step run-d" + (b.depth || 0), body);
        li.id = "step-" + b.id;
        var label = el("label", "run-check", li);
        var box = el("input", "", label);
        box.type = "checkbox";
        box.setAttribute("aria-label", "Step " + n);
        var text = el("span", "run-step-text", label);
        var tree = md.parse(b.text);
        text.appendChild(md.toDom(tree, document, {}));
        var meta = el("div", "run-step-meta", li);
        var who = el("span", "run-who", meta);
        var noteBtn = btn("Add note", "run-link", meta, null);
        var noteShow = el("span", "run-note", meta);
        var noteRow = el("div", "run-note-row", li);
        noteRow.hidden = true;
        var noteIn = el("input", "run-note-in", noteRow);
        noteIn.type = "text"; noteIn.maxLength = 300; noteIn.placeholder = "A short note for whoever does this next (no passwords)";
        noteIn.setAttribute("aria-label", "Note on step " + n);
        if (b.detail) {
          var det = el("details", "run-detail", li);
          det.open = true;
          el("summary", "", det, "Details");
          markdown(b.detail, det, "md");
        }
        box.addEventListener("change", function () { tick(b.id, box.checked, null); });
        noteBtn.addEventListener("click", function () { noteRow.hidden = !noteRow.hidden; if (!noteRow.hidden) noteIn.focus(); });
        function saveNote() { var cur = (run.state[b.id] && run.state[b.id].n) || ""; if (noteIn.value.trim() !== cur) tick(b.id, !!(run.state[b.id] && run.state[b.id].d), noteIn.value.trim()); }
        noteIn.addEventListener("blur", saveNote);
        noteIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); noteIn.blur(); } });
        rows[b.id] = { box: box, who: who, noteBtn: noteBtn, noteIn: noteIn, noteShow: noteShow, noteRow: noteRow, li: li };
      } else if (b.t === "email") {
        buildEmail(b, body);
      }
    });
  }

  function buildEmail(e, parent) {
    var card = el("section", "run-mail", parent);
    el("h3", "run-mail-name", card, "Email: " + e.name);
    var grid = el("dl", "run-mail-head", card);
    var to = e.to ? [el("dt", "", grid, "To"), el("dd", "", grid)][1] : null;
    el("dt", "", grid, "Subject");
    var subj = el("dd", "", grid);
    var pre = el("pre", "run-mail-body", card);
    var hint = el("p", "run-mail-hint", card);
    var tools = el("div", "run-mail-tools", card);
    var view = { email: e, to: to, subj: subj, pre: pre, hint: hint, open: null };
    btn("Copy subject", "btn", tools, function () { copy(fillTemplate(e.subject, liveFields()), "Subject"); });
    btn("Copy body", "btn", tools, function () { copy(fillTemplate(e.body, liveFields()), "Body"); });
    btn("Copy all", "btn", tools, function () { var f = liveFields(); copy((e.to ? "To: " + fillTemplate(e.to, f) + "\n" : "") + "Subject: " + fillTemplate(e.subject, f) + "\n\n" + fillTemplate(e.body, f), "Email"); });
    view.open = el("a", "btn run-mail-open", tools, "Open in email app");
    view.open.rel = "noopener";
    mailViews.push(view);
    buildSend(view, card);
  }

  // The Send panel under an email. Hidden for everyone else: it only appears once the Worker says this browser is
  // signed in as the owner or someone who may publish (checkSend). If the shared mailbox is not set up yet the panel
  // says so instead of offering a button.
  function buildSend(view, card) {
    var box = el("div", "run-send", card);
    box.hidden = true;
    var row = el("label", "run-send-to", box);
    el("span", "", row, "Send to");
    var to = el("input", "", row);
    to.type = "text"; to.maxLength = 1000; to.autocomplete = "off"; to.placeholder = "name@example.org, other@example.org";
    var acts = el("div", "run-send-acts", box);
    var go = btn("Send", "btn run-send-go", acts, null);
    var sure = el("span", "run-send-sure", acts);
    sure.hidden = true;
    var sureText = el("span", "", sure);
    var yes = btn("Send now", "btn run-send-yes", sure, null);
    var no = btn("Cancel", "btn", sure, function () { sure.hidden = true; go.hidden = false; });
    var status = el("p", "run-send-status", box);
    view.send = { box: box, to: to, go: go, status: status, edited: false, sending: false };
    to.addEventListener("input", function () { view.send.edited = true; });
    go.addEventListener("click", function () {
      var miss = missingFor({ t: "email", to: "", subject: view.email.subject, body: view.email.body }, liveFields());
      if (miss.length) { status.textContent = sendErrorText("details_missing", { details: miss }); status.className = "run-send-status run-bad"; return; }
      var n = countAddresses(to.value);
      if (!n) { status.textContent = sendErrorText("no_recipients"); status.className = "run-send-status run-bad"; return; }
      var again = !!(run.sent && run.sent[view.email.id]);
      sureText.textContent = (again ? "This was already sent. Send it again to " : "Send to ") + n + (n === 1 ? " address" : " addresses") + " from " + sendInfo.from + "? " + (sendInfo.perPerson > 0 ? "(You can send to up to " + sendInfo.perPerson + " addresses a day.) " : "");
      sure.hidden = false; go.hidden = true;
      yes.onclick = function () { sure.hidden = true; go.hidden = false; doSend(view, again); };
    });
  }

  var sendInfo = null;     // { from, perPerson } once the Worker says this browser may send and sending is set up

  function checkSend() {
    return fetch("https://api.barnyard.site/kb/run/send-status", { credentials: "include", cache: "no-store", referrerPolicy: "no-referrer" }).then(function (r) {
      if (r.status !== 200) return null;
      return r.json().catch(function () { return null; });
    }, function () { return null; }).then(function (j) {
      if (!j) return;
      if (!j.canSend) {
        // allowed to send, but the shared mailbox is not set up: say so rather than show nothing
        mailViews.forEach(function (v) {
          if (!v.send) return;
          v.send.box.hidden = false; v.send.go.hidden = true; v.send.to.parentNode.hidden = true;
          v.send.status.textContent = sendErrorText("send_not_configured") + " Ask the owner to set up the sending mailbox.";
          v.send.status.className = "run-send-status";
        });
        return;
      }
      sendInfo = { from: j.from, perPerson: typeof j.perPerson === "number" ? j.perPerson : 0 };
      mailViews.forEach(function (v) { if (v.send) v.send.box.hidden = false; });
      paintMail();
    });
  }

  function doSend(view, again) {
    var s = view.send;
    s.go.disabled = true;
    s.status.textContent = "Sending…"; s.status.className = "run-send-status";
    fetch("https://api.barnyard.site/kb/run/send", {
      method: "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, email: view.email.id, to: s.to.value, confirmResend: again }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j || {} }; });
    }, function () { return { status: 0, json: {} }; }).then(function (r) {
      s.go.disabled = false;
      if (r.status === 200 && r.json.ok) {
        run.sent = r.json.sent || run.sent;
        s.edited = false;
        paintMail();
        say("Email sent");
      } else {
        s.status.textContent = sendErrorText(r.json.error, r.json, r.status);
        s.status.className = "run-send-status run-bad";
      }
    });
  }

  function buildFields() {
    var names = fieldsOf(run.plan);
    var box = $("run-fields");
    clear(box);
    fieldInputs = {};
    $("run-fields-wrap").hidden = !names.length;
    names.forEach(function (k) {
      var row = el("label", "run-field", box);
      el("span", "", row, k);
      var inp = el("input", "", row);
      inp.type = "text"; inp.maxLength = 200; inp.autocomplete = "off";
      inp.addEventListener("input", function () {
        clearTimeout(saveTimers[k]);
        saveTimers[k] = setTimeout(function () { saveField(k, inp.value); }, SAVE_MS);
        paintMail();
      });
      inp.addEventListener("blur", function () { clearTimeout(saveTimers[k]); saveField(k, inp.value); });
      fieldInputs[k] = inp;
    });
  }

  // ---- painting the live state onto the page

  // The details as they are on screen right now (a box someone is still typing in counts), over what the server has.
  function liveFields() {
    var f = {};
    Object.keys(run.fields).forEach(function (k) { f[k] = run.fields[k]; });
    Object.keys(fieldInputs).forEach(function (k) { var v = fieldInputs[k].value.trim(); if (v) f[k] = v; else delete f[k]; });
    return f;
  }

  function paintMail() {
    var f = liveFields();
    mailViews.forEach(function (v) {
      if (v.to) v.to.textContent = fillTemplate(v.email.to, f);
      v.subj.textContent = fillTemplate(v.email.subject, f);
      v.pre.textContent = fillTemplate(v.email.body, f);
      var miss = missingFor(v.email, f);
      v.hint.textContent = miss.length ? "Still to fill in above: " + miss.join(", ") + "." : "";
      var href = mailtoUrl(v.email, f);
      if (href) { v.open.href = href; v.open.hidden = false; } else { v.open.removeAttribute("href"); v.open.hidden = true; }
      if (v.send && sendInfo) {
        var s = v.send;
        if (!s.edited && document.activeElement !== s.to) { var filled = fillTemplate(v.email.to, f); s.to.value = /\{\{/.test(filled) ? "" : filled; }
        var was = run.sent && run.sent[v.email.id];
        s.go.textContent = was ? "Send again from " + sendInfo.from : "Send from " + sendInfo.from;
        if (was) { s.status.textContent = "Sent " + clock(was.at) + " to " + was.n + (was.n === 1 ? " address" : " addresses") + (was.by ? " by " + was.by : "") + "."; s.status.className = "run-send-status run-ok"; }
        else if (s.status.className.indexOf("run-ok") !== -1) { s.status.textContent = ""; s.status.className = "run-send-status"; }
      }
    });
  }

  function paint() {
    var p = progress(run.plan, run.state);
    $("run-count").textContent = p.done + " of " + p.total + " steps done";
    $("run-bar").value = p.pct;
    $("run-bar").textContent = p.pct + "%";
    var complete = p.total > 0 && p.done === p.total;
    $("run-complete").hidden = !complete;
    $("run-complete").textContent = complete ? "Every step is done" + (run.completedAt ? " (" + clock(run.completedAt) + ")" : "") + "." : "";
    Object.keys(rows).forEach(function (id) {
      var r = rows[id], s = run.state[id];
      var done = !!(s && s.d);
      if (document.activeElement !== r.box) r.box.checked = done;
      r.li.classList.toggle("run-done", done);
      r.who.textContent = done ? "Done" + (s.by ? " by " + s.by : "") + ", " + clock(s.d) : "";
      var note = (s && s.n) || "";
      r.noteShow.textContent = note ? "Note: " + note : "";
      r.noteBtn.textContent = note ? "Edit note" : "Add note";
      if (document.activeElement !== r.noteIn) r.noteIn.value = note;
    });
    Object.keys(fieldInputs).forEach(function (k) { if (document.activeElement !== fieldInputs[k]) fieldInputs[k].value = run.fields[k] || ""; });
    paintMail();
    $("run-expiry").textContent = expiryText(run.expiresAt);
  }

  // ---- talking to the server

  function take(r, quiet) {
    if (r.status === 200 && r.json.ok) { run = r.json.run; run.fields = run.fields || {}; paint(); return true; }
    var code = r.json && r.json.error;
    if (FATAL[code]) { stop(errorText(code, r.status)); return false; }
    say(errorText(code, r.status), true);
    paint();   // put the page back to what the server last said
    return false;
  }

  function tick(id, done, note) {
    var change = { step: id, done: done, by: myName() };
    if (note !== null) change.note = note;
    busy++;
    post("/step", change).then(function (r) {
      busy--;
      if (busy > 0 && r.status === 200 && r.json.ok) { run = r.json.run; run.fields = run.fields || {}; return; }   // a later tick is still on its way: it will repaint
      take(r);
    });
  }
  function saveField(k, value) {
    var v = value.trim();
    if ((run.fields[k] || "") === v) return;
    busy++;
    post("/field", { key: k, value: v }).then(function (r) {
      busy--;
      if (r.status === 200 && r.json.ok) { run.fields = r.json.run.fields || {}; run.rev = r.json.run.rev; paintMail(); }
      else take(r);
    });
  }

  function poll() {
    if (document.hidden || busy) return;
    var a = document.activeElement;
    if (a && (a.tagName === "INPUT") && a.type === "text") return;   // never overwrite what someone is typing
    post("/open", {}).then(function (r) { if (!busy && r.status === 200 && r.json.ok && r.json.run.rev !== run.rev) take(r); else if (r.status !== 200) take(r); });
  }

  function start() {
    if (!token) { stop(errorText("not_found")); return; }
    $("run-gate").hidden = true;
    post("/open", {}).then(function (r) {
      if (!(r.status === 200 && r.json.ok)) { stop(errorText(r.json && r.json.error, r.status)); return; }
      run = r.json.run;
      run.fields = run.fields || {};
      document.title = run.title + " — run";
      $("run-title").textContent = run.title;
      $("run-label").textContent = run.label || "";
      $("run-label").hidden = !run.label;
      $("run-by").textContent = (run.by ? "Prepared by " + run.by + " on " : "Prepared on ") + clock(run.createdAt) + ".";
      build();
      buildFields();
      $("run").hidden = false;
      paint();
      checkSend();
      loadName();
      $("run-name").addEventListener("change", saveName);
      $("run-print").addEventListener("click", function () { root.print(); });
      pollTimer = setInterval(poll, POLL_MS);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
    });
  }

  start();
})(typeof window !== "undefined" ? window : this);
