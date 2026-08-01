/** Behavioral telemetry helpers — local aggregation + network-safe sanitization. */

import { sanitizeUrlForTelemetry, formatTelemetryStorageKey } from './privacy_telemetry.js';

export async function getOrInitTelemetryId() {
  const result = await chrome.storage.local.get('telemetryId');
  if (result.telemetryId) return result.telemetryId;

  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ telemetryId: newId });
  return newId;
}

export function bucketUrlForLocalTelemetry(rawUrl) {
  try {
    const sanitized = sanitizeUrlForTelemetry(rawUrl);
    if (sanitized?.hostname) {
      return {
        clean_host: sanitized.hostname,
        clean_path: sanitized.cleanPath ?? '',
      };
    }

    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { clean_host: 'unknown', clean_path: '/' };
    }

    return { clean_host: host, clean_path: '/' };
  } catch (_) {
    return { clean_host: 'unknown', clean_path: '/' };
  }
}

export function telemetryBucketKey(rawUrl) {
  const { clean_host, clean_path } = bucketUrlForLocalTelemetry(rawUrl);
  return formatTelemetryStorageKey(clean_host, clean_path);
}

export function hostnameOnlyForTelemetry(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host || null;
  } catch (_) {
    return null;
  }
}

function hostnameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl || '');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (!host) return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch (_) {
    return null;
  }
}

/** Minimum ms + score for hourly portfolio snapshot of open-but-idle tabs. */
export const PASSIVE_RESTING_MS = 5000;
export const PASSIVE_RESTING_SCORE = 0.5;

/** Caps time component — log-scale saturates near 1 hour of active time. */
const ENGAGEMENT_TIME_CAP_SEC = 3600;
const ENGAGEMENT_W_TIME = 0.35;
const ENGAGEMENT_W_DENSITY = 0.45;
const ENGAGEMENT_W_NAV = 0.20;

/**
 * Before hourly sync, seed any open tab whose bucket is missing from the buffer
 * so background/hoarded tabs still appear in the portfolio map.
 */
export function seedPassivePortfolioTabs(buffer, openTabs, { now = Date.now(), skipUrl = () => false } = {}) {
  const next = buffer && typeof buffer === 'object' ? buffer : {};
  for (const tab of openTabs || []) {
    if (!tab?.url) continue;
    const hostname = hostnameFromUrl(tab.url);
    if (!hostname) continue;
    if (skipUrl(tab.url)) continue;

    const bucketKey = telemetryBucketKey(tab.url);
    if (next[bucketKey]) continue;

    const { clean_host, clean_path } = bucketUrlForLocalTelemetry(tab.url);
    if (!clean_host || clean_host === 'unknown') continue;

    next[bucketKey] = {
      clean_host,
      clean_path,
      totalTimeMs: PASSIVE_RESTING_MS,
      signalWeight: 0,
      deltaS: 0,
      deltaK: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      state_context: 'passive',
      restingScore: PASSIVE_RESTING_SCORE
    };
  }
  return next;
}

/** 0–1 bot-likelihood for server-side down-weighting (not a hard drop). */
export function computeBotConfidence(tel) {
  if (!tel) return 0;
  migrateTelemetryFields(tel);
  let confidence = 0;
  if (tel.rapidPulse) confidence += 0.65;
  if (tel.repeatBurst) confidence += 0.35;
  return Math.min(1, Math.max(0, confidence));
}

function computeEngagementComponents(tel, { includeNav = true } = {}) {
  migrateTelemetryFields(tel);
  const activeSec = (Number(tel.totalTimeMs) || 0) / 1000;
  const pathTransitions = Number(tel.pathTransitions) || 0;
  const tabReturns = Number(tel.tabReturns) || 0;
  const signalWeight = Number(tel.signalWeight) || 0;
  const deltaS = Number(tel.deltaS) || 0;
  const deltaK = Number(tel.deltaK) || 0;

  const interactionTicks = signalWeight * 0.5 + deltaS * 0.2 + deltaK * 0.3;
  const timeComponent = Math.min(
    1,
    Math.log(activeSec + 1) / Math.log(ENGAGEMENT_TIME_CAP_SEC + 1)
  );
  const densityComponent = Math.tanh(interactionTicks / (activeSec + 1));
  const navComponent = includeNav
    ? Math.min(1, pathTransitions * 0.12 + tabReturns * 0.15)
    : 0;

  return { timeComponent, densityComponent, navComponent };
}

/**
 * Bounded 0–1 engagement score for server push — rate/time based, no machine-specific values.
 * Never zeroed by bot flags; pair with computeBotConfidence for server weighting.
 */
export function computeNormalizedEngagementScore(tel, { includeNav = true } = {}) {
  if (!tel) return 0;
  const { timeComponent, densityComponent, navComponent } = computeEngagementComponents(tel, { includeNav });
  const score = ENGAGEMENT_W_TIME * timeComponent
    + ENGAGEMENT_W_DENSITY * densityComponent
    + ENGAGEMENT_W_NAV * navComponent;
  return Math.min(1, Math.max(0, score));
}

export function resolveBufferEngagementScore(record) {
  if (!record) return 0;
  if (record.state_context === 'passive') {
    return Number(record.restingScore) || PASSIVE_RESTING_SCORE;
  }
  return computeNormalizedEngagementScore(record, { includeNav: false });
}

/** Default multipliers for local bot dampening (ranking/eviction only — not server push). */
export const DEFAULT_ENGAGEMENT_BOT_CONFIG = {
  rapidPulseMultiplier: 0.5,
  rapidPulseEvictionScore: 0,
  repeatBurstMultiplier: 0.8
};

/**
 * Optional runtime override for staging/automation (set globalThis.__pfEngagementBotConfig).
 * Example: { bypassBotPenalties: true } or { rapidPulseMultiplier: 1 }
 */
export function resolveEngagementBotConfig(overrides = {}) {
  const runtime = (typeof globalThis !== 'undefined' && globalThis.__pfEngagementBotConfig) || {};
  return {
    ...DEFAULT_ENGAGEMENT_BOT_CONFIG,
    ...runtime,
    ...overrides
  };
}

const LEGACY_FIELD_MAP = [
  ['keystrokeCount', 'deltaK'],
  ['clickCount', 'deltaC'],
  ['scrollCount', 'deltaS'],
  ['weightedClickScore', 'signalWeight'],
  ['isBotLoop', 'rapidPulse'],
  ['isRageClicking', 'repeatBurst'],
  ['urlVisits', 'pathTransitions']
];

export function migrateTelemetryFields(tel) {
  if (!tel || typeof tel !== 'object') return tel;
  for (const [legacy, next] of LEGACY_FIELD_MAP) {
    if (tel[legacy] != null && tel[next] == null) {
      tel[next] = tel[legacy];
    }
    delete tel[legacy];
  }
  if (tel.urlChanges != null && tel.pathTransitions == null) {
    tel.pathTransitions = tel.urlChanges;
  }
  delete tel.urlChanges;

  tel.pathTransitions = Number(tel.pathTransitions) || 0;
  tel.tabReturns = Number(tel.tabReturns) || 0;
  tel.deltaC = Number(tel.deltaC) || 0;
  tel.deltaS = Number(tel.deltaS) || 0;
  tel.deltaK = Number(tel.deltaK) || 0;
  tel.signalWeight = Number(tel.signalWeight) || 0;
  tel.rapidPulse = !!tel.rapidPulse;
  tel.repeatBurst = !!tel.repeatBurst;
  return tel;
}

export function createDefaultTelemetry(tabUrl = null) {
  return {
    totalTimeMs: 0,
    lastInteraction: 0,
    productivityScoreSum: 0,
    pathTransitions: tabUrl && tabUrl !== '' && !String(tabUrl).startsWith('chrome:') ? 1 : 0,
    tabReturns: 0,
    activatedAt: null,
    deltaC: 0,
    deltaS: 0,
    deltaK: 0,
    signalWeight: 0,
    rapidPulse: false,
    repeatBurst: false,
    lastEngagementPush: null
  };
}

/**
 * Local engagement score (0–1) with optional bot dampening for ranking/eviction.
 * Server push uses computeNormalizedEngagementScore + computeBotConfidence instead.
 *
 * Options:
 * - botPenaltyMultiplier / rapidPulseMultiplier — dampen score when rapidPulse (default 0.5)
 * - rapidPulseEvictionScore — score when rapidPulse and !forRanking (default 0)
 * - repeatBurstMultiplier — dampen when repeatBurst (default 0.8)
 * - ignoreBotSignals / bypassBotPenalties — skip all bot dampening (staging/automation)
 */
export function computeEngagementScore(tel, options = {}) {
  if (!tel) return 0;
  migrateTelemetryFields(tel);

  const botConfig = resolveEngagementBotConfig(options);
  const {
    includeNav = true,
    forRanking = false,
    ignoreBotSignals = false,
    bypassBotPenalties = false,
    botPenaltyMultiplier,
    rapidPulseMultiplier,
    rapidPulseEvictionScore,
    repeatBurstMultiplier
  } = { ...botConfig, ...options };

  const rapidMul = rapidPulseMultiplier ?? botPenaltyMultiplier ?? DEFAULT_ENGAGEMENT_BOT_CONFIG.rapidPulseMultiplier;
  const repeatMul = repeatBurstMultiplier ?? DEFAULT_ENGAGEMENT_BOT_CONFIG.repeatBurstMultiplier;
  const evictionScore = rapidPulseEvictionScore ?? DEFAULT_ENGAGEMENT_BOT_CONFIG.rapidPulseEvictionScore;
  const skipBot = ignoreBotSignals || bypassBotPenalties;

  let score = computeNormalizedEngagementScore(tel, { includeNav });
  if (skipBot) return score;

  if (tel.repeatBurst) score *= repeatMul;
  if (tel.rapidPulse) {
    if (!forRanking) return evictionScore;
    score *= rapidMul;
  }
  return score;
}

/**
 * ── IMPORTANCE (ordering only, v84) ──────────────────────────────────────
 *
 * User spec: "instead of just the engagement it also looks at how much you
 * open that tab for importance. dont change the engagement score thats sent
 * but change the order thing."
 *
 * So this lives OUTSIDE computeNormalizedEngagementScore on purpose.
 * That function is the number pushed to the server; it has to stay
 * comparable across versions and across users, and nothing here may leak
 * into it.
 *
 * Why engagement alone was not enough: engagement is dominated by dwell
 * time, and it already folds revisits into navComponent as
 * min(1, pathTransitions*0.12 + tabReturns*0.15) — which saturates after
 * about seven of them and is then worth ENGAGEMENT_W_NAV of the total.
 * A reference tab you flick back to forty times a day maxes that term out
 * early and still loses to a video left playing in the background.
 *
 * The revisit component is logarithmic: the first few returns move the
 * needle most, and it keeps rising (slowly) past the point where
 * navComponent has flatlined, so "I keep coming back to this" never stops
 * counting. pathTransitions counts at a quarter weight — navigating within
 * a tab is a weaker signal of importance than deliberately returning to it.
 */
/**
 * 0.20 is deliberately modest. Real engagement scores bunch between about
 * 0.2 and 0.6 rather than spanning the full 0–1, so a revisit term worth
 * 0.20/1.20 ≈ 0.17 of the range is already enough to reorder tabs that are
 * close, while a tab you genuinely worked in still beats one you merely
 * flicked through sixty times. At 0.35 (tried first) the flicked tab won,
 * which turns the tab bar into a click counter.
 */
export const IMPORTANCE_REVISIT_WEIGHT = 0.20;
export const IMPORTANCE_REVISIT_CAP = 12;

export function computeRevisitComponent(tel) {
  if (!tel) return 0;
  const tabReturns = Number(tel.tabReturns) || 0;
  const pathTransitions = Number(tel.pathTransitions) || 0;
  const revisits = tabReturns + pathTransitions * 0.25;
  if (revisits <= 0) return 0;
  return Math.min(1, Math.log(revisits + 1) / Math.log(IMPORTANCE_REVISIT_CAP + 1));
}

/**
 * Ordering score: engagement, plus how often the tab gets reopened.
 *
 * Normalised by (1 + weight) so the result stays 0–1 like the engagement
 * score it replaces, and it is strictly monotonic in engagement — two tabs
 * with identical revisit counts still sort by engagement exactly as before.
 */
export function computeTabImportanceScore(tel, options = {}) {
  if (!tel) return 0;
  const engagement = computeEngagementScore(tel, { includeNav: true, ...options });
  const revisit = computeRevisitComponent(tel);
  return (engagement + IMPORTANCE_REVISIT_WEIGHT * revisit) / (1 + IMPORTANCE_REVISIT_WEIGHT);
}

export function hasMeaningfulEngagement(tel) {
  if (!tel) return false;
  migrateTelemetryFields(tel);
  const totalTimeMs = Number(tel.totalTimeMs) || 0;
  const deltaC = Number(tel.deltaC) || 0;
  const deltaK = Number(tel.deltaK) || 0;
  return deltaC > 0 || deltaK > 0 || totalTimeMs > 30000;
}

export function resetTelEngagementCounters(tel) {
  if (!tel) return;
  migrateTelemetryFields(tel);
  tel.deltaC = 0;
  tel.deltaS = 0;
  tel.deltaK = 0;
  tel.signalWeight = 0;
  tel.rapidPulse = false;
  tel.repeatBurst = false;
  tel.pathTransitions = 0;
  tel.tabReturns = 0;
}

export function migrateUrlEngagementBuffer(buffer) {
  if (!buffer || typeof buffer !== 'object') return {};
  const migrated = {};
  for (const [key, raw] of Object.entries(buffer)) {
    if (!raw || typeof raw !== 'object') continue;
    let srcUrl = raw.url || (typeof key === 'string' && key.startsWith('http') ? key : null);
    if (!srcUrl && raw.clean_host) {
      srcUrl = `https://${raw.clean_host}${raw.clean_path || '/'}`;
    }
    if (!srcUrl) continue;

    const { clean_host, clean_path } = bucketUrlForLocalTelemetry(srcUrl);
    const bucketKey = telemetryBucketKey(srcUrl);
    const rec = migrated[bucketKey] || {
      clean_host,
      clean_path,
      totalTimeMs: 0,
      signalWeight: 0,
      deltaS: 0,
      deltaK: 0,
      firstSeenAt: raw.firstSeenAt || Date.now(),
      lastSeenAt: raw.lastSeenAt || Date.now()
    };
    rec.clean_host = clean_host;
    rec.clean_path = clean_path;
    if (raw.cleanUrl) rec.cleanUrl = raw.cleanUrl;
    delete rec.rawUrl;
    rec.totalTimeMs += Number(raw.totalTimeMs) || 0;
    rec.signalWeight += Number(raw.signalWeight ?? raw.weightedClickScore) || 0;
    rec.deltaS += Number(raw.deltaS ?? raw.scrollCount) || 0;
    rec.deltaK += Number(raw.deltaK ?? raw.keystrokeCount) || 0;
    rec.rapidPulse = !!(rec.rapidPulse || raw.rapidPulse);
    rec.repeatBurst = !!(rec.repeatBurst || raw.repeatBurst);
    rec.firstSeenAt = Math.min(rec.firstSeenAt, raw.firstSeenAt || rec.firstSeenAt);
    rec.lastSeenAt = Math.max(rec.lastSeenAt, raw.lastSeenAt || rec.lastSeenAt);
    migrated[bucketKey] = rec;
  }
  return migrated;
}

export function migrateTabUrlSnapshots(snapshots) {
  if (!snapshots || typeof snapshots !== 'object') return {};
  const migrated = {};
  for (const [tabId, snap] of Object.entries(snapshots)) {
    if (!snap || typeof snap !== 'object') continue;
    const next = { ...snap };
    if (!next.bucketKey && next.url) {
      next.bucketKey = telemetryBucketKey(next.url);
    }
    if (next.weightedClickScore != null && next.signalWeight == null) {
      next.signalWeight = next.weightedClickScore;
    }
    if (next.scrollCount != null && next.deltaS == null) {
      next.deltaS = next.scrollCount;
    }
    if (next.keystrokeCount != null && next.deltaK == null) {
      next.deltaK = next.keystrokeCount;
    }
    delete next.url;
    delete next.weightedClickScore;
    delete next.scrollCount;
    delete next.keystrokeCount;
    migrated[tabId] = next;
  }
  return migrated;
}
