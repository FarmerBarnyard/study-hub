// A small, safe Markdown renderer for the study notebook (notes.html).
//
// Two steps, so the risky part is testable without a browser:
//   parse(text)          -> a plain-data tree (blocks and inline nodes)
//   toDom(tree, doc, cx) -> DOM nodes, built ONLY with createElement /
//                           createTextNode / setAttribute / textContent
//
// There is no innerHTML anywhere: note text can never become markup, so a note
// cannot inject script or style however it is written. Links are limited to
// http, https and mailto (anything else renders as plain text); images are only
// the notebook's own (`img:im_xxxxxxxx`, fetched from the Worker with the login
// cookie) -- a Markdown image pointing at another site becomes a plain link, so
// reading a note never makes the browser call a third party. A web address on a
// line by itself becomes a link card (host and path only; the page is never
// fetched). [[Note title]] and [[Note title|label]] link to other notes.
//
// Supported: headings, paragraphs (line breaks kept), bold, italic, strikethrough,
// inline code, fenced code, block quotes, callouts (> [!NOTE] / TIP / IMPORTANT /
// WARNING / CAUTION), bullet / numbered / task lists (nested), tables, rules.
//
// Plain script (no build step): sets window.BarnyardMarkdown; under Node it is
// require()-able for the tests in test/markdown.test.js.
(function (root) {
  "use strict";

  var MAX_BLOCK_DEPTH = 8;      // quotes / lists nested this deep, then plain text
  var MAX_INLINE_DEPTH = 5;     // emphasis nested this deep, then plain text
  var MAX_INLINE_CHARS = 20000; // a single paragraph longer than this is shown as plain text
  var CALLOUTS = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };
  var IMAGE_ID = /^im_[a-z0-9]{8}$/;
  var NOTE_ID = /^(nt|ka)_[a-z0-9]{8}$/;   // a note in the notebook, or an article in the Knowledgebase

  // ---------------------------------------------------------------- safe URLs

  // -> a normalised absolute http(s)/mailto URL string, or null.
  function safeUrl(raw) {
    if (typeof raw !== "string") return null;
    var s = raw.trim();
    if (!s || s.length > 2000 || /[\u0000- \u007f-\u009f"<>\\^`{|}]/.test(s)) return null;
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(s)) return s;
    if (!/^https?:\/\//i.test(s)) return null;
    try {
      var u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (u.username || u.password) return null; // no user:pass@host tricks
      return u.href;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------- inline

  function text(v) { return { t: "text", v: v }; }

  function isAlnum(ch) { return ch !== undefined && ch !== "" && /[A-Za-z0-9]/.test(ch); }

  // Index of the `]` that closes the `[` at `open`, honouring nesting and escapes; -1 if none.
  function closeBracket(s, open) {
    var depth = 0;
    for (var i = open; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === "\\") { i++; continue; }
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) return i; }
      else if (c === "\n") return -1;
    }
    return -1;
  }

  // `(url "title")` starting at s[i] === "(" -> { url, end } with `end` after the ")", or null.
  function readDest(s, i) {
    if (s.charAt(i) !== "(") return null;
    var depth = 0, j = i;
    for (; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === "\\") { j++; continue; }
      if (c === "\n") return null;
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    if (j >= s.length) return null;
    var inner = s.slice(i + 1, j).trim();
    var m = /^(\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(inner);
    if (!m) return null;
    return { url: m[1].replace(/^<|>$/g, ""), end: j + 1 };
  }

  function parseInline(s, depth) {
    var out = [];
    var buf = "";
    function flush() { if (buf) { out.push(text(buf)); buf = ""; } }
    if (depth > MAX_INLINE_DEPTH || s.length > MAX_INLINE_CHARS) return [text(s)];
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);

      if (c === "\\" && i + 1 < s.length) {
        var nx = s.charAt(i + 1);
        if (nx === "\n") { flush(); out.push({ t: "br" }); i += 2; continue; }
        if (/[\\`*_{}\[\]()#+\-.!|~>]/.test(nx)) { buf += nx; i += 2; continue; }
        buf += c; i++; continue;
      }
      if (c === "\n") { flush(); out.push({ t: "br" }); i++; continue; }

      if (c === "`") {
        var run = 1;
        while (s.charAt(i + run) === "`") run++;
        var fence = new Array(run + 1).join("`");
        var end = s.indexOf(fence, i + run);
        // the closing run must be exactly as long as the opening one
        while (end !== -1 && s.charAt(end + run) === "`") end = s.indexOf(fence, end + run + 1);
        if (end !== -1) {
          flush();
          out.push({ t: "code", v: s.slice(i + run, end).replace(/^ (.*) $/, "$1") });
          i = end + run;
          continue;
        }
        buf += fence; i += run; continue;
      }

      if (c === "!" && s.charAt(i + 1) === "[") {
        var cb = closeBracket(s, i + 1);
        var dest = cb === -1 ? null : readDest(s, cb + 1);
        if (dest) {
          flush();
          var alt = s.slice(i + 2, cb);
          var idm = /^img:(im_[a-z0-9]{8})$/.exec(dest.url);
          if (idm) out.push({ t: "img", id: idm[1], alt: alt });
          else {
            var href = safeUrl(dest.url);
            out.push(href ? { t: "link", href: href, c: [text("Image: " + (alt || href))] } : text(alt));
          }
          i = dest.end;
          continue;
        }
      }

      if (c === "[" && s.charAt(i + 1) === "[") {
        var close = s.indexOf("]]", i + 2);
        var nl = s.indexOf("\n", i + 2);
        if (close !== -1 && (nl === -1 || close < nl) && close - i < 420) {
          var body = s.slice(i + 2, close);
          var bar = body.indexOf("|");
          var title = (bar === -1 ? body : body.slice(0, bar)).trim();
          var label = bar === -1 ? title : body.slice(bar + 1).trim();
          if (title && title.indexOf("[") === -1) {
            flush();
            out.push({ t: "wiki", title: title, label: label || title });
            i = close + 2;
            continue;
          }
        }
      }

      if (c === "[") {
        var cb2 = closeBracket(s, i);
        var d2 = cb2 === -1 ? null : readDest(s, cb2 + 1);
        if (d2) {
          flush();
          var url = safeUrl(d2.url);
          var inner = parseInline(s.slice(i + 1, cb2), depth + 1);
          out.push(url ? { t: "link", href: url, c: inner } : { t: "span", c: inner });
          i = d2.end;
          continue;
        }
      }

      var two = s.substr(i, 2);
      if (two === "**" || two === "__" || two === "~~") {
        var e2 = s.indexOf(two, i + 2);
        if (e2 > i + 2 && !/\s/.test(s.charAt(i + 2)) && !/\s/.test(s.charAt(e2 - 1)) && !(two === "__" && isAlnum(s.charAt(i - 1)))) {
          flush();
          out.push({ t: two === "~~" ? "del" : "strong", c: parseInline(s.slice(i + 2, e2), depth + 1) });
          i = e2 + 2;
          continue;
        }
      }
      if ((c === "*" || c === "_") && s.charAt(i + 1) !== c) {
        var e1 = i + 1;
        do { e1 = s.indexOf(c, e1); } while (e1 !== -1 && s.charAt(e1 + 1) === c && (e1 += 2));
        if (e1 > i + 1 && !/\s/.test(s.charAt(i + 1)) && !/\s/.test(s.charAt(e1 - 1)) && !(c === "_" && (isAlnum(s.charAt(i - 1)) || isAlnum(s.charAt(e1 + 1))))) {
          flush();
          out.push({ t: "em", c: parseInline(s.slice(i + 1, e1), depth + 1) });
          i = e1 + 1;
          continue;
        }
      }

      if ((c === "h" || c === "H") && /^https?:\/\//i.test(s.substr(i, 8)) && !isAlnum(s.charAt(i - 1))) {
        var m = /^https?:\/\/[^\s<>\[\]()]+/i.exec(s.slice(i, i + 2100));
        if (m) {
          var raw = m[0].replace(/[.,;:!?'"*_~]+$/, "");
          var safe = safeUrl(raw);
          if (safe) {
            flush();
            out.push({ t: "link", href: safe, c: [text(raw)] });
            i += raw.length;
            continue;
          }
        }
      }

      buf += c; i++;
    }
    flush();
    return out;
  }

  // ------------------------------------------------------------------- blocks

  var FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  var HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*(?:#+[ \t]*)?$/;
  var HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  var QUOTE = /^ {0,3}>[ ]?(.*)$/;
  var TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    var cells = [], cur = "";
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) === "\\" && s.charAt(i + 1) === "|") { cur += "|"; i++; }
      else if (s.charAt(i) === "|") { cells.push(cur.trim()); cur = ""; }
      else cur += s.charAt(i);
    }
    cells.push(cur.trim());
    return cells;
  }

  function startsBlock(line, next) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) ||
      (line.indexOf("|") !== -1 && next !== undefined && next.indexOf("-") !== -1 && TABLE_SEP.test(next) && next.indexOf("|") !== -1);
  }

  function parseBlocks(lines, depth) {
    var blocks = [];
    var i = 0;
    if (depth > MAX_BLOCK_DEPTH) return [{ t: "p", c: [text(lines.join("\n"))] }];
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var f = FENCE.exec(line);
      if (f) {
        var marker = f[1].charAt(0), len = f[1].length, body = [];
        i++;
        while (i < lines.length) {
          var closing = new RegExp("^ {0,3}" + (marker === "`" ? "`" : "~") + "{" + len + ",}\\s*$");
          if (closing.test(lines[i])) { i++; break; }
          body.push(lines[i]); i++;
        }
        blocks.push({ t: "code", lang: f[2] || "", v: body.join("\n") });
        continue;
      }

      var h = HEADING.exec(line);
      if (h) { blocks.push({ t: "h", level: h[1].length, c: parseInline(h[2], 0) }); i++; continue; }

      if (HR.test(line)) { blocks.push({ t: "hr" }); i++; continue; }

      if (line.indexOf("|") !== -1 && i + 1 < lines.length && lines[i + 1].indexOf("|") !== -1 && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf("-") !== -1) {
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":";
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        if (aligns.length === head.length) {
          var rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
            var cells = splitRow(lines[i]);
            while (cells.length < head.length) cells.push("");
            rows.push(cells.slice(0, head.length).map(function (c) { return parseInline(c, 0); }));
            i++;
          }
          blocks.push({ t: "table", align: aligns, head: head.map(function (c) { return parseInline(c, 0); }), rows: rows });
          continue;
        }
      }

      if (QUOTE.test(line)) {
        var q = [];
        while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && q.length && !startsBlock(lines[i], lines[i + 1])))) {
          var qm = QUOTE.exec(lines[i]);
          q.push(qm ? qm[1] : lines[i]);
          i++;
        }
        var callout = null;
        var cm = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i.exec(q[0] || "");
        if (cm) {
          callout = cm[1].toUpperCase();
          q = (cm[2] ? [cm[2]] : []).concat(q.slice(1));
        }
        blocks.push({ t: "quote", callout: callout, title: callout ? CALLOUTS[callout] : "", c: parseBlocks(q, depth + 1) });
        continue;
      }

      var lm = LIST.exec(line);
      if (lm) {
        var ordered = /\d/.test(lm[2].charAt(0));
        var base = lm[1].length;
        var start = ordered ? parseInt(lm[2], 10) : 1;
        var items = [];
        while (i < lines.length) {
          var m = LIST.exec(lines[i]);
          if (!m || m[1].length !== base || /\d/.test(m[2].charAt(0)) !== ordered) break;
          var contentIndent = base + m[2].length + 1;
          var itemLines = [m[3]];
          i++;
          while (i < lines.length) {
            var l2 = lines[i];
            if (!l2.trim()) {
              // a blank line stays in the item only if an indented line follows
              var k = i + 1;
              while (k < lines.length && !lines[k].trim()) k++;
              if (k < lines.length && /^ +/.test(lines[k]) && lines[k].match(/^ */)[0].length > base) { itemLines.push(""); i++; continue; }
              break;
            }
            var ind = l2.match(/^ */)[0].length;
            if (ind <= base) {
              var sib = LIST.exec(l2);
              if (sib || startsBlock(l2, lines[i + 1])) break;
              itemLines.push(l2.trim()); i++; continue; // a lazy continuation of the paragraph
            }
            itemLines.push(l2.slice(Math.min(ind, contentIndent)));
            i++;
          }
          var task = null;
          var tm = /^\[( |x|X)\][ \t]+(.*)$/.exec(itemLines[0]);
          if (tm) { task = tm[1] !== " "; itemLines[0] = tm[2]; }
          items.push({ task: task, c: parseBlocks(itemLines, depth + 1) });
          while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1]) && LIST.exec(lines[i + 1])[1].length === base) i++;
        }
        blocks.push({ t: "list", ordered: ordered, start: start, items: items });
        continue;
      }

      var para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
      var joined = para.map(function (l) { return l.replace(/[ \t]+$/, ""); }).join("\n");
      var only = para.length === 1 ? safeUrl(para[0].trim()) : null;
      // A line that is only a link, [Title](https://...), is a card that shows the title too.
      var titled = para.length === 1 ? /^\[([^\[\]\n]{1,300})\]\(([^()\s]{1,2000})\)$/.exec(para[0].trim()) : null;
      var titledHref = titled && /^https?:\/\//i.test(titled[2]) ? safeUrl(titled[2]) : null;
      if (only && /^https?:\/\//i.test(para[0].trim())) blocks.push({ t: "card", href: only });
      else if (titledHref) {
        var cardTitle = titled[1].replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, "$1").trim();
        blocks.push(cardTitle && cardTitle !== titled[2] && cardTitle !== titledHref ? { t: "card", href: titledHref, title: cardTitle } : { t: "card", href: titledHref });
      }
      else blocks.push({ t: "p", c: parseInline(joined, 0) });
    }
    return blocks;
  }

  function parse(src) {
    var s = typeof src === "string" ? src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ") : "";
    return parseBlocks(s.split("\n"), 0);
  }

  // Titles used by [[links]] and the ids of images used, for the editor and checks.
  function collect(tree) {
    var wiki = [], images = [];
    (function walk(nodes) {
      nodes.forEach(function (n) {
        if (n.t === "wiki" && wiki.indexOf(n.title) === -1) wiki.push(n.title);
        if (n.t === "img" && images.indexOf(n.id) === -1) images.push(n.id);
        if (n.c) walk(n.c);
        if (n.items) n.items.forEach(function (it) { walk(it.c); });
        if (n.head) { n.head.forEach(walk); n.rows.forEach(function (r) { r.forEach(walk); }); }
      });
    })(tree);
    return { wiki: wiki, images: images };
  }

  // ---------------------------------------------------------------------- DOM

  // cx: {
  //   imageUrl(id) -> string        where an uploaded image is fetched from
  //   findNote(title) -> id | null  which note (or article) a [[title]] means
  //   hrefFor(id) -> string         where that link goes (default "#<id>")
  //   missingTitle(title) -> string the tooltip for a [[title]] that matches nothing
  // }
  function toDom(tree, doc, cx) {
    cx = cx || {};
    function el(name, cls, parent) {
      var e = doc.createElement(name);
      if (cls) e.className = cls;
      if (parent) parent.appendChild(e);
      return e;
    }

    function inline(nodes, parent) {
      nodes.forEach(function (n) {
        switch (n.t) {
          case "text": parent.appendChild(doc.createTextNode(n.v)); break;
          case "br": el("br", "", parent); break;
          case "code": el("code", "", parent).textContent = n.v; break;
          case "strong": inline(n.c, el("strong", "", parent)); break;
          case "em": inline(n.c, el("em", "", parent)); break;
          case "del": inline(n.c, el("del", "", parent)); break;
          case "span": inline(n.c, el("span", "", parent)); break;
          case "link": {
            var a = el("a", "", parent);
            a.setAttribute("href", n.href);
            a.setAttribute("rel", "noopener noreferrer nofollow");
            if (/^https?:/i.test(n.href)) a.setAttribute("target", "_blank");
            inline(n.c, a);
            break;
          }
          case "img": {
            if (!IMAGE_ID.test(n.id) || !cx.imageUrl) { parent.appendChild(doc.createTextNode(n.alt || "")); break; }
            var img = el("img", "nb-img", parent);
            img.crossOrigin = "use-credentials"; // the login cookie must ride along; the image is private
            img.setAttribute("loading", "lazy");
            img.setAttribute("alt", n.alt || "");
            img.setAttribute("src", cx.imageUrl(n.id));
            break;
          }
          case "wiki": {
            var id = cx.findNote ? cx.findNote(n.title) : null;
            if (id && NOTE_ID.test(id)) {
              var w = el("a", "wiki", parent);
              w.setAttribute("href", cx.hrefFor ? cx.hrefFor(id) : "#" + id);
              w.setAttribute("data-note", id);
              w.textContent = n.label;
            } else {
              var m = el("span", "wiki missing", parent);
              m.setAttribute("title", cx.missingTitle ? cx.missingTitle(n.title) : "No note called “" + n.title + "” yet — click to create it");
              m.setAttribute("data-wiki", n.title);
              m.textContent = n.label;
            }
            break;
          }
        }
      });
    }

    function blocks(nodes, parent) {
      nodes.forEach(function (n) {
        switch (n.t) {
          case "h": inline(n.c, el("h" + Math.min(6, n.level + 0), "", parent)); break;
          case "p": inline(n.c, el("p", "", parent)); break;
          case "hr": el("hr", "", parent); break;
          case "code": {
            var pre = el("pre", "", parent);
            var code = el("code", "", pre);
            if (n.lang) code.setAttribute("data-lang", n.lang.slice(0, 20));
            code.textContent = n.v;
            break;
          }
          case "quote": {
            if (n.callout) {
              var box = el("div", "callout callout-" + n.callout.toLowerCase(), parent);
              box.setAttribute("role", "note");
              el("div", "callout-title", box).textContent = n.title;
              blocks(n.c, el("div", "callout-body", box));
            } else blocks(n.c, el("blockquote", "", parent));
            break;
          }
          case "list": {
            var list = el(n.ordered ? "ol" : "ul", "", parent);
            if (n.ordered && n.start !== 1) list.setAttribute("start", String(n.start));
            var hasTask = n.items.some(function (it) { return it.task !== null; });
            if (hasTask) list.className = "tasks";
            n.items.forEach(function (it) {
              var li = el("li", it.task !== null ? "task" + (it.task ? " done" : "") : "", list);
              if (it.task !== null) {
                var box2 = el("input", "task-box", li);
                box2.setAttribute("type", "checkbox");
                box2.setAttribute("disabled", "");
                box2.setAttribute("aria-label", it.task ? "Done" : "Not done");
                if (it.task) box2.setAttribute("checked", "");
                blocks(it.c, el("div", "task-text", li));
              } else blocks(it.c, li);
            });
            break;
          }
          case "table": {
            var wrap = el("div", "table-wrap", parent);
            var table = el("table", "", wrap);
            var trh = el("tr", "", el("thead", "", table));
            n.head.forEach(function (c, ci) {
              var th = el("th", "", trh);
              if (n.align[ci]) th.setAttribute("data-align", n.align[ci]);
              inline(c, th);
            });
            var tb = el("tbody", "", table);
            n.rows.forEach(function (r) {
              var tr = el("tr", "", tb);
              r.forEach(function (c, ci) {
                var td = el("td", "", tr);
                if (n.align[ci]) td.setAttribute("data-align", n.align[ci]);
                inline(c, td);
              });
            });
            break;
          }
          case "card": {
            var a = el("a", "linkcard", parent);
            a.setAttribute("href", n.href);
            a.setAttribute("rel", "noopener noreferrer nofollow");
            a.setAttribute("target", "_blank");
            var u = new URL(n.href);
            if (n.title) el("span", "lc-title", a).textContent = n.title;
            el("span", "lc-host", a).textContent = u.hostname.replace(/^www\./, "");
            var rest = (u.pathname === "/" ? "" : u.pathname) + u.search;
            el("span", "lc-path", a).textContent = rest.length > 80 ? rest.slice(0, 79) + "…" : rest || n.href;
            break;
          }
        }
      });
    }

    var frag = doc.createDocumentFragment ? doc.createDocumentFragment() : el("div");
    blocks(tree, frag);
    return frag;
  }

  var api = { parse: parse, toDom: toDom, collect: collect, safeUrl: safeUrl, parseInline: function (s) { return parseInline(s, 0); } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardMarkdown = api;
})(typeof window !== "undefined" ? window : this);
