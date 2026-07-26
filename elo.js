// elo.js — unified contributor trust calibration (traps, classifier, global consensus)

export const ELO_MIN = -5;
export const ELO_MAX = 10;
export const ELO_MUTE_THRESHOLD = 1.5;
export const TRAP_CATASTROPHIC_MULTIPLIER = 0.20;
export const TRAP_FIRST_STRIKE_PENALTY = -1.0;

const TRAP_STREAK_SESSION_KEY = 'trapStreak';

const BASE_GAIN = 0.05;
const BASE_LOSS = 0.15;
const HISTORY_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_TRAP_EVENTS = 5;

const SHORT_TO_LONG = {
  P: 'Productive',
  U: 'Unproductive',
  N: 'Neutral'
};

function clampElo(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(ELO_MIN, Math.min(ELO_MAX, Number(n.toFixed(2))));
}

function normalizeVerdictLong(verdict) {
  if (verdict == null) return 'Neutral';
  if (verdict === 'Productive' || verdict === 'Unproductive' || verdict === 'Neutral') {
    return verdict;
  }
  return SHORT_TO_LONG[String(verdict).toUpperCase()] || 'Neutral';
}

function normalizeGlobalProductive(value) {
  if (value === true || value === 'Productive') return true;
  if (value === false || value === 'Unproductive') return false;
  return null;
}

function isRateLimited(history, now) {
  const recentTrapEvents = history.filter(
    (entry) => entry.isTrap && (now - entry.ts) < RATE_LIMIT_WINDOW_MS
  );
  return recentTrapEvents.length >= RATE_LIMIT_TRAP_EVENTS;
}

async function appendEloHistory(entry) {
  const stored = await chrome.storage.local.get('eloUpdateHistory');
  const history = Array.isArray(stored.eloUpdateHistory) ? stored.eloUpdateHistory : [];
  const updatedHistory = [...history, entry].slice(-HISTORY_MAX);
  await chrome.storage.local.set({ eloUpdateHistory: updatedHistory });
}

export function isContributorMuted(userElo) {
  return Number(userElo ?? 5) <= ELO_MUTE_THRESHOLD;
}

async function getTrapStreak() {
  try {
    const stored = await chrome.storage.session.get(TRAP_STREAK_SESSION_KEY);
    const n = Number(stored[TRAP_STREAK_SESSION_KEY]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch (_) {
    return 0;
  }
}

async function setTrapStreak(streak) {
  const value = Math.max(0, Math.floor(Number(streak) || 0));
  try {
    await chrome.storage.session.set({ [TRAP_STREAK_SESSION_KEY]: value });
  } catch (_) { /* session unavailable — streak not persisted */ }
  return value;
}

async function resetTrapStreak() {
  return setTrapStreak(0);
}

/**
 * Unified feedback Elo update — replaces all legacy inline deltas in worker.js.
 * Trap contradiction: first failure in session = flat -1.0 (human buffer);
 * consecutive failure (trap_streak >= 1) = multiplicative wipeout (× 0.20).
 */
export async function applyFeedbackEloUpdate({
  currentElo,
  userVerdict,
  source = 'feedback_card',
  isTrap = false,
  trapExpected = null,
  trapConfidence = 0,
  extensionClassification = 'Neutral',
  classifierConfidence = 0,
  globalConfidence = null,
  globalSaysProductive = null
}) {
  const stored = await chrome.storage.local.get('eloUpdateHistory');
  const history = Array.isArray(stored.eloUpdateHistory) ? stored.eloUpdateHistory : [];
  const now = Date.now();
  const before = clampElo(currentElo);
  const normalizedVerdict = normalizeVerdictLong(userVerdict);

  if (isTrap && isRateLimited(history, now)) {
    const trapStreak = await getTrapStreak();
    return {
      newElo: before,
      delta: 0,
      agreed: false,
      catastrophic: false,
      trapWarning: false,
      trapStreak,
      rateLimited: true
    };
  }

  if (isTrap) {
    const expected = normalizeVerdictLong(trapExpected);
    const agreed = normalizedVerdict === expected;
    if (!agreed) {
      const trapStreakBefore = await getTrapStreak();
      if (trapStreakBefore === 0) {
        const newElo = clampElo(before + TRAP_FIRST_STRIKE_PENALTY);
        const trapStreak = await setTrapStreak(1);
        await appendEloHistory({
          ts: now,
          delta: newElo - before,
          isTrap: true,
          agreed: false,
          catastrophic: false,
          trapWarning: true,
          trapStreakBefore,
          trapStreak,
          source,
          before,
          after: newElo
        });
        return {
          newElo,
          delta: newElo - before,
          agreed: false,
          catastrophic: false,
          trapWarning: true,
          trapStreak,
          rateLimited: false
        };
      }

      const newElo = clampElo(
        Math.min(before, before > 0 ? before * TRAP_CATASTROPHIC_MULTIPLIER : before - 1.0)
      );
      const trapStreak = await setTrapStreak(trapStreakBefore + 1);
      await appendEloHistory({
        ts: now,
        delta: newElo - before,
        isTrap: true,
        agreed: false,
        catastrophic: true,
        trapWarning: false,
        trapStreakBefore,
        trapStreak,
        source,
        before,
        after: newElo
      });
      return {
        newElo,
        delta: newElo - before,
        agreed: false,
        catastrophic: true,
        trapWarning: false,
        trapStreak,
        rateLimited: false
      };
    }

    await resetTrapStreak();
    const conf = Number(trapConfidence) || 0;
    const ceilingFactor = Math.max(0, 1 - before / ELO_MAX);
    const delta = BASE_GAIN * conf * ceilingFactor;
    const newElo = clampElo(before + delta);
    await appendEloHistory({
      ts: now,
      delta,
      isTrap: true,
      agreed: true,
      catastrophic: false,
      trapWarning: false,
      trapStreak: 0,
      source,
      before,
      after: newElo
    });
    return {
      newElo,
      delta,
      agreed: true,
      catastrophic: false,
      trapWarning: false,
      trapStreak: 0,
      rateLimited: false
    };
  }

  if (globalConfidence != null && Number(globalConfidence) >= 0.7 && normalizedVerdict !== 'Neutral') {
    const globalProductive = normalizeGlobalProductive(globalSaysProductive);
    if (globalProductive !== null) {
      const userSaysProductive = normalizedVerdict === 'Productive';
      const agreed = globalProductive === userSaysProductive;
      let delta = 0;
      if (agreed) {
        const ceilingFactor = Math.max(0, 1 - before / ELO_MAX);
        delta = BASE_GAIN * Number(globalConfidence) * 0.5 * ceilingFactor;
      } else {
        delta = -BASE_LOSS * Number(globalConfidence) * 0.5;
      }
      if (delta !== 0) {
        const newElo = clampElo(before + delta);
        const trapStreak = agreed ? await resetTrapStreak() : await getTrapStreak();
        await appendEloHistory({
          ts: now,
          delta,
          isTrap: false,
          agreed,
          catastrophic: false,
          trapWarning: false,
          trapStreak,
          source: `${source}:global`,
          before,
          after: newElo
        });
        return {
          newElo,
          delta,
          agreed,
          catastrophic: false,
          trapWarning: false,
          trapStreak,
          rateLimited: false
        };
      }
    }
  }

  const conf = Number(classifierConfidence) || 0;
  const eloWeight = Math.max(0.1, before / 10);
  const extUnprod = extensionClassification === 'Unproductive';
  const extProd = extensionClassification === 'Productive';
  const userProd = normalizedVerdict === 'Productive';
  const userUnprod = normalizedVerdict === 'Unproductive';

  let delta = 0;

  if (source === 'close_card') {
    if (userProd && conf > 0.85) {
      delta = -(conf * eloWeight * 0.3);
    } else if (userUnprod) {
      delta = 0.05;
    }
  } else {
    if (extUnprod && userProd && conf > 0.85) {
      delta = -(conf * eloWeight * 0.3);
    } else if (extProd && userUnprod && conf > 0.85) {
      delta = -(conf * eloWeight * 0.3);
    } else if (userUnprod && extUnprod) {
      delta = 0.15;
    } else if (userProd && extUnprod) {
      delta = 0.05;
    }
  }

  const newElo = clampElo(before + delta);
  if (delta !== 0) {
    await appendEloHistory({
      ts: now,
      delta,
      isTrap: false,
      agreed: delta > 0,
      catastrophic: false,
      source: `${source}:classifier`,
      before,
      after: newElo
    });
  }

  return {
    newElo,
    delta,
    agreed: delta > 0,
    catastrophic: false,
    trapWarning: false,
    trapStreak: await getTrapStreak(),
    rateLimited: false
  };
}

/** @deprecated Use applyFeedbackEloUpdate — retained for any stale imports */
export async function computeEloDelta(params) {
  const result = await applyFeedbackEloUpdate({
    currentElo: params.currentElo,
    userVerdict: params.userVerdict,
    isTrap: params.isTrap,
    trapExpected: params.trapExpected,
    trapConfidence: params.trapConfidence,
    globalConfidence: params.globalConfidence,
    globalSaysProductive: params.globalSaysProductive,
    extensionClassification: 'Neutral',
    classifierConfidence: 0
  });
  return result.delta;
}
