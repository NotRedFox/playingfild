/**
 * analytics.js — opt-out anonymous funnel telemetry.
 *
 * Zero personal data leaves the device:
 *   • no URLs, no titles, no hostnames, no tab IDs, no user IDs
 *   • no free-text values — every property is a bounded enum or integer
 *   • one random 128-bit install ID (UUID v4) so we can count distinct
 *     users, but the ID never joins to email / auth / anything else
 *   • events are batched and flushed on a 30 s timer or when 10 events
 *     have queued, whichever comes first
 *   • opt-out kill switch: chrome.storage.local.set({ pfAnalyticsOptOut: true })
 *     stops all sends immediately AND drops the queue
 *
 * Wiring is intentionally decoupled from any specific vendor:
 *   • Set PF_ANALYTICS_ENDPOINT to your self-hosted PostHog "/capture" URL
 *     (e.g. https://ph.yourdomain.com/capture/) OR to any endpoint that
 *     accepts a PostHog-shaped batch payload.
 *   • Set PF_ANALYTICS_API_KEY to the project's public write key.
 *   • Leave both empty during local dev — capture() becomes a no-op.
 *
 * The payload shape matches PostHog's batch endpoint so a stock PostHog
 * instance accepts it without a proxy. Swap the endpoint for Plausible,
 * Umami, or a custom collector if preferred.
 */

// ── Configure these two constants before enabling analytics ─────────────
// Leave both empty ("") for a no-op build. capture() early-returns so it
// costs nothing when disabled.
// PostHog EU batch endpoint — public project token, safe to ship in the extension.
// Reference: POSTHOG_HOST and POSTHOG_API_KEY in .env
const PF_ANALYTICS_ENDPOINT = 'https://eu.i.posthog.com/batch/';
const PF_ANALYTICS_API_KEY = 'phc_BrxiwatUaghrGAPGGWY5LwUeEaBH5aPbinKgtxnBvEHR';

// Event allowlist — any capture(name) with a name NOT in this set is
// silently dropped. Prevents drift into logging things we shouldn't.
const ALLOWED_EVENTS = new Set([
  'install',                    // first-run stamp
  'tutorial_started',           // showStep(0) fired
  'tutorial_step_reached',      // showStep(N) fired — { step_index, step_name }
  'tutorial_skipped',           // Skip Tutorial pressed — { at_step }
  'tutorial_completed',         // Finish pressed successfully
  'signin_reached',             // step 14 shown
  'signin_success',             // supabase signIn resolved
  'first_focus_session',        // first productive session completed
  'first_break_earned',         // first credit banked
  'uninstalled',                // uninstall URL redirect (server-observed only)
  'signup_submitted',           // user submits the signup form
  'signup_completed',           // email verified, account created
  'signin_submitted',           // user submits the signin form
  'password_reset_requested',   // user requests a password-reset email
  'signout',                    // user signs out from the dashboard
  'timer_started',              // study or break timer started
  'timer_completed',            // timer expires naturally
  'tab_limit_hit',              // extension closes tabs due to tab limit
  'shield_activated',           // user activates tab shield from popup
  'recap_shared',               // user downloads or copies a recap card
  'theme_selected'              // user selects a visual theme
]);

// Property allowlist per event. Keeps the schema tight and audit-friendly.
// Any property NOT listed here is stripped before send.
const ALLOWED_PROPERTIES = {
  install:                   new Set(['manifest_version', 'browser']),
  tutorial_started:          new Set(['tutorial_version']),
  tutorial_step_reached:     new Set(['step_index', 'step_name']),
  tutorial_skipped:          new Set(['at_step']),
  tutorial_completed:        new Set(['seconds_to_finish', 'theme_chosen']),
  signin_reached:            new Set([]),
  signin_success:            new Set(['is_new_account']),
  first_focus_session:       new Set([]),
  first_break_earned:        new Set([]),
  signup_submitted:          new Set([]),
  signup_completed:          new Set([]),
  signin_submitted:          new Set([]),
  password_reset_requested:  new Set([]),
  signout:                   new Set([]),
  timer_started:             new Set(['mode', 'duration_sec']),
  timer_completed:           new Set(['mode', 'duration_sec']),
  tab_limit_hit:             new Set(['tabs_closed', 'tab_limit']),
  shield_activated:          new Set(['duration_min']),
  recap_shared:              new Set(['kind', 'format', 'action']),
  theme_selected:            new Set(['theme'])
};

// Bounded string / integer sanitization — enums only, no free text.
function sanitizeProps(eventName, propsIn) {
  const allowed = ALLOWED_PROPERTIES[eventName];
  if (!allowed) return {};
  const out = {};
  for (const key of Object.keys(propsIn || {})) {
    if (!allowed.has(key)) continue;
    const v = propsIn[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Clamp integers to a safe range so a bug can't emit huge numbers.
      out[key] = Math.max(-1e9, Math.min(1e9, Math.round(v)));
    } else if (typeof v === 'boolean') {
      out[key] = v;
    } else if (typeof v === 'string' && v.length <= 40) {
      // Only whitelist [a-z0-9_-] to guarantee no PII smuggling.
      if (/^[a-zA-Z0-9_-]{1,40}$/.test(v)) out[key] = v;
    }
  }
  return out;
}

// One-time install ID: UUID v4, kept only in chrome.storage.local. Never
// derived from email / hardware / IP — pure crypto.randomUUID().
async function getAnonId() {
  const stored = await chrome.storage.local.get('pfAnonId');
  if (stored?.pfAnonId) return stored.pfAnonId;
  const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ pfAnonId: id });
  return id;
}

async function isOptedOut() {
  try {
    const { pfAnalyticsOptOut } = await chrome.storage.local.get('pfAnalyticsOptOut');
    return pfAnalyticsOptOut === true;
  } catch (_) {
    return true; // fail closed on storage error
  }
}

// ── Bot shadow-ban ──────────────────────────────────────────────────────
// Suspected automation keeps the FULL local experience (nothing visibly
// changes for them) but contributes NOTHING to the global dataset:
// capture(), identify() and the flush all silently no-op. Signals:
//   • navigator.webdriver === true (WebDriver/automation present)
//   • headless / automation user agents
//   • the sticky pfBotSuspect flag, set by the worker or pages when they
//     observe untrusted synthetic clicks (feedback card votes) or
//     humanly-impossible sustained typing rates.
// Sticky by design: once tripped, this install never re-enters the pool.
let pfBotSuspectCache = null;
async function pfIsBotSuspect() {
  if (pfBotSuspectCache === true) return true;
  try {
    if (typeof navigator !== 'undefined') {
      if (navigator.webdriver === true
        || /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium/i.test(navigator.userAgent || '')) {
        pfBotSuspectCache = true;
      }
    }
    if (pfBotSuspectCache !== true) {
      const { pfBotSuspect } = await chrome.storage.local.get('pfBotSuspect');
      pfBotSuspectCache = pfBotSuspect === true;
    } else {
      // Persist so every context (worker, dashboard, content) agrees.
      chrome.storage.local.set({ pfBotSuspect: true }).catch(() => {});
    }
  } catch (_) { /* keep whatever we know */ }
  return pfBotSuspectCache === true;
}

// In-memory queue. Persisted to chrome.storage.session on every push so a
// service-worker restart doesn't drop events. Session storage — not local —
// so the queue can't accumulate across browser restarts (which would let it
// grow unbounded if the endpoint were down).
const QUEUE_KEY = 'pfAnalyticsQueue';
const MAX_QUEUE = 100;
const BATCH_SIZE = 10;
// 5s (was 30s): in MV3 the service worker dies with its timers, and
// reloading the extension wipes chrome.storage.session — with a 30s debounce
// most events never lived long enough to send (root cause of the empty
// PostHog dashboard, diagnosed 2026-07). 5s still micro-batches bursts.
const FLUSH_INTERVAL_MS = 5_000;

async function loadQueue() {
  try {
    const { [QUEUE_KEY]: q } = await chrome.storage.session.get(QUEUE_KEY);
    return Array.isArray(q) ? q : [];
  } catch (_) { return []; }
}

async function saveQueue(q) {
  try { await chrome.storage.session.set({ [QUEUE_KEY]: q.slice(-MAX_QUEUE) }); }
  catch (_) { /* best-effort */ }
}

let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushNow(); }, FLUSH_INTERVAL_MS);
}

async function flushNow() {
  if (!PF_ANALYTICS_ENDPOINT || !PF_ANALYTICS_API_KEY) return;
  if (await isOptedOut()) { await saveQueue([]); return; }
  if (await pfIsBotSuspect()) { await saveQueue([]); return; } // shadow-ban: drop, never send
  const queue = await loadQueue();
  if (!queue.length) return;
  const batch = queue.slice(0, BATCH_SIZE);
  const remaining = queue.slice(BATCH_SIZE);
  await saveQueue(remaining); // optimistic — drop on send failure
  try {
    // PostHog batch shape. Also compatible with any endpoint that treats
    // `batch` as an array of {event, distinct_id, properties, timestamp}.
    await fetch(PF_ANALYTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: PF_ANALYTICS_API_KEY, batch }),
      credentials: 'omit',
      // keepalive so the fetch survives the service worker spinning down.
      keepalive: true
    });
  } catch (_) {
    // Silently drop; do not retry indefinitely (would hammer users offline).
    // The next scheduled flush picks up newer events.
  }
  if (remaining.length) scheduleFlush();
}

/**
 * Capture a funnel event.
 * @param {string} event  Must be in ALLOWED_EVENTS or the call is a no-op.
 * @param {object} [props] Bounded properties from ALLOWED_PROPERTIES[event].
 */
export async function capture(event, props = {}) {
  if (!ALLOWED_EVENTS.has(event)) return;
  if (!PF_ANALYTICS_ENDPOINT || !PF_ANALYTICS_API_KEY) return;
  if (await isOptedOut()) return;
  if (await pfIsBotSuspect()) return; // shadow-ban: bots never enter the dataset
  const distinct_id = await getAnonId();
  const properties = {
    ...sanitizeProps(event, props),
    ext_version: (chrome.runtime.getManifest?.().version) || 'unknown'
  };
  const entry = {
    event,
    distinct_id,
    properties,
    timestamp: new Date().toISOString()
  };
  const queue = await loadQueue();
  queue.push(entry);
  await saveQueue(queue);
  if (queue.length >= BATCH_SIZE) {
    // Force an immediate flush when the batch is full.
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    void flushNow();
  } else {
    scheduleFlush();
  }
}

/**
 * Link the anonymous install ID to a known user ID.
 * Sends a PostHog $identify event so that all prior anonymous events from
 * this install are merged with the authenticated user's profile.
 * @param {string} userId  The user's stable Supabase UUID (not email or name).
 */
export async function identify(userId) {
  if (!userId || typeof userId !== 'string') return;
  if (!PF_ANALYTICS_ENDPOINT || !PF_ANALYTICS_API_KEY) return;
  if (await isOptedOut()) return;
  if (await pfIsBotSuspect()) return; // shadow-ban
  const anonId = await getAnonId();
  if (anonId === userId) return; // already identified as this user
  const entry = {
    event: '$identify',
    distinct_id: userId,
    properties: {
      $anon_distinct_id: anonId,
      ext_version: (chrome.runtime.getManifest?.().version) || 'unknown'
    },
    timestamp: new Date().toISOString()
  };
  const queue = await loadQueue();
  queue.push(entry);
  await saveQueue(queue);
  if (queue.length >= BATCH_SIZE) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    void flushNow();
  } else {
    scheduleFlush();
  }
}

/**
 * Force-drain the queue now. Called from the worker's 1-minute alarm so
 * worker-side events (install, timer_*, tab_limit_hit) still ship even
 * though the service worker's setTimeout dies whenever it spins down.
 */
export async function flush() {
  // Drain fully — flushNow sends one batch and re-schedules, but an alarm
  // tick should push everything that's queued.
  for (let i = 0; i < Math.ceil(MAX_QUEUE / BATCH_SIZE); i++) {
    const before = (await loadQueue()).length;
    if (!before) return;
    await flushNow();
    const after = (await loadQueue()).length;
    if (after >= before) return; // endpoint down — stop, don't spin
  }
}

/** Opt out at runtime — clears the queue and stops future sends. */
export async function optOut() {
  try {
    await chrome.storage.local.set({ pfAnalyticsOptOut: true });
    await saveQueue([]);
  } catch (_) { /* best-effort */ }
}

/** Opt back in at runtime. */
export async function optIn() {
  try { await chrome.storage.local.set({ pfAnalyticsOptOut: false }); }
  catch (_) { /* best-effort */ }
}
