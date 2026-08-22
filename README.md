# study-hub

Static site at [study.barnyard.site](https://study.barnyard.site/), listing ongoing and completed certifications and their revision notes. Linked from the "Study" tile on [dashboard.barnyard.site](https://dashboard.barnyard.site/) (barnyard-hub).

No build step, no framework — plain HTML/CSS/vanilla JS, deployed via GitHub Pages, same conventions as the barnyard-hub and market-dashboard repos in this account.

## Architecture

- `index.html` / `style.css` / `app.js` — the page shell and renderer. `app.js` fetches `data.json` client-side and builds the ongoing/completed lists; revision notes (`notes/*.html`) are fetched lazily, only when a cert's "Revision notes" `<details>` is expanded.
- `data.json` — the certification list (name, status, Notion link, notes reference). **This is a static, committed snapshot, not a live query** — the page itself never calls the Notion API (that would require exposing a Notion integration token client-side, which this site deliberately never does).
- `notes/*.html` — revision-notes fragments, one per certification that has them. Plain semantic HTML (`<h3>`/`<ul>`/`<p>`), injected via `innerHTML` in `app.js` — safe because these are build-time-generated trusted files, not user input (unlike barnyard-hub's calendar/to-do data, which is untrusted and stays `textContent`-only).

## Where the data comes from

Source of truth is the **✅ Knowledgebase** database in the "Claude PM Workspace" Notion workspace (`collection://255a25f1-dd2d-8119-b3a7-000b56b22e1d`), which has a `Status` property (`Not started` / `In progress` / `Done`) per certification/course page. "Ongoing" = anything not yet `Done`.

## Refreshing the data (manual, or via a scheduled agent)

This has no CI pipeline (unlike ClaudeRepo's market-dashboard pipeline) — refreshing is a manual or agent-driven process:

1. Query the Knowledgebase data source for the current `Name`/`Status`/`url` of every row.
2. Diff against `data.json`'s current `ongoing`/`completed` lists — move anything now `Done` into `completed`, anything newly `In progress`/`Not started` into `ongoing`.
3. For any `ongoing` cert that doesn't yet have a `notesUrl` and has substantial Notion content (a few hundred+ words), generate a revision-notes summary: read the cert's full Notion page content, write a condensed-but-substantive summary (headings matching the source's own topic structure, preserve enumerated lists, keep specific numbers/thresholds — don't pad with generic filler), save it as `notes/<slug>.html` (semantic HTML, matching `notes/sc-300.html`'s style), and reference it via `notesUrl` in `data.json`.
4. Update `data.json`'s top-level `generated` date.
5. Commit and push to `main` — GitHub Pages redeploys automatically.

This was last done by hand on 2026-08-23 (initial build). A scheduled cloud task is set up to repeat this weekly — see the Claude PM Workspace's Progress Planner entry for this project for the schedule details.

## Deploy

GitHub Pages, custom domain `study.barnyard.site` (see `CNAME`), DNS + TLS via Cloudflare (proxied CNAME on the `barnyard.site` zone, matching `dashboard`/`stocks`/`api`'s existing setup).
