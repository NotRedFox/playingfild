# &gt;=PlayingFild

A Chrome MV3 productivity extension that classifies tabs, enforces a tab limit, lets you earn break time by focusing on productive work, and produces Wrapped-style recap cards. Everything runs on-device.

**Repository name reads:** "greater than or equal to PlayingField", a nod to leveling the playing field between you and the attention economy.

### Install from the Chrome Web Store

[**chromewebstore.google.com/detail/jacglcjkkcfliokenohoiekpncmbkfhm**](https://chromewebstore.google.com/detail/jacglcjkkcfliokenohoiekpncmbkfhm)

Or load unpacked from source, see [Installing (unpacked)](#installing-unpacked) below.

---

## Table of Contents

- [What it does](#what-it-does)
- [The core loop](#the-core-loop)
- [Architecture overview](#architecture-overview)
- [Classification pipeline](#classification-pipeline)
- [Tab enforcement](#tab-enforcement)
- [Work Timer + earn/spend banking](#work-timer--earnspend-banking)
- [In-page indicator (closer_indicator)](#in-page-indicator-closer_indicator)
- [Privacy stack](#privacy-stack)
- [Storage model](#storage-model)
- [Recap engine + Wrapped cards](#recap-engine--wrapped-cards)
- [YouTube embed handling](#youtube-embed-handling)
- [Auth](#auth)
- [Analytics (opt-out)](#analytics-opt-out)
- [Testing](#testing)
- [Installing (unpacked)](#installing-unpacked)
- [File layout](#file-layout)
- [Design decisions worth calling out](#design-decisions-worth-calling-out)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

- **Classifies every open tab** as productive, neutral, or unproductive in real time using a layered on-device classifier.
- **Enforces a tab limit you pick** (default 5). When you go over, the least-engaged tab closes; when the "Unproductive Tab Closer" is on, unproductive tabs are targeted preferentially.
- **Reorders your tabs by engagement** (optional). Most-used sits leftmost, least-used sits rightmost.
- **Work Timer** - every N seconds of focused productive work earns M seconds of break time. Bank the break, spend it later.
- **Advanced Earn/Spend** - declare source sites (where you earn) and target sites (where you spend), for more explicit rules.
- **Reminders** - nudges after N minutes on unproductive tabs, optional per-video timer suggestion on long YouTube videos.
- **Daily / Weekly / Monthly Wrapped** recap cards summarizing what you worked on, share-ready.
- **Multi-window aware** - each Chrome window has its own configuration.
- **Themed** - ships with a notebook skin (Caveat + PatrickHand fonts) and a default clean skin.

---

## The core loop

1. Set your tab limit and (optionally) turn on the Unproductive Tab Closer.
2. Start a Work Timer. Every 15s (default) you spend on productive tabs earns 10s of break time.
3. When you need a breather, hit "Spend" - the closer temporarily doesn't fire so you can browse Instagram, YouTube, whatever, without penalty.
4. When your break time runs out, the closer re-arms and unproductive tabs get closed again.
5. At the end of each day/week/month, a Wrapped card appears summarizing your focus - top productive hosts, biggest focus block, distractions closed, and so on.

The design bet is that _earned distraction beats blocked distraction_. Blockers create the urge to whitelist. Budgets create the urge to earn.

---

## Architecture overview

Chrome MV3 with a `type: "module"` service worker as the single source of truth for state and enforcement. Content scripts inject a floating indicator into every http/https tab. The dashboard is a chrome-extension:// HTML page. Everything runs in Chrome; no page content leaves the browser for classification.

```
                +--------------------------------------------+
                |  service worker (worker.js, ~25k lines)    |
                |                                            |
                |  - tab lifecycle (onCreated/onRemoved/     |
                |    onActivated/onMoved)                    |
                |  - enforcement chokepoint                  |
                |  - alarms + timer engine                   |
                |  - banking (earn/spend) bookkeeping        |
                |  - message router (all UI calls this)      |
                |  - all writes to chrome.storage            |
                +---+----------------------------+-----------+
                    |                            |
       chrome.tabs / |                            | chrome.storage.local
       chrome.alarms |                            | chrome.storage.session
       chrome.action |                            | (persisted state)
                    |                            |
    +---------------v-------+       +------------v-------------+
    |  content scripts       |       |  dashboard (stats.html)  |
    |  (every http/https tab)|       |                          |
    |                        |       |  - Window Settings tab   |
    |  - privacy_gate.js     |       |  - Stats & Words tab     |
    |  - sensitive_page_     |       |  - Customisations tab    |
    |    detector.js         |       |  - Profile (top-left)    |
    |  - consolidated_       |       |                          |
    |    content.js          |       |  Talks to worker only    |
    |  - closer_indicator.js |       |  via chrome.runtime.     |
    |    (Shadow DOM)        |       |  sendMessage             |
    +------------------------+       +--------------------------+
```

Every message from UI to worker goes through the `chrome.runtime.onMessage` router in `worker.js`. Every destructive tab close funnels through a single `requestEviction(tabId, reason, {analysis})` chokepoint so gating is centralized.

---

## Classification pipeline

Layered, on-device. Fast paths win first; the model only runs when everything else is uncertain.

**Layer 1 - Anchored hostname classifier** (`classifyByTitle`, `classifyYouTubeAnchor`)
Lookup-based. `github.com` is productive, `instagram.com` is unproductive, `google.com` is neutral. Extended with title-word matching for YouTube (`math lecture` = productive, `funny fails` = unproductive).

**Layer 2 - Path scores + hostname bias with Elo weighting** (`elo.js`)
`youtube.com/watch?v=lecture-on-cell-biology` reads differently than `youtube.com/shorts/xyz`. Path segments get Elo-updated per user feedback; hostnames drift toward the user's confirmed labels over time. Sync helpers normalize scores to signed [-1, 1] via `deriveProductivityScore` / `getNormalizedAnalysisScore`.

**Layer 3 - Naive Bayes over TF-IDF**
Word frequencies from the tab title + a small snippet of visible page text, scored against a bootstrap seed of pre-computed word weights (`global_seed.json`). Runs in the content script's isolated world, sends the classification back to the worker.

**Layer 4 - all-MiniLM-L6-v2 ONNX embedder** (via transformers.js)
For hard-to-classify pages where the earlier layers disagreed or returned low confidence. A ~22 MB quantized MiniLM model is bundled in `models/`. Runs entirely in-browser through `vendor/transformers.min.js` + `vendor/ort-wasm-simd-threaded.asyncify.wasm`. No page content is transmitted anywhere for classification.

**Layer 5 - User feedback**
"Yes/No productive?" cards attach labels that feed back into layers 1 and 2. `hostnameBias` and `pathScores` shift toward the user's confirmed labels; a small test suite (`tests/confirmed_label_promotion.test.mjs`) guards that a user-labeled host always wins over any classifier vote.

---

## Tab enforcement

Two independent enforcement paths, both funneled through `requestEviction`:

### Path A - Tab-count enforcement

`enforceTabLimit(windowId, options)` in `worker.js`. Fires on `tabs.onCreated`, `tabs.onActivated`, `tabs.onMoved`, `saveWindowConfig` when `tabLimit` changes, and the dashboard "Confirm" button.

**Does NOT gate on the Unproductive Tab Closer toggle.** As long as you have a tab limit set and you're signed in, exceeding it triggers eviction of the lowest-engagement tab.

Chain of exclusion (`getTabLimitEvictionExclusion`):
1. `dashboard` - the extension's own tab is never evicted.
2. `active` - the currently focused tab is never evicted.
3. `recently_opened` - tabs opened in the last 15 seconds get a grace period.
4. `shielded` - tabs the user manually protected.
5. `payment` - payment hosts (stripe, checkout pages) never evict.
6. `banking_source` / `banking_target` - Advanced Earn/Spend source/target sites never evict during an active session.

If overflow persists but the eligible pool is empty (e.g. every tab is inside the 15s grace), enforcement schedules a self-retry 16 seconds later - past the newest tab's grace expiry, so the extra tab evicts once it ages.

Sort order is lowest-engagement first: TF-IDF weighted access counts + total time on tab + rapid-pulse detection (fast repeated switching in and out) + tab index (rightmost first on ties).

### Path B - Unproductive Tab Closer

Gated on `limitsEnabled === true` in the window config, `advancedBankedTimeEnabled !== true`, and no active break session (`!isBreakSessionRunning`). Runs as a periodic tick (`ANALYZE_INTERVAL_MS`), so unproductive tabs opened while at limit get closed even if you don't manually trigger Path A.

Both paths call `requestEviction`, so `chokepoint gates` (in-flight dedup, shielded-tab check, safe-domain check, tab-protected-from-mechanical-close) apply universally.

---

## Work Timer + earn/spend banking

**Work Timer** (`timer_engine.js` + `timer_worker_integration.js`)
Wall-clock, not just tick-based - survives SW restarts, throttled tabs, and idle periods.

- Study mode ticks only on productive tabs.
- Break mode ticks on any tab.
- Ratio is user-configurable: e.g. every 15s of productive work earns 10s of break.
- Streak credit is granted on _completion_ (not start), so "click Start and abandon" doesn't count.

On study start, the worker snapshots `limitsEnabled` into `studyPreviousCloserState[windowName]` and force-enables it. On study end (natural or manual stop), it restores from that snapshot instead of hard-forcing false. This means running a Work Timer no longer silently flips your Unproductive Tab Closer off.

**Advanced Earn/Spend**
More explicit variant: declare source sites (where you _can_ earn) and target sites (where you _can_ spend). Per-source earning; per-source or pooled spending. Handled in `worker.js` via `startBankSpendMode` / `endBankSpendMode` / `refundAndEndBankSpend` (unspent time refunds cleanly).

Storage keys involved: `bankedReward` (per-window, per-source-host balance), `focusedTimeBank` (pooled), `bankSpendActive`, `bankSpendRemaining`, `bankSpendTotal`, `bankSpendStartAt`, `bankSpendSourceHost`, `bankPreviousCloserState`, `bankSpendPaused`.

---

## In-page indicator (`closer_indicator.js`)

A floating pill/ring UI mounted into every http/https tab.

**Mounting:** attaches a `<div>` to `<html>` at `z-index: 2147483647` with a Shadow DOM (`mode: 'closed'`). This isolates our CSS/HTML from the page and prevents the page's JS from reading the DOM.

**Fullscreen:** uses the HTML `popover` API + `:popover-open` - the pill rides into the fullscreen video's top layer while remaining click-through for the rest of the viewport. Solved without moving the element (previous "reparent" approach broke stacking contexts).

**Cross-world takeover:** if a second copy of the indicator is injected (e.g. iframe reloaded, tab reactivated), the first cedes gracefully. The takeover event `pf-closer-indicator-takeover` is dispatched on `document` with `event.detail.secret = chrome.runtime.id`. The page world can't read `chrome.runtime.id` (it's isolated-world only), so it can't forge the event.

**Host re-attach watchdog:** SPAs like YouTube sometimes re-render `<html>` on route change. A watchdog checks every second that the host node is still attached; if not, it re-mounts.

**Modal input projection:** the reminder popup's `<input>` elements are placed in the light DOM via `<slot>` (rather than deep inside the shadow root). Page-level keyboard listeners (Instagram's shortcut handlers, YouTube's `k` for pause) see `e.target.matches('input')` and skip their global shortcuts. Without this, typing "n" in the dismiss field would fire Instagram's new-post shortcut in the background.

---

## Privacy stack

Layered gates:

**Layer 1 - Privacy gate** (`privacy_gate.js`)
Runs before other content scripts. Short-circuits injection entirely on sensitive pages so no analysis, no telemetry, no anything runs there.

**Layer 2 - Sensitive page detector** (`sensitive_page_detector.js`)
Scored heuristic that catches login pages, payment forms, OTP grids, AI chat surfaces, banking, medical portals. Uses `queryAllDeep` for shadow-DOM traversal (React portals, etc.), autocomplete tag matching (`current-password`, `new-password`), and OTP-group detection (`≥ 4 sibling <input maxlength="1|2">` in text/tel/number modes).

Certain hostnames are hard-excluded regardless (`gmail.com`, `chase.com`, `chat.mistral.ai`, `chatgpt.com`, `claude.ai`, `character.ai`, medical domains, etc.). See `excluded_hosts.js` for the full list.

**Layer 3 - Telemetry batching** (`sync.js`)
When telemetry does go out, it goes through `pushEngagementEvent` / `pushUrlEngagementBatch` / `pushFeedbackToSupabase`. Three fingerprint mitigations applied:

- `pfBucketScore(v, 10)` - float in [0, 1] rounded to nearest 1/10 (10 discrete tiers).
- `pfRoundTimestampMs(ts, 5*60*1000)` - timestamps rounded to 5-minute buckets.
- `pfRoundDurationMs(ms, 10*1000)` - durations rounded to 10-second buckets.

**What's never recorded:** actual keystrokes, exact click positions, mouse trajectories, page content. WPM tracking counts _words_, not characters; the character stream is never captured.

Full data model: see [`PRIVACY.md`](PRIVACY.md).

---

## Storage model

**`chrome.storage.local`** (persisted, size-unlimited via `unlimitedStorage` permission)
- `windowConfigs` - per-window settings map (tabLimit, limitsEnabled, timer configs, banking configs, etc.)
- `analysis_<tabId>` - per-tab classifier verdict + probabilities
- `dailySiteLogs` - per-day, per-hostname time totals by classification
- `dailyWPMData` - per-day word counts per hostname
- `hostnameBias` + `pathScores` - classifier feedback weights
- `bankedReward`, `focusedTimeBank`, `bankSpendActive`, `bankSpendRemaining`, `bankSpendTotal`, `bankSpendStartAt`, `bankSpendSourceHost`, `bankSpendPaused`, `bankPreviousCloserState` - Advanced Earn/Spend state
- `breakPreviousCloserState`, `studyPreviousCloserState` - snapshots so timer end can restore your closer toggle
- `pfRecapDailySummaries` - daily aggregates the recap engine rolls up
- `pfRecapSeen` - user-opened flag per recap kind
- `pfDailyWrappedNotifiedForKey`, `pfDailyWrappedLastFireDay` - per-day dedup for daily wrapped notifications
- `pfSession` - Supabase access + refresh tokens
- `pfTimerSession` - wall-clock timer session (survives SW restarts)
- `pfInstalledAt`, `pfTutorialFinishedAt` - time-lock anchors

**`chrome.storage.session`** (volatile, cleared per Chrome session)
- `windowIdToName` - window ID resolution cache
- `tabUsage` - access counts + last-active times (aggregated in tabUsage Map + snapshotted here)
- `tutorialActive`, `tutorialDashboardTabId`, `tutorialDashboardWindowId` - tutorial state
- Per-tab short-lived caches

---

## Recap engine + Wrapped cards

**`recap_engine.js`** - rolls up `dailySiteLogs` + `dailyWPMData` into structured summaries:

- `buildDailyRecap(summaryMap, {now})` - today's productive/unproductive totals, top hosts, focus windows, biggest closed distractions, streak update.
- `buildWeeklyRecap(summaryMap, {now})` - last completed Mon&ndash;Sun; requires >=2 days of data. Returns null if the week is too sparse to summarize.
- `buildMonthlyRecap(summaryMap, {now})` - last completed calendar month; requires >=5 days of data.

Each recap returns:
```
{
  key: 'w:2026-W29',
  stats: [ { label: 'Top tab', value: 'github.com &middot; 4h 12m' }, ... ],
  hero: { label, value },
  bars: [ { label: 'Mon', sec: 12340 }, ... ],
  topHosts: [...],
  reorders: N, timers: N, shields: N, closes: {host: count},
  range: '13 Jul &ndash; 19 Jul',
}
```

**`recap_cards.js`** - composes shareable image cards from a recap. Three variants (`Story`, `Post`, `Spotlight`) with variant-aware backgrounds and layout, poetic subtitles pulled from template pools, grain overlays, kicker/hero/callout typography. Cards render to DOM then get rasterized to PNG on share.

**Notification tiers** - override hierarchy per user spec: monthly &gt; weekly &gt; daily. `maybeNotifyAnyWrappedReady()` fires the biggest fresh recap only. Daily is gated on install day (no daily fires on the day you install) and per-calendar-day (once per day, tracked by `pfDailyWrappedLastFireDay`).

---

## YouTube embed handling

Chrome extensions loaded from `chrome-extension://` are blocked from embedding most YouTube videos due to referrer policy. Fixed via:

- `declarativeNetRequest` rule (`youtube_embed_rules.json`) that rewrites Referer + Origin headers on subframe requests to `https://www.youtube-nocookie.com`.
- Rule limited to `resourceType: sub_frame` and to iframe origins matching `youtube.com` / `youtube-nocookie.com`.
- Matching CSP: `frame-src` / `child-src` / `connect-src` / `media-src` all allow `youtube.com`, `youtube-nocookie.com`, `googlevideo.com`, `ytimg.com`.

Per-video timer prompt (optional): when the user opens a long YouTube video (&ge; 3 min), a small in-page prompt asks "Set a timer for half / full duration?" - auto-starts a break timer scoped to that video.

---

## Auth

Supabase (`@supabase/supabase-js` v2, dynamic-imported so the SW doesn't crash if unavailable).

- Sign up / sign in / forgot-password flows in dedicated pages: `signup.html`, `forgot-password.html`.
- Password reset via OTP: 6-digit code sent to the user's email, verified locally.
- Session persisted in `chrome.storage.local` as `pfSession` with `access_token` + `refresh_token`. Session storage was tried but lost the token on every SW restart, forcing re-sign-in every ~5 minutes.
- Rate limits from Supabase auth are surfaced honestly (mailer errors, cooldowns) rather than hidden.

---

## Analytics (opt-out)

`analytics.js` exports `capture(event, props)` and `flush()`. Backed by PostHog EU (`eu.i.posthog.com`) via `mcp__` client. Funnel events only - no PII. User toggle in Profile &gt; User Settings.

Events include: `tutorial_completed`, `tab_limit_hit`, `timer_started`, `timer_completed`, `wrapped_opened`, `analytics_opt_out`. Each fires `void pfAnalyticsCapture(name, props).catch(() =&gt; {})` from the worker - never blocking, never surfaced to the user.

---

## Testing

```bash
npm install
npm run lint          # acorn syntax check on all .js/.mjs files
npm run test          # node --test tests/*.test.mjs
npm run validate      # manifest + INCLUDE consistency check
```

Test suites:

- `elo.test.mjs` - Elo update math + rating drift
- `classification.test.mjs` - classifier helpers, score normalization, hostname bias
- `privacy_telemetry.test.mjs` - bucketing + rounding + skip-conditions
- `dom_safe.test.mjs` - DOM sanitizer against injection attempts
- `closer_indicator.test.mjs` - hover/click/pointer behavior against a DOM polyfill
- `tab_limit_urls.test.mjs` + `tab_limit_eviction.test.mjs` - URL counting rules + eviction pool filtering
- `daily_site_log.test.mjs` - log rollover, size caps, midnight boundary
- `bank_earn_spend.test.mjs` + `study_break_banking.test.mjs` - banking math, refund correctness, edge cases
- `confirmed_label_promotion.test.mjs` - user feedback always wins over classifier
- `wpm_retention.test.mjs` - per-day WPM windows
- `recap_engine.test.mjs` + `recap_cards.test.mjs` - recap composition, card rendering
- `timer_hms_parsing.test.mjs` - time-string parser edge cases
- `chrome_mock.test.mjs` - sanity check the chrome.* mock harness

CI runs lint + tests on push (`.github/workflows/lint.yml`).

---

## Installing (unpacked)

Most users should just install from the [Chrome Web Store](https://chromewebstore.google.com/detail/jacglcjkkcfliokenohoiekpncmbkfhm). Load unpacked is only needed if you want to modify the code, run the tests, or ship a build to your own testers.

1. Clone this repo
2. Open `chrome://extensions`
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked** and select the repo folder
5. Pin the extension from the puzzle-piece icon in the toolbar

The extension will open its dashboard on first install to walk you through onboarding.

**Requirements:** Chrome 115+ (MV3 with modern `chrome.storage.session` and `popover` API). Firefox 115+ works via `browser_specific_settings` in the manifest.

---

## File layout

```
manifest.json                     - MV3 manifest
worker.js                          - service worker (tab lifecycle, enforcement, timers, banking)
stats.html + stats.js              - dashboard UI (Window Settings / Stats &amp; Words / Customisations)
stats-bootstrap.js                 - dashboard bootstrap (early font load, tutorial state hydration)
closer_indicator.js                - in-page floating pill/ring
consolidated_content.js            - content-script router (WPM, engagement pings, DOM cues)
privacy_gate.js                    - blocks injection on sensitive pages
sensitive_page_detector.js         - login/payment/OTP/AI-chat detector
sensitive_page_detector_page_bridge.js - shadow-DOM traversal helper
pf_sensitive_page_guard.js         - runtime guard around telemetry sends
excluded_hosts.js                  - hard-exclude host list (banking, health, AI chat, webmail)
modern_trackers.js                 - known tracker domain list

timer_engine.js                    - wall-clock timer engine (pure, no chrome.*)
timer_worker_integration.js        - worker bridge (start/stop, mode switching, snapshot)

sync.js                            - Supabase telemetry + settings sync
auth.js                            - Supabase auth wrapper
analytics.js                       - PostHog funnel events
privacy_telemetry.js               - low-level bucketing helpers
telemetry_utils.js                 - hostname normalization, URL scrubbing
tab_limit_urls.js                  - shared tab-limit URL classification

elo.js                             - Elo update math
constants.js                       - shared enums (classification labels, timer modes)
dom_safe.js                        - HTML string sanitizer
disposable_email_domains.js        - block list for signup
email_validation.js                - email format + disposable check
daily_site_log_utils.js            - per-day site log normalization

recap_engine.js                    - daily/weekly/monthly recap builder
recap_cards.js                     - shareable card composer (Story/Post/Spotlight variants)

global_seed.json + global_seed.js  - bootstrap classifier weights
signup.html + signup.js            - signup flow
signup-bootstrap.js                - early signup form UX
forgot-password.html + .js         - OTP password reset

Feedback/feedback.html + Feedback.js - uninstall feedback survey
popup.html + popup.js              - browser action popup

chest_scene.bundle.js              - Three.js chest reveal (Wrapped opening animation)
setting-demos.js                   - animated setting previews (used in tutorial)

vendor/                            - transformers.js + ONNX runtime
models/all-MiniLM-L6-v2/           - quantized embedder model
themes/                            - notebook.css, fonts.css, font-load.js
shared/brand-tokens.css            - CSS variables shared across pages
fonts/                             - Caveat, PatrickHand

youtube_embed_rules.json           - DNR rules for YouTube iframe Referer spoof
```

Directory ~60 files, ~65k lines of JS. `worker.js` is the largest at ~25k lines and warrants a future split.

---

## Design decisions worth calling out

**On-device classification, not a server API.** Every classifier hit that fires against a server costs money, adds latency, and forces you to explain what your users' browsing data does on your servers. A bundled quantized MiniLM model + a bootstrap seed means the extension works before you sign in, keeps working if the backend is down, and never has to answer "where does the URL data go" (it doesn't go anywhere).

**Earn/spend instead of block.** Blockers create the urge to whitelist. Budgets create the urge to earn.

**Tab limit as the primary interface.** Most people want fewer tabs but can't get themselves to close them. The tab limit closes them for you, ranked by how little you've used them. The classifier + Work Timer exist because the tab-limit interface creates an obvious need for them (which tab? based on what? during a break, do we still close?).

**Single codebase, two builds.** Dev has the full source (Dev Tools panel, dev keyboard shortcuts, dev console helpers). The packager strips regions marked `<!-- PF_STRIP_OPEN --> ... <!-- PF_STRIP_CLOSE -->`, specific dev-only files (`pf_dev_console.js`), and the `chrome.commands` manifest block for public builds. No two-branch merge dance.

**Dynamic import for optional modules.** The dev console is dynamically imported at first use rather than statically imported at SW load. A missing file (in public builds) doesn't crash the SW - it silently no-ops. Static imports to stripped files would crash the entire service worker at load time, killing every event handler downstream.

**Enforcement chokepoint.** Every destructive tab close funnels through `requestEviction`. Adding a new close reason means adding to the reason enum + writing the caller; the gating logic stays in one place. Same pattern applies to `setCloserLimitsForWindow` (single write path for `limitsEnabled`).

**Wall-clock timers over interval-based.** Service workers get killed. Setting `setInterval(tick, 1000)` and expecting it to fire 60 times a minute is naive. The timer engine stores `startedAt` + `limitSec` in storage and computes `remaining = (limitSec - (Date.now() - startedAt))` on every read. Idle detection + tab-focus events drive pause/resume, not tick counting.

**Fingerprint mitigations at the telemetry chokepoint, not per-caller.** `pushEngagementEvent` and its siblings apply score/timestamp/duration bucketing before the send. Individual callers don't opt in; they can't accidentally forget. The mitigations are enforced structurally.

**Compositor-only scroll parallax.** The profile anchor's scroll-parallax uses `transform: translateY(deltaY)`, not `top: ...px`. `top` invalidates layout on every scroll frame - a real perf problem on Windows dashboards with large notebook SVGs. `transform` stays on the compositor thread.

**Universal descendant scrollbar suppression during tutorial.** Windows Chrome renders scrollbars on any descendant with `overflow: auto/scroll`, regardless of the parent's overflow. Suppression targets `body.tutorial-active *`'s scrollbar pseudo-elements globally instead of playing whack-a-mole with individual containers.

---

## Contributing

Bug reports and pull requests welcome. Before proposing anything:

1. Read [`PRIVACY.md`](PRIVACY.md) if the change touches telemetry, storage, or content-script reach.
2. Read the "Design decisions worth calling out" section above - some patterns look strange but are load-bearing.
3. Run `npm run lint && npm run test` before opening a PR.
4. Keep any new user-visible strings in sentence case (not Title Case), no em-dashes, no exclamation marks in error messages.

---

## License

MIT - see [`LICENSE`](LICENSE).
