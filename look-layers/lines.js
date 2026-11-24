// Look "Lines": draws the Overview as a transit map (the look's own markup for this one page).
// Registered with BarnyardTheme.look; overview.js calls it with the same data model it draws from, an empty #look-mount and a small
// kit (its own helpers, the element builder, the link maker and the Mark done action). Everything is DOM calls, setAttribute and
// textContent: nothing from the server ever reaches innerHTML. The page's own widgets are drawn first by overview.js; lines.css hides
// the default blocks only while this has drawn (html[data-look-drawn="overview"]), so a renderer that fails leaves the normal page.
//
// THE LINES. A line is a group of Ops board items (plus, for Servers, the hub's own services); a stop is one item or service. Which
// line an item rides is decided here, from LINES below, by the item's title prefix first and its category second. Anything that matches
// no line rides the last one, "Other". Edit LINES to add a line or move a category: a line with no stops is not drawn.
// Layout is automatic: lines are stacked, stops are spaced evenly along a straight run, labels alternate above and below, and a line
// with more than MAX_STOPS stops ends in a "+N more" stop that opens the Ops board.
(function () {
  "use strict";
  var T = window.BarnyardTheme;
  if (!T || !T.look || typeof T.look.register !== "function") return;

  var SVG_NS = "http://www.w3.org/2000/svg";
  var DAY_MS = 86400000;
  var MAX_STOPS = 7;
  var MAX_LIST = 6;

  // id, name, letter (in the bullet, so lines differ without colour), prefixes (title starts with), categories (Ops board categories).
  var LINES = [
    { id: "servers", name: "Servers", letter: "S", prefixes: [], categories: ["infrastructure"], services: true },
    { id: "projects", name: "Projects", letter: "P", prefixes: [], categories: ["backend", "frontend", "agent", "data", "docs"] },
    { id: "housekeeping", name: "Housekeeping", letter: "H", prefixes: [], categories: ["maintenance", "security"] }
  ];
  var OTHER = { id: "other", name: "Other", letter: "O", prefixes: [], categories: [] };

  var W = 960, ROW_H = 160, CY = 80, X0 = 118, X1 = 920, BULLET_X = 40;

  function pad(n) { return ("0" + n).slice(-2); }
  function clock(ts) { var d = new Date(ts); return isNaN(d.getTime()) ? "" : pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Short due text for lists and labels: "5 d late", "today", "in 3 d", "12 Dec".
  function dueShort(due, today) {
    var a = new Date(due + "T00:00:00").getTime(), b = new Date(today + "T00:00:00").getTime();
    if (isNaN(a) || isNaN(b)) return "";
    var days = Math.round((a - b) / DAY_MS);
    if (days < 0) return (-days) + " d late";
    if (days === 0) return "today";
    if (days <= 7) return "in " + days + " d";
    var d = new Date(a);
    return d.getDate() + " " + MONTHS[d.getMonth()];
  }
  function isLate(item, today) { return !!item.due && item.due < today; }

  function lineFor(item) {
    var title = String(item.title || "");
    for (var i = 0; i < LINES.length; i++) {
      for (var p = 0; p < LINES[i].prefixes.length; p++) if (title.indexOf(LINES[i].prefixes[p]) === 0) return LINES[i];
    }
    for (var j = 0; j < LINES.length; j++) {
      if (LINES[j].categories.indexOf(item.category) !== -1) return LINES[j];
    }
    return OTHER;
  }

  // ---- the stops ------------------------------------------------------------------------------------------------
  // A stop: { id, title, state, word, href, inter, plan }. state: done | progress | need | down | degraded | late | plan | more.

  var ORDER = { soaking: 0, in_progress: 1, waiting: 2, backlog: 3 };

  function itemStop(item, today, kit) {
    var late = isLate(item, today), state, word;
    if (late) { state = "late"; word = "overdue " + dueShort(item.due, today).replace(" late", ""); }
    else if (item.lane === "waiting") { state = "need"; word = "needs you" + (item.due ? ", " + dueShort(item.due, today) : ""); }
    else if (item.lane === "in_progress") { state = "progress"; word = "in progress"; }
    else if (item.lane === "soaking") { state = "done"; word = "soaking"; }
    else { state = "plan"; word = "planned" + (item.due ? ", " + dueShort(item.due, today) : ""); }
    return { id: item.id, title: item.title || "an item", state: state, word: word, href: kit.hrefFor(item.id), inter: "", plan: item.lane === "backlog", item: item, lane: item.lane, due: item.due || "" };
  }

  function serviceStops(m, kit) {
    var s = m.status, out = [];
    if (!s) return out;
    [["runner", "Chat runner"], ["engine", "Campaign engine"]].forEach(function (p) {
      var x = s[p[0]];
      if (!x || !x.enabled) return;
      if (x.error) out.push({ id: p[0], title: p[1], state: "degraded", word: "status unknown", href: "", inter: "", plan: false });
      else if (x.online) out.push({ id: p[0], title: p[1], state: "done", word: "running", href: "", inter: "", plan: false });
      else out.push({ id: p[0], title: p[1], state: "down", word: "down", href: "", inter: "", plan: false });
    });
    var c = s.check;
    if (c && c.known) {
      var link = c.itemId || c.id;
      out.push({ id: "check", title: "Daily check", state: c.ok ? "done" : "degraded", word: c.ok ? "passed" : "found something", href: link ? kit.hrefFor(link) : "", inter: "", plan: false, linkId: link || "" });
    }
    return out;
  }

  function cmpStops(a, b) {
    var oa = ORDER[a.lane] != null ? ORDER[a.lane] : 3, ob = ORDER[b.lane] != null ? ORDER[b.lane] : 3;
    if (oa !== ob) return oa - ob;
    var da = a.due || "9999", db = b.due || "9999";
    if (da !== db) return da < db ? -1 : 1;
    return String(a.title).localeCompare(String(b.title));
  }

  // Build the lines with their stops. Two stops on different lines that are the same piece of work (the daily check and the
  // item it opened) are an interchange: each says it is also on the other's line.
  function buildLines(m, kit, today) {
    var H = kit.helpers, byId = {}, order = LINES.concat([OTHER]);
    order.forEach(function (l) { byId[l.id] = { def: l, stops: [], more: 0 }; });
    var open = (m.items || []).filter(function (i) { return i && i.lane !== "done" && !i.proposal; });
    var itemStopsByLine = {};
    open.forEach(function (item) {
      var def = lineFor(item);
      (itemStopsByLine[def.id] = itemStopsByLine[def.id] || []).push(itemStop(item, today, kit));
    });
    LINES.forEach(function (def) {
      if (def.services) byId[def.id].stops = serviceStops(m, kit);
    });
    order.forEach(function (def) {
      var list = (itemStopsByLine[def.id] || []).sort(cmpStops);
      byId[def.id].stops = byId[def.id].stops.concat(list);
    });
    // interchange: a service stop that points at an item that has its own stop elsewhere
    var where = {};
    order.forEach(function (def) { byId[def.id].stops.forEach(function (st) { if (st.item) where[st.id] = { line: def, stop: st }; }); });
    order.forEach(function (def) {
      byId[def.id].stops.forEach(function (st) {
        var hit = st.linkId && where[st.linkId];
        if (hit && hit.line.id !== def.id) { st.inter = hit.line.name; hit.stop.inter = def.name; }
      });
    });
    var out = [];
    order.forEach(function (def) {
      var e = byId[def.id];
      if (!e.stops.length) return;
      if (e.stops.length > MAX_STOPS) { e.more = e.stops.length - MAX_STOPS; e.stops = e.stops.slice(0, MAX_STOPS); }
      out.push({ def: def, stops: e.stops, more: e.more, colour: out.length % 4 });
    });
    return out;
  }

  // ---- words ------------------------------------------------------------------------------------------------------

  function lineSentence(line) {
    var downs = [], degraded = [], need = 0, late = 0, prog = 0;
    line.stops.forEach(function (s) {
      if (s.state === "down") downs.push(s.title);
      else if (s.state === "degraded") degraded.push(s.title);
      else if (s.state === "need") need++;
      else if (s.state === "late") late++;
      else if (s.state === "progress") prog++;
    });
    var parts = [];
    if (downs.length) parts.push(downs.join(" and ") + (downs.length === 1 ? " is down" : " are down"));
    if (degraded.length) parts.push(degraded.join(" and ") + (degraded.length === 1 ? " found something" : " need a look"));
    if (!downs.length && !degraded.length && !need && !late) parts.push("Running");
    if (need) parts.push(plural(need, "stop needs you", "stops need you"));
    if (late) parts.push(plural(late, "stop is overdue", "stops are overdue"));
    if (prog) parts.push(prog + " in progress");
    return cap(parts.join(". ")) + ".";
  }

  function opening(m, kit, lines) {
    var H = kit.helpers;
    var need = H.waitingItems(m.items).length;
    var issues = m.status ? H.statusIssues(m.status) : [];
    var bits = [];
    if (issues.length) bits.push(issues.map(cap).join(". ") + ".");
    else if (m.status) bits.push("Every service is running.");
    bits.push(need ? plural(need, "stop needs you.", "stops need you.") : "No stop needs you.");
    return kit.h("p", "ln-open", bits.join(" "));
  }

  // ---- the map (SVG, drawn by attributes only) -----------------------------------------------------------------------

  function s(tag, cls, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute("class", cls);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
    return e;
  }
  function txt(e, text) { e.textContent = text; return e; }

  // Wrap a stop's name into at most two lines of about 22 characters.
  function wrap(title) {
    var words = String(title).split(/\s+/), lines = [""], i;
    for (i = 0; i < words.length; i++) {
      var cur = lines[lines.length - 1];
      if (!cur) lines[lines.length - 1] = words[i];
      else if ((cur + " " + words[i]).length <= 22) lines[lines.length - 1] = cur + " " + words[i];
      else if (lines.length < 2) lines.push(words[i]);
      else { lines[1] = lines[1] + " " + words[i]; }
    }
    lines = lines.map(function (l) { return l.length > 24 ? l.slice(0, 22) + "…" : l; });
    return lines.slice(0, 2);
  }

  function shape(g, st, x) {
    var r = 9;
    if (st.inter) g.appendChild(s("circle", "ln-inter", { cx: x, cy: CY, r: 14 }));
    if (st.state === "degraded") {
      g.appendChild(s("polygon", "ln-ring ln-diamond", { points: [x, CY - 11, x + 11, CY, x, CY + 11, x - 11, CY].join(",") }));
      return;
    }
    g.appendChild(s("circle", "ln-ring" + (st.state === "late" ? " ln-dashed" : ""), { cx: x, cy: CY, r: r }));
    if (st.state === "done") g.appendChild(s("circle", "ln-fill", { cx: x, cy: CY, r: 5.5 }));
    else if (st.state === "progress") g.appendChild(s("path", "ln-fill", { d: "M " + (x - 6) + " " + CY + " a 6 6 0 0 0 12 0 z" }));
    else if (st.state === "need") g.appendChild(s("circle", "ln-fill", { cx: x, cy: CY, r: 3 }));
    else if (st.state === "down") {
      g.appendChild(s("line", "ln-cross", { x1: x - 4.5, y1: CY - 4.5, x2: x + 4.5, y2: CY + 4.5 }));
      g.appendChild(s("line", "ln-cross", { x1: x - 4.5, y1: CY + 4.5, x2: x + 4.5, y2: CY - 4.5 }));
    }
  }

  function drawStop(svg, st, x, above, kit) {
    var wrapEl = st.href ? s("a", "ln-stop ln-stop-" + st.state, { href: st.href }) : s("g", "ln-stop ln-stop-" + st.state);
    wrapEl.setAttribute("aria-label", st.title + ", " + st.word + (st.inter ? ", also on the " + st.inter + " line" : ""));
    var g = s("g", "ln-st");
    shape(g, st, x);
    wrapEl.appendChild(g);
    var name = wrap(st.title), words = [st.word];
    if (st.inter) words.push("also on " + st.inter);
    var n = name.length + words.length, lineH = 16;
    var y0 = above ? CY - 26 - (n - 1) * lineH : CY + 34;
    var label = s("text", "ln-lbl", { x: x, "text-anchor": "middle" });
    name.forEach(function (l, i) { var t = s("tspan", "ln-name", { x: x, y: y0 + i * lineH }); label.appendChild(txt(t, l)); });
    words.forEach(function (l, i) { var t = s("tspan", "ln-word", { x: x, y: y0 + (name.length + i) * lineH }); label.appendChild(txt(t, l)); });
    wrapEl.appendChild(label);
    svg.appendChild(wrapEl);
  }

  function drawMap(lines, kit) {
    var svg = s("svg", "ln-svg", { viewBox: "0 0 " + W + " " + (lines.length * ROW_H), role: "group", "aria-label": "Network map: one line per group of work, one stop per item" });
    lines.forEach(function (line, li) {
      var row = s("g", "ln-line ln-c" + line.colour, { transform: "translate(0," + (li * ROW_H) + ")" });
      var stops = line.stops.slice();
      if (line.more) stops.push({ id: "more", title: "+" + line.more + " more", state: "more", word: "on the Ops board", href: kit.hrefFor(""), inter: "", plan: false });
      var n = stops.length, step = n > 1 ? Math.min(150, (X1 - X0) / (n - 1)) : 0;
      var xs = stops.map(function (st, i) { return Math.round(X0 + i * step); });
      var endX = (xs[n - 1] || X0) + 28;
      // the run: solid up to the last stop that is running or needs you; dashed for planned work after it
      row.appendChild(s("line", "ln-seg", { x1: BULLET_X + 20, y1: CY, x2: xs[0], y2: CY }));
      for (var i = 1; i < n; i++) {
        var planned = stops[i].plan || stops[i].state === "more";
        row.appendChild(s("line", "ln-seg" + (planned ? " ln-seg-plan" : ""), { x1: xs[i - 1], y1: CY, x2: xs[i], y2: CY }));
      }
      row.appendChild(s("line", "ln-seg ln-seg-end", { x1: xs[n - 1], y1: CY, x2: endX, y2: CY }));
      // the line's bullet: a ring with its letter, and its name under it
      var bullet = s("g", "ln-bullet");
      bullet.appendChild(s("circle", "ln-bullet-ring", { cx: BULLET_X, cy: CY, r: 17 }));
      bullet.appendChild(txt(s("text", "ln-bullet-letter", { x: BULLET_X, y: CY + 5, "text-anchor": "middle" }), line.def.letter));
      row.appendChild(bullet);
      row.appendChild(txt(s("text", "ln-line-name", { x: BULLET_X, y: CY + 38, "text-anchor": "middle" }), line.def.name));
      svg.appendChild(row);
      stops.forEach(function (st, i) {
        var holder = s("g", "ln-c" + line.colour, { transform: "translate(0," + (li * ROW_H) + ")" });
        if (st.state === "more") {
          var a = s("a", "ln-stop ln-stop-more", { href: st.href, "aria-label": st.title + " " + st.word });
          a.appendChild(s("circle", "ln-ring", { cx: xs[i], cy: CY, r: 6 }));
          var lb = s("text", "ln-lbl", { x: xs[i], "text-anchor": "middle" });
          lb.appendChild(txt(s("tspan", "ln-name", { x: xs[i], y: i % 2 === 0 ? CY - 22 : CY + 34 }), st.title));
          a.appendChild(lb);
          holder.appendChild(a);
        } else drawStop(holder, st, xs[i], i % 2 === 0, kit);
        svg.appendChild(holder);
      });
    });
    return svg;
  }

  // ---- the status board and the plain lists ---------------------------------------------------------------------------

  function board(lines, kit) {
    var list = kit.h("ol", "ln-board");
    lines.forEach(function (line) {
      var li = kit.h("li", "ln-boardrow ln-c" + line.colour);
      li.appendChild(kit.h("span", "ln-roundel", line.def.letter));
      li.appendChild(kit.h("span", "ln-boardname", line.def.name));
      li.appendChild(kit.h("span", "ln-boardtext", lineSentence(line)));
      list.appendChild(li);
    });
    return list;
  }

  function block(kit, title) {
    var sec = kit.h("section", "ln-block");
    sec.appendChild(kit.h("h2", "ln-head", title));
    var rows = kit.h("ul", "ln-rows");
    sec.appendChild(rows);
    sec._rows = rows;
    return sec;
  }
  function plainRow(kit, time, text, href, side) {
    var li = kit.h("li", "ln-row");
    li.appendChild(kit.h("span", "ln-time", time));
    var body = kit.h("span", "ln-rowtext");
    if (href) { var a = kit.h("a", "ln-link", text); a.href = href; body.appendChild(a); } else body.appendChild(document.createTextNode(text));
    li.appendChild(body);
    li.appendChild(kit.h("span", "ln-side", side || ""));
    return li;
  }

  function needsBlock(m, kit, today) {
    var items = kit.helpers.waitingItems(m.items);
    var sec = block(kit, "Needs you");
    if (!items.length) { sec._rows.appendChild(kit.h("li", "ln-empty", "No stop needs you.")); return sec; }
    items.forEach(function (item) {
      var li = plainRow(kit, item.due ? dueShort(item.due, today) : "", item.title, kit.hrefFor(item.id), item.next || "");
      var done = kit.h("button", "ln-act", "Mark done");
      done.type = "button";
      done.addEventListener("click", function () { kit.markDone(item, done); });
      li.children[1].appendChild(done);
      sec._rows.appendChild(li);
    });
    return sec;
  }

  function changesBlock(m, kit, now) {
    var H = kit.helpers;
    var all = m.events && m.events.length ? m.events : H.feedFromItems(m.items, MAX_LIST);
    var recent = all.filter(function (e) { return e && e.ts && e.ts <= now && e.ts > now - DAY_MS; }).sort(function (a, b) { return b.ts - a.ts; }).slice(0, MAX_LIST);
    var sec = block(kit, "Changes today");
    if (!recent.length) { sec._rows.appendChild(kit.h("li", "ln-empty", "No changes today.")); return sec; }
    recent.forEach(function (ev) {
      var d = H.describeFeed(ev);
      var text = (d.actor ? d.who + " " + d.verb + " " : "") + d.title + (d.tail || "") + (!d.actor ? " changed" : "");
      sec._rows.appendChild(plainRow(kit, clock(ev.ts), text, kit.hrefFor(ev.itemId), d.note || ""));
    });
    return sec;
  }

  function comingBlock(m, kit, today, lines) {
    var lineName = {};
    lines.forEach(function (l) { l.stops.forEach(function (st) { if (st.item) lineName[st.id] = l.def.name; }); });
    var items = (m.items || []).filter(function (i) { return i && i.due && i.due >= today && i.lane !== "done" && !i.proposal; })
      .sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; }).slice(0, MAX_LIST);
    var sec = block(kit, "Coming up");
    if (!items.length) { sec._rows.appendChild(kit.h("li", "ln-empty", "Nothing is dated.")); return sec; }
    items.forEach(function (item) { sec._rows.appendChild(plainRow(kit, dueShort(item.due, today), item.title, kit.hrefFor(item.id), lineName[item.id] || "")); });
    return sec;
  }

  T.look.register("lines", "overview", function (m, mount, kit) {
    if (!m || m.state !== "ok" || !kit || !kit.helpers || typeof document.createElementNS !== "function") return false;
    var now = Date.now(), today = kit.todayString();
    var lines = buildLines(m, kit, today);
    var wrapEl = kit.h("div", "ln-sheet");
    wrapEl.appendChild(opening(m, kit, lines));
    if (lines.length) {
      wrapEl.appendChild(board(lines, kit));
      var mapBox = kit.h("div", "ln-map");
      mapBox.setAttribute("tabindex", "0");           // a scrollable region on a narrow window must be reachable by keyboard
      mapBox.setAttribute("role", "region");
      mapBox.setAttribute("aria-label", "Network map");
      mapBox.appendChild(drawMap(lines, kit));
      wrapEl.appendChild(mapBox);
      wrapEl.appendChild(legend(kit));
    } else wrapEl.appendChild(kit.h("p", "ln-empty", "There are no stops on the network yet."));
    wrapEl.appendChild(needsBlock(m, kit, today));
    wrapEl.appendChild(changesBlock(m, kit, now));
    wrapEl.appendChild(comingBlock(m, kit, today, lines));
    mount.appendChild(wrapEl);
    return true;
  });

  // The key: each station shape in words, so a shape is never the only carrier of state.
  function legend(kit) {
    var list = kit.h("p", "ln-key",
      "Filled dot: running or soaking. Ring with a centre: needs you. Half filled: in progress. Cross in a ring: down. Diamond: degraded. Dashed ring: overdue. Plain ring on a dashed run: planned.");
    return list;
  }
})();
