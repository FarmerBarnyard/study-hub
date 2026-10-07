# study-hub

Static site at [study.barnyard.site](https://study.barnyard.site/), listing ongoing and completed certifications and their revision notes. Linked from the "Study" tile on [dashboard.barnyard.site](https://dashboard.barnyard.site/) (barnyard-hub).

No build step, no framework — plain HTML/CSS/vanilla JS, deployed via GitHub Pages, same conventions as the barnyard-hub and market-dashboard repos in this account.

## Architecture

- `index.html` / `style.css` / `app.js` — the page shell and renderer. `app.js` fetches `data.json` client-side and builds the ongoing/completed lists; revision notes (`notes/*.html`) are fetched lazily, only when a cert's "Revision notes" `<details>` is expanded.
- `data.json` — the certification list (name, status, Notion link, notes reference). **This is a static, committed snapshot, not a live query** — the page itself never calls the Notion API directly (that would require exposing a Notion integration token client-side, which this site deliberately never does). The one live call this site does make is the "Generate revision notes" button below.
- `notes/*.html` — pre-authored revision-notes fragments, one per certification that has them at build time. Plain semantic HTML (`<h3>`/`<ul>`/`<p>`), injected via `innerHTML` in `app.js` — safe because these are build-time-generated trusted files, not user input (unlike barnyard-hub's calendar/to-do data, which is untrusted and stays `textContent`-only).

## "Generate revision notes" button (live, on-demand generation)

Every `ongoing` cert with a `slug` in `data.json` gets a "Generate revision notes" (or "Regenerate notes", if content already exists) button. Clicking it calls `POST https://api.barnyard.site/generate-notes` — a Cloudflare Worker route (in the separate `ClaudeRepo` repo's `cloudflare-worker/`) that fetches the cert's Notion page content server-side and asks Claude to condense it into structured revision notes, returned as JSON.

**This is a real, paid API call every time it's clicked** — see `ClaudeRepo/cloudflare-worker/README.md`'s "Revision notes generation setup" section for the full cost breakdown, the setup steps (a Notion integration + an Anthropic API key, both set as Worker secrets — this repo has no involvement in that setup), and the honest limits of this route's abuse-mitigation (no real authentication, by design — see that README for why).

Freshly generated notes are rendered via `createElement`/`textContent` (not `innerHTML` — this content is model-generated at request time, not pre-authored trusted content the way `notes/*.html` fragments are) and cached in **this browser's own `localStorage` only**. That means:
- A repeat visit from the same browser shows the cached version instantly, with no new API call, until "Regenerate notes" is clicked again.
- The generated notes are **not synced anywhere** — a different browser, device, or visitor sees the static `notes/*.html` fragment (if one exists) or the "Generate" button again, never someone else's generated copy. This is a deliberate, low-effort choice to avoid needing a second write-back mechanism (e.g. committing to this repo via the GitHub API) for what is fundamentally a single-user personal site.
- A cached generated version takes precedence over the static `notes/*.html` fragment on that same browser, on the assumption that a click-triggered regeneration is newer/more current than whatever was last committed.

Adding "Generate" support for a new cert requires **two separate changes**, not one: add a `"slug"` field to that cert's entry in `data.json` here, AND add a matching entry to `CERT_NOTION_PAGES` in the Worker's `src/index.js` (in `ClaudeRepo`). The slug must match exactly (`^[a-z0-9-]+$`, matching the Worker's own allowlist keys) — `app.js`'s `normalizeCert()` silently drops anything else, and the Worker independently rejects any slug it doesn't recognize.

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
      "notesUrl": "notes/sc-300.html",                               // optional; omit entirely if no pre-authored revision notes exist yet
      "slug": "sc-300"                                               // optional; enables the "Generate/Regenerate notes" button -- must match a key in the Worker's CERT_NOTION_PAGES allowlist (see below)
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

This was last done by hand on 2026-08-23 (initial build). It produces the **pre-authored baseline** shown to any visitor with no localStorage cache of their own — the "Generate/Regenerate notes" button above is the complementary on-demand path for the account owner's own browser, and doesn't require this manual process to be repeated on a schedule. A scheduled agent-driven refresh of this baseline (step 1-2 above) is still worth doing periodically to keep the ongoing/completed split itself current — check the Claude PM Workspace's Progress Planner entry for this project for whether that's been set up.

## Shared shell and themes (2026-10-08)

This page now sits in the same shell as the dashboard: a left sidebar (Overview, Ops board, Study, Campaign, Stocks), a top bar (jump search, light/dark, Settings) and a Settings panel with 18 colour themes, 18 backgrounds, density and sidebar options. The choice follows you between the barnyard.site pages through a small `bh_prefs` cookie (look-and-feel keys only, validated on read).

- `themes.js`, `shell.js`, `shell.css` and `fonts/` are **hand-copied unchanged from barnyard-hub**, the same way `auth-gate.js` is. They are not edited here; change them in barnyard-hub and copy them out again. `test/shell.test.js` checks them (every theme readable in both modes, every background has CSS, the page stays inside its CSP).
- `style.css` is now only this page's own layout (certification rows, status dots, revision notes, the generate button).
- The Notion sync note turns red and says how old the snapshot is once it passes 14 days (`describeSync` in `app.js`, tested), because a stale list looks exactly like a current one.
- Script order matters: `shell.js` before `auth-gate.js` (it creates `#auth-status`), `themes.js` in `<head>`.
## Deploy

GitHub Pages, custom domain `study.barnyard.site` (see `CNAME`), DNS + TLS via Cloudflare (proxied CNAME on the `barnyard.site` zone, matching `dashboard`/`stocks`/`api`'s existing setup).

### Settings follow the signed-in user (2026-10-07)

The copied `themes.js` now also syncs the look-and-feel settings with the signed-in user's profile (Worker `GET/PUT/DELETE /prefs`), so a theme chosen in one browser loads in any other. `shell.js` shows the status in the Settings footer (a **Sign in** link when signed out, **Remove saved profile**). Nothing is sent when signed out. `themes.js`, `shell.js` and `shell.css` are hand-copied unchanged from `barnyard-hub`; do not edit them here.

### Hides what a guest cannot use (2026-10-08)

The copied `themes.js` now also reads the Worker's `/auth/session` (`BarnyardTheme.who`: signed in, hub owner or not, which apps their groups allow), and `shell.js` hides the **Study** and **Campaign** links (and their jump-search results) from a signed-in person whose groups don't include them. It is a display hint only, fails open when unknown, and every route still checks its own group. `themes.js`, `shell.js` and `shell.css` are hand-copied unchanged from `barnyard-hub`; do not edit them here.
