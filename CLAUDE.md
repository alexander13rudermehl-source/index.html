# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Тролль-Баттл" (Troll Battle) — a Telegram Mini App voice-battle game. The entire client is **one monolithic `index.html`** (~7500 lines: `<style>`, HTML, then a sequence of `<script>` blocks) with **no build step, no bundler, no package manager, no framework**. It is deployed as-is via GitHub Pages / Firebase Hosting.

The backend is **Firebase Realtime Database only** — there is no server, no Cloud Functions, no API. All game logic (matchmaking, battle state, ELO, shop, clans, events) lives in client-side JS in `index.html` that reads/writes the RTDB directly. `database.rules.json` is deliberately wide open (`.read: true, .write: true` at root, with only two narrow `.validate` rules for `users/$uid/role` and `battles/$code`) — this is an accepted, explicit tradeoff, not an oversight.

A companion repo, `battle-admin-bot`, provides a Telegram-bot-launched admin panel against the **same Firebase project** (`zolotaya-kletka`). The two repos share: the RTDB schema, the `emailLogins/<email> → telegramId` table (so one attached email works for cross-device login to both the game and the admin panel — see Identity below), and the error-reporting pipeline described below.

**This project must stay on Firebase's free (Spark) plan — no billing, ever.** This constraint has already shaped real architecture decisions (see the login-request flow below, which replaced Firebase Auth specifically to avoid its paid-tier-only email quota) and should keep shaping them; don't propose Blaze/billing as the fix for a Firebase quota or limit.

## Commands

There is no build, lint, or test suite (no `package.json` in this repo). "Testing" a change means:

1. **Syntax/structure validation** (run after every edit, since there's no compiler to catch errors) — extract every non-`src` `<script>` block and check it parses, and check `<div>`/`</div>` balance:
   ```bash
   node -e "
   const fs = require('fs');
   const html = fs.readFileSync('index.html', 'utf8');
   const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
   scripts.forEach((s,i) => { try { new Function(s); } catch(e) { console.log('Script', i, 'error:', e.message); } });
   const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
   console.log('div open/close:', (noComments.match(/<div/g)||[]).length, (noComments.match(/<\/div>/g)||[]).length);
   "
   ```
   Also worth checking for duplicate `id` attributes and `getElementById('...')` calls with no matching `id="..."` in the document. Two pre-existing false positives for duplicate ids: `clan-action-error` and the `${id}` template-literal string (not a real id).

2. **Visual verification** — this app depends on `window.firebase`/`window.Telegram`, which aren't reachable from a sandboxed test run. Use Playwright with `page.addInitScript()` to stub a fake `window.firebase` (fake `database().ref()` returning resolved/no-op promises, fake `auth()`) *before* navigation, then screenshot. Always check **both** a desktop viewport (e.g. 1440×900) and a mobile one (e.g. 390×844 — real Telegram WebView widths) since the CSS branches hard on `@media (min-width: 900px)`.

There is nothing to `npm install` here.

## Architecture

### Script block layout (in `index.html`, top to bottom)
The file is not one script — it's several sequential `<script>` blocks interleaved with the HTML for the overlay/sheet they belong to (e.g. the Community `<script>` sits right after `<div class="overlay" id="community-overlay">`). They are **not modules** — everything is one shared global scope, so a `function foo(){}` declared in an early block is callable from a later one (this is relied upon, e.g. `dockOverlayToDevice`/`closeOtherDockOverlays` are defined once and called from separate later blocks). The biggest block (after the Firebase/Telegram/LiveKit `<script src>` tags) contains identity resolution, profile rendering, the shop, and events. i18n is the very last block, right before `</body>`.

### Identity & accounts (`resolveIdentity()`)
- Opened inside Telegram → `telegramId = tgUser.id` (from `Telegram.WebApp.initDataUnsafe.user`), always present and stable.
- Opened as a plain webpage (not Telegram) → check `localStorage.battleTelegramId` (set once a login request below gets approved); if present, use it as-is.
- Neither of the above → synthetic `guest_<random>` id, kept for that browser only. Guests are a deliberate, permanent feature (used for testing) — they can later attach to a real account via Settings without losing anything.
- **No Firebase Auth anywhere in this project** — it was removed entirely (previously used for passwordless Email Link sign-in) because its free-tier daily quota on auth emails was trivial to exhaust just by testing, and the project must stay on Firebase's free plan (explicit, non-negotiable constraint — do not suggest Blaze/billing as a fix for anything). Cross-device login is now a **manual approval flow**, built entirely on the RTDB (no email ever sent, no third-party service):
  1. Settings → Account lets a real account attach an email: `emailLogins/<emailToKey(email)> = telegramId` plus `users/<telegramId>/attachedEmail`. `emailToKey` replaces `.` with `,` (RTDB forbids `.` in keys). Attaching does **not** verify ownership of the email (deliberate — see below) but does refuse to overwrite an email already claimed by a *different* `telegramId`.
  2. A guest/new browser enters that same email; the client looks up `emailLogins/<key>` to find the target `telegramId`, then pushes a request to `users/<telegramId>/loginRequests/<pushId>` (`{ device, requestedAt, status: 'pending' }`) and attaches a `.on('value')` listener on that exact node (5-minute client-side timeout, after which it deletes the still-pending request).
  3. The real account sees pending requests merged into Community's "Запросы" tab (`renderCommunityRequests` — see below) or, for the admin panel specifically, also in `battle-admin-bot`'s own Account tab. Approving sets `status: 'approved'`; the waiting browser's listener picks that up, saves `telegramId` to `localStorage`, deletes the request, and reloads.
  - The lack of email verification is intentional, not an oversight: the real security boundary is the human tap on "Разрешить", not the email. Don't re-add email verification without being asked — it would require sending mail again, which is the exact problem this design avoids.
- Player records live at `users/<telegramId-or-guest-id>`: `role` (`user`/`moderator`/`admin`/`superadmin`), `points` (ELO, see `ELO_BASELINE`/`computeEloDelta`/`LEAGUES` — **not** a plain win counter), `stats`, `status` (`active`/`restricted`/`banned`), `avatarData`, `starsBalance`, `attachedEmail`.
- New Telegram accounts are gated by `config/closedBeta` (see the beta-application screen) when set.

### Overlay/sheet UI system
Every modal (Community, Profile, Settings, Shop, Room, Battle Result, Invite, Event, Theme Lab) is a `<div class="overlay" id="...">` containing a `<div class="sheet">`, toggled via `classList.add/remove('open')` on the overlay. All overlays share the same `.sheet`/`.sheet-head`/`.sheet-body` CSS, so one rule changes all of them.

### Desktop layout (`@media (min-width: 900px)`)
Chosen breakpoint because real mobile/Telegram WebView widths never approach it — the mobile layout below it is untouched by design.
- `.desktop-sidebar` — a persistent left nav (hidden below the breakpoint) replacing the mobile action-row tiles; its Community-related items (Топ/Друзья/Запросы/Кланы) map directly to Community's internal tabs rather than duplicating a single "Community" entry.
- **`.dock-desktop` overlays** (Community/Profile/Settings/Shop only — not Room/Battle-Result/Invite/Event, which stay as real centered modals): on desktop these don't pop up as a small floating card. `dockOverlayToDevice(overlayEl)` measures `.device`'s `getBoundingClientRect()` and positions the overlay with `position: absolute` (not `fixed` — the page can scroll, and `absolute` scrolls with `.device` while `fixed` would drift) to exactly cover it, so opening one looks like the right-hand panel's content changed rather than a dialog appearing over the sidebar. `closeOtherDockOverlays(exceptEl)` is called before opening any of the four, otherwise they silently stack (same z-index, later DOM order wins) and clicking a sidebar item can appear to do nothing because the newly-opened panel is hidden behind an already-open one.

### i18n (RU/EN/DE)
Retrofit, not a rewrite: Russian strings stay hardcoded in the markup. `window.I18N_DICT.en`/`.de` are dictionaries keyed by the **literal Russian source string**. `t(ru)` looks up the current language; `window.applyTranslations(root)` walks `root`'s text nodes recursively and replaces them, caching each node's original Russian text in a `WeakMap` so re-translating (e.g. switching language twice) doesn't compound. Every place that injects new DOM into an overlay after it opens must call `window.applyTranslations?.(el)` on that new content, or it stays in Russian. Coverage is intentionally partial — clan creation/moderation, the beta-application flow, the event admin panel, and the version history are still Russian-only.

### Debug/error reporting (no direct network access from this sandbox)
`window.showDebugError(label, err)` appends to an in-memory session log and shows a small on-device debug card; the "Отправить" button pushes the whole log to `errorReports/<pushId>`. Since this repo's Claude Code sandbox has no route to Firebase, `.github/workflows/sync-error-reports.yml` (cron, every 30 min, plus `workflow_dispatch`) pulls that RTDB node via its public-read REST endpoint and commits it to `admin-logs/error-reports.json` — that file, not live Firebase, is how errors get reviewed here.

### Versioning convention
`.version-block .v-num` (near the bottom of Settings) is bumped on **every** content change with a one-line summary; the previous top entry is pushed down into `#version-history-full`. There's no such convention in `battle-admin-bot` beyond a single `#admin-version` tooltip in the topbar.

### Firebase project
`zolotaya-kletka` (config/keys are the public client-side web config, not secret — see the comment above `firebaseConfig`; the real protection boundary is `database.rules.json`, which is intentionally permissive). `firebase.json` deploys only Hosting + Database rules; `.github/workflows/firebase-database-deploy.yml` auto-deploys `database.rules.json`/`firebase.json` on push to `main`.
