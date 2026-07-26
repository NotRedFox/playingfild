// sync.js — user_data sync (local chrome.storage.local ↔ Supabase)

import { SUPABASE_URL, SUPABASE_ANON_KEY, pfRefreshSession, parseJwtExpiry, isPfEmailVerified } from './auth.js';
import { loadSnapshot, getSnapshotTrap } from './global_seed.js';
import { ELO_MUTE_THRESHOLD } from './elo.js';
import { getOrInitTelemetryId, computeBotConfidence } from './telemetry_utils.js';
import { sanitizeUrlForTelemetry, filterPathScoresForPrivacy } from './privacy_telemetry.js';
import {
  filterHostnameKeyedMap
} from './excluded_hosts.js';

export { ELO_MUTE_THRESHOLD };

// ── Fingerprint mitigations for Layer 2 telemetry (security review 2026-07)
// ────────────────────────────────────────────────────────────────────────
// Precision reduction reduces re-identification risk on rows sent to
// Supabase without losing signal that the classifier or bot-detection
// pipeline actually needs. Applied to every engagement / URL-engagement
// row before send.
//
//   • Engagement score: bucketed into 10 tiers (0.0, 0.1, ... 1.0).
//     The exact 7-sig-fig decimal was a quasi-identifier on its own.
//   • Bot confidence: bucketed to 20 tiers (0.05 precision).
//   • Timestamps: rounded to the nearest 5 minutes. Millisecond-precise
//     timestamps combine with hostname + path to fingerprint an
//     individual's session.
//   • Active-time / total-time: rounded to nearest 10 seconds. Fine
//     enough to differentiate "brief visit" from "long visit", too
//     coarse to reconstruct a per-second timeline.
//
// If a reviewer greps for these helpers they should find them wrapping
// every outbound telemetry row.
export function pfBucketScore(v, buckets = 10) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.max(0, Math.min(1, n));
  return Math.round(clamped * buckets) / buckets;
}

export function pfRoundTimestampMs(ts, bucketMs = 5 * 60 * 1000) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / bucketMs) * bucketMs;
}

export function pfRoundDurationMs(ms, bucketMs = 10 * 1000) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / bucketMs) * bucketMs;
}

// Advanced Settings time lock — mirrors stats.js PF_ADV_UNLOCK_MS (1 min).
// The lock anchors to pfTutorialFinishedAt (falls back to pfInstalledAt
// for accounts that finished the tutorial on an older build). Also stays
// locked if the tutorial hasn't been finished yet.
const PF_SYNC_ADV_UNLOCK_MS = 1 * 60 * 1000;

// Returns the windowConfigs map with advancedBankedTimeEnabled forced false
// on every config while the Advanced Settings lock is active. If the lock
// is NOT active, returns the input unchanged. Standalone (reads storage
// directly) so it doesn't depend on stats.js.
async function stripAdvancedEarnIfLocked(windowConfigs) {
  try {
    if (!windowConfigs || typeof windowConfigs !== 'object') return windowConfigs;
    const stored = await chrome.storage.local.get([
      'pfInstalledAt', 'pfTutorialFinishedAt', 'tutorialCompleted', 'tutorialComplete'
    ]);
    const installedAt = Number(stored.pfInstalledAt) || 0;
    if (!installedAt) return windowConfigs; // stamp not landed yet — leave as-is
    const tutorialDone = stored.tutorialCompleted === true || stored.tutorialComplete === true;
    const anchor = tutorialDone
      ? (Number(stored.pfTutorialFinishedAt) || installedAt)
      : Number.POSITIVE_INFINITY; // never-unlocks until tutorial is finished
    if (Date.now() >= anchor + PF_SYNC_ADV_UNLOCK_MS) return windowConfigs; // unlocked
    const next = {};
    for (const wn of Object.keys(windowConfigs)) {
      const cfg = windowConfigs[wn];
      if (cfg && typeof cfg === 'object' && cfg.advancedBankedTimeEnabled === true) {
        next[wn] = { ...cfg, advancedBankedTimeEnabled: false };
      } else {
        next[wn] = cfg;
      }
    }
    return next;
  } catch (_) {
    return windowConfigs;
  }
}

export async function getResolvedDataCollectionMode() {
  const stored = await chrome.storage.local.get(['dataCollectionMode']);
  const mode = stored.dataCollectionMode;
  if (mode === 'local') return 'local';
  if (mode === 'standard') return 'standard';
  return 'pending';
}

export async function isRemoteSyncAllowed() {
  return (await getResolvedDataCollectionMode()) === 'standard';
}

async function notifySyncUserFailure(operation, detail = {}) {
  const message = operation === 'pull'
    ? 'Cloud sync could not download your data. Showing your local copy.'
    : 'Cloud sync could not save your changes. They are kept on this device.';
  await chrome.storage.local.set({
    pfSyncUserNotice: {
      message,
      operation,
      ...detail,
      at: Date.now()
    }
  });
}

export async function shouldBlackholeContributorPush() {
  try {
    const { userElo } = await chrome.storage.local.get('userElo');
    return Number(userElo ?? 5) <= ELO_MUTE_THRESHOLD;
  } catch (_) {
    return false;
  }
}

export function computePersonalNameTokens(pfSession) {
  if (!pfSession?.user) return new Set();
  const blocked = new Set();
  const email = pfSession.user.email || '';
  const localPart = email.split('@')[0].toLowerCase();
  if (localPart) blocked.add(localPart);
  localPart.split(/[^a-z0-9]+/).filter((s) => s.length > 1).forEach((s) => blocked.add(s));

  const displayName = pfSession.user.user_metadata?.display_name
    || pfSession.user.user_metadata?.username
    || '';
  displayName.toLowerCase().split(/[^a-z0-9]+/).filter((s) => s.length > 1)
    .forEach((s) => blocked.add(s));

  return blocked;
}

async function filterPersonalNameTokensFromTelemetry(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!list.length) return [];
  const stored = await chrome.storage.local.get('pfSession');
  const blocked = computePersonalNameTokens(stored.pfSession);
  if (!blocked.size) return list;
  return list.filter((token) => !blocked.has(String(token).toLowerCase()));
}

export const PII_PATTERNS = [
  // Email
  /\S+@\S+\.\S+/,
  // US-style 7-10 digit phone (e.g. 555-123-4567, 555.123.4567, 555 123 4567)
  /\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/,
  // Credit card style (4-4-4-4)
  /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/,
  // US Social Security style
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Passport style
  /\b[A-Z]{2}\d{6}[A-Z]\b/,
  // Long alphanumeric ID
  /\b[A-Z0-9]{20,}\b/,
  // International phone with + (e.g. +1 555 555 5555, +44 20 1234 5678,
  // +61-4-1234-5678) — 2-4 groups of digits after the country code, total
  // 7+ digits including the country code so we don't catch short codes.
  /\+\d{1,3}[\s.()-]*\d{1,4}[\s.()-]*\d{1,4}[\s.()-]*\d{2,4}(?:[\s.()-]*\d{2,4})?/,
  // US-style with area code in parens (e.g. (555) 123-4567 or (555)123-4567)
  /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/,
  // Pure 10–15 digit run (typical for phone numbers stored without separators);
  // long enough that years/years-in-id are unlikely to trip it.
  /\b\d{10,15}\b/
];

/** Standalone digit runs — 5+ digits (avoids stripping years like 2026). */
const LONG_DIGIT_RUN = /\b\d{5,}\b/;

/**
 * Returns true when a keyword token should not leave the device.
 * Applied before user_keywords / feedback token push.
 */
export function isLikelyIdentifyingKeyword(token) {
  if (typeof token !== 'string') return true;
  const t = String(token).trim().toLowerCase();
  if (t.length < 3 || t.length > 40) return true;

  if (PII_PATTERNS.some((pattern) => pattern.test(t))) return true;
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(t)) return true;
  if (LONG_DIGIT_RUN.test(t)) return true;
  if (/^[a-f0-9]{8,}$/.test(t)) return true;
  if (/^[a-z0-9]{8,}-[a-z0-9-]{4,}/.test(t)) return true;
  if (/^[a-z]{2,}\d{3,}$/.test(t) || /^\d{3,}[a-z]{2,}$/.test(t)) return true;
  if ((t.match(/_/g) || []).length >= 2) return true;
  if (/^[a-z]+[0-9]{2,}[a-z0-9]*$/.test(t) && t.length <= 16) return true;

  return false;
}

export function stripPiiFromTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  const before = tokens.length;
  const stripped = tokens.filter((token) => !isLikelyIdentifyingKeyword(token));
  if (before !== stripped.length) {
    console.info('[pf-privacy-strip] removed PII patterns', {
      before,
      after: stripped.length
    });
  }
  return stripped;
}

export function sanitizeTokensForPush(tokens) {
  return stripPiiFromTokens(tokens);
}

/** Same token pipeline as pushFeedbackEvent — PII patterns, then session personal names. */
async function filterTokenKeysForTelemetryPush(tokens) {
  const sanitized = sanitizeTokensForPush(tokens);
  return filterPersonalNameTokensFromTelemetry(sanitized);
}

async function buildAllowedTokenSet(tokens) {
  const filtered = await filterTokenKeysForTelemetryPush(tokens);
  return new Set(filtered.map((t) => String(t).toLowerCase()));
}

function pairKeyTokens(pairKey) {
  const k = String(pairKey || '');
  if (k.startsWith('@') && k.includes('|')) {
    const rest = k.slice(1);
    const idx = rest.indexOf('|');
    const keyword = rest.slice(idx + 1);
    return keyword ? [keyword] : [];
  }
  return k.split('|').filter(Boolean);
}

function bayesEntryForPush(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { P = 0, N = 0, U = 0, total = 0 } = entry;
  return { P, N, U, total };
}

async function filterUserKeywordsForPush(userKeywords) {
  const map = userKeywords && typeof userKeywords === 'object' ? userKeywords : {};
  const keys = Object.keys(map);
  if (!keys.length) return { filtered: {}, removed: 0 };
  const allowed = await buildAllowedTokenSet(keys);
  const filtered = {};
  let removed = 0;
  for (const [key, val] of Object.entries(map)) {
    const keyLower = String(key).toLowerCase();
    const total = Number(val?.total) || 0;
    if (!allowed.has(keyLower)) {
      removed++;
      continue;
    }
    if (total <= 1) {
      removed++;
      continue;
    }
    filtered[key] = bayesEntryForPush(val);
  }
  return { filtered, removed };
}

async function filterUserKeywordPairsForPush(userKeywordPairs) {
  const map = userKeywordPairs && typeof userKeywordPairs === 'object' ? userKeywordPairs : {};
  const keys = Object.keys(map);
  if (!keys.length) return { filtered: {}, removed: 0 };
  const allTokens = new Set();
  for (const key of keys) {
    for (const token of pairKeyTokens(key)) {
      allTokens.add(token);
    }
  }
  const allowed = await buildAllowedTokenSet([...allTokens]);
  const filtered = {};
  let removed = 0;
  for (const [key, val] of Object.entries(map)) {
    const tokens = pairKeyTokens(key);
    if (tokens.length && tokens.every((t) => allowed.has(String(t).toLowerCase()))) {
      const total = Number(val?.total) || 0;
      if (total <= 1) {
        removed++;
        continue;
      }
      filtered[key] = bayesEntryForPush(val);
    } else {
      removed++;
    }
  }
  return { filtered, removed };
}

const PUSH_DEBOUNCE_MS = 5000;

/** Immutable schema tag for user_data sync payloads — bump when shape changes. */
export const USER_DATA_SCHEMA_VERSION = '1.2.6';

const LOCAL_SYNC_KEYS = [
  'windowConfigs',
  'hostnameBias',
  'pathScores',
  'userKeywords',
  'userKeywordPairs',
  'classCounts',
  'userElo'
];

/**
 * Layer 1 prefs only — allowlisted window_config fields safe for user_data sync.
 * Timer durations, banking sites, startup URLs, and personal limits stay local.
 */
const SYNCABLE_WINDOW_CONFIG_FIELDS = new Set([
  'name',
  'tabLimit',
  'limitsEnabled',
  'rankingMode',
  'resetSession',
  'pauseActive',
  'tabLifeEnabled',
  'bankedTimeEnabled',
  'advancedBankedTimeEnabled',
  'studyTimerEnabled',
  'studyBreakEnabled',
  'studyBreakAutoStart',
  'wipeTabTimesEnabled',
  'wipeTabTimesInterval',
  'wipeTabTimesAt',
  'wipeTabTimesLastAt',
  'autoCloseDashboard',
  'autoShieldPopouts',
  'autoCloseAutoTabs',
  'specificLimits'
]);

/** Copy only allowlisted keys from one window config entry (sync push/pull). */
export function filterWindowConfigEntryForSync(config) {
  if (!config || typeof config !== 'object') return {};
  const filtered = {};
  for (const key of SYNCABLE_WINDOW_CONFIG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      filtered[key] = config[key];
    }
  }
  return filtered;
}

/** Allowlist filter for all windows — local chrome.storage.windowConfigs is never modified by this. */
export function filterWindowConfigsForSync(windowConfigs) {
  if (!windowConfigs || typeof windowConfigs !== 'object') return {};
  const filtered = {};
  for (const [windowName, config] of Object.entries(windowConfigs)) {
    filtered[windowName] = filterWindowConfigEntryForSync(config);
  }
  return filtered;
}

function countStrippedWindowConfigFields(windowConfigs) {
  if (!windowConfigs || typeof windowConfigs !== 'object') return 0;
  let removed = 0;
  for (const config of Object.values(windowConfigs)) {
    if (!config || typeof config !== 'object') continue;
    for (const key of Object.keys(config)) {
      if (!SYNCABLE_WINDOW_CONFIG_FIELDS.has(key)) removed++;
    }
  }
  return removed;
}

const SKIP_ENGAGEMENT_HOSTNAMES = [
  // AI chat services
  'claude.ai', 'chatgpt.com', 'chat.openai.com',
  'gemini.google.com', 'copilot.microsoft.com',
  'poe.com', 'character.ai', 'perplexity.ai',

  // Authentication
  'accounts.google.com', 'login.microsoftonline.com',
  'login.yahoo.com', 'appleid.apple.com',
  'auth0.com', 'okta.com',

  // Payment gateways
  'stripe.com', 'checkout.stripe.com',
  'paypal.com', 'paypal.me',
  'square.com', 'squareup.com',
  'braintreepayments.com',
  'adyen.com', 'klarna.com', 'afterpay.com',

  // Major US banks
  'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'citi.com', 'citibank.com', 'usbank.com',
  'capitalone.com', 'pnc.com', 'tdbank.com',
  'discover.com', 'americanexpress.com',

  // International major banks
  'hsbc.com', 'barclays.co.uk', 'lloydsbank.com',
  'natwest.com', 'santander.com', 'rbc.com',
  'commbank.com.au', 'westpac.com.au', 'anz.com.au', 'nab.com.au',

  // Webmail providers
  'mail.google.com', 'outlook.live.com', 'outlook.office.com',
  'mail.yahoo.com', 'mail.proton.me', 'protonmail.com',
  'mail.aol.com', 'fastmail.com',

  // Health
  'mychart.com', 'patientportal.com',

  // Crypto
  'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com'
];

const SKIP_PATH_PATTERNS = [
  /\/login(\/|$|\?)/i,
  /\/signin(\/|$|\?)/i,
  /\/sign-in(\/|$|\?)/i,
  /\/signup(\/|$|\?)/i,
  /\/register(\/|$|\?)/i,
  /\/checkout(\/|$|\?)/i,
  /\/cart(\/|$|\?)/i,
  /\/payment(\/|$|\?)/i,
  /\/billing(\/|$|\?)/i,
  /\/account\/(security|password|payment|billing)/i,
  /\/oauth\/(authorize|callback)/i,
  /\/auth\//i,
  /\/password(\/|$|\?)/i,
  /\/reset-password/i,
  /\/forgot-password/i,
  /\/2fa(\/|$|\?)/i,
  /\/verify(\/|$|\?)/i,
  /\/sessions\/social\//i,
  /\/sessions\/two-factor/i,
  /\/sso\//i,
  /\/saml\//i,
  /\/o\/oauth2\//i,
  /\/connect\/oauth/i,
  /\/authorize\b/i
];

export function isSensitivePath(url) {
  try {
    const u = new URL(url);
    return SKIP_PATH_PATTERNS.some((rx) => rx.test(u.pathname));
  } catch {
    return false;
  }
}

export function isSensitiveHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  return SKIP_ENGAGEMENT_HOSTNAMES.some((host) => h === host || h.endsWith('.' + host));
}

export function shouldSkipSensitiveUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (isSensitiveHostname(u.hostname)) return true;
    return isSensitivePath(url);
  } catch {
    return false;
  }
}

const KNOWN_AI_TOOL_HOSTS = [
  'claude.ai',
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'gemini.google.com',
  'copilot.microsoft.com',
  'poe.com',
  'character.ai',
  'perplexity.ai',
  'you.com',
  'meta.ai',
  'pi.ai',
  'huggingface.co',
  'writesonic.com',
  'jasper.ai',
  'midjourney.com',
  'notion.so',
  'deepseek.com',
  'mistral.ai',
  'cohere.com'
];

const AI_TITLE_PATTERNS = [
  /\bchatgpt\b/i,
  /\bclaude\b/i,
  /\bgemini\b/i,
  /\bcopilot\b/i,
  /\bperplexity\b/i,
  /\bcharacter\.ai\b/i,
  /\bpoe\b/i,
  /\bai chat\b/i,
  /\bchat with\b/i,
  /\blarge language model\b/i,
  /\bllm\b/i,
  /\bgpt-?\d/i
];

export function isKnownAiToolHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  return KNOWN_AI_TOOL_HOSTS.some((host) => h === host || h.endsWith('.' + host));
}

function isAiHostHeuristic(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  const parts = h.split('.');
  if (parts.length < 2) return false;
  const label = parts[0];
  if (/^(chat|ai|assistant|gpt|copilot|genai|llm|bot)$/i.test(label)) return true;
  if (/^(chat|ai)[-_.]/i.test(label)) return true;
  return false;
}

function isAiTitleHeuristic(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  return AI_TITLE_PATTERNS.some((rx) => rx.test(t));
}

/** Returns { ai: boolean, reason: string|null } for feedback-card gating. */
export function isAiToolPage(url, title = '') {
  if (!url) return { ai: false, reason: null };
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    if (isKnownAiToolHost(hostname)) {
      console.info('[pf-ai-detect] known AI host', { hostname, url });
      return { ai: true, reason: 'known-host' };
    }
    if (isAiHostHeuristic(hostname)) {
      return { ai: true, reason: 'host-heuristic' };
    }
    if (isAiTitleHeuristic(title)) {
      return { ai: true, reason: 'title-heuristic' };
    }
  } catch {
    return { ai: false, reason: null };
  }
  return { ai: false, reason: null };
}

let pushDebounceTimer = null;
let pushInFlight = false;
let pendingPushAfterComplete = false;
let pullInProgress = false;
let deferredSchedulePush = false;

function emptyClassCounts() {
  return { P: 0, N: 0, U: 0, total: 0 };
}

async function getAuthContext() {
  try {
    const stored = await chrome.storage.local.get(['pfSession', 'telemetryId']);
    let session = stored.pfSession;
    if (!session?.access_token || !session?.user?.id) {
      return null;
    }
    if (!session.user.email_confirmed_at) {
      return null;
    }
    const expMs = parseJwtExpiry(session.access_token);
    if (expMs != null && expMs <= Date.now()) {
      const refreshed = await pfRefreshSession();
      if (!refreshed?.access_token || !refreshed?.user?.id) {
        return null;
      }
      session = refreshed;
    }
    return {
      access_token: session.access_token,
      userId: session.user.id,
      telemetryId: stored.telemetryId || null
    };
  } catch (_) {
    return null;
  }
}

async function authedFetch(url, options = {}) {
  const auth = await getAuthContext();
  if (!auth) {
    return new Response(null, { status: 401, statusText: 'Unauthorized' });
  }

  const withAuth = (accessToken) => fetch(url, {
    ...options,
    headers: {
      ...authHeaders(accessToken),
      ...(options.headers || {})
    }
  });

  let response = await withAuth(auth.access_token);
  if (response.status !== 401) {
    return response;
  }

  const refreshed = await pfRefreshSession();
  if (!refreshed?.access_token) {
    return response;
  }

  return withAuth(refreshed.access_token);
}

function authHeaders(accessToken) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
}

/**
 * user_data pull merge strategies (syncPullOnSignin → syncPushNow round-trip).
 * NEVER use local + cloud for snapshot totals — that doubled classCounts every cycle.
 *
 * | Field              | Merge                         | Safe? |
 * |--------------------|-------------------------------|-------|
 * | userKeywords       | mergeBayesMaps: higher total  | yes   |
 * | userKeywordPairs   | mergeBayesMaps: higher total  | yes   |
 * | hostnameBias       | mergeTimestampEntryMaps: LWW  | yes   |
 * | pathScores         | mergeTimestampEntryMaps: LWW  | yes   |
 * | windowConfigs      | cloud-newer overlay per win   | yes   |
 * | classCounts        | max per P/N/U/total           | yes   |
 * | userElo            | average or cloud if fresh     | yes   |
 * | feedbackEventCount | max (monotonic counter)       | yes   |
 *
 * Not in user_data pull: urlScores (syncFromSupabase, higher feedback_count wins),
 * user_confirmed_labels, feedbackHistory (local-only).
 *
 * Local += training (trainBayesFromFeedback, applyHostnameBiasTraining) is intentional;
 * pull reconcile picks winner/max/LWW — not a second increment.
 */
function mergeBayesEntry(local, cloud) {
  if (!local && !cloud) return null;
  if (!local) return { ...cloud };
  if (!cloud) return { ...local };
  const localTotal = Number(local.total) || 0;
  const cloudTotal = Number(cloud.total) || 0;
  const winner = localTotal >= cloudTotal ? { ...local } : { ...cloud };
  winner.lastSeen = Math.max(Number(local.lastSeen) || 0, Number(cloud.lastSeen) || 0);
  return winner;
}

function mergeBayesMaps(localMap, cloudMap) {
  const local = localMap || {};
  const cloud = cloudMap || {};
  const merged = { ...local };
  let overlapCount = 0;
  for (const key of new Set([...Object.keys(local), ...Object.keys(cloud)])) {
    const l = local[key];
    const c = cloud[key];
    if (l && c) overlapCount += 1;
    const entry = mergeBayesEntry(l, c);
    if (entry) merged[key] = entry;
  }
  return { merged, overlapCount };
}

function mergeTimestampEntryMaps(localMap, cloudMap) {
  const local = localMap || {};
  const cloud = cloudMap || {};
  const merged = { ...local };
  let overlapCount = 0;
  for (const key of new Set([...Object.keys(local), ...Object.keys(cloud)])) {
    const l = local[key];
    const c = cloud[key];
    if (l && c) {
      overlapCount += 1;
      const lTime = Number(l.lastUpdated) || 0;
      const cTime = Number(c.lastUpdated) || 0;
      merged[key] = lTime >= cTime ? { ...l } : { ...c };
    } else if (c) {
      merged[key] = { ...c };
    }
  }
  return { merged, overlapCount };
}

/** Per-device totals — must not sum on pull (that doubled counts every sync cycle). */
function mergeClassCounts(local, cloud) {
  const l = local || emptyClassCounts();
  const c = cloud || emptyClassCounts();
  const P = Math.max(Number(l.P) || 0, Number(c.P) || 0);
  const N = Math.max(Number(l.N) || 0, Number(c.N) || 0);
  const U = Math.max(Number(l.U) || 0, Number(c.U) || 0);
  const total = Math.max(Number(l.total) || 0, Number(c.total) || 0, P + N + U);
  return { P, N, U, total };
}

/** Monotonic counter — max, never sum (same failure mode as classCounts). */
function mergeFeedbackEventCount(local, cloud) {
  return Math.max(Number(local) || 0, Number(cloud) || 0);
}

function isFreshLocalElo(localElo, meta = {}) {
  if (meta.lastSyncAt) return false;
  if (meta.lastEloUpdate) return false;
  const elo = Number(localElo);
  return !Number.isFinite(elo) || elo === 5;
}

function mergeUserElo(local, cloud, meta = {}) {
  const l = Number(local);
  const c = Number(cloud);
  if (!Number.isFinite(l) && !Number.isFinite(c)) return 5;
  if (!Number.isFinite(l)) return c;
  if (!Number.isFinite(c)) return l;
  if (isFreshLocalElo(local, meta)) return c;
  return (l + c) / 2;
}

function mergeWindowConfigs(localConfigs, cloudConfigs, localUpdatedAt, cloudUpdatedAt) {
  const local = localConfigs || {};
  const localTs = Number(localUpdatedAt) || 0;
  const cloudTs = cloudUpdatedAt ? new Date(cloudUpdatedAt).getTime() : 0;
  if (cloudTs > localTs) {
    const merged = { ...local };
    const cloudSafe = filterWindowConfigsForSync(cloudConfigs || {});
    for (const [windowName, safeEntry] of Object.entries(cloudSafe)) {
      merged[windowName] = {
        ...(local[windowName] || {}),
        ...safeEntry
      };
    }
    return {
      windowConfigs: merged,
      windowConfigsUpdatedAt: cloudTs || Date.now()
    };
  }
  return {
    windowConfigs: local,
    windowConfigsUpdatedAt: localTs || Date.now()
  };
}

async function handleAuthFailure(status) {
  if (status === 401) {
    console.info('[pf-sync] auth expired, bail');
    if (typeof globalThis.pfRefreshSession !== 'function') {
      console.warn('[pf-sync] pfRefreshSession unavailable — sign in again to sync');
    }
  }
}

function finishDeferredSchedulePush() {
  if (deferredSchedulePush) {
    deferredSchedulePush = false;
    schedulePush();
  }
}

export function cancelPendingSync(reason = 'mode_change') {
  if (pushDebounceTimer != null) {
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = null;
    console.info('[pf-sync] pending push CANCELLED —', reason);
  }
  deferredSchedulePush = false;
}

export function schedulePush() {
  if (pullInProgress) {
    deferredSchedulePush = true;
    return;
  }
  if (pushDebounceTimer != null) {
    clearTimeout(pushDebounceTimer);
  }
  console.info(`[pf-sync] push scheduled (${PUSH_DEBOUNCE_MS} ms debounce)`);
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null;
    void isRemoteSyncAllowed().then((allowed) => {
      if (!allowed) {
        console.info('[pf-sync] push skipped — remote sync not allowed yet');
        return;
      }
      syncPushNow().catch(() => {});
    });
  }, PUSH_DEBOUNCE_MS);
}

export async function syncPushNow(options = {}) {
  const { fromPullComplete = false } = options;
  if (pullInProgress && !fromPullComplete) {
    deferredSchedulePush = true;
    return;
  }
  if (pushInFlight) {
    pendingPushAfterComplete = true;
    return;
  }

  const auth = await getAuthContext();
  if (!auth) {
    console.info('[pf-sync] not authenticated, push/pull skipped');
    return;
  }

  if (!(await isRemoteSyncAllowed())) {
    console.info('[pf-sync] push skipped — remote sync not allowed (local or pending data-mode choice)');
    return;
  }

  pushInFlight = true;
  const started = Date.now();
  console.info('[pf-sync] push starting');

  try {
    const local = await chrome.storage.local.get([
      ...LOCAL_SYNC_KEYS,
      'feedbackEventCount',
      'lastEloUpdate'
    ]);
    const biasFiltered = filterHostnameKeyedMap(local.hostnameBias || {});
    const pathFiltered = filterPathScoresForPrivacy(local.pathScores || {});
    const kwFiltered = await filterUserKeywordsForPush(local.userKeywords || {});
    const pairFiltered = await filterUserKeywordPairsForPush(local.userKeywordPairs || {});
    if (biasFiltered.removed > 0 || pathFiltered.removed > 0) {
      console.info('[pf-sync] stripped excluded/blocked paths from user_data push', {
        hostnameBias: biasFiltered.removed,
        pathScores: pathFiltered.removed
      });
    }
    if (kwFiltered.removed > 0 || pairFiltered.removed > 0) {
      console.info('[pf-sync] stripped PII/personal tokens from user_data keyword push', {
        userKeywords: kwFiltered.removed,
        userKeywordPairs: pairFiltered.removed
      });
    }
    const windowConfigsForSync = filterWindowConfigsForSync(local.windowConfigs || {});
    const strippedWindowFields = countStrippedWindowConfigFields(local.windowConfigs || {});
    if (strippedWindowFields > 0) {
      console.info('[pf-sync] stripped Layer-1 window_config fields from user_data push', {
        strippedFieldCount: strippedWindowFields,
        windowCount: Object.keys(local.windowConfigs || {}).length
      });
    }
    const nowIso = new Date().toISOString();
    const body = {
      user_id: auth.userId,
      schema_version: USER_DATA_SCHEMA_VERSION,
      window_configs: windowConfigsForSync,
      hostname_bias: biasFiltered.filtered,
      path_scores: pathFiltered.filtered,
      user_keywords: kwFiltered.filtered,
      user_keyword_pairs: pairFiltered.filtered,
      class_counts: local.classCounts || emptyClassCounts(),
      user_elo: Number(local.userElo ?? 5),
      updated_at: nowIso,
      last_sync_at: nowIso,
      last_elo_update: local.lastEloUpdate
        ? new Date(local.lastEloUpdate).toISOString()
        : null,
      feedback_event_count: Number(local.feedbackEventCount) || 0
    };

    const response = await authedFetch(`${SUPABASE_URL}/rest/v1/user_data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(body)
    });

    if (response.status === 401) {
      await handleAuthFailure(401);
      return;
    }

    if (!response.ok) {
      const brief = (await response.text()).slice(0, 200);
      console.info('[pf-sync] push failed:', response.status, brief);
      await notifySyncUserFailure('push', { status: response.status, brief });
      return;
    }

    const lastSyncAt = Date.now();
    await chrome.storage.local.set({ lastSyncAt });
    console.info('[pf-sync] push success', `(${Date.now() - started} ms)`);
  } catch (e) {
    console.info('[pf-sync] push failed:', 0, String(e?.message || e).slice(0, 200));
    await notifySyncUserFailure('push', { error: String(e?.message || e) });
  } finally {
    pushInFlight = false;
    if (pendingPushAfterComplete) {
      pendingPushAfterComplete = false;
      syncPushNow().catch(() => {});
    }
  }
}

export async function syncPullOnSignin() {
  if (pullInProgress) return { skipped: true, reason: 'in_progress' };

  const stored = await chrome.storage.local.get('pfSession');
  const session = stored.pfSession;
  if (!session?.access_token || !session?.user?.id) {
    console.info('[pf-sync] not authenticated, push/pull skipped');
    return { skipped: true, reason: 'not_authenticated' };
  }
  if (!isPfEmailVerified(session)) {
    console.info('[pf-sync] pull skipped — verify your email to sync');
    return { skipped: true, reason: 'email_unverified' };
  }

  const auth = await getAuthContext();
  if (!auth) {
    console.info('[pf-sync] not authenticated, push/pull skipped');
    return { skipped: true, reason: 'not_authenticated' };
  }

  if (!(await isRemoteSyncAllowed())) {
    console.info('[pf-sync] pull skipped — remote sync not allowed (local or pending data-mode choice)');
    return { skipped: true, reason: 'sync_not_allowed' };
  }

  pullInProgress = true;
  deferredSchedulePush = false;
  if (pushDebounceTimer != null) {
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = null;
  }

  console.info('[pf-sync] pull starting');

  try {
    const url = `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${encodeURIComponent(auth.userId)}&select=*`;
    const response = await authedFetch(url, {
      method: 'GET'
    });

    if (response.status === 401) {
      await handleAuthFailure(401);
      return { skipped: true, reason: 'auth_failed' };
    }

    if (!response.ok) {
      const brief = (await response.text()).slice(0, 200);
      console.info('[pf-sync] pull failed:', response.status, brief);
      await notifySyncUserFailure('pull', { status: response.status, brief });
      return { skipped: true, reason: 'pull_failed', status: response.status };
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      console.info('[pf-sync] pull found no remote row, will create on next push');
      return { success: true, empty: true };
    }

    const row = rows[0];
    const local = await chrome.storage.local.get([
      ...LOCAL_SYNC_KEYS,
      'windowConfigsUpdatedAt',
      'lastSyncAt',
      'lastEloUpdate',
      'feedbackEventCount'
    ]);

    const kwMerge = mergeBayesMaps(local.userKeywords, row.user_keywords);
    const pairMerge = mergeBayesMaps(local.userKeywordPairs, row.user_keyword_pairs);
    const hostMerge = mergeTimestampEntryMaps(local.hostnameBias, row.hostname_bias);
    const pathMerge = mergeTimestampEntryMaps(local.pathScores, row.path_scores);
    const winMerge = mergeWindowConfigs(
      local.windowConfigs,
      row.window_configs,
      local.windowConfigsUpdatedAt,
      row.updated_at
    );

    const merged = {
      windowConfigs: winMerge.windowConfigs,
      windowConfigsUpdatedAt: winMerge.windowConfigsUpdatedAt,
      hostnameBias: hostMerge.merged,
      pathScores: pathMerge.merged,
      userKeywords: kwMerge.merged,
      userKeywordPairs: pairMerge.merged,
      classCounts: mergeClassCounts(local.classCounts, row.class_counts),
      userElo: mergeUserElo(local.userElo, row.user_elo, {
        lastSyncAt: local.lastSyncAt,
        lastEloUpdate: local.lastEloUpdate
      }),
      feedbackEventCount: mergeFeedbackEventCount(
        local.feedbackEventCount,
        row.feedback_event_count
      ),
      lastSyncAt: Date.now()
    };

    // ADVANCED-LOCK GATE (user report 2026-07: "advanced earn/spend
    // immediately turned on when I just signed in and can't even access it
    // yet"): cloud sync restores advancedBankedTimeEnabled from another
    // device, but if the Advanced Settings time-lock (10-min post-install
    // grace period) is still active, the feature must NOT come back on here
    // — the worker's per-second tick would auto-start a spend session on an
    // unproductive tab the moment the flag lands. Strip the flag (force
    // false) on every window config while locked. Mirrors the same gate in
    // worker.js pfPullSettingsFromProfile + stats.js pfSyncAdvancedSettingsLock.
    merged.windowConfigs = await stripAdvancedEarnIfLocked(merged.windowConfigs);

    await chrome.storage.local.set(merged);
    await getOrInitTelemetryId();

    console.info('[pf-sync] pull success:', {
      keywords: Object.keys(merged.userKeywords).length,
      keywordPairs: Object.keys(merged.userKeywordPairs).length,
      hostnames: Object.keys(merged.hostnameBias).length,
      paths: Object.keys(merged.pathScores).length,
      keywordsMerged: kwMerge.overlapCount,
      hostnamesMerged: hostMerge.overlapCount,
      pathsMerged: pathMerge.overlapCount
    });

    await syncPushNow({ fromPullComplete: true });
    return { success: true };
  } catch (e) {
    console.info('[pf-sync] pull failed:', 0, String(e?.message || e).slice(0, 200));
    await notifySyncUserFailure('pull', { error: String(e?.message || e) });
    return { skipped: true, reason: 'pull_error', error: String(e?.message || e) };
  } finally {
    pullInProgress = false;
    finishDeferredSchedulePush();
  }
}

export async function isHostnameTrapped(hostname, pageUrl = '') {
  try {
    await loadSnapshot();
    const hit = getSnapshotTrap(hostname, pageUrl);
    if (hit) {
      const expected = hit.class === 'P'
        ? 'Productive'
        : hit.class === 'U'
          ? 'Unproductive'
          : 'Neutral';
      return {
        isTrap: true,
        expected,
        confidence: Number(hit.confidence) || 0
      };
    }
    return { isTrap: false, expected: null, confidence: 0 };
  } catch (_) {
    return { isTrap: false, expected: null, confidence: 0 };
  }
}

export async function pushFeedbackEvent({
  rawUrl,
  hostname,
  classification,
  userVerdict,
  tokens,
  confidence,
  sourcePath,
  wasTrap,
  trapExpected,
  contributorElo
}) {
  try {
    const mode = await getResolvedDataCollectionMode();
    const allowed = await isRemoteSyncAllowed();
    console.info('[pf-sync-gate] push attempt', { fn: 'pushFeedbackEvent', mode, allowed });
    if (!allowed) {
      console.info('[pf-sync-gate] blocked — mode not standard');
      return;
    }

    if (await shouldBlackholeContributorPush()) {
      console.info('[pf-telemetry] contributor muted — feedback event black-holed');
      return;
    }

    // BOT SHADOW-BAN (2026-07): suspected automation never contributes
    // feedback events to the global dataset.
    try {
      const { pfBotSuspect } = await chrome.storage.local.get('pfBotSuspect');
      if (pfBotSuspect === true) {
        console.info('[pf-telemetry] bot-suspect — feedback event shadow-dropped');
        return;
      }
    } catch (_) { /* storage unavailable — proceed */ }

    if (rawUrl) {
      const sanitized = sanitizeUrlForTelemetry(rawUrl);
      if (!sanitized) {
        console.info('[pf-privacy-strip] feedback event skipped — excluded host');
        return;
      }
      hostname = sanitized.hostname;
    }

    const telemetryStored = await chrome.storage.local.get(['telemetryEnabled', 'dataCollectionMode']);
    const devKillSwitchOn = telemetryStored.telemetryEnabled !== false;

    const auth = await getAuthContext();
    if (!auth) {
      console.info('[pf-telemetry] skip — not signed in');
      return;
    }

    if (!devKillSwitchOn) {
      console.info('[pf-telemetry] dev kill-switch off, skipping');
      return;
    }

    let eloAtTime = Number(contributorElo);
    if (!Number.isFinite(eloAtTime)) {
      const eloStored = await chrome.storage.local.get('userElo');
      eloAtTime = Number(eloStored.userElo ?? 5);
    }

    const sanitized = sanitizeTokensForPush(tokens);
    const filteredTokens = await filterPersonalNameTokensFromTelemetry(sanitized);

    const body = {
      user_id: auth.userId,
      contributor_elo_at_time: eloAtTime,
      hostname: String(hostname || '').slice(0, 253),
      classification: String(classification || 'Neutral'),
      user_verdict: String(userVerdict || 'Neutral'),
      tokens: filteredTokens.slice(0, 50),
      // Fingerprint mitigation (security review 2026-07): confidence
      // bucketed to 10 tiers before send. Feedback events already
      // include telemetry_id server-side; the raw decimal was a
      // quasi-identifier without adding signal that the classifier
      // couldn't get from the bucketed value.
      confidence: pfBucketScore(confidence, 10),
      source_path: String(sourcePath || 'unknown'),
      was_trap: wasTrap === true,
      trap_expected: trapExpected || null
    };

    const response = await authedFetch(`${SUPABASE_URL}/rest/v1/feedback_events`, {
      method: 'POST',
      headers: {
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    });

    if (response.status === 401) {
      console.info('[pf-telemetry] skip — not signed in');
      return;
    }

    if (!response.ok) {
      const brief = (await response.text()).slice(0, 200);
      console.info('[pf-telemetry] event push failed:', response.status, brief);
      return;
    }

    console.info('[pf-telemetry] event pushed',
      `(hostname=${body.hostname}, verdict=${body.user_verdict})`);

    const countStored = await chrome.storage.local.get('feedbackEventCount');
    await chrome.storage.local.set({
      feedbackEventCount: (Number(countStored.feedbackEventCount) || 0) + 1
    });
  } catch (e) {
    console.info('[pf-telemetry] event push failed:', 0,
      String(e?.message || e).slice(0, 200));
  }
}

export async function pushEngagementEvent(payload) {
  try {
    const mode = await getResolvedDataCollectionMode();
    const allowed = await isRemoteSyncAllowed();
    console.info('[pf-sync-gate] push attempt', { fn: 'pushEngagementEvent', mode, allowed });
    if (!allowed) {
      console.info('[pf-sync-gate] blocked — mode not standard');
      return { ok: false, reason: 'local_mode' };
    }

    if (await shouldBlackholeContributorPush()) {
      console.info('[pf-engagement] contributor muted — push black-holed');
      return { ok: false, reason: 'contributor_muted' };
    }

    const ctx = await getAuthContext();
    if (!ctx) {
      console.info('[pf-engagement] skip — not signed in');
      return { ok: false, reason: 'not_signed_in' };
    }

    const telemetryId = ctx.telemetryId || await getOrInitTelemetryId();

    let hostname = String(payload?.hostname || '').toLowerCase();
    if (payload?.rawUrl) {
      const sanitized = sanitizeUrlForTelemetry(payload.rawUrl);
      if (!sanitized) {
        console.info('[pf-privacy-strip] engagement event skipped — excluded host');
        return { ok: false, reason: 'excluded_host' };
      }
      hostname = sanitized.hostname;
    }

    // Fingerprint mitigation (security review 2026-07): bucket the score
    // + bot confidence into discrete tiers and round the active-time to
    // 10-second buckets. This kills the "combination of 3 near-identical
    // 7-sig-fig decimals fingerprints me" attack described in the review.
    const body = {
      user_id: ctx.userId,
      telemetry_id: telemetryId,
      hostname,
      classification: payload?.classification || null,
      pure_engagement_score: pfBucketScore(payload?.pure_engagement_score, 10),
      bot_confidence: pfBucketScore(payload?.bot_confidence, 20),
      active_time_ms: pfRoundDurationMs(payload?.active_time_ms),
      trigger_reason: String(payload?.trigger_reason || 'unknown'),
      user_elo: payload?.user_elo == null ? null : Number(payload.user_elo)
    };

    const resp = await authedFetch(`${SUPABASE_URL}/rest/v1/engagement_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn('[pf-engagement] push failed', resp.status, text);
      return { ok: false, reason: 'http_error', status: resp.status };
    }

    console.info('[pf-engagement] push success', {
      hostname: body.hostname,
      score: body.pure_engagement_score,
      trigger: body.trigger_reason
    });
    return { ok: true };
  } catch (e) {
    console.warn('[pf-engagement] push exception', e?.message);
    return { ok: false, reason: 'exception' };
  }
}

export async function pushUrlEngagementBatch(records) {
  try {
    const mode = await getResolvedDataCollectionMode();
    const allowed = await isRemoteSyncAllowed();
    console.info('[pf-sync-gate] push attempt', { fn: 'pushUrlEngagementBatch', mode, allowed });
    if (!allowed) {
      console.info('[pf-sync-gate] blocked — mode not standard');
      return { ok: false, reason: 'local_mode' };
    }

    if (await shouldBlackholeContributorPush()) {
      console.info('[pf-url-engagement] contributor muted — batch black-holed');
      return { ok: false, reason: 'contributor_muted' };
    }

    const ctx = await getAuthContext();
    if (!ctx) {
      console.info('[pf-url-engagement] skip — not signed in');
      return { ok: false, reason: 'not_signed_in' };
    }

    const telemetryId = ctx.telemetryId || await getOrInitTelemetryId();
    const { userElo } = await chrome.storage.local.get('userElo');
    let skippedMalformed = 0;
    const body = (records || []).map((r) => {
      try {
        const rawUrl = r.raw_url || r.rawUrl
          || (r.clean_host ? `https://${r.clean_host}${r.clean_path || ''}` : null);
        const sanitized = sanitizeUrlForTelemetry(rawUrl);
        if (!sanitized) return null;
        const rawBotConfidence = r.bot_confidence != null
          ? Math.min(1, Math.max(0, Number(r.bot_confidence) || 0))
          : computeBotConfidence(r);
        // Fingerprint mitigation (security review 2026-07):
        // - engagement + bot score → bucketed to 10/20 tiers
        // - total_time_ms → rounded to nearest 10s
        // - first/last seen timestamps → rounded to nearest 5min
        const firstSeenMs = pfRoundTimestampMs(new Date(r.first_seen_at).getTime());
        const lastSeenMs = pfRoundTimestampMs(new Date(r.last_seen_at).getTime());
        return {
          user_id: ctx.userId,
          telemetry_id: telemetryId,
          hostname: sanitized.hostname,
          clean_host: sanitized.hostname,
          clean_path: sanitized.cleanPath,
          url: sanitized.cleanUrl,
          pure_engagement_score: pfBucketScore(r.pure_engagement_score, 10),
          bot_confidence: pfBucketScore(rawBotConfidence, 20),
          total_time_ms: pfRoundDurationMs(r.total_time_ms),
          first_seen_at: firstSeenMs ? new Date(firstSeenMs).toISOString() : new Date(r.first_seen_at).toISOString(),
          last_seen_at: lastSeenMs ? new Date(lastSeenMs).toISOString() : new Date(r.last_seen_at).toISOString(),
          state_context: r.state_context || 'active',
          user_elo: userElo == null ? null : Number(userElo)
        };
      } catch (e) {
        skippedMalformed++;
        return null;
      }
    }).filter(Boolean);
    if (skippedMalformed > 0) {
      console.warn('[pf-url-engagement] skipped malformed records:', skippedMalformed);
    }

    const validRows = body.filter(
      (r) => r.hostname && r.hostname !== 'unknown' && r.user_id
    );
    if (validRows.length === 0) {
      return { ok: true, reason: 'empty_batch' };
    }

    const resp = await authedFetch(`${SUPABASE_URL}/rest/v1/url_engagement_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(validRows)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn('[pf-url-engagement] batch push failed', resp.status, text);
      return { ok: false, status: resp.status };
    }

    console.info('[pf-url-engagement] batch push success', validRows.length, 'URLs');
    return { ok: true };
  } catch (e) {
    console.warn('[pf-url-engagement] batch push exception', e?.message);
    return { ok: false, reason: 'exception' };
  }
}
