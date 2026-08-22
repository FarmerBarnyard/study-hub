# study-hub

Static site at [study.barnyard.site](https://study.barnyard.site/), listing ongoing and completed certifications and their revision notes. Linked from the "Study" tile on [dashboard.barnyard.site](https://dashboard.barnyard.site/) (barnyard-hub).

No build step, no framework — plain HTML/CSS/vanilla JS, deployed via GitHub Pages, same conventions as the barnyard-hub and market-dashboard repos in this account.

## Architecture

- `index.html` / `style.css` / `app.js` — the page shell and renderer. `app.js` fetches `data.json` client-side and builds the ongoing/completed lists; revision notes (`notes/*.html`) are fetched lazily, only when a cert's "Revision notes" `<details>` is expanded.
- `data.json` — the certification list (name, status, Notion link, notes reference). **This is a static, committed snapshot, not a live query** — the page itself never calls the Notion API (that would require exposing a Notion integration token client-side, which this site deliberately never does).
- `notes/*.html` — revision-notes fragments, one per certification that has them. Plain semantic HTML (`<h3>`/`<ul>`/`<p>`), injected via `innerHTML` in `app.js` — safe because these are build-time-generated trusted files, not user input (unlike barnyard-hub's calendar/to-do data, which is untrusted and stays `textContent`-only).

## Where the data comes from

Source of truth is the **✅ Knowledgebase** database in the "Claude PM Workspace" Notion workspace (`collection://255a25f1-dd2d-8119-b3a7-000b56b22e1d`), which has a `Status` property (`Not started` / `In progress` / `Done`) per certification/course page. "Ongoing" = anything not yet `Done`.

## `data.json` schema

```jsonc
{
  "generated": "2026-08-23",   // plain string, shown verbatim in the "Last synced" note
  "source": "…",               // free-text description of where this snapshot came from
  "ongoing": [
    {
      "name": "SC-300",                                              // required
      "fullName": "SC-300: Microsoft Identity and Access Administrator", // optional; omit or match `name` to suppress the subtitle line
      "status": "In progress",                                       // "In progress" | "Not started" | "Done" — drives the badge color
      "notionUrl": "https://app.notion.com/…",                       // required for a "View notes in Notion" link to render at all
      "notesUrl": "notes/sc-300.html"                                // optional; omit entirely if no revision notes exist yet
    }
  ],
  "completed": [
    { "name": "…", "notionUrl": "https://app.notion.com/…" }         // status/fullName/notesUrl are never rendered for completed entries, even if present
  ]
}
```

`app.js`'s `normalizeCert()` treats a missing/empty `name` as `"(untitled certification)"` and a `notionUrl` that isn't a real `https://` string as absent (no link rendered, rather than a broken `href="undefined"`) — so a malformed entry degrades visibly rather than silently, but the goal is still to keep every entry complete.

## Refreshing the data (manual, or via a scheduled agent)

This has no CI pipeline (unlike ClaudeRepo's market-dashboard pipeline) — refreshing is a manual or agent-driven process:

1. Query the Knowledgebase data source for the current `Name`/`Status`/`url` of every row.
2. Diff against `data.json`'s current `ongoing`/`completed` lists — move anything now `Done` into `completed`, anything newly `In progress`/`Not started` into `ongoing`. Follow the schema above exactly (don't drop `fullName` — it's read and rendered, not just decorative).
3. For any `ongoing` cert that doesn't yet have a `notesUrl` and has substantial Notion content (a few hundred+ words), generate a revision-notes summary: read the cert's full Notion page content, write a condensed-but-substantive summary (headings matching the source's own topic structure, preserve enumerated lists, keep specific numbers/thresholds — don't pad with generic filler), save it as `notes/<slug>.html` (semantic HTML, matching `notes/sc-300.html`'s style: only `h3`/`ul`/`ol`/`li`/`p`/`strong`/`em`/`code`/`br`, no attributes on any tag), and reference it via `notesUrl` in `data.json`.
   - **Escape every character pulled from Notion** (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`) before writing it into the fragment — these fragments are injected via `innerHTML` on the trust assumption that they're clean, build-time-generated HTML, not arbitrary text. Notion pages routinely contain pasted third-party text; don't let that defeat the assumption.
   - **No images.** `img-src 'self'` in `index.html`'s CSP blocks any `<img>` pointing at Notion's S3-hosted attachments — carrying a diagram or screenshot over from a Notion page into a notes fragment will silently fail to load. If a cert's notes genuinely need an image, commit it into this repo (e.g. `notes/img/`) so it's same-origin, rather than linking the Notion-hosted URL.
4. Update `data.json`'s top-level `generated` date.
5. Commit and push to `main` — GitHub Pages redeploys automatically.

This was last done by hand on 2026-08-23 (initial build). Repeating this on a schedule (e.g. weekly) is the intended long-term shape of "automatically create study revision notes" — check the Claude PM Workspace's Progress Planner entry for this project for whether a scheduled task has actually been set up yet before assuming this happens without being triggered.

## Deploy

GitHub Pages, custom domain `study.barnyard.site` (see `CNAME`), DNS + TLS via Cloudflare (proxied CNAME on the `barnyard.site` zone, matching `dashboard`/`stocks`/`api`'s existing setup).
