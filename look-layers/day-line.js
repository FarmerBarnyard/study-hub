// Look "Day Line": draws the Overview as one vertical time axis (the look's own markup for this one page).
// Registered with BarnyardTheme.look; overview.js calls it with the same data model it draws from, an empty #look-mount and a small
// kit (its own helpers, the element builder, the link maker and the Mark done action). Everything is DOM calls and textContent:
// nothing from the server ever reaches innerHTML. Earlier changes sit above a "now" line, what needs you sits on it, what is going on
// and what is coming sit below it. How long something has been wrong is a bar in the left gutter, from when it began to now.
// The page's own widgets are drawn first by overview.js; day-line.css hides the default blocks only while this has drawn
// (html[data-look-drawn="overview"]), so a renderer that fails leaves the normal page.
(function () {
  "use strict";
  var T = window.BarnyardTheme;
  if (!T || !T.look || typeof T.look.register !== "function") return;

  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAY_MS = 86400000;
  var LANES = 3;          // how many gutter bars can run side by side
  var MAX_EARLIER = 8;    // the newest changes shown above the line
  var MAX_PLANNED = 6;    // dated things shown below it

  function pad(n) { return ("0" + n).slice(-2); }
  function clock(ts) {
    var d = new Date(ts);
    return isNaN(d.getTime()) ? "" : pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function dayTitle(ts, now) {
    var key = dayKey(ts);
    if (key === dayKey(now)) return "Today";
    if (key === dayKey(now - DAY_MS)) return "Yesterday";
    var d = new Date(ts);
    return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
  }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // "14 min", "3 h", "5 days": how long something has been going on.
  function spanText(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    var h = Math.round(m / 60);
    if (h < 48) return h + " h";
    return Math.round(h / 24) + " days";
  }

  // The time column for something with a due date: short, so it fits beside the axis.
  function dueShort(due, today) {
    var a = new Date(due + "T00:00:00").getTime(), b = new Date(today + "T00:00:00").getTime();
    if (isNaN(a) || isNaN(b)) return "";
    var days = Math.round((a - b) / DAY_MS);
    if (days < 0) return (-days) + " d late";
    if (days === 0) return "today";
    if (days <= 7) return "in " + days + " d";
    var d = new Date(a);
    return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
  }

  // One row of the line: gutter bars | clock time | axis marker | text | side note.
  // kind: day | event | done | now | need | down | flight | plan | empty. The rows are plain data until draw().
  function makeRow(kind, o) {
    o = o || {};
    return { kind: kind, ts: o.ts || 0, time: o.time || "", text: o.text || "", href: o.href || "", side: o.side || "", item: o.item || null, strong: !!o.strong, lanes: [] };
  }

  // What happened, oldest first, with a day heading wherever the day changes.
  function earlierRows(m, kit, now) {
    var H = kit.helpers;
    var entries = (m.events && m.events.length ? m.events : H.feedFromItems(m.items, MAX_EARLIER)).filter(function (e) { return e && e.ts && e.ts <= now; });
    entries = entries.slice().sort(function (a, b) { return a.ts - b.ts; }).slice(-MAX_EARLIER);
    var rows = [], last = "";
    entries.forEach(function (ev) {
      var key = dayKey(ev.ts);
      if (key !== last) { rows.push(makeRow("day", { ts: ev.ts - 1, text: dayTitle(ev.ts, now) })); last = key; }
      var d = H.describeFeed(ev);
      var text = (d.actor ? d.who + " " + d.verb + " " : "") + d.title + (d.tail || "") + (!d.actor ? " changed" : "");
      rows.push(makeRow(ev.kind === "done" ? "done" : "event", { ts: ev.ts, time: clock(ev.ts), text: text, href: kit.hrefFor(ev.itemId), side: d.note || "" }));
    });
    if (!rows.length) rows.push(makeRow("empty", { text: "No changes yet." }));
    return rows;
  }

  // The things that are wrong right now, each with when it began (when that is known) and what kind of bar it gets.
  function trouble(m, kit, now) {
    var out = [], s = m.status;
    if (!s) return out;
    [["runner", "The chat runner is offline"], ["engine", "The campaign engine is offline"]].forEach(function (p) {
      var x = s[p[0]];
      if (x && x.enabled && !x.error && !x.online) out.push({ text: p[1], start: x.lastSeen || 0, bar: "down", href: "" });
    });
    var c = s.check;
    if (c && c.known && !c.ok) out.push({ text: "The daily check found something", start: c.lastAt || 0, bar: "degraded", href: c.itemId ? kit.hrefFor(c.itemId) : (c.id ? kit.hrefFor(c.id) : "") });
    return out;
  }

  function onTheLine(m, kit, now, today) {
    var H = kit.helpers, rows = [], spans = [];
    trouble(m, kit, now).forEach(function (t) {
      rows.push(makeRow("down", { ts: now, time: "now", text: t.text, href: t.href, strong: true, side: t.start ? "for " + spanText(now - t.start) : "" }));
      spans.push({ owner: rows.length - 1, start: t.start, bar: t.bar });
    });
    var waiting = H.waitingItems(m.items);
    waiting.forEach(function (item) {
      var late = item.due && new Date(item.due + "T00:00:00").getTime() < new Date(today + "T00:00:00").getTime();
      rows.push(makeRow("need", { ts: now, time: item.due ? dueShort(item.due, today) : "now", text: item.title, href: kit.hrefFor(item.id), strong: true, side: item.next || "", item: item }));
      if (late) spans.push({ owner: rows.length - 1, start: new Date(item.due + "T00:00:00").getTime(), bar: "overdue" });
    });
    if (!rows.length) rows.push(makeRow("empty", { text: "Nothing needs you." }));
    return { rows: rows, spans: spans };
  }

  // What is going on, then what is dated and coming.
  function belowTheLine(m, kit, now, today) {
    var H = kit.helpers, rows = [];
    H.flightItems(m.items).forEach(function (item) {
      var word = item.status ? String(item.status).replace(/_/g, " ") : "";
      rows.push(makeRow("flight", { ts: now, time: "now", text: item.title + (word ? " (" + word + ")" : ""), href: kit.hrefFor(item.id), side: item.next || "" }));
    });
    var planned = (m.items || []).filter(function (i) {
      return i && i.due && i.lane !== "done" && !i.proposal && i.lane !== "waiting" && i.lane !== "in_progress" && i.lane !== "soaking" && i.due >= today;
    }).sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; }).slice(0, MAX_PLANNED);
    planned.forEach(function (item) {
      var d = new Date(item.due + "T00:00:00");
      rows.push(makeRow("plan", { ts: now, time: dueShort(item.due, today), text: item.title, href: kit.hrefFor(item.id), side: isNaN(d.getTime()) ? "" : DAYS[d.getDay()] }));
    });
    return rows;
  }

  // Give each gutter bar its lane and mark every row it runs through, from where it began down to the row it belongs to.
  function placeBars(rows, spans, nowIdx) {
    var lane = 0;
    spans.forEach(function (sp) {
      if (lane >= LANES) return;
      var from = nowIdx;
      for (var i = 0; i <= nowIdx; i++) { if (rows[i].ts >= sp.start) { from = i; break; } }
      if (!sp.start) from = sp.owner;                  // no start known: just the row itself
      for (var r = from; r <= sp.owner; r++) rows[r].lanes[lane] = { bar: sp.bar, first: r === from, last: r === sp.owner };
      lane++;
    });
  }

  function markerFor(kind) {
    return { day: "", empty: "", event: "dl-m-event", done: "dl-m-done", now: "dl-m-now", need: "dl-m-need", down: "dl-m-down", flight: "dl-m-flight", plan: "dl-m-plan" }[kind] || "dl-m-event";
  }

  function draw(rows, kit) {
    var list = kit.h("ol", "dl-line");
    rows.forEach(function (r) {
      var li = kit.h("li", "dl-row dl-" + r.kind);
      var gutter = kit.h("span", "dl-gutter");
      gutter.setAttribute("aria-hidden", "true");
      for (var i = 0; i < LANES; i++) {
        var b = r.lanes[i];
        gutter.appendChild(kit.h("i", b ? "dl-bar dl-bar-" + b.bar + (b.first ? " dl-first" : "") + (b.last ? " dl-last" : "") : "dl-bar dl-bar-none"));
      }
      li.appendChild(gutter);
      var time = kit.h("span", "dl-time", r.kind === "now" ? "" : r.time);
      if (r.kind === "now") time.appendChild(kit.h("span", "dl-nowtag", "now"));
      li.appendChild(time);
      var mark = kit.h("span", "dl-mark");
      var cls = markerFor(r.kind);
      if (cls) { var shape = kit.h("i", "dl-shape " + cls); shape.setAttribute("aria-hidden", "true"); mark.appendChild(shape); }
      li.appendChild(mark);
      var text = kit.h("span", "dl-text" + (r.strong ? " dl-strong" : ""));
      if (r.kind === "now") text.textContent = r.text;
      else if (r.href) { var a = kit.h("a", "dl-title", r.text); a.href = r.href; text.appendChild(a); }
      else text.textContent = r.text;
      if (r.kind === "need" && r.item) {
        var done = kit.h("button", "dl-act", "Mark done");
        done.type = "button";
        done.addEventListener("click", function () { kit.markDone(r.item, done); });
        text.appendChild(done);
      }
      li.appendChild(text);
      li.appendChild(kit.h("span", "dl-side", r.side));
      list.appendChild(li);
    });
    return list;
  }

  // The opening sentence is built from the data: when it is, what is wrong, how many things need you.
  function opening(m, kit, now) {
    var H = kit.helpers, d = new Date(now);
    var need = H.waitingItems(m.items).length;
    var issues = m.status ? H.statusIssues(m.status) : [];
    var bits = [clock(now) + " " + DAYS[d.getDay()] + "."];
    if (issues.length) bits.push(issues.map(cap).join(". ") + ".");
    else if (m.status) bits.push("Everything is running.");
    bits.push(need ? plural(need, "item needs you.", "items need you.") : "Nothing needs you.");
    return kit.h("p", "dl-open", bits.join(" "));
  }

  T.look.register("day-line", "overview", function (m, mount, kit) {
    if (!m || m.state !== "ok" || !kit || !kit.helpers) return false;
    var now = Date.now(), today = kit.todayString();
    var earlier = earlierRows(m, kit, now);
    var nowRow = makeRow("now", { ts: now, text: clock(now) + " " + DAYS[new Date(now).getDay()] });
    var line = onTheLine(m, kit, now, today);
    var below = belowTheLine(m, kit, now, today);
    var rows = earlier.concat([nowRow], line.rows, below);
    var nowIdx = earlier.length;
    // the owner of each bar sits on the line: shift its index past the earlier rows and the now row
    var spans = line.spans.map(function (s) { return { owner: s.owner + nowIdx + 1, start: s.start, bar: s.bar }; });
    placeBars(rows, spans, nowIdx);
    var sheet = kit.h("div", "dl-sheet");
    sheet.appendChild(opening(m, kit, now));
    sheet.appendChild(draw(rows, kit));
    mount.appendChild(sheet);
    return true;
  });
})();
