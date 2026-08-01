/**
 * Wall-clock timer engine — single source of truth for Work/Study and Break sessions.
 * Stored truth: status, mode, startedAt, limitSec, pausedAt, totalPausedMs, windowName.
 * Elapsed/remaining are always computed; reads never write.
 */

export const TIMER_SESSION_KEY = 'pfTimerSession';
/** Dedupes expiry side-effects across MV3 worker restarts (mode + windowName + startedAt). */
export const TIMER_EXPIRY_HANDLED_KEY = 'pfTimerExpiryHandled';

export const TIMER_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused'
};

export const TIMER_MODE = {
  STUDY: 'study',
  BREAK: 'break'
};

export function createIdleSession() {
  return {
    status: TIMER_STATUS.IDLE,
    mode: null,
    windowName: null,
    limitSec: 0,
    startedAt: null,
    pausedAt: null,
    totalPausedMs: 0,
    originalInput: ''
  };
}

export function computePausedMs(session, now = Date.now()) {
  if (!session) return 0;
  let pausedMs = Math.max(0, Number(session.totalPausedMs) || 0);
  if (session.status === TIMER_STATUS.PAUSED && session.pausedAt) {
    pausedMs += Math.max(0, now - Number(session.pausedAt));
  }
  return pausedMs;
}

export function computeElapsedMs(session, now = Date.now()) {
  if (!session || session.status === TIMER_STATUS.IDLE || !session.startedAt) return 0;
  const startedAt = Number(session.startedAt) || 0;
  if (startedAt <= 0) return 0;
  return Math.max(0, now - startedAt - computePausedMs(session, now));
}

export function computeElapsedSec(session, now = Date.now()) {
  return Math.floor(computeElapsedMs(session, now) / 1000);
}

export function computeRemainingSec(session, now = Date.now()) {
  const limitSec = Math.max(0, Number(session?.limitSec) || 0);
  if (limitSec <= 0 || session?.status === TIMER_STATUS.IDLE) return 0;
  return Math.max(0, limitSec - computeElapsedSec(session, now));
}

export function isSessionActive(session) {
  return session?.status === TIMER_STATUS.RUNNING || session?.status === TIMER_STATUS.PAUSED;
}

export function isSessionExpired(session, now = Date.now()) {
  if (!isSessionActive(session)) return false;
  const limitSec = Number(session.limitSec) || 0;
  if (limitSec <= 0) return false;
  return computeRemainingSec(session, now) <= 0;
}

export function buildTimerSnapshot(session, now = Date.now()) {
  const idle = createIdleSession();
  const s = session && session.status !== TIMER_STATUS.IDLE ? session : idle;
  const limitSec = Math.max(0, Number(s.limitSec) || 0);
  const elapsedSec = computeElapsedSec(s, now);
  const remainingSec = computeRemainingSec(s, now);
  const active = isSessionActive(s);
  const mode = s.mode || 'none';
  const paused = s.status === TIMER_STATUS.PAUSED;

  return {
    status: s.status || TIMER_STATUS.IDLE,
    mode,
    windowName: s.windowName || null,
    limitSec,
    elapsedSec,
    remainingSec,
    startedAt: s.startedAt || null,
    paused,
    active,
    expired: active && remainingSec <= 0,
    originalInput: s.originalInput || '',
    studyTimerEnabled: mode === TIMER_MODE.STUDY && active,
    breakTimerEnabled: mode === TIMER_MODE.BREAK && active,
    timerMode: active ? mode : 'none',
    timerActive: active && limitSec > 0 && (!paused || remainingSec > 0),
    timerPaused: paused,
    timerTotalSec: active ? limitSec : 0,
    timerElapsedSec: active ? elapsedSec : 0,
    timerRemainingSec: active ? remainingSec : 0,
    timerStartedAt: s.startedAt || null,
    // Video-scoped break (started from the YouTube per-video prompt): the
    // timer belongs to ONE video — it pauses when the user isn't watching
    // it, and a new video's prompt may override it.
    timerVideoScoped: active && s.videoScoped === true,
    timerVideoId: (active && s.videoScoped === true) ? (s.videoId || null) : null
  };
}

export async function loadTimerSession() {
  const stored = await chrome.storage.local.get(TIMER_SESSION_KEY);
  const session = stored[TIMER_SESSION_KEY];
  if (!session || session.status === TIMER_STATUS.IDLE) {
    return createIdleSession();
  }
  // Corruption guard: startTimerSession always writes limitSec >= 1, so an
  // "active" session with no positive limit is corrupt. Such a session can
  // NEVER expire (isSessionExpired returns false when limitSec <= 0) yet
  // still counts as active for enforcement — a ghost study session in this
  // state closes unproductive tabs forever while the UI shows NO timer
  // (buildTimerSnapshot reports timerActive:false for limitSec 0). Repair
  // to idle instead of letting enforcement act on it.
  const corruption = describeSessionCorruption(session);
  if (corruption) {
    try {
      console.warn(`[pf-timer] repaired corrupt active timer session (${corruption})`, {
        mode: session.mode,
        windowName: session.windowName,
        startedAt: session.startedAt,
        limitSec: session.limitSec,
        status: session.status
      });
      await setTimerIdle();
    } catch (_) { /* repair is best-effort; still return idle below */ }
    return createIdleSession();
  }
  return { ...createIdleSession(), ...session };
}

/**
 * Hard upper bound on how long an active session may sit in storage before we
 * treat it as orphaned. Nothing legitimately runs a wall-clock Work/Break
 * session for a full day; a session older than this is left over from a
 * previous browser life (crash, forced update, SW never woke to expire it).
 */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerance for small clock skew / NTP corrections on startedAt. */
const FUTURE_START_TOLERANCE_MS = 60 * 1000;

/**
 * Integrity check for a persisted ACTIVE session. Returns a short reason string
 * when the session is unusable, or null when it is sound.
 *
 * Persisted timer state is the one thing that survives reloads, updates and
 * crashes, so a single bad write can wedge the extension indefinitely: ghost
 * sessions that can never expire keep enforcement running while the UI shows no
 * timer, and orphaned sessions block new timers from starting. Uninstalling
 * clears storage and "fixes" it, which is exactly the symptom users report and
 * cannot act on. Repairing to idle on read is always safe — the worst case is
 * one lost timer, versus an extension that misbehaves until reinstall.
 */
function describeSessionCorruption(session, now = Date.now()) {
  // startTimerSession always writes limitSec >= 1. An "active" session with no
  // positive limit can NEVER expire (isSessionExpired short-circuits on
  // limitSec <= 0) yet still counts as active for enforcement.
  const limitSec = Number(session.limitSec) || 0;
  if (!Number.isFinite(limitSec) || limitSec <= 0) return 'limitSec <= 0';

  // Enforcement, expiry and every broadcast key off mode + windowName. Either
  // one missing or unrecognised means the session can never be matched to a
  // window, so it can never be expired or stopped through the normal paths.
  if (session.mode !== TIMER_MODE.STUDY && session.mode !== TIMER_MODE.BREAK) {
    return `unknown mode: ${String(session.mode)}`;
  }
  if (!session.windowName) return 'missing windowName';

  // Elapsed time is derived entirely from startedAt; a missing, non-numeric or
  // future timestamp makes every downstream computation meaningless.
  const startedAt = Number(session.startedAt) || 0;
  if (!Number.isFinite(startedAt) || startedAt <= 0) return 'missing startedAt';
  if (startedAt > now + FUTURE_START_TOLERANCE_MS) return 'startedAt in the future';
  if (now - startedAt > MAX_SESSION_AGE_MS) return 'session older than 24h';

  // A PAUSED session without pausedAt under-counts paused time forever, so the
  // countdown drains in real time while the UI insists it is paused.
  if (session.status === TIMER_STATUS.PAUSED) {
    const pausedAt = Number(session.pausedAt) || 0;
    if (!Number.isFinite(pausedAt) || pausedAt <= 0) return 'paused without pausedAt';
    if (pausedAt > now + FUTURE_START_TOLERANCE_MS) return 'pausedAt in the future';
  }

  // Accumulated pause time can never exceed the wall-clock age of the session.
  const totalPausedMs = Number(session.totalPausedMs) || 0;
  if (!Number.isFinite(totalPausedMs) || totalPausedMs < 0) return 'negative totalPausedMs';
  if (totalPausedMs > (now - startedAt) + FUTURE_START_TOLERANCE_MS) {
    return 'totalPausedMs exceeds session age';
  }

  return null;
}

export async function saveTimerSession(session) {
  await chrome.storage.local.set({ [TIMER_SESSION_KEY]: session });
}

export async function setTimerIdle() {
  const idle = createIdleSession();
  await saveTimerSession(idle);
  return idle;
}

export async function startTimerSession({
  windowName,
  mode,
  limitSec,
  originalInput = '',
  startedAt = Date.now()
}) {
  const session = {
    status: TIMER_STATUS.RUNNING,
    mode,
    windowName,
    limitSec: Math.max(1, Math.floor(Number(limitSec) || 0)),
    startedAt,
    pausedAt: null,
    totalPausedMs: 0,
    originalInput: originalInput || ''
  };
  await saveTimerSession(session);
  return session;
}

export async function pauseTimerSession(session, now = Date.now()) {
  if (!session || session.status !== TIMER_STATUS.RUNNING) return session;
  const next = {
    ...session,
    status: TIMER_STATUS.PAUSED,
    pausedAt: now
  };
  await saveTimerSession(next);
  return next;
}

export async function resumeTimerSession(session, now = Date.now()) {
  if (!session || session.status !== TIMER_STATUS.PAUSED || !session.pausedAt) return session;
  const pausedAt = Number(session.pausedAt) || now;
  const next = {
    ...session,
    status: TIMER_STATUS.RUNNING,
    totalPausedMs: Math.max(0, Number(session.totalPausedMs) || 0) + Math.max(0, now - pausedAt),
    pausedAt: null
  };
  await saveTimerSession(next);
  return next;
}

export async function stopTimerSession() {
  return setTimerIdle();
}

export async function getTimerSnapshotForWindow(windowName, now = Date.now()) {
  const session = await loadTimerSession();
  if (session.status !== TIMER_STATUS.IDLE &&
      session.windowName &&
      windowName &&
      session.windowName !== windowName) {
    return buildTimerSnapshot(createIdleSession(), now);
  }
  return buildTimerSnapshot(session, now);
}
