// The study notebook (notes.html): private Markdown notes kept on the Worker
// (api.barnyard.site/notebook/*), one notebook per login. See markdown.js for how
// note text is rendered (DOM nodes only, never innerHTML) and
// ClaudeRepo/cloudflare-worker/README.md "Study notebook" for the server side.
//
// Saving: edits are sent after a short pause with the revision they were made
// against (`baseRev`). If the note changed somewhere else the server answers 409
// and this page asks what to do -- it never overwrites silently.
//
// Plain script, no build step. Under Node only the pure helpers are exported (for
// test/notes.test.js); the page code runs when a `document` exists.
(function (root) {
  "use strict";

  var API = "https://api.barnyard.site/notebook";
  var AUTOSAVE_MS = 1200;
  var PREVIEW_MS = 150;
  var SEARCH_MS = 250;
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  var IMAGE_TYPES = { "image/png": 1, "image/jpeg": 1, "image/gif": 1, "image/webp": 1 };

  // ------------------------------------------------------------ pure helpers

  // Items (from /tree) -> { children: {parentId|"": [item...]}, byId }. Folders first, then A-Z.
  function buildTree(items) {
    var byId = {}, children = { "": [] };
    items.forEach(function (it) { byId[it.id] = it; });
    items.forEach(function (it) {
      var p = it.parent && byId[it.parent] && byId[it.parent].kind === "folder" ? it.parent : "";
      (children[p] = children[p] || []).push(it);
    });
    Object.keys(children).forEach(function (k) {
      children[k].sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
      });
    });
    return { children: children, byId: byId };
  }

  // Ids of a folder and everything under it (a folder cannot be moved into itself).
  function subtreeIds(tree, id) {
    var out = [id], queue = [id];
    while (queue.length) {
      var kids = tree.children[queue.shift()] || [];
      kids.forEach(function (k) { out.push(k.id); queue.push(k.id); });
    }
    return out;
  }

  // Enter pressed at `caret` in `text`: continue a list item, or end the list on an empty one.
  // -> { text, caret } or null when the key should behave normally.
  function listEnter(text, caret) {
    var start = text.lastIndexOf("\n", caret - 1) + 1;
    var line = text.slice(start, caret);
    var m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!m) {
      var q = /^(\s*>\s?)(.*)$/.exec(line);
      if (!q) return null;
      if (!q[2]) return { text: text.slice(0, start) + text.slice(caret), caret: start };
      var qIns = "\n" + q[1];
      return { text: text.slice(0, caret) + qIns + text.slice(caret), caret: caret + qIns.length };
    }
    if (!m[5]) return { text: text.slice(0, start) + text.slice(caret), caret: start }; // empty item: leave the list
    var marker = m[2];
    if (/\d/.test(marker.charAt(0))) marker = (parseInt(marker, 10) + 1) + marker.slice(-1);
    var ins = "\n" + m[1] + marker + m[3] + (m[4] ? "[ ] " : "");
    return { text: text.slice(0, caret) + ins + text.slice(caret), caret: caret + ins.length };
  }

  // Wrap the selection (or insert the marks around the caret). -> { text, selStart, selEnd }
  function wrapSelection(text, a, b, before, after, placeholder) {
    var sel = text.slice(a, b) || placeholder || "";
    var out = text.slice(0, a) + before + sel + after + text.slice(b);
    return { text: out, selStart: a + before.length, selEnd: a + before.length + sel.length };
  }

  // Put `prefix` at the start of every selected line. Lines that already have it lose it.
  function prefixLines(text, a, b, prefix) {
    var s = text.lastIndexOf("\n", a - 1) + 1;
    var e = text.indexOf("\n", b);
    if (e === -1) e = text.length;
    var lines = text.slice(s, e).split("\n");
    var all = lines.every(function (l) { return l.indexOf(prefix) === 0; });
    var next = lines.map(function (l) { return all ? l.slice(prefix.length) : prefix + l; }).join("\n");
    return { text: text.slice(0, s) + next + text.slice(e), selStart: s, selEnd: s + next.length };
  }

  var SLASH = [
    { id: "h1", label: "Heading 1", insert: "# " },
    { id: "h2", label: "Heading 2", insert: "## " },
    { id: "h3", label: "Heading 3", insert: "### " },
    { id: "bullet", label: "Bulleted list", insert: "- " },
    { id: "number", label: "Numbered list", insert: "1. " },
    { id: "todo", label: "To-do list", insert: "- [ ] " },
    { id: "quote", label: "Quote", insert: "> " },
    { id: "note", label: "Callout: note", insert: "> [!NOTE] " },
    { id: "tip", label: "Callout: tip", insert: "> [!TIP] " },
    { id: "warning", label: "Callout: warning", insert: "> [!WARNING] " },
    { id: "code", label: "Code block", insert: "```\n\n```", caretBack: 4 },
    { id: "table", label: "Table", insert: "| Column | Column |\n| --- | --- |\n| | |\n", caretBack: 0 },
    { id: "divider", label: "Divider", insert: "---\n" },
    { id: "link", label: "Link card (paste a web address)", insert: "https://" },
    { id: "wiki", label: "Link to a note", insert: "[[" },
    { id: "image", label: "Image from your computer", action: "image", insert: "" },
  ];

  function slashMatches(query) {
    var q = query.toLowerCase();
    return SLASH.filter(function (c) { return !q || c.id.indexOf(q) === 0 || c.label.toLowerCase().indexOf(q) !== -1; });
  }

  // What the caret is in the middle of: a slash command at the start of a line, or an open [[link.
  function triggerAt(text, caret) {
    var start = text.lastIndexOf("\n", caret - 1) + 1;
    var line = text.slice(start, caret);
    var s = /^(\s*)\/([a-z0-9 ]{0,20})$/i.exec(line);
    if (s) return { kind: "slash", query: s[2], from: start + s[1].length, to: caret };
    var w = /\[\[([^\]\n|]{0,100})$/.exec(line);
    if (w) return { kind: "wiki", query: w[1], from: caret - w[1].length - 2, to: caret };
    return null;
  }

  function fileNameFor(title) {
    var base = String(title || "note").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return (base || "note") + ".md";
  }

  var helpers = {
    buildTree: buildTree, subtreeIds: subtreeIds, listEnter: listEnter, wrapSelection: wrapSelection,
    prefixLines: prefixLines, slashMatches: slashMatches, triggerAt: triggerAt, fileNameFor: fileNameFor,
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---------------------------------------------------------------- the page

  var md = root.BarnyardMarkdown;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    items: [], tree: null, titleToId: {},
    cur: null,            // the open note or folder: { note, backlinks, revisions }
    sentBody: "", sentTitle: "", sentTags: "",
    saving: false, dirty: false, conflict: false, blocked: "",
    mode: "split", query: "", expanded: {},
  };
  var timers = { save: null, preview: null, search: null, retry: null };
  var chain = Promise.resolve();

  function store(key, value) { try { if (value === undefined) return root.localStorage.getItem(key); root.localStorage.setItem(key, value); } catch (e) { return null; } return null; }

  function el(name, cls, parent, txt) {
    var e = document.createElement(name);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- talking to the Worker

  function call(method, path, body, raw) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (raw) { opts.body = raw.body; opts.headers["Content-Type"] = raw.type; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j || {} }; });
    }, function () { return { status: 0, json: {} }; });
  }

  function loginUrl() { return typeof root.barnyardLoginUrl === "function" ? root.barnyardLoginUrl() : "https://api.barnyard.site/auth/login"; }

  function showGate(msg, login) {
    $("nb").hidden = true;
    $("nb-gate").hidden = false;
    $("nb-gate-msg").textContent = msg;
    var a = $("nb-gate-login");
    a.hidden = !login;
    if (login) a.href = loginUrl();
  }

  var ERRORS = {
    recent_sign_in_required: "For safety this needs a recent sign-in. Log in again, then retry.",
    rate_limited: "Too many changes too quickly. Wait a moment and retry.",
    notebook_full: "The notebook is full (3,000 notes and folders).",
    secret_detected: "That looks like it contains a password or key, so it was not saved.",
    too_deep: "Folders can only go 8 levels deep.",
    parent_cycle: "A folder cannot go inside itself.",
    storage_full: "Image storage is full.",
    images_full: "Too many images in this notebook.",
    image_type_invalid: "Only PNG, JPEG, GIF and WebP images can be added.",
    image_invalid: "That file is not a valid image.",
    image_too_large: "Images can be up to 8 MB.",
  };
  function explain(r) { return (r.json && ERRORS[r.json.error]) || (r.status === 0 ? "Could not reach the server." : "Something went wrong (" + (r.json.error || r.status) + ")."); }

  // ---- status line

  function setStatus(text, kind) {
    ["nb-status", "nb-folder-status"].forEach(function (id) {
      var s = $(id);
      s.textContent = text;
      s.className = "nb-status" + (kind ? " " + kind : "");
    });
  }

  // ---- sidebar

  function rebuildIndex() {
    state.tree = buildTree(state.items);
    state.titleToId = {};
    state.items.forEach(function (it) {
      if (it.kind === "note" && !state.titleToId[it.title.toLowerCase()]) state.titleToId[it.title.toLowerCase()] = it.id;
    });
  }

  function itemButton(it, depth, parent) {
    var li = el("li", "", parent);
    var b = el("button", "nb-row" + (state.cur && state.cur.note.id === it.id ? " active" : ""), li);
    b.type = "button";
    b.setAttribute("data-id", it.id);
    b.setAttribute("data-depth", String(Math.min(depth, 8)));
    if (it.kind === "folder") {
      var open = !!state.expanded[it.id];
      b.setAttribute("aria-expanded", open ? "true" : "false");
      el("span", "nb-ico", b, open ? "▾" : "▸");
    } else el("span", "nb-ico", b, "•");
    el("span", "nb-row-title", b, it.title);
    if (it.pii && it.pii.length) { var w = el("span", "nb-pii", b, "personal data"); w.title = "This note seems to contain: " + it.pii.join(", "); }
    return li;
  }

  function renderBranch(parentId, depth, ul) {
    (state.tree.children[parentId] || []).forEach(function (it) {
      var li = itemButton(it, depth, ul);
      if (it.kind === "folder" && state.expanded[it.id]) {
        var sub = el("ul", "nb-list", li);
        renderBranch(it.id, depth + 1, sub);
      }
    });
  }

  function renderTree() {
    var nav = $("nb-tree");
    clear(nav);
    if (state.query) return;
    var pinned = state.items.filter(function (i) { return i.pinned && i.kind === "note"; });
    if (pinned.length) {
      el("h2", "nb-h", nav, "Pinned");
      var pul = el("ul", "nb-list", nav);
      pinned.forEach(function (it) { itemButton(it, 0, pul); });
      el("h2", "nb-h", nav, "All notes");
    }
    var ul = el("ul", "nb-list", nav);
    renderBranch("", 0, ul);
    if (!state.items.length) el("p", "nb-hint", nav, "Nothing here yet. Start with New note.");
  }

  function renderResults(results) {
    var nav = $("nb-tree");
    clear(nav);
    el("h2", "nb-h", nav, results.length ? "Results" : "No matches");
    var ul = el("ul", "nb-list", nav);
    results.forEach(function (r) {
      var li = el("li", "", ul);
      var b = el("button", "nb-row nb-result", li);
      b.type = "button";
      b.setAttribute("data-id", r.id);
      el("span", "nb-row-title", b, r.title);
      if (r.snippet) el("span", "nb-snippet", b, r.snippet);
    });
  }

  function refreshTree() {
    return call("GET", "/tree").then(function (r) {
      if (r.status === 401) { showGate("Log in to use your notes.", true); return false; }
      if (r.status === 403) { showGate("Your account isn’t set up for the study notebook.", false); return false; }
      if (r.status !== 200) { showGate("The notebook could not be loaded (" + explain(r) + ") Try again in a moment.", false); return false; }
      state.items = r.json.items || [];
      rebuildIndex();
      renderTree();
      return true;
    });
  }

  // ---- opening things

  function show(which) {
    $("nb-empty").hidden = which !== "empty";
    $("nb-editor").hidden = which !== "note";
    $("nb-folder").hidden = which !== "folder";
  }

  function findNoteId(title) { return state.titleToId[String(title).toLowerCase()] || null; }

  function imageUrl(id) { return API + "/image?id=" + encodeURIComponent(id); }

  function renderPreview() {
    var host = $("nb-preview");
    clear(host);
    var tree = md.parse($("nb-text").value);
    host.appendChild(md.toDom(tree, document, { imageUrl: imageUrl, findNote: findNoteId }));
    buildOutline(host);
  }

  function buildOutline(host) {
    var heads = host.querySelectorAll("h1, h2, h3");
    var det = $("nb-outline"), list = $("nb-outline-list");
    clear(list);
    det.hidden = heads.length < 3;
    Array.prototype.forEach.call(heads, function (h, i) {
      h.setAttribute("data-h", String(i));
      var li = el("li", "lvl" + h.tagName.charAt(1), list);
      var b = el("button", "nb-link", li, h.textContent);
      b.type = "button";
      b.setAttribute("data-h", String(i));
    });
  }

  function renderBacklinks() {
    var list = $("nb-backlinks-list");
    clear(list);
    var back = (state.cur && state.cur.backlinks) || [];
    $("nb-backlinks").hidden = !back.length;
    back.forEach(function (b) {
      var li = el("li", "", list);
      var a = el("a", "wiki", li, b.title);
      a.href = "#" + b.id;
      a.setAttribute("data-note", b.id);
    });
  }

  function setMode(mode) {
    state.mode = mode;
    $("nb-panes").setAttribute("data-mode", mode);
    Array.prototype.forEach.call(document.querySelectorAll(".nb-modes button"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-mode") === mode ? "true" : "false");
    });
    store("nb.mode", mode);
  }

  function applyNote(data) {
    state.cur = data;
    var n = data.note;
    state.sentBody = n.body || "";
    state.sentTitle = n.title;
    state.sentTags = (n.tags || []).join(", ");
    state.dirty = false; state.conflict = false; state.blocked = "";
    $("nb-conflict").hidden = true;
    clearTimeout(timers.save);
    if (n.kind === "folder") {
      show("folder");
      $("nb-folder-title").value = n.title;
      renderFolderList(n.id);
    } else {
      show("note");
      $("nb-title").value = n.title;
      $("nb-text").value = n.body || "";
      $("nb-tags").value = state.sentTags;
      var pin = $("nb-pin");
      pin.setAttribute("aria-pressed", n.pinned ? "true" : "false");
      pin.textContent = n.pinned ? "Unpin" : "Pin";
      renderPreview();
      renderBacklinks();
    }
    setStatus(n.deletedAt ? "In the trash" : "Saved " + new Date(n.updatedAt).toLocaleString(), "");
    renderTree();
  }

  function renderFolderList(id) {
    var ul = $("nb-folder-list");
    clear(ul);
    var kids = (state.tree.children[id] || []);
    if (!kids.length) el("li", "nb-hint", ul, "This folder is empty.");
    kids.forEach(function (k) { itemButton(k, 0, ul); });
  }

  function openItem(id, quiet) {
    if (!/^nt_[a-z0-9]{8}$/.test(id)) return Promise.resolve();
    return flush().then(function () {
      return call("GET", "/note?id=" + id).then(function (r) {
        if (r.status !== 200) { if (!quiet) setStatus(r.status === 404 ? "That note no longer exists." : explain(r), "warn"); return; }
        applyNote(r.json);
        if (location.hash !== "#" + id) { try { history.replaceState(null, "", "#" + id); } catch (e) { /* ignore */ } }
        if (root.matchMedia && root.matchMedia("(max-width: 900px)").matches) collapseSide(true);
      });
    });
  }

  function collapseSide(collapsed) {
    $("nb-side").classList.toggle("collapsed", collapsed);
    $("nb-side-toggle").setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  // ---- saving (one write at a time, in order)

  function enqueue(fn) { chain = chain.then(fn, fn); return chain; }

  function currentFields() {
    if (!state.cur) return null;
    var n = state.cur.note, f = {};
    if (n.kind === "folder") {
      var ft = $("nb-folder-title").value.trim();
      if (ft && ft !== state.sentTitle) f.title = ft;
      return f;
    }
    var t = $("nb-title").value.trim();
    if (t && t !== state.sentTitle) f.title = t;
    var body = $("nb-text").value;
    if (body !== state.sentBody) f.body = body;
    var tags = parseTags($("nb-tags").value);
    if (tags.join(", ") !== state.sentTags) f.tags = tags;
    return f;
  }

  function parseTags(s) {
    var out = [];
    s.split(",").forEach(function (t) { t = t.trim().toLowerCase(); if (t && out.indexOf(t) === -1) out.push(t); });
    return out.slice(0, 12);
  }

  function save(extra) {
    return enqueue(function () {
      if (!state.cur || state.conflict) return Promise.resolve(false);
      var fields = currentFields();
      for (var k in (extra || {})) fields[k] = extra[k];
      if (!Object.keys(fields).length) { state.dirty = false; return Promise.resolve(true); }
      var n = state.cur.note;
      var body = { baseRev: n.rev };
      for (var key in fields) body[key] = fields[key];
      setStatus("Saving…", "");
      state.saving = true;
      return call("PATCH", "/note?id=" + n.id, body).then(function (r) {
        state.saving = false;
        if (r.status === 200) {
          var wasBody = body.body, wasTitle = body.title;
          state.cur.note = r.json.note;
          state.cur.backlinks = r.json.backlinks; state.cur.revisions = r.json.revisions;
          if (wasBody !== undefined) state.sentBody = wasBody;
          if (wasTitle !== undefined) state.sentTitle = wasTitle;
          if (body.tags !== undefined) state.sentTags = body.tags.join(", ");
          state.blocked = "";
          var again = currentFields();
          state.dirty = !!Object.keys(again).length;
          if (state.dirty) schedule();
          setStatus(state.dirty ? "Unsaved changes" : "Saved " + new Date(r.json.note.updatedAt).toLocaleTimeString(), state.dirty ? "warn" : "ok");
          var idx = state.items.filter(function (i) { return i.id === n.id; })[0];
          if (idx) { var m = r.json.note; idx.title = m.title; idx.pinned = m.pinned; idx.parent = m.parent; idx.tags = m.tags; idx.pii = m.pii; idx.rev = m.rev; rebuildIndex(); renderTree(); }
          if (n.kind === "note") { $("nb-pin").setAttribute("aria-pressed", r.json.note.pinned ? "true" : "false"); $("nb-pin").textContent = r.json.note.pinned ? "Unpin" : "Pin"; }
          return true;
        }
        if (r.status === 409 && r.json.error === "conflict") { showConflict(); return false; }
        if (r.status === 422 && r.json.error === "secret_detected") {
          state.blocked = "This note looks like it contains a " + String(r.json.kind || "credential").replace(/_/g, " ") + " (in the " + r.json.field + "), so it was not saved. Remove it and saving will resume.";
          setStatus("Not saved — " + state.blocked, "bad");
          return false;
        }
        if (r.status === 401) { setStatus("You were signed out — your last changes are not saved. Log in again in another tab, then keep typing.", "bad"); state.dirty = true; return false; }
        if (r.status === 0 || r.status === 429 || r.status >= 500) {
          setStatus((r.status === 0 ? "Offline" : "Server busy") + " — will retry", "warn");
          state.dirty = true;
          clearTimeout(timers.retry);
          timers.retry = setTimeout(function () { save(); }, 5000);
          return false;
        }
        setStatus("Not saved — " + explain(r), "bad");
        state.dirty = true;
        return false;
      });
    });
  }

  function schedule() {
    state.dirty = true;
    if (!state.blocked) setStatus("Unsaved changes", "warn");
    clearTimeout(timers.save);
    timers.save = setTimeout(function () { save(); }, AUTOSAVE_MS);
  }

  function flush() {
    clearTimeout(timers.save);
    return state.dirty && state.cur && !state.conflict && !state.blocked ? save() : chain;
  }

  function showConflict() {
    state.conflict = true;
    var box = $("nb-conflict");
    clear(box);
    el("p", "", box, "This note was changed somewhere else (another tab or device) since you opened it. Your edits here are not saved yet.");
    var keep = el("button", "btn", box, "Keep mine as a new note");
    keep.type = "button";
    keep.addEventListener("click", function () {
      var fields = currentFields();
      call("POST", "/note", { title: ((fields.title || state.sentTitle) + " (my version)").slice(0, 200), body: $("nb-text").value, parent: state.cur.note.parent }).then(function (r) {
        if (r.status === 201) { state.dirty = false; state.conflict = false; refreshTree().then(function () { openItem(r.json.note.id); }); }
        else setStatus("Could not make the copy: " + explain(r), "bad");
      });
    });
    var take = el("button", "btn", box, "Load the latest (discard mine)");
    take.type = "button";
    take.addEventListener("click", function () {
      state.dirty = false; state.conflict = false;
      call("GET", "/note?id=" + state.cur.note.id).then(function (r) { if (r.status === 200) applyNote(r.json); });
    });
    box.hidden = false;
    setStatus("Not saved — note changed elsewhere", "bad");
  }

  // ---- creating, moving, deleting

  function create(fields) {
    return flush().then(function () {
      return call("POST", "/note", fields).then(function (r) {
        if (r.status !== 201) { setStatus(explain(r), "bad"); return null; }
        var n = r.json.note;
        state.items.push({ id: n.id, parent: n.parent, kind: n.kind, title: n.title, tags: n.tags, pinned: n.pinned, rev: n.rev, pii: n.pii });
        if (n.parent) state.expanded[n.parent] = true;
        rebuildIndex();
        applyNote(r.json);
        try { history.replaceState(null, "", "#" + n.id); } catch (e) { /* ignore */ }
        return n;
      });
    });
  }

  function parentForNew() {
    if (!state.cur) return null;
    return state.cur.note.kind === "folder" ? state.cur.note.id : state.cur.note.parent;
  }

  function newNote(parent) {
    create({ title: "Untitled", body: "", kind: "note", parent: parent === undefined ? parentForNew() : parent }).then(function (n) {
      if (n) { $("nb-title").focus(); $("nb-title").select(); }
    });
  }
  function newFolder(parent) {
    create({ title: "New folder", kind: "folder", parent: parent === undefined ? parentForNew() : parent }).then(function (n) {
      if (n) { $("nb-folder-title").focus(); $("nb-folder-title").select(); }
    });
  }

  function openDialog(title, build) {
    var dlg = $("nb-dialog");
    $("nb-dialog-title").textContent = title;
    var body = $("nb-dialog-body");
    clear(body);
    build(body, function close() { if (dlg.open) dlg.close(); });
    if (!dlg.open) dlg.showModal();
  }

  function moveDialog() {
    if (!state.cur) return;
    var n = state.cur.note;
    var bad = n.kind === "folder" ? subtreeIds(state.tree, n.id) : [];
    openDialog("Move “" + n.title + "”", function (body, close) {
      var sel = el("select", "nb-select", body);
      sel.setAttribute("aria-label", "Move to");
      var top = el("option", "", sel, "Top level"); top.value = "";
      (function walk(pid, depth) {
        (state.tree.children[pid] || []).forEach(function (it) {
          if (it.kind !== "folder" || bad.indexOf(it.id) !== -1) return;
          var o = el("option", "", sel, new Array(depth + 1).join(" ") + it.title);
          o.value = it.id;
          if (it.id === n.parent) o.selected = true;
          walk(it.id, depth + 1);
        });
      })("", 0);
      var go = el("button", "btn", body, "Move here");
      go.type = "button";
      go.addEventListener("click", function () {
        var target = sel.value || null;
        save({ parent: target }).then(function (ok) {
          if (ok !== false) { if (target) state.expanded[target] = true; renderTree(); close(); }
          else setStatus("Could not move it.", "bad");
        });
      });
    });
  }

  function confirmDelete() {
    if (!state.cur) return;
    var n = state.cur.note;
    var what = n.kind === "folder" ? "folder “" + n.title + "” and everything in it" : "“" + n.title + "”";
    openDialog("Move to the trash?", function (body, close) {
      el("p", "", body, "The " + what + " goes to the trash. You can restore it from there.");
      var go = el("button", "btn nb-danger", body, "Move to trash");
      go.type = "button";
      go.addEventListener("click", function () {
        flush().then(function () {
          return call("DELETE", "/note?id=" + n.id).then(function (r) {
            if (r.status !== 200) { setStatus(explain(r), "bad"); return; }
            state.cur = null; state.dirty = false;
            close();
            show("empty");
            try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
            refreshTree();
          });
        });
      });
    });
  }

  function trashDialog() {
    openDialog("Trash", function (body, close) {
      call("GET", "/trash").then(function (r) {
        if (r.status !== 200) { el("p", "", body, explain(r)); return; }
        var items = r.json.items || [];
        if (!items.length) { el("p", "nb-hint", body, "The trash is empty."); return; }
        var ul = el("ul", "nb-trash", body);
        items.forEach(function (it) {
          var li = el("li", "", ul);
          el("span", "nb-row-title", li, (it.kind === "folder" ? "📁 " : "") + it.title);
          var re = el("button", "btn", li, "Restore");
          re.type = "button";
          re.addEventListener("click", function () {
            call("POST", "/note/restore?id=" + it.id).then(function (x) {
              if (x.status === 200) { li.remove(); refreshTree(); } else setStatus(explain(x), "bad");
            });
          });
          var del = el("button", "btn nb-danger", li, "Delete forever");
          del.type = "button";
          del.addEventListener("click", function () {
            call("DELETE", "/note?id=" + it.id + "&permanent=1").then(function (x) {
              if (x.status === 200) li.remove(); else el("p", "nb-hint", body, explain(x));
            });
          });
        });
        var empty = el("button", "btn nb-danger", body, "Empty the trash");
        empty.type = "button";
        empty.addEventListener("click", function () {
          call("POST", "/trash/empty").then(function (x) { if (x.status === 200) close(); else el("p", "nb-hint", body, explain(x)); });
        });
      });
    });
  }

  function historyDialog() {
    if (!state.cur || state.cur.note.kind !== "note") return;
    var n = state.cur.note;
    flush().then(function () {
      openDialog("History of “" + n.title + "”", function (body, close) {
        var revs = state.cur.revisions || [];
        if (!revs.length) { el("p", "nb-hint", body, "No earlier versions yet. A version is kept each time you change a note after a few minutes."); return; }
        el("p", "nb-hint", body, "Up to " + revs.length + " earlier versions.");
        var ul = el("ul", "nb-trash", body);
        var preview = el("pre", "nb-hist-preview", body);
        revs.forEach(function (rv) {
          var li = el("li", "", ul);
          el("span", "nb-row-title", li, new Date(rv.ts).toLocaleString() + " · " + rv.size + " characters");
          var see = el("button", "btn", li, "View");
          see.type = "button";
          see.addEventListener("click", function () {
            call("GET", "/revision?id=" + n.id + "&seq=" + rv.seq).then(function (x) { preview.textContent = x.status === 200 ? x.json.revision.body : explain(x); });
          });
          var back = el("button", "btn", li, "Restore this version");
          back.type = "button";
          back.addEventListener("click", function () {
            call("POST", "/revert", { id: n.id, seq: rv.seq, baseRev: state.cur.note.rev }).then(function (x) {
              if (x.status === 200) { applyNote(x.json); close(); } else el("p", "nb-hint", body, x.status === 409 ? "The note changed meanwhile. Close this and try again." : explain(x));
            });
          });
        });
      });
    });
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function notebookDialog() {
    openDialog("Your notebook", function (body, close) {
      var info = el("p", "nb-hint", body, "Loading…");
      call("GET", "/me").then(function (r) {
        if (r.status !== 200) { info.textContent = explain(r); return; }
        var j = r.json;
        info.textContent = j.notes + " notes and folders, " + j.trashed + " in the trash, " + j.images + " images (" + (j.imageBytes / 1048576).toFixed(1) + " MB of " + Math.round(j.limits.imagesTotalBytes / 1048576) + " MB).";
      });
      var ex = el("button", "btn", body, "Download everything (JSON)");
      ex.type = "button";
      ex.addEventListener("click", function () {
        call("GET", "/export").then(function (r) {
          if (r.status !== 200) { info.textContent = explain(r); return; }
          download("study-notebook-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(r.json, null, 2), "application/json");
        });
      });
      el("hr", "", body);
      el("h3", "", body, "Delete my notebook");
      el("p", "", body, "This permanently removes every note, folder, image and earlier version. There is no undo. Type “delete my notebook” to confirm.");
      var inp = el("input", "nb-confirm", body);
      inp.type = "text"; inp.setAttribute("aria-label", "Type delete my notebook to confirm"); inp.autocomplete = "off";
      var go = el("button", "btn nb-danger", body, "Delete everything");
      go.type = "button";
      go.addEventListener("click", function () {
        if (inp.value.trim() !== "delete my notebook") { info.textContent = "Type the words exactly to confirm."; return; }
        call("POST", "/delete-all", { confirm: "delete my notebook" }).then(function (r) {
          if (r.status === 200) { state.cur = null; state.dirty = false; show("empty"); refreshTree(); close(); } else info.textContent = explain(r);
        });
      });
      var login = el("a", "nb-link", body, "Sign in again (needed for downloads and deletes after a while)");
      login.href = loginUrl();
    });
  }

  // ---- editor helpers

  function textarea() { return $("nb-text"); }

  function apply(res) {
    var t = textarea();
    t.value = res.text;
    t.focus();
    t.setSelectionRange(res.selStart, res.selEnd);
    onEdit();
  }

  function onEdit() {
    schedule();
    clearTimeout(timers.preview);
    timers.preview = setTimeout(renderPreview, PREVIEW_MS);
    updatePop();
  }

  var TOOLBAR = [
    { label: "B", title: "Bold (Ctrl+B)", run: function (t, a, b) { return wrapSelection(t, a, b, "**", "**", "bold"); } },
    { label: "I", title: "Italic (Ctrl+I)", run: function (t, a, b) { return wrapSelection(t, a, b, "*", "*", "italic"); } },
    { label: "S", title: "Strikethrough", run: function (t, a, b) { return wrapSelection(t, a, b, "~~", "~~", "text"); } },
    { label: "</>", title: "Inline code", run: function (t, a, b) { return wrapSelection(t, a, b, "`", "`", "code"); } },
    { label: "Link", title: "Link (Ctrl+K)", run: function (t, a, b) { var r = wrapSelection(t, a, b, "[", "](https://)", "text"); r.selStart = r.selEnd + 2; r.selEnd = r.selStart + 8; return r; } },
    { label: "H2", title: "Heading", run: function (t, a, b) { return prefixLines(t, a, b, "## "); } },
    { label: "H3", title: "Sub-heading", run: function (t, a, b) { return prefixLines(t, a, b, "### "); } },
    { label: "• List", title: "Bulleted list", run: function (t, a, b) { return prefixLines(t, a, b, "- "); } },
    { label: "1. List", title: "Numbered list", run: function (t, a, b) { return prefixLines(t, a, b, "1. "); } },
    { label: "To-do", title: "To-do list", run: function (t, a, b) { return prefixLines(t, a, b, "- [ ] "); } },
    { label: "Quote", title: "Quote", run: function (t, a, b) { return prefixLines(t, a, b, "> "); } },
    { label: "Callout", title: "Callout", run: function (t, a, b) { return prefixLines(t, a, b, "> [!NOTE] "); } },
    { label: "Code", title: "Code block", run: function (t, a, b) { return wrapSelection(t, a, b, "```\n", "\n```", "code"); } },
    { label: "Table", title: "Table", run: function (t, a, b) { return wrapSelection(t, a, b, "", "| Column | Column |\n| --- | --- |\n| | |\n", ""); } },
    { label: "[[Note]]", title: "Link to another note", run: function (t, a, b) { return wrapSelection(t, a, b, "[[", "]]", "Note title"); } },
    { label: "Image", title: "Add an image", image: true },
  ];

  function buildToolbar() {
    var bar = $("nb-toolbar");
    TOOLBAR.forEach(function (tool) {
      var b = el("button", "nb-tool", bar, tool.label);
      b.type = "button";
      b.title = tool.title;
      b.setAttribute("aria-label", tool.title);
      b.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep the text selection
      b.addEventListener("click", function () {
        if (tool.image) { $("nb-file").click(); return; }
        var t = textarea();
        apply(tool.run(t.value, t.selectionStart, t.selectionEnd));
      });
    });
  }

  // images

  function insertAtCaret(text) {
    var t = textarea(), a = t.selectionStart, b = t.selectionEnd;
    t.value = t.value.slice(0, a) + text + t.value.slice(b);
    t.focus();
    t.setSelectionRange(a + text.length, a + text.length);
    onEdit();
  }

  function uploadImage(file) {
    if (!file || !IMAGE_TYPES[file.type]) { setStatus(ERRORS.image_type_invalid, "bad"); return; }
    if (file.size > MAX_IMAGE_BYTES) { setStatus(ERRORS.image_too_large, "bad"); return; }
    setStatus("Uploading image…", "");
    var name = (file.name || "image").replace(/\.[A-Za-z0-9]+$/, "").replace(/[\[\]()]/g, "").slice(0, 60) || "image";
    call("POST", "/image?name=" + encodeURIComponent(file.name || "image"), undefined, { body: file, type: file.type }).then(function (r) {
      if (r.status === 201) { insertAtCaret("\n![" + name + "](img:" + r.json.id + ")\n"); setStatus("Image added", "ok"); }
      else setStatus("Image not added — " + explain(r), "bad");
    });
  }

  // suggestions (slash menu and [[ links)

  var pop = { trig: null, items: [], index: 0 };

  function hidePop() { pop.trig = null; $("nb-pop").hidden = true; }

  function updatePop() {
    var t = textarea();
    var trig = triggerAt(t.value, t.selectionStart);
    if (!trig) { hidePop(); return; }
    var items;
    if (trig.kind === "slash") items = slashMatches(trig.query).map(function (c) { return { label: c.label, cmd: c }; });
    else {
      var q = trig.query.toLowerCase();
      items = state.items.filter(function (i) { return i.kind === "note" && (!state.cur || i.id !== state.cur.note.id) && (!q || i.title.toLowerCase().indexOf(q) !== -1); })
        .slice(0, 8).map(function (i) { return { label: i.title, title: i.title }; });
      if (trig.query.trim() && !state.titleToId[trig.query.trim().toLowerCase()]) items.push({ label: "Create “" + trig.query.trim() + "”", title: trig.query.trim(), create: true });
    }
    if (!items.length) { hidePop(); return; }
    pop.trig = trig; pop.items = items; pop.index = 0;
    renderPop();
  }

  function renderPop() {
    var box = $("nb-pop");
    clear(box);
    pop.items.forEach(function (it, i) {
      var b = el("button", "nb-pop-item" + (i === pop.index ? " on" : ""), box, it.label);
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", i === pop.index ? "true" : "false");
      b.addEventListener("mousedown", function (e) { e.preventDefault(); pop.index = i; choose(); });
    });
    box.hidden = false;
  }

  function choose() {
    var it = pop.items[pop.index], trig = pop.trig, t = textarea();
    if (!it || !trig) return;
    var before = t.value.slice(0, trig.from), after = t.value.slice(trig.to), caret;
    var ins;
    if (trig.kind === "slash") {
      if (it.cmd.action === "image") { t.value = before + after; t.setSelectionRange(before.length, before.length); hidePop(); onEdit(); $("nb-file").click(); return; }
      ins = it.cmd.insert;
      caret = before.length + ins.length - (it.cmd.caretBack || 0);
    } else {
      ins = "[[" + it.title + "]]";
      if (after.indexOf("]]") === 0) after = after.slice(2);
      caret = before.length + ins.length;
    }
    t.value = before + ins + after;
    t.focus();
    t.setSelectionRange(caret, caret);
    hidePop();
    onEdit();
    if (trig.kind === "wiki" && it.create && !state.titleToId[it.title.toLowerCase()]) create2(it.title);
  }

  // A [[link]] to a note that does not exist yet: make it in the background so the link works.
  function create2(title) {
    var keep = state.cur;
    call("POST", "/note", { title: title, body: "", kind: "note", parent: keep ? keep.note.parent : null }).then(function (r) {
      if (r.status === 201) {
        var n = r.json.note;
        state.items.push({ id: n.id, parent: n.parent, kind: n.kind, title: n.title, tags: n.tags, pinned: n.pinned, rev: n.rev, pii: n.pii });
        rebuildIndex(); renderTree(); renderPreview();
      }
    });
  }

  function onKeydown(e) {
    var t = textarea();
    if (!$("nb-pop").hidden && pop.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); pop.index = (pop.index + 1) % pop.items.length; renderPop(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); pop.index = (pop.index + pop.items.length - 1) % pop.items.length; renderPop(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(); return; }
      if (e.key === "Escape") { e.preventDefault(); hidePop(); return; }
    }
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey) {
      var k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); apply(wrapSelection(t.value, t.selectionStart, t.selectionEnd, "**", "**", "bold")); return; }
      if (k === "i") { e.preventDefault(); apply(wrapSelection(t.value, t.selectionStart, t.selectionEnd, "*", "*", "italic")); return; }
      if (k === "k") { e.preventDefault(); TOOLBAR[4].run && apply(TOOLBAR[4].run(t.value, t.selectionStart, t.selectionEnd)); return; }
      if (k === "s") { e.preventDefault(); flush(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !mod && t.selectionStart === t.selectionEnd) {
      var r = listEnter(t.value, t.selectionStart);
      if (r) { e.preventDefault(); t.value = r.text; t.setSelectionRange(r.caret, r.caret); onEdit(); }
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && t.selectionStart === t.selectionEnd) {
      var ls = t.value.lastIndexOf("\n", t.selectionStart - 1) + 1;
      if (/^\s*([-*+]|\d{1,9}[.)])\s/.test(t.value.slice(ls, t.selectionStart + 1))) {
        e.preventDefault();
        t.value = t.value.slice(0, ls) + "  " + t.value.slice(ls);
        t.setSelectionRange(t.selectionStart + 2, t.selectionStart + 2);
        onEdit();
      }
    }
  }

  // ---- wiring

  function route() {
    var id = (location.hash || "").slice(1);
    if (/^nt_[a-z0-9]{8}$/.test(id) && !(state.cur && state.cur.note.id === id)) openItem(id, true);
  }

  function searchNow(q) {
    call("GET", "/search?q=" + encodeURIComponent(q)).then(function (r) {
      if (state.query !== q) return;
      if (r.status === 200) renderResults(r.json.results || []);
    });
  }

  function init() {
    var saved = store("nb.mode");
    buildToolbar();
    setMode(saved === "edit" || saved === "preview" || saved === "split" ? saved : (root.matchMedia && root.matchMedia("(max-width: 900px)").matches ? "edit" : "split"));
    try { state.expanded = JSON.parse(store("nb.open") || "{}") || {}; } catch (e) { state.expanded = {}; }

    $("nb-new-note").addEventListener("click", function () { newNote(); });
    $("nb-new-folder").addEventListener("click", function () { newFolder(); });
    $("nb-open-trash").addEventListener("click", trashDialog);
    $("nb-open-notebook").addEventListener("click", notebookDialog);
    $("nb-dialog-close").addEventListener("click", function () { $("nb-dialog").close(); });
    $("nb-side-toggle").addEventListener("click", function () { collapseSide(!$("nb-side").classList.contains("collapsed")); });

    $("nb-tree").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-id]") : null;
      if (!b) return;
      var id = b.getAttribute("data-id"), it = state.tree && state.tree.byId[id];
      if (it && it.kind === "folder") { state.expanded[id] = !(state.expanded[id] && state.cur && state.cur.note.id === id); store("nb.open", JSON.stringify(state.expanded)); }
      openItem(id);
    });
    $("nb-folder-list").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-id]") : null;
      if (b) openItem(b.getAttribute("data-id"));
    });

    $("nb-search").addEventListener("input", function (e) {
      var q = e.target.value.trim();
      state.query = q.length >= 2 ? q : "";
      clearTimeout(timers.search);
      if (!state.query) { renderTree(); return; }
      timers.search = setTimeout(function () { searchNow(q); }, SEARCH_MS);
    });

    var t = textarea();
    t.addEventListener("input", onEdit);
    t.addEventListener("keydown", onKeydown);
    t.addEventListener("click", updatePop);
    t.addEventListener("blur", function () { setTimeout(hidePop, 150); });
    t.addEventListener("paste", function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && IMAGE_TYPES[files[0].type]) { e.preventDefault(); uploadImage(files[0]); }
    });
    t.addEventListener("dragover", function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1) e.preventDefault(); });
    t.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) { e.preventDefault(); uploadImage(files[0]); }
    });
    $("nb-file").addEventListener("change", function (e) { if (e.target.files[0]) uploadImage(e.target.files[0]); e.target.value = ""; });

    $("nb-title").addEventListener("input", schedule);
    $("nb-folder-title").addEventListener("input", schedule);
    $("nb-tags").addEventListener("input", schedule);
    $("nb-title").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); textarea().focus(); } });

    Array.prototype.forEach.call(document.querySelectorAll(".nb-modes button"), function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });
    });
    $("nb-pin").addEventListener("click", function () { save({ pinned: !state.cur.note.pinned }); });
    $("nb-move").addEventListener("click", moveDialog);
    $("nb-folder-move").addEventListener("click", moveDialog);
    $("nb-history").addEventListener("click", historyDialog);
    $("nb-delete").addEventListener("click", confirmDelete);
    $("nb-folder-delete").addEventListener("click", confirmDelete);
    $("nb-folder-note").addEventListener("click", function () { newNote(state.cur.note.id); });
    $("nb-folder-sub").addEventListener("click", function () { newFolder(state.cur.note.id); });
    $("nb-download").addEventListener("click", function () {
      if (!state.cur) return;
      var n = state.cur.note;
      download(fileNameFor($("nb-title").value || n.title), "# " + ($("nb-title").value || n.title) + "\n\n" + textarea().value + "\n", "text/markdown");
    });

    $("nb-preview").addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a.wiki[data-note]") : null;
      if (a) { e.preventDefault(); openItem(a.getAttribute("data-note")); return; }
      var m = e.target.closest ? e.target.closest("span.wiki.missing[data-wiki]") : null;
      if (m) { create2(m.getAttribute("data-wiki")); }
    });
    $("nb-backlinks-list").addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-note]") : null;
      if (a) { e.preventDefault(); openItem(a.getAttribute("data-note")); }
    });
    $("nb-outline-list").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-h]") : null;
      if (!b) return;
      var h = $("nb-preview").querySelector('[data-h="' + b.getAttribute("data-h") + '"]');
      if (h && h.scrollIntoView) h.scrollIntoView({ block: "start" });
    });

    root.addEventListener("hashchange", route);
    root.addEventListener("beforeunload", function (e) {
      if (state.dirty && !state.blocked) { e.preventDefault(); e.returnValue = ""; }
    });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });

    refreshTree().then(function (ok) {
      if (!ok) return;
      $("nb-gate").hidden = true;
      $("nb").hidden = false;
      show("empty");
      route();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(typeof window !== "undefined" ? window : this);
