// Look "Grid 9": draws the Overview as ruled bands on a nine-column grid (the look's own markup for this one page).
// Registered with BarnyardTheme.look; overview.js calls it with the same data model it draws from, an empty #look-mount and a small
// kit (its own helpers, the element builder, the link maker and the Mark done action). Everything is DOM calls and textContent:
// nothing from the server ever reaches innerHTML. The page's own widgets are drawn first by overview.js; this adds a second layout,
// and grid-9.css hides the default blocks only while this has drawn (html[data-look-drawn="overview"]).
(function () {
  "use strict";
  var T = window.BarnyardTheme;
  if (!T || !T.look || typeof T.look.register !== "function") return;

  var STATE_WORD = { ok: "Up", attn: "Check", alert: "Down", info: "", hollow: "" };

  function clock(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function count(n, one, many) { return String(n) + " " + (n === 1 ? one : many); }

  // The three display lines of the opening: numbers and words in one face, no tiles.
  function opening(m, kit) {
    var H = kit.helpers;
    var need = H.waitingItems(m.items).length;
    var flight = H.flightItems(m.items).length;
    var issues = m.status ? H.statusIssues(m.status).length : 0;
    var lines = [need + (need === 1 ? " needs you." : " need you.")];
    if (m.status) lines.push(issues ? count(issues, "thing is down.", "things are down.") : "Nothing is down.");
    lines.push(flight + " in progress.");
    var box = kit.h("div", "g9-open");
    lines.forEach(function (text, i) {
      var p = kit.h("p", i === 0 && need ? "g9-line g9-strong" : "g9-line", text);
      box.appendChild(p);
    });
    return box;
  }

  function band(kit, title, extra) {
    var sec = kit.h("section", "g9-band");
    var head = kit.h("h2", "g9-head", title);
    sec.appendChild(head);
    if (extra) { var note = kit.h("p", "g9-sub", extra); sec.appendChild(note); }
    var rows = kit.h("div", "g9-rows");
    sec.appendChild(rows);
    sec._rows = rows;
    return sec;
  }

  function row(kit, cls) { return kit.h("div", "g9-row" + (cls ? " " + cls : "")); }
  function cell(kit, cls, text) { return kit.h("span", "g9-cell " + cls, text); }

  function needsBand(m, kit) {
    var H = kit.helpers, today = kit.todayString();
    var items = H.waitingItems(m.items);
    var sec = band(kit, "Needs you");
    if (!items.length) { sec._rows.appendChild(kit.h("p", "g9-empty", "Nothing needs you.")); return sec; }
    items.forEach(function (item) {
      var r = row(kit, "g9-need");
      var due = H.dueChip(item.due, today);
      r.appendChild(cell(kit, "g9-c1", due ? due.text : ""));
      var title = kit.h("a", "g9-title", item.title);
      title.href = kit.hrefFor(item.id);
      var c2 = cell(kit, "g9-c2", "");
      c2.appendChild(title);
      r.appendChild(c2);
      r.appendChild(cell(kit, "g9-c6", item.next || ""));
      var acts = cell(kit, "g9-c8", "");
      var done = kit.h("button", "g9-act", "Mark done");
      done.type = "button";
      done.addEventListener("click", function () { kit.markDone(item, done); });
      acts.appendChild(done);
      r.appendChild(acts);
      sec._rows.appendChild(r);
    });
    return sec;
  }

  function flightBand(m, kit) {
    var items = kit.helpers.flightItems(m.items);
    var sec = band(kit, "In progress");
    if (!items.length) { sec._rows.appendChild(kit.h("p", "g9-empty", "Nothing is in progress.")); return sec; }
    items.forEach(function (item) {
      var r = row(kit, "g9-flight");
      r.appendChild(cell(kit, "g9-c1", item.status ? String(item.status).replace(/_/g, " ") : ""));
      var title = kit.h("a", "g9-title", item.title);
      title.href = kit.hrefFor(item.id);
      var c2 = cell(kit, "g9-c2", "");
      c2.appendChild(title);
      r.appendChild(c2);
      r.appendChild(cell(kit, "g9-c6", item.next || ""));
      sec._rows.appendChild(r);
    });
    return sec;
  }

  function todayBand(m, kit) {
    var H = kit.helpers;
    var entries = m.events && m.events.length ? m.events : H.feedFromItems(m.items, 6);
    var sec = band(kit, "Today");
    if (!entries.length) { sec._rows.appendChild(kit.h("p", "g9-empty", "No changes yet.")); return sec; }
    entries.slice(0, 8).forEach(function (ev) {
      var d = H.describeFeed(ev);
      var r = row(kit, "g9-feed");
      r.appendChild(cell(kit, "g9-c1 g9-num", clock(d.ts)));
      var text = (d.actor ? d.who + " " + d.verb + " " : "") + d.title + (d.tail || "") + (!d.actor ? " changed" : "");
      var c2 = cell(kit, "g9-c2", "");
      var a = kit.h("a", "g9-title", text);
      a.href = kit.hrefFor(ev.itemId);
      c2.appendChild(a);
      r.appendChild(c2);
      r.appendChild(cell(kit, "g9-c6", d.note || ""));
      sec._rows.appendChild(r);
    });
    return sec;
  }

  function statusBand(m, kit) {
    if (!m.status) return null;
    var chips = kit.helpers.statusChips(m.status, Date.now());
    if (!chips.length) return null;
    var sec = band(kit, "Services");
    chips.forEach(function (c) {
      var r = row(kit, "g9-svc");
      var word = STATE_WORD[c.tone || ""] || "";
      r.appendChild(cell(kit, "g9-c1 " + (c.tone === "alert" || c.tone === "attn" ? "g9-strong" : ""), word));
      var c2 = cell(kit, "g9-c2", "");
      if (c.href) { var a = kit.h("a", "g9-title", c.text); a.href = c.href; c2.appendChild(a); } else c2.appendChild(document.createTextNode(c.text));
      r.appendChild(c2);
      sec._rows.appendChild(r);
    });
    return sec;
  }

  T.look.register("grid-9", "overview", function (m, mount, kit) {
    if (!m || m.state !== "ok" || !kit || !kit.helpers) return false;
    var wrap = kit.h("div", "g9-sheet");
    wrap.appendChild(opening(m, kit));
    [needsBand(m, kit), flightBand(m, kit), todayBand(m, kit), statusBand(m, kit)].forEach(function (b) { if (b) wrap.appendChild(b); });
    mount.appendChild(wrap);
    return true;
  });
})();
