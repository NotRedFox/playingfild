/**
 * Worker integration for wall-clock timer_engine — expiry actions and lifecycle.
 */

import {
  TIMER_EXPIRY_HANDLED_KEY,
  TIMER_MODE,
  TIMER_STATUS,
  buildTimerSnapshot,
  computeElapsedSec,
  computeRemainingSec,
  getTimerSnapshotForWindow,
  isSessionActive,
  isSessionExpired,
  loadTimerSession,
  pauseTimerSession,
  resumeTimerSession,
  saveTimerSession,
  setTimerIdle,
  startTimerSession,
  stopTimerSession
} from './timer_engine.js';

let timerTickInFlight = false;

export async function getWallClockTimerSnapshot(windowName) {
  return getTimerSnapshotForWindow(windowName);
}

export async function syncWindowConfigStudyFlags(session, windowId, windowName) {
  if (!windowId || !windowName) return;
  const stored = await chrome.storage.local.get('windowConfigs');
  const configs = stored.windowConfigs || {};
  const prev = configs[windowName] || {};
  if (session.mode === TIMER_MODE.STUDY && isSessionActive(session)) {
    configs[windowName] = {
      ...prev,
      studyTimerEnabled: true,
      studyLimitSec: session.limitSec,
      studyStartedAt: session.startedAt
    };
  } else if (prev.studyTimerEnabled) {
    configs[windowName] = {
      ...prev,
      studyTimerEnabled: false,
      studyStartedAt: null
    };
  }
  await chrome.storage.local.set({ windowConfigs: configs });
}

export function createWallClockTimerBridge(deps) {
  async function stopTimer({ windowId, windowName, reason = 'cancelled' }) {
    const session = await loadTimerSession();
    const mode = session.mode;
    // Capture what's left of a running break BEFORE the session is stopped.
    // When the stop is because the user started ANOTHER timer ('switched'),
    // that unused time is banked back (deps.bankUnusedBreakTime) instead of
    // silently discarded — per user spec: "the time I had not used should
    // be saved." EXCEPT video-scoped YT-prompt timers: that time was never
    // earned (it's just the video's runtime), so banking it would grant
    // free break credit.
    const unusedBreakSec = (mode === TIMER_MODE.BREAK && isSessionActive(session) &&
        session.videoScoped !== true)
      ? Math.max(0, computeRemainingSec(session))
      : 0;
    await stopTimerSession();

    if (windowId && windowName) {
      if (mode === TIMER_MODE.BREAK) {
        // 'source-dwell-restart' (auto-restart into a focus session) banks
        // the remainder too — mirrors the spend-session dwell path, which
        // refunds unspent time before starting the focus session.
        if ((reason === 'switched' || reason === 'source-dwell-restart') &&
            unusedBreakSec > 0 && deps.bankUnusedBreakTime) {
          try {
            await deps.bankUnusedBreakTime(session.windowName || windowName, unusedBreakSec);
          } catch (e) {
            console.warn('[pf-timer] banking unused break time failed', e);
          }
        }
        await deps.clearBreakBudget(windowName);
        await deps.saveWindowConfig(windowId, {
          unprodLimit: '',
          unprodLimitSec: 0,
          limitsEnabled: false
        });
      } else if (mode === TIMER_MODE.STUDY) {
        // RESTORE the closer toggle to whatever the user had it set to
        // BEFORE the Work Timer started, instead of hard-forcing OFF.
        // The old "flip OFF for clean slate" behavior meant: user turns
        // ON the Unproductive Tab Closer + sets a tab limit + runs Work
        // Timer → session ends → closer silently flips OFF → tab limit
        // stops enforcing → Instagram/YouTube stay open (user report
        // 2026-07: "why tf is my tab limit not working again? its just
        // ignoring instagram like it doesnt exist?"). During study,
        // limitsEnabled is forced ON (see startTimer STUDY branch); this
        // restores the pre-session value so a session doesn't secretly
        // change the user's persistent toggle.
        const studyStored = await chrome.storage.local.get('studyPreviousCloserState');
        const prevMap = { ...(studyStored.studyPreviousCloserState || {}) };
        const hadPrev = Object.prototype.hasOwnProperty.call(prevMap, windowName);
        const restoreCloser = hadPrev ? prevMap[windowName] === true : false;
        if (hadPrev) {
          delete prevMap[windowName];
          await chrome.storage.local.set({ studyPreviousCloserState: prevMap });
        }
        await deps.saveWindowConfig(windowId, {
          studyTimerEnabled: false,
          studyStartedAt: null,
          limitsEnabled: restoreCloser
        });
      }
    }

    await deps.broadcastCloserState();
    return { success: true, reason };
  }

  return {
    async startTimer({ windowId, windowName, mode, limitSec, originalInput, windowConfigUpdates = {} }) {
      const current = await loadTimerSession();
      // Override guard. A different mode always stops the previous session
      // (existing behavior — a study session cancels a running break, and
      // vice versa). Per user spec 2026-07 we ALSO override when a NON-
      // video-scoped BREAK starts while a video-scoped BREAK is running —
      // otherwise the YouTube per-video timer would silently outrank the
      // Suggested-break flow the user just picked.
      const differentMode = isSessionActive(current) && current.mode !== mode;
      const overridingVideoScoped =
        isSessionActive(current) &&
        current.mode === TIMER_MODE.BREAK &&
        current.videoScoped === true &&
        mode === TIMER_MODE.BREAK;
      if (differentMode || overridingVideoScoped) {
        const prevWindowId = await deps.resolveWindowIdFromName(current.windowName);
        await stopTimer({
          windowId: prevWindowId,
          windowName: current.windowName,
          reason: 'switched'
        });
      }

      await startTimerSession({ windowName, mode, limitSec, originalInput });

      // Streak credit now happens on timer COMPLETION (see runTick expiry
      // branch), not on start. Per user report 2026-07: crediting on
      // start rewarded "click Start and abandon it", which isn't what
      // the streak should measure.

      if (mode === TIMER_MODE.BREAK) {
        const closerStored = await chrome.storage.local.get(['windowConfigs', 'breakPreviousCloserState']);
        const prevCloserMap = { ...(closerStored.breakPreviousCloserState || {}) };
        const sessionConfig = closerStored.windowConfigs?.[windowName] || {};
        if (!Object.prototype.hasOwnProperty.call(prevCloserMap, windowName)) {
          prevCloserMap[windowName] = sessionConfig.limitsEnabled === true;
        }
        await chrome.storage.local.set({ breakPreviousCloserState: prevCloserMap });
        await deps.saveWindowConfig(windowId, {
          unprodLimit: originalInput || '',
          unprodLimitSec: limitSec,
          limitsEnabled: false,
          studyTimerEnabled: false,
          studyStartedAt: null,
          ...windowConfigUpdates
        });
      } else {
        // STUDY mode: the closer must be ON so unproductive tabs (YouTube,
        // etc.) get closed during the work session (user report 2026-07 v43:
        // "the Work timer is not shutting unproductive tabs like youtube when
        // its on study mode"). Previously this set limitsEnabled:false (turning
        // the closer OFF), which was backwards — during a break you want
        // unproductive tabs to stay open, but during study you want them gone.
        // BREAK mode (above) correctly sets limitsEnabled:false.
        //
        // Capture the pre-session limitsEnabled value into
        // studyPreviousCloserState so stopTimer can restore it. Without this,
        // running Work Timer silently flipped the user's persistent Closer
        // toggle off at session end (user report 2026-07 v46).
        const priorStored = await chrome.storage.local.get(['windowConfigs', 'studyPreviousCloserState']);
        const priorMap = { ...(priorStored.studyPreviousCloserState || {}) };
        const priorConfig = priorStored.windowConfigs?.[windowName] || {};
        if (!Object.prototype.hasOwnProperty.call(priorMap, windowName)) {
          priorMap[windowName] = priorConfig.limitsEnabled === true;
          await chrome.storage.local.set({ studyPreviousCloserState: priorMap });
        }
        await deps.saveWindowConfig(windowId, {
          studyLimit: originalInput || '',
          studyLimitSec: limitSec,
          studyTimerEnabled: true,
          studyStartedAt: Date.now(),
          unprodLimit: '',
          unprodLimitSec: 0,
          limitsEnabled: true,
          ...windowConfigUpdates
        });
      }

      const session = await loadTimerSession();
      await deps.broadcastCloserState();
      return buildTimerSnapshot(session);
    },

    stopTimer,

    async pauseTimer() {
      const session = await loadTimerSession();
      if (!isSessionActive(session) || session.status === TIMER_STATUS.PAUSED) {
        return buildTimerSnapshot(session);
      }
      const next = await pauseTimerSession(session);
      await deps.broadcastCloserState();
      return buildTimerSnapshot(next);
    },

    async resumeTimer() {
      const session = await loadTimerSession();
      if (session.status !== TIMER_STATUS.PAUSED) {
        return buildTimerSnapshot(session);
      }
      const next = await resumeTimerSession(session);
      if (next.dashboardPause) {
        next.dashboardPause = false;
        await saveTimerSession(next);
      }
      await deps.broadcastCloserState();
      return buildTimerSnapshot(next);
    },

    async runTick() {
      if (timerTickInFlight) return;
      timerTickInFlight = true;
      try {
        let session = await loadTimerSession();
        if (!isSessionActive(session)) return;

        const windowName = session.windowName;
        const windowId = windowName ? await deps.resolveWindowIdFromName(windowName) : null;
        // Just-started grace window: skip ALL auto-pause hooks for the first
        // 3s of a fresh session. Without this, a reminder-triggered break can
        // land in a paused state within 1s of the user clicking Start (e.g.
        // idle detection fires because the user hadn't interacted with the
        // page recently before the popup appeared, or a stale focus/dashboard
        // signal races). The visible symptom is "I click Start but the timer
        // doesn't move until I switch tabs" — the resume only fires on the
        // NEXT user interaction. Per user report 2026-07.
        const JUST_STARTED_MS = 3000;
        const startedAt = Number(session.startedAt) || 0;
        const inGrace = startedAt > 0 && (Date.now() - startedAt) < JUST_STARTED_MS;
        if (!inGrace) {
          if (windowId != null && deps.syncDashboardTimerPause) {
            await deps.syncDashboardTimerPause(windowId);
            session = await loadTimerSession();
          }
          if (windowId != null && deps.syncVideoScopedPause) {
            await deps.syncVideoScopedPause(windowId);
            session = await loadTimerSession();
          }
        }
        // Idle-pause hook: BREAK-mode only (per user spec 2026-07). Runs
        // async in the background — NOT awaited, because it makes cross-
        // process calls (chrome.scripting.executeScript to detect fullscreen
        // video) that can take >200ms and cause the next timer tick to
        // stagger by 2s. The pause takes effect on the following tick if
        // idle is detected, which is fine — 1s latency is imperceptible
        // next to the 2-min idle threshold.
        if (!inGrace && windowId != null && deps.syncIdleTimerPause) {
          deps.syncIdleTimerPause(windowId).catch(() => {});
        }
        // Break → focus auto-restart hook: on a source site for N seconds
        // during a break, cancel the break and start a fresh focus timer.
        // Fire-and-forget for the same reason as the idle hook (avoid
        // stalling the 1s tick on cross-process work).
        if (windowId != null && deps.syncBreakSourceAutoRestart) {
          deps.syncBreakSourceAutoRestart(windowId).catch(() => {});
        }

        if (!isSessionActive(session)) return;

        // Use the DIRECT (non-throttled) broadcast here. runTick fires exactly
        // once per second; routing it through the 900ms coalesce throttle made
        // broadcasts land at drifting offsets from the 1-second boundary,
        // which surfaced as visible countdown stutter (a digit holding ~1.9s
        // then jumping). Fall back to the throttled broadcast if the direct
        // variant isn't wired (older worker).
        if (deps.broadcastCloserStateDirect) {
          await deps.broadcastCloserStateDirect();
        } else {
          await deps.broadcastCloserState();
        }

        // DEADLOCK FIX (user report 2026-07: pill stuck at 0:00, closer
        // toggle "permanently staying on" after a reminder break ran out):
        // break timers auto-pause on idle AND while the dashboard is
        // focused. When a session managed to be BOTH paused and expired
        // (expiry lands the same second as a pause, or the user sits on the
        // dashboard as the break ends), the old paused-return ran BEFORE the
        // expiry handling — so completion/cleanup never executed and the
        // stale "active" session blocked the toggle forever. An EXPIRED
        // session must complete regardless of pause state.
        if (session.status === TIMER_STATUS.PAUSED && !isSessionExpired(session)) return;
        if (!isSessionExpired(session)) return;

        const expiryHandledStored = await chrome.storage.local.get(TIMER_EXPIRY_HANDLED_KEY);
        const expiryHandled = expiryHandledStored[TIMER_EXPIRY_HANDLED_KEY];
        const expiryAlreadyHandled = expiryHandled &&
          expiryHandled.mode === session.mode &&
          expiryHandled.windowName === windowName &&
          expiryHandled.startedAt === session.startedAt;

        const beforeStartedAt = session.startedAt;
        const beforeMode = session.mode;

        // Stale-expiry guard: if the session blew past its limit more than
        // 10 minutes ago (SW was suspended, browser closed, machine asleep),
        // firing the enforcement sweep NOW would nuke tabs / force the closer
        // ON long after the moment the user expected it. Quietly clean up to
        // idle instead — the cleanup block below handles that.
        const STALE_EXPIRY_OVERSHOOT_SEC = 10 * 60;
        const overshootSec = computeElapsedSec(session) - (Number(session.limitSec) || 0);
        const staleExpiry = overshootSec > STALE_EXPIRY_OVERSHOOT_SEC;
        if (staleExpiry && !expiryAlreadyHandled) {
          console.info('[pf-timer-tick] stale expiry — skipping enforcement, cleaning up', {
            mode: session.mode, windowName, overshootSec
          });
        }

        if (!expiryAlreadyHandled && !staleExpiry) {
          if (!state.timerSessionEndedAt) state.timerSessionEndedAt = {};
          state.timerSessionEndedAt[`${session.mode}:${windowName}`] = Date.now();

          await chrome.storage.local.set({
            [TIMER_EXPIRY_HANDLED_KEY]: {
              mode: session.mode,
              windowName,
              startedAt: session.startedAt
            }
          });

          // Streak credit fires on ACTUAL completion, not on start (per
          // user spec 2026-07), and ONLY for DASHBOARD timers (user spec
          // 2026-07 v2): that means STUDY sessions — the Work Timer is the
          // only wall-clock timer the dashboard starts. BREAK sessions all
          // originate from prompts (the unprod REMINDER, YouTube per-video
          // prompts, completion popups) and are the reward phase, not the
          // user "using a timer". The Advanced Earn cycle credits separately
          // on completion in tickBankedTime.
          if (typeof deps.markDailyTimerUsed === 'function'
              && session.videoScoped !== true
              && session.mode === TIMER_MODE.STUDY) {
            deps.markDailyTimerUsed().catch(() => {});
          }

          if (session.mode === TIMER_MODE.BREAK && windowName) {
            await deps.onBreakExpired(windowId, windowName);
          } else if (session.mode === TIMER_MODE.STUDY && windowId && windowName) {
            await deps.onStudyExpired(windowId, windowName, session);
          }
        }

        session = await loadTimerSession();
        const replacedSession = isSessionActive(session) &&
          (session.startedAt !== beforeStartedAt || session.mode !== beforeMode);

        if (replacedSession) {
          await chrome.storage.local.remove(TIMER_EXPIRY_HANDLED_KEY);
        } else {
          await setTimerIdle();
          await syncWindowConfigStudyFlags({ status: TIMER_STATUS.IDLE }, windowId, windowName);
          await chrome.storage.local.remove(TIMER_EXPIRY_HANDLED_KEY);
        }
        await deps.broadcastCloserState();
      } finally {
        timerTickInFlight = false;
      }
    }
  };
}

// state is injected from worker at init
let state = { timerSessionEndedAt: {} };

export function initWallClockTimerBridge(workerState, deps) {
  state = workerState;
  const bridge = createWallClockTimerBridge(deps);

  if (!globalThis.pfWallClockTimerInterval) {
    globalThis.pfWallClockTimerInterval = setInterval(() => {
      bridge.runTick().catch((e) => {
        console.warn('[pf-timer-tick] failed', e);
      });
    }, 1000);
  }

  return bridge;
}

export async function isStudySessionRunning(windowName) {
  const session = await loadTimerSession();
  if (!isSessionActive(session) || session.mode !== TIMER_MODE.STUDY) return false;
  if (!windowName) return false;
  return session.windowName === windowName;
}

export async function isBreakSessionRunning(windowName) {
  const session = await loadTimerSession();
  if (!isSessionActive(session) || session.mode !== TIMER_MODE.BREAK) return false;
  if (!windowName) return false;
  return session.windowName === windowName;
}
