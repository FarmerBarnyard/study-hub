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

This was done by hand on 2026-08-23 (initial build) and again on 2026-10-08 (checked every row of the Knowledgebase: no status changes; the SC-300 page was edited in Notion on 2026-09-25 but already matched the notes apart from the identity-capabilities detail, now added; AZ-900 and AZ-104 pages are still empty). It produces the **pre-authored baseline** shown to any visitor with no localStorage cache of their own — the "Generate/Regenerate notes" button above is the complementary on-demand path for the account owner's own browser, and doesn't require this manual process to be repeated on a schedule. A scheduled agent-driven refresh of this baseline (step 1-2 above) is still worth doing periodically to keep the ongoing/completed split itself current — check the Claude PM Workspace's Progress Planner entry for this project for whether that's been set up.

## Shared shell and themes (2026-10-08)

This page now sits in the same shell as the dashboard: a left sidebar (Overview, Ops board, Study, Campaign, Stocks), a top bar (jump search, light/dark, Settings) and a Settings panel with 18 colour themes, 18 backgrounds, density and sidebar options. The choice follows you between the barnyard.site pages through a small `bh_prefs` cookie (look-and-feel keys only, validated on read).

- `themes.js`, `shell.js`, `shell.css` and `fonts/` are **hand-copied unchanged from barnyard-hub**, the same way `auth-gate.js` is. They are not edited here; change them in barnyard-hub and copy them out again. `test/shell.test.js` checks them (every theme readable in both modes, every background has CSS, the page stays inside its CSP).
- `style.css` is now only this page's own layout (certification rows, status dots, revision notes, the generate button).
- The Notion sync note turns red and says how old the snapshot is once it passes 14 days (`describeSync` in `app.js`, tested), because a stale list looks exactly like a current one.
- Script order matters: `shell.js` before `auth-gate.js` (it creates `#auth-status`), `themes.js` in `<head>`.

## My notes: the private notebook (`notes.html`, 2026-10-08)

A Notion-free place to take notes, written in Markdown with a live preview. Notes belong to the signed-in person and are stored by the Worker (`api.barnyard.site/notebook/*`, a Durable Object per person; see `ClaudeRepo/cloudflare-worker/README.md` "Study notebook"). Nothing is stored in this repo and nothing is public.

- `markdown.js` renders note text with DOM nodes only (no `innerHTML`): headings, lists, task lists, tables, code, quotes and callouts (`> [!NOTE]`, TIP, IMPORTANT, WARNING, CAUTION), and `[[links]]` between notes. Only http, https and mailto links are live. A web address on its own line, or a line that is only `[Title](address)`, becomes a link card (title if given, host and path; nothing is fetched). Images are the notebook's own (`![alt](img:im_xxxxxxxx)`, loaded from the Worker with the login cookie); an image pointing at another site is shown as a link, so reading a note never calls a third party.
- `notes.js` is the editor: tree with folders, pinned notes, search, tags, autosave with revision checking (a conflict never overwrites), history, trash, move, outline, backlinks, image paste/drop/upload, a `/` menu and `[[` autocomplete, download a note as `.md`, download everything, delete the whole notebook (typed confirmation).
- Everyday conveniences (2026-10-08): drag a note onto a folder to move it; the ⋯ button on a row (or right-click) has rename, move, pin, new note inside and trash; Alt+K finds a note by title (Ctrl+K too, outside the editor), Alt+N starts a new note, `/` searches inside all notes, `?` lists the shortcuts; a breadcrumb shows where a note sits; the last open note reopens; "Recently edited" appears once there are 12+ notes; to-do boxes can be ticked in the preview (the matching `- [ ]` line changes); code blocks have a Copy button; images enlarge on click; the status line shows words and reading time. Pure helpers (`toggleTask`, `textStats`, `crumbPath`, `rankFind`) are tested in `test/notes.test.js`.
- Tests: `node test/markdown.test.js` (including hostile-input cases) and `node test/notes.test.js`.
- The page CSP is `img-src 'self' https://api.barnyard.site` (images come from the Worker) and `connect-src 'self' https://api.barnyard.site`.
- A password or key in a note is refused by the Worker (`secret_detected`) and the page says so; personal details are flagged on the note rather than refused.

## Knowledgebase: shared articles built from notes (`knowledgebase.html`, 2026-10-08)

The shared side of the notebook. An article is a COPY of one or more notes that a signed-in person chose to publish; everyone who can sign in to the study site (group `study-hub-sso`) can read it. Stored by the Worker (`api.barnyard.site/kb/*`, one shared Durable Object; see `ClaudeRepo/cloudflare-worker/README.md` "Knowledgebase"). Nothing is stored in this repo. There is a "Knowledgebase" item in the shared menu on all four sites.

- `kb.js` is the page. Views by address hash: `#/` library (search that also reads article text, tag chips, sort, "my articles"), `#/a/<id>` an article, `#/new[?note=<id>]` generate and publish, `#/edit/<id>` edit your own. An article is shown with a colour treatment (eight, chosen from the title unless the author picks one), a banner, contents list with the current section highlighted, reading progress, copy buttons on code, enlargeable images, related articles and "linked from". Authors can edit, hide/show or delete their own; the owner can hide or delete any. Pure helpers are tested in `test/kb.test.js`.
- **Generate from notes** (`kb-format.js`, tested in `test/kb-format.test.js`) needs no AI: it tidies the Markdown, drops a first heading that repeats the title, starts sections at `##` (each note becomes a section when several are chosen), turns `[[links]]` to your own notes into plain text (other people cannot open them) unless they name an article already in the library, picks a summary line from the text (the first real paragraph, else a list item, else "Covers" and the section names) and gathers the tags. It shows what is in the draft before anything is shared.
- **Optional AI summary and key points** (button in the editor): the article text goes to the site's own Ollama model through the Worker (never an outside service), is capped, limited to 10 a day per person, and the answer goes into the summary box and a "Key points" callout for the author to edit. It is slow (a minute or two) and only works while the model's machine and tunnel are up; otherwise the button says so.
- **Generate KB article (AI)** (button on every note, and "Rewrite with AI, passage by passage" in the composer): the site's own model rewrites the draft into article prose one passage at a time, because it is slow and one request may run at most ~85 s. `kb-format.js` `splitForAi` cuts the draft into units of about 90 words and never sends headings, code blocks, tables, quotes, pictures, link cards or lines under 12 words; inline code, links, images and addresses are swapped for markers (`⟦1⟧`) that must come back exactly once each (`protect` / `restore`), and `acceptRewrite` drops a rewrite that adds a heading or code fence or is under 40% / over 170% of the original length, so your own words stay. The page shows "passage 3 of 12, about 9 minutes left" with a Stop button, locks the text and Publish while it runs, then asks for the summary and key points. It runs only when you press a button, 80 passages a day per person, and nothing is published until you press Publish. Needs the Worker's `OLLAMA_TUNNEL_URL` secret (see the Worker README); without it the buttons are disabled and say the model is not connected. Tests: `test/kb-format.test.js`.
- The old Study "Generate revision notes" button (paid Claude API) is switched off: `GENERATE_NOTES_ENABLED = false` in `app.js`, and the Worker route answers 410.
- Publishing needs a recent sign-in (like export). A password or key in the text is refused; personal details (email, phone, card numbers...) need the author to confirm "Publish anyway". Images are copied from the author's notebook into the article's own storage when it is saved, so only images the author put in the article become readable by others.
- `markdown.js` links `[[Title]]` to articles through the page-supplied `hrefFor`/`findNote`/`missingTitle` options.
- Notes page: a "Publish…" button on a note opens the generator with that note selected.

## Deploy

GitHub Pages, custom domain `study.barnyard.site` (see `CNAME`), DNS + TLS via Cloudflare (proxied CNAME on the `barnyard.site` zone, matching `dashboard`/`stocks`/`api`'s existing setup).

### Settings follow the signed-in user (2026-10-07)

The copied `themes.js` now also syncs the look-and-feel settings with the signed-in user's profile (Worker `GET/PUT/DELETE /prefs`), so a theme chosen in one browser loads in any other. `shell.js` shows the status in the Settings footer (a **Sign in** link when signed out, **Remove saved profile**). Nothing is sent when signed out. `themes.js`, `shell.js` and `shell.css` are hand-copied unchanged from `barnyard-hub`; do not edit them here.

### Hides what a guest cannot use (2026-10-08)

The copied `themes.js` now also reads the Worker's `/auth/session` (`BarnyardTheme.who`: signed in, hub owner or not, which apps their groups allow), and `shell.js` hides the **Study** and **Campaign** links (and their jump-search results) from a signed-in person whose groups don't include them. It is a display hint only, fails open when unknown, and every route still checks its own group. `themes.js`, `shell.js` and `shell.css` are hand-copied unchanged from `barnyard-hub`; do not edit them here.
