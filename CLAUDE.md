# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Speak Up: management PWA for a speech-therapy center (clients, sessions, payments, purchases, staff, branches, calendar, therapist dashboards, a parent portal). UI language is Egyptian Arabic, RTL by default (`<html lang="ar" dir="rtl">`); English is toggled at runtime via `localStorage.SU_LANG`. Code comments are also mostly in Arabic.

There is **no build system, package manager, linter or test suite**. It is a static site: open `index.html` through any static server (e.g. `python3 -m http.server`) — a server is needed for the service worker. Tailwind (`cdn.tailwindcss.com/3.4.17`) and `@supabase/supabase-js@2.78.0` (UMD) are loaded from CDNs.

## Files that matter

- `index.html` (~1.6 MB, ~2.9k lines) — the entire app: all CSS, HTML and JS inline. Some lines are hundreds of KB (line ~2612 holds the core app logic; base64 images live in others), so **never read the file whole** — use `grep -n`/`grep -o` with a narrow pattern and `cut -c` to slice lines, and make edits with exact unique strings.
- `service-worker.js` — cache-first app shell + CDN libs, background refresh of `index.html` that posts `SU_UPDATE_AVAILABLE` to the page when it changed. It refuses to cache a fetched shell lacking `suSplash` or `</html>`, so keep both in `index.html`. Supabase hosts are never cached. Bump `VERSION` when changing cached-asset behavior; the `importScripts('push-sw.js?v=N')` query string must be bumped when `push-sw.js` changes.
- `push-sw.js` — Web Push display + notification click handling.
- `supabase/functions/admin-users/index.ts` — Deno edge function (admin-only create/update/delete of auth users; verifies caller's `profiles.role === 'admin'` with the service-role key). Deploy with `supabase functions deploy admin-users`. The app also invokes `parent-data` and `portrait-ai` edge functions whose source is not in this repo.
- `manifest.json`, `icons/`, `assets/` (logos, backgrounds, `assets/act/*.jpg` activity images).
- Not part of the running app: `index_مرحلة4.html` (older "phase 4" snapshot, identical to the `index.html` inside `speak-up-app-phase7.zip`), the `*.zip` phase archives, `SpeakUpDB_Setup.sql` (a SQL Server script with the original data imported from Google Sheets — the live backend is Supabase/Postgres, not this), and the brand-board PNG. Edit `index.html`, not the snapshots.

## index.html architecture

The file grew by layering: a base app followed by many feature/patch blocks, each an `<style id="...">` / `<script id="...">` pair (e.g. `su-calendar`, `su-clients`, `su-nav`, `su-push`, `su-admin-only-guard`, `pph3-js`…`pph8-js` parent-portal phases, `su-fix-r6`/`r7` CSS fixes). Later blocks often override or monkey-patch functions/styles defined earlier, so search for every definition and override of a symbol before changing it, and prefer adding to the relevant existing block.

- **State**: a single global `state` object (clients, sessions, payments, purchases, staff, branches, settings, …), seeded from the inline `sheetData`. `saveState()` writes it to `localStorage["SPEAK_UP_DATABASE_MASTER_V4"]`, calls `refreshAll()` (which re-renders every view via the `render*` functions), then `cloudSchedulePush()`. Mutate `state` then call `saveState()`; don't render views piecemeal.
- **Cloud sync** (`cloud*` functions): Supabase project `dbqszalzzmxodqqhhdhi` with a publishable key in `SB_URL`/`SB_KEY`.
  - Keys listed in the `SU` map (`clients`, `sessions`, `payments`, `purchases`, `staff`, `branches`) sync row-by-row to tables `su_<key>`; `SU[k].m` maps camelCase JS fields to snake_case columns, and `suTablePush` diffs against the last synced snapshot (every record needs an id — `id`, `staff_id`, `purchase_id` or `branch_id`).
  - All other `state` keys sync as JSON blobs in the `app_state` table (`key`, value, `updated_at`), with `cloudMerge` doing three-way array merges by id.
  - `cloudSynced[k]` holds the canonical (`canon()`) last-synced string used for dirty detection.
- **Roles**: `admin`, `secretary`, `therapist` (staff logins in `profiles`) plus `parent` (parent portal). `window._realRole` drives `applyPermissions()` / the permissions matrix. Therapists never pull or push `payments`/`purchases` (`SU_THERAPIST_DENY`) and are read-only for the `SU` tables.
- **Per-user prefs and UI flags** live in localStorage under `SU_*` keys (`SU_UPREF:*`, `SU_THEME`, `SU_LOGO`, `SU_ERRLOG`, …). Errors are routed through `suLog(...)`.
- Supabase RPCs used: `push_register`, `push_unregister`, `admin_reset_mfa`.

## Workflow notes

The repo history is GitHub web uploads ("Add files via upload") of the whole `index.html`; there is no CI. Verify changes by loading the page in a browser (Playwright/Chromium is available in cloud sessions) and checking the console — a syntax error in any inline `<script>` block silently disables that whole feature.
