# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Speak Up: management PWA for a speech-therapy center (clients, sessions, payments, purchases, staff, branches, calendar, therapist dashboards, a parent portal). UI language is Egyptian Arabic, RTL by default (`<html lang="ar" dir="rtl">`); English is toggled at runtime via `localStorage.SU_LANG`. Code comments are also mostly in Arabic.

There is **no build system or package manager**. It is a static site: open `index.html` through any static server (e.g. `python3 -m http.server`) — a server is needed for the service worker. Tailwind (`cdn.tailwindcss.com/3.4.17`) and `@supabase/supabase-js@2.78.0` (UMD) are loaded from CDNs.

## Checks (`tests/`, no dependencies except Playwright for the smoke test; Node 22+)

- `node tests/static-checks.mjs`: compiles every inline `<script>` in `index.html`, checks the `suSplash`/`</html>` markers the service worker needs, flags duplicate block ids, syntax-checks `supabase/functions/*/index.ts`, and fails on data files (`.sql`/`.csv`/`.xlsx`… outside `supabase/migrations/`) or any tracked text file with more than 10 distinct Egyptian mobile numbers (the repo is public).
- `node tests/merge.test.mjs`: sync merge cases, run against `canon`/`cloudMerge*` and the notebooks patch extracted from `index.html` itself. Add a case here when you touch the merge.
- `node tests/smoke.mjs`: serves the repo, opens `index.html` in Chromium at phone and desktop widths, and fails on any page error. The CDNs and Supabase may be unreachable from a sandbox; the page should still load cleanly.
- `.github/workflows/checks.yml` runs all three on every push to `main` (including web uploads) and on pull requests.

## Files that matter

- `index.html` (~1.6 MB, ~2.9k lines) — the entire app: all CSS, HTML and JS inline. Some lines are hundreds of KB (line ~2612 holds the core app logic; base64 images live in others), so **never read the file whole** — use `grep -n`/`grep -o` with a narrow pattern and `cut -c` to slice lines, and make edits with exact unique strings.
- `service-worker.js` — cache-first app shell + CDN libs, background refresh of `index.html` that posts `SU_UPDATE_AVAILABLE` to the page when it changed. It refuses to cache a fetched shell lacking `suSplash` or `</html>`, so keep both in `index.html`. Supabase hosts are never cached. Bump `VERSION` when changing cached-asset behavior; the `importScripts('push-sw.js?v=N')` query string must be bumped when `push-sw.js` changes.
- `push-sw.js` — Web Push display + notification click handling.
- `supabase/functions/admin-users/index.ts` — Deno edge function (admin-only create/update/delete of auth users; verifies caller's `profiles.role === 'admin'` with the service-role key). Deploy with `supabase functions deploy admin-users`. `parent-data` (the parent portal's only data source), `push-notify` and `push-reminders` are also in `supabase/functions/`. The app also invokes a `portrait-ai` function whose source is not in this repo.
- `manifest.json`, `icons/`, `assets/` (logos, backgrounds, `assets/act/*.jpg` activity images).
- Not part of the running app: the brand-board PNG. (Old snapshots — `index_مرحلة4.html` and the phase `.zip` archives — were removed; they are still in git history.)

## index.html architecture

The file is a **base block plus layers of patches**. The base app (`sheetData` seed, `state`, `saveState`, `refreshAll`, all `render*` functions, the `cloud*` sync layer, login/logout) lives in one huge unnamed `<script>` (line ~2612). After it come many patch blocks, each an `<style id="...">` / `<script id="...">` pair:
- `su-*` — staff-app features and fixes (`su-calendar`, `su-clients`, `su-nav`, `su-push`, `su-notif`, `su-admin-only-guard`, `su-mdash`, `su-fix-r6`/`r7` CSS…).
- `pph*` (`pph2-css`…`pph8-js`, plus `pp-*`) — parent-portal phases.

Later blocks often override or monkey-patch functions and styles defined earlier, so search for every definition and override of a symbol before changing it, and prefer adding to the relevant existing block.

- **State**: a single global `state` object (clients, sessions, payments, purchases, staff, branches, settings, …), seeded from the inline `sheetData`. `saveState()` writes it to `localStorage["SPEAK_UP_DATABASE_MASTER_V4"]`, calls `refreshAll()` (which re-renders every view via the `render*` functions), then `cloudSchedulePush()`. Mutate `state` then call `saveState()`; don't render views piecemeal.
- **Cloud sync** (`cloud*` functions): Supabase project `dbqszalzzmxodqqhhdhi` with a publishable key in `SB_URL`/`SB_KEY`.
  - Keys listed in the `SU` map (`clients`, `sessions`, `payments`, `purchases`, `staff`, `branches`) sync row-by-row to tables `su_<key>`; `SU[k].m` maps camelCase JS fields to snake_case columns, and `suTablePush` diffs against the last synced snapshot (every record needs an id — `id`, `staff_id`, `purchase_id` or `branch_id`).
  - All other `state` keys sync as JSON blobs in the `app_state` table (`key`, `data`, `updated_at`). `cloudMerge` → `cloudMerge3` does the three-way merge: a change made on only one side is taken as-is, objects merge key by key, arrays merge by id (`cloudMergeArr`), and this device wins only when both sides changed the same field. A later patch also wraps `window.cloudMerge` for objects of id-arrays (`notebooks`).
  - `cloudSynced[k]` holds the canonical (`canon()`) last-synced string used for dirty detection.
  - Timing: `saveState()` debounces a push 8 s later (`cloudSchedulePush`); a `setInterval` also pushes every 15 s; pulls (`cloudTick` → `cloudPull`) run every 60 s, only while the tab is visible. A push first compares `app_state.updated_at` with `cloudStamp` and merges when the remote copy changed.
  - Server side (Supabase): after every write to a `su_*` table, DB triggers (`su_after_stmt` → `su_rebuild`) rebuild the full JSON mirror of `clients`/`sessions`/`payments`/`purchases`/`staff`/`branches` into the service-only table `su_blobs`. They also bump `updated_at` on the matching `app_state` row, whose `data` stays `[]` so clients can't read other people's records through it. Edge functions read the full mirrors through the service-only view `app_state_full` (it has the same shape as `app_state`); never point a client-facing read at either one. The `su_guard_app_state` trigger rejects direct client writes to those keys. The `users` blob is admin-only: the `su_guard_users_blob` trigger silently ignores writes from non-admins. An admin write to it runs `su_sync_users`, which rebuilds `su_user_clients` (parent→child links) and `profiles.limit_clients`.
  - Per-child keys (`notebooks`, `clientActivities`, `feedingResponses`, `commResponses`, `parentNotes`, `notebookTicks`, `avatars`, `evaluations`; see `su_child_keys()`) are split one row per child/item into `su_child_blobs` (RLS: `su_is_staff()` and `su_can_see_client(client_id)`; rows with no client, like staff photos, are visible to all staff). Their `app_state.data` is the placeholder `"split"`. Clients read every key through the `app_state_v` view, which rebuilds each blob from the rows the caller may see; `tests/static-checks.mjs` fails on any data read straight from `app_state`. Writes still upsert the whole blob into `app_state`: the `su_split_child_blobs` trigger splits it, only touches rows the writer can see (so a therapist with `limit_clients` can neither read nor overwrite other children), and ignores a blob of the wrong JSON type. Secretaries can neither read nor write `notebooks`, `notebookTicks` and `clientActivities` (`su_child_key_ok()`, used by the read policy and the split trigger); the UI hides the activities and notebook pages from them too (`su-sec-nochild-js`). Edge functions read `app_state_full` (unfiltered) and write whole blobs.
  - Edge function sources live in `supabase/functions/`, migrations in `supabase/migrations/`. Keep each function's existing `verify_jwt` setting when redeploying: `parent-data` is `true`; `push-notify`, `push-reminders` and `admin-users` are `false`. `push-notify` and `push-reminders` are called by `pg_cron` with an `x-push-secret` header. RLS uses the helper functions `my_role()`, `su_role()`, `su_is_admin()`, `su_is_office()` (admin + secretary), `su_is_staff()` and `su_can_see_client()`. The old pre-`su_*` tables (`clients`, `sessions`, `payments`…) and the October backup tables were dropped (`20261029_drop_legacy_tables.sql`); the remaining public tables are all in use.
- **Roles** (stored in `profiles.role`, loaded at login into `currentUser`/`window._realRole`; `applyPermissions()` and the permissions matrix gate the UI):
  - `admin` — everything, including user management (`admin-users` edge function) and MFA reset.
  - `secretary` — office work (clients, sessions, payments), no user or purchase admin.
  - `therapist` — never pulls or pushes `payments`/`purchases` (`SU_THERAPIST_DENY`) and is read-only for the `SU` tables. With `limit_clients`, they only see the clients linked to them or that they have sessions with.
  - `parent` — no staff UI. `parentStart()` loads only their children (via `su_user_clients` / the `parent-data` edge function) into the parent portal.
  - UI gating is not security: every rule has to be enforced in RLS or the edge functions as well.
  - Two-step verification (TOTP): the app's `REQUIRE` map (next to `GRACE_DAYS`) sets which roles must enroll; currently only `admin`. On the server, `my_role()`/`su_role()` return `null` for a user who has a verified factor but a session below `aal2` (`su_mfa_ok()`), so every policy and `admin-users` (which checks `su_role` through the caller's own session) require the second step once it's enabled.
- **Session statuses** (`CP_STATUS`, `cpStatusKey`): `ATT` حضر (full price), `SDE` غياب بدون عذر (half), `EXC` غياب بعذر and `TCA` إلغاء من المركز (free), `CAN` ملغية (not billed, not in attendance rates or therapist earnings; only counted), `SCHEDULED`. A rescheduled session (`su-move-js`) keeps its original row as `CAN` with `movedTo` (+ `movedPrevStatus` for undo) so month generation doesn't recreate it, and the make-up session carries `movedFrom`; fields outside `SU[k].m` sync through the `extra` jsonb column.
- **Invoices** are computed on the fly by `calculateClientInvoice` (sessions except `CAN`, prepaid at full price, previous month's `EXC`/`TCA`/half `SDE` as credit; with no sessions, an estimate from the weekly schedule only for the current/future months inside the client's start/end dates, never for `تقييم` slots). Frozen copies live in `su_invoice_archive` (`su-invarch-js`): on the first office login of each month the previous month's invoices are saved once per client (`id = 'YYYY-MM:clientId'`, insert-only; office reads, admin deletes), viewable from «🗄️ أرشيف الفواتير». The `security_invoker` view `public."فواتير_الأرشيف"` flattens the archive into Arabic-named columns for the Table Editor/SQL.
- **Per-user prefs and UI flags** live in localStorage under `SU_*` keys (`SU_UPREF:*`, `SU_THEME`, `SU_LOGO`, `SU_ERRLOG`, …). Errors are routed through `suLog(...)`.
- Supabase RPCs used: `push_register`, `push_unregister`, `admin_reset_mfa`.

## Workflow notes

The GitHub repo is **public**: never commit client data, exports, DB dumps or backups. When a Supabase MCP connection is available, use it to inspect policies and functions before assuming the server enforces what the UI does.

Most of the repo history is GitHub web uploads ("Add files via upload") of the whole `index.html`. Run the checks above before pushing, and verify changes by loading the page in a browser (Playwright/Chromium is available in cloud sessions) and checking the console — a syntax error in any inline `<script>` block silently disables that whole feature.
