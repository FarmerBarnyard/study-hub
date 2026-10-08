// Knowledgebase -- turning notes into an article draft (no AI, no network).
//
// "Generate an article" starts here: one or more notes go in, a tidy draft comes
// out that the author then edits and publishes (knowledgebase.html). This file only
// reshapes Markdown the author already wrote; it never rewrites their words.
//
//   draftFromNotes(notes, { title, publishedTitles }) -> { title, summary, tags, body, report }
//
// What it does:
//   - tidies the text (line endings, runs of blank lines, empty headings, an
//     unclosed code fence) and drops the note's own first heading when it just repeats the title;
//   - shifts heading levels so the article's sections start at "##" (the title is
//     shown as the page heading); with several notes each note becomes a "##" section;
//   - turns [[links]] into plain text unless they point at an article that is
//     already published (other people cannot open your notes);
//   - takes the first real paragraph as the summary and gathers the notes' tags.
//
// Plain script, no build step; exported for Node tests as well as the page.
(function (root) {
  "use strict";

  var MAX_SUMMARY = 300;
  var MAX_TAGS = 8;

  function lines(text) { return String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n"); }

  // Visit every line with whether it sits inside a fenced code block.
  function eachLine(text, fn) {
    var fence = null;
    lines(text).forEach(function (line, i) {
      var m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      var inCode = fence !== null;
      if (m) {
        if (fence === null) { fence = m[1].charAt(0); inCode = true; }
        else if (m[1].charAt(0) === fence) { fence = null; inCode = true; }
      }
      fn(line, inCode, i);
    });
  }

  function headingLevel(line) {
    var m = /^(#{1,6})\s+\S/.exec(line);
    return m ? m[1].length : 0;
  }

  // Remove an unclosed fence's trouble: close it at the end of the text.
  function closeFences(text) {
    var open = null;
    eachLine(text, function (line, inCode) {
      var m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (m) open = open === null ? m[1] : (m[1].charAt(0) === open.charAt(0) ? null : open);
    });
    return open === null ? text : text.replace(/\s*$/, "") + "\n" + open + "\n";
  }

  // Line endings, trailing spaces, 3+ blank lines -> 2, empty headings, edge blank lines.
  function cleanBody(text) {
    var out = [], blank = 0;
    eachLine(String(text == null ? "" : text), function (line, inCode) {
      if (!inCode) {
        line = line.replace(/[ \t]+$/, "");
        if (/^#{1,6}\s*$/.test(line)) return;                     // an empty heading
        if (/^<!--.*-->$/.test(line.trim())) return;              // a stray HTML comment line
      }
      if (!inCode && line === "") { blank++; if (blank > 1) return; } else blank = 0;
      out.push(line);
    });
    var joined = closeFences(out.join("\n")).replace(/^\n+/, "").replace(/\n+$/, "");
    return joined ? joined + "\n" : "";
  }

  // The note's first heading is dropped when it only repeats the title.
  function stripLeadingTitle(text, title) {
    var ls = lines(text), i = 0;
    while (i < ls.length && !ls[i].trim()) i++;
    if (i < ls.length && headingLevel(ls[i]) && ls[i].replace(/^#{1,6}\s+/, "").trim().toLowerCase() === String(title || "").trim().toLowerCase()) {
      ls.splice(i, 1);
    }
    return ls.join("\n");
  }

  // Shift every heading so the shallowest one is `to`; levels stay within 1..6.
  function shiftHeadings(text, to) {
    var min = 7;
    eachLine(text, function (line, inCode) { var l = !inCode && headingLevel(line); if (l && l < min) min = l; });
    if (min === 7) return String(text);
    var delta = to - min;
    if (delta === 0) return String(text);
    var out = [];
    eachLine(text, function (line, inCode) {
      var l = !inCode && headingLevel(line);
      if (!l) { out.push(line); return; }
      var next = Math.min(6, Math.max(1, l + delta));
      out.push(new Array(next + 1).join("#") + line.slice(l));
    });
    return out.join("\n");
  }

  // [[Title]] / [[Title|label]] -> the label as plain text, unless `keep` (a set of
  // lower-cased titles of published articles) has that title. Returns {text, removed:[titles]}.
  function flattenLinks(text, keep) {
    var removed = [], pub = keep || {};
    var out = [];
    eachLine(text, function (line, inCode) {
      if (inCode) { out.push(line); return; }
      out.push(line.replace(/\[\[([^\]\n|]{1,200})(?:\|([^\]\n]{0,200}))?\]\]/g, function (all, title, label) {
        var t = title.trim();
        if (pub[t.toLowerCase()]) return all;
        if (removed.indexOf(t) === -1) removed.push(t);
        return (label && label.trim()) || t;
      }));
    });
    return { text: out.join("\n"), removed: removed };
  }

  // Plain text of Markdown inline syntax, for a summary line.
  function plain(s) {
    return String(s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, function (a, t, l) { return l || t; })
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // The first paragraph of ordinary prose (not a heading, list, quote, table, code, image or link card).
  function firstParagraph(text, max) {
    return clip(proseOf(text).paras[0] || "", max || MAX_SUMMARY);
  }

  // Cut to `limit` characters at the end of a sentence if there is one past the middle, else at a word.
  function clip(found, limit) {
    if (found.length <= limit) return found;
    var cut = found.slice(0, limit);
    var stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (stop > limit * 0.5) return cut.slice(0, stop + 1);
    var sp = cut.lastIndexOf(" ");
    return (sp > limit * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "…";
  }

  var CAPTION = /^(image|figure|fig\.?|table|source)\s*\d*\s*[:.\-–]/i;
  function words(s) { return (String(s).match(/[\p{L}\p{N}']+/gu) || []).length; }

  // Ordinary prose paragraphs and list items, in order, as plain text: not headings, quotes, tables,
  // code, images, link cards or picture captions ("Image 1: ...").
  function proseOf(text) {
    var paras = [], items = [], para = [];
    function flush() {
      if (para.length) { var p = plain(para.join(" ")); if (p && !CAPTION.test(p)) paras.push(p); }
      para = [];
    }
    eachLine(text, function (line, inCode) {
      var t = line.trim();
      if (inCode) { flush(); return; }
      if (!t) { flush(); return; }
      var item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(t);
      if (item) { flush(); var it = plain(item[1]); if (it && !CAPTION.test(it)) items.push(it); return; }
      var prose = !/^(#{1,6}\s|>|\||!\[|={3,}|-{3,}$)/.test(t) && !/^(\[[^\]]+\]\()?https?:\/\/\S+\)?$/.test(t);
      if (!prose) { flush(); return; }
      para.push(t);
    });
    flush();
    return { paras: paras, items: items };
  }

  // A line for the top of an article, from the text alone: the first real paragraph (long enough to say
  // something), else the first sentence-like list item, else what the article covers (its section
  // headings), else whatever short paragraph there is.
  function summaryOf(text, max) {
    var limit = max || MAX_SUMMARY, p = proseOf(text);
    var para = p.paras.filter(function (s) { return words(s) >= 8; })[0];
    if (para) return clip(para, limit);
    var item = p.items.filter(function (s) { return words(s) >= 6; })[0];
    if (item) return clip(item, limit);
    var heads = headingsOf(text).filter(function (h) { return h.level >= 2 && h.level <= 3 && h.text; }).map(function (h) { return h.text; });
    if (heads.length >= 2) {
      var shown = heads.slice(0, 3);
      var list = shown.length === 2 ? shown.join(" and ") : shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1];
      return clip("Covers " + list + (heads.length > 3 ? " and more" : "") + ".", limit);
    }
    return clip(p.paras[0] || p.items[0] || "", limit);
  }

  function headingsOf(text) {
    var out = [];
    eachLine(text, function (line, inCode) {
      var l = !inCode && headingLevel(line);
      if (l) out.push({ level: l, text: plain(line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")) });
    });
    return out;
  }

  function countOf(text) {
    var images = (String(text).match(/\(img:im_[a-z0-9]{8}\)/g) || []).length;
    var fences = 0, cards = 0;
    eachLine(text, function (line, inCode) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fences++;
      if (!inCode && /^(\[[^\]]+\]\()?https?:\/\/\S+\)?$/.test(line.trim())) cards++;
    });
    var words = (plain(String(text).replace(/```[\s\S]*?(```|$)/g, " ")).match(/[\p{L}\p{N}']+/gu) || []).length;
    return { words: words, images: images, codeBlocks: Math.floor(fences / 2), linkCards: cards };
  }

  function mergeTags(notes) {
    var out = [];
    notes.forEach(function (n) {
      (n.tags || []).forEach(function (t) {
        var tag = String(t).trim().toLowerCase();
        if (tag && tag.length <= 40 && !/[,\n]/.test(tag) && out.indexOf(tag) === -1 && out.length < MAX_TAGS) out.push(tag);
      });
    });
    return out;
  }

  // notes: [{ title, body, tags }] in the order they should appear.
  // opts:  { title, publishedTitles: [titles of articles already in the library] }
  function draftFromNotes(notes, opts) {
    opts = opts || {};
    var list = (notes || []).filter(function (n) { return n && typeof n.body === "string"; });
    var keep = {};
    (opts.publishedTitles || []).forEach(function (t) { keep[String(t).toLowerCase()] = true; });
    var title = String(opts.title || (list[0] && list[0].title) || "Untitled article").trim();
    var parts = [], removed = [];
    list.forEach(function (n) {
      var body = cleanBody(stripLeadingTitle(n.body, n.title));
      if (list.length === 1) body = shiftHeadings(body, 2);
      else body = shiftHeadings(body, 3);
      var flat = flattenLinks(body, keep);
      flat.removed.forEach(function (t) { if (removed.indexOf(t) === -1) removed.push(t); });
      body = flat.text.replace(/^\n+/, "").replace(/\n+$/, "");
      parts.push(list.length === 1 ? body : "## " + String(n.title || "Untitled").trim() + "\n\n" + body);
    });
    var body = cleanBody(parts.join("\n\n"));
    var counts = countOf(body);
    return {
      title: title,
      summary: summaryOf(body, MAX_SUMMARY),
      tags: mergeTags(list),
      body: body,
      report: { words: counts.words, images: counts.images, codeBlocks: counts.codeBlocks, linkCards: counts.linkCards, sections: headingsOf(body).filter(function (h) { return h.level === 2; }).length, flattenedLinks: removed },
    };
  }

  // An anchor id for a heading, unique within `seen` (an object the caller keeps per article).
  function headingId(text, seen) {
    var base = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
    var id = base, n = 2;
    while (seen[id]) id = base + "-" + (n++);
    seen[id] = true;
    return id;
  }

  // The summary and key points written by the optional local model go at the top as a callout.
  function withKeyPoints(body, takeaways) {
    var pts = (takeaways || []).map(function (t) { return String(t).replace(/\s+/g, " ").trim(); }).filter(Boolean).slice(0, 5);
    if (!pts.length) return body;
    var block = "> [!TIP]\n> **Key points**\n" + pts.map(function (p) { return "> - " + p; }).join("\n") + "\n\n";
    return block + String(body).replace(/^> \[!TIP\]\n> \*\*Key points\*\*\n(?:>.*\n?)*\n*/, "");
  }

  // ---- rewriting an article one passage at a time with the site's model ----------------------
  //
  // The model is slow, so the article is cut into units of about 90 words and each prose unit
  // is sent on its own (see kb-logic.js on the Worker). Headings, code blocks, tables, quotes,
  // pictures, link cards and short lines are never sent; inline code, links and images inside
  // a sent unit are swapped for markers (⟦1⟧ ...) that must come back exactly once each, so
  // the model cannot change a command or an address. A rewrite that fails any check is
  // dropped and the author's own words stay.

  var AI_CHUNK_WORDS = 90;
  var AI_MIN_WORDS = 12;

  // The article as units: { text, ai, heading, sep }. Joining text + sep rebuilds it.
  function splitForAi(body, maxWords) {
    var limit = maxWords || AI_CHUNK_WORDS;
    var blocks = [], cur = [], fence = null;
    function flush() { if (cur.length) { blocks.push(cur.join("\n")); cur = []; } }
    lines(body).forEach(function (line) {
      var m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence === null) {
        if (m) { flush(); fence = m[1].charAt(0); cur.push(line); return; }
        if (!line.trim()) { flush(); return; }
        if (headingLevel(line)) { flush(); blocks.push(line); return; }
        cur.push(line);
      } else {
        cur.push(line);
        if (m && m[1].charAt(0) === fence) { fence = null; flush(); }
      }
    });
    flush();

    var units = [], heading = "";
    blocks.forEach(function (b) {
      var first = b.split("\n")[0];
      if (headingLevel(first) && b.indexOf("\n") === -1) { heading = plain(first.replace(/^#{1,6}\s+/, "")); units.push({ text: b, ai: false, heading: heading, sep: "\n\n" }); return; }
      var rewritable = !/^\s{0,3}(`{3,}|~{3,})/.test(first) && !/^\|/.test(first) && !/^>/.test(first) && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(first) &&
        !b.split("\n").every(function (l) { return /^!\[[^\]]*\]\([^)]*\)\s*$/.test(l.trim()) || /^(\[[^\]]+\]\()?https?:\/\/\S+\)?$/.test(l.trim()); }) &&
        words(b) >= AI_MIN_WORDS;
      if (!rewritable) { units.push({ text: b, ai: false, heading: heading, sep: "\n\n" }); return; }
      var isList = b.split("\n").some(function (l) { return /^\s*(?:[-*+]|\d+[.)])\s/.test(l); });
      var parts = [];
      if (words(b) <= limit) parts = [b];
      else if (isList) {
        var acc = [], n = 0;
        b.split("\n").forEach(function (l) {
          var w = words(l);
          if (acc.length && n + w > limit) { parts.push(acc.join("\n")); acc = []; n = 0; }
          acc.push(l); n += w;
        });
        if (acc.length) parts.push(acc.join("\n"));
      } else {
        var sentences = b.replace(/\n/g, " ").match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [b];
        var cur2 = "", n2 = 0;
        sentences.forEach(function (s) {
          var w = words(s);
          if (cur2 && n2 + w > limit) { parts.push(cur2.trim()); cur2 = ""; n2 = 0; }
          cur2 += s; n2 += w;
        });
        if (cur2.trim()) parts.push(cur2.trim());
      }
      parts.forEach(function (p, i) {
        units.push({ text: p, ai: true, heading: heading, sep: i === parts.length - 1 ? "\n\n" : (isList ? "\n" : " ") });
      });
    });
    return units;
  }

  function joinUnits(units) {
    var s = units.map(function (u) { return u.text + u.sep; }).join("").replace(/\s+$/, "");
    return s ? s + "\n" : "";
  }

  var PROTECT = /!\[[^\]]*\]\([^)]*\)|\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]+`|https?:\/\/[^\s)]+/g;

  // -> { text, tokens }: inline code, links, images and addresses replaced by ⟦n⟧.
  function protect(text) {
    var tokens = [];
    var out = String(text).replace(PROTECT, function (m) { tokens.push(m); return "⟦" + tokens.length + "⟧"; });
    return { text: out, tokens: tokens };
  }

  // Puts the tokens back; null if any marker is missing, repeated or invented.
  function restore(text, tokens) {
    var s = String(text);
    for (var i = 0; i < tokens.length; i++) {
      var mark = "⟦" + (i + 1) + "⟧";
      if (s.split(mark).length !== 2) return null;
    }
    var seen = s.match(/⟦\d+⟧/g) || [];
    if (seen.length !== tokens.length) return null;
    return s.replace(/⟦(\d+)⟧/g, function (m, n) { return tokens[Number(n) - 1]; });
  }

  // Is this restored rewrite plausibly the same passage? Not much shorter or longer, no
  // headings or code fences added, nothing left of the markers.
  function acceptRewrite(original, rewritten) {
    if (typeof rewritten !== "string" || !rewritten.trim()) return false;
    if (/⟦|⟧/.test(rewritten)) return false;
    if (/^\s{0,3}(#{1,6}\s|`{3,}|~{3,})/m.test(rewritten)) return false;
    var a = words(protect(original).text), b = words(protect(rewritten).text);
    if (!a || b < a * 0.4 || b > a * 1.7) return false;
    return true;
  }

  var api = {
    draftFromNotes: draftFromNotes, cleanBody: cleanBody, stripLeadingTitle: stripLeadingTitle, shiftHeadings: shiftHeadings,
    flattenLinks: flattenLinks, firstParagraph: firstParagraph, summaryOf: summaryOf, headingsOf: headingsOf, headingId: headingId,
    withKeyPoints: withKeyPoints, countOf: countOf, plain: plain,
    splitForAi: splitForAi, joinUnits: joinUnits, protect: protect, restore: restore, acceptRewrite: acceptRewrite,
    AI_CHUNK_WORDS: AI_CHUNK_WORDS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardKbFormat = api;
})(typeof window !== "undefined" ? window : this);
