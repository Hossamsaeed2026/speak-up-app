# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Speak Up: management PWA for a speech-therapy center (clients, sessions, payments, purchases, staff, branches, calendar, therapist dashboards, a parent portal). UI language is Egyptian Arabic, RTL by default (`<html lang="ar" dir="rtl">`); English is toggled at runtime via `localStorage.SU_LANG`. Code comments are also mostly in Arabic.

There is **no build system, package manager, linter or test suite**. It is a static site: open `index.html` through any static server (e.g. `python3 -m http.server`) — a server is needed for the service worker. Tailwind (`cdn.tailwindcss.com/3.4.17`) and `@supabase/supabase-js@2.78.0` (UMD) are loaded from CDNs.

## Files that matter

- `index.html` (~1.6 MB, ~2.9k lines) — the entire app: all CSS, HTML and JS inline. Some lines are hundreds of KB (line ~2612 holds the core app logic; base64 images live in others), so **never read the file whole** — use `grep -n`/`grep -o` with a narrow pattern and `cut -c` to slice lines, and make edits with exact unique strings.
- `service-worker.js` — cache-first app shell + CDN libs, background refresh of `index.html` that posts `SU_UPDATE_AVAILABLE` to the page when it changed. It refuses to cache a fetched shell lacking `suSplash` or `</html>`, so keep both in `index.html`. Supabase hosts are never cached. Bump `VERSION` when changing cached-asset behavior; the `importScripts('push-sw.js?v=N')` query string must be bumped when `push-sw.js` changes.
- `push-sw.js` — Web Push display + notification click handling.
- `supabase/functions/admin-users/index.ts` — Deno edge function (admin-only create/update/delete of auth users; verifies caller's `profiles.role === 'admin'` with the service-role key). Deploy with `supabase functions deploy admin-users`. `parent-data` (the parent portal's only data source), `push-notify` and `push-reminders` are also in `supabase/functions/`. The app also invokes a `portrait-ai` function whose source is not in this repo.
- `manifest.json`, `icons/`, `assets/` (logos, backgrounds, `assets/act/*.jpg` activity images).
- Not part of the running app: `index_مرحلة4.html` (older "phase 4" snapshot, identical to the `index.html` inside `speak-up-app-phase7.zip`), the `*.zip` phase archives, `SpeakUpDB_Setup.sql` (a SQL Server script with the original data imported from Google Sheets — the live backend is Supabase/Postgres, not this), and the brand-board PNG. Edit `index.html`, not the snapshots.

## index.html architecture

The file is a **base block plus layers of patches**. The base app (`sheetData` seed, `state`, `saveState`, `refreshAll`, all `render*` functions, the `cloud*` sync layer, login/logout) lives in one huge unnamed `<script>` (line ~2612). After it come many patch blocks, each an `<style id="...">` / `<script id="...">` pair:
- `su-*` — staff-app features and fixes (`su-calendar`, `su-clients`, `su-nav`, `su-push`, `su-notif`, `su-admin-only-guard`, `su-mdash`, `su-fix-r6`/`r7` CSS…).
- `pph*` (`pph2-css`…`pph8-js`, plus `pp-*`) — parent-portal phases.

Later blocks often override or monkey-patch functions and styles defined earlier, so search for every definition and override of a symbol before changing it, and prefer adding to the relevant existing block.

- **State**: a single global `state` object (clients, sessions, payments, purchases, staff, branches, settings, …), seeded from the inline `sheetData`. `saveState()` writes it to `localStorage["SPEAK_UP_DATABASE_MASTER_V4"]`, calls `refreshAll()` (which re-renders every view via the `render*` functions), then `cloudSchedulePush()`. Mutate `state` then call `saveState()`; don't render views piecemeal.
- **Cloud sync** (`cloud*` functions): Supabase project `dbqszalzzmxodqqhhdhi` with a publishable key in `SB_URL`/`SB_KEY`.
  - Keys listed in the `SU` map (`clients`, `sessions`, `payments`, `purchases`, `staff`, `branches`) sync row-by-row to tables `su_<key>`; `SU[k].m` maps camelCase JS fields to snake_case columns, and `suTablePush` diffs against the last synced snapshot (every record needs an id — `id`, `staff_id`, `purchase_id` or `branch_id`).
  - All other `state` keys sync as JSON blobs in the `app_state` table (`key`, value, `updated_at`), with `cloudMerge` doing three-way array merges by id.
  - `cloudSynced[k]` holds the canonical (`canon()`) last-synced string used for dirty detection.
  - Timing: `saveState()` debounces a push 8 s later (`cloudSchedulePush`); a `setInterval` also pushes every 15 s; pulls (`cloudTick` → `cloudPull`) run every 60 s, only while the tab is visible. A push first compares `app_state.updated_at` with `cloudStamp` and merges when the remote copy changed.
  - Server side (Supabase): after every write to a `su_*` table, DB triggers (`su_after_stmt` → `su_rebuild`) rebuild the full JSON mirror of `clients`/`sessions`/`payments`/`purchases`/`staff`/`branches` into the service-only table `su_blobs`. They also bump `updated_at` on the matching `app_state` row, whose `data` stays `[]` so clients can't read other people's records through it. Edge functions read the full mirrors through the service-only view `app_state_full` (it has the same shape as `app_state`); never point a client-facing read at either one. The `su_guard_app_state` trigger rejects direct client writes to those keys. The `users` blob is admin-only: the `su_guard_users_blob` trigger silently ignores writes from non-admins. An admin write to it runs `su_sync_users`, which rebuilds `su_user_clients` (parent→child links) and `profiles.limit_clients`.
  - Edge function sources live in `supabase/functions/`, migrations in `supabase/migrations/`. Keep each function's existing `verify_jwt` setting when redeploying: `parent-data` is `true`; `push-notify`, `push-reminders` and `admin-users` are `false`. `push-notify` and `push-reminders` are called by `pg_cron` with an `x-push-secret` header. RLS uses the helper functions `my_role()`, `su_role()`, `su_is_admin()`, `su_is_office()` (admin + secretary), `su_is_staff()` and `su_can_see_client()`. The DB also has legacy tables (`clients`, `payments`, `*_backup_*`…) that the app no longer uses.
- **Roles** (stored in `profiles.role`, loaded at login into `currentUser`/`window._realRole`; `applyPermissions()` and the permissions matrix gate the UI):
  - `admin` — everything, including user management (`admin-users` edge function) and MFA reset.
  - `secretary` — office work (clients, sessions, payments), no user or purchase admin.
  - `therapist` — never pulls or pushes `payments`/`purchases` (`SU_THERAPIST_DENY`) and is read-only for the `SU` tables. With `limit_clients`, they only see the clients linked to them or that they have sessions with.
  - `parent` — no staff UI. `parentStart()` loads only their children (via `su_user_clients` / the `parent-data` edge function) into the parent portal.
  - UI gating is not security: every rule has to be enforced in RLS or the edge functions as well.
- **Per-user prefs and UI flags** live in localStorage under `SU_*` keys (`SU_UPREF:*`, `SU_THEME`, `SU_LOGO`, `SU_ERRLOG`, …). Errors are routed through `suLog(...)`.
- Supabase RPCs used: `push_register`, `push_unregister`, `admin_reset_mfa`.

## Workflow notes

The GitHub repo is **public**: never commit client data, exports, DB dumps or backups. When a Supabase MCP connection is available, use it to inspect policies and functions before assuming the server enforces what the UI does.

The repo history is GitHub web uploads ("Add files via upload") of the whole `index.html`; there is no CI. Verify changes by loading the page in a browser (Playwright/Chromium is available in cloud sessions) and checking the console — a syntax error in any inline `<script>` block silently disables that whole feature.
