// Study page (index.html): revision material from a vendor link.
//
// The person pastes a link (a Microsoft Learn module or study guide, an AWS or Google Cloud doc, ...),
// picks what to make, and the page asks the Worker (POST /study/generate, see ClaudeRepo's
// cloudflare-worker README, "Study: revision material from a vendor link"). The Worker reads the
// page and asks Claude; what comes back is notes, flashcards and practice questions, shown here and
// optionally saved to the private notebook (the same /notebook/note the Notes page uses).
//
// Everything that came from the server is put on the page with createElement/textContent, never
// innerHTML: the material is model-written from a web page, so it is data, not markup. The page's
// CSP has no 'unsafe-inline' either.
//
// Layout: 1. pure helpers (tested in test/study.test.js)  2. the page.

(function (root) {
  "use strict";

  var API = "https://api.barnyard.site";
  var KINDS = [
    { key: "notes", label: "Notes" },
    { key: "flashcards", label: "Flashcards" },
    { key: "quiz", label: "Practice questions" }
  ];
  var GENERATE_TIMEOUT_MS = 100000;

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
    disabled: "Revision material is switched off at the moment.",
    not_configured: "Revision material isn’t set up on the server yet.",
    host_not_allowed: "That site isn’t on the list this page can read. It works with Microsoft Learn, AWS, Google Cloud and a few other vendors’ own documentation.",
    url_not_https: "Use an address that starts with https://.",
    url_invalid: "That doesn’t look like a page address.",
    kinds_invalid: "Pick at least one thing to make.",
    source_redirected_away: "That link goes somewhere this page can’t read.",
    source_not_a_page: "That link isn’t a web page this page can read.",
    source_too_thin: "There’s not enough text on that page to make revision material from. Try the module’s own page, or a study guide.",
    source_unavailable: "That page couldn’t be opened. Check the link.",
    source_unreachable: "That page couldn’t be reached right now. Try again in a moment.",
    daily_limit: "You’ve used today’s allowance. It resets tomorrow.",
    generation_failed: "Claude couldn’t make anything from that page this time. Try again.",
    recent_sign_in_required: "For safety this needs a recent sign-in. Log in again, then retry.",
    secret_detected: "That looks like it contains a password or key, so it was not saved."
  };

  // -> { text, login } : what to tell the person; login says to offer the log in button.
  function errorText(code, status) {
    if (status === 401) return { text: "Log in to make revision material.", login: true };
    if (status === 403 && (!code || code === "forbidden")) return { text: "Your account isn’t set up for Study.", login: false };
    if (code && ERRORS[code]) return { text: ERRORS[code], login: code === "recent_sign_in_required" };
    if (status === 0) return { text: "Couldn’t reach the server. Try again.", login: false };
    return { text: "That didn’t work. Try again.", login: false };
  }

  function letter(i) { return "abcd".charAt(i); }

  // How the person is doing on the practice questions: picks is {questionIndex: choiceIndex}.
  function scoreQuiz(questions, picks) {
    var answered = 0, correct = 0;
    for (var i = 0; i < questions.length; i++) {
      if (picks[i] === undefined) continue;
      answered++;
      if (picks[i] === questions[i].answer) correct++;
    }
    return { answered: answered, correct: correct, total: questions.length };
  }

  function scoreText(s) {
    if (!s.answered) return "Pick an answer for each question.";
    return s.correct + " of " + s.answered + " correct" + (s.answered < s.total ? " so far (" + s.total + " questions)" : "") + ".";
  }

  // The whole result as Markdown, for the notebook. Only the kinds that were made are included.
  function toMarkdown(result, url) {
    var out = ["# " + (result.title || "Revision material"), ""];
    if (url) out.push("Source: " + url, "");
    if (result.notes && result.notes.length) {
      out.push("## Notes", "");
      result.notes.forEach(function (s) {
        out.push("### " + s.heading, "");
        s.items.forEach(function (i) { out.push("- " + i); });
        out.push("");
      });
    }
    if (result.flashcards && result.flashcards.length) {
      out.push("## Flashcards", "");
      result.flashcards.forEach(function (c) { out.push("- **" + c.front + "** — " + c.back); });
      out.push("");
    }
    if (result.quiz && result.quiz.length) {
      out.push("## Practice questions", "");
      result.quiz.forEach(function (q, n) {
        out.push((n + 1) + ". " + q.question);
        q.choices.forEach(function (c, i) { out.push("   - " + letter(i) + ") " + c); });
        out.push("   - **Answer: " + letter(q.answer) + ".**" + (q.why ? " " + q.why : ""));
      });
      out.push("");
    }
    return out.join("\n");
  }

  function sourceLine(result) {
    var s = result.source || {};
    var bits = [];
    if (s.host) bits.push("From " + s.host);
    if (s.pages > 1) bits.push(s.pages + " pages read");
    if (s.truncated) bits.push("only the start of a long page was used");
    if (result.failed && result.failed.length) {
      var names = result.failed.map(function (k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i].key === k) return KINDS[i].label.toLowerCase(); return k; });
      bits.push("couldn’t make " + names.join(" or "));
    }
    return bits.join(" · ");
  }

  var helpers = { normalizeLink: normalizeLink, errorText: errorText, scoreQuiz: scoreQuiz, scoreText: scoreText, toMarkdown: toMarkdown, sourceLine: sourceLine, letter: letter, KINDS: KINDS };
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. the page -------------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function loginUrl() { return typeof root.barnyardLoginUrl === "function" ? root.barnyardLoginUrl() : API + "/auth/login"; }

  var state = { result: null, url: "", tab: "notes", picks: {}, saving: false };

  function showGate(msg, login) {
    $("gen-gate").hidden = !msg;
    $("gen-gate-msg").textContent = msg || "";
    var a = $("gen-gate-login");
    a.hidden = !login;
    if (login) a.href = loginUrl();
  }

  function say(text) { $("gen-status").textContent = text || ""; }

  function call(method, path, body, timeoutMs) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 20000);
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {}, signal: ctl.signal };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j || {} }; });
    }, function () { return { status: 0, json: {} }; }).then(function (x) { clearTimeout(timer); return x; });
  }

  // ---- result panels

  function notesPanel(notes) {
    var box = el("div", "gen-notes");
    notes.forEach(function (s) {
      box.appendChild(el("h3", null, s.heading));
      var ul = el("ul");
      s.items.forEach(function (i) { ul.appendChild(el("li", null, i)); });
      box.appendChild(ul);
    });
    return box;
  }

  function cardsPanel(cards) {
    var box = el("div");
    var bar = el("div", "gen-actions");
    var all = el("button", "btn", "Show all answers");
    all.type = "button";
    var showing = false;
    var nodes = [];
    all.addEventListener("click", function () {
      showing = !showing;
      nodes.forEach(function (n) { setFlipped(n, showing); });
      all.textContent = showing ? "Hide all answers" : "Show all answers";
    });
    bar.appendChild(all);
    bar.appendChild(el("span", "gen-note", cards.length + " cards. Click a card to turn it over."));
    box.appendChild(bar);
    var grid = el("div", "gen-cards");
    cards.forEach(function (c) {
      var b = el("button", "gen-card");
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      var front = el("span", "gen-card-front", c.front);
      var back = el("span", "gen-card-back", c.back);
      back.hidden = true;
      b.appendChild(front); b.appendChild(back);
      b._front = front; b._back = back;
      b.addEventListener("click", function () { setFlipped(b, !!back.hidden); });
      nodes.push(b);
      grid.appendChild(b);
    });
    box.appendChild(grid);
    return box;
  }

  function setFlipped(b, flipped) {
    b._front.hidden = flipped;
    b._back.hidden = !flipped;
    b.setAttribute("aria-pressed", flipped ? "true" : "false");
    b.classList.toggle("is-flipped", flipped);
  }

  function quizPanel(questions) {
    var box = el("div");
    var score = el("p", "gen-score", scoreText(scoreQuiz(questions, {})));
    score.setAttribute("role", "status");
    box.appendChild(score);
    state.picks = {};
    questions.forEach(function (q, n) {
      var item = el("div", "gen-q");
      item.appendChild(el("p", "gen-q-text", (n + 1) + ". " + q.question));
      var list = el("div", "gen-choices");
      var why = el("p", "gen-why");
      why.hidden = true;
      var buttons = [];
      q.choices.forEach(function (c, i) {
        var b = el("button", "gen-choice", letter(i) + ") " + c);
        b.type = "button";
        b.addEventListener("click", function () {
          state.picks[n] = i;
          buttons.forEach(function (x, j) {
            x.disabled = true;
            if (j === q.answer) x.classList.add("is-right");
            else if (j === i) x.classList.add("is-wrong");
          });
          why.textContent = (i === q.answer ? "Correct. " : "Not quite: the answer is " + letter(q.answer) + ". ") + (q.why || "");
          why.hidden = false;
          score.textContent = scoreText(scoreQuiz(questions, state.picks));
        });
        buttons.push(b);
        list.appendChild(b);
      });
      item.appendChild(list);
      item.appendChild(why);
      box.appendChild(item);
    });
    return box;
  }

  function renderPanel() {
    var r = state.result, panel = $("gen-panel");
    clear(panel);
    if (!r || !r[state.tab]) return;
    panel.appendChild(state.tab === "notes" ? notesPanel(r.notes) : state.tab === "flashcards" ? cardsPanel(r.flashcards) : quizPanel(r.quiz));
  }

  function renderTabs() {
    var tabs = $("gen-tabs");
    clear(tabs);
    KINDS.forEach(function (k) {
      if (!state.result[k.key]) return;
      var b = el("button", "gen-tab", k.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", state.tab === k.key ? "true" : "false");
      b.addEventListener("click", function () { state.tab = k.key; renderTabs(); renderPanel(); });
      tabs.appendChild(b);
    });
  }

  function showResult(result, url) {
    state.result = result; state.url = url;
    state.tab = KINDS.filter(function (k) { return result[k.key]; })[0].key;
    $("gen-title").textContent = result.title || "Revision material";
    $("gen-source").textContent = sourceLine(result);
    $("gen-open-note").hidden = true;
    $("gen-save").disabled = false;
    $("gen-save").textContent = "Save to my notes";
    $("gen-result").hidden = false;
    renderTabs();
    renderPanel();
  }

  // ---- actions

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
    say("Reading the page and writing your material. This can take up to a minute…");
    call("POST", "/study/generate", { url: link, kinds: kinds }, GENERATE_TIMEOUT_MS).then(function (r) {
      go.disabled = false;
      if (r.status === 200 && r.json) { say(""); showResult(r.json, link); $("gen-result").scrollIntoView({ block: "start" }); return; }
      var e = errorText(r.json && r.json.error, r.status);
      say("");
      showGate(e.text, e.login);
    });
  }

  function onSave() {
    if (!state.result || state.saving) return;
    state.saving = true;
    var btn = $("gen-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    var title = ("Revision: " + (state.result.title || "material")).slice(0, 200);
    call("POST", "/notebook/note", { title: title, body: toMarkdown(state.result, state.url), tags: ["revision"] }).then(function (r) {
      state.saving = false;
      if (r.status === 201 && r.json && r.json.note && r.json.note.id) {
        btn.textContent = "Saved";
        var a = $("gen-open-note");
        a.href = "notes.html#" + encodeURIComponent(r.json.note.id);
        a.hidden = false;
        return;
      }
      btn.disabled = false;
      btn.textContent = "Save to my notes";
      var e = errorText(r.json && r.json.error, r.status);
      showGate(e.text, e.login);
    });
  }

  $("gen-form").addEventListener("submit", onSubmit);
  $("gen-save").addEventListener("click", onSave);
})(typeof window !== "undefined" ? window : this);
