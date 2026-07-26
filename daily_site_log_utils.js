/** Shared helpers for dailySiteLogs host entries (split by classification). */

export const PVU_LOG_TYPES = ['Productive', 'Unproductive', 'Neutral'];

export function emptyDailySiteLogEntry() {
  return { Productive: 0, Unproductive: 0, Neutral: 0 };
}

export function normalizeDailySiteLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return emptyDailySiteLogEntry();
  if (
    Object.prototype.hasOwnProperty.call(entry, 'Productive')
    || Object.prototype.hasOwnProperty.call(entry, 'Unproductive')
    || Object.prototype.hasOwnProperty.call(entry, 'Neutral')
  ) {
    return {
      Productive: Math.max(0, Number(entry.Productive) || 0),
      Unproductive: Math.max(0, Number(entry.Unproductive) || 0),
      Neutral: Math.max(0, Number(entry.Neutral) || 0)
    };
  }
  const sec = Math.max(0, Number(entry.seconds) || 0);
  let type = entry.type;
  if (type !== 'Productive' && type !== 'Unproductive' && type !== 'Neutral') {
    type = 'Neutral';
  }
  const out = emptyDailySiteLogEntry();
  out[type] = sec;
  return out;
}

export function dailySiteLogTotal(entry) {
  const buckets = normalizeDailySiteLogEntry(entry);
  return buckets.Productive + buckets.Unproductive + buckets.Neutral;
}

export function normalizePvuClassification(classification) {
  return classification === 'Productive' || classification === 'Unproductive' || classification === 'Neutral'
    ? classification
    : 'Neutral';
}

export const STREAK_PRODUCTIVE_GOAL_SEC = 30 * 60;
export const STREAK_PRODUCTIVE_GOAL_MIN = 30;

export function sumProductiveSecondsForDay(dayKey, dailySiteLogs = {}) {
  const day = dailySiteLogs?.[dayKey];
  if (!day || typeof day !== 'object') return 0;
  let total = 0;
  for (const entry of Object.values(day)) {
    total += normalizeDailySiteLogEntry(entry).Productive;
  }
  return total;
}
