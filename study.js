// Study page (index.html): a study lab made from a vendor link.
//
// The person pastes a link (a Microsoft Learn module or study guide, an AWS or Google Cloud doc, ...),
// picks what to make, and the page asks the Worker (POST /study/generate, see ClaudeRepo's
// cloudflare-worker README, "Study: revision material from a vendor link"). What comes back is
// opened as a lab: a readiness gauge, a tab rail (Overview, Notes, Quiz, Flashcards, Traps,
// Checklist), topics to tick off as studied, a one-question-at-a-time quiz with a score, flip cards
// marked known or still learning, and a final-week checklist. The lab and the person's progress are
// kept in the person's own notebook on the server (the Worker saves each lab as it is made, and the
// page saves progress as it changes), so they can open them again from any device; "Save to my notes"
// still copies a lab to the notebook as Markdown.
//
// Everything that came from the server is put on the page with
// createElement/textContent, never innerHTML: the material is model-written from a web page, so it
// is data, not markup. The page's CSP has no 'unsafe-inline' either.
//
// Layout: 1. pure helpers (tested in test/study.test.js)  2. the page.

(function (root) {
  "use strict";

  var API = "https://api.barnyard.site";
  var GENERATE_TIMEOUT_MS = 100000;

  // The tabs of a lab, in order, and which kind of material each one needs.
  var TABS = [
    { key: "overview", label: "Overview", kind: null },
    { key: "notes", label: "Notes", kind: "notes" },
    { key: "quiz", label: "Quiz", kind: "quiz" },
    { key: "flashcards", label: "Flashcards", kind: "flashcards" },
    { key: "traps", label: "Traps", kind: "traps" },
    { key: "checklist", label: "Checklist", kind: "checklist" }
  ];
  var KIND_ORDER = ["notes", "quiz", "flashcards", "traps", "checklist"];

  // ---- 1. pure helpers --------------------------------------------------------------------

  // What the person typed -> an https address, or "". A bare "learn.microsoft.com/..." gets https://.
  function normalizeLink(s) {
    if (typeof s !== "string") return "";
    var t = s.trim();
    if (!t || /\s/.test(t) || t.length > 500) return "";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = "https://" + t;
    if (!/^https:\/\//i.test(t)) return "";
    try { var u = new URL(t); return u.hostname.indexOf(".") > 0 ? u.toString() : ""; } catch (e) { return ""; }
  }

  var ERRORS = {
    disabled: "The study lab is switched off at the moment.",
    not_configured: "The study lab isn’t set up on the server yet.",
    host_not_allowed: "That site isn’t on the list this page can read. It works with Microsoft Learn, AWS, Google Cloud and a few other vendors’ own documentation.",
    url_not_https: "Use an address that starts with https://.",
    url_invalid: "That doesn’t look like a page address.",
    kinds_invalid: "Pick at least one thing to make.",
    source_redirected_away: "That link goes somewhere this page can’t read.",
    source_not_a_page: "That link isn’t a web page this page can read.",
    source_too_thin: "There’s not enough text on that page to make a lab from. Try the module’s own page, or a study guide.",
    source_unavailable: "That page couldn’t be opened. Check the link.",
    source_unreachable: "That page couldn’t be reached right now. Try again in a moment.",
    daily_limit: "You’ve used today’s allowance. It resets tomorrow.",
    generation_failed: "Claude couldn’t make anything from that page this time. Try again.",
    recent_sign_in_required: "For safety this needs a recent sign-in. Log in again, then retry.",
    secret_detected: "That looks like it contains a password or key, so it was not saved."
  };

  // -> { text, login } : what to tell the person; login says to offer the log in button.
  function errorText(code, status) {
    if (status === 401) return { text: "Log in to make a study lab.", login: true };
    if (status === 403 && (!code || code === "forbidden")) return { text: "Your account isn’t set up for Study.", login: false };
    if (code && ERRORS[code]) return { text: ERRORS[code], login: code === "recent_sign_in_required" };
    if (status === 0) return { text: "Couldn’t reach the server. Try again.", login: false };
    return { text: "That didn’t work. Try again.", login: false };
  }

  function letter(i) { return "abcd".charAt(i); }

  var text = function (v, max) { return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, max) : ""; };

  // Whatever came back, made safe to draw: unknown shapes are dropped, never trusted.
  // -> a lab { id, title, url, host, pages, truncated, at, notes?, quiz?, flashcards?, traps?, checklist?, failed } or null.
  function cleanSet(o) {
    if (!o || typeof o !== "object") return null;
    var id = typeof o.id === "string" && /^[0-9a-f]{8}$/.test(o.id) ? o.id : "";
    if (!id) return null;
    var set = {
      id: id, title: text(o.title, 200) || "Study lab", url: typeof o.url === "string" && /^https:\/\//.test(o.url) ? o.url.slice(0, 500) : "",
      host: text(o.host, 100), pages: Math.max(1, Math.min(50, parseInt(o.pages, 10) || 1)), truncated: o.truncated === true,
      at: Number.isFinite(o.at) ? o.at : 0, failed: Array.isArray(o.failed) ? o.failed.filter(function (k) { return KIND_ORDER.indexOf(k) > -1; }) : []
    };
    var n;
    if (Array.isArray(o.notes)) {
      n = o.notes.map(function (s) { return s && typeof s === "object" ? { heading: text(s.heading, 200), items: (Array.isArray(s.items) ? s.items : []).map(function (i) { return text(i, 1500); }).filter(Boolean).slice(0, 20) } : null; })
        .filter(function (s) { return s && s.heading && s.items.length; }).slice(0, 20);
      if (n.length) set.notes = n;
    }
    if (Array.isArray(o.quiz)) {
      n = o.quiz.map(function (q) {
        if (!q || typeof q !== "object" || !Array.isArray(q.choices) || q.choices.length !== 4) return null;
        var c = q.choices.map(function (x) { return text(x, 300); });
        var question = text(q.question, 600);
        if (!question || c.some(function (x) { return !x; }) || !(q.answer >= 0 && q.answer <= 3 && q.answer % 1 === 0)) return null;
        return { question: question, choices: c, answer: q.answer, why: text(q.why, 900) };
      }).filter(Boolean).slice(0, 30);
      if (n.length) set.quiz = n;
    }
    if (Array.isArray(o.flashcards)) {
      n = o.flashcards.map(function (c) { return c && typeof c === "object" ? { front: text(c.front, 400), back: text(c.back, 900) } : null; })
        .filter(function (c) { return c && c.front && c.back; }).slice(0, 60);
      if (n.length) set.flashcards = n;
    }
    if (Array.isArray(o.traps)) {
      n = o.traps.map(function (t) { return t && typeof t === "object" ? { mistake: text(t.mistake, 300), fix: text(t.fix, 500) } : null; })
        .filter(function (t) { return t && t.mistake && t.fix; }).slice(0, 30);
      if (n.length) set.traps = n;
    }
    if (Array.isArray(o.checklist)) {
      n = o.checklist.map(function (g) { return g && typeof g === "object" ? { heading: text(g.heading, 200), items: (Array.isArray(g.items) ? g.items : []).map(function (i) { return text(i, 300); }).filter(Boolean).slice(0, 12) } : null; })
        .filter(function (g) { return g && g.heading && g.items.length; }).slice(0, 10);
      if (n.length) set.checklist = n;
    }
    return KIND_ORDER.some(function (k) { return set[k]; }) ? set : null;
  }

  function emptyProgress() { return { notes: {}, known: {}, check: {}, best: null, tab: "overview" }; }

  function cleanProgress(o) {
    var p = emptyProgress();
    if (!o || typeof o !== "object") return p;
    ["notes", "known", "check"].forEach(function (k) {
      if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) Object.keys(o[k]).slice(0, 400).forEach(function (id) { if (o[k][id] === true && /^[a-z0-9:_-]{1,20}$/i.test(id)) p[k][id] = true; });
    });
    if (o.best && Number.isInteger(o.best.pct) && o.best.pct >= 0 && o.best.pct <= 100 && Number.isInteger(o.best.right) && Number.isInteger(o.best.total)) p.best = { pct: o.best.pct, right: o.best.right, total: o.best.total };
    if (typeof o.tab === "string" && TABS.some(function (t) { return t.key === o.tab; })) p.tab = o.tab;
    return p;
  }

  function checklistTotal(set) { return (set.checklist || []).reduce(function (n, g) { return n + g.items.length; }, 0); }
  function count(map) { return Object.keys(map).filter(function (k) { return map[k]; }).length; }

  var WEIGHTS = { notes: 0.3, flashcards: 0.2, quiz: 0.3, checklist: 0.2 };

  // How ready the person is, from what they have done in each part that exists in this lab.
  // -> { pct, parts: [{ key, text, frac }] }
  function readiness(set, p) {
    var parts = [];
    if (set.notes) parts.push({ key: "notes", text: "Notes " + Math.min(count(p.notes), set.notes.length) + "/" + set.notes.length, frac: Math.min(count(p.notes), set.notes.length) / set.notes.length });
    if (set.quiz) parts.push({ key: "quiz", text: p.best ? "Quiz best " + p.best.pct + "%" : "Quiz best —", frac: p.best ? p.best.pct / 100 : 0 });
    if (set.flashcards) parts.push({ key: "flashcards", text: "Cards " + Math.min(count(p.known), set.flashcards.length) + "/" + set.flashcards.length + " known", frac: Math.min(count(p.known), set.flashcards.length) / set.flashcards.length });
    if (set.checklist) { var t = checklistTotal(set); parts.push({ key: "checklist", text: "Checklist " + Math.min(count(p.check), t) + "/" + t, frac: Math.min(count(p.check), t) / t }); }
    var w = 0, sum = 0;
    parts.forEach(function (x) { w += WEIGHTS[x.key]; sum += WEIGHTS[x.key] * x.frac; });
    return { pct: w ? Math.round(sum / w * 100) : 0, parts: parts };
  }

  // The tabs this lab has: Overview always, then one for each kind that was made.
  function tabsFor(set) { return TABS.filter(function (t) { return !t.kind || set[t.kind]; }); }

  function shuffled(n, rnd) {
    var a = [], i;
    for (i = 0; i < n; i++) a.push(i);
    for (i = n - 1; i > 0; i--) { var j = Math.floor((rnd || Math.random)() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // The flip cards still to show: all of them, or only those not yet marked known.
  function cardList(order, known, onlyLearning) { return onlyLearning ? order.filter(function (i) { return !known[i]; }) : order.slice(); }

  // How a run of the quiz went: answers is one choice (or null) per question in the order asked.
  function quizOutcome(questions, order, answers) {
    var right = 0;
    order.forEach(function (qi, k) { if (answers[k] === questions[qi].answer) right++; });
    return { right: right, total: order.length, pct: order.length ? Math.round(right / order.length * 100) : 0 };
  }

  function verdict(pct) { return pct >= 85 ? "ready on this set" : pct >= 70 ? "close: review the misses" : "keep studying the notes"; }

  // The whole lab as Markdown, for the notebook. Only the parts that were made are included.
  function toMarkdown(set) {
    var out = ["# " + set.title, ""];
    if (set.url) out.push("Source: " + set.url, "");
    if (set.notes) {
      out.push("## Notes", "");
      set.notes.forEach(function (s) { out.push("### " + s.heading, ""); s.items.forEach(function (i) { out.push("- " + i); }); out.push(""); });
    }
    if (set.flashcards) {
      out.push("## Flashcards", "");
      set.flashcards.forEach(function (c) { out.push("- **" + c.front + "** — " + c.back); });
      out.push("");
    }
    if (set.quiz) {
      out.push("## Practice questions", "");
      set.quiz.forEach(function (q, n) {
        out.push((n + 1) + ". " + q.question);
        q.choices.forEach(function (c, i) { out.push("   - " + letter(i) + ") " + c); });
        out.push("   - **Answer: " + letter(q.answer) + ".**" + (q.why ? " " + q.why : ""));
      });
      out.push("");
    }
    if (set.traps) {
      out.push("## Traps", "");
      set.traps.forEach(function (t) { out.push("- **" + t.mistake + "** — " + t.fix); });
      out.push("");
    }
    if (set.checklist) {
      out.push("## Checklist", "");
      set.checklist.forEach(function (g) { out.push("### " + g.heading, ""); g.items.forEach(function (i) { out.push("- [ ] " + i); }); out.push(""); });
    }
    return out.join("\n");
  }

  function sourceLine(set) {
    var bits = [];
    if (set.host) bits.push("From " + set.host);
    if (set.pages > 1) bits.push(set.pages + " pages read");
    if (set.truncated) bits.push("only the start of a long page was used");
    if (set.failed && set.failed.length) bits.push("couldn’t make " + set.failed.join(", "));
    return bits.join(" · ");
  }

  function scoreText(s) {
    if (!s.answered) return "Pick an answer for each question.";
    return s.correct + " of " + s.answered + " correct" + (s.answered < s.total ? " so far (" + s.total + " questions)" : "") + ".";
  }

  var helpers = {
    normalizeLink: normalizeLink, errorText: errorText, letter: letter, cleanSet: cleanSet, cleanProgress: cleanProgress, emptyProgress: emptyProgress,
    readiness: readiness, tabsFor: tabsFor, shuffled: shuffled, cardList: cardList, quizOutcome: quizOutcome, verdict: verdict,
    toMarkdown: toMarkdown, sourceLine: sourceLine, scoreText: scoreText, checklistTotal: checklistTotal, TABS: TABS
  };
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. the page -------------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = txt;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function btn(label, cls, id) { var b = el("button", "btn" + (cls ? " " + cls : ""), label); b.type = "button"; if (id) b.id = id; return b; }
  function loginUrl() { return typeof root.barnyardLoginUrl === "function" ? root.barnyardLoginUrl() : API + "/auth/login"; }

  var lab = null;           // { set, progress, tab, quiz, cards, persisted, dirty }
  var labs = [];            // the list of saved labs, from the server
  var toastTimer = null;
  var saveTimer = null;

  function toast(msg) {
    var t = $("sl-toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }

  // Progress is saved to the person's notebook a moment after it changes, and straight away when the
  // page is hidden or the lab is closed.
  function saveProgress() {
    if (!lab || !lab.persisted) return;
    lab.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { flushProgress(false); }, 600);
  }
  function flushProgress(keepalive) {
    clearTimeout(saveTimer);
    if (!lab || !lab.persisted || !lab.dirty) return;
    lab.dirty = false;
    call("POST", "/notebook/lab-progress", { id: lab.set.id, progress: lab.progress, ready: readiness(lab.set, lab.progress).pct }, 20000, keepalive === true);
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushProgress(true); });
  root.addEventListener("pagehide", function () { flushProgress(true); });

  function showGate(msg, login) {
    $("gen-gate").hidden = !msg;
    $("gen-gate-msg").textContent = msg || "";
    var a = $("gen-gate-login");
    a.hidden = !login;
    if (login) a.href = loginUrl();
  }
  function say(t) { $("gen-status").textContent = t || ""; }

  function call(method, path, body, timeoutMs, keepalive) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 20000);
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {}, signal: ctl.signal };
    if (keepalive) opts.keepalive = true;
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j || {} }; });
    }, function () { return { status: 0, json: {} }; }).then(function (x) { clearTimeout(timer); return x; });
  }

  // -- the library of labs

  function loadLibrary() {
    call("GET", "/notebook/labs").then(function (r) {
      if (r.status === 200 && r.json && Array.isArray(r.json.labs)) { labs = r.json.labs; renderLibrary(); return; }
      if (r.status === 401) { var e = errorText(null, 401); showGate(e.text, e.login); }
    });
  }

  var armedRemove = null;
  function renderLibrary() {
    var box = $("sl-library"), ul = $("sl-sets");
    clear(ul);
    box.hidden = !labs.length;
    labs.forEach(function (m) {
      if (!m || typeof m.id !== "string" || !/^[0-9a-f]{8}$/.test(m.id)) return;
      var li = el("li", "sl-set");
      var open = el("button", "sl-set-open");
      open.type = "button";
      open.appendChild(el("span", "sl-set-title", text(m.title, 200) || "Study lab"));
      var pct = Number.isInteger(m.ready) ? m.ready : 0;
      open.appendChild(el("span", "sl-set-meta", (text(m.host, 100) || "") + (pct ? " · " + pct + "% ready" : "")));
      open.addEventListener("click", function () { openLab(m.id); });
      li.appendChild(open);
      var rm = btn(armedRemove === m.id ? "Click again to delete" : "Delete", "btn-quiet sl-small");
      rm.addEventListener("click", function () {
        if (armedRemove !== m.id) { armedRemove = m.id; renderLibrary(); return; }
        armedRemove = null;
        rm.disabled = true;
        call("DELETE", "/notebook/lab?id=" + encodeURIComponent(m.id)).then(function (r) {
          if (r.status === 200 || r.status === 404) labs = labs.filter(function (x) { return x.id !== m.id; }); else toast("That lab couldn’t be deleted. Try again.");
          renderLibrary();
        });
      });
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  // -- opening a lab

  function openLab(id) {
    call("GET", "/notebook/lab?id=" + encodeURIComponent(id)).then(function (r) {
      var set = r.status === 200 && r.json && r.json.lab ? cleanSet(Object.assign({}, r.json.lab, { at: r.json.lab.at || r.json.lab.updatedAt })) : null;
      if (!set) { var e = errorText(r.json && r.json.error, r.status); toast(r.status === 404 ? "That lab is gone." : e.text); loadLibrary(); return; }
      startLab(set, cleanProgress(r.json.progress), true);
    });
  }

  function startLab(set, progress, persisted) {
    lab = { set: set, progress: progress, persisted: persisted, dirty: false, tab: progress.tab, quiz: { order: null, i: 0, ans: [], done: false }, cards: { order: (set.flashcards || []).map(function (_, i) { return i; }), i: 0, only: false }, resetArmed: false };
    if (!tabsFor(set).some(function (t) { return t.key === lab.tab; })) lab.tab = "overview";
    $("sl-start").hidden = true;
    $("lab").hidden = false;
    $("lab-source").textContent = set.host ? "Study lab · " + set.host : "Study lab";
    $("lab-title").textContent = set.title;
    $("lab-sub").textContent = sourceLine(set);
    $("gen-open-note").hidden = true;
    $("gen-save").disabled = false;
    $("gen-save").textContent = "Save to my notes";
    renderTabs();
    renderView();
    updateGauge();
    window.scrollTo(0, 0);
  }

  function closeLab() {
    flushProgress(false);
    lab = null;
    $("lab").hidden = true;
    $("sl-start").hidden = false;
    loadLibrary();
  }

  // -- gauge

  function updateGauge() {
    var r = readiness(lab.set, lab.progress);
    $("gauge-pct").textContent = r.pct + "%";
    var arc = $("gauge-arc");
    arc.style.strokeDashoffset = String(213.6 * (1 - r.pct / 100));
    arc.classList.toggle("is-good", r.pct >= 80);
    var ul = $("gauge-parts");
    clear(ul);
    r.parts.forEach(function (p) { ul.appendChild(el("li", null, p.text)); });
  }

  // -- tabs

  function renderTabs() {
    var nav = $("lab-tabs");
    clear(nav);
    tabsFor(lab.set).forEach(function (t) {
      var b = el("button", "lab-tab", t.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", lab.tab === t.key ? "true" : "false");
      b.addEventListener("click", function () { selectTab(t.key); window.scrollTo(0, 0); });
      nav.appendChild(b);
    });
  }

  function selectTab(key) {
    lab.tab = key;
    lab.progress.tab = key;
    saveProgress();
    renderTabs();
    renderView();
  }

  function renderView() {
    var v = $("lab-views");
    clear(v);
    var panel = el("section", "lab-view");
    panel.setAttribute("role", "tabpanel");
    v.appendChild(panel);
    ({ overview: viewOverview, notes: viewNotes, quiz: viewQuiz, flashcards: viewCards, traps: viewTraps, checklist: viewChecklist })[lab.tab](panel);
  }

  // -- overview

  function viewOverview(p) {
    var set = lab.set;
    if (set.notes) {
      var grid = el("div", "sl-grid");
      set.notes.forEach(function (s, i) {
        var card = el("button", "sl-topic");
        card.type = "button";
        card.appendChild(el("span", "sl-topic-n", "Topic " + (i + 1)));
        card.appendChild(el("span", "sl-topic-t", s.heading));
        var bar = el("div", "bar"); var fill = el("i"); fill.style.width = lab.progress.notes[i] ? "100%" : "0%"; bar.appendChild(fill);
        card.appendChild(bar);
        card.appendChild(el("span", "gen-note", lab.progress.notes[i] ? "Studied" : "Not studied yet"));
        card.addEventListener("click", function () { selectTab("notes"); var t = document.getElementById("sl-topic-" + i); if (t) { t.open = true; t.scrollIntoView(); } });
        grid.appendChild(card);
      });
      p.appendChild(grid);
    }
    var panel = el("div", "sl-panel");
    panel.appendChild(el("h3", null, "In this lab"));
    var ul = el("ul", "sl-facts");
    if (set.notes) ul.appendChild(el("li", null, set.notes.length + " note topics to read and tick off"));
    if (set.quiz) ul.appendChild(el("li", null, set.quiz.length + " practice questions, shuffled each run"));
    if (set.flashcards) ul.appendChild(el("li", null, set.flashcards.length + " flashcards"));
    if (set.traps) ul.appendChild(el("li", null, set.traps.length + " common traps"));
    if (set.checklist) ul.appendChild(el("li", null, checklistTotal(set) + " things to be able to explain or do"));
    panel.appendChild(ul);
    panel.appendChild(el("p", "gen-note", "Readiness counts topics studied, your best quiz score, cards marked known and checklist items ticked. Your progress stays in this browser."));
    if (set.url) {
      var a = el("a", null, "Open the source page");
      a.href = set.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      var line = el("p", "gen-note"); line.appendChild(a);
      panel.appendChild(line);
    }
    p.appendChild(panel);
  }

  // -- notes

  function viewNotes(p) {
    lab.set.notes.forEach(function (s, i) {
      var d = el("details", "sl-detail");
      d.id = "sl-topic-" + i;
      var sum = el("summary");
      var left = el("span", "sl-sum");
      left.appendChild(el("span", "sl-arrow", "›"));
      left.appendChild(el("h3", null, s.heading));
      sum.appendChild(left);
      var mark = el("label", "sl-mark");
      mark.addEventListener("click", function (e) { e.stopPropagation(); });
      var cb = el("input"); cb.type = "checkbox"; cb.checked = !!lab.progress.notes[i];
      cb.addEventListener("change", function () {
        if (cb.checked) lab.progress.notes[i] = true; else delete lab.progress.notes[i];
        saveProgress(); updateGauge();
        if (cb.checked) toast("Marked as studied");
      });
      mark.appendChild(cb); mark.appendChild(document.createTextNode("Studied"));
      sum.appendChild(mark);
      d.appendChild(sum);
      var body = el("div", "sl-body");
      var ul = el("ul");
      s.items.forEach(function (it) { ul.appendChild(el("li", null, it)); });
      body.appendChild(ul);
      d.appendChild(body);
      p.appendChild(d);
    });
  }

  // -- quiz

  function viewQuiz(p) {
    var set = lab.set, Q = lab.quiz;
    var card = el("div", "sl-panel sl-q");
    p.appendChild(card);
    if (!Q.order) {
      card.appendChild(el("h2", null, "Practice quiz"));
      card.appendChild(el("p", "gen-note", set.quiz.length + " exam-style questions with explanations. They are shuffled each run, and your best score counts towards readiness."));
      if (lab.progress.best) card.appendChild(el("p", "gen-note", "Best run: " + lab.progress.best.pct + "% (" + lab.progress.best.right + "/" + lab.progress.best.total + ")"));
      var go = btn("Start quiz", "btn-primary");
      go.addEventListener("click", function () { Q.order = shuffled(set.quiz.length); Q.i = 0; Q.ans = Q.order.map(function () { return null; }); Q.done = false; renderView(); });
      card.appendChild(go);
      return;
    }
    if (Q.done) {
      var o = quizOutcome(set.quiz, Q.order, Q.ans);
      card.appendChild(el("p", "eyebrow", "Result"));
      var row = el("div", "sl-row");
      var big = el("span", "sl-score", o.pct + "%");
      big.classList.add(o.pct >= 85 ? "is-good" : o.pct >= 70 ? "is-mid" : "is-bad");
      row.appendChild(big);
      row.appendChild(el("span", "gen-note", o.right + " of " + o.total + " correct · " + verdict(o.pct)));
      card.appendChild(row);
      var acts = el("div", "sl-row");
      var again = btn("Try again", "btn-primary"); again.addEventListener("click", function () { Q.order = shuffled(set.quiz.length); Q.i = 0; Q.ans = Q.order.map(function () { return null; }); Q.done = false; renderView(); });
      var menu = btn("Back"); menu.addEventListener("click", function () { Q.order = null; renderView(); });
      acts.appendChild(again); acts.appendChild(menu);
      card.appendChild(acts);
      var missed = Q.order.map(function (qi, k) { return [qi, k]; }).filter(function (x) { return Q.ans[x[1]] !== set.quiz[x[0]].answer; });
      if (missed.length) {
        var rev = el("div", "sl-panel");
        rev.appendChild(el("h3", null, "Review your misses"));
        missed.forEach(function (x) {
          var q = set.quiz[x[0]];
          var item = el("div", "sl-miss");
          item.appendChild(el("p", "sl-strong", q.question));
          item.appendChild(el("p", "gen-note", "Answer: " + q.choices[q.answer] + ". " + q.why));
          rev.appendChild(item);
        });
        p.appendChild(rev);
      }
      return;
    }
    var q = set.quiz[Q.order[Q.i]], a = Q.ans[Q.i];
    var top = el("div", "sl-qtop");
    top.appendChild(el("span", "gen-note", "Question " + (Q.i + 1) + " of " + Q.order.length));
    card.appendChild(top);
    var dots = el("div", "dots");
    Q.order.forEach(function (qi, k) { var d = el("i", Q.ans[k] === null ? "" : Q.ans[k] === set.quiz[qi].answer ? "r" : "w"); if (k === Q.i) d.classList.add("c"); dots.appendChild(d); });
    card.appendChild(dots);
    card.appendChild(el("p", "sl-qtext", q.question));
    var opts = el("div", "opts");
    q.choices.forEach(function (c, k) {
      var o = el("button", "opt" + (a !== null ? (k === q.answer ? " right" : k === a ? " wrong" : "") : ""));
      o.type = "button"; o.disabled = a !== null;
      o.appendChild(el("span", "k", letter(k).toUpperCase()));
      o.appendChild(el("span", null, c));
      o.addEventListener("click", function () { Q.ans[Q.i] = k; renderView(); });
      opts.appendChild(o);
    });
    card.appendChild(opts);
    if (a !== null) {
      var ex = el("div", "explain" + (a === q.answer ? "" : " no"));
      ex.appendChild(el("strong", null, a === q.answer ? "Correct. " : "Not quite. "));
      ex.appendChild(document.createTextNode(q.why));
      card.appendChild(ex);
    }
    var nav = el("div", "sl-row sl-between");
    var prev = btn("Back"); prev.disabled = Q.i === 0; prev.addEventListener("click", function () { Q.i--; renderView(); });
    var next = btn(Q.i === Q.order.length - 1 ? "See result" : "Next", "btn-primary"); next.disabled = a === null;
    next.addEventListener("click", function () {
      if (Q.i < Q.order.length - 1) { Q.i++; renderView(); return; }
      Q.done = true;
      var o2 = quizOutcome(set.quiz, Q.order, Q.ans);
      if (!lab.progress.best || o2.pct > lab.progress.best.pct) { lab.progress.best = o2; saveProgress(); updateGauge(); toast("New best score"); }
      renderView(); window.scrollTo(0, 0);
    });
    nav.appendChild(prev); nav.appendChild(next);
    card.appendChild(nav);
  }

  // -- flashcards

  function viewCards(p) {
    var set = lab.set, C = lab.cards;
    var list = cardList(C.order, lab.progress.known, C.only);
    var known = Math.min(count(lab.progress.known), set.flashcards.length);
    if (C.i >= list.length) C.i = 0;
    var head = el("div", "sl-row sl-between");
    var h = el("div");
    h.appendChild(el("h2", null, "Flashcards"));
    h.appendChild(el("p", "gen-note", known + "/" + set.flashcards.length + " marked as known · click a card to flip it (space), arrows to move"));
    head.appendChild(h);
    var ctl = el("div", "sl-row");
    var only = el("label", "sl-mark");
    var cb = el("input"); cb.type = "checkbox"; cb.checked = C.only;
    cb.addEventListener("change", function () { C.only = cb.checked; C.i = 0; renderView(); });
    only.appendChild(cb); only.appendChild(document.createTextNode("Only cards I’m learning"));
    var shuf = btn("Shuffle"); shuf.addEventListener("click", function () { C.order = shuffled(set.flashcards.length); C.i = 0; renderView(); toast("Shuffled"); });
    ctl.appendChild(only); ctl.appendChild(shuf);
    head.appendChild(ctl);
    p.appendChild(head);
    if (!list.length) {
      var done = el("div", "sl-panel");
      done.appendChild(el("h3", null, "All cards known"));
      done.appendChild(el("p", "gen-note", "Untick the filter or reset to go again."));
      var rs = btn("Reset known cards"); rs.addEventListener("click", function () { lab.progress.known = {}; saveProgress(); updateGauge(); renderView(); });
      done.appendChild(rs);
      p.appendChild(done);
      return;
    }
    var idx = list[C.i], c = set.flashcards[idx];
    var flip = el("button", "flip"); flip.type = "button"; flip.id = "sl-flip"; flip.setAttribute("aria-label", "Flip card");
    var inner = el("div", "in");
    var front = el("div", "face");
    front.appendChild(el("span", "hint", "Card " + (C.i + 1) + " of " + list.length));
    front.appendChild(el("span", "q", c.front));
    front.appendChild(el("span", "hint", "Click to reveal"));
    var back = el("div", "face back");
    back.appendChild(el("span", "hint", "Answer"));
    back.appendChild(el("span", "a", c.back));
    back.appendChild(el("span", "hint", c.front));
    inner.appendChild(front); inner.appendChild(back); flip.appendChild(inner);
    flip.addEventListener("click", function () { flip.classList.toggle("on"); });
    p.appendChild(flip);
    var nav = el("div", "sl-row sl-between");
    var prev = btn("Previous"); prev.addEventListener("click", function () { C.i = (C.i - 1 + list.length) % list.length; renderView(); });
    var right = el("div", "sl-row");
    var learn = btn("Still learning"), know = btn("I know this", "btn-primary");
    learn.addEventListener("click", function () { delete lab.progress.known[idx]; saveProgress(); updateGauge(); C.i = (C.i + 1) % list.length; renderView(); });
    know.addEventListener("click", function () { lab.progress.known[idx] = true; saveProgress(); updateGauge(); if (!C.only) C.i = (C.i + 1) % list.length; renderView(); });
    right.appendChild(learn); right.appendChild(know);
    nav.appendChild(prev); nav.appendChild(right);
    p.appendChild(nav);
  }

  // -- traps

  function viewTraps(p) {
    var head = el("div");
    head.appendChild(el("h2", null, "Traps that catch people"));
    head.appendChild(el("p", "gen-note", "Tempting wrong answers, and what to remember instead."));
    p.appendChild(head);
    var box = el("div", "traps");
    lab.set.traps.forEach(function (t) {
      var row = el("div", "trap");
      var x = el("div", "x"); x.appendChild(el("span", "trap-k", "Trap")); x.appendChild(document.createTextNode(t.mistake));
      var y = el("div", "y"); y.appendChild(el("span", "trap-k", "Remember")); y.appendChild(document.createTextNode(t.fix));
      row.appendChild(x); row.appendChild(y);
      box.appendChild(row);
    });
    p.appendChild(box);
  }

  // -- checklist

  function viewChecklist(p) {
    var set = lab.set;
    var head = el("div", "sl-row sl-between");
    var h = el("div");
    h.appendChild(el("h2", null, "Final-week checklist"));
    h.appendChild(el("p", "gen-note", "Tick only what you could explain aloud and do without notes."));
    head.appendChild(h);
    var box = el("div", "sl-row");
    if (lab.resetArmed) {
      box.appendChild(el("span", "gen-note", "Clear all progress in this lab?"));
      var no = btn("Cancel"); no.addEventListener("click", function () { lab.resetArmed = false; renderView(); });
      var yes = btn("Clear", "btn-danger");
      yes.addEventListener("click", function () {
        lab.progress = emptyProgress(); lab.progress.tab = lab.tab; lab.resetArmed = false;
        lab.quiz = { order: null, i: 0, ans: [], done: false }; lab.cards.i = 0; lab.cards.only = false;
        saveProgress(); updateGauge(); renderView(); toast("Progress cleared");
      });
      box.appendChild(no); box.appendChild(yes);
    } else {
      var arm = btn("Reset all progress"); arm.addEventListener("click", function () { lab.resetArmed = true; renderView(); });
      box.appendChild(arm);
    }
    head.appendChild(box);
    p.appendChild(head);
    set.checklist.forEach(function (g, gi) {
      var panel = el("div", "sl-panel");
      var done = g.items.filter(function (_, k) { return lab.progress.check[gi + ":" + k]; }).length;
      var top = el("div", "sl-row sl-between");
      top.appendChild(el("h3", null, g.heading));
      top.appendChild(el("span", "gen-note", done + "/" + g.items.length));
      panel.appendChild(top);
      var cl = el("div", "cl");
      g.items.forEach(function (it, k) {
        var label = el("label");
        var cb = el("input"); cb.type = "checkbox"; cb.checked = !!lab.progress.check[gi + ":" + k];
        cb.addEventListener("change", function () {
          if (cb.checked) lab.progress.check[gi + ":" + k] = true; else delete lab.progress.check[gi + ":" + k];
          saveProgress(); updateGauge(); renderView();
        });
        label.appendChild(cb); label.appendChild(el("span", null, it));
        cl.appendChild(label);
      });
      panel.appendChild(cl);
      p.appendChild(panel);
    });
  }

  // -- keyboard for the flashcards

  document.addEventListener("keydown", function (e) {
    if (!lab || lab.tab !== "flashcards" || $("lab").hidden) return;
    if (e.target && e.target.closest && e.target.closest("input, select, textarea")) return;
    var list = cardList(lab.cards.order, lab.progress.known, lab.cards.only);
    if (!list.length) return;
    if (e.key === " ") { var f = $("sl-flip"); if (f) { e.preventDefault(); f.classList.toggle("on"); } }
    else if (e.key === "ArrowRight") { lab.cards.i = (lab.cards.i + 1) % list.length; renderView(); }
    else if (e.key === "ArrowLeft") { lab.cards.i = (lab.cards.i - 1 + list.length) % list.length; renderView(); }
  });

  // -- making a lab

  function chosenKinds() {
    var out = [];
    var boxes = document.querySelectorAll('input[name="kind"]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].value);
    return out;
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var link = normalizeLink($("gen-url").value);
    var kinds = chosenKinds();
    showGate("");
    if (!link) { say("Paste the address of a web page, for example a Microsoft Learn module."); return; }
    if (!kinds.length) { say(ERRORS.kinds_invalid); return; }
    var go = $("gen-go");
    go.disabled = true;
    say("Reading the page and building your lab. This can take up to a minute…");
    call("POST", "/study/generate", { url: link, kinds: kinds }, GENERATE_TIMEOUT_MS).then(function (r) {
      go.disabled = false;
      if (r.status === 200 && r.json) {
        var j = r.json, src = j.source || {};
        var raw = { id: j.id, title: j.title, url: link, host: src.host, pages: src.pages, truncated: src.truncated, at: j.at || Date.now(), failed: j.failed,
          notes: j.notes, quiz: j.quiz, flashcards: j.flashcards, traps: j.traps, checklist: j.checklist };
        var set = cleanSet(raw);
        if (!set) { say(""); showGate(ERRORS.generation_failed, false); return; }
        say("");
        startLab(set, emptyProgress(), j.saved === true);   // the Worker has already saved it, with fresh progress
        if (j.saved !== true) toast("This lab couldn’t be saved to your account, so it will be gone when you leave. Use Save to my notes to keep a copy.");
        return;
      }
      var e = errorText(r.json && r.json.error, r.status);
      say("");
      showGate(e.text, e.login);
    });
  }

  function onSave() {
    if (!lab) return;
    var b = $("gen-save");
    b.disabled = true;
    b.textContent = "Saving…";
    var title = ("Study lab: " + lab.set.title).slice(0, 200);
    call("POST", "/notebook/note", { title: title, body: toMarkdown(lab.set), tags: ["revision"] }).then(function (r) {
      if (r.status === 201 && r.json && r.json.note && r.json.note.id) {
        b.textContent = "Saved";
        var a = $("gen-open-note");
        a.href = "notes.html#" + encodeURIComponent(r.json.note.id);
        a.hidden = false;
        return;
      }
      b.disabled = false;
      b.textContent = "Save to my notes";
      var e = errorText(r.json && r.json.error, r.status);
      toast(e.text);
    });
  }

  $("gen-form").addEventListener("submit", onSubmit);
  $("gen-save").addEventListener("click", onSave);
  $("lab-back").addEventListener("click", closeLab);
  loadLibrary();
})(typeof window !== "undefined" ? window : this);
