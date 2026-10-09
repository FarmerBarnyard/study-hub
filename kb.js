// The Knowledgebase (knowledgebase.html): articles that people published from their
// notes, shared with everyone who can sign in to the study site. The articles live
// on the Worker (api.barnyard.site/kb/*, see ClaudeRepo/cloudflare-worker/README.md
// "Knowledgebase"); the notes they come from stay in each person's private notebook
// (api.barnyard.site/notebook/*). An article is a COPY: publishing sends the text
// (and the images it uses) to the library, editing a note afterwards changes nothing.
//
// Views, by address hash:  #/ library · #/a/<id> an article · #/new[?note=<id>] and
// #/edit/<id> the page where an article is generated from notes and published.
//
// Article text is shown with markdown.js (DOM nodes only, never innerHTML), so a
// published article cannot inject script or style however it is written.
//
// Plain script, no build step. Under Node only the pure helpers are exported (for
// test/kb.test.js); the page code runs when a `document` exists.
(function (root) {
  "use strict";

  var API = "https://api.barnyard.site/kb";
  var NB = "https://api.barnyard.site/notebook";
  var SEARCH_MS = 250;
  var ACCENTS = 8;
  var ARTICLE_ID = /^ka_[a-z0-9]{8}$/;
  var NOTE_ID = /^nt_[a-z0-9]{8}$/;

  // ------------------------------------------------------------ pure helpers

  // "#/a/ka_x1" -> { view:"article", id }; "#/new?note=nt_a&note=nt_b" -> { view:"new", notes:[...] }; anything else -> the library.
  function parseRoute(hash) {
    var h = String(hash || "").replace(/^#/, "");
    var q = "", i = h.indexOf("?");
    if (i !== -1) { q = h.slice(i + 1); h = h.slice(0, i); }
    var parts = h.split("/").filter(Boolean);
    if (parts[0] === "a" && ARTICLE_ID.test(parts[1] || "")) return { view: "article", id: parts[1] };
    if (parts[0] === "edit" && ARTICLE_ID.test(parts[1] || "")) return { view: "edit", id: parts[1] };
    if (parts[0] === "new") {
      var notes = [];
      q.split("&").forEach(function (kv) {
        var p = kv.split("=");
        if (p[0] === "note" && NOTE_ID.test(p[1] || "") && notes.indexOf(p[1]) === -1 && notes.length < 12) notes.push(p[1]);
      });
      return { view: "new", notes: notes, ai: /(^|&)ai=1(&|$)/.test(q) };
    }
    return { view: "library" };
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function relTime(ts, now) {
    if (!Number.isFinite(ts)) return "";
    var n = Number.isFinite(now) ? now : Date.now();
    var days = Math.floor((startOfDay(n) - startOfDay(ts)) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 14) return days + " days ago";
    var d = new Date(ts);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }
  function startOfDay(ts) { var d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  // [{tag, count}] most used first, then A-Z.
  function tagCounts(items) {
    var m = {};
    items.forEach(function (it) { (it.tags || []).forEach(function (t) { m[t] = (m[t] || 0) + 1; }); });
    return Object.keys(m).map(function (t) { return { tag: t, count: m[t] }; })
      .sort(function (a, b) { return b.count - a.count || (a.tag < b.tag ? -1 : 1); });
  }

  // Filters the list the page already has; every word of the query must appear in the
  // title, summary, tags or author.
  function filterItems(items, f) {
    var words = String((f && f.q) || "").toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(function (it) {
      if (f && f.mine && !it.mine) return false;
      if (f && f.tag && (it.tags || []).indexOf(f.tag) === -1) return false;
      if (!words.length) return true;
      var hay = (it.title + " " + (it.summary || "") + " " + (it.tags || []).join(" ") + " " + (it.author || "")).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
  }

  function sortItems(items, how) {
    var out = items.slice();
    if (how === "title") out.sort(function (a, b) { return a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }); });
    else if (how === "short") out.sort(function (a, b) { return a.minutes - b.minutes || b.updatedAt - a.updatedAt; });
    else if (how === "long") out.sort(function (a, b) { return b.minutes - a.minutes || b.updatedAt - a.updatedAt; });
    else out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return out;
  }

  // The folder names above a notebook item, outermost first ("Knowledgebase / SC-300").
  function folderPath(items, id) {
    var byId = {};
    items.forEach(function (i) { byId[i.id] = i; });
    var out = [], cur = byId[id], guard = 0;
    while (cur && cur.parent && byId[cur.parent] && guard++ < 12) { cur = byId[cur.parent]; out.unshift(cur.title); }
    return out;
  }

  // Notes (not folders) for the picker, matching every word of the query in the title,
  // the folder path or the tags; the newest first.
  function noteChoices(items, query, limit) {
    var words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .filter(function (i) { return i.kind === "note"; })
      .map(function (i) { return { id: i.id, title: i.title, path: folderPath(items, i.id).join(" / "), tags: i.tags || [], pii: i.pii || [], updatedAt: i.updatedAt }; })
      .filter(function (c) {
        if (!words.length) return true;
        var hay = (c.title + " " + c.path + " " + c.tags.join(" ")).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) !== -1; });
      })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
      .slice(0, limit || 60);
  }

  var ERRORS = {
    recent_sign_in_required: "For safety, publishing needs a recent sign-in. Log in again, then retry.",
    rate_limited: "Too many changes too quickly. Wait a moment and retry.",
    library_full: "The library is full (500 articles). Delete an old one first.",
    author_full: "You have published the most articles allowed (100). Delete one first.",
    storage_full: "Image storage for the library is full.",
    image_missing: "An image in this article is not in your notebook any more, so it could not be copied. Remove it from the text or add it to a note again.",
    image_copy_failed: "The images could not be copied just now. Nothing was published; try again.",
    too_many_images: "An article can use up to 60 images.",
    conflict: "This article was changed somewhere else. Reload it before editing again.",
    title_too_long: "The title can be up to 120 characters.",
    summary_too_long: "The summary can be up to 400 characters.",
    body_too_long: "The article is too long (200,000 characters at most).",
    body_required: "The article needs some text.",
    title_required: "The article needs a title.",
    tags_invalid: "Use up to 8 tags, each up to 40 characters, with no commas.",
    ai_unavailable: "The AI model is not reachable right now. You can write the summary yourself.",
    ai_bad_reply: "The AI model answered in an unexpected way. Try again, or write the summary yourself.",
    forbidden: "You do not have access to do that.",
  };
  function describeError(status, json) {
    var j = json || {};
    if (j.error === "secret_detected") return "The " + (j.field || "text") + " looks like it contains a password or key (" + (j.kind || "secret") + "), so it was not published. Remove it and retry.";
    if (j.error && ERRORS[j.error]) return ERRORS[j.error];
    if (status === 0) return "Could not reach the server.";
    if (status === 401) return "You are signed out. Log in again.";
    return "Something went wrong (" + (j.error || status) + ").";
  }

  var PII_WORDS = { email: "email addresses", phone: "phone numbers", card: "card numbers", tfn: "tax file numbers", medicare: "Medicare numbers", ssn: "social security numbers" };
  function describePii(kinds) { return (kinds || []).map(function (k) { return PII_WORDS[k] || k; }).join(", "); }

  // ---- the AI help as background jobs -------------------------------------------------------
  //
  // The site's model is too slow to answer a waiting request, so the page queues a job and checks
  // on it every few seconds (the Worker: /kb/ai-job). These helpers are the wording and the
  // arithmetic; the page code below does the asking.

  var JOB_ERRORS = {
    too_many_jobs: "You already have three AI jobs waiting or running. Let one finish, or stop it, then try again.",
    queue_full: "The AI queue is full right now. Try again in a few minutes.",
    too_many_units: "That is more passages than one job can take.",
    spec_too_large: "That article is too long to send in one go.",
    rate_limited: "You have used today's AI allowance. It resets tomorrow.",
  };

  function describeJobError(status, json) {
    var j = json || {};
    if (j.error === "ai_unavailable" && j.reason === "engine_offline") return "The AI service is offline right now (the server that runs it is not answering). Try again later, or write it yourself.";
    if (JOB_ERRORS[j.error]) return JOB_ERRORS[j.error];
    return describeError(status, json);
  }

  // The longest passage list one job takes; the rest of the article is left as written.
  function planRewrite(todo, max) {
    var cap = Number.isInteger(max) && max > 0 ? max : 30;
    return { take: todo.slice(0, cap), skipped: Math.max(0, todo.length - cap) };
  }

  // About how long is left, from how fast the finished results came (a first guess until one has).
  function jobEtaMs(job, now) {
    var left = Math.max(0, (job.total || 0) - (job.done || 0) - (job.failed || 0));
    var finished = (job.done || 0) + (job.failed || 0);
    var per = finished > 0 && job.startedAt ? (now - job.startedAt) / finished : 150000;
    return left * per;
  }

  function minutesText(ms) {
    var mins = Math.max(1, Math.round(ms / 60000));
    return "about " + mins + (mins === 1 ? " minute" : " minutes");
  }

  // One line for the progress area. `what` is "summary" or "rewrite".
  function jobStatusText(job, what, now) {
    if (job.state === "queued") return "Waiting for the AI service to start…";
    if (job.cancelling) return "Stopping…";
    if (what === "summary") return "Writing the summary… this takes a few minutes. You can leave this page open and keep reading.";
    var at = Math.min(job.total, (job.done || 0) + (job.failed || 0) + 1);
    return "Rewriting passage " + at + " of " + job.total + " (" + minutesText(jobEtaMs(job, now)) + " left). Stop at any time.";
  }

  // 0..1 for the bar: finished results over the total (a sliver while waiting so it is visibly alive).
  function jobFraction(job) {
    if (!job.total) return 0.05;
    return Math.max(0.05, Math.min(1, ((job.done || 0) + (job.failed || 0)) / job.total));
  }

  // How often to ask: quickly at first, then every few seconds; slower while it is only queued.
  function pollDelayMs(attempt, state) {
    if (state === "queued") return 5000;
    return attempt < 3 ? 2000 : 4000;
  }

  // ---- picking a background job up again ---------------------------------------------------------
  // A rewrite takes minutes a passage. If the person leaves the page the job keeps running in the Worker, and
  // the browser (this tab only, sessionStorage) remembers just enough to offer to carry on: the job's id, its
  // kind, and the draft as it stood when the job started (the page makes the draft read-only while a job runs,
  // so that is still the draft the results belong to). It is dropped when the job ends or is discarded, and
  // after MEMO_MAX_AGE_MS. Nothing here leaves the browser.
  var MEMO_KEY = "barnyard-kb-ai-job";
  var MEMO_MAX_AGE_MS = 3 * 3600 * 1000;
  var MEMO_MAX_CHARS = 400000;

  function isText(v, max) { return typeof v === "string" && v.length <= max; }

  // -> a clean memo, or null for anything that is not exactly what the page stores.
  function readMemo(raw, now) {
    if (typeof raw !== "string" || !raw || raw.length > MEMO_MAX_CHARS) return null;
    var m;
    try { m = JSON.parse(raw); } catch (e) { return null; }
    if (!m || typeof m !== "object" || m.v !== 1) return null;
    if (!/^cj_[a-z0-9]{8}$/.test(m.id)) return null;
    if (m.type !== "rewrite" && m.type !== "summary") return null;
    if (!Number.isFinite(m.startedAt) || (now || Date.now()) - m.startedAt > MEMO_MAX_AGE_MS || m.startedAt > (now || Date.now()) + 60000) return null;
    if (m.mode !== "new" && m.mode !== "edit") return null;
    if (m.mode === "edit" && !/^ka_[a-z0-9]{8}$/.test(m.editId)) return null;
    var d = m.draft;
    if (!d || typeof d !== "object" || !isText(d.title, 400) || !isText(d.summary, 2000) || !isText(d.body, 300000)) return null;
    if (!Array.isArray(d.tags) || d.tags.length > 30 || !d.tags.every(function (t) { return isText(t, 60); })) return null;
    if (d.accent !== null && !Number.isInteger(d.accent)) return null;
    var todo = Array.isArray(m.todo) ? m.todo : [];
    if (m.type === "rewrite" && (!todo.length || todo.length > 200 || !todo.every(function (i) { return Number.isInteger(i) && i >= 0 && i < 100000; }))) return null;
    var sources = Array.isArray(m.sources) ? m.sources : [];
    if (sources.length > 50 || !sources.every(function (s) { return isText(s, 200); })) return null;
    return {
      v: 1, id: m.id, type: m.type, startedAt: m.startedAt, mode: m.mode, editId: m.mode === "edit" ? m.editId : null,
      rev: Number.isFinite(m.rev) ? m.rev : null, alsoSummary: m.alsoSummary === true, todo: todo, skipped: Number.isInteger(m.skipped) && m.skipped > 0 ? m.skipped : 0,
      draft: { title: d.title, summary: d.summary, tags: d.tags.slice(), body: d.body, accent: d.accent }, sources: sources.slice(),
    };
  }

  // "AI rewrite of “Title” started 12 min ago."
  function memoLine(memo, now) {
    var what = memo.type === "summary" ? "AI summary" : "AI rewrite";
    var title = memo.draft.title ? " of “" + memo.draft.title.slice(0, 80) + "”" : "";
    var mins = Math.max(0, Math.round(((now || Date.now()) - memo.startedAt) / 60000));
    var ago = mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : Math.round(mins / 60) + " h ago";
    return what + title + " started " + ago + ". It carries on without this page.";
  }

  var api = {
    readMemo: readMemo, memoLine: memoLine, MEMO_MAX_AGE_MS: MEMO_MAX_AGE_MS,
    parseRoute: parseRoute, relTime: relTime, tagCounts: tagCounts, filterItems: filterItems, sortItems: sortItems,
    folderPath: folderPath, noteChoices: noteChoices, describeError: describeError, describePii: describePii,
    describeJobError: describeJobError, planRewrite: planRewrite, jobEtaMs: jobEtaMs, jobStatusText: jobStatusText, jobFraction: jobFraction, pollDelayMs: pollDelayMs,
  };
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return;
  }

  // ---------------------------------------------------------------- the page

  var md = root.BarnyardMarkdown, fmt = root.BarnyardKbFormat;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    me: null,            // { admin, ai, limits, name, ... }
    items: [],           // the library list
    loaded: false,
    q: "", tag: "", sort: "updated", mine: false,
    searchSeq: 0, serverResults: null,
    cur: null,           // the open article's response
  };
  var comp = null;       // the article composer's state while it is open

  function saveMemo(m) { try { root.sessionStorage.setItem(MEMO_KEY, JSON.stringify(m)); } catch (e) { /* private window: the job just cannot be picked up again */ } }
  function dropMemo() { try { root.sessionStorage.removeItem(MEMO_KEY); } catch (e) { /* nothing to drop */ } }
  function loadMemo() {
    var raw = null;
    try { raw = root.sessionStorage.getItem(MEMO_KEY); } catch (e) { return null; }
    var m = readMemo(raw, Date.now());
    if (!m && raw) dropMemo();
    return m;
  }

  // Shown on the library and on the "write an article" page while a job the person left is still remembered.
  function resumeBanner(parent) {
    var memo = loadMemo();
    if (!memo) return;
    var box = el("div", "kb-note-box2 kb-resume", parent);
    el("span", "", box, memoLine(memo, Date.now()));
    btn("Pick it up", "btn kb-primary", box, function () { resumeFromMemo(memo); });
    btn("Discard", "btn", box, function () {
      kb("POST", "/ai-job/cancel", { id: memo.id });   // so the engine does not carry on for nobody
      dropMemo();
      if (box.parentNode) box.parentNode.removeChild(box);
    });
  }

  // Back to the composer with the draft as it was when the job started; the editor then watches the job.
  function resumeFromMemo(memo) {
    dropObservers(); dropScroll();
    comp = { mode: memo.mode, step: "edit", editId: memo.editId, rev: memo.rev === null ? undefined : memo.rev, dirty: true, report: null, sources: memo.sources, draft: memo.draft, resume: memo };
    var c = fmt.countOf(memo.draft.body);
    comp.report = { words: c.words, images: c.images, codeBlocks: c.codeBlocks, linkCards: c.linkCards, sections: fmt.headingsOf(memo.draft.body).filter(function (h) { return h.level === 2; }).length, flattenedLinks: [] };
    setTitle(memo.mode === "edit" ? "Edit " + memo.draft.title : "New article");
    var want = memo.mode === "edit" ? "#/edit/" + memo.editId : "#/new";
    if (location.hash !== want) location.hash = want;     // route() sees the composer is already open and leaves it alone
    renderEditor();
  }
  var timers = { search: null };
  var observers = [];

  function el(name, cls, parent, txt) {
    var e = document.createElement(name);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function btn(label, cls, parent, onclick) {
    var b = el("button", cls || "btn", parent, label);
    b.type = "button";
    if (onclick) b.addEventListener("click", onclick);
    return b;
  }
  function toast(text) { if (root.BarnyardShell && root.BarnyardShell.toast) root.BarnyardShell.toast(text); }

  function call(base, method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    return fetch(base + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j || {} }; });
    }, function () { return { status: 0, json: {} }; });
  }
  function kb(method, path, body) { return call(API, method, path, body); }

  function loginUrl() { return typeof root.barnyardLoginUrl === "function" ? root.barnyardLoginUrl() : "https://api.barnyard.site/auth/login"; }
  function showGate(msg, login) {
    $("kb").hidden = true;
    $("kb-gate").hidden = false;
    $("kb-gate-msg").textContent = msg;
    var a = $("kb-gate-login");
    a.hidden = !login;
    if (login) a.href = loginUrl();
  }

  function imageUrlFor(articleId) { return function (id) { return API + "/image?a=" + encodeURIComponent(articleId) + "&id=" + encodeURIComponent(id); }; }

  function setTitle(t) { document.title = (t ? t + " — " : "") + "Knowledgebase — Barnyard Study"; }

  function dropObservers() { observers.forEach(function (o) { o.disconnect(); }); observers = []; }
  var scrollHandler = null;
  function dropScroll() { if (scrollHandler) { root.removeEventListener("scroll", scrollHandler); scrollHandler = null; } }

  // ---- dialog

  function openDialog(title, build, foot) {
    var dlg = $("kb-dialog");
    $("kb-dialog-title").textContent = title;
    var body = $("kb-dialog-body");
    clear(body);
    build(body);
    var f = $("kb-dialog-foot");
    clear(f);
    if (foot) foot(f); else btn("Close", "btn", f, function () { dlg.close(); });
    dlg.classList.remove("wide");
    if (!dlg.open) dlg.showModal();
    return dlg;
  }

  function lightbox(src, alt) {
    var dlg = openDialog(alt || "Image", function (body) {
      var img = el("img", "nb-lightbox", body);
      img.crossOrigin = "use-credentials";
      img.alt = alt || "";
      img.src = src;
    });
    dlg.classList.add("wide");
  }

  function copyText(text, done) {
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

  // ---- shared bits of the library

  function chips(parent, tags) {
    var row = el("div", "kb-tags", parent);
    tags.forEach(function (t) { el("span", "kb-tag", row, t); });
    return row;
  }

  function accentOf(item) { return "kb-a" + (Number.isInteger(item.accent) ? item.accent % ACCENTS : 0); }

  function metaLine(parent, it) {
    var m = el("div", "kb-meta", parent);
    if (it.author) el("span", "", m, it.author);
    el("span", "", m, it.minutes + " min read");
    if (it.updatedAt) el("span", "", m, relTime(it.updatedAt));
    return m;
  }

  function card(it) {
    var a = el("a", "kb-card " + accentOf(it));
    a.href = "#/a/" + it.id;
    var cover = el("div", "kb-cover", a);
    cover.setAttribute("data-p", String((it.accent || 0) % 4));
    el("span", "kb-cover-tag", cover, (it.tags && it.tags[0]) || "Article");
    if (it.hidden) el("span", "kb-hidden-badge", cover, "Hidden");
    var body = el("div", "kb-card-body", a);
    el("h3", "kb-card-title", body, it.title);
    if (it.summary) el("p", "kb-card-sum", body, it.summary);
    else if (it.snippet) el("p", "kb-card-sum", body, it.snippet);
    if (it.snippet && it.summary) el("p", "kb-card-snip", body, it.snippet);
    if (it.tags && it.tags.length > 1) chips(body, it.tags.slice(1, 4));
    metaLine(body, it);
    return a;
  }

  // ---------------------------------------------------------------- library

  function visibleItems() {
    var base = state.serverResults && state.q.length >= 2 ? state.serverResults : state.items;
    var list = filterItems(base, { tag: state.tag, mine: state.mine, q: state.serverResults && state.q.length >= 2 ? "" : state.q });
    if (state.serverResults && state.q.length >= 2) return list;     // the server already ranked these
    return sortItems(list, state.sort);
  }

  function renderResults() {
    var host = $("kb-results");
    if (!host) return;
    clear(host);
    var list = visibleItems();
    $("kb-count").textContent = state.items.length ? list.length + (list.length === state.items.length ? " articles" : " of " + state.items.length + " articles") : "";
    if (!state.items.length) {
      var empty = el("div", "kb-empty", host);
      el("h2", "", empty, "Nothing published yet");
      el("p", "", empty, "Pick one or more of your notes and turn them into a tidy, shareable article.");
      btn("Write the first article", "btn kb-primary", empty, function () { location.hash = "#/new"; });
      return;
    }
    if (!list.length) {
      var none = el("div", "kb-empty", host);
      el("h2", "", none, "No articles match");
      el("p", "", none, "Try fewer words, or clear the filters.");
      btn("Clear filters", "btn", none, function () { state.q = ""; state.tag = ""; state.mine = false; state.serverResults = null; renderLibrary(); });
      return;
    }
    list.forEach(function (it) { host.appendChild(card(it)); });
  }

  function renderTagRow() {
    var host = $("kb-tagrow");
    if (!host) return;
    clear(host);
    var counts = tagCounts(state.items).slice(0, 14);
    if (!counts.length) return;
    var all = btn("All", "kb-chip", host, function () { state.tag = ""; renderTagRow(); renderResults(); });
    all.setAttribute("aria-pressed", String(!state.tag));
    counts.forEach(function (c) {
      var b = btn(c.tag, "kb-chip", host, function () { state.tag = state.tag === c.tag ? "" : c.tag; renderTagRow(); renderResults(); });
      el("span", "kb-chip-n", b, String(c.count));
      b.setAttribute("aria-pressed", String(state.tag === c.tag));
    });
  }

  function searchNow() {
    var q = state.q.trim();
    var seq = ++state.searchSeq;
    if (q.length < 2) { state.serverResults = null; renderResults(); return; }
    kb("GET", "/list?q=" + encodeURIComponent(q)).then(function (r) {
      if (seq !== state.searchSeq) return;
      state.serverResults = r.status === 200 ? r.json.items : null;
      renderResults();
    });
  }

  function renderLibrary() {
    dropObservers(); dropScroll();
    setTitle("");
    var view = $("kb-view");
    clear(view);
    var head = el("div", "page-head kb-head", view);
    var titleBox = el("div", "", head);
    el("h1", "", titleBox, "Knowledgebase");
    el("p", "", titleBox, "Articles written from study notes. Everyone who can sign in here can read them.");
    resumeBanner(view);
    var actions = el("div", "kb-head-actions", head);
    btn("Write an article", "btn kb-primary", actions, function () { location.hash = "#/new"; });
    var back = el("a", "btn", actions, "Open Notes");
    back.href = "notes.html";

    var bar = el("div", "kb-toolbar", view);
    var search = el("input", "kb-search", bar);
    search.type = "search"; search.placeholder = "Search articles"; search.maxLength = 100; search.value = state.q;
    search.setAttribute("aria-label", "Search articles");
    search.autocomplete = "off";
    search.addEventListener("input", function () {
      state.q = search.value;
      renderResults();
      clearTimeout(timers.search);
      timers.search = setTimeout(searchNow, SEARCH_MS);
    });
    var sort = el("select", "kb-sort", bar);
    sort.setAttribute("aria-label", "Sort");
    [["updated", "Recently updated"], ["title", "Title A–Z"], ["short", "Shortest first"], ["long", "Longest first"]].forEach(function (o) {
      var op = el("option", "", sort, o[1]); op.value = o[0];
    });
    sort.value = state.sort;
    sort.addEventListener("change", function () { state.sort = sort.value; renderResults(); });
    var mine = btn("My articles", "btn", bar, function () { state.mine = !state.mine; mine.setAttribute("aria-pressed", String(state.mine)); renderResults(); });
    mine.setAttribute("aria-pressed", String(state.mine));
    el("span", "kb-count", bar).id = "kb-count";

    el("div", "kb-tagrow", view).id = "kb-tagrow";
    el("div", "kb-grid", view).id = "kb-results";
    renderTagRow();
    renderResults();
  }

  function loadLibrary() {
    return kb("GET", "/list").then(function (r) {
      if (r.status !== 200) return false;
      state.items = r.json.items || [];
      state.loaded = true;
      return true;
    });
  }

  // ---------------------------------------------------------------- an article

  function titleToId(links) {
    var m = {};
    (links || []).forEach(function (l) { if (l.id) m[String(l.title).toLowerCase()] = l.id; });
    return m;
  }

  function buildToc(host, tocEl) {
    var heads = host.querySelectorAll("h2, h3");
    clear(tocEl);
    if (heads.length < 3) { tocEl.hidden = true; return []; }
    tocEl.hidden = false;
    el("div", "kb-toc-h", tocEl, "On this page");
    var list = el("ol", "kb-toc-list", tocEl);
    var seen = {}, out = [];
    Array.prototype.forEach.call(heads, function (h) {
      var id = fmt.headingId(h.textContent, seen);
      h.id = "s-" + id;
      var li = el("li", "kb-toc-" + h.tagName.toLowerCase(), list);
      var b = el("button", "kb-toc-link", li, h.textContent);
      b.type = "button";
      b.setAttribute("data-target", h.id);
      out.push({ h: h, b: b });
    });
    tocEl.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-target]") : null;
      var t = b && document.getElementById(b.getAttribute("data-target"));
      if (t && t.scrollIntoView) t.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return out;
  }

  function watchSections(entries) {
    if (!entries.length || !root.IntersectionObserver) return;
    var current = null;
    var io = new IntersectionObserver(function (seen) {
      seen.forEach(function (s) { if (s.isIntersecting) current = s.target.id; });
      entries.forEach(function (e) { if (e.h.id === current) e.b.setAttribute("aria-current", "true"); else e.b.removeAttribute("aria-current"); });
    }, { rootMargin: "-10% 0px -75% 0px" });
    entries.forEach(function (e) { io.observe(e.h); });
    observers.push(io);
  }

  function renderArticle(data) {
    dropObservers(); dropScroll();
    var a = data.article;
    state.cur = data;
    setTitle(a.title);
    var view = $("kb-view");
    clear(view);
    var art = el("article", "kb-art " + accentOf(a), view);
    var bar = el("div", "kb-progress", art);
    var fill = el("div", "kb-progress-fill", bar);
    scrollHandler = function () {
      var max = document.documentElement.scrollHeight - root.innerHeight;
      var pct = max > 0 ? Math.min(1, Math.max(0, root.scrollY / max)) : 0;
      fill.style.transform = "scaleX(" + pct.toFixed(3) + ")";
    };
    root.addEventListener("scroll", scrollHandler, { passive: true });
    scrollHandler();

    var banner = el("header", "kb-banner", art);
    banner.setAttribute("data-p", String((a.accent || 0) % 4));
    var crumb = el("a", "kb-back", banner, "← Knowledgebase");
    crumb.href = "#/";
    if (a.tags.length) chips(banner, a.tags);
    el("h1", "kb-title", banner, a.title);
    if (a.summary) el("p", "kb-lede", banner, a.summary);
    var by = el("div", "kb-byline", banner);
    if (a.author) el("span", "", by, "By " + a.author);
    el("span", "", by, "Updated " + relTime(a.updatedAt));
    el("span", "", by, a.minutes + " min read");
    el("span", "", by, a.words.toLocaleString() + " words");
    if (a.hidden) el("p", "kb-hidden-note", banner, "Hidden: only you" + (data.canModerate && !data.canEdit ? " and the other owners" : "") + " can see this article.");

    var tools = el("div", "kb-actions", banner);
    btn("Copy link", "btn", tools, function () { copyText(location.href, function (ok) { toast(ok ? "Link copied" : "Could not copy the link"); }); });
    btn("Print", "btn", tools, function () { root.print(); });
    if (data.canEdit) {
      var edit = el("a", "btn", tools, "Edit");
      edit.href = "#/edit/" + a.id;
    }
    if (data.canEdit || data.canModerate) {
      btn(a.hidden ? "Show again" : "Hide", "btn", tools, function () { setHidden(a, !a.hidden); });
      btn("Delete", "btn kb-danger", tools, function () { confirmDelete(a); });
    }

    var layout = el("div", "kb-layout", art);
    var main = el("div", "kb-main", layout);
    var tocEl = el("aside", "kb-toc", layout);
    tocEl.setAttribute("aria-label", "On this page");

    var body = el("div", "md kb-body", main);
    var ids = titleToId(data.links);
    body.appendChild(md.toDom(md.parse(a.body), document, {
      imageUrl: imageUrlFor(a.id),
      findNote: function (t) { return ids[String(t).toLowerCase()] || null; },
      hrefFor: function (id) { return "#/a/" + id; },
      missingTitle: function (t) { return "“" + t + "” is not in the Knowledgebase"; },
    }));
    Array.prototype.forEach.call(body.querySelectorAll("pre"), function (pre) {
      pre.classList.add("has-copy");
      var c = el("button", "nb-copy", pre, "Copy");
      c.type = "button";
      c.setAttribute("aria-label", "Copy this code");
    });
    body.addEventListener("click", function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains("nb-copy")) {
        var code = t.parentNode.querySelector("code");
        copyText(code ? code.textContent : "", function (ok) { t.textContent = ok ? "Copied" : "Copy failed"; setTimeout(function () { t.textContent = "Copy"; }, 1500); });
      } else if (t.tagName === "IMG" && t.classList.contains("nb-img")) lightbox(t.src, t.alt);
    });
    watchSections(buildToc(body, tocEl));

    if (data.backlinks && data.backlinks.length) {
      var back = el("section", "kb-more", main);
      el("h2", "", back, "Linked from");
      var ul = el("ul", "kb-linklist", back);
      data.backlinks.forEach(function (b) { var li = el("li", "", ul); var l = el("a", "", li, b.title); l.href = "#/a/" + b.id; });
    }
    if (data.related && data.related.length) {
      var rel = el("section", "kb-more", main);
      el("h2", "", rel, "More like this");
      var grid = el("div", "kb-grid kb-grid-small", rel);
      data.related.forEach(function (r) {
        var item = { id: r.id, title: r.title, summary: r.summary, accent: r.accent, minutes: r.minutes, tags: r.tags, updatedAt: 0, author: "" };
        var c = card(item);
        var m = c.querySelector(".kb-meta"); if (m) m.textContent = r.minutes + " min read";
        grid.appendChild(c);
      });
    }
    root.scrollTo(0, 0);
  }

  function openArticle(id) {
    var view = $("kb-view");
    clear(view);
    el("p", "kb-loading", view, "Loading…");
    return kb("GET", "/article?id=" + encodeURIComponent(id)).then(function (r) {
      if (r.status === 200) { renderArticle(r.json); return; }
      clear(view);
      var box = el("div", "kb-empty", view);
      el("h2", "", box, r.status === 404 ? "That article is not here" : "Could not open the article");
      el("p", "", box, r.status === 404 ? "It may have been hidden or deleted." : describeError(r.status, r.json));
      var back = el("a", "btn", box, "Back to the Knowledgebase"); back.href = "#/";
    });
  }

  function setHidden(a, hidden) {
    kb("POST", "/article/visibility?id=" + encodeURIComponent(a.id), { hidden: hidden }).then(function (r) {
      if (r.status !== 200) { toast(describeError(r.status, r.json)); return; }
      toast(hidden ? "Hidden from everyone else" : "Visible to everyone again");
      openArticle(a.id);
    });
  }

  function confirmDelete(a) {
    openDialog("Delete this article?", function (body) {
      el("p", "", body, "“" + a.title + "” will be removed for everyone, along with its copies of the images. The notes it was made from are not touched.");
    }, function (foot) {
      btn("Cancel", "btn", foot, function () { $("kb-dialog").close(); });
      btn("Delete for good", "btn kb-danger", foot, function () {
        kb("DELETE", "/article?id=" + encodeURIComponent(a.id)).then(function (r) {
          $("kb-dialog").close();
          if (r.status !== 200) { toast(describeError(r.status, r.json)); return; }
          toast("Article deleted");
          state.loaded = false;
          location.hash = "#/";
        });
      });
    });
  }

  // ---------------------------------------------------------------- the composer

  function compDirty() { return !!comp && comp.dirty; }

  function stepper(parent, step) {
    var s = el("ol", "kb-steps", parent);
    [["pick", "Choose notes"], ["edit", "Review and publish"]].forEach(function (x) {
      var li = el("li", "", s, x[1]);
      if (x[0] === step) li.setAttribute("aria-current", "step");
    });
  }

  function loadNotebook() {
    if (comp.notebook) return Promise.resolve(true);
    return call(NB, "GET", "/tree").then(function (r) {
      if (r.status !== 200) { comp.error = r.status === 401 ? "Log in to use your notes." : "Could not read your notebook (" + (r.json.error || r.status) + ")."; return false; }
      comp.notebook = r.json.items || [];
      return true;
    });
  }

  // `ai` (from "Generate KB article (AI)" on a note): skip choosing, build the draft from the
  // chosen note(s) and start the passage-by-passage rewrite as soon as the editor opens.
  function startNew(preselect, ai) {
    dropObservers(); dropScroll();
    comp = { mode: "new", step: "pick", picked: (preselect || []).slice(), q: "", notebook: null, draft: null, dirty: false, title: "", report: null, autoAi: false };
    setTitle("New article");
    var view = $("kb-view");
    clear(view);
    el("p", "kb-loading", view, "Reading your notebook…");
    Promise.all([loadNotebook(), state.loaded ? true : loadLibrary()]).then(function () {
      if (ai && comp.picked.length && comp.notebook) { comp.autoAi = true; generate(null); } else renderPick();
    });
  }

  function renderPick() {
    var view = $("kb-view");
    clear(view);
    var head = el("div", "page-head kb-head", view);
    var tb = el("div", "", head);
    el("h1", "", tb, "Write an article");
    el("p", "", tb, "Choose one or more notes. They are copied into a tidy draft that you can edit before anyone else sees it.");
    resumeBanner(view);
    var back = el("a", "btn", head, "Cancel"); back.href = "#/";
    stepper(view, "pick");
    if (comp.error) { el("p", "kb-error", view, comp.error); return; }

    var grid = el("div", "kb-pick", view);
    var left = el("section", "kb-pick-list", grid);
    var search = el("input", "kb-search", left);
    search.type = "search"; search.placeholder = "Find a note"; search.value = comp.q; search.autocomplete = "off"; search.maxLength = 100;
    search.setAttribute("aria-label", "Find a note");
    var list = el("ul", "kb-notes", left);
    var right = el("section", "kb-pick-sel", grid);

    function drawList() {
      clear(list);
      var choices = noteChoices(comp.notebook, comp.q, 80);
      if (!choices.length) el("li", "kb-none", list, comp.notebook.length ? "No notes match." : "Your notebook is empty. Write a note first.");
      choices.forEach(function (c) {
        var li = el("li", "", list);
        var b = el("button", "kb-note", li);
        b.type = "button";
        var on = comp.picked.indexOf(c.id) !== -1;
        b.setAttribute("aria-pressed", String(on));
        el("span", "kb-note-box", b, on ? "✓" : "");
        var t = el("span", "kb-note-text", b);
        el("span", "kb-note-title", t, c.title);
        if (c.path) el("span", "kb-note-path", t, c.path);
        if (c.pii.length) el("span", "kb-pii", b, "personal data");
        b.addEventListener("click", function () {
          var i = comp.picked.indexOf(c.id);
          if (i === -1) { if (comp.picked.length < 12) comp.picked.push(c.id); } else comp.picked.splice(i, 1);
          drawList(); drawSel();
        });
      });
    }
    function titleOf(id) { var f = comp.notebook.filter(function (i) { return i.id === id; })[0]; return f ? f.title : id; }
    function drawSel() {
      clear(right);
      el("h2", "", right, comp.picked.length ? comp.picked.length + (comp.picked.length === 1 ? " note selected" : " notes selected") : "Nothing selected yet");
      if (comp.picked.length > 1) el("p", "kb-hint", right, "Each note becomes a section, in this order.");
      var ol = el("ol", "kb-sel", right);
      comp.picked.forEach(function (id, i) {
        var li = el("li", "", ol);
        el("span", "kb-sel-title", li, titleOf(id));
        var up = btn("↑", "kb-mini", li, function () { if (i > 0) { comp.picked.splice(i - 1, 0, comp.picked.splice(i, 1)[0]); drawSel(); } });
        up.setAttribute("aria-label", "Move up"); up.disabled = i === 0;
        var dn = btn("↓", "kb-mini", li, function () { if (i < comp.picked.length - 1) { comp.picked.splice(i + 1, 0, comp.picked.splice(i, 1)[0]); drawSel(); } });
        dn.setAttribute("aria-label", "Move down"); dn.disabled = i === comp.picked.length - 1;
        var rm = btn("✕", "kb-mini", li, function () { comp.picked.splice(i, 1); drawList(); drawSel(); });
        rm.setAttribute("aria-label", "Remove");
      });
      var label = el("label", "kb-label", right, comp.picked.length > 1 ? "Article title" : "Article title (optional)");
      var title = el("input", "kb-input", label);
      title.type = "text"; title.maxLength = 120; title.value = comp.title; title.autocomplete = "off";
      title.placeholder = comp.picked.length ? titleOf(comp.picked[0]) : "";
      title.addEventListener("input", function () { comp.title = title.value; });
      var go = btn("Generate article", "btn kb-primary", right, function () { generate(go); });
      go.disabled = !comp.picked.length;
      el("p", "kb-hint", right, "Nothing is shared yet. You see the draft first and choose when to publish.");
    }
    search.addEventListener("input", function () { comp.q = search.value; drawList(); });
    drawList(); drawSel();
  }

  function generate(button) {
    if (button) { button.disabled = true; button.textContent = "Reading your notes…"; }
    var notes = [];
    var chain = Promise.resolve();
    comp.picked.forEach(function (id) {
      chain = chain.then(function () {
        return call(NB, "GET", "/note?id=" + encodeURIComponent(id)).then(function (r) {
          if (r.status !== 200 || !r.json.note) throw new Error("note");
          notes.push({ title: r.json.note.title, body: r.json.note.body || "", tags: r.json.note.tags || [] });
        });
      });
    });
    chain.then(function () {
      var published = state.items.map(function (i) { return i.title; });
      var d = fmt.draftFromNotes(notes, { title: comp.title.trim(), publishedTitles: published });
      comp.draft = { title: d.title, summary: d.summary, tags: d.tags, body: d.body, accent: null };
      comp.report = d.report;
      comp.sources = notes.map(function (n) { return n.title; });
      comp.step = "edit";
      comp.dirty = true;
      renderEditor();
    }, function () {
      if (button) { button.disabled = false; button.textContent = "Generate article"; }
      else { comp.autoAi = false; renderPick(); }
      toast("Could not read one of the notes. Try again.");
    });
  }

  function startEdit(id) {
    dropObservers(); dropScroll();
    comp = { mode: "edit", step: "edit", editId: id, dirty: false, report: null, sources: null };
    var view = $("kb-view");
    clear(view);
    el("p", "kb-loading", view, "Loading…");
    kb("GET", "/article?id=" + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200 || !r.json.canEdit) {
        clear(view);
        var box = el("div", "kb-empty", view);
        el("h2", "", box, "You can only edit your own articles");
        var b = el("a", "btn", box, "Back"); b.href = "#/a/" + id;
        return;
      }
      var a = r.json.article;
      comp.rev = a.rev;
      comp.draft = { title: a.title, summary: a.summary, tags: a.tags.slice(), body: a.body, accent: a.accent };
      comp.report = fmt.countOf(a.body);
      comp.report.sections = fmt.headingsOf(a.body).filter(function (h) { return h.level === 2; }).length;
      comp.report.flattenedLinks = [];
      setTitle("Edit " + a.title);
      renderEditor();
    });
  }

  function recount() {
    var c = fmt.countOf(comp.draft.body);
    comp.report = { words: c.words, images: c.images, codeBlocks: c.codeBlocks, linkCards: c.linkCards, sections: fmt.headingsOf(comp.draft.body).filter(function (h) { return h.level === 2; }).length, flattenedLinks: comp.report ? comp.report.flattenedLinks : [] };
  }

  function renderEditor() {
    var d = comp.draft;
    var view = $("kb-view");
    clear(view);
    var head = el("div", "page-head kb-head", view);
    var tb = el("div", "", head);
    el("h1", "", tb, comp.mode === "edit" ? "Edit article" : "Review your article");
    el("p", "", tb, comp.mode === "edit" ? "Changes are visible to everyone as soon as you save." : "This is a draft. Nothing is visible to anyone else until you publish.");
    var cancel = btn(comp.mode === "edit" ? "Cancel" : "Back to notes", "btn", head, function () {
      if (compDirty() && !root.confirm("Discard this draft?")) return;
      comp.dirty = false;
      if (comp.mode === "edit") location.hash = "#/a/" + comp.editId; else { comp.step = "pick"; renderPick(); }
    });
    if (comp.mode === "new") stepper(view, "edit");

    var grid = el("div", "kb-edit", view);
    var form = el("section", "kb-form", grid);
    var side = el("aside", "kb-side", grid);

    function field(label, node, hint) {
      var l = el("label", "kb-label", form, label);
      l.appendChild(node);
      if (hint) el("span", "kb-hint", l, hint);
      return l;
    }
    var title = el("input", "kb-input");
    title.type = "text"; title.maxLength = 120; title.value = d.title; title.autocomplete = "off";
    field("Title", title);
    var summary = el("textarea", "kb-textarea kb-summary");
    summary.maxLength = 400; summary.rows = 3; summary.value = d.summary;
    var sumLabel = field("Summary", summary);
    var count = el("span", "kb-hint kb-count-hint", sumLabel);
    var aiRow = el("div", "kb-airow", form);
    var aiRewrite = btn("Rewrite with AI, passage by passage", "btn", aiRow);
    var ai = btn("Add an AI summary and key points", "btn", aiRow);
    var aiNote = el("span", "kb-hint", aiRow);
    var aiRun = el("div", "kb-airun", form);
    aiRun.hidden = true;
    var aiRunText = el("span", "kb-airun-text", aiRun);
    aiRunText.setAttribute("role", "status");
    var aiBar = el("div", "kb-ai-progress", aiRun);
    var aiFill = el("div", "kb-ai-progress-fill", aiBar);
    var aiStop = btn("Stop", "btn", aiRun);
    var tags = el("input", "kb-input");
    tags.type = "text"; tags.value = d.tags.join(", "); tags.autocomplete = "off"; tags.placeholder = "azure, identity";
    field("Tags", tags, "Separate with commas (up to 8). The first one is shown on the card.");

    var swWrap = el("div", "kb-label", form);
    el("span", "", swWrap, "Colour");
    var sw = el("div", "kb-swatches", swWrap);
    var autoAccent = d.accent === null;
    for (var s = 0; s < ACCENTS; s++) (function (n) {
      var b = el("button", "kb-swatch kb-a" + n, sw);
      b.type = "button";
      b.setAttribute("aria-label", "Colour " + (n + 1));
      b.addEventListener("click", function () { d.accent = n; comp.dirty = true; drawSwatches(); });
    })(s);
    function drawSwatches() {
      Array.prototype.forEach.call(sw.children, function (b, n) { b.setAttribute("aria-pressed", String(d.accent === n)); });
    }
    if (autoAccent) el("span", "kb-hint", swWrap, "Left unset, a colour is picked from the title.");
    drawSwatches();

    var bodyLabel = el("div", "kb-label", form);
    var modes = el("div", "nb-modes kb-modes", bodyLabel);
    el("span", "kb-bodylab", bodyLabel, "Article text (Markdown)");
    var panes = el("div", "kb-panes", form);
    panes.setAttribute("data-mode", root.matchMedia && root.matchMedia("(min-width: 1100px)").matches ? "split" : "preview");
    var text = el("textarea", "kb-textarea kb-body-text", panes);
    text.value = d.body; text.spellcheck = true;
    text.setAttribute("aria-label", "Article text");
    var prev = el("div", "md kb-preview", panes);
    [["edit", "Write"], ["split", "Side by side"], ["preview", "Preview"]].forEach(function (m) {
      var b = el("button", "", modes, m[1]); b.type = "button"; b.setAttribute("data-mode", m[0]);
      b.addEventListener("click", function () { panes.setAttribute("data-mode", m[0]); drawModes(); });
    });
    function drawModes() { Array.prototype.forEach.call(modes.children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === panes.getAttribute("data-mode"))); }); }
    drawModes();

    var previewTimer = null;
    function drawPreview() {
      clear(prev);
      var ids = {};
      state.items.forEach(function (i) { ids[i.title.toLowerCase()] = i.id; });
      prev.appendChild(md.toDom(md.parse(d.body), document, {
        // Images already in the article show; ones still in your notebook are only copied when you publish.
        imageUrl: comp.mode === "edit" ? imageUrlFor(comp.editId) : null,
        findNote: function (t) { return ids[String(t).toLowerCase()] || null; },
        hrefFor: function (id) { return "#/a/" + id; },
        missingTitle: function (t) { return "“" + t + "” is not in the Knowledgebase, so it will show as plain text"; },
      }));
      if (comp.mode === "new") {
        Array.prototype.forEach.call(prev.querySelectorAll("img"), function (i) { i.remove(); });
      }
    }
    function drawSide() {
      clear(side);
      recount();
      var r = comp.report;
      el("h2", "", side, "What is in it");
      var dl = el("dl", "kb-stats", side);
      [["Words", r.words.toLocaleString()], ["Reading time", Math.max(1, Math.round(r.words / 220 + r.images * 0.2 + r.codeBlocks * 0.3)) + " min"], ["Sections", String(r.sections)], ["Images", String(r.images)], ["Code blocks", String(r.codeBlocks)], ["Link cards", String(r.linkCards)]].forEach(function (p) {
        el("dt", "", dl, p[0]); el("dd", "", dl, p[1]);
      });
      if (r.flattenedLinks && r.flattenedLinks.length) {
        var w = el("p", "kb-note-box2", side);
        w.textContent = "Links to your own notes were turned into plain text, because other people cannot open your notes: " + r.flattenedLinks.join(", ") + ".";
      }
      if (comp.sources && comp.sources.length) el("p", "kb-hint", side, "Made from: " + comp.sources.join(", "));
      if (comp.mode === "new" && r.images) el("p", "kb-hint", side, "Images are copied from your notebook when you publish. They do not show in this preview.");
      el("h2", "kb-vis", side, "Who can see it");
      el("p", "", side, "Everyone who can sign in to the study site, as soon as you publish. You can hide or delete it later.");
      var pub = btn(comp.mode === "edit" ? "Save changes" : "Publish article", "btn kb-primary", side, function () { publish(pub, false); });
      pub.disabled = !d.title.trim() || !d.body.trim();
      comp.pubBtn = pub;
      comp.statusEl = el("p", "kb-status", side);
      comp.statusEl.setAttribute("role", "status");
    }
    function status(msg, bad) { if (comp.statusEl) { comp.statusEl.textContent = msg; comp.statusEl.className = "kb-status" + (bad ? " bad" : ""); } }
    comp.status = status;

    function parseTags(s) {
      var out = [];
      String(s).split(",").forEach(function (t) { var x = t.trim().toLowerCase(); if (x && out.indexOf(x) === -1) out.push(x); });
      return out;
    }
    function updateCount() { count.textContent = summary.value.length + " / 400"; }
    function onChange() {
      d.title = title.value; d.summary = summary.value; d.tags = parseTags(tags.value); d.body = text.value;
      comp.dirty = true;
      updateCount();
      if (comp.pubBtn) comp.pubBtn.disabled = running || !d.title.trim() || !d.body.trim();
    }
    [title, summary, tags].forEach(function (n) { n.addEventListener("input", onChange); });
    text.addEventListener("input", function () {
      onChange();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(function () { drawPreview(); drawSide(); }, 200);
    });
    updateCount();

    // The optional help from the site's own model. Nothing here runs unless a button is
    // pressed, and the text goes only to the site's own model, not to an outside service.
    var meAi = state.me && state.me.ai;
    var running = false;
    aiRewrite.disabled = !meAi;
    ai.disabled = !meAi;
    // The model runs as a background job: it takes a few minutes, the page checks on it, and nothing is lost
    // if it is slow. (The older direct routes, which timed out on this server, were removed on 2026-10-10.)
    aiNote.textContent = !meAi
      ? "The site’s AI service is not switched on, so you can write the summary yourself."
      : "Runs in the background on this site’s own model, not an outside service. A summary takes a few minutes and a rewrite two or three minutes a passage; you can stop at any time." +
        (state.me.aiEngineOnline === false ? " The AI service looks offline right now." : "");

    function setBusy(on) {
      running = on;
      aiRewrite.disabled = on || !meAi;
      ai.disabled = on || !meAi;
      text.readOnly = on;
      if (comp.pubBtn) comp.pubBtn.disabled = on || !d.title.trim() || !d.body.trim();
      aiRun.hidden = !on;
    }
    function refreshAll() { summary.value = d.summary; text.value = d.body; updateCount(); drawPreview(); drawSide(); if (running && comp.pubBtn) comp.pubBtn.disabled = true; }

    // ---- as background jobs ----------------------------------------------------------------
    // Watches one job until it ends: asks for it every few seconds, hands each answer to onUpdate, and
    // resolves with {ok, data, stopped} (data = the last answer: job, result or results, left). Stop
    // asks the Worker to cancel and resolves at once with what has arrived. Leaving the page does NOT cancel:
    // the job carries on and the browser remembers it (see saveMemo) so it can be picked up again; the
    // answer is {left: true} and nothing more is painted.
    var watching = null;
    function watchJob(id, onUpdate) {
      return new Promise(function (resolve) {
        var attempt = 0, since = null, last = null, started = Date.now();
        var me = { stop: false, timer: null, wake: null };
        watching = me;
        // Stop should act at once, not on the next scheduled check.
        me.wake = function () { clearTimeout(me.timer); tick(); };
        var finished = false;
        function end(res) { if (finished) return; finished = true; clearTimeout(me.timer); if (watching === me) watching = null; resolve(res); }
        function cancel() { if (!finished) kb("POST", "/ai-job/cancel", { id: id }); }
        function tick() {
          if (finished) return;
          if (!aiRun.isConnected) { end({ ok: false, left: true, message: "", data: last }); return; }
          if (me.stop) { cancel(); end({ ok: true, stopped: true, data: last }); return; }
          kb("GET", "/ai-job?id=" + encodeURIComponent(id) + (since === null ? "" : "&since=" + since)).then(function (r) {
            if (me.stop) { cancel(); end({ ok: true, stopped: true, data: last }); return; }
            if (r.status !== 200) {
              if (r.status === 404 || r.status === 401 || r.status === 403 || attempt > 40) { end({ ok: false, message: describeJobError(r.status, r.json), data: last }); return; }
              attempt++; me.timer = setTimeout(tick, 5000); return;
            }
            if (!r.json.unchanged) { last = r.json; since = r.json.job.rev; }
            if (last) onUpdate(last);
            var st = last && last.job.state;
            if (st === "done" || st === "error" || st === "cancelled") { end({ ok: true, data: last }); return; }
            if (Date.now() - started > 3 * 3600 * 1000) { cancel(); end({ ok: false, message: "This is taking far too long, so the page stopped waiting.", data: last }); return; }
            attempt++;
            me.timer = setTimeout(tick, pollDelayMs(attempt, st));
          });
        }
        tick();
      });
    }
    function paintJob(data, what) {
      aiRunText.textContent = jobStatusText(data.job, what, Date.now());
      aiFill.style.transform = "scaleX(" + jobFraction(data.job).toFixed(3) + ")";
    }

    function runSummaryJob(done) {
      aiNote.textContent = "";
      aiRunText.textContent = "Sending the article to the AI service…";
      var startDraft = { title: d.title, summary: d.summary, tags: d.tags.slice(), body: d.body, accent: d.accent === undefined ? null : d.accent };
      kb("POST", "/ai-job", { type: "summary", title: d.title, body: d.body }).then(function (r) {
        if (r.status !== 202) { aiNote.textContent = describeJobError(r.status, r.json); if (done) done(false); return; }
        saveMemo({ v: 1, id: r.json.job.id, type: "summary", startedAt: Date.now(), mode: comp.mode, editId: comp.editId || null, rev: comp.rev === undefined ? null : comp.rev, alsoSummary: false, todo: [], skipped: 0, draft: startDraft, sources: comp.sources || [] });
        watchSummary(r.json.job.id, done);
      });
    }
    function watchSummary(jobId, done) {
      aiStop.hidden = false;
      {
        watchJob(jobId, function (data) { paintJob(data, "summary"); }).then(function (res) {
          if (res.left) return;
          dropMemo();
          var data = res.data;
          if (res.ok && data && data.result) {
            d.summary = data.result.summary;
            d.body = fmt.withKeyPoints(d.body, data.result.takeaways);
            comp.dirty = true;
            refreshAll();
            aiNote.textContent = "Summary and key points added (" + (data.left === null || data.left === undefined ? "some" : data.left) + " summaries left today). Check they read right.";
            if (done) done(true);
            return;
          }
          aiNote.textContent = res.stopped ? "Stopped." : !res.ok ? (res.message || "") : (data && data.job.error) || "The model did not give a usable summary. Try again, or write it yourself.";
          if (done) done(false);
        });
      }
    }

    ai.addEventListener("click", function () {
      onChange();
      if (!d.body.trim()) return;
      setBusy(true);
      aiRunText.textContent = "Asking the model for a summary…";
      aiFill.style.transform = "scaleX(0.05)";
      aiStop.hidden = true;
      runSummaryJob(function () { aiStop.hidden = false; setBusy(false); });
    });

    // Rewrite the article as one background job: every prose passage (about 90 words; headings, code, tables,
    // pictures and short lines stay exactly as written) goes in a single request with code, links and images
    // already swapped for markers. The page watches the job and applies each passage as it comes back; a rewrite
    // that fails any check is dropped and the author's words stay. Passages beyond what one job takes are left as written.
    function startRewriteJob(alsoSummary) {
      onChange();
      if (running || !d.body.trim()) return;
      var units = fmt.splitForAi(d.body);
      var todo = [];
      units.forEach(function (u, i) { if (u.ai) todo.push(i); });
      if (!todo.length) { aiNote.textContent = "Nothing to rewrite here: it is all headings, code, tables, pictures or short lines."; if (alsoSummary) { setBusy(true); runSummaryJob(function () { setBusy(false); }); } return; }
      var plan = planRewrite(todo, state.me && state.me.limits && state.me.limits.aiRewriteUnits);
      todo = plan.take;
      var prot = todo.map(function (ui) { return fmt.protect(units[ui].text); });
      var startDraft = { title: d.title, summary: d.summary, tags: d.tags.slice(), body: d.body, accent: d.accent === undefined ? null : d.accent };
      setBusy(true);
      aiStop.hidden = true;
      aiRunText.textContent = "Sending " + todo.length + " passage" + (todo.length === 1 ? "" : "s") + " to the AI service…";
      aiFill.style.transform = "scaleX(0.05)";
      kb("POST", "/ai-job", { type: "rewrite", units: todo.map(function (ui, k) { return { heading: units[ui].heading || d.title, text: prot[k].text }; }) }).then(function (r) {
        if (r.status !== 202) { setBusy(false); aiNote.textContent = describeJobError(r.status, r.json); return; }
        saveMemo({ v: 1, id: r.json.job.id, type: "rewrite", startedAt: Date.now(), mode: comp.mode, editId: comp.editId || null, rev: comp.rev === undefined ? null : comp.rev, alsoSummary: !!alsoSummary, todo: todo.slice(), skipped: plan.skipped || 0, draft: startDraft, sources: comp.sources || [] });
        watchRewrite(r.json.job.id, units, todo, prot, plan, alsoSummary);
      });
    }
    // Watches a rewrite job (a new one, or one picked up again) and applies each passage as it comes back.
    function watchRewrite(jobId, units, todo, prot, plan, alsoSummary) {
      var done = 0, kept = 0, applied = {};
      function apply(results) {
        var any = false;
        (results || []).forEach(function (x) {
          if (applied[x.idx] || x.idx >= todo.length) return;
          applied[x.idx] = true;
          any = true;
          var u = units[todo[x.idx]];
          if (x.text !== null && x.text !== undefined) {
            var back = fmt.restore(x.text, prot[x.idx].tokens);
            if (back !== null && fmt.acceptRewrite(u.text, back)) { u.text = back; done++; return; }
          }
          kept++;
        });
        if (any) { d.body = fmt.joinUnits(units); text.value = d.body; drawPreview(); comp.dirty = true; }
      }
      {
        aiStop.hidden = false;
        watchJob(jobId, function (data) { apply(data.results); paintJob(data, "rewrite"); }).then(function (res) {
          if (res.left) return;
          dropMemo();
          if (res.data) apply(res.data.results);
          var job = res.data && res.data.job;
          var halted = !res.ok ? (res.message || "") : res.stopped ? "Stopped." : job && job.state === "error" ? (job.error || "The AI service stopped.") : job && job.state === "cancelled" ? "Stopped." : "";
          var left = res.data && res.data.left !== null && res.data.left !== undefined ? res.data.left : null;
          function after() {
            setBusy(false);
            aiNote.textContent = (halted ? halted + " " : "") + "Rewrote " + done + " of " + todo.length + " passages" + (kept ? "; " + kept + " kept as you wrote them" : "") +
              (plan.skipped ? "; the last " + plan.skipped + " were left as written (a job takes up to " + (todo.length) + ")" : "") +
              (left !== null ? "; " + left + " passage rewrites left today" : "") + ". Read it through before publishing.";
            refreshAll();
          }
          refreshAll();
          if (alsoSummary && !halted) {
            aiRunText.textContent = "Writing the summary and key points…";
            aiFill.style.transform = "scaleX(0.05)";
            aiStop.hidden = true;
            runSummaryJob(function () { aiStop.hidden = false; after(); });
          } else after();
        });
      }
    }

    // A job the person left and came back to: the draft is the one from when it started, so the same passages
    // are worked out again from it and the results are applied as before.
    function resumeJob(m) {
      setBusy(true);
      aiStop.hidden = false;
      aiRunText.textContent = "Picking up where you left off…";
      aiFill.style.transform = "scaleX(0.05)";
      if (m.type === "summary") { watchSummary(m.id, function () { aiStop.hidden = false; setBusy(false); }); return; }
      var units = fmt.splitForAi(d.body);
      var todo = m.todo.filter(function (i) { return i < units.length && units[i].ai; });
      if (todo.length !== m.todo.length) { dropMemo(); setBusy(false); aiNote.textContent = "That draft has changed since the AI started, so its work cannot be put back."; return; }
      watchRewrite(m.id, units, todo, todo.map(function (ui) { return fmt.protect(units[ui].text); }), { skipped: m.skipped }, m.alsoSummary);
    }

    var rewriteNow = startRewriteJob;
    aiRewrite.addEventListener("click", function () { rewriteNow(true); });
    aiStop.addEventListener("click", function () {
      if (watching) { watching.stop = true; aiRunText.textContent = "Stopping…"; watching.wake(); }
    });
    comp.startRewrite = rewriteNow;

    drawPreview();
    drawSide();
    if (comp.resume) { var memo = comp.resume; comp.resume = null; resumeJob(memo); return; }
    if (comp.autoAi) {
      comp.autoAi = false;
      if (meAi) rewriteNow(true);
      else aiNote.textContent = "The site’s AI model is not connected, so this draft was not rewritten. You can edit it by hand and publish.";
    }
  }

  function publish(button, allowPii) {
    var d = comp.draft;
    var edit = comp.mode === "edit";
    var body = { title: d.title.trim(), summary: d.summary.trim(), body: d.body, tags: d.tags };
    if (d.accent !== null && d.accent !== undefined) body.accent = d.accent;
    if (allowPii) body.allowPii = true;
    if (edit) body.baseRev = comp.rev;
    button.disabled = true;
    comp.status(edit ? "Saving…" : "Publishing…", false);
    var req = edit ? kb("PATCH", "/article?id=" + encodeURIComponent(comp.editId), body) : kb("POST", "/article", body);
    req.then(function (r) {
      button.disabled = false;
      if (r.status === 200 || r.status === 201) {
        comp.dirty = false;
        state.loaded = false;
        toast(edit ? "Changes saved" : "Article published");
        location.hash = "#/a/" + r.json.article.id;
        return;
      }
      if (r.json.error === "pii_detected") { confirmPii(r.json.kinds, button); comp.status("", false); return; }
      comp.status(describeError(r.status, r.json), true);
      if (r.json.error === "recent_sign_in_required") {
        var a = el("a", "btn", comp.statusEl.parentNode, "Log in again");
        a.href = loginUrl();
      }
    });
  }

  function confirmPii(kinds, button) {
    openDialog("Personal details found", function (body) {
      el("p", "", body, "The text seems to include " + describePii(kinds) + ". Everyone who can sign in here would be able to read them.");
      el("p", "", body, "If that is fine (for example a shared support address), publish anyway. Otherwise go back and take them out.");
    }, function (foot) {
      btn("Go back and edit", "btn", foot, function () { $("kb-dialog").close(); });
      btn("Publish anyway", "btn kb-danger", foot, function () { $("kb-dialog").close(); publish(button, true); });
    });
  }

  // ---------------------------------------------------------------- routing and start

  function route() {
    var r = parseRoute(location.hash);
    if (comp && comp.dirty && r.view !== "new" && r.view !== "edit") {
      var text = loadMemo() ? "Leave without publishing? The AI keeps working, and you can pick the draft up again from the Knowledgebase page for the next few hours. Anything else in it will be lost." : "Leave without publishing? Your draft will be lost.";
      if (!root.confirm(text)) { location.hash = comp.mode === "edit" ? "#/edit/" + comp.editId : "#/new"; return; }
    }
    if (r.view !== "new" && r.view !== "edit") comp = null;
    if (r.view === "article") { openArticle(r.id); return; }
    if (r.view === "new") { if (comp && comp.mode === "new" && comp.step === "edit") return; startNew(r.notes, r.ai); return; }
    if (r.view === "edit") { if (comp && comp.mode === "edit" && comp.editId === r.id) return; startEdit(r.id); return; }
    renderLibrary();
    loadLibrary().then(function (ok) {
      if (ok && parseRoute(location.hash).view === "library") { renderTagRow(); renderResults(); }
    });
  }

  function init() {
    $("kb-dialog-close").addEventListener("click", function () { $("kb-dialog").close(); });
    root.addEventListener("hashchange", route);
    root.addEventListener("beforeunload", function (e) { if (compDirty()) { e.preventDefault(); e.returnValue = ""; } });

    kb("GET", "/me").then(function (r) {
      if (r.status === 401) { showGate("Log in to read the Knowledgebase.", true); return; }
      if (r.status === 403) { showGate("Your account does not have access to the study site.", false); return; }
      if (r.status !== 200) { showGate(r.status === 0 ? "Could not reach the server. Check your connection and reload." : "The Knowledgebase is unavailable right now (" + (r.json.error || r.status) + ").", false); return; }
      state.me = r.json;
      $("kb-gate").hidden = true;
      $("kb").hidden = false;
      if (root.BarnyardShell && root.BarnyardShell.setSearchSource) {
        root.BarnyardShell.setSearchSource(function () {
          return state.items.map(function (i) { return { title: i.title, hint: "Knowledgebase", go: function () { location.hash = "#/a/" + i.id; } }; });
        });
      }
      route();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(typeof window !== "undefined" ? window : this);
