import { pfSignOut, fetchUserChosenDisplayName, saveUserChosenDisplayName, pfClaimStatsForAccount } from './auth.js';
import {
  createElementWithText,
  createParagraph
} from './dom_safe.js';
import {
  initSettingDemos,
  refreshSettingDemoVisibility,
  resetAllSettingDemosForDev,
  setSettingDemoDevForceShow
} from './setting-demos.js';
import {
  normalizeDailySiteLogEntry,
  dailySiteLogTotal,
  STREAK_PRODUCTIVE_GOAL_MIN,
  STREAK_PRODUCTIVE_GOAL_SEC,
  sumProductiveSecondsForDay
} from './daily_site_log_utils.js';
import {
  isExcludedHostname,
  coerceAiExcludedBankSitePattern,
  shouldCoerceAiBankSiteToHostOnly
} from './excluded_hosts.js';
import { MAX_TAB_LIMIT } from './constants.js';
import { tabCountsTowardTabLimitShared } from './tab_limit_urls.js';
import { capture as pfAnalyticsCapture, identify as pfAnalyticsIdentify, optIn as pfAnalyticsOptIn, optOut as pfAnalyticsOptOut } from './analytics.js';
import {
  buildDailyRecap,
  buildWeeklyRecap,
  buildMonthlyRecap,
  buildRecapSlides,
  fmtDur as recapFmtDur,
  heroNumber as recapHeroNumber
} from './recap_engine.js';
import {
  renderRecapPoster,
  animateRecapPoster,
  downloadPoster,
  copyPosterToClipboard,
  openRecapStoryViewer
} from './recap_cards.js';

// Selected share-card format toggle. Sticky across a session (in-memory only —
// deliberately doesn't persist to storage; users pick per share). Default is
// Story (portrait) per user spec 2026-07 v43: "instead of post being already
// selected make story selected". Was 'post' (landscape) because the dashboard
// opens on desktop where landscape is what most people will actually save and
// paste first.
let pfRecapFormat = 'story';

const $ = id => document.getElementById(id);
let currentUser = null, currentStep = 0, posInterval = null, tabLimitConfirmedInTutor = false;
let tutorRafId = null;
let lastTutorRect = null;
let tutorMotionCurrent = null;
let tutorMotionTarget = null;
let tutorMotionFrom = null;
let tutorMotionStartTs = 0;
let tutorMotionDurationMs = 0;
let tutorCountdownTimer = null;
let tutorCountdownRemaining = 0;
let tutorialBorderFollowCleanup = null;
let activeObservers = [];
let isInitialized = false;
let lastRenderedLimEn = false;
// Signature of the last applied closer-toggle lock state, so refreshCloserToggleUI
// can skip re-styling the buttons when nothing changed (avoids flicker from the
// per-second closer-state broadcasts).
let lastToggleLockSignature = null;
let confirmedRankingMode = 'tab';
let s = null;

// Listen for refresh-signin trigger from signup flow
if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === 'pfRefreshSigninStatus') {
      if (typeof refreshAuthFromStorage === 'function') {
        refreshAuthFromStorage()
          .then(async () => {
            await renderOtherWindows();
            await renderOtherComputers();
            if (typeof runTutorial === 'function') {
              runTutorial().catch(() => {});
            }
          })
          .catch(e => console.warn('refresh signin failed:', e));
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.action === 'pfCloserStateUpdate' || msg?.type === 'closerStateUpdate') {
      refreshCloserToggleUI().catch((e) => {
        console.warn('[pf-dashboard] refreshCloserToggleUI failed', e);
      });
    }
  });
}

let tutorialUserClickedProductive = false;
let tutorialStep8SawOn = false;
let tutorialStep9UnlockTimer = null;
let tutorialStep9AutoUnlocked = false;
let tutorialMockHoldTimer = null;
let tutorialRunToken = 0;
const TUTORIAL_COMMIT_TARGET = 'I am fully committed';
let tutorialCommitProgress = 0;
const TUTORIAL_MAIN_STEPS = 16;
/** YouTube video ID for "How to use >=PlayingFild" (https://youtu.be/Wg6d9-Weca8). */
const TUTORIAL_SKIP_YOUTUBE_VIDEO_ID = 'Wg6d9-Weca8';
let tutorialSkipVideoDismissCallback = null;

function streakDayKey(d) {
  const h = d.getHours();
  return (h < 3 ? new Date(d - 86400000) : d).toLocaleDateString();
}

function formatStreakProductiveMinutes(productiveSec) {
  const min = Math.min(STREAK_PRODUCTIVE_GOAL_MIN, Math.floor(Math.max(0, productiveSec) / 60));
  return `${min}/${STREAK_PRODUCTIVE_GOAL_MIN} min productive today`;
}

function refreshStreakDisplay(stored = {}) {
  const streak = stored.currentStreak || 0;
  const todayStr = streakDayKey(new Date());
  const todayLog = (stored.dailyLogs || {})[todayStr] || {};
  let productiveSec = Number(todayLog.productiveSeconds);
  if (!Number.isFinite(productiveSec)) {
    productiveSec = sumProductiveSecondsForDay(todayStr, stored.dailySiteLogs || {});
  }
  // Timer-used counter (per user spec 2026-07): using a study/break timer
  // is now REQUIRED to keep the streak. worker.markDailyTimerUsed flips
  // this flag on every timer start; the streak card surfaces "0/1 timers
  // used today" so the user always sees whether they've hit that half.
  const timerUsed = todayLog.timerUsed === true ? 1 : 0;
  const el = $('streakCount');
  const sub = $('streakSubtext');
  if (el) el.textContent = streak > 0 ? `${streak} day streak` : 'No streak yet';
  if (sub) {
    const productiveMet = productiveSec >= STREAK_PRODUCTIVE_GOAL_SEC;
    const timerMet = timerUsed >= 1;
    const goalMet = productiveMet && timerMet;
    if (goalMet) {
      sub.replaceChildren();
      const wrap = document.createElement('span');
      wrap.className = 'streak-goal-met';
      const icon = document.createElement('span');
      icon.className = 'nb-sketch-icon';
      icon.dataset.icon = 'check';
      icon.setAttribute('aria-hidden', 'true');
      wrap.appendChild(icon);
      wrap.appendChild(document.createTextNode(`Goal met today! (${STREAK_PRODUCTIVE_GOAL_MIN} min productive + timer used)`));
      sub.appendChild(wrap);
    } else {
      const prodLine = formatStreakProductiveMinutes(productiveSec);
      const timerLine = `${timerUsed}/1 timers used today`;
      sub.replaceChildren();
      const line1 = document.createElement('div');
      line1.textContent = prodLine;
      const line2 = document.createElement('div');
      line2.textContent = timerLine;
      line2.style.marginTop = '2px';
      if (timerMet) line2.style.color = '#2d5a2d';
      sub.appendChild(line1);
      sub.appendChild(line2);
    }
  }
}
const TUTORIAL_FIXED_TARGETS = new Set([
  'pf-tutorial-demo-card',
  'pf-tutorial-mock-indicator',
  'pf-tutorial-timer-mock'
]);
const TUTORIAL_WIDE_HIGHLIGHT_TARGETS = new Set([
  'pf-tutorial-mock-indicator',
  'pf-tutorial-timer-mock',
  'nameWrapper',
  'tabLimitWrapper',
  'unprodTimerBlock',
  'studyTimerBlock',
  'rankingModeContainer',
  'rankingModeMain',
  'wipeTabTimesContainer',
  'enforcerToggleRow',
  'themeCarousel',
  'pvuWeekNavWrap'
]);
const TUTORIAL_DEMO_CARD_POS = { position: 'fixed', bottom: '20px', right: '20px', top: 'auto', left: 'auto' };
const TUTORIAL_MOCK_INDICATOR_POS = { position: 'fixed', bottom: '12px', right: '32px', top: 'auto', left: 'auto' };
// Fixed-position mockup cards for steps 7 + 8. Centered horizontally,
// pinned a bit above viewport center so the tutor box below has room.
const TUTORIAL_MOCKUP_CENTER_POS = { position: 'fixed', top: '32%', left: '50%', right: 'auto', bottom: 'auto', transform: 'translate(-50%, 0)', display: 'block' };
// Daily Wrapped demo banner (tutorial step after the PVU graph): the tutor
// box is pinned high-ish for this step (body.tutorial-step-wrapped CSS,
// top 16%), and the banner sits directly beneath it with a clear gap.
const TUTORIAL_WRAPPED_CARD_POS = { position: 'fixed', top: '63%', bottom: 'auto', left: '50%', right: 'auto', transform: 'translateX(-50%)', display: 'block' };
let tutorialRepositionBox = null;
let tutorialSetTutorTarget = null;
// Set to the current step's coord-calculator so the global resize listener
// can snap the tutor box (and its RAF-tracked highlight rect) back into
// position when the user resizes the window mid-step. Cleared on step exit.
let tutorialCalculateTargetCoords = null;
let tutorialResizeListenerBound = false;
let tutorialResizeRafId = 0;
// While > now: ALL tutor-box repositioning is suppressed (theme-swap window
// on step 12 — mid-swap rects produced garbage coords; see selectTheme).
let pfTutorRepositionMuteUntil = 0;

function restoreTutorialDevChrome() {
  ['revertTutorialBtn', 'resetRankingDemoBtn'].forEach((id) => {
    const el = $(id);
    if (el) el.style.display = '';
  });
}

const TUTORIAL_CONTENT_SCALES = new Map([
  [0, '3x'], [1, 'lg'], [2, 'lg'], [3, 'lg'], [4, 'lg'], [5, 'lg'],
  [6, 'lg'], [7, 'lg'], [8, 'lg'], [9, 'lg'], [10, 'lg'], [11, 'lg'], [13, '3x'], [14, '3x']
]);
// Step 6 (idx 5) moved out of BELOW so its tutor box no longer covers the
// HH:MM:SS input at the bottom of the Break/Unprod timer card.
const TUTOR_BELOW_TARGET_STEPS = new Set([5, 6, 7, 9, 10]);
// (2026-07): idx 9 (Work Timer) used to be ABOVE-target, but the card is tall
// and pinned high (top:18%) so the box-above path had no room and overlapped
// the card. Below-target matches its sibling steps (5/6/7/10) and keeps the
// whole card inside the highlight ring with the box sitting under it.
const TUTOR_ABOVE_TARGET_STEPS = new Set([]);
const TUTOR_BESIDE_TARGET_STEPS = new Set([1, 2, 3, 4]);
const TUTOR_BESIDE_TARGET_RIGHT_STEPS = new Set([11]);

const TUTOR_WIDE_BOX_STEPS = new Set([]);
const TUTOR_COMPACT_BOX_STEPS = new Set([1]);
const TUTOR_BESIDE_NAME_STEPS = new Set([2]);
const TUTOR_BESIDE_MEDIUM_STEPS = new Set([3, 4]);
const TUTOR_BESIDE_CENTER_Y_STEPS = new Set([2]);
const TUTOR_BESIDE_ALIGN_TARGET_STEPS = new Set([3, 4]);
const TUTOR_BESIDE_ALIGN_TARGET_Y_OFFSET = -88;
const TUTOR_EXPANDED_BELOW_STEPS = new Set([7, 9, 10]);
const TUTOR_STACK_CENTERED_STEPS = new Set([5, 6, 7, 10]);
const TUTOR_EXPANDED_ABOVE_STEPS = new Set([]);
const TUTOR_BESIDE_RIGHT_EXPANDED_STEPS = new Set([11]);
const TUTOR_FLOATING_BTN_BOX_STEPS = new Set([8]);

function setTutorialContentScale(idx) {
  const box = $('tutorBox');
  if (!box) return;
  box.classList.remove('tutor-content-3x', 'tutor-content-lg', 'tutor-content-md', 'tutor-box-wide', 'tutor-box-compact', 'tutor-box-beside-name', 'tutor-box-beside-medium', 'tutor-box-below-expanded', 'tutor-box-below-compact', 'tutor-box-above-expanded', 'tutor-box-beside-right', 'tutor-box-floating-btn');
  const scale = TUTORIAL_CONTENT_SCALES.get(idx);
  if (scale) box.classList.add(`tutor-content-${scale}`);
  if (TUTOR_WIDE_BOX_STEPS.has(idx)) box.classList.add('tutor-box-wide');
  if (TUTOR_COMPACT_BOX_STEPS.has(idx)) box.classList.add('tutor-box-compact');
  if (TUTOR_BESIDE_NAME_STEPS.has(idx)) box.classList.add('tutor-box-beside-name');
  if (TUTOR_BESIDE_MEDIUM_STEPS.has(idx)) box.classList.add('tutor-box-beside-medium');
  if (TUTOR_EXPANDED_BELOW_STEPS.has(idx)) box.classList.add('tutor-box-below-expanded');
  if (TUTOR_EXPANDED_ABOVE_STEPS.has(idx)) box.classList.add('tutor-box-above-expanded');
  if (TUTOR_BESIDE_RIGHT_EXPANDED_STEPS.has(idx)) box.classList.add('tutor-box-beside-right');
  if (TUTOR_FLOATING_BTN_BOX_STEPS.has(idx)) box.classList.add('tutor-box-floating-btn');
}

function tutorCoordsBesideTargetLeft(tr, boxW, boxH, clampX, clampY, pad, screenW, screenH, gap = 16) {
  const besideLeft = tr.left - boxW - gap;
  const yBeside = clampY(tr.top + Math.max(0, (tr.height - boxH) / 2));
  if (besideLeft >= pad) {
    return { x: clampX(besideLeft), y: yBeside };
  }
  return computeTutorBoxCoordsAvoidingTarget(
    tr, boxW, boxH, screenW, screenH, pad, ['left', 'above', 'below']
  );
}

function tutorCoordsBesideTargetRight(tr, boxW, boxH, clampX, clampY, pad, screenW, screenH, gap = 20) {
  const besideRight = tr.right + gap;
  const yBeside = clampY(tr.top + Math.max(0, (tr.height - boxH) / 2));
  if (besideRight + boxW <= screenW - pad) {
    return { x: clampX(besideRight), y: yBeside };
  }
  return computeTutorBoxCoordsAvoidingTarget(
    tr, boxW, boxH, screenW, screenH, pad, ['right', 'below', 'left']
  );
}

function scrollForTutorBesideTargetRight(targetEl, tutorBox, gap = 20) {
  if (!targetEl || !tutorBox) return;
  // Portal-pinned (fixed) targets don't move with page scroll — skip.
  if (getComputedStyle(targetEl).position === 'fixed') return;
  const topReserve = getTutorialTopReserve();
  const bottomPad = getTutorialBottomPad();
  const { height: boxH } = getTutorBoxLayoutSize(tutorBox);
  const tr = targetEl.getBoundingClientRect();
  let delta = 0;
  const minTargetTop = topReserve + 8;
  if (tr.top - delta < minTargetTop) delta = tr.top - minTargetTop;
  const yBeside = (tr.top - delta) + Math.max(0, (tr.height - boxH) / 2);
  if (yBeside < topReserve) delta += yBeside - topReserve;
  if (yBeside + boxH > window.innerHeight - bottomPad) {
    delta += yBeside + boxH - (window.innerHeight - bottomPad);
  }
  tutorialScrollBy(delta);
}

/**
 * BESIDE-LEFT steps (1–4, incl. "Name your window"): make sure the TARGET
 * itself sits in the visible safe zone — below the tutorial header, above
 * the bottom edge. These steps historically never scrolled at all, so with
 * any restored scroll offset the highlight was drawn off-screen or hidden
 * under the header (user report 2026-07: "sometimes invisible / moved too
 * high"). Scrolls the minimum distance to bring it into view.
 */
function scrollTutorBesideTargetIntoSafeZone(targetEl) {
  if (!targetEl) return;
  const topReserve = getTutorialTopReserve();
  const r = targetEl.getBoundingClientRect();
  if (!r.height) return; // target not laid out yet — nothing to correct
  const viewportH = document.documentElement.clientHeight || window.innerHeight;
  const minTop = topReserve + 20;
  const maxBottom = viewportH - 24;
  let delta = 0;
  if (r.top < minTop) {
    delta = r.top - minTop;
  } else if (r.bottom > maxBottom) {
    // Don't over-correct past the header when the target is very tall.
    delta = Math.min(r.top - minTop, r.bottom - maxBottom);
  }
  if (delta !== 0) tutorialScrollBy(delta);
}

function tutorCoordsBelowTarget(tr, boxW, clampX, clampY, gap = 28) {
  return {
    x: clampX((window.innerWidth - boxW) / 2),
    y: clampY(tr.bottom + gap)
  };
}

function tutorCoordsAboveTarget(tr, boxW, boxH, clampX, clampY, gap = 40) {
  return {
    x: clampX((window.innerWidth - boxW) / 2),
    y: clampY(tr.top - boxH - gap)
  };
}

function scrollForTutorBelowTarget(targetEl, tutorBox, gap = 28, { pinTargetTop = true, targetTopGap = 8 } = {}) {
  if (!targetEl || !tutorBox) return;
  const topReserve = getTutorialTopReserve();
  const bottomPad = getTutorialBottomPad();
  const { height: boxH } = getTutorBoxLayoutSize(tutorBox);
  const minTargetTop = topReserve + targetTopGap;
  const maxTutorBottom = window.innerHeight - bottomPad;

  const tr = targetEl.getBoundingClientRect();
  let delta = 0;
  if (pinTargetTop && tr.top < minTargetTop) {
    delta = tr.top - minTargetTop;
  } else if (!pinTargetTop && tr.top < minTargetTop) {
    delta = tr.top - minTargetTop;
  } else if (!pinTargetTop && tr.bottom < minTargetTop) {
    delta = tr.bottom - minTargetTop - 16;
  } else if (!pinTargetTop && tr.top > maxTutorBottom - boxH - gap) {
    delta = tr.top - minTargetTop;
  }
  const projectedBottom = tr.bottom - delta;
  const tutorBottom = projectedBottom + gap + boxH;
  if (tutorBottom > maxTutorBottom) delta += tutorBottom - maxTutorBottom;
  tutorialScrollBy(delta);
}

function tutorBelowScrollOptions(stepIdx) {
  if (stepIdx === 5) return { pinTargetTop: true, targetTopGap: 44 };
  if (stepIdx === 6) return { pinTargetTop: true, targetTopGap: 36 };
  return {};
}

function stackCenteredLayoutGap(stepIdx) {
  if (stepIdx === 6) return 32;
  if (stepIdx === 7) return 48;  // Closer toggle: larger gap so text box sits lower
  return 28;
}

/** Center highlight + tutor box as one stack; tutor sits directly below the highlight. */
function layoutHighlightStackCentered(targetEl, tutorBox, { gap = 28 } = {}) {
  if (!targetEl || !tutorBox) return null;
  const topReserve = getTutorialTopReserve();
  const bottomPad = getTutorialBottomPad();
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const { width: boxW, height: boxH } = getTutorBoxLayoutSize(tutorBox);
  const { clampX, clampY } = createTutorBoxClamps(boxW, boxH, screenW, screenH, 20);

  // Add explicit padding above the highlight (per user report 2026-07):
  // "give the text box enough space above it not to block the 7/13". The
  // extra 32px keeps the target well below the tutorial progress bar so
  // the tutor box never crowds the "N/M" step counter.
  const availTop = topReserve + 40;
  const availBottom = screenH - bottomPad;
  const availH = Math.max(1, availBottom - availTop);

  const measureTarget = () => {
    const tr = targetEl.getBoundingClientRect();
    return { tr, targetH: Math.max(tr.height, 1) };
  };

  // Force a reflow BEFORE measuring so any display:none collapses (from CSS
  // classes applied this step) are reflected in the first measurement. Without
  // this, the target's position was measured BEFORE the above-elements hid,
  // causing the scroll delta to overshoot and push the highlight off-screen.
  void targetEl.offsetHeight;

  let { tr, targetH } = measureTarget();
  let stackH = targetH + gap + boxH;
  // FIXED (portal-pinned) targets don't move with page scroll — the
  // centering scrolls below would just churn the page under the overlay
  // (and could shove OTHER content around). Their rect is already final:
  // go straight to placing the box below it.
  const targetIsFixed = getComputedStyle(targetEl).position === 'fixed';
  if (!targetIsFixed) {
    // Aim for the CENTER of the target to sit at the vertical center of the
    // available viewport, so the highlight looks visually middle-aligned
    // even when the stack (target + gap + tutor) is shorter than the avail
    // space. Per user report 2026-07: previous math left the target pinned
    // near the top.
    let desiredTargetTop = availTop + Math.max(0, (availH - stackH) / 2);
    const viewportCenterY = availTop + availH / 2;
    const centerAlignedTop = viewportCenterY - (targetH / 2) - (gap + boxH) / 2;
    desiredTargetTop = Math.max(desiredTargetTop, centerAlignedTop - 20);

    tutorialScrollBy(tr.top - desiredTargetTop);

    ({ tr, targetH } = measureTarget());
    stackH = targetH + gap + boxH;
    desiredTargetTop = availTop + Math.max(0, (availH - stackH) / 2);
    if (Math.abs(tr.top - desiredTargetTop) > 6) {
      tutorialScrollBy(tr.top - desiredTargetTop);
      ({ tr } = measureTarget());
    }
  }

  let tutorY = tr.bottom + gap;
  const maxTutorY = availBottom - boxH;
  if (tutorY > maxTutorY) {
    // Stack doesn't fit (short viewports). Recovery order — the box must
    // stay BELOW the highlight AND fully on screen (v2, user report
    // 2026-07: the previous overflow fallback left the box hanging off the
    // bottom on steps 6/7):
    //   1. scroll the page so the target rises (only helps in-flow
    //      targets; the fixed-pinned ones don't move);
    //   2. shrink the gap;
    //   3. CAP THE BOX HEIGHT to the space under the target — the box has
    //      overflow-y:auto, so it scrolls internally instead of covering
    //      the highlight or spilling off-screen.
    const deficit = tutorY - maxTutorY;
    if (!targetIsFixed) {
      // CLAMP (2026-07): never scroll the target's top above the header
      // line — an unclamped deficit scroll shoved the highlight up under
      // the progress bar, so the user saw the box but no highlight.
      const maxScrollUp = Math.max(0, tr.top - availTop);
      tutorialScrollBy(Math.min(deficit, maxScrollUp));
      ({ tr, targetH } = measureTarget());
    }
    tutorY = tr.bottom + Math.min(gap, 12);
    if (tutorY + boxH > availBottom) {
      let room = Math.max(240, availBottom - tutorY - 8);
      // NEVER hide the box's buttons behind an internal scrollbar (user
      // spec 2026-07: "you should not have to scroll the text box to find
      // Next — EVER"). If the space under the target is too tight, SHRINK
      // THE PINNED CARD instead (it scrolls internally) until the box has
      // at least ~300px — enough for title + text + buttons on every step.
      if (targetIsFixed && (availBottom - tutorY - 8) < 300) {
        const give = 300 - Math.max(0, availBottom - tutorY - 8);
        const newMax = Math.max(180, tr.height - give);
        targetEl.style.setProperty('max-height', `${newMax}px`, 'important');
        ({ tr, targetH } = measureTarget());
        tutorY = tr.bottom + Math.min(gap, 12);
        room = Math.max(240, availBottom - tutorY - 8);
      }
      tutorBox.style.maxHeight = `${room}px`;
      return {
        x: clampX((screenW - boxW) / 2),
        y: tutorY // below the target, capped to fit — never over, never off
      };
    }
  }
  // Fits normally — release any height cap a previous cramped layout set.
  tutorBox.style.maxHeight = '';

  return {
    x: clampX((screenW - boxW) / 2),
    y: clampY(tutorY)
  };
}

/** Reposition the tutor box below the highlight without changing page scroll (step 8 checkbox toggles). */
function repositionTutorBelowTargetNoScroll(targetEl, tutorBox, gap = 28) {
  if (!targetEl || !tutorBox) return null;
  const { width: boxW, height: boxH } = getTutorBoxLayoutSize(tutorBox);
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const { clampX, clampY } = createTutorBoxClamps(boxW, boxH, screenW, screenH, 20);
  const tr = targetEl.getBoundingClientRect();
  const availBottom = screenH - getTutorialBottomPad();
  let tutorY = tr.bottom + gap;
  if (tutorY + boxH > availBottom) {
    // No scrolling allowed here — keep the box BELOW the highlight and cap
    // its height to the remaining space (overflow-y:auto scrolls inside)
    // so it neither covers the target nor spills off-screen.
    tutorY = tr.bottom + 12;
    const room = Math.max(240, availBottom - tutorY - 8);
    tutorBox.style.maxHeight = `${room}px`;
    return {
      x: clampX((screenW - boxW) / 2),
      y: tutorY
    };
  }
  tutorBox.style.maxHeight = '';
  return {
    x: clampX((screenW - boxW) / 2),
    y: clampY(tutorY)
  };
}

function scheduleTutorialWipeStepTutorReposition() {
  if (currentStep !== 6) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const target = $('wipeTabTimesContainer');
      const b = $('tutorBox');
      if (!target || !b) return;
      const coords = repositionTutorBelowTargetNoScroll(target, b, 28);
      if (coords && tutorialSetTutorTarget) {
        tutorialSetTutorTarget(coords, { animate: true });
      }
    });
  });
}

function scrollTutorialTargetBelowHeader(targetEl, extraGap = 24) {
  if (!targetEl) return;
  const minTop = getTutorialTopReserve() + extraGap;
  const delta = targetEl.getBoundingClientRect().top - minTop;
  tutorialScrollBy(delta);
}

function scrollForTutorAboveTarget(targetEl, tutorBox, gap = 80) {
  if (!targetEl || !tutorBox) return;
  // Portal-pinned (fixed) targets don't move with page scroll — skip. The
  // scroll used to be the ONLY thing separating box and card, and on a
  // short first-run page it couldn't happen → the box buried the card
  // (user report 2026-07: "step 10 highlight box is still not showing").
  if (getComputedStyle(targetEl).position === 'fixed') return;
  const topReserve = getTutorialTopReserve();
  const bottomPad = getTutorialBottomPad();
  const { height: boxH } = getTutorBoxLayoutSize(tutorBox);
  const desiredTargetTop = topReserve + boxH + gap + 8;
  const tr = targetEl.getBoundingClientRect();
  let delta = tr.top - desiredTargetTop;
  const targetBottomAfter = tr.bottom - delta;
  if (targetBottomAfter > window.innerHeight - bottomPad) {
    delta += targetBottomAfter - (window.innerHeight - bottomPad);
  }
  tutorialScrollBy(delta);
}

// Step 13 (PVU) chart offset: NEGATIVE pulls the chart UP toward the tutor
// box (user spec 2026-07: "move the graph up a bit more, leave the text box
// where it is"). The box is pinned at topReserve independently, so only the
// chart moves. NOTE: margin/padding nudges on #topSitesContent do NOTHING
// here — this scroll math dictates the chart's on-screen position and
// cancels any layout offset. Tune THIS constant, not CSS.
// 2026-07 follow-up: "move the dashboard higher up, leave the text box where
// it is, so you can see the bottom of the dashboard's border" → pulled up a
// further 36px (-34 → -70).
// 2026-07 v3: "move the example graph higher up so there's a bit of black
// space below it" → pulled up another 70px (-70 → -140).
// 2026-07 v4: "step 13 is better but move it up just a little, more so
// there's blank space below the graph" → another 40px (-140 → -180).
// 2026-07 v5: "still not moved up, please move it higher so there's some
// black space below the graph" → another 80px (-180 → -260).
// 2026-07 v6 GEOMETRY CHANGE: the tutor box moved UP to just below the
// "13/16" header (it used to sit much lower — all the negative offsets
// above were tuned against that old position). With the raised box, -260
// dragged the chart up OVER the box to the very top of the screen (user
// report: "major glitch, the graph moves up to the top"). The chart now
// hangs a small gap BELOW the box: desiredTop = topReserve + boxH + 12.
const TUTOR_PVU_CHART_GAP = 12;

function scrollTutorialHighlightBelowHeaderTutor(targetEl, tutorBox, gap = 12) {
  if (!targetEl || !tutorBox) return;
  const topReserve = getTutorialTopReserve();
  const { height: boxH } = getTutorBoxLayoutSize(tutorBox);
  const desiredTargetTop = topReserve + boxH + gap;
  const targetTop = targetEl.getBoundingClientRect().top;
  const delta = targetTop - desiredTargetTop;
  tutorialScrollBy(delta);
}

/**
 * Tab-limit tutorial steps (idx 3 + 4) WATCHDOG. The pinned target
 * (#tabLimitWrapper, fixed mid-screen via body.tutorial-step-tablimit CSS)
 * sometimes never appears on a FIRST install — the highlighted area is
 * simply missing and the user is stuck (report 2026-07, twice). Verify the
 * element is truly visible; when it isn't, log exactly what's wrong (so the
 * next report pins the root cause) and FORCE visibility with inline
 * !important styles that beat any late/missing CSS class application.
 */
function pfEnsureTabLimitStepVisible(target) {
  try {
    const r = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const offscreen = r.bottom < 0 || r.top > window.innerHeight
      || r.right < 0 || r.left > window.innerWidth;
    const collapsed = r.width < 5 || r.height < 5;
    const hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
    const unpinned = cs.position !== 'fixed';
    if (!offscreen && !collapsed && !hidden && !unpinned) return; // healthy
    // Diagnose: report the target state + any hiding ancestor.
    let hiddenAncestor = null;
    for (let el = target.parentElement; el && el !== document.body; el = el.parentElement) {
      const acs = getComputedStyle(el);
      if (acs.display === 'none' || acs.visibility === 'hidden' || Number(acs.opacity) === 0) {
        hiddenAncestor = { id: el.id || null, cls: String(el.className).slice(0, 60), display: acs.display, visibility: acs.visibility, opacity: acs.opacity };
        break;
      }
    }
    console.warn('[pf-tutorial] tab-limit target NOT visible — forcing', {
      rect: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      position: cs.position, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      bodyClasses: { active: document.body.classList.contains('tutorial-active'), tablimit: document.body.classList.contains('tutorial-step-tablimit') },
      hiddenAncestor
    });
    // Re-assert the step classes (a missed toggle is one suspected cause)…
    document.body.classList.add('tutorial-active', 'tutorial-step-tablimit');
    // …then re-run the ONE authoritative pin path. The portal moves the
    // wrapper to <body> (so no ancestor can hide, transform-trap, or
    // stack-context it) and applies pin + ring + internal layout inline.
    // No separate forced-style set here any more — the old duplicate is
    // what left "the lock not centered / in line" (user report 2026-07).
    pfPinTabLimitForTutorial();
  } catch (e) {
    console.warn('[pf-tutorial] tab-limit visibility watchdog failed', e);
  }
}

/**
 * Theme-step watchdog: the carousel must be visible whenever step 12 is
 * active. Covers the exit → extension-update → resume path where the
 * customizations tab never re-activated and the highlight vanished
 * (user report 2026-07). Logs the failure mode before forcing.
 */
function pfEnsureThemeStepVisible(target) {
  try {
    const r = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const hidden = cs.display === 'none' || cs.visibility === 'hidden'
      || r.width < 5 || r.height < 5;
    const offscreen = r.bottom < 0 || r.top > window.innerHeight;
    if (!hidden && !offscreen) return; // healthy
    console.warn('[pf-tutorial] theme carousel NOT visible — forcing', {
      display: cs.display, visibility: cs.visibility,
      rect: { t: Math.round(r.top), h: Math.round(r.height) },
      stepClass: document.body.classList.contains('tutorial-step-theme')
    });
    // Re-activate the customizations tab (the usual culprit on resume)…
    try { switchMainTab('customizations', { force: true }); } catch (_) {}
    // …re-assert the step classes so the fixed-pin CSS applies…
    document.body.classList.add('tutorial-active', 'tutorial-step-theme');
    setTutorialThemeCarouselMode(true);
    // …and force-show as a last resort.
    if (getComputedStyle(target).display === 'none') {
      target.style.setProperty('display', 'flex', 'important');
    }
    target.style.setProperty('visibility', 'visible', 'important');
  } catch (e) {
    console.warn('[pf-tutorial] theme watchdog failed', e);
  }
}

// ── TUTORIAL TARGET PORTAL ENGINE (the deterministic fix, 2026-07) ─────────
// Several steps pin their target fixed mid-screen. Doing that with CSS
// classes kept failing on genuine first installs (missing ring, unpinned or
// fully invisible target — reported for the tab-limit steps AND the ranking
// step): position:fixed silently breaks inside ANY transformed/filtered
// ancestor, hidden ancestors swallow the target whole, and the ring rode on
// the same cascade. So, like the chest layer and the recap modal before it,
// pinned targets are PORTALED to <body> for the duration of their steps,
// with pin + ring applied INLINE. No cascade, no ancestor effects, no
// timing — it always renders.
const PF_TUTOR_RING_SHADOW = '0 0 0 3px rgba(91,75,159,0.30), 0 0 44px rgba(91,75,159,0.45)';

// Per-step pin configs. Values mirror each step's (now bypassed) CSS pin
// rule so the on-screen result is identical to when the cascade worked.
const PF_TUTORIAL_STEP_PINS = {
  3: { id: 'tabLimitWrapper', stepClass: 'tutorial-step-tablimit', styles: {
    position: 'fixed', top: '36%', left: '80%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 12px',
    background: '#fff', 'border-radius': '10px', 'box-shadow': PF_TUTOR_RING_SHADOW,
    'pointer-events': 'auto'
  } },
  5: { id: 'rankingModeMain', stepClass: 'tutorial-step-ranking', styles: {
    // Mirrors body.tutorial-step-ranking #rankingModeMain + the ranking
    // highlight skin (padding/bg/radius) from stats.html.
    position: 'fixed', top: '22%', left: '50%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    width: 'min(520px, 92vw)', 'max-height': '60vh', overflow: 'auto',
    padding: '22px 26px', 'min-height': '148px', background: '#fff',
    'border-radius': '12px', color: '#333', 'box-shadow': PF_TUTOR_RING_SHADOW,
    'pointer-events': 'auto'
  } },
  11: { id: 'themeCarousel', stepClass: 'tutorial-step-theme', styles: {
    // Theme step (2026-07, "now step 12 broken with the same issue"): the
    // LAST step still relying on the CSS-class pin — the exact mechanism
    // that failed on first runs for every other pinned step. Mirrors the
    // body.tutorial-step-theme #themeCarousel rule; display:flex is the
    // carousel's natural layout.
    position: 'fixed', top: '16%', left: '28%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    display: 'flex', 'max-width': '58vw', 'max-height': '70vh',
    overflow: 'auto', 'pointer-events': 'auto'
  } },
  10: { id: 'unprodReminderDropdown', stepClass: 'tutorial-step-study', styles: {
    // Reminders step (2026-07, "step 11 super broken, going step by step"):
    // the LAST scroll-based stack step. Its tall card made every settle
    // pass re-scroll visibly and squeezed the tutor box until Next hid
    // below a scrollbar. Pinned like its siblings: card scrolls INSIDE
    // 44vh, box sits below with guaranteed room.
    position: 'fixed', top: '14%', left: '50%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    width: 'min(720px, 94vw)', 'max-height': '44vh', overflow: 'auto',
    padding: '14px 18px', background: '#fff', 'border-radius': '12px',
    color: '#333', 'box-shadow': PF_TUTOR_RING_SHADOW, 'pointer-events': 'auto'
  } },
  9: { id: 'studyBreakBlock', stepClass: 'tutorial-step-work', styles: {
    // Work-Timer step (2026-07, "step 10 highlight not showing"): the step
    // relied on scrolling the card DOWN below the tutor box, but a short
    // first-run page can't scroll — the box landed ON the card and buried
    // it. Pin the card mid-low; the box sits above the fixed rect.
    // 56% + 780px (2026-07 screenshot fix): at 46%/640px the tutor box above
    // had too little room (its buttons clipped) and the card's own Start
    // row was cut at the sides.
    //
    // FULL-CARD FIX (user report 2026-07: "the work timer end part
    // highlighted part is a bit cut off" + "the text box is in front of the
    // highlighted box" + "the break available gets cut off a bit in the
    // highlighted area"): the ring is the card's own box-shadow, so it only
    // frames the visible box. The card is BELOW-target (box sits under it),
    // so pin it HIGH and give it enough max-height that the WHOLE card —
    // including the Break-available pill at the bottom of the controls row —
    // renders inside the ring. overflow:auto stays as a floor for very short
    // viewports, but 70vh comfortably fits the header + description + the
    // controls row + status on normal screens so nothing is clipped.
    //
    // WIDTH BUMP (user report 2026-07 v43: "the break available seems to be
    // just cut off a little bit — make the highlighted box a bit bigger on
    // the right so it fits"). The controls row uses white-space:nowrap, so
    // when the card is narrower than the row's natural width (Every [H:MM:SS]
    // on productive tabs, earn [H:MM:SS] break. [Start] [Break available]),
    // the Break-available pill at the end gets clipped at the card's right
    // edge. Widen the card from 820px → 960px (and vw ceiling 94 → 97) and
    // trim horizontal padding 22 → 18 so the full row fits inside the ring
    // without horizontal scroll on normal screens.
    position: 'fixed', top: '14%', left: '50%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    width: 'min(960px, 97vw)', 'max-height': '70vh', overflow: 'auto',
    padding: '18px 18px', background: '#fff', 'border-radius': '12px',
    color: '#333', 'box-shadow': PF_TUTOR_RING_SHADOW, 'pointer-events': 'auto'
  } },
  7: { id: 'enforcerToggleRow', stepClass: 'tutorial-step-closer', styles: {
    // Closer-toggle step (2026-07): was scroll-centered in-flow, and its
    // entry flash kept coming back — pin it like ranking/wipe so there is
    // NO scroll dependency at all. White card + ring, box sits below.
    position: 'fixed', top: '24%', left: '50%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    width: 'min(560px, 92vw)', 'max-height': '52vh', overflow: 'auto',
    padding: '20px 24px', background: '#fff', 'border-radius': '12px',
    color: '#333', 'box-shadow': PF_TUTOR_RING_SHADOW, 'pointer-events': 'auto'
  } },
  6: { id: 'wipeTabTimesContainer', stepClass: 'tutorial-step-wipe', styles: {
    // WHITE CARD look (2026-07 screenshot fix): the intended card styling
    // lived under `#rankingModeContainer #wipeTabTimesContainer.tutor-…`
    // ancestor selectors, which the portal severs — so the pin must carry
    // the card look itself. Values copied 1:1 from that rule.
    position: 'fixed', top: '22%', left: '50%', right: 'auto', bottom: 'auto',
    margin: '0', transform: 'translateX(-50%)', 'z-index': '10005',
    width: 'min(520px, 92vw)', 'max-height': '60vh', overflow: 'auto',
    padding: '20px 22px 18px', background: '#fff', 'border-radius': '12px',
    color: '#333', border: '1px solid rgba(0, 0, 0, 0.1)', 'min-height': '84px',
    'box-shadow': '0 0 0 3px rgba(255,255,255,0.6), 0 0 0 10px rgba(91,75,159,0.30), 0 0 30px rgba(91,75,159,0.45)',
    'pointer-events': 'auto'
  } }
};
PF_TUTORIAL_STEP_PINS[4] = PF_TUTORIAL_STEP_PINS[3]; // both tab-limit steps share one pin

const pfTutorialPortalMap = new Map(); // id → { parent, next, style }

function pfPortalPinTutorialTarget(pin) {
  if (!pin) return;
  const target = $(pin.id);
  if (!target) return;
  if (!pfTutorialPortalMap.has(pin.id)) {
    // Snapshot the ORIGINAL inline style attribute before the pin overwrites
    // shared properties — restoring the attribute wholesale on unpin is the
    // only safe way to hand back the markup's own styling untouched.
    pfTutorialPortalMap.set(pin.id, { parent: target.parentElement, next: target.nextSibling, style: target.getAttribute('style') || '' });
    document.body.appendChild(target);
  }
  // Re-assert the step's body classes (sibling-hiding + step-skin rules key
  // off them; a missed toggle was one suspected first-run failure mode).
  document.body.classList.add('tutorial-active', pin.stepClass);
  const st = target.style;
  for (const [prop, val] of Object.entries(pin.styles)) st.setProperty(prop, val, 'important');
  if (getComputedStyle(target).display === 'none') st.setProperty('display', 'block', 'important');
  st.setProperty('visibility', 'visible', 'important');
  st.setProperty('opacity', '1', 'important');
}

function pfPortalUnpinTutorialTarget(id) {
  const rec = pfTutorialPortalMap.get(id);
  if (!rec) return;
  pfTutorialPortalMap.delete(id);
  const target = $(id);
  if (!target) return;
  // Restore the exact pre-pin inline style attribute (the pin overwrote
  // shared properties — removeProperty would strip the markup's own values).
  target.setAttribute('style', rec.style);
  try {
    if (rec.parent && rec.parent.isConnected) {
      if (rec.next && rec.next.parentNode === rec.parent) rec.parent.insertBefore(target, rec.next);
      else rec.parent.appendChild(target);
    }
  } catch (_) { /* target stays where it is — better than vanishing */ }
}

function pfPortalUnpinAllTutorialTargets(exceptId = null) {
  for (const id of [...pfTutorialPortalMap.keys()]) {
    if (id !== exceptId) pfPortalUnpinTutorialTarget(id);
  }
}

/** Legacy aliases — earlier call sites (watchdog force path, cleanup,
 *  finish/skip, dev reset) all funnel into the portal engine. */
function pfPinTabLimitForTutorial() {
  pfPortalPinTutorialTarget(PF_TUTORIAL_STEP_PINS[3]);
}
function pfUnpinTabLimitAfterTutorial() {
  pfPortalUnpinAllTutorialTargets();
}
function pfClearTabLimitWatchdogStyles() {
  pfPortalUnpinAllTutorialTargets();
}

function refreshTutorialStepScroll() {
  if (Date.now() < pfTutorRepositionMuteUntil) return; // theme-swap window
  const idx = currentStep;
  const target = steps[idx]?.target ? $(steps[idx].target) : null;
  const b = $('tutorBox');
  if (idx === 12 && target && b) {
    scrollTutorialHighlightBelowHeaderTutor(target, b, TUTOR_PVU_CHART_GAP);
    return;
  }
  if (TUTOR_ABOVE_TARGET_STEPS.has(idx) && target && b) {
    scrollForTutorAboveTarget(target, b);
    return;
  }
  if (TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx) && target && b) {
    scrollForTutorBesideTargetRight(target, b);
    return;
  }
  if (TUTOR_STACK_CENTERED_STEPS.has(idx) && target && b) {
    tutorialRepositionBox?.();
    return;
  }
  if (TUTOR_BELOW_TARGET_STEPS.has(idx) && target && b) {
    scrollForTutorBelowTarget(target, b, 28, tutorBelowScrollOptions(idx));
  }
}

function getTutorialTopReserve() {
  const header = $('tutorialHeader');
  if (!header || header.style.display === 'none') return 72;
  const rect = header.getBoundingClientRect();
  if (!rect.height) return 72;
  return Math.ceil(rect.bottom + 14);
}

function getTutorialBottomPad() {
  return 20;
}

function runTutorialPageScroll(run) {
  const scrollRoot = document.scrollingElement || document.documentElement;
  const prevBodyOverflow = document.body.style.overflow;
  const prevHtmlOverflow = document.documentElement.style.overflow;
  document.body.style.overflow = 'visible';
  document.documentElement.style.overflow = 'auto';
  try {
    run(scrollRoot);
  } finally {
    document.body.style.overflow = prevBodyOverflow;
    document.documentElement.style.overflow = prevHtmlOverflow;
  }
}

function tutorialScrollBy(delta) {
  if (Math.abs(delta) <= 2) return;
  runTutorialPageScroll((scrollRoot) => {
    scrollRoot.scrollTop += delta;
    window.scrollBy(0, delta);
  });
}

function scrollTutorialTargetIntoView(targetEl, { block = 'center', inline = 'nearest' } = {}) {
  if (!targetEl) return;
  runTutorialPageScroll(() => {
    targetEl.scrollIntoView({ behavior: 'auto', block, inline });
  });
}

function createTutorBoxClamps(boxW, boxH, screenW, screenH, pad = 20) {
  const topReserve = getTutorialTopReserve();
  const bottomPad = getTutorialBottomPad();
  const clampX = (value) => Math.min(Math.max(value, pad), Math.max(pad, screenW - boxW - pad));
  const clampY = (value) => Math.min(
    Math.max(value, topReserve),
    Math.max(topReserve, screenH - boxH - bottomPad)
  );
  return { clampX, clampY, topReserve, bottomPad };
}

function centerTutorBoxY(boxH, screenH = window.innerHeight) {
  const topReserve = getTutorialTopReserve();
  const bottomPad = getTutorialBottomPad();
  const availableH = Math.max(0, screenH - topReserve - bottomPad);
  if (boxH >= availableH - 4) return topReserve;
  return topReserve + Math.max(0, (availableH - boxH) / 2);
}

function getTutorBoxLayoutSize(box) {
  if (!box) return { width: 480, height: 320 };
  const rect = box.getBoundingClientRect();
  const styles = window.getComputedStyle(box);
  const maxHeightRaw = styles.maxHeight;
  const maxHeight = maxHeightRaw && maxHeightRaw !== 'none' ? parseFloat(maxHeightRaw) : Infinity;
  const width = Math.ceil(rect.width || box.offsetWidth || 480);
  let height = Math.ceil(rect.height || box.offsetHeight || 320);
  if (Number.isFinite(maxHeight) && maxHeight > 0) height = Math.min(height, maxHeight);
  const viewportCap = window.innerHeight - getTutorialTopReserve() - getTutorialBottomPad();
  height = Math.min(height, Math.max(140, viewportCap));
  return { width, height };
}

function centerTutorBox() {
  requestAnimationFrame(() => {
    const b = $('tutorBox');
    if (!b) return;
    const { width: boxW, height: boxH } = getTutorBoxLayoutSize(b);
    const y = centerTutorBoxY(boxH);
    b.style.transform = `translate3d(${(window.innerWidth - boxW) / 2}px, ${y}px, 0)`;
  });
}

function computeTutorBoxCoordsAvoidingTarget(tr, boxW, boxH, screenW, screenH, pad = 20, placementOrder = ['above', 'below', 'left', 'right']) {
  const { clampX, clampY, topReserve } = createTutorBoxClamps(boxW, boxH, screenW, screenH, pad);
  const gap = 20;
  const overlaps = (x, y) => (
    x + boxW > tr.left - 8
    && x < tr.right + 8
    && y + boxH > tr.top - 8
    && y < tr.bottom + 8
  );
  const candidates = {
    above: { x: (screenW - boxW) / 2, y: tr.top - boxH - gap },
    below: { x: (screenW - boxW) / 2, y: tr.bottom + gap },
    left: { x: tr.left - boxW - gap, y: tr.top + (tr.height - boxH) / 2 },
    right: { x: tr.right + gap, y: tr.top + (tr.height - boxH) / 2 }
  };
  const pickCoords = (raw) => {
    if (!raw) return null;
    const x = clampX(raw.x);
    const y = clampY(raw.y);
    return overlaps(x, y) ? null : { x, y };
  };
  for (const key of placementOrder) {
    const picked = pickCoords(candidates[key]);
    if (picked) return picked;
  }
  const fallbacks = [
    { x: (screenW - boxW) / 2, y: tr.top - boxH - gap },
    { x: (screenW - boxW) / 2, y: tr.bottom + gap },
    { x: tr.left - boxW - gap, y: tr.top + (tr.height - boxH) / 2 },
    { x: tr.right + gap, y: tr.top + (tr.height - boxH) / 2 }
  ];
  for (const raw of fallbacks) {
    const picked = pickCoords(raw);
    if (picked) return picked;
  }
  const aboveY = tr.top - boxH - gap;
  if (aboveY >= topReserve) {
    return { x: clampX((screenW - boxW) / 2), y: aboveY };
  }
  return { x: clampX((screenW - boxW) / 2), y: clampY(tr.bottom + gap) };
}
const TUTOR_BOX_GLIDE_MS = 300;
const TUTOR_BOX_GLIDE_EASING = 'ease-out';
let tutorialTabLimitLocked = false;
let tutorialTabLimitReadyForConfirm = false;
let tutorialTabLimitUserEdited = false;
let tutorialTabLimitUnlockSeen = false;
let tutorialTabLimitRelockSeen = false;
let tutorialTimerMockDemoInterval = null;
let tutorialMockStage = 1;
let tutorialMockIsOn = false;
let tutorialStep9SawOn = false;
// Once the user clicks the mock button on step 10 (idx 9), the purple
// pulse should stay gone through EVERY subsequent stage — including the
// timer-mock swap in stage 3. applyTutorialFloatingButtonHighlight
// respects this flag when it re-attaches the glow class.
let tutorialStep9BtnPulseStopped = false;
let tutorialMockStageTimer = null;
let renderedTabLimit = 5;
let tutorialTabLimitConfirmClicked = false;
let postSigninMode = null;

const postSigninPinStep = {
  title: 'Pin the extension',
  unlock: 'always'
};

const postSigninDataModeStep = {
  title: 'Classification model',
  unlock: 'always'
};

const postSigninStep = {
  title: 'Stick with it',
  text: "This extension might feel annoying at first. After using it for a day or two, you'll start feeling like you have more mental bandwidth than you used to.",
  target: null,
  unlock: 'finish'
};

const TUTORIAL_NOTEBOOK_SELECTED_TEXT = 'You can change and see the full themes once you finish the tutorial.';

const steps = [
  {
    title: 'Quick tutorial',
    text: 'This is a quick tutorial, about 5/10 minutes. The time you invest in this extension will save you time and mental bandwidth. But it only works if you actually want to commit to using it fully.',
    target: null,
    tab: 'window',
    unlock: 'always',
    boxSize: 'large'
  },
  {
    title: 'Feedback cards',
    text: "A small card like this will sometimes appear at the bottom right of pages. Try clicking 'Yes' on the example to the right.",
    target: 'pf-tutorial-demo-card',
    tab: 'window',
    unlock: 'productive-click',
    boxPosition: 'bottom-right',
    showDemoCard: true
  },
  {
    title: 'Name your window',
    text: 'Give this window a name. This helps when using multiple Chrome windows with different rules.',
    target: 'nameWrapper',
    tab: 'window',
    unlock: 'name-save',
    /* Silently skipped — user requested removal (2026-07). We keep the
       entry in the array so every hard-coded step index elsewhere in
       stats.js stays valid (idx 3 → Tab limit, idx 4 → Tab limit
       confirm, etc.). setActiveTutorialStep detects `skip: true` and
       auto-advances past it in both directions. */
    skip: true
  },
  {
    title: 'Tab limit',
    // Tab Limit was moved to the far right of the header row (opposite the
    // streak). Anchor the tutor box on the LEFT so it doesn't clip the right
    // edge of the viewport.
    text: 'This is your tab limit: <b>how many tabs can stay open at once before older ones get auto-closed</b>. Set a number that feels comfortable. Press the lock to unlock the Confirm button in the next step.',
    target: 'tabLimitWrapper',
    tab: 'window',
    unlock: 'tab-limit-lock-cycle',
    boxPosition: 'left'
  },
  {
    title: 'Apply your limit',
    text: 'Time to rip off the bandaid. Once you click Confirm, <b>all but your first [N] tabs (the ones you have open right now) will be closed.</b> This might be stressful but you can reopen them later if you need.',
    target: 'tabLimitWrapper',
    tab: 'window',
    unlock: 'tab-limit-apply',
    highlightGreenConfirm: true,
    boxPosition: 'left'
  },
  // 2026-07 user reorder: Work Timer now runs AFTER Floating button, so the
  // ranking / reset / closer / mock-indicator flow reads first and the timer
  // sits alongside the Reminders step it pairs with. Old order (index 5→9):
  // Work Timer → Ranking → Reset → Closer → Floating.
  // New order            (index 5→9):
  // Ranking → Reset → Closer → Floating → Work Timer.
  {
    title: 'Tab ranking',
    // Targets the REAL #rankingModeMain — during this step CSS pins it to
    // the middle of the viewport (body.tutorial-step-ranking rules), so
    // the user sees the exact live control and their radio choice
    // persists to the real setting. No fake mockup HTML.
    text: 'Tabs in this window are ordered by how much you use them. Tabs you spend time on move left, and tabs you ignore move right and close first when you hit your limit.',
    target: 'rankingModeMain',
    tab: 'window',
    unlock: 'always'
  },
  {
    title: 'Reset Tab Ranking Scores',
    // Real #wipeTabTimesContainer pinned to viewport center (see body
    // .tutorial-step-wipe CSS). Gate the Next button on the user
    // actually flipping the Reset Tab Ranking Scores checkbox on — per
    // user spec 2026-07 the step should require the interaction.
    text: 'Reset Tab Ranking Scores clears those scores on a schedule so one tab does not stay at the top forever. Turn it on now to continue.',
    target: 'wipeTabTimesContainer',
    tab: 'window',
    unlock: 'wipe-tab-times-setup'
  },
  {
    title: 'Closer toggle',
    text: 'This is the toggle for closing unproductive tabs. Turn it on if you want unproductive tabs to be closed. Leave it off if you want them to stay open.',
    target: 'enforcerToggleRow',
    tab: 'window',
    unlock: 'closer-toggle-cycle'
  },
  {
    title: 'Floating button',
    text: "The floating button on the bottom right of any page also controls this toggle. Try turning it on by holding it for 2 seconds.",
    target: 'pf-tutorial-mock-indicator',
    tab: 'window',
    unlock: 'mock-stage-flow',
    showMockIndicator: true,
    boxPosition: 'bottom-right'
  },
  {
    // Retargeted 2026-07: the standalone Break/Unproductive timer card was
    // removed from the dashboard — Study Break (now directly below the
    // closer) is the break feature users interact with. Moved here (was
    // index 5) to run after the tab-management steps (user spec 2026-07).
    title: 'Work Timer',
    text: 'This is the Work Timer. Earn break time while you focus on productive tabs, then spend it on unproductive tabs when you need a breather. Your break timer shows on the floating button.',
    target: 'studyBreakBlock',
    tab: 'window',
    unlock: 'always'
  },
  {
    // Retargeted 2026-07: the standalone Work/Study timer card was removed —
    // the Reminders panel (attached to Study Break) is the visible feature
    // in that spot now.
    title: 'Reminders',
    text: 'Set a reminder for when you\'ve been on unproductive tabs too long, and choose whether YouTube asks if you want a per-video timer on long videos.',
    target: 'unprodReminderDropdown',
    tab: 'window',
    unlock: 'always'
  },
  {
    // Title carries the question directly (user spec 2026-07 v4) — the
    // body is now just a soft reassurance that they can swap themes.
    // Unlock requires a theme selection (user spec 2026-07 v6) — either
    // Notebook (Student) or Tutorial Background (Professional) counts.
    title: 'Are you a student or professional?',
    text: "Pick a theme, you can change it any time.",
    target: 'themeCarousel',
    tab: 'customizations',
    unlock: 'customizations-theme'
  },
  {
    title: 'Weekly productivity',
    text: 'This is what your stats could look like in a few days. Hover a chart bar to see the daily breakdown appear beside it.',
    target: 'pvuWeekNavWrap',
    tab: 'stats',
    unlock: 'always'
  },
  {
    // Inserted 2026-07 (user spec): right after the PVU-graph step, show off
    // the Daily Wrapped with a real example card (rendered by the actual
    // poster renderer from synthetic demo data — see
    // ensureTutorialWrappedCard). All step machinery below uses
    // unlock-type / steps.length lookups, so the insert is index-safe.
    title: 'Daily Wrapped',
    // Plain text only — <b> spans render in the notebook theme's cursive
    // accent font, which looked out of place here (user spec 2026-07).
    text: 'Every morning a banner like this appears above your chart: your Daily Wrapped. Click the banner below to open an example and see the crate reveal. Weekly and monthly editions go even deeper.',
    target: null,
    tab: 'stats',
    unlock: 'wrapped-opened',
    showWrappedCard: true
  },
  {
    title: 'Final commitment',
    text: 'Before signing in, type the commitment phrase below to continue.',
    target: null,
    tab: 'window',
    unlock: 'commit-typing'
  },
  {
    title: 'Sign in',
    text: "This extension can't force you to be more productive. It gives you the tools to stop spiraling, in a way no other extension can.\n\nSign in to begin.",
    target: null,
    tab: 'window',
    unlock: 'signin',
    boxSize: 'large'
  }
];

function playTutorialIrisReveal() {
  return new Promise((resolve) => {
    const overlay = $('tutorialOverlay');
    const path = $('irisPath');
    if (!overlay || !path) {
      resolve();
      return;
    }

    overlay.classList.add('active', 'revealed');
    overlay.style.clipPath = 'url(#irisClip)';
    overlay.style.webkitClipPath = 'url(#irisClip)';

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const maxRadius = Math.sqrt(screenW * screenW + screenH * screenH) / 2;
    const cx = screenW / 2;
    const cy = screenH / 2;
    const duration = 2150;

    const solveBezier = (p1x, p1y, p2x, p2y, t) => {
      const cx1 = 3 * p1x;
      const bx1 = 3 * (p2x - p1x) - cx1;
      const ax1 = 1 - cx1 - bx1;
      const cy1 = 3 * p1y;
      const by1 = 3 * (p2y - p1y) - cy1;
      const ay1 = 1 - cy1 - by1;
      const sampleCurveX = (x) => ((ax1 * x + bx1) * x + cx1) * x;
      const sampleCurveY = (x) => ((ay1 * x + by1) * x + cy1) * x;
      let x = t;
      for (let i = 0; i < 8; i += 1) {
        const dx = sampleCurveX(x) - t;
        if (Math.abs(dx) < 1e-6) break;
        x -= dx / (3 * ax1 * x * x + 2 * bx1 * x + cx1);
      }
      return sampleCurveY(x);
    };

    const start = performance.now();
    const animate = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const t = (() => {
        if (progress === 0) return 0;
        if (progress === 1) return 1;
        if (progress < 0.34) {
          const t1 = progress / 0.34;
          return solveBezier(0.48, 0.08, 0.28, 1, t1) * 0.38;
        }
        if (progress < 0.80) {
          const t2 = (progress - 0.34) / 0.46;
          return 0.38 + solveBezier(0.88, -0.05, 0.15, 1, t2) * 0.57;
        }
        const t3 = (progress - 0.80) / 0.20;
        return 0.95 + t3 * 0.05;
      })();
      const r = t * maxRadius;
      path.setAttribute(
        'd',
        `M 0 0 H ${screenW} V ${screenH} H 0 Z M ${cx} ${cy} m -${r} 0 a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 -${r * 2} 0`
      );
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        overlay.style.clipPath = '';
        overlay.style.webkitClipPath = '';
        overlay.classList.remove('active', 'revealed');
        resolve();
      }
    };

    requestAnimationFrame(animate);
  });
}

async function getTutorialStorageFlags() {
  return chrome.storage.local.get([
    'tutorialUserClickedProductive',
    'tutorialNameConfirmed',
    'tutorialTabLimitConfirmed',
    'tutorialTabLimitApplied',
    'tutorialCloserToggleCycleDone',
    'tutorialCustomizationsOpened',
    'tutorialSelectedNotebook',
    'tutorialMockToggled',
    'tutorialWipeTabTimesConfigured',
    'tutorialReachedStep14',
    'tutorialCommitTyped',
    'tutorialWrappedOpened',
    'tutorialSelectedProfessional'
  ]);
}

async function isTutorialCompleted() {
  const d = await chrome.storage.local.get(['tutorialCompleted', 'tutorialComplete']);
  return d.tutorialCompleted === true || d.tutorialComplete === true;
}

async function isOnboardingIncomplete() {
  return !(await isTutorialCompleted());
}

async function shouldBlockTutorialTimerStart(mode = 'unprod') {
  if (await isTutorialCompleted()) return false;
  if (postSigninMode) return false;
  const session = await chrome.storage.session.get('tutorialActive');
  if (session.tutorialActive !== true) return false;
  if (mode === 'unprod' && currentStep === 9) return false;
  if (mode === 'study' && currentStep === 10) return false;
  return true;
}

function showTutorialTimerStartBlockedNote() {
  const note = $('tutorProgressNote');
  if (!note || !document.body.classList.contains('tutorial-active')) return;
  note.style.display = 'block';
  note.innerText = 'Timer Start unlocks on the Break and Work/Study timer tutorial steps.';
}

function ensureTutorialTimerPreset(hiddenId, fallbackSec) {
  const sec = parseTimeToSeconds(readTimerHmsString(hiddenId));
  if (sec >= 1) return;
  writeTimerHmsFromSeconds(hiddenId, fallbackSec);
  syncTimerHiddenFromHms(hiddenId);
}

async function isTutorialSessionActive() {
  const { tutorialActive } = await chrome.storage.session.get('tutorialActive');
  return tutorialActive === true;
}

// Timestamp when the PVU step (step 13) was activated. Used to suppress hover
// for the first 2 seconds so the user can read the intro text before the
// breakdown panel pops up (user spec 2026-07 v43: "make it so that the hover
// doesn't work for like 3 seconds"; v53 shortened 3s → 2s).
let pfPvuStepActivatedAt = 0;
const PF_PVU_HOVER_DELAY_MS = 2000;

function tutorialBlocksPvuHover() {
  if (!document.body.classList.contains('tutorial-active')) return false;
  if (!document.body.classList.contains('tutorial-step-pvu')) return true;
  // On the PVU step, block hover for the first 2 seconds after step entry.
  if (pfPvuStepActivatedAt > 0 && Date.now() - pfPvuStepActivatedAt < PF_PVU_HOVER_DELAY_MS) {
    return true;
  }
  return false;
}

async function registerTutorialDashboardTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (!tab?.id) return;
    await chrome.runtime.sendMessage({
      action: 'registerTutorialDashboardTab',
      tabId: tab.id,
      windowId: tab.windowId
    });
  } catch (_) {
    // Background may be unavailable during tests.
  }
}

function clearTutorialTutorFontOverrides() {
  document.body.classList.remove('tutorial-notebook-font', 'tutorial-customizations-open', 'tutorial-late-steps');
  ['tutorTitle', 'tutorText', 'tutorProgressNote'].forEach((id) => {
    $(id)?.classList.remove('tutor-readable-text');
  });
}

/** Match tutor overlay typography to the active theme (customisations step onward). */
function syncTutorialTutorFontFromTheme(themeId, stepIdx = currentStep) {
  // User spec 2026-07 v24: defer the notebook-font swap on step 12 itself
  // (stepIdx === 11 — the theme-pick step). Applying the swap on step 12
  // caused the tutor text box to visibly jump when the user toggled
  // between notebook and professional themes, because Caveat's metrics
  // differ from system-ui and the box's own height/width changes on the
  // swap. The font now applies from step 13 (stepIdx >= 12) onward, so
  // the tutor box stays put through the whole theme-picking step and
  // only switches typography once the user has moved past it.
  const useNotebookFont = themeId === 'notebook' && stepIdx >= 12;
  document.body.classList.remove('tutorial-customizations-open');
  document.body.classList.toggle('tutorial-notebook-font', useNotebookFont);
  document.body.classList.toggle('tutorial-late-steps', useNotebookFont && stepIdx >= 13);
  ['tutorTitle', 'tutorText', 'tutorProgressNote'].forEach((id) => {
    $(id)?.classList.toggle('tutor-readable-text', useNotebookFont);
  });
}

async function applyTutorialTutorFont(stepIdx) {
  if (stepIdx < 11) {
    clearTutorialTutorFontOverrides();
    return;
  }
  const stored = await chrome.storage.local.get('selectedTheme');
  syncTutorialTutorFontFromTheme(stored.selectedTheme || 'tutorial_background', stepIdx);
}

async function handleTutorialNotebookSelect() {
  if (currentStep !== 11) {
    await selectTheme('notebook');
    return;
  }
  setTutorialNotebookPulse(false);
  await selectTheme('notebook');
  syncTutorialTutorFontFromTheme('notebook', 11);
  const textEl = $('tutorText');
  // Updated per user spec — reassure that theme can be changed later.
  // Added the crate-animation note on a new line below (smaller) so the
  // user knows the Notebook skin includes the wrapped crate animation
  // (user spec 2026-07 v43).
  if (textEl) textEl.innerHTML = 'Great. Click Next to move on. You can change your theme any time.<br><span style="font-size: 0.8em; opacity: 0.75;">Shows crate animation for &gt;=PlayingFild wrapped</span>';
  await chrome.storage.local.set({
    tutorialSelectedNotebook: true,
    tutorialSelectedProfessional: false,
    tutorialCustomizationsOpened: true
  });
  await updateTutorNextState();
}

async function handleTutorialBackgroundSelect() {
  if (isTutorialNotebookBackLocked()) {
    triggerTutorialShake($('tutorBox'));
    return;
  }
  if (currentStep !== 11) {
    await selectTheme('tutorial_background');
    return;
  }
  setTutorialNotebookPulse(false);
  await selectTheme('tutorial_background');
  syncTutorialTutorFontFromTheme('tutorial_background', 11);
  // Confirmation feedback for the "professional" path — same Great/Next
  // pattern used on other early steps. Added the no-animation note on a
  // new line below (smaller) so the user knows the Professional skin does
  // NOT include the crate animation (user spec 2026-07 v43).
  const textEl = $('tutorText');
  if (textEl) textEl.innerHTML = 'Great. Click Next to move on. You can change your theme any time.<br><span style="font-size: 0.8em; opacity: 0.75;">Shows no animation for &gt;=PlayingFild wrapped</span>';
  await chrome.storage.local.set({
    tutorialSelectedNotebook: false,
    tutorialSelectedProfessional: true,
    tutorialCustomizationsOpened: true
  });
  await updateTutorNextState();
  // Make Next unmistakably READY (purple) the instant the default skin is
  // picked (user spec 2026-07) — don't wait on any async flag round-trip.
  {
    const n = $('tutorNext');
    if (n) {
      n.disabled = false;
      n.style.backgroundColor = '#5B4B9F';
      n.style.color = 'white';
      n.style.cursor = 'pointer';
    }
  }
  // Per user spec 2026-07 (correction): do NOT auto-advance. The user
  // should press Next manually. Auto-advancing caused confusion when the
  // user clicked the tutorial background and it jumped to the next step.
}

function showTutorPinExtensionGuide(visible) {
  const el = $('tutorPinExtensionGuide');
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? 'block' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  // The tutor box carries a 300ms transform/opacity transition; when this
  // guide appears the box re-measures and the transition made it slide in
  // from the bottom-left (user report 2026-07). Snap instead: kill the
  // transition for this reposition, restore it two frames later.
  if (visible) {
    const box = $('tutorBox');
    if (box) {
      box.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { box.style.transition = ''; }));
    }
  }
}

function setTutorDataModeReadableFont(enabled) {
  const guide = $('tutorDataModeGuide');
  const title = $('tutorTitle');
  if (guide) guide.classList.toggle('tutor-readable-text', enabled);
  if (title) title.classList.toggle('tutor-readable-text', enabled);
}

function setTutorDataModePanel(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? 'block' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function showTutorDataModeGuide(visible, phase = 'choice') {
  const el = $('tutorDataModeGuide');
  const choice = $('tutorDataModeChoice');
  const noSharing = $('tutorDataModeNoSharing');
  const enterpriseInfo = $('tutorDataModeEnterpriseInfo');
  const warning = $('tutorDataModeLocalWarning');
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? 'block' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  document.body.classList.toggle('tutor-data-mode-active', visible);
  document.body.classList.toggle('tutor-data-mode-no-sharing-phase', visible && phase === 'no-sharing');
  setTutorDataModeReadableFont(false);
  $('tutorTitle')?.classList.remove('tutor-readable-text');
  if (!visible) {
    setTutorDataModeLoading(false);
    setTutorDataModePanel(choice, false);
    setTutorDataModePanel(noSharing, false);
    setTutorDataModePanel(enterpriseInfo, false);
    setTutorDataModePanel(warning, false);
    setTutorDataModeReadableFont(false);
    document.body.classList.remove('tutor-data-mode-active', 'tutor-data-mode-no-sharing-phase');
    $('tutorTitle')?.classList.remove('tutor-readable-text');
    return;
  }
  setTutorDataModePanel(choice, phase === 'choice');
  setTutorDataModePanel(noSharing, phase === 'no-sharing');
  setTutorDataModePanel(enterpriseInfo, phase === 'enterprise-info');
  setTutorDataModePanel(warning, phase === 'local-warning');
}

let tutorDataModeLoading = false;
let tutorDataModeSpinnerPos = { x: 0, y: 0 };
let tutorDataModeSpinnerTrackingBound = false;

function positionTutorDataModeCursorSpinner() {
  const el = $('tutorDataModeCursorSpinner');
  const box = $('tutorBox');
  if (!el || !tutorDataModeLoading) return;
  const size = 26;
  if (box) {
    const rect = box.getBoundingClientRect();
    el.style.left = `${rect.left + rect.width / 2 - size / 2}px`;
    el.style.top = `${rect.top + rect.height / 2 - size / 2}px`;
    return;
  }
  el.style.left = `${tutorDataModeSpinnerPos.x - size / 2}px`;
  el.style.top = `${tutorDataModeSpinnerPos.y - size / 2}px`;
}

function bindTutorDataModeSpinnerTracking() {
  if (tutorDataModeSpinnerTrackingBound) return;
  tutorDataModeSpinnerTrackingBound = true;
  document.addEventListener('mousemove', (e) => {
    if (!tutorDataModeLoading) return;
    tutorDataModeSpinnerPos = { x: e.clientX, y: e.clientY };
    positionTutorDataModeCursorSpinner();
  });
}

function setTutorDataModeLoading(active, clientX, clientY) {
  tutorDataModeLoading = active;
  bindTutorDataModeSpinnerTracking();
  if (typeof clientX === 'number' && typeof clientY === 'number') {
    tutorDataModeSpinnerPos = { x: clientX, y: clientY };
  }
  document.body.classList.toggle('tutor-data-mode-loading', active);
  const spinner = $('tutorDataModeCursorSpinner');
  if (spinner) {
    spinner.hidden = !active;
    spinner.style.display = active ? 'block' : 'none';
    spinner.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (active) positionTutorDataModeCursorSpinner();
  }
  const guide = $('tutorDataModeGuide');
  if (guide) {
    guide.classList.toggle('is-applying', active);
    guide.setAttribute('aria-busy', active ? 'true' : 'false');
    guide.querySelectorAll('button').forEach((btn) => {
      btn.disabled = active;
    });
  }
}

async function completeTutorialDataModeChoice(mode, evt) {
  setTutorDataModeLoading(true, evt?.clientX, evt?.clientY);
  try {
    await applyDataCollectionMode(mode);
    await chrome.storage.local.set({ tutorialDataModeStepDone: true });
    await showPostSigninStep();
  } finally {
    setTutorDataModeLoading(false);
  }
}

function revealDashboardAtTop() {
  switchMainTab('window', { persist: true });
  const scrollTop = () => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  scrollTop();
  requestAnimationFrame(() => {
    scrollTop();
    requestAnimationFrame(scrollTop);
  });
}

function updateTutorialProgressBar(stepIdx) {
  const fill = $('tutorialProgressFill');
  if (!fill) return;
  const pct = Math.max(0, Math.min(100, ((stepIdx + 1) / TUTORIAL_MAIN_STEPS) * 100));
  fill.style.width = `${pct}%`;
}

function applyTutorialFixedPosition(el, pos) {
  if (!el || !pos) return;
  Object.assign(el.style, pos);
}

function setTutorialFixedVisible(el, visible, pos) {
  if (!el) return;
  applyTutorialFixedPosition(el, pos);
  el.style.visibility = visible ? 'visible' : 'hidden';
  el.style.pointerEvents = visible ? 'auto' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function buildTutorialCommitNote(note) {
  note.replaceChildren();
  note.appendChild(document.createTextNode('Type "'));
  const span = document.createElement('span');
  span.id = 'tutorialCommitTarget';
  span.setAttribute('aria-live', 'polite');
  note.appendChild(span);
  note.appendChild(document.createTextNode('". To continue'));
}

function renderTutorialCommitPlaceholder() {
  const note = $('tutorProgressNote');
  const target = $('tutorialCommitTarget');
  if (note && !target) {
    note.style.display = 'block';
    buildTutorialCommitNote(note);
  }
  const liveTarget = $('tutorialCommitTarget');
  if (!liveTarget) return;
  if (liveTarget.childNodes.length !== TUTORIAL_COMMIT_TARGET.length) {
    liveTarget.replaceChildren();
    for (let i = 0; i < TUTORIAL_COMMIT_TARGET.length; i += 1) {
      const ch = TUTORIAL_COMMIT_TARGET[i];
      const span = document.createElement('span');
      span.className = `commit-letter${ch === ' ' ? ' commit-space' : ''}`;
      span.textContent = ch;
      liveTarget.appendChild(span);
    }
  }
  [...liveTarget.childNodes].forEach((node, idx) => {
    if (!(node instanceof HTMLElement)) return;
    node.classList.toggle('lit', idx < tutorialCommitProgress);
  });
}

function ensureCommitNoteStructure() {
  const note = $('tutorProgressNote');
  if (!note) return;
  note.style.display = 'block';
  if (!$('tutorialCommitTarget')) {
    buildTutorialCommitNote(note);
  }
  renderTutorialCommitPlaceholder();
}

function showTutorialCommitProgressNote() {
  ensureCommitNoteStructure();
}

function restoreCommitProgressNoteAfterMessage() {
  if (!isCommitTypingStep(currentStep) || tutorialCommitProgress >= TUTORIAL_COMMIT_TARGET.length) return;
  showTutorialCommitProgressNote();
}

function shakeTutorialCommitPlaceholder() {
  const target = $('tutorialCommitTarget');
  if (!target) return;
  target.classList.remove('shake');
  void target.offsetWidth;
  target.classList.add('shake');
  setTimeout(() => target.classList.remove('shake'), 320);
  // Flash the NEXT expected NON-SPACE letter (per user report 2026-07 —
  // the flash sometimes landed on a space, making it look like it was
  // hitting the adjacent letter; spaces don't count as target chars for
  // the visual hint). Also robustly re-fire the animation on repeated
  // misses by wiping any lingering flash class + clones from previous
  // attempts before adding it back on the current target letter.
  try {
    const letters = target.querySelectorAll('.commit-letter');
    // Clear any leftover flash marks from earlier wrong attempts so the
    // animation restarts cleanly even after many misses.
    letters.forEach((l) => l.classList.remove('commit-letter-miss-flash'));

    let nextIdx = Math.min(letters.length - 1, Math.max(0, tutorialCommitProgress));
    // Skip forward over any spaces so the flash sits on a printable
    // character; user complained the flash on a space read as landing
    // on the letter next to it.
    while (
      nextIdx < letters.length &&
      letters[nextIdx] &&
      letters[nextIdx].classList.contains('commit-space')
    ) {
      nextIdx += 1;
    }
    const nextLetter = letters[nextIdx];
    if (nextLetter) {
      // Force reflow so the animation reliably restarts even if this
      // letter was flashed a moment ago (e.g. multiple rapid misses).
      void nextLetter.offsetWidth;
      nextLetter.classList.add('commit-letter-miss-flash');
      setTimeout(() => nextLetter.classList.remove('commit-letter-miss-flash'), 700);
    }
  } catch (_) { /* best-effort */ }
}

async function resetTutorialCommitGate() {
  tutorialCommitProgress = 0;
  renderTutorialCommitPlaceholder();
  await chrome.storage.local.set({ tutorialCommitTyped: false });
}

function setTutorialCommitUIVisible(visible) {
  const note = $('tutorProgressNote');
  if (!note) return;
  if (!visible) {
    note.style.display = 'none';
    note.innerText = '';
    return;
  }
  showTutorialCommitProgressNote();
}

function clearTutorialHighlight() {
  clearTutorialFloatingButtonHighlight();
  document.querySelectorAll('.tutor-highlight').forEach((el) => el.classList.remove('tutor-highlight'));
  document.querySelectorAll('.tutor-highlight-fixed').forEach((el) => el.classList.remove('tutor-highlight-fixed'));
  document.querySelectorAll('.tutor-highlight-wide').forEach((el) => el.classList.remove('tutor-highlight-wide'));
  document.querySelectorAll('.tutor-highlight-wide-fixed').forEach((el) => el.classList.remove('tutor-highlight-wide-fixed'));
  document.querySelectorAll('.tutor-soft-highlight').forEach((el) => el.classList.remove('tutor-soft-highlight'));
  document.querySelectorAll('.tutor-soft-highlight-fixed').forEach((el) => el.classList.remove('tutor-soft-highlight-fixed'));
  document.querySelectorAll('.tutor-group-member').forEach((el) => el.classList.remove('tutor-group-member'));
  const gh = document.getElementById('tutorGroupHighlight');
  if (gh) gh.style.display = 'none';
  if (tutorialBorderFollowCleanup) {
    tutorialBorderFollowCleanup();
    tutorialBorderFollowCleanup = null;
  }
  activeObservers.forEach((obs) => obs.disconnect());
  activeObservers = [];
  lastTutorRect = null;
}

function cleanupTutorialExtras() {
  // Clear any watchdog force-pin from the tab-limit steps (runs on every
  // step change, so advancing past step 4 releases the wrapper).
  // Mid-tutorial cleanup must NOT unpin the CURRENT step's portaled target
  // (applyTutorialStepEffects re-pins keyed on the NEW idx right after; the
  // gate just avoids a pointless unpin/re-pin churn on pinned-step repeats).
  if (!PF_TUTORIAL_STEP_PINS[currentStep]) pfPortalUnpinAllTutorialTargets();
  setTutorialFixedVisible($('pf-tutorial-demo-card'), false, TUTORIAL_DEMO_CARD_POS);
  setTutorialFixedVisible($('pf-tutorial-mock-indicator'), false, TUTORIAL_MOCK_INDICATOR_POS);
  setTutorialFixedVisible($('pf-tutorial-timer-mock'), false, TUTORIAL_MOCK_INDICATOR_POS);
  setTutorialFixedVisible($('pf-tutorial-wrapped-card'), false, TUTORIAL_WRAPPED_CARD_POS);
  $('confirmTabLimit')?.classList.remove('tutorial-active-green', 'tutorial-pulse');
  setTutorialThemeCarouselMode(false);
  setTutorialNotebookPulse(false);
  $('themeCarousel')?.classList.remove('tutorial-hide-scrollbar');
  $('tutorText')?.classList.remove('tutor-readable-text', 'tutor-pin-no-body');
  $('tutorTitle')?.classList.remove('tutor-readable-text');
  $('tutorProgressNote')?.classList.remove('tutor-readable-text');
  $('tutorBox')?.classList.remove('tutorial-finish-step');
  // Release any cramped-layout height cap from the previous step.
  const tb = $('tutorBox');
  if (tb) tb.style.maxHeight = '';
  document.body.classList.remove('tutorial-finish-step');
  document.body.classList.remove('tutorial-notebook-font', 'tutorial-customizations-open', 'tutorial-late-steps', 'tutorial-step-pvu', 'tutorial-step-wrapped', 'tutorial-step-wipe', 'tutorial-step-ranking', 'tutorial-step-study', 'tutorial-step-work', 'tutorial-step-closer', 'tutorial-step-theme', 'tutorial-step-name', 'tutorial-name-editing', 'tutorial-step-tablimit');
  showTutorPinExtensionGuide(false);
  showTutorDataModeGuide(false);
  setTutorDataModeReadableFont(false);
  document.querySelector('#pf-tutorial-timer-mock .pf-progress-ring')?.classList.remove('rotating-unprod');
  document.querySelector('#pf-tutorial-timer-mock .pf-btn-stack')?.classList.remove('pf-tutorial-btn-glow');
  stopTutorialTimerMockDemo();
  if (tutorialMockStageTimer) {
    clearTimeout(tutorialMockStageTimer);
    tutorialMockStageTimer = null;
  }
  if (tutorialStep9UnlockTimer) {
    clearTimeout(tutorialStep9UnlockTimer);
    tutorialStep9UnlockTimer = null;
  }
  if (tutorialMockHoldTimer) {
    clearTimeout(tutorialMockHoldTimer);
    tutorialMockHoldTimer = null;
  }
  tutorialRepositionBox = null;
  tutorialSetTutorTarget = null;
  tutorialCalculateTargetCoords = null;
  clearTutorialPvuSample();
}

let tutorialPvuSampleActive = false;

function buildTutorialPvuSampleLogs() {
  const dayKeys = getLast7StreakDayKeys(0);
  const dailySiteLogs = {};
  const dailyProductiveEngagement = {};
  const hourlySiteLogs = {};
  // Scaled up per user spec 2026-07 v43: "increase the time on all the days
  // so there's more and make them have different amounts". The daily PVU
  // chart uses a fixed 24-hour y-axis, so values in the 1-2 hour range
  // produced tiny bars. These values (in seconds) translate to ~5-11 hours
  // of total activity per day, giving the bars real presence while staying
  // varied day-to-day. Productive > Unproductive > Neutral pattern kept.
  const dayPatterns = [
    { productive: 25200, unproductive: 7200,  neutral: 3600,  score: 24 },
    { productive: 19800, unproductive: 10800, neutral: 5400,  score: 16 },
    { productive: 30600, unproductive: 5400,  neutral: 2700,  score: 36 },
    { productive: 18000, unproductive: 12600, neutral: 4500,  score: 12 },
    { productive: 23400, unproductive: 9000,  neutral: 6300,  score: 22 },
    { productive: 28800, unproductive: 4500,  neutral: 7200,  score: 32 },
    { productive: 16200, unproductive: 8100,  neutral: 5400,  score: 18 }
  ];
  const productiveHosts = [
    ['docs.google.com', 0.42],
    ['github.com', 0.32],
    ['notion.so', 0.18]
  ];
  const neutralHosts = [
    ['google.com', 0.6],
    ['amazon.com', 0.4]
  ];
  // Per-day fraction variants (user spec 2026-07 v43: "increase the examples'
  // time so they're not all the same exact time but keep the same sites in
  // the same order"). Same sites, same ORDER — only the split shifts day to
  // day so each bar shows different per-site times instead of identical ones
  // across the whole week. Fractions sum to ~1.0 per category per day.
  const productiveFracsByDay = [
    { 'docs.google.com': 0.42, 'github.com': 0.32, 'notion.so': 0.18 },
    { 'docs.google.com': 0.36, 'github.com': 0.40, 'notion.so': 0.16 },
    { 'docs.google.com': 0.48, 'github.com': 0.26, 'notion.so': 0.20 },
    { 'docs.google.com': 0.30, 'github.com': 0.44, 'notion.so': 0.14 },
    { 'docs.google.com': 0.40, 'github.com': 0.34, 'notion.so': 0.18 },
    { 'docs.google.com': 0.46, 'github.com': 0.28, 'notion.so': 0.22 },
    { 'docs.google.com': 0.34, 'github.com': 0.38, 'notion.so': 0.16 }
  ];
  const neutralFracsByDay = [
    { 'google.com': 0.60, 'amazon.com': 0.40 },
    { 'google.com': 0.68, 'amazon.com': 0.32 },
    { 'google.com': 0.55, 'amazon.com': 0.45 },
    { 'google.com': 0.72, 'amazon.com': 0.28 },
    { 'google.com': 0.62, 'amazon.com': 0.38 },
    { 'google.com': 0.58, 'amazon.com': 0.42 },
    { 'google.com': 0.66, 'amazon.com': 0.34 }
  ];
  // Per-day split so YouTube / Reddit show different productive vs unproductive time.
  const mixedHostSplits = [
    { youtube: { prod: 0.08, unprod: 0.42 }, reddit: { prod: 0.05, unprod: 0.38 } },
    { youtube: { prod: 0.11, unprod: 0.36 }, reddit: { prod: 0.07, unprod: 0.41 } },
    { youtube: { prod: 0.06, unprod: 0.48 }, reddit: { prod: 0.04, unprod: 0.32 } },
    { youtube: { prod: 0.09, unprod: 0.28 }, reddit: { prod: 0.06, unprod: 0.45 } },
    { youtube: { prod: 0.10, unprod: 0.34 }, reddit: { prod: 0.08, unprod: 0.36 } },
    { youtube: { prod: 0.07, unprod: 0.40 }, reddit: { prod: 0.05, unprod: 0.33 } },
    { youtube: { prod: 0.12, unprod: 0.30 }, reddit: { prod: 0.09, unprod: 0.39 } }
  ];

  const assignHosts = (hosts, list, totalSec, type) => {
    list.forEach(([host, frac]) => {
      hosts[host] = { [type]: Math.max(60, Math.round(totalSec * frac)) };
    });
  };

  const assignMixedHost = (hosts, host, productiveSec, unproductiveSec) => {
    hosts[host] = {
      Productive: Math.max(60, productiveSec),
      Unproductive: Math.max(60, unproductiveSec)
    };
  };

  dayKeys.forEach((dayKey, i) => {
    const pattern = dayPatterns[i] || dayPatterns[0];
    const split = mixedHostSplits[i] || mixedHostSplits[0];
    const prodFracs = productiveFracsByDay[i] || productiveFracsByDay[0];
    const neutralFracs = neutralFracsByDay[i] || neutralFracsByDay[0];
    dailyProductiveEngagement[dayKey] = pattern.score;
    const hosts = {};
    // Apply per-day fractions (same sites, same order — only the split
    // varies) by mapping the host list through today's fraction table.
    assignHosts(hosts, productiveHosts.map(([h]) => [h, prodFracs[h] || 0]), pattern.productive, 'Productive');
    assignHosts(hosts, neutralHosts.map(([h]) => [h, neutralFracs[h] || 0]), pattern.neutral, 'Neutral');
    assignMixedHost(
      hosts,
      'youtube.com',
      Math.round(pattern.productive * split.youtube.prod),
      Math.round(pattern.unproductive * split.youtube.unprod)
    );
    assignMixedHost(
      hosts,
      'reddit.com',
      Math.round(pattern.productive * split.reddit.prod),
      Math.round(pattern.unproductive * split.reddit.unprod)
    );
    dailySiteLogs[dayKey] = hosts;

    hourlySiteLogs[dayKey] = {};
    for (let hour = 9; hour <= 17; hour += 1) {
      const factor = hour === 12 ? 0.55 : 1;
      const hourProdBase = (pattern.productive / 8) * factor;
      const hourUnprodBase = (pattern.unproductive / 8) * factor;
      const prod = Math.round(hourProdBase * 0.62);
      const unprod = Math.round(hourUnprodBase * 0.24);
      const neutral = Math.round((pattern.neutral / 8) * factor * 0.14);
      hourlySiteLogs[dayKey][hour] = {
        Productive: prod,
        Unproductive: unprod,
        Neutral: neutral,
        hosts: {
          'docs.google.com': { Productive: Math.round(prod * 0.42) },
          'github.com': { Productive: Math.round(prod * 0.38) },
          'youtube.com': {
            Productive: Math.max(15, Math.round(hourProdBase * split.youtube.prod)),
            Unproductive: Math.max(20, Math.round(hourUnprodBase * split.youtube.unprod))
          },
          'reddit.com': {
            Productive: Math.max(10, Math.round(hourProdBase * split.reddit.prod)),
            Unproductive: Math.max(18, Math.round(hourUnprodBase * split.reddit.unprod))
          }
        }
      };
    }
  });

  return {
    dailySiteLogs,
    hourlySiteLogs,
    hourlyProductiveLogs: {},
    dailyProductiveEngagement,
    hourlyProductiveEngagement: {}
  };
}

function activateTutorialPvuSample() {
  tutorialPvuSampleActive = true;
  pvuWeekOffset = 0;
  pvuFollowLiveWeek = false;
  pvuFollowLiveDay = false;
  pvuBreakdownPinned = false;
  pvuBreakdownPinnedDayKey = null;
  pvuHourBreakdownPinned = false;
  pvuHourBreakdownPinnedHour = null;
  pvuSelectedDayKey = null;
}

function clearTutorialPvuSample() {
  if (!tutorialPvuSampleActive) return;
  tutorialPvuSampleActive = false;
  pvuFollowLiveWeek = true;
  pvuFollowLiveDay = true;
  pvuBreakdownPinned = false;
  pvuBreakdownPinnedDayKey = null;
  pvuHourBreakdownPinned = false;
  pvuHourBreakdownPinnedHour = null;
  pvuSelectedDayKey = null;
}

function setTutorialTimerFieldsLocked(locked, blockIds = null) {
  const startBtnByBlock = {
    unprodTimerBlock: 'unprodTimerStartBtn',
    studyTimerBlock: 'studyTimerStartBtn'
  };
  const ids = blockIds || ['unprodTimerBlock', 'studyTimerBlock'];
  ids.forEach((id) => {
    const block = $(id);
    if (!block) return;
    block.querySelectorAll('.timer-hms input').forEach((inp) => {
      inp.disabled = locked;
    });
    block.querySelectorAll('.timer-hms').forEach((el) => {
      el.classList.toggle('timer-hms-tutorial-locked', locked);
      if (locked) {
        el.title = 'Will unlock after tutorial';
      } else {
        el.removeAttribute('title');
      }
    });
    const startBtn = $(startBtnByBlock[id]);
    if (startBtn) {
      startBtn.disabled = locked;
      startBtn.style.opacity = locked ? '0.5' : '';
      startBtn.style.cursor = locked ? 'not-allowed' : 'pointer';
    }
    const hint = block.querySelector('.timer-tutorial-lock-hint');
    if (hint) hint.style.display = locked ? 'block' : 'none';
  });
}

function ensureTutorialDemoCard(visible) {
  setTutorialFixedVisible($('pf-tutorial-demo-card'), visible, TUTORIAL_DEMO_CARD_POS);
  if (!visible) return;
  const bar = $('pfTutorialDemoProgress');
  if (!bar) return;
  bar.style.width = '0%';
  bar.style.transition = 'none';
  void bar.offsetWidth;
  requestAnimationFrame(() => {
    bar.style.transition = 'width 10s linear';
    bar.style.width = '100%';
  });
}

function ensureTutorialMockIndicator(visible) {
  setTutorialFixedVisible($('pf-tutorial-mock-indicator'), visible, TUTORIAL_MOCK_INDICATOR_POS);
}

function ensureTutorialTimerMock(visible) {
  setTutorialFixedVisible($('pf-tutorial-timer-mock'), visible, TUTORIAL_MOCK_INDICATOR_POS);
}

/** Synthetic-but-real demo recap for the tutorial's Daily Wrapped step:
 *  built by the ACTUAL engine from demo rollups, plus one special example
 *  card. Nothing is written to storage (see the demo flag in the chest). */
function pfTutorialDemoWrapped() {
  const now = Date.now();
  const noonDaysAgo = (n) => { const d = new Date(now - n * 864e5); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const demoDay = (n, over = {}) => ({
    ts: noonDaysAgo(n),
    p: 2 * 3600 + 45 * 60, u: 38 * 60, n: 22 * 60, eng: 14,
    topHosts: [['docs.google.com', 5400, 'Productive'], ['github.com', 3600, 'Productive'], ['youtube.com', 1500, 'Unproductive']],
    hourlyP: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 12 ? 2400 : (h >= 14 && h < 17 ? 1500 : 0))),
    closesByHost: { 'youtube.com': 3 },
    reorders: 21, shields: 2, timers: 2, breaks: 1,
    ...over
  });
  const demoSummaries = { 'demo-1': demoDay(1), 'demo-2': demoDay(2, { p: 2 * 3600, u: 50 * 60 }) };
  const recap = buildDailyRecap(demoSummaries, { now, streak: 3 });
  if (!recap) return null;
  // Special example card: unmistakably a demo, welcoming rather than stats-y.
  const slide = {
    ...recap,
    dateLabel: 'EXAMPLE',
    heroDetail: 'This is an example card. Your real Wrapped lands every morning.'
  };
  return { recap, slide };
}

/** Daily Wrapped tutorial step: a REAL banner pill (built by the same
 *  factory as the live rail). Clicking it opens the actual daily crate
 *  unboxing with one special example card inside. */
function ensureTutorialWrappedCard(visible) {
  let el = $('pf-tutorial-wrapped-card');
  if (!el && visible) {
    el = document.createElement('div');
    el.id = 'pf-tutorial-wrapped-card';
    el.style.zIndex = '10015'; // above the tutorial dim (10000), below the box (10020)
    el.style.width = 'min(640px, 92vw)';
    document.body.appendChild(el);
    try {
      const demo = pfTutorialDemoWrapped();
      if (demo) {
        const banner = pfRecapBanner({
          kind: 'daily',
          kicker: 'DAILY WRAPPED',
          line: 'Yesterday, wrapped into cards',
          sub: 'Click to open an example',
          recap: demo.recap
        });
        // Strip the live handlers (real chest gate + storage-writing
        // dismiss) — the demo banner opens the FORCED demo crate instead.
        const demoBanner = banner.cloneNode(true);
        demoBanner.querySelector('.pf-recap-dismiss')?.remove();
        demoBanner.addEventListener('click', () => {
          const host = $('pf-tutorial-wrapped-card');
          if (host?.dataset.used === '1') return;
          if (host) host.dataset.used = '1'; // ONE-SHOT: works once…
          // Unlock Next button — user must open the card before proceeding.
          // Per user spec 2026-07: "don't let them click next till they open the thing."
          chrome.storage.local.set({ tutorialWrappedOpened: true }).catch(() => {});
          updateTutorNextState();
          // Behave exactly like the real banner will on THEIR skin:
          //   notebook  → fullscreen crate unboxing
          //   basic     → just the example card modal, no fullscreen
          if (document.body.classList.contains('theme-notebook')) {
            void pfRecapOpenChest(demo.recap, { forceChest: true, demo: true, slides: [demo.slide] });
          } else {
            void pfRecapOpenModal(demo.slide, { markSeen: false });
          }
          // …then disappears for good.
          if (host) setTutorialFixedVisible(host, false, TUTORIAL_WRAPPED_CARD_POS);
        });
        el.appendChild(demoBanner);
      }
    } catch (e) {
      console.warn('[pf-tutorial] wrapped demo banner failed', e);
    }
  }
  // Once used, the demo banner never comes back (even re-entering the step).
  const used = el?.dataset.used === '1';
  setTutorialFixedVisible(el, visible && !used, TUTORIAL_WRAPPED_CARD_POS);
}

function getTutorialFloatingButtonHighlightEl() {
  const timerMock = $('pf-tutorial-timer-mock');
  if (timerMock?.style.visibility === 'visible') {
    return timerMock.querySelector('.pf-btn-stack') || timerMock;
  }
  const mock = $('pf-tutorial-mock-indicator');
  if (mock?.style.visibility === 'visible') {
    return mock.querySelector('.pf-btn-stack') || mock;
  }
  return mock?.querySelector('.pf-btn-stack') || mock;
}

function clearTutorialFloatingButtonHighlight() {
  document.querySelectorAll(
    '#pf-tutorial-mock-indicator .pf-btn-stack, #pf-tutorial-timer-mock .pf-btn-stack'
  ).forEach((el) => {
    el.classList.remove(
      'tutor-highlight-fixed',
      'tutor-highlight-wide-fixed',
      'tutor-soft-highlight-fixed',
      'pf-tutorial-btn-glow'
    );
  });
  ['pf-tutorial-mock-indicator', 'pf-tutorial-timer-mock'].forEach((id) => {
    $(id)?.classList.remove(
      'tutor-highlight-fixed',
      'tutor-highlight-wide-fixed',
      'tutor-soft-highlight-fixed'
    );
  });
}

function applyTutorialFloatingButtonHighlight() {
  clearTutorialFloatingButtonHighlight();
  const timerMock = $('pf-tutorial-timer-mock');
  const mock = $('pf-tutorial-mock-indicator');
  const container = timerMock?.style.visibility === 'visible' ? timerMock : mock;
  const stack = container?.querySelector('.pf-btn-stack');
  if (!container || !stack) return;
  applyTutorialFixedPosition(container, TUTORIAL_MOCK_INDICATOR_POS);
  container.classList.add('tutor-highlight-fixed', 'tutor-highlight-wide-fixed');
  stack.classList.add('pf-tutorial-btn-glow');
  // Preserve the "click stopped the pulse" state across the stage 3
  // swap from mock-indicator → timer-mock. Without this, freshly
  // attaching pf-tutorial-btn-glow to the timer-mock stack would restart
  // the purple pulsing. Per user report 2026-07.
  if (tutorialStep9BtnPulseStopped) {
    stack.classList.add('pf-pulse-done');
  }
}

function refreshTutorialStep9Layout() {
  if (currentStep !== 8) return;
  applyTutorialFloatingButtonHighlight();
  tutorialRepositionBox?.();
}

function orderOwnedThemeCards(carousel) {
  const tutorialBg = $('themeCardTutorialBackground');
  const notebook = $('themeCardNotebook');
  if (tutorialBg) carousel.prepend(tutorialBg);
  if (notebook && tutorialBg) {
    carousel.insertBefore(notebook, tutorialBg.nextSibling);
  }
}

function setTutorialThemeCarouselMode(onlyOwned) {
  const carousel = $('themeCarousel');
  if (!carousel) return;
  const lockedCards = [...carousel.querySelectorAll('.theme-card.theme-locked')];
  orderOwnedThemeCards(carousel);
  if (onlyOwned) {
    lockedCards.forEach((card) => { card.style.display = 'none'; });
    carousel.style.width = '480px';
    carousel.style.maxWidth = '480px';
    carousel.style.overflowX = 'hidden';
    carousel.classList.add('tutorial-hide-scrollbar');
    return;
  }
  lockedCards.forEach((card) => { card.style.display = ''; });
  carousel.style.width = '';
  carousel.style.maxWidth = '';
  carousel.style.overflowX = '';
  carousel.classList.remove('tutorial-hide-scrollbar');
}

function setTutorialNotebookPulse(active) {
  const notebook = $('themeCardNotebook');
  if (!notebook) return;
  notebook.classList.toggle('tutorial-pulse-selection', !!active);
}

function stopTutorialTimerMockDemo() {
  if (tutorialTimerMockDemoInterval) {
    clearInterval(tutorialTimerMockDemoInterval);
    tutorialTimerMockDemoInterval = null;
  }
  const ring = document.querySelector('#pf-tutorial-timer-mock .pf-progress-ring');
  const btn = document.querySelector('#pf-tutorial-timer-mock .pf-btn');
  if (ring) {
    ring.classList.remove('pf-visible', 'pf-done');
    ring.style.background = '';
  }
  if (btn) {
    btn.style.background = '';
    btn.style.boxShadow = '';
    btn.style.transform = '';
  }
}

function startTutorialTimerMockDemo() {
  stopTutorialTimerMockDemo();
  const timeEl = document.querySelector('#pf-tutorial-timer-mock .pf-countdown-time');
  const ring = document.querySelector('#pf-tutorial-timer-mock .pf-progress-ring');
  const btn = document.querySelector('#pf-tutorial-timer-mock .pf-btn');
  if (!timeEl) return;
  const TOTAL = 60;
  let remaining = TOTAL;
  const applyMockPuck = () => {
    if (!btn) return;
    btn.style.background = 'radial-gradient(circle at 38% 32%, #2a313a 0%, #12151a 72%)';
    btn.style.boxShadow = 'inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -2px 3px rgba(0,0,0,0.55)';
    btn.style.border = 'none';
  };
  const render = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timeEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    applyMockPuck();
    if (ring) {
      const elapsed = TOTAL - remaining;
      const angle = Math.max(0, Math.min(360, (elapsed / TOTAL) * 360));
      ring.classList.add('pf-visible');
      ring.style.background = `
        conic-gradient(
          from 0deg,
          #8fd41a 0deg,
          #a3e635 ${angle * 0.45}deg,
          #8fd41a ${angle}deg,
          #2f4538 ${angle}deg,
          #1f2d26 360deg)
      `;
    }
  };
  render();
  tutorialTimerMockDemoInterval = setInterval(() => {
    remaining = remaining <= 0 ? TOTAL : remaining - 1;
    render();
  }, 1000);
}

function getTabLimitValueOrNull() {
  const raw = parseInt($('maxTabLimit')?.value ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1) return null;
  return Math.min(raw, MAX_TAB_LIMIT);
}

function triggerTabLimitLockShake() {
  const input = $('maxTabLimit');
  const lockBtn = $('tabLimitLockBtn');
  [input, lockBtn].forEach((el) => {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 420);
  });
}

function triggerTutorialShake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 420);
}

function isTutorialRankingPerTabOnlyStep() {
  return document.body.classList.contains('tutorial-active') && currentStep === 5;
}

function triggerRankingModePerWebsiteShake() {
  triggerTutorialShake($('rankingModeWebsite')?.closest('label'));
  triggerTutorialShake($('rankingModeMain'));
}

function blockTutorialPerWebsiteRankingMode() {
  const tabRadio = $('rankingModeTab');
  if (tabRadio) tabRadio.checked = true;
  triggerRankingModePerWebsiteShake();
  updateWipeTabTimesVisibility();
  syncRankingModeDemo();
  // Per user report 2026-07: show a small purple hint under the Per
  // Website label so the user understands why nothing happened when
  // they clicked it — the tutorial locks the ranking mode to Per Tab.
  showTutorialPerTabOnlyHint();
}

function showTutorialPerTabOnlyHint() {
  const label = $('rankingModeWebsite')?.closest('label');
  if (!label) return;
  let hint = label.parentNode.querySelector('.pf-tutorial-per-tab-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'pf-tutorial-per-tab-hint';
    hint.textContent = 'Please use Per tab for the tutorial.';
    label.insertAdjacentElement('afterend', hint);
  }
  hint.classList.remove('pf-visible');
  void hint.offsetWidth;
  hint.classList.add('pf-visible');
  clearTimeout(showTutorialPerTabOnlyHint._t);
  showTutorialPerTabOnlyHint._t = setTimeout(() => {
    hint.classList.remove('pf-visible');
  }, 4000);
}

function isTutorialNotebookBackLocked() {
  // User spec 2026-07 v3: theme choice is freely reversible during the
  // tutorial. Clicking the notebook no longer traps the user — they can
  // swap between Student (notebook) and Professional (tutorial_background)
  // as many times as they want before hitting Next.
  return false;
}

function updateTutorialTabLimitControls() {
  const input = $('maxTabLimit');
  const lockBtn = $('tabLimitLockBtn');
  const confirmBtn = $('confirmTabLimit');
  if (!input || !lockBtn || !confirmBtn) return;

  const applyLockButtonState = () => {
    const isLocked = !!tutorialTabLimitLocked;
    const lockIcon = lockBtn.querySelector('.pf-control-icon, .nb-sketch-icon');
    if (lockIcon) lockIcon.dataset.icon = isLocked ? 'lock-closed' : 'lock-open';
    lockBtn.classList.toggle('is-locked', isLocked);
    lockBtn.classList.toggle('is-unlocked', !isLocked);
    lockBtn.setAttribute('aria-label', isLocked ? 'Unlock tab limit value' : 'Lock tab limit value');
    lockBtn.title = isLocked ? 'Unlock tab limit value' : 'Lock tab limit value';
  };

  const inTutorialTabLimitFlow = currentStep === 3 || currentStep === 4;
  const hasValidTabLimit = getTabLimitValueOrNull() !== null;

  if (!inTutorialTabLimitFlow) {
    input.disabled = tutorialTabLimitLocked;
    applyLockButtonState();
    const canConfirmOutsideTutorial = tutorialTabLimitLocked && hasValidTabLimit;
    confirmBtn.disabled = !canConfirmOutsideTutorial;
    confirmBtn.classList.toggle('tutorial-active-green', canConfirmOutsideTutorial);
    confirmBtn.classList.remove('tutorial-pulse');
    confirmBtn.style.cursor = canConfirmOutsideTutorial ? 'pointer' : 'not-allowed';
    return;
  }

  input.disabled = tutorialTabLimitLocked;
  applyLockButtonState();

  const canConfirm = currentStep === 4 && hasValidTabLimit;
  confirmBtn.disabled = !canConfirm;
  confirmBtn.classList.toggle('tutorial-active-green', canConfirm);
  confirmBtn.classList.toggle('tutorial-pulse', canConfirm && !tutorialTabLimitConfirmClicked);
  if (tutorialTabLimitConfirmClicked) {
    confirmBtn.classList.remove('tutorial-pulse');
    confirmBtn.style.animation = 'none';
  }
  confirmBtn.style.cursor = canConfirm ? 'pointer' : 'not-allowed';
}

function triggerTutorialDemoRipple(cardElement, buttonElement) {
  if (!cardElement || !buttonElement) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const computedPos = getComputedStyle(cardElement).position;
  if (computedPos === 'static') cardElement.style.position = 'relative';

  const popupRect = cardElement.getBoundingClientRect();
  const buttonRect = buttonElement.getBoundingClientRect();
  const originX = buttonRect.left + buttonRect.width / 2 - popupRect.left;
  const originY = buttonRect.top + buttonRect.height / 2 - popupRect.top;
  const corners = [
    { x: 0, y: 0 },
    { x: popupRect.width, y: 0 },
    { x: 0, y: popupRect.height },
    { x: popupRect.width, y: popupRect.height }
  ];
  const maxDistance = Math.max(...corners.map((c) => Math.hypot(c.x - originX, c.y - originY)));
  const targetDiameter = maxDistance * 2.2;
  const ripple = document.createElement('div');
  ripple.className = 'pf-affirm-ripple';
  ripple.style.cssText = `
    position: absolute;
    left: ${originX}px;
    top: ${originY}px;
    width: 20px;
    height: 20px;
    margin-left: -10px;
    margin-top: -10px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 50%,
      rgba(74, 222, 128, 0.9) 0%,
      rgba(34, 197, 94, 0.7) 40%,
      rgba(22, 163, 74, 0.4) 70%,
      rgba(34, 197, 94, 0) 100%);
    box-shadow:
      0 0 24px 8px rgba(34, 197, 94, 0.5),
      0 0 8px 2px rgba(74, 222, 128, 0.7) inset;
    pointer-events: none;
    opacity: 1;
    transform: scale(0.1);
    transition:
      transform 1.1s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 1.1s cubic-bezier(0.4, 0, 0.6, 1);
    z-index: 100;
    mix-blend-mode: screen;
  `;
  ripple.style.width = `${targetDiameter}px`;
  ripple.style.height = `${targetDiameter}px`;
  ripple.style.marginLeft = `${-targetDiameter / 2}px`;
  ripple.style.marginTop = `${-targetDiameter / 2}px`;
  cardElement.appendChild(ripple);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ripple.style.transform = 'scale(1)';
      ripple.style.opacity = '0';
    });
  });
  setTimeout(() => {
    if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
  }, 1200);
}

function readTutorBoxVisualPosition(box) {
  const rect = box.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}

function captureTutorTargetRect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height)
  };
}

function serializeTutorTargetRect(el) {
  const snap = captureTutorTargetRect(el);
  return snap ? JSON.stringify(snap) : null;
}

function tutorTargetRectChanged(prevSerialized, el, epsilon = 3) {
  const next = captureTutorTargetRect(el);
  if (!next) return false;
  if (!prevSerialized) return true;
  let prev = null;
  try {
    prev = JSON.parse(prevSerialized);
  } catch (_) {
    return true;
  }
  return Math.abs(prev.left - next.left) > epsilon
    || Math.abs(prev.top - next.top) > epsilon
    || Math.abs(prev.width - next.width) > epsilon
    || Math.abs(prev.height - next.height) > epsilon;
}

function scheduleTutorialTargetLayoutSync({ animate = false } = {}) {
  if (!document.body.classList.contains('tutorial-active')) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof tutorialRepositionBox === 'function') {
        tutorialRepositionBox({ animate });
      }
    });
  });
}

function getTutorialUnlockHint(stepIdx) {
  const step = steps[stepIdx];
  if (!step) return '';
  switch (step.unlock) {
    case 'commit-typing':
      return `Type "${TUTORIAL_COMMIT_TARGET}" to continue.`;
    case 'productive-click':
      return "Click Yes on the card to continue.";
    case 'name-save':
      return 'Edit the window name and save it to continue.';
    case 'tab-limit':
      return 'Set a tab limit and click Confirm to continue.';
    case 'tab-limit-lock-cycle':
      return 'Unlock and re-lock the tab limit once to continue.';
    case 'tab-limit-apply':
      return 'Click Confirm to apply your tab limit and continue.';
    case 'customizations-theme':
      return 'Select the Notebook theme to continue.';
    case 'closer-toggle-cycle':
      return 'Toggle closer ON, then OFF to continue.';
    case 'mock-stage-flow':
      return 'Follow the hold prompts to continue.';
    case 'wipe-tab-times-setup':
      return 'Turn on Reset Tab Ranking Scores to continue.';
    case 'wrapped-opened':
      return 'Click the banner above to open your Daily Wrapped example.';
    default:
      return '';
  }
}

function updateTutorProgressNote(unlocked, isFinalStep = false) {
  const note = $('tutorProgressNote');
  if (!note) return;
  const step = steps[currentStep];
  if (step?.unlock === 'commit-typing') {
    if (unlocked) {
      note.style.display = 'none';
      note.innerText = '';
      return;
    }
    showTutorialCommitProgressNote();
    return;
  }
  if (unlocked) {
    note.style.display = 'none';
    note.innerText = '';
    return;
  }
  const hint = getTutorialUnlockHint(currentStep);
  if (!hint) {
    note.style.display = 'none';
    note.innerText = '';
    return;
  }
  note.style.display = 'block';
  note.innerText = hint;
}

function parseTimeToSeconds(str) {
  if (!str) return 0;
  if (str.toUpperCase && str.toUpperCase() === 'BLOCK') return -1;

  const trimmed = String(str).trim();
  if (!trimmed) return 0;

  // Colon format: "MM:SS" or "H:MM:SS"
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map(p => parseInt(p, 10) || 0);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  // wdhms format: "1h30m", "5m", "1d2h", "45s", "2h30m15s"
  const u = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const regex = /(\d+)\s*([wdhms])/gi;
  let total = 0, found = false, res;
  while ((res = regex.exec(trimmed)) !== null) {
    total += res[1] * u[res[2].toLowerCase()];
    found = true;
  }
  if (found) return total;

  // Plain integer = minutes
  const asNum = parseInt(trimmed, 10);
  return isNaN(asNum) ? 0 : asNum * 60;
}

function getTimerHmsEl(hiddenId) {
  return document.querySelector(`.timer-hms[data-sync-id="${hiddenId}"]`);
}

function clampTimerHmsPart(value, max) {
  return Math.min(max, Math.max(0, parseInt(String(value).replace(/\D/g, ''), 10) || 0));
}

function formatTimerHmsPart(value, max = 59) {
  return String(clampTimerHmsPart(value, max)).padStart(2, '0');
}

function normalizeTimerHmsField(input) {
  if (!input) return;
  // Allow minutes/seconds to exceed 59 here so users can type e.g. "90" for
  // 90 minutes (1h30m) without the field silently truncating to 59. Overflow
  // is normalized into the next unit when the value is read (readTimerHmsString)
  // or written back (writeTimerHmsValues). Upper bound of 9999 keeps typos sane.
  const max = input.classList.contains('timer-hms-h') ? 99 : 9999;
  input.value = formatTimerHmsPart(input.value, max);
}

/**
 * Detect shorthand duration text the user typed into ANY sub-field of an HMS
 * box — e.g. "1H", "1h", "90m", "45s", "2h30m" — and expand it across the
 * three h/m/s inputs. This is the input style many users reach for first
 * ("1H" for one hour); without it, the "H" was stripped and the bare "1" was
 * mis-filed into whichever box it was typed in, so a 1-hour focus period
 * became 1 hour / 1 minute / 1 second depending on the box. Returns true if
 * shorthand was detected and expanded (so the caller can skip plain clamping).
 */
function expandShorthandInHmsBox(box) {
  if (!box) return false;
  const hEl = box.querySelector('.timer-hms-h');
  const mEl = box.querySelector('.timer-hms-m');
  const sEl = box.querySelector('.timer-hms-s');
  if (!hEl || !mEl || !sEl) return false;
  // Shorthand = any field text contains a unit letter (h/m/s/w/d) after a digit.
  // A plain number ("15", "60") is NOT shorthand — leave it for the normal path.
  const combined = `${hEl.value || ''} ${mEl.value || ''} ${sEl.value || ''}`;
  if (!/\d\s*[wdhms]/i.test(combined)) return false;
  // parseTimeToSeconds understands wdhm shorthand and finds units anywhere in
  // the string, so feeding it the combined box text captures "1H" typed into
  // any single field. Decompose the resulting seconds back into h/m/s.
  const total = Math.max(0, parseTimeToSeconds(combined));
  if (total <= 0) return false;
  hEl.value = Math.floor(total / 3600);
  mEl.value = Math.floor((total % 3600) / 60);
  sEl.value = total % 60;
  return true;
}

function normalizeTimerHmsBox(box) {
  if (!box) return;
  // First, expand any shorthand duration ("1H", "90m", "2h30m") the user typed
  // into a sub-field across all three h/m/s fields. After this the values are
  // plain numbers, so the per-field normalize below works as usual.
  expandShorthandInHmsBox(box);
  normalizeTimerHmsField(box.querySelector('.timer-hms-h'));
  normalizeTimerHmsField(box.querySelector('.timer-hms-m'));
  normalizeTimerHmsField(box.querySelector('.timer-hms-s'));
}

function readTimerHmsString(hiddenId) {
  const box = getTimerHmsEl(hiddenId);
  if (!box) {
    return (document.getElementById(hiddenId)?.value || '').trim();
  }
  // Normalize first so shorthand ("1H") typed into any sub-field is expanded
  // to plain h/m/s values before we read them. Idempotent for plain numbers.
  expandShorthandInHmsBox(box);
  // Read raw values, then NORMALIZE overflow into the next unit instead of
  // clamping at 59. This lets users type "90" in the minutes field to mean
  // 1h30m (and "1" in hours for 1H) — the old Math.min(59, …) clamp silently
  // turned "60 minutes" into 59, and "100 minutes" into 59, so a user entering
  // a 1-hour focus period via the minutes box got 59 (or fewer) minutes instead.
  let h = Math.max(0, parseInt(box.querySelector('.timer-hms-h')?.value, 10) || 0);
  let m = Math.max(0, parseInt(box.querySelector('.timer-hms-m')?.value, 10) || 0);
  let s = Math.max(0, parseInt(box.querySelector('.timer-hms-s')?.value, 10) || 0);
  // Roll seconds → minutes → hours.
  m += Math.floor(s / 60);
  s = s % 60;
  h += Math.floor(m / 60);
  m = m % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function syncTimerHiddenFromHms(hiddenId) {
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = readTimerHmsString(hiddenId);
}

function writeTimerHmsValues(hiddenId, h, m, s) {
  const box = getTimerHmsEl(hiddenId);
  // Normalize overflow (seconds→minutes→hours) instead of clamping at 59, so a
  // stored value like 90 minutes writes back as 1h 30m, not a truncated 59m.
  // Matches the normalization in readTimerHmsString.
  let nh = clampTimerHmsPart(h, 99);
  let nm = clampTimerHmsPart(m, 999);
  let ns = clampTimerHmsPart(s, 999);
  nm += Math.floor(ns / 60);
  ns = ns % 60;
  nh += Math.floor(nm / 60);
  nm = nm % 60;
  const ch = nh;
  const cm = nm;
  const cs = ns;
  const formatted = `${ch}:${String(cm).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = formatted;
  if (!box) return;
  const hEl = box.querySelector('.timer-hms-h');
  const mEl = box.querySelector('.timer-hms-m');
  const sEl = box.querySelector('.timer-hms-s');
  if (hEl) hEl.value = formatTimerHmsPart(ch, 99);
  if (mEl) mEl.value = formatTimerHmsPart(cm, 59);
  if (sEl) sEl.value = formatTimerHmsPart(cs, 59);
}

function writeTimerHmsFromSeconds(hiddenId, totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  writeTimerHmsValues(
    hiddenId,
    Math.floor(sec / 3600),
    Math.floor((sec % 3600) / 60),
    sec % 60
  );
}

function writeTimerHmsFromString(hiddenId, str) {
  const sec = parseTimeToSeconds(str || '');
  if (sec > 0) {
    writeTimerHmsFromSeconds(hiddenId, sec);
    return;
  }
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = str || '';
  writeTimerHmsValues(hiddenId, 0, 0, 0);
}

function setTimerHmsDisabled(hiddenId, disabled) {
  const box = getTimerHmsEl(hiddenId);
  if (box) {
    box.querySelectorAll('input').forEach((inp) => { inp.disabled = disabled; });
    box.classList.toggle('timer-hms-disabled', disabled);
    return;
  }
  const el = document.getElementById(hiddenId);
  if (el) el.disabled = disabled;
}

function setTimerHmsRunningStyle(hiddenId, mode) {
  const box = getTimerHmsEl(hiddenId);
  if (!box) return;
  box.classList.remove('timer-hms-active', 'timer-hms-idle', 'timer-hms-paused');
  if (mode) box.classList.add(`timer-hms-${mode}`);
}

function isTimerHmsFieldFocused(hiddenId) {
  const hidden = $(hiddenId);
  if (!hidden) return false;
  if (document.activeElement === hidden) return true;
  const box = document.querySelector(`.timer-hms[data-sync-id="${hiddenId}"]`);
  return !!(box && box.contains(document.activeElement));
}

function bindTimerHmsInputs() {
  document.querySelectorAll('.timer-hms[data-sync-id]').forEach((box) => {
    const hiddenId = box.dataset.syncId;
    if (!hiddenId || box.dataset.hmsBound === '1') return;
    box.dataset.hmsBound = '1';
    box.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '').slice(0, 2);
        syncTimerHiddenFromHms(hiddenId);
      });
      inp.addEventListener('blur', () => {
        normalizeTimerHmsField(inp);
        syncTimerHiddenFromHms(hiddenId);
      });
      inp.addEventListener('change', () => {
        normalizeTimerHmsBox(box);
        syncTimerHiddenFromHms(hiddenId);
        autoSave(`timer-hms-${hiddenId}`);
        if (['bankFocusTime', 'bankEarnedTime', 'studyTimeLimit'].includes(hiddenId)) {
          void refreshSettingDemoVisibility('bankedTime');
        }
      });
    });
    normalizeTimerHmsBox(box);
    syncTimerHiddenFromHms(hiddenId);
  });
}

async function autoSave(triggerSource) {
  if (!isInitialized) return;
  const win = await chrome.windows.getCurrent();
  const [currentConfigResponse, timerFlags] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id }),
    getWallClockTimerUiFlags(win.id)
  ]);
  const currentConfig = currentConfigResponse?.config || {};
  const timerSessionActive = timerFlags.timerSessionActive;
  const enforcerEl = $('enforcerToggle');
  // TOGGLE STUCK-ON FIX (2026-07): the old guard discarded the checkbox
  // whenever ANY timer session was active and re-saved the previous config
  // value. A reminder timer IS a session (and can run for hours), so while
  // one ran — and after its expiry forced the closer ON — every attempt to
  // switch the toggle OFF was silently thrown away and the UI snapped back
  // to ON ("the toggle is permanently on, I think the reminder thing has
  // something to do with it"). The dashboard's own rule (see
  // refreshCloserToggleUI) is that plain timer sessions leave the toggle
  // USABLE; only a LOCKED toggle (active spend session — rendered disabled
  // and force-unchecked) must not clobber config with its forced state.
  const enforcerLocked = !!(enforcerEl && (enforcerEl.disabled || enforcerEl.hasAttribute('data-pf-locked')));
  const limitsEnabled = currentStep === 7
    ? currentConfig.limitsEnabled
    : enforcerLocked
      ? currentConfig.limitsEnabled
      : (enforcerEl ? enforcerEl.checked : currentConfig.limitsEnabled);
  console.warn('[pf-autosave-call] autoSave triggered. limitsEnabled=', limitsEnabled, 'trigger:', triggerSource);
  syncTimerHiddenFromHms('unprodTimeLimit');
  syncTimerHiddenFromHms('studyTimeLimit');
  syncTimerHiddenFromHms('bankFocusTime');
  syncTimerHiddenFromHms('bankEarnedTime');
  syncTimerHiddenFromHms('bankFocusTimeModeB');
  syncTimerHiddenFromHms('bankEarnedTimeModeB');
  syncTimerHiddenFromHms('studyBreakEveryTime');
  syncTimerHiddenFromHms('studyBreakEarnTime');
  const updates = {
    name: $('displayName').innerText,
    tabLimit: Math.min(parseInt($('maxTabLimit').value, 10) || MAX_TAB_LIMIT, MAX_TAB_LIMIT),
    limitsEnabled,
    tabLifeEnabled: !!($('tabLifeLimit')?.value || ''),
    tabLifeLimit: $('tabLifeLimit')?.value || '',
    tabLifeLimitStr: $('tabLifeLimit')?.value || '',
    tabLifeLimitSec: $('tabLifeLimit')?.value ? parseTimeToSeconds($('tabLifeLimit').value) : 0,
    unprodLimit: readTimerHmsString('unprodTimeLimit'),
    unprodLimitSec: parseTimeToSeconds(readTimerHmsString('unprodTimeLimit')),
    studyLimit: readTimerHmsString('studyTimeLimit'),
    studyLimitSec: parseTimeToSeconds(readTimerHmsString('studyTimeLimit')),
    studyTimerEnabled: currentConfig.studyTimerEnabled || false,
    studyStartedAt: currentConfig.studyStartedAt ?? null,
    specificLimits: [],
    bankedTimeEnabled: !!($('enableBankedTimeModeB')?.checked || $('enableBankedTime')?.checked),
    advancedBankedTimeEnabled: !!$('enableBankedTimeModeB')?.checked,
    bankFocusStr: readTimerHmsString('bankFocusTimeModeB') || readTimerHmsString('bankFocusTime'),
    bankFocus: parseTimeToSeconds(readTimerHmsString('bankFocusTimeModeB') || readTimerHmsString('bankFocusTime')),
    bankEarnedStr: readTimerHmsString('bankEarnedTimeModeB') || readTimerHmsString('bankEarnedTime'),
    bankEarned: parseTimeToSeconds(readTimerHmsString('bankEarnedTimeModeB') || readTimerHmsString('bankEarnedTime')),
    studyBreakEnabled: !!$('studyBreakEnabled')?.checked,
    studyBreakEvery: readTimerHmsString('studyBreakEveryTime'),
    studyBreakEverySec: parseTimeToSeconds(readTimerHmsString('studyBreakEveryTime')),
    studyBreakEarn: readTimerHmsString('studyBreakEarnTime'),
    studyBreakEarnSec: parseTimeToSeconds(readTimerHmsString('studyBreakEarnTime')),
    resetSession: $('resetSessionCheck').checked,
    startupSlots: triggerSource === 'startupSlotsConfirm'
      ? readStartupSlotsFromUI()
      : currentConfig.startupSlots,
    wipeTabTimesEnabled: $('enableWipeTabTimes') ? $('enableWipeTabTimes').checked : false,
    wipeTabTimesInterval: $('wipeTabTimesInterval')?.value || '1w',
    wipeTabTimesAt: $('wipeTabTimesAt')?.value || '09:00',
    pauseActive: $('enablePause') ? $('enablePause').checked : (currentConfig.pauseActive || false),
    autoCloseDashboard: $('autoCloseDashboard') ? $('autoCloseDashboard').checked : false,
    autoShieldPopouts: $('autoShieldPopouts') ? $('autoShieldPopouts').checked : false,
    autoCloseAutoTabs: $('autoCloseAutoTabs') ? $('autoCloseAutoTabs').checked : false,
    rankingMode: getSelectedRankingMode(),
    pausedUntil: currentConfig.pausedUntil || 0
  };
  console.warn('[pf-savewindow-call] autoSave sending saveWindowConfig', { windowId: win.id, updates });
  await chrome.runtime.sendMessage({ action: 'saveWindowConfig', windowId: win.id, updates });
  if (triggerSource === 'maxTabLimit') {
    $('tabUpdateTick').style.opacity = '1';
    setTimeout(() => $('tabUpdateTick').style.opacity = '0', 1500);
  }
}

const STARTUP_SLOT_TYPES = [
  { value: 'url', label: 'Website' },
  { value: 'last_session', label: 'Last session tab' },
  { value: 'empty', label: 'Leave empty' }
];
const STARTUP_SLOTS_VALIDATION_MSG = "You can't leave a space open without having Leave empty selected. Leave empty only works on your last tab.";
/** Rolling window for startup auto-fill ranking (matches streak day keys). */
const STARTUP_FILL_DAY_WINDOW = 7;

function hostnameFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return (u.hostname || '').replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/** Mirrors worker.js canonicalHostname aliases for Mode B site lists. */
const SITE_LIST_HOST_ALIASES = {
  'm.youtube.com': 'youtube.com',
  'music.youtube.com': 'music.youtube.com',
  'mobile.twitter.com': 'twitter.com',
  'm.twitter.com': 'twitter.com',
  'm.facebook.com': 'facebook.com',
  'old.reddit.com': 'reddit.com',
  'new.reddit.com': 'reddit.com',
  'np.reddit.com': 'reddit.com'
};

function canonicalSiteListHostname(rawHost) {
  const h = String(rawHost || '').toLowerCase().replace(/^www\./, '');
  return SITE_LIST_HOST_ALIASES[h] || h;
}

function isValidSiteListHostname(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost') return true;
  if (!h.includes('.') || h.length > 253) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return false;
  const tld = h.split('.').pop();
  return !!tld && tld.length >= 2 && !/^\d+$/.test(tld);
}

/** Bare hostname (youtube.com) or path-specific pattern (youtube.com/watch?v=abc). */
function normalizeBankSitePattern(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const rawHost = (u.hostname || '').toLowerCase();
    if (rawHost === 'youtu.be') {
      const videoId = (u.pathname || '').replace(/^\//, '').split('/')[0];
      if (!videoId) return '';
      return `youtube.com/watch?v=${videoId}`;
    }
    const host = canonicalSiteListHostname(rawHost);
    if (!isValidSiteListHostname(host)) return '';
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const hasPath = path && path !== '/';
    const query = u.search ? u.search.slice(1) : '';
    if (!hasPath && !query) return host;
    let out = host;
    if (hasPath) out += path;
    if (query) out += `?${query}`;
    return coerceAiExcludedBankSitePattern(out);
  } catch (_) {
    return '';
  }
}

function normalizeStoredSiteList(raw) {
  const items = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',').map((part) => part.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const pattern = normalizeBankSitePattern(item);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

function normalizeStartupFillHostname(hostKey) {
  return hostnameFromUrl(hostKey) || String(hostKey || '').replace(/^www\./, '').toLowerCase();
}

function isStartupFillHostAllowed(hostname) {
  if (!hostname) return false;
  return !isExcludedHostname(hostname);
}

/** Last N calendar days using the same day-key logic as streaks (3am rollover). */
function getStartupFillDayKeys(windowDays = STARTUP_FILL_DAY_WINDOW) {
  const keys = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(streakDayKey(d));
  }
  return keys;
}

/**
 * Aggregate per-host seconds from dailySiteLogs across dayKeys.
 * Excludes banking/AI/sensitive hosts via isExcludedHostname.
 */
function aggregateHostsFromDailySiteLogs(dailySiteLogs, dayKeys) {
  const hostProductiveSec = new Map();
  const hostTotalSec = new Map();

  for (const dayKey of dayKeys) {
    const day = dailySiteLogs?.[dayKey];
    if (!day || typeof day !== 'object') continue;
    for (const [hostKey, entry] of Object.entries(day)) {
      const hostname = normalizeStartupFillHostname(hostKey);
      if (!isStartupFillHostAllowed(hostname)) continue;
      const buckets = normalizeDailySiteLogEntry(entry);
      const productiveSec = buckets.Productive;
      const totalSec = dailySiteLogTotal(buckets);
      if (productiveSec > 0) {
        hostProductiveSec.set(hostname, (hostProductiveSec.get(hostname) || 0) + productiveSec);
      }
      if (totalSec > 0) {
        hostTotalSec.set(hostname, (hostTotalSec.get(hostname) || 0) + totalSec);
      }
    }
  }

  return { hostProductiveSec, hostTotalSec };
}

/** Fold live session tabTelemetry (open tabs) into total seconds on top of dailySiteLogs. */
async function foldLiveSessionSecondsIntoHostMap(hostTotalSec) {
  const [sessionData, tabs] = await Promise.all([
    chrome.storage.session.get(['tabTelemetry']),
    chrome.tabs.query({})
  ]);
  const tabTelemetry = sessionData.tabTelemetry || {};
  const tabById = new Map((tabs || []).map((t) => [String(t.id), t]));

  for (const [tabId, tel] of Object.entries(tabTelemetry)) {
    const tab = tabById.get(String(tabId));
    if (!tab?.url) continue;
    const hostname = hostnameFromUrl(tab.url);
    if (!isStartupFillHostAllowed(hostname)) continue;
    const ms = Number(tel?.totalTimeMs) || 0;
    if (ms <= 0) continue;
    hostTotalSec.set(hostname, (hostTotalSec.get(hostname) || 0) + ms / 1000);
  }
}

async function getMostUsedSites(limit = 5) {
  const { dailySiteLogs = {} } = await chrome.storage.local.get('dailySiteLogs');
  const dayKeys = getStartupFillDayKeys();
  const { hostTotalSec } = aggregateHostsFromDailySiteLogs(dailySiteLogs, dayKeys);
  await foldLiveSessionSecondsIntoHostMap(hostTotalSec);

  const rows = [...hostTotalSec.entries()]
    .filter(([, sec]) => sec > 0)
    .sort((a, b) => b[1] - a[1]);

  return {
    sites: rows.slice(0, limit).map(([host]) => host),
    uniqueCount: rows.length,
    dayWindow: STARTUP_FILL_DAY_WINDOW
  };
}

async function getMostProductiveSites(limit = 5) {
  const { dailySiteLogs = {} } = await chrome.storage.local.get('dailySiteLogs');
  const dayKeys = getStartupFillDayKeys();
  const { hostProductiveSec } = aggregateHostsFromDailySiteLogs(dailySiteLogs, dayKeys);

  const rows = [...hostProductiveSec.entries()]
    .filter(([, sec]) => sec > 0)
    .sort((a, b) => b[1] - a[1]);

  return {
    sites: rows.slice(0, limit).map(([host]) => host),
    uniqueCount: rows.length,
    dayWindow: STARTUP_FILL_DAY_WINDOW
  };
}

function applyStartupSlotFillFromSites(sites) {
  const rows = Array.from(document.querySelectorAll('#startupSlotsList .startup-slot-row'));
  const usedDomains = new Set();
  rows.forEach((row) => {
    const type = row.querySelector('.startup-slot-type')?.value;
    const url = row.querySelector('.startup-slot-url')?.value.trim();
    if (type === 'url' && url) {
      const host = hostnameFromUrl(url);
      if (host) usedDomains.add(host);
    }
  });

  let siteIdx = 0;
  let filled = 0;
  rows.forEach((row) => {
    const typeSelect = row.querySelector('.startup-slot-type');
    const urlInput = row.querySelector('.startup-slot-url');
    const lastSelect = row.querySelector('.startup-slot-last-index');
    if (!typeSelect || !urlInput) return;

    const type = typeSelect.value;
    const hasUrl = urlInput.value.trim();
    const isFillable = type === 'empty' || (type === 'url' && !hasUrl);
    if (!isFillable) return;

    while (siteIdx < sites.length) {
      const site = sites[siteIdx++];
      const domain = site.toLowerCase();
      if (usedDomains.has(domain)) continue;
      typeSelect.value = 'url';
      urlInput.value = site;
      urlInput.style.display = '';
      if (lastSelect) lastSelect.style.display = 'none';
      usedDomains.add(domain);
      filled += 1;
      break;
    }
  });

  updateStartupSlotEmptyOptions();
  return filled;
}

function formatStartupFillStatus(filled, tabLimit, dayWindow, label) {
  if (filled >= tabLimit) {
    return `Added ${filled} ${label} site${filled === 1 ? '' : 's'}. Click Confirm to save.`;
  }
  return `Filled ${filled} of ${tabLimit} from your history (last ${dayWindow} days). Click Confirm to save.`;
}

function setFillStartupFromStatsStatus(text, tone = '') {
  const el = $('fillStartupFromStatsStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('is-error', 'is-success');
  if (tone === 'error') el.classList.add('is-error');
  if (tone === 'success') el.classList.add('is-success');
}

function setStartupSlotsConfirmStatus(text, tone = '') {
  const el = $('startupSlotsConfirmStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('is-error', 'is-success');
  if (tone === 'error') el.classList.add('is-error');
  if (tone === 'success') el.classList.add('is-success');
}

function getStartupSlotsValidationErrors() {
  const rows = Array.from(document.querySelectorAll('#startupSlotsList .startup-slot-row'));
  const invalidRows = [];
  rows.forEach((row, idx) => {
    const type = row.querySelector('.startup-slot-type')?.value || 'empty';
    const url = row.querySelector('.startup-slot-url')?.value.trim() || '';
    if (type === 'url' && !url) invalidRows.push({ rowIndex: idx, row });
  });
  return invalidRows;
}

function triggerStartupSlotsConfirmShake(invalidRows = []) {
  const confirmBtn = $('confirmStartupSlots');
  const shakeTargets = [confirmBtn, ...invalidRows.map((entry) => entry.row)];
  shakeTargets.forEach((el) => {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 420);
  });
}

function clearStartupSlotsDraftStatus() {
  setStartupSlotsConfirmStatus('');
}

function normalizeStartupSlots(rawSlots, tabLimit) {
  const limit = Math.max(1, Math.min(Number(tabLimit) || 5, MAX_TAB_LIMIT));
  const slots = Array.isArray(rawSlots) ? rawSlots.map((s) => ({ ...s })) : [];
  while (slots.length < limit) slots.push({ type: 'empty' });
  const normalized = slots.slice(0, limit).map((slot) => {
    if (slot?.type === 'url') {
      return { type: 'url', value: String(slot.value || '').trim() };
    }
    if (slot?.type === 'last_session') {
      const index = Math.max(0, Math.min(limit - 1, Number(slot.index) || 0));
      return { type: 'last_session', index };
    }
    return { type: 'empty' };
  });
  return enforceStartupEmptySuffixRule(normalized);
}

function enforceStartupEmptySuffixRule(slots) {
  return slots.map((slot, idx) => {
    if (slot.type !== 'empty') return slot;
    for (let j = idx + 1; j < slots.length; j++) {
      if (slots[j].type !== 'empty') {
        return { type: 'url', value: '' };
      }
    }
    return slot;
  });
}

function isStartupEmptyAllowedAtIndex(rows, rowIndex) {
  for (let j = rowIndex + 1; j < rows.length; j++) {
    const type = rows[j].querySelector('.startup-slot-type')?.value || 'empty';
    if (type !== 'empty') return false;
  }
  return true;
}

function updateStartupSlotEmptyOptions() {
  const rows = Array.from(document.querySelectorAll('#startupSlotsList .startup-slot-row'));
  rows.forEach((row, idx) => {
    const typeSelect = row.querySelector('.startup-slot-type');
    if (!typeSelect) return;
    const emptyOpt = typeSelect.querySelector('option[value="empty"]');
    if (!emptyOpt) return;
    const allowed = isStartupEmptyAllowedAtIndex(rows, idx);
    emptyOpt.disabled = !allowed;
  });
}

function readStartupSlotsFromUI() {
  const tabLimit = parseInt($('maxTabLimit')?.value, 10) || 5;
  const rows = Array.from(document.querySelectorAll('#startupSlotsList .startup-slot-row'));
  const slots = rows.map((row) => {
    const type = row.querySelector('.startup-slot-type')?.value || 'empty';
    if (type === 'url') {
      return { type: 'url', value: row.querySelector('.startup-slot-url')?.value.trim() || '' };
    }
    if (type === 'last_session') {
      return {
        type: 'last_session',
        index: parseInt(row.querySelector('.startup-slot-last-index')?.value, 10) || 0
      };
    }
    return { type: 'empty' };
  });
  return normalizeStartupSlots(slots, tabLimit);
}

function bindStartupSlotRow(row, tabLimit, rowIndex) {
  const typeSelect = row.querySelector('.startup-slot-type');
  const urlInput = row.querySelector('.startup-slot-url');
  const lastSelect = row.querySelector('.startup-slot-last-index');
  let previousType = typeSelect?.value || 'empty';
  const syncVisibility = () => {
    const type = typeSelect?.value || 'empty';
    if (urlInput) urlInput.style.display = type === 'url' ? '' : 'none';
    if (lastSelect) lastSelect.style.display = type === 'last_session' ? '' : 'none';
  };
  typeSelect?.addEventListener('focus', () => {
    previousType = typeSelect.value;
  });
  typeSelect?.addEventListener('change', () => {
    if (typeSelect.value === 'empty') {
      const rows = Array.from(document.querySelectorAll('#startupSlotsList .startup-slot-row'));
      if (!isStartupEmptyAllowedAtIndex(rows, rowIndex)) {
        typeSelect.value = previousType;
        setStartupSlotsConfirmStatus(STARTUP_SLOTS_VALIDATION_MSG, 'error');
        triggerStartupSlotsConfirmShake([{ row }]);
        return;
      }
    }
    previousType = typeSelect.value;
    syncVisibility();
    updateStartupSlotEmptyOptions();
    clearStartupSlotsDraftStatus();
  });
  urlInput?.addEventListener('input', () => { clearStartupSlotsDraftStatus(); });
  lastSelect?.addEventListener('change', () => { clearStartupSlotsDraftStatus(); });
  if (lastSelect) {
    lastSelect.replaceChildren();
    for (let i = 0; i < tabLimit; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Tab ${i + 1}${i === 0 ? ' (leftmost)' : ''}`;
      lastSelect.appendChild(opt);
    }
  }
  syncVisibility();
}

async function renderStartupSlots(config = {}) {
  const list = $('startupSlotsList');
  if (!list) return;
  setFillStartupFromStatsStatus('');
  setStartupSlotsConfirmStatus('');
  const tabLimit = parseInt($('maxTabLimit')?.value, 10) || Number(config.tabLimit) || 5;
  const limitLabel = $('startupSlotLimitLabel');
  if (limitLabel) limitLabel.textContent = String(tabLimit);
  const slots = normalizeStartupSlots(config.startupSlots, tabLimit);
  list.replaceChildren();
  slots.forEach((slot, idx) => {
    const row = document.createElement('div');
    row.className = 'startup-slot-row';
    const rank = document.createElement('span');
    rank.className = 'startup-slot-rank';
    rank.textContent = String(idx + 1);
    const typeSelect = document.createElement('select');
    typeSelect.className = 'startup-slot-type';
    STARTUP_SLOT_TYPES.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      typeSelect.appendChild(opt);
    });
    typeSelect.value = slot.type === 'url' ? 'url' : slot.type === 'last_session' ? 'last_session' : 'empty';
    const urlInput = document.createElement('input');
    urlInput.className = 'startup-slot-url';
    urlInput.type = 'text';
    urlInput.placeholder = 'youtube.com';
    urlInput.value = slot.type === 'url' ? (slot.value || '') : '';
    const lastSelect = document.createElement('select');
    lastSelect.className = 'startup-slot-last-index';
    if (slot.type === 'last_session') lastSelect.value = String(slot.index ?? idx);
    row.appendChild(rank);
    row.appendChild(typeSelect);
    row.appendChild(urlInput);
    row.appendChild(lastSelect);
    bindStartupSlotRow(row, tabLimit, idx);
    if (slot.type === 'last_session') lastSelect.value = String(slot.index ?? idx);
    list.appendChild(row);
  });
  updateStartupSlotEmptyOptions();
}

async function fillStartupSlotsFromStats() {
  const tabLimit = parseInt($('maxTabLimit')?.value, 10) || 5;
  const { sites, uniqueCount, dayWindow } = await getMostUsedSites(tabLimit);

  if (uniqueCount === 0) {
    setFillStartupFromStatsStatus(
      `No site history in the last ${dayWindow} days yet. Browse a few sites, then try again.`,
      'error'
    );
    return;
  }

  const filled = applyStartupSlotFillFromSites(sites);
  if (filled > 0) {
    setFillStartupFromStatsStatus(
      formatStartupFillStatus(filled, tabLimit, dayWindow, 'most-used'),
      'success'
    );
    clearStartupSlotsDraftStatus();
    return;
  }

  setFillStartupFromStatsStatus('All slots are already filled.', 'error');
}

async function fillStartupSlotsFromProductiveStats() {
  const tabLimit = parseInt($('maxTabLimit')?.value, 10) || 5;
  const { sites, uniqueCount, dayWindow } = await getMostProductiveSites(tabLimit);

  if (uniqueCount === 0) {
    setFillStartupFromStatsStatus(
      `No productive site history in the last ${dayWindow} days yet. Browse some productive sites, then try again.`,
      'error'
    );
    return;
  }

  const filled = applyStartupSlotFillFromSites(sites);
  if (filled > 0) {
    setFillStartupFromStatsStatus(
      formatStartupFillStatus(filled, tabLimit, dayWindow, 'productive'),
      'success'
    );
    clearStartupSlotsDraftStatus();
    return;
  }

  setFillStartupFromStatsStatus('All slots are already filled.', 'error');
}

async function confirmStartupSlots() {
  if (!$('resetSessionCheck')?.checked) return;
  const invalidRows = getStartupSlotsValidationErrors();
  if (invalidRows.length > 0) {
    setStartupSlotsConfirmStatus(STARTUP_SLOTS_VALIDATION_MSG, 'error');
    triggerStartupSlotsConfirmShake(invalidRows);
    invalidRows[0].row?.querySelector('.startup-slot-url')?.focus();
    return;
  }

  await autoSave('startupSlotsConfirm');
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (win) {
    await chrome.runtime.sendMessage({ action: 'syncLastSessionTabs', windowId: win.id }).catch(() => {});
  }

  const btn = $('confirmStartupSlots');
  if (btn) {
    const originalText = btn.textContent;
    btn.textContent = 'Confirmed!';
    btn.style.background = '#28a745';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
    }, 2000);
  }
  setStartupSlotsConfirmStatus('Startup tabs saved for next session.', 'success');
}

function wipeIntervalUsesPreferredTime(interval) {
  return interval === '1d' || interval === '3d' || interval === '1w';
}

function bindInlineHelpPanels() {
  document.querySelectorAll('.pf-inline-help-btn[aria-controls]').forEach((btn) => {
    if (btn.dataset.helpBound === '1') return;
    btn.dataset.helpBound = '1';
    const panelId = btn.getAttribute('aria-controls');
    const panel = panelId ? $(panelId) : null;
    if (!panel) return;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = btn.getAttribute('aria-expanded') === 'true';
      const nextOpen = !open;
      btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      panel.style.display = nextOpen ? 'block' : 'none';
    });
  });
}

function updateWipeTabTimesAtRowState() {
  const interval = $('wipeTabTimesInterval')?.value || '1w';
  const row = $('wipeTabTimesAtRow');
  const input = $('wipeTabTimesAt');
  const enabled = wipeIntervalUsesPreferredTime(interval);
  // Per user spec 2026-07: fully hide the preferred-reset-time row when the
  // interval is under one day — "Preferred reset time" is meaningless if
  // the reset fires multiple times per day. The row previously stayed
  // visible but disabled, which looked broken.
  if (row) {
    row.classList.toggle('is-disabled', !enabled);
    row.style.display = enabled ? '' : 'none';
  }
  if (input) input.disabled = !enabled;
}

function updateWipeTabTimesVisibility() {
  const container = $('wipeTabTimesContainer');
  if (!container) return;
  container.style.display = getSelectedRankingMode() === 'tab' ? 'block' : 'none';
}

function isTutorialWipeTabTimesStep() {
  return currentStep === 6 && document.body.classList.contains('tutorial-active');
}

function syncWipeTabTimesContainerUi(wipeUiOn) {
  const container = $('wipeTabTimesContainer');
  if (!container) return;
  if (isTutorialWipeTabTimesStep()) {
    container.classList.remove('active');
    container.classList.add('inactive');
    return;
  }
  container.classList.toggle('active', wipeUiOn);
  container.classList.toggle('inactive', !wipeUiOn);
}

async function maybeAdvanceTutorialWipeTabTimesStep() {
  if (currentStep !== 6) return;

  const enabled = $('enableWipeTabTimes')?.checked === true;
  const textEl = $('tutorText');
  const stepText = steps[7]?.text || '';

  if (!enabled) {
    if (textEl) textEl.innerText = stepText;
    await chrome.storage.local.set({ tutorialWipeTabTimesConfigured: false });
    await updateTutorNextState();
    scheduleTutorialWipeStepTutorReposition();
    return;
  }

  const wipeSection = $('wipeTabTimesSection');
  if (wipeSection) wipeSection.style.display = 'block';
  if (textEl) textEl.innerText = 'Great. Click Next to continue.';
  await chrome.storage.local.set({ tutorialWipeTabTimesConfigured: true });
  await updateTutorNextState();
  scheduleTutorialWipeStepTutorReposition();
}

function scheduleTutorialStepLayoutRefresh() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshTutorialStepScroll();
    });
  });
}

let rankDemoPaused = false;
let pfPreviewDevForceShow = false;
const RANK_DEMO_CYCLE_MS = 24000;

function getRankDemoPhaseMs(root) {
  if (!root) return 0;
  const frame = root.querySelector('.pf-rank-demo-frame');
  if (!frame || typeof frame.getAnimations !== 'function') return 0;
  for (const anim of frame.getAnimations()) {
    const name = String(anim.animationName || '');
    if (name.includes('pfRankDemoFrame') && anim.currentTime != null) {
      return Number(anim.currentTime) % RANK_DEMO_CYCLE_MS;
    }
  }
  return 0;
}

function applyRankDemoPhase(root, phaseMs) {
  if (!root) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const normalized = ((phaseMs % RANK_DEMO_CYCLE_MS) + RANK_DEMO_CYCLE_MS) % RANK_DEMO_CYCLE_MS;
  const delayMs = -normalized;
  root.querySelectorAll('.pf-rank-demo-frame, .pf-rank-demo-caption').forEach((node) => {
    node.style.animationDelay = `${delayMs}ms`;
  });
}

function syncOpenRankDemoModalPhase() {
  const modal = $('rankingModeDemoModal');
  if (!modal?.classList.contains('is-open')) return;
  const source = $('rankingModeDemoShell')?.querySelector('.pf-rank-demo.is-visible');
  const clone = $('rankingModeDemoModalBody')?.querySelector('.pf-rank-demo');
  if (!source || !clone) return;
  applyRankDemoPhase(clone, getRankDemoPhaseMs(source));
}

function syncRankDemoPauseButtons() {
  const label = rankDemoPaused ? 'Resume animation' : 'Pause animation';
  const icon = rankDemoPaused ? '▶' : '⏸';
  ['rankingModeDemoPause', 'rankingModeDemoModalPause'].forEach((id) => {
    const btn = $(id);
    if (!btn) return;
    btn.setAttribute('aria-pressed', rankDemoPaused ? 'true' : 'false');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const iconEl = btn.querySelector('.pf-rank-demo-pause-icon');
    if (iconEl) iconEl.textContent = icon;
  });
}

function setRankDemoPaused(paused) {
  rankDemoPaused = paused;
  document.querySelectorAll('#rankingModeDemoShell .pf-rank-demo, #rankingModeDemoModalBody .pf-rank-demo').forEach((el) => {
    el.classList.toggle('is-paused', paused);
  });
  syncRankDemoPauseButtons();
}

function toggleRankDemoPause() {
  setRankDemoPaused(!rankDemoPaused);
}

function bindRankingModeDemoPause() {
  ['rankingModeDemoPause', 'rankingModeDemoModalPause'].forEach((id) => {
    const btn = $(id);
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => toggleRankDemoPause());
  });
  syncRankDemoPauseButtons();
}

function openRankingModeDemoModal() {
  const shell = $('rankingModeDemoShell');
  const modal = $('rankingModeDemoModal');
  const body = $('rankingModeDemoModalBody');
  const title = $('rankingModeDemoModalTitle');
  const source = shell?.querySelector('.pf-rank-demo.is-visible');
  if (!modal || !body || !source) return;
  const mode = getSelectedRankingMode();
  if (title) title.textContent = mode === 'website' ? 'Per website preview' : 'Per tab preview';
  body.innerHTML = '';
  const clone = source.cloneNode(true);
  clone.removeAttribute('id');
  clone.hidden = false;
  clone.classList.add('is-visible');
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  body.appendChild(clone);
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('pf-rank-demo-modal-open');
  setRankDemoPaused(rankDemoPaused);
  requestAnimationFrame(() => {
    applyRankDemoPhase(clone, getRankDemoPhaseMs(source));
  });
}

function closeRankingModeDemoModal() {
  const modal = $('rankingModeDemoModal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('pf-rank-demo-modal-open');
  const body = $('rankingModeDemoModalBody');
  if (body) body.innerHTML = '';
}

function bindRankingModeDemoExpand() {
  const btn = $('rankingModeDemoExpand');
  const modal = $('rankingModeDemoModal');
  const modalClose = $('rankingModeDemoModalClose');
  const scrim = modal?.querySelector('.pf-rank-demo-modal-scrim');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => openRankingModeDemoModal());
  if (modalClose) modalClose.addEventListener('click', () => closeRankingModeDemoModal());
  if (scrim) scrim.addEventListener('click', () => closeRankingModeDemoModal());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal?.classList.contains('is-open')) closeRankingModeDemoModal();
  });
}

const RANK_DEMO_DISMISS_MODES_KEY = 'pfRankingDemoDismissedModes';

function readRankDemoDismissedModes() {
  try {
    if (localStorage.getItem('pfRankingDemoDismissed') === '1') {
      return { tab: true, website: true };
    }
    const raw = localStorage.getItem(RANK_DEMO_DISMISS_MODES_KEY);
    if (!raw) return { tab: false, website: false };
    const parsed = JSON.parse(raw);
    return { tab: !!parsed.tab, website: !!parsed.website };
  } catch (_) {
    return { tab: false, website: false };
  }
}

function writeRankDemoDismissedModes(modes) {
  try {
    localStorage.removeItem('pfRankingDemoDismissed');
    localStorage.setItem(RANK_DEMO_DISMISS_MODES_KEY, JSON.stringify({
      tab: !!modes.tab,
      website: !!modes.website
    }));
  } catch (_) {}
}

function dismissRankDemoForMode(mode) {
  pfPreviewDevForceShow = false;
  setSettingDemoDevForceShow(false);
  // Per user report 2026-07: clicking X on the ranking preview only
  // dismissed the currently-selected mode, so switching between "Per
  // tab" and "Per website" brought the preview right back. Dismiss BOTH
  // modes on any X click — one gesture means "I understand this feature,
  // hide the preview permanently."
  writeRankDemoDismissedModes({ tab: true, website: true });
  $('rankingModeDemoShell')?.classList.remove('is-force-visible');
}

function areAllRankDemoModesDismissed() {
  const modes = readRankDemoDismissedModes();
  return modes.tab && modes.website;
}

function isRankDemoModeDismissed(mode) {
  const modes = readRankDemoDismissedModes();
  return mode === 'website' ? modes.website : modes.tab;
}

function bindRankingModeDemoDismiss() {
  const shell = $('rankingModeDemoShell');
  const closeBtn = $('rankingModeDemoClose');
  if (!shell || !closeBtn || closeBtn.dataset.bound === '1') return;
  closeBtn.dataset.bound = '1';
  closeBtn.addEventListener('click', () => {
    closeRankingModeDemoModal();
    dismissRankDemoForMode(getSelectedRankingMode());
    void updateRankingModeDemoVisibility();
  });
}

async function updateRankingModeDemoVisibility(options = {}) {
  const forceShow = options.forceShow === true || pfPreviewDevForceShow;
  const shell = $('rankingModeDemoShell');
  if (!shell) return;
  if (!forceShow && areAllRankDemoModesDismissed()) {
    shell.classList.add('is-dismissed');
    shell.hidden = true;
    closeRankingModeDemoModal();
    return;
  }
  const tutorialDone = forceShow || await isTutorialCompleted();
  if (!tutorialDone) {
    shell.hidden = true;
    shell.classList.remove('is-dismissed');
    closeRankingModeDemoModal();
    return;
  }
  const mode = getSelectedRankingMode();
  if (!forceShow && isRankDemoModeDismissed(mode)) {
    shell.hidden = true;
    shell.classList.remove('is-dismissed');
    closeRankingModeDemoModal();
    return;
  }
  shell.hidden = false;
  shell.classList.remove('is-dismissed');
  shell.removeAttribute('hidden');
  shell.classList.toggle('is-force-visible', forceShow);
  restartActiveRankDemoIfVisible();
}

function showRankingDemoShellForced() {
  pfPreviewDevForceShow = true;
  setSettingDemoDevForceShow(true);
  closeRankingModeDemoModal();
  setRankDemoPaused(false);
  syncRankingModeDemo({ skipVisibility: true });
  const shell = $('rankingModeDemoShell');
  if (!shell) return;
  shell.removeAttribute('hidden');
  shell.hidden = false;
  shell.classList.remove('is-dismissed');
  shell.classList.add('is-force-visible');
  const mode = getSelectedRankingMode();
  const tabDemo = $('rankingModeDemoTab');
  const webDemo = $('rankingModeDemoWebsite');
  if (tabDemo) {
    const show = mode === 'tab';
    tabDemo.hidden = !show;
    tabDemo.classList.toggle('is-visible', show);
  }
  if (webDemo) {
    const show = mode === 'website';
    webDemo.hidden = !show;
    webDemo.classList.toggle('is-visible', show);
  }
  restartActiveRankDemoIfVisible();
}

async function initRankingModeDemoShell() {
  await updateRankingModeDemoVisibility();
  bindRankingModeDemoExpand();
  bindRankingModeDemoPause();
  bindRankingModeDemoDismiss();
}

/** Dev-only: show ranking preview again and restart its animation (ignores tutorial + dismiss). */
function resetRankingModeDemoForDev() {
  try {
    localStorage.removeItem('pfRankingDemoDismissed');
    localStorage.removeItem(RANK_DEMO_DISMISS_MODES_KEY);
  } catch (_) {}
  showRankingDemoShellForced();
  switchMainTab('window');
  const target = $('rankingModeContainer') || $('rankingModeDemoShell');
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function restartRankDemoAnimation(root) {
  if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.pf-rank-demo-frame, .pf-rank-demo-caption').forEach((node) => {
    node.style.animation = 'none';
    node.style.animationDelay = '';
    node.style.opacity = '';
  });
  void root.offsetHeight;
  root.querySelectorAll('.pf-rank-demo-frame, .pf-rank-demo-caption').forEach((node) => {
    node.style.animation = '';
  });
  applyRankDemoPhase(root, 0);
  syncOpenRankDemoModalPhase();
}

function restartActiveRankDemoIfVisible() {
  const shell = $('rankingModeDemoShell');
  if (!shell || shell.hidden || shell.classList.contains('is-dismissed')) return;
  const mode = getSelectedRankingMode();
  const activeDemo = mode === 'website' ? $('rankingModeDemoWebsite') : $('rankingModeDemoTab');
  if (!activeDemo?.classList.contains('is-visible') || activeDemo.hidden) return;
  requestAnimationFrame(() => restartRankDemoAnimation(activeDemo));
}

function syncRankingModeDemo(options = {}) {
  const mode = getSelectedRankingMode();
  const tabDemo = $('rankingModeDemoTab');
  const webDemo = $('rankingModeDemoWebsite');
  if (tabDemo) {
    const show = mode === 'tab';
    tabDemo.classList.toggle('is-visible', show);
    tabDemo.hidden = !show;
  }
  if (webDemo) {
    const show = mode === 'website';
    webDemo.classList.toggle('is-visible', show);
    webDemo.hidden = !show;
  }
  const modal = $('rankingModeDemoModal');
  if (modal?.classList.contains('is-open')) openRankingModeDemoModal();
  if (!options.skipVisibility) {
    void updateRankingModeDemoVisibility({ forceShow: pfPreviewDevForceShow });
  } else {
    restartActiveRankDemoIfVisible();
  }
}

async function setAdvancedSettingsExpanded(expanded, { persist = true } = {}) {
  const checkbox = $('enableLimits');
  const section = $('advancedLimitsSection');
  if (checkbox && checkbox.checked !== expanded) checkbox.checked = expanded;
  if (section) {
    section.style.display = expanded ? 'block' : 'none';
    section.classList.toggle('is-expanded', expanded);
    section.setAttribute('aria-hidden', expanded ? 'false' : 'true');
  }
  if (persist) {
    await chrome.storage.local.set({ advancedSettingsExpanded: expanded });
  }
  try {
    await refreshSettingDemoVisibility();
  } catch (_) {}
}

// ── Advanced Settings first-day lock (user spec 2026-07 v8) ────────────────
// New installs can't open Advanced Settings for the first day — the row
// grays out and shows a live countdown to the unlock. Learn the basics
// first; the power tools come later. Existing users' install stamp is
// backdated by the worker, so they're never locked. The tutorial is exempt
// (its steps reveal sections themselves).
// Lock reduced from 24h → 30min → 10min → 2min → 1min per user spec
// 2026-07 v49. Countdown anchors to pfTutorialFinishedAt (stamped
// exactly once inside finishTutorial), so the lock is a one-shot event
// that fires only after the user clicks Finish. Reloading the dashboard
// after Finish doesn't restart the clock — the stamp persists and 1min
// from that fixed moment is either past or not.
const PF_ADV_UNLOCK_MS = 1 * 60 * 1000;
let pfAdvLockTimer = null;

async function pfAdvancedSettingsLockedNow() {
  // FAIL CLOSED (user report 2026-07: "worked for 5 min before locking"):
  // if the install stamp hasn't landed yet (cold worker on a fresh
  // install), stamp it HERE and treat the device as freshly installed —
  // the old behavior read a missing stamp as "unlocked", giving brand-new
  // users a free window until the worker caught up.
  {
    const { pfInstalledAt } = await chrome.storage.local.get('pfInstalledAt');
    if (!Number(pfInstalledAt)) {
      await chrome.storage.local.set({ pfInstalledAt: Date.now() }).catch(() => {});
      return true;
    }
  }
  if (document.body.classList.contains('tutorial-active')) return false;
  try {
    const stored = await chrome.storage.local.get([
      'pfInstalledAt',
      'pfTutorialFinishedAt',
      'tutorialCompleted',
      'tutorialComplete'
    ]);
    const tutorialDone = stored.tutorialCompleted === true || stored.tutorialComplete === true;
    // If the tutorial hasn't been finished yet, keep the row locked —
    // Advanced Settings shouldn't be accessible pre-onboarding.
    if (!tutorialDone) return true;
    const finishedAt = Number(stored.pfTutorialFinishedAt) || 0;
    if (finishedAt <= 0) {
      // Tutorial completed on an older build that didn't stamp the finish
      // time. Stamp it now so the countdown starts here and stays
      // consistent across reloads.
      const now = Date.now();
      await chrome.storage.local.set({ pfTutorialFinishedAt: now }).catch(() => {});
      return Date.now() < now + PF_ADV_UNLOCK_MS;
    }
    return Date.now() < finishedAt + PF_ADV_UNLOCK_MS;
  } catch (_) { return false; }
}

/**
 * Returns the timestamp the countdown display should count DOWN from.
 * Prefers tutorial finish (that's when the user actually earned the
 * "waiting for basics" clock); falls back to install stamp for older
 * users whose tutorialFinishedAt was never recorded. Returns 0 if
 * nothing is set (locked state shouldn't render a stale countdown).
 */
async function pfAdvancedSettingsLockAnchorMs() {
  try {
    const { pfTutorialFinishedAt, pfInstalledAt } = await chrome.storage.local.get([
      'pfTutorialFinishedAt', 'pfInstalledAt'
    ]);
    const finishedAt = Number(pfTutorialFinishedAt) || 0;
    if (finishedAt > 0) return finishedAt;
    return Number(pfInstalledAt) || 0;
  } catch (_) { return 0; }
}

async function pfSyncAdvancedSettingsLock() {
  const row = $('advancedOptionsRow');
  const checkbox = $('enableLimits');
  if (!row || !checkbox) return;
  const locked = await pfAdvancedSettingsLockedNow();
  row.classList.toggle('pf-adv-locked', locked);
  checkbox.disabled = locked;
  let note = $('pfAdvUnlockNote');
  if (locked) {
    if (!note) {
      note = document.createElement('span');
      note.id = 'pfAdvUnlockNote';
      note.style.cssText = 'font-size:0.82em;font-weight:700;color:#8a86a0;white-space:nowrap;flex:0 0 auto;';
      row.appendChild(note);
    }
    const anchor = await pfAdvancedSettingsLockAnchorMs();
    const left = anchor > 0 ? Math.max(0, anchor + PF_ADV_UNLOCK_MS - Date.now()) : PF_ADV_UNLOCK_MS;
    const d = Math.floor(left / 86400000);
    const h = Math.floor((left % 86400000) / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    const s = Math.floor((left % 60000) / 1000);
    // 2-minute lock: show seconds under 1 minute so the countdown feels
    // alive instead of stuck on "0min".
    const label = d > 0 ? `${d}d ${h}h`
      : h > 0 ? `${h}h ${m}min`
      : m > 0 ? `${m}min`
      : `${s}s`;
    note.textContent = `🔒 Unlocks in ${label}`;
    // Force-collapse if it was somehow open (e.g. flag written mid-session).
    if (checkbox.checked) void setAdvancedSettingsExpanded(false, { persist: false });
    if (!pfAdvLockTimer) {
      // 1s tick so the sub-60s portion of the countdown ("42s" → "41s")
      // actually moves — a 60s tick made the last minute feel frozen.
      pfAdvLockTimer = setInterval(() => { void pfSyncAdvancedSettingsLock(); }, 1000);
    }
  } else {
    note?.remove();
    if (pfAdvLockTimer) { clearInterval(pfAdvLockTimer); pfAdvLockTimer = null; }
  }

  // ALSO lock the Advanced Earn/Spend card (user report 2026-07: "worked
  // for 5 min before locking — meant to be locked immediately"). The card
  // was moved OUT of the Advanced-settings collapsible, which silently
  // removed it from this lock's coverage — new users could use it freely.
  const advCard = $('advancedEarnSpendBlock');
  if (advCard) {
    advCard.style.opacity = locked ? '0.55' : '';
    advCard.style.pointerEvents = locked ? 'none' : '';
    advCard.setAttribute('aria-disabled', locked ? 'true' : 'false');
    let cardNote = $('pfAdvEarnLockNote');
    if (locked) {
      if (!cardNote) {
        cardNote = document.createElement('div');
        cardNote.id = 'pfAdvEarnLockNote';
        cardNote.style.cssText = 'margin:0 0 10px;padding:8px 12px;border-radius:8px;'
          + 'background:#f3f0fc;border:1px solid #d8d0f0;color:#4A3D85;'
          + 'font-size:0.88em;font-weight:700;';
        advCard.prepend(cardNote);
      }
      const anchor = await pfAdvancedSettingsLockAnchorMs();
      const left = anchor > 0 ? Math.max(0, anchor + PF_ADV_UNLOCK_MS - Date.now()) : PF_ADV_UNLOCK_MS;
      const d = Math.floor(left / 86400000);
      const h = Math.floor((left % 86400000) / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const s = Math.floor((left % 60000) / 1000);
      const label = d > 0 ? `${d}d ${h}h`
        : h > 0 ? `${h}h ${m}min`
        : m > 0 ? `${m}min`
        : `${s}s`;
      cardNote.textContent = `🔒 Advanced Earn/Spend unlocks in ${label} — get comfortable with the basics first.`;
      // AUTHORITATIVE LOCK (user report 2026-07: "Advanced Earn/Spend
      // immediately turned on when I just signed in"). Beyond graying the
      // UI, actively force `advancedBankedTimeEnabled: false` on every
      // window config in storage so any value that slipped past the two
      // sync gates (worker.js pfPullSettingsFromProfile + sync.js
      // stripAdvancedEarnIfLocked) gets corrected in place on the next
      // dashboard render. Fire-and-forget — the worker's next tick reads
      // the corrected value.
      try {
        const stored = await chrome.storage.local.get('windowConfigs');
        const configs = stored.windowConfigs || {};
        let mutated = false;
        const next = {};
        for (const wn of Object.keys(configs)) {
          const cfg = configs[wn];
          if (cfg && typeof cfg === 'object' && cfg.advancedBankedTimeEnabled === true) {
            next[wn] = { ...cfg, advancedBankedTimeEnabled: false };
            mutated = true;
          } else {
            next[wn] = cfg;
          }
        }
        if (mutated) {
          await chrome.storage.local.set({ windowConfigs: next });
          console.info('[pf-adv-lock] force-cleared advancedBankedTimeEnabled on locked configs');
        }
      } catch (_) { /* best-effort */ }
    } else {
      cardNote?.remove();
    }
  }
}

function bindAdvancedSettingsToggle() {
  const row = $('advancedOptionsRow');
  const checkbox = $('enableLimits');
  if (!row || !checkbox || row.dataset.advBound === '1') return;
  row.dataset.advBound = '1';
  row.style.cursor = 'pointer';
  const syncFromCheckbox = () => {
    if (checkbox.disabled) { checkbox.checked = false; return; }
    void setAdvancedSettingsExpanded(checkbox.checked);
  };
  checkbox.addEventListener('change', syncFromCheckbox);
  const label = row.querySelector('label[for="enableLimits"]');
  label?.addEventListener('click', () => {
    queueMicrotask(syncFromCheckbox);
  });
  row.addEventListener('click', (event) => {
    if (event.target.closest('button, a, label')) return;
    if (checkbox.disabled) return; // locked — countdown explains why
    checkbox.checked = !checkbox.checked;
    syncFromCheckbox();
  });
  void pfSyncAdvancedSettingsLock();
}

function bindResetPreviewsButton() {
  const btn = $('resetRankingDemoBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    resetRankingModeDemoForDev();
    resetAllSettingDemosForDev();
  });
}

// User spec 2026-07 v40: Reorder Tabs toggle sits next to Unproductive
// Tab Closer. Defaults ON (matches the previous unconditional behavior)
// so existing users don't lose the reordering they were used to. When
// OFF, the worker skips reorderTabsByEngagement entirely — tabs stay
// wherever the user drags them.
async function bindReorderTabsToggle() {
  const toggle = document.getElementById('reorderTabsToggle');
  if (!toggle || toggle.dataset.pfBound === '1') return;
  toggle.dataset.pfBound = '1';
  const KEY = 'pfReorderTabsEnabled';
  try {
    const stored = await chrome.storage.local.get(KEY);
    // Default true — same behavior as before the toggle existed.
    toggle.checked = stored[KEY] !== false;
  } catch (_) { toggle.checked = true; }
  toggle.addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ [KEY]: toggle.checked === true });
    } catch (e) {
      console.warn('[pf-reorder-toggle] save failed', e);
    }
  });
}

function getSelectedRankingMode() {
  return document.querySelector('input[name="rankingMode"]:checked')?.value === 'website' ? 'website' : 'tab';
}

async function applyRankingModeChange() {
  const mode = getSelectedRankingMode();
  updateWipeTabTimesVisibility();
  syncRankingModeDemo();
  if (mode === confirmedRankingMode) return;
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (!win) return;
  await chrome.runtime.sendMessage({ action: 'saveWindowConfig', windowId: win.id, updates: { rankingMode: mode } });
  await chrome.runtime.sendMessage({ action: 'reorderTabsNow', windowId: win.id }).catch(() => {});
  confirmedRankingMode = mode;
}

async function renderStartupList() {
  const win = await chrome.windows.getCurrent();
  const configResponse = await chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id });
  const currentConfig = configResponse?.config || {};
  await renderStartupSlots(currentConfig);
}

/**
 * Gray out (or restore) the dashboard controls that conflict with Advanced
 * Earn/Spend. Called directly from the toggle's change handler so the gray-out
 * is INSTANT and does NOT depend on a service-worker round-trip succeeding
 * (refreshCloserToggleUI reads config from the SW, which silently no-ops when
 * the worker is cold/dead — leaving the controls unlocked). This reads the
 * checkbox state itself, so it always reflects what the user just did.
 *
 * `locked` is optional; when omitted it's read from the checkbox, so callers
 * can invoke applyAdvancedEarnLock() with no args to sync to current state.
 */
function applyAdvancedEarnLock(locked) {
  const isLocked = (typeof locked === 'boolean')
    ? locked
    : !!$('enableBankedTimeModeB')?.checked;
  // Advanced Earn/Spend no longer locks the Work Timer or its inputs
  // (user spec 2026-07). Only the enforcer and the unprod/study timer
  // start buttons remain locked.
  const controls = [
    'enforcerToggle', 'studyTimerStartBtn', 'unprodTimerStartBtn'
  ];
  for (const id of controls) {
    const el = $(id);
    if (!el) continue;
    el.disabled = isLocked;
    el.style.opacity = isLocked ? '0.5' : '1';
    el.style.pointerEvents = isLocked ? 'none' : '';
    if (isLocked) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  }
  const enforcerLabel = $('enforcerToggle')?.parentElement;
  if (enforcerLabel) {
    enforcerLabel.style.opacity = isLocked ? '0.4' : '1';
    enforcerLabel.style.pointerEvents = isLocked ? 'none' : '';
    enforcerLabel.style.cursor = isLocked ? 'not-allowed' : 'pointer';
  }
  const slider = document.getElementById('enforcerSlider');
  if (slider) slider.style.filter = isLocked ? 'grayscale(1)' : '';
}

async function refreshCloserToggleUI() {
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (!win?.id) return;
  const configResponse = await chrome.runtime.sendMessage({
    action: 'getWindowConfig',
    windowId: win.id
  }).catch(() => null);
  const config = configResponse?.config;
  if (!config) return;

  const windowName = await resolveWindowName(win.id);
  const { timerSessionActive, timerActivelyRunning, timerMode } = await getWallClockTimerUiFlags(win.id);
  const { bankSpendActive, bankSpendPaused, bankSpendSourceHost, bankFocusActive } = await chrome.storage.local.get([
    'bankSpendActive', 'bankSpendPaused', 'bankSpendSourceHost', 'bankFocusActive'
  ]);
  // SELF-HEAL PHANTOM SPEND LOCK (2026-07): if bankSpendActive[wn] lingers
  // from a crashed / half-closed session while Advanced Earn/Spend is OFF
  // AND it isn't a legit Work-Timer break (which reuses the spend keys with
  // sourceHost='study_break') AND no wall-clock timer session is running,
  // the closer toggle silently reverts every click — user report: "the
  // unproductive tab closer toggle won't turn off." Wipe the ghost keys
  // once and continue with a clean lock state. Confirmed by user this
  // periodic pass is the version that actually fixes the reported bug.
  const advancedOnForHeal = config.advancedBankedTimeEnabled === true;
  const spendIsStudyBreakForHeal = bankSpendSourceHost?.[windowName] === 'study_break';
  if (
    windowName
    && bankSpendActive?.[windowName]
    && !advancedOnForHeal
    && !spendIsStudyBreakForHeal
    && !timerSessionActive
  ) {
    console.warn('[pf-enforcer] self-heal: clearing phantom bankSpendActive', { windowName });
    try {
      const nextActive = { ...(bankSpendActive || {}) };
      const nextPaused = { ...(bankSpendPaused || {}) };
      const nextSource = { ...(bankSpendSourceHost || {}) };
      delete nextActive[windowName];
      delete nextPaused[windowName];
      delete nextSource[windowName];
      await chrome.storage.local.set({
        bankSpendActive: nextActive,
        bankSpendPaused: nextPaused,
        bankSpendSourceHost: nextSource
      });
      bankSpendActive[windowName] = undefined;
    } catch (e) {
      console.warn('[pf-enforcer] phantom clear failed', e);
    }
  }
  const spendSessionLocksToggle = !!(
    windowName
    && bankSpendActive?.[windowName]
    && !bankSpendPaused?.[windowName]
  );
  // ORIGIN of the active spend session: the Work Timer's break reuses the
  // advanced bankSpend* keys (tagged 'study_break') so the floating pill
  // renders both identically — but the LOCK MESSAGE must attribute it to
  // the right feature. A Work Timer break saying "Turn off Advanced
  // Earn/Spend" made the user think advanced had switched itself on
  // (user report 2026-07).
  const spendIsStudyBreak = spendSessionLocksToggle
    && bankSpendSourceHost?.[windowName] === 'study_break';
  const spendLockMessage = spendIsStudyBreak
    ? 'Break in progress — it ends on its own, or stop it from the Work Timer.'
    : 'Turn off Advanced Earn/Spend to use this.';
  // A break timer session does NOT lock the toggle/buttons — breaks are the
  // reward phase and don't conflict with the closer. Only study/unprod sessions
  // (or a spend session / advanced earn) lock the controls.
  const locksForTimer = timerSessionActive && timerMode !== 'break';
  // Only the Advanced Earn/Spend toggle (advancedBankedTimeEnabled) locks the
  // closer toggle + study timers/break. The separate basic "Focused Time Banked"
  // toggle (bankedTimeEnabled) does NOT — checking both meant turning off
  // Advanced Earn/Spend left everything locked while Focused Time Banked was on.
  const advancedEarnOn = config.advancedBankedTimeEnabled === true;
  // STUDY-FORCES-ON (user spec 2026-07): while the Work Timer runs the closer
  // MUST be on so unproductive tabs get closed. Force the toggle to ON and
  // lock it — the user can't turn it off mid-session. When the timer ends
  // (Stop or natural expiry) the worker flips limitsEnabled back to false,
  // so the toggle drops back to OFF and the user regains manual control.
  const studyForcesToggleOn = locksForTimer;
  // The enforcer (closer) toggle should remain usable while a break timer runs
  // (breaks don't need the closer). It IS locked by: an active spend session,
  // OR a running study session (forced ON — see studyForcesToggleOn).
  const toggleLocked = spendSessionLocksToggle || studyForcesToggleOn;
  // The timer START buttons are blocked by a running timer or a spend session.
  // Advanced Earn/Spend no longer locks the Work Timer (user spec 2026-07).
  const startButtonsLocked = locksForTimer || spendSessionLocksToggle;
  const limEn = config.limitsEnabled === true;
  // Reason shown when the enforcer toggle / a start button is clicked while locked.
  const toggleLockMessage = studyForcesToggleOn
    ? 'Work Timer is on — closer stays on until the timer ends.'
    : spendSessionLocksToggle
      ? spendLockMessage
      : advancedEarnOn
        ? 'Turn off Advanced Earn/Spend to use this.'
        : '';
  // Reason shown when a START button is clicked while locked.
  const startLockMessage = locksForTimer
    ? 'A timer is already running — stop it first'
    : spendSessionLocksToggle
      ? spendLockMessage
      : advancedEarnOn
        ? 'Turn off Advanced Earn/Spend to use this.'
        : '';

  // Idempotency: this runs on EVERY closer-state broadcast (which fires every
  // second on timer ticks), so re-applying disabled/opacity/pointerEvents each
  // time makes the buttons visibly flicker. Skip the whole re-style block when
  // the lock state, the toggle value, and the message haven't changed.
  const lockSignature = `${toggleLocked ? 1 : 0}|${startButtonsLocked ? 1 : 0}|${limEn ? 1 : 0}|${studyForcesToggleOn ? 1 : 0}|${toggleLockMessage}|${startLockMessage}`;
  if (lastToggleLockSignature === lockSignature) return;
  lastToggleLockSignature = lockSignature;

  if ($('enforcerToggle')) {
    // During the "Closer toggle" (currentStep === 7) and "Floating button"
    // (currentStep === 8) tutorial steps, the tutorial owns the checkbox
    // transiently. Do NOT reset it to the stale stored limitsEnabled here —
    // that snapped the toggle back OFF the instant the user turned it ON.
    // (This runs frequently via storage/timer refreshes, so it overrode the
    // renderWindowSettings guard.)
    if (currentStep !== 7 && currentStep !== 8) {
      // STUDY-FORCES-ON: while a Work Timer study session is live, force the
      // checkbox visually ON (matches limitsEnabled which the worker also
      // pinned true on session start). Otherwise the spend-lock branch
      // forces OFF, and the idle branch honors the stored limEn.
      $('enforcerToggle').checked = studyForcesToggleOn
        ? true
        : (spendSessionLocksToggle ? false : limEn);
    }
    $('enforcerToggle').disabled = toggleLocked;
    if (toggleLocked) {
      $('enforcerToggle').setAttribute('aria-disabled', 'true');
      $('enforcerToggle').setAttribute('aria-describedby', 'enforcerHelpText');
      $('enforcerToggle').setAttribute('data-pf-locked', toggleLockMessage || '1');
    } else {
      $('enforcerToggle').removeAttribute('aria-disabled');
      $('enforcerToggle').removeAttribute('aria-describedby');
      $('enforcerToggle').removeAttribute('data-pf-locked');
    }
    const enforcerLabel = $('enforcerToggle').parentElement;
    // Per user spec 2026-07: when Advanced Earn/Spend is on, HIDE the toggle
    // entirely rather than graying it out — the "Turn off Advanced Earn/Spend
    // to use this." note beside it is the only signpost the user needs.
    // Other lock reasons (spend-session, timer running) still gray-out.
    const hideToggleForAdvEarn = advancedEarnOn;
    if (enforcerLabel) {
      enforcerLabel.style.display = hideToggleForAdvEarn ? 'none' : '';
      enforcerLabel.style.opacity = hideToggleForAdvEarn ? '' : (toggleLocked ? '0.4' : '1');
      enforcerLabel.style.pointerEvents = toggleLocked ? 'none' : '';
      enforcerLabel.style.cursor = toggleLocked ? 'not-allowed' : 'pointer';
      if (toggleLocked) enforcerLabel.setAttribute('data-pf-locked', toggleLockMessage || '1');
      else enforcerLabel.removeAttribute('data-pf-locked');
    }
    // Only apply grayscale when the toggle is still visible AND locked (i.e.
    // locked for a non-adv-earn reason). When hidden the filter is irrelevant.
    const slider = document.getElementById('enforcerSlider');
    if (slider) {
      slider.style.filter = (toggleLocked && !hideToggleForAdvEarn) ? 'grayscale(1)' : '';
    }
    // The direct opacity/pointer-events on the input itself matter only when
    // it's actually rendered — hiding the label removes it from the flow.
    $('enforcerToggle').style.opacity = hideToggleForAdvEarn ? '' : (toggleLocked ? '0.5' : '1');
    $('enforcerToggle').style.pointerEvents = toggleLocked ? 'none' : '';
  }
  const helpEl = $('enforcerHelpText');
  if (helpEl && toggleLockMessage) {
    helpEl.dataset.lockMessage = toggleLockMessage;
  }

  // Lock the FULL Study Break UI while a spend session is active or advanced
  // earn is on (same conditions as the closer toggle — a running timer does
  // NOT lock these, since break settings apply on next start). Expanded per
  // user spec 2026-07 to include both the "earn" duration input AND every
  // timer-button in the Start/Pause/Resume/Stop set — the user should not
  // be able to interact with anything Study Break-related while Advanced
  // Earn/Spend owns the source/target flow.
  const STUDY_BREAK_LOCK_IDS = [
    'studyBreakEnabled',
    'studyBreakEveryTime',
    'studyBreakEarnTime',
    'studyBreakStartBtn',
    'studyBreakPauseBtn',
    'studyBreakResumeBtn',
    'studyBreakStopBtn',
  ];
  STUDY_BREAK_LOCK_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    // TAKEOVER (user spec 2026-07): the Work Timer START button stays
    // clickable while Advanced Earn/Spend is on — clicking it SWITCHES
    // systems (its handler shuts advanced down first, mirroring how the
    // advanced Start shuts the Work Timer down). Only an active spend
    // session still locks it. Every other Study Break control keeps the
    // full advanced lock.
    // …and during the Work Timer's OWN break, its Stop button must stay
    // usable — that's how the user ends the break and banks the remainder.
    // STOP-ALWAYS-USABLE (2026-07): the Stop button is NEVER locked. User
    // report: "when a tab gets closed by the Work timer it can't be hit
    // stopped" — a closer-driven tab close was reshaping state so the
    // Stop button ended up with pointer-events:none via this lock. The
    // Stop button is the fail-safe way to end any timer; it must always
    // be clickable regardless of spend/toggle state. The onchange handler
    // and stop dispatch already handle the actual end-of-session logic.
    const lockThis = id === 'studyBreakStartBtn' ? spendSessionLocksToggle
      : (id === 'studyBreakStopBtn') ? false
      : toggleLocked;
    el.disabled = lockThis;
    el.style.opacity = lockThis ? '0.5' : '1';
    el.style.pointerEvents = lockThis ? 'none' : '';
    if (lockThis) { el.setAttribute('aria-disabled', 'true'); el.setAttribute('data-pf-locked', toggleLockMessage || '1'); }
    else { el.removeAttribute('aria-disabled'); el.removeAttribute('data-pf-locked'); }
  });
  // Also disable EVERY input inside the two nested timer-hms widgets
  // (studyBreakEveryTime + studyBreakEarnTime) — the wrapper div can't
  // carry `disabled`, so its numeric inputs stay clickable otherwise.
  ['studyBreakEveryTime', 'studyBreakEarnTime'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const wrapper = el.previousElementSibling; // the .timer-hms div
    if (wrapper && wrapper.classList?.contains('timer-hms')) {
      wrapper.querySelectorAll('input').forEach((inp) => {
        inp.disabled = toggleLocked;
      });
      wrapper.style.opacity = toggleLocked ? '0.5' : '';
      wrapper.style.pointerEvents = toggleLocked ? 'none' : '';
    }
  });
  // Lock ONLY the timer START buttons when a conflicting session is active. The
  // stop/pause/cancel buttons must ALWAYS work so the user can stop a running
  // timer. Start buttons carry the start-specific reason (e.g. "A timer is
  // already running — stop it first").
  ['studyTimerStartBtn', 'unprodTimerStartBtn'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.disabled = startButtonsLocked;
    el.style.opacity = startButtonsLocked ? '0.5' : '1';
    el.style.pointerEvents = startButtonsLocked ? 'none' : '';
    if (startButtonsLocked) { el.setAttribute('aria-disabled', 'true'); el.setAttribute('data-pf-locked', startLockMessage || '1'); }
    else { el.removeAttribute('aria-disabled'); el.removeAttribute('data-pf-locked'); }
  });

  // Static "Turn off Advanced Earn/Spend to use this." notes — REMOVED from
  // Work Timer and enforcer per user spec 2026-07. Advanced Earn/Spend no
  // longer locks the Work Timer or shows the note.
  ['enforcerAdvEarnNote', 'studyBreakAdvEarnNote'].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
  const showAdvEarnNote = spendSessionLocksToggle;
  ['unprodTimerAdvEarnNote', 'studyTimerAdvEarnNote'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.hidden = !showAdvEarnNote;
  });

  // Sync the Advanced Earn/Spend Start/Stop button state. When "I'm finished"
  // is clicked in the popup (pfBankCycleTurnOff clears bankFocusActive +
  // bankSpendActive), this ensures the dashboard reflects the idle state
  // (Start visible, Stop hidden) rather than staying stuck on "Stop timer".
  // STICKY-AWARE (user report 2026-07: Start/Stop "glich on and off" while
  // the cycle-complete popup is awaiting a choice): this writer used to
  // derive ONLY from focus/spend-active, so during awaitingChoice (both
  // false, sticky true) it wrote 'idle' while the 1 s reconcilers wrote
  // 'running' — the two alternated every tick. It now honours the same
  // sticky rule as pfReconcileModeBButtonsFromStorage / renderModeBSpendUI:
  // sticky keeps Stop up while the feature is on; feature-off clears sticky.
  const focusActiveForWindow = !!(windowName && bankFocusActive?.[windowName]);
  const spendActiveForWindow = !!(windowName && bankSpendActive?.[windowName]);
  if (!advancedEarnOn && window.pfModeBStickyRunning === true) {
    window.pfModeBStickyClear?.();
  }
  const stickyForWindow = advancedEarnOn === true && window.pfModeBStickyRunning === true;
  if (typeof window.__pfApplyModeBEarnButtonState === 'function') {
    window.__pfApplyModeBEarnButtonState(
      (focusActiveForWindow || spendActiveForWindow || stickyForWindow) ? 'running' : 'idle'
    );
  }

  console.info('[pf-dashboard] toggle UI refreshed, limitsEnabled:', limEn,
    'timerSessionActive:', timerSessionActive, 'timerActivelyRunning:', timerActivelyRunning,
    'spendSessionLocksToggle:', spendSessionLocksToggle, 'advancedEarnOn:', advancedEarnOn,
    'toggleLocked:', toggleLocked, 'startButtonsLocked:', startButtonsLocked);
}

async function renderWindowSettings() {
  // Parallelize the independent reads — they were sequential and each is a
  // round-trip, which added up on the critical render path (delays the gray
  // overlay drop). getCurrent is fetched once and shared.
  const win = await chrome.windows.getCurrent();
  const [d, configResponse] = await Promise.all([
    chrome.storage.local.get(["tabLimitConfirmedInTutor", "tabLimitLockState"]),
    chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id }).catch(() => null)
  ]);
  const config = configResponse?.config || {};
  const limEn = config.limitsEnabled || false, resAc = config.resetSession || false, pauseEn = config.pauseActive || false;
  tabLimitConfirmedInTutor = d.tabLimitConfirmedInTutor || false;
  tutorialTabLimitLocked = d.tabLimitLockState !== false;
  lastRenderedLimEn = limEn;

  // Friendly default name: numbered by the window's index among all open
  // windows so first-time users see "Window #1" (or "Window #2" if two
  // windows are open) instead of the flat "New Window" that leaked to
  // the Other Windows list. Per user spec 2026-07.
  if (config.name && String(config.name).trim()) {
    $('displayName').innerText = config.name;
  } else {
    try {
      const all = await chrome.windows.getAll();
      const idx = all.findIndex((w) => w.id === win.id);
      $('displayName').innerText = `Window #${idx >= 0 ? idx + 1 : 1}`;
    } catch (_) {
      $('displayName').innerText = 'Window #1';
    }
  }
  chrome.storage.local.get(['currentStreak', 'dailyLogs', 'dailySiteLogs']).then(refreshStreakDisplay);
  $('maxTabLimit').value = Math.min(config.tabLimit || 5, MAX_TAB_LIMIT);
  renderedTabLimit = Math.min(config.tabLimit || 5, MAX_TAB_LIMIT);
  const tabLimitInput = $('maxTabLimit');
  const tabLimitLockBtn = $('tabLimitLockBtn');
  // If a timer is active, force toggle visual to OFF and disable it,
  // regardless of what config.limitsEnabled says
  const { advancedSettingsExpanded, bankSpendActive, bankSpendPaused } = await chrome.storage.local.get([
    'advancedSettingsExpanded', 'bankSpendActive', 'bankSpendPaused'
  ]);
  const { timerSessionActive, timerActivelyRunning, snap: timerSnap } = await getWallClockTimerUiFlags(win.id);
  const windowNameForLock = await resolveWindowName(win.id) || config.name || `Window ${win.id}`;
  const spendSessionLocksToggle = !!(
    bankSpendActive?.[windowNameForLock]
    && !bankSpendPaused?.[windowNameForLock]
  );
  // 2026-07 RUN-THROUGH FIX: this renderer still locked the toggle for ANY
  // timer session (`timerSessionActive || …`), silently undoing the
  // "toggle stays usable while timers run" rule whenever it re-rendered —
  // the last remaining path that kept the toggle stuck around break
  // expiry. Locked by an ACTIVE SPEND session only, same as everywhere else.
  const toggleLocked = spendSessionLocksToggle;
  const advExpanded = advancedSettingsExpanded === true || $('enableLimits')?.checked === true;
  if (document.activeElement !== $('enableLimits')) {
    void setAdvancedSettingsExpanded(advExpanded, { persist: false });
  }
  if ($('enforcerToggle')) {
    // During the "Closer toggle" step (currentStep === 7) and the "Floating
    // button" mock step (currentStep === 8), the tutorial owns the checkbox
    // transiently (ON→OFF cycle / mock hold). Do NOT reset it to the stale
    // stored value here — that was snapping the toggle back OFF the instant the
    // user turned it ON, breaking both steps.
    if (currentStep !== 7 && currentStep !== 8) {
      $('enforcerToggle').checked = toggleLocked ? false : limEn;
    }
    $('enforcerToggle').disabled = toggleLocked;
    $('enforcerToggle').style.opacity = toggleLocked ? '0.5' : '1';
    $('enforcerToggle').style.pointerEvents = toggleLocked ? 'none' : '';
    const enforcerLabel = $('enforcerToggle').parentElement;
    if (enforcerLabel) {
      enforcerLabel.style.opacity = toggleLocked ? '0.4' : '1';
      enforcerLabel.style.pointerEvents = toggleLocked ? 'none' : '';
      enforcerLabel.style.cursor = toggleLocked ? 'not-allowed' : 'pointer';
    }
    const slider = document.getElementById('enforcerSlider');
    if (slider) {
      slider.style.filter = toggleLocked ? 'grayscale(1)' : '';
    }
  }
  if (document.activeElement !== $('resetSessionCheck')) $('resetSessionCheck').checked = resAc;
  const wipeTabEn = config.wipeTabTimesEnabled === true;
  if ($('enableWipeTabTimes') && document.activeElement !== $('enableWipeTabTimes')) {
    $('enableWipeTabTimes').checked = wipeTabEn;
  }
  if ($('wipeTabTimesInterval')) $('wipeTabTimesInterval').value = config.wipeTabTimesInterval || '1w';
  if ($('wipeTabTimesAt')) $('wipeTabTimesAt').value = config.wipeTabTimesAt || '09:00';
  updateWipeTabTimesAtRowState();
  loadTransferWindowOptions();
  updateFocusedBankDisplay();
  if (document.activeElement !== $('enablePause')) $('enablePause').checked = pauseEn;
  if (document.activeElement !== $('enableBankedTime')) $('enableBankedTime').checked = !!config.bankedTimeEnabled;
  const pauseUiOn = $('enablePause') ? $('enablePause').checked : pauseEn;
  const bankedUiOn = $('enableBankedTime') ? $('enableBankedTime').checked : !!config.bankedTimeEnabled;
  const wipeUiOn = $('enableWipeTabTimes') ? $('enableWipeTabTimes').checked : wipeTabEn;
  const resetUiOn = $('resetSessionCheck') ? $('resetSessionCheck').checked : resAc;
  $('sessionResetContainer').className = resetUiOn ? 'active' : 'inactive';
  $('bankedTimeContainer').className = bankedUiOn ? 'active' : 'inactive';
  $('pauseContainer')?.classList.toggle('active', pauseUiOn);
  $('pauseContainer')?.classList.toggle('inactive', !pauseUiOn);
  syncWipeTabTimesContainerUi(wipeUiOn);
  if ($('tabLifeLimit')) {
    const limitStr = config.tabLifeLimit ?? config.tabLifeLimitStr;
    const sec = Number(config.tabLifeLimitSec || 0);
    let tabLifeOn;
    if (config.tabLifeEnabled === false || limitStr === '') {
      tabLifeOn = false;
    } else if (sec > 0 || limitStr) {
      tabLifeOn = true;
    } else {
      tabLifeOn = true;
    }
    $('tabLifeLimit').value = tabLifeOn ? (limitStr || '24h') : '';
  }

  ['sessionResetSection', 'pauseSection', 'bankedTimeSection', 'wipeTabTimesSection'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const checkbox = id === 'sessionResetSection' ? $('resetSessionCheck') :
                     id === 'bankedTimeSection' ? $('enableBankedTime') :
                     id === 'wipeTabTimesSection' ? $('enableWipeTabTimes') : $('enablePause');
    const expected = id === 'sessionResetSection' ? resAc :
                     id === 'bankedTimeSection' ? !!config.bankedTimeEnabled :
                     id === 'wipeTabTimesSection' ? wipeTabEn : pauseEn;
    if (checkbox?.checked !== undefined && checkbox.checked !== expected) return;
    el.style.display = expected ? 'block' : 'none';
  });
  await renderStartupSlots(config);

  loadStudyBreakSettings(config);
  loadModeBEarnSpendSettings(config);
  const renderWindowName = await getFriendlyWindowNameForTimer(win.id);
  void renderStudyBreakUI(renderWindowName);
  void renderModeBSpendUI(renderWindowName);

  ['tabLifeLimit', 'unprodTimeLimit', 'studyTimeLimit', 'bankFocusTime', 'bankEarnedTime'].forEach(id => {
    const val = id === 'tabLifeLimit'
      ? (() => {
        const limitStr = config.tabLifeLimit ?? config.tabLifeLimitStr;
        const sec = Number(config.tabLifeLimitSec || 0);
        if (config.tabLifeEnabled === false || limitStr === '') return '';
        if (sec > 0 || limitStr) return limitStr || '24h';
        return '24h';
      })()
      : (id === 'unprodTimeLimit' ? config.unprodLimit : (id === 'studyTimeLimit' ? config.studyLimit : (id === 'bankFocusTime' ? config.bankFocusStr : config.bankEarnedStr)));
    if (id === 'unprodTimeLimit') {
      const unprodVal = (timerSnap?.mode === 'break' && timerSnap?.active && timerSnap?.originalInput)
        ? timerSnap.originalInput
        : (config.unprodLimit || '');
      writeTimerHmsFromString(id, unprodVal);
      return;
    }
    if (id === 'studyTimeLimit') {
      writeTimerHmsFromString(id, config.studyLimit || '');
      return;
    }
    if (id === 'bankFocusTime' || id === 'bankEarnedTime') {
      if (!isTimerHmsFieldFocused(id)) {
        writeTimerHmsFromString(id, val || '');
      }
      return;
    }
    if ($(id) && document.activeElement !== $(id)) $(id).value = val || "";
  });

  if (config.pausedUntil > Date.now()) {
    const r = Math.ceil((config.pausedUntil - Date.now()) / 60000);
    $('pauseDuration').value = r; $('pauseDurationLabel').innerText = `${r} min${r === 1 ? '' : 's'}`;
  }
  $('autoShieldPopouts').checked = !!config.autoShieldPopouts;
  if ($('autoCloseAutoTabs')) $('autoCloseAutoTabs').checked = !!config.autoCloseAutoTabs;
  // Default OFF on first install: user has to explicitly switch this on.
  if ($('autoCloseDashboard')) $('autoCloseDashboard').checked = config.autoCloseDashboard === true;
  const rankingMode = config.rankingMode === 'website' ? 'website' : 'tab';
  confirmedRankingMode = rankingMode;
  const rankingTab = $('rankingModeTab');
  const rankingWebsite = $('rankingModeWebsite');
  if (rankingTab) rankingTab.checked = rankingMode === 'tab';
  if (rankingWebsite) rankingWebsite.checked = rankingMode === 'website';
  updateWipeTabTimesVisibility();
  syncRankingModeDemo();

  if (tabLimitInput) {
    if (!tabLimitInput.dataset.lockGuardBound) {
      const guard = (e) => {
        const inTutorialTabLimitFlow = currentStep === 3 || currentStep === 4;
        if (!tutorialTabLimitLocked) return;
        if (inTutorialTabLimitFlow) return;
        if (e?.type === 'focus') {
          tabLimitInput.blur();
        } else if (e?.cancelable) {
          e.preventDefault();
        }
        triggerTabLimitLockShake();
      };
      ['mousedown', 'click', 'wheel', 'keydown', 'focus'].forEach((evtName) => {
        tabLimitInput.addEventListener(evtName, guard, { passive: false });
      });
      tabLimitInput.dataset.lockGuardBound = 'true';
    }
    tabLimitInput.oninput = () => {
      if (currentStep === 4 && !tutorialTabLimitLocked) {
        tutorialTabLimitUserEdited = true;
        tutorialTabLimitReadyForConfirm = false;
      }
      updateTutorialTabLimitControls();
      void chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id }).then((resp) => {
        void renderStartupSlots(resp?.config || {});
      });
    };
  }

  if (tabLimitLockBtn) {
    tabLimitLockBtn.onclick = async () => {
      const inTutorialTabLimitFlow = currentStep === 3 || currentStep === 4;
      if (!inTutorialTabLimitFlow) {
        tutorialTabLimitLocked = !tutorialTabLimitLocked;
        tutorialTabLimitReadyForConfirm = false;
        chrome.storage.local.set({ tabLimitLockState: tutorialTabLimitLocked });
        console.info('[pf-tutor-lock-diag] non-tutorial toggle', {
          tutorialTabLimitLocked,
          tutorialTabLimitReadyForConfirm,
          tutorialTabLimitUserEdited
        });
        updateTutorialTabLimitControls();
        return;
      }

      if (currentStep === 4) {
        triggerTabLimitLockShake();
        return;
      }

      if (tutorialTabLimitLocked) {
        tutorialTabLimitLocked = false;
        tutorialTabLimitReadyForConfirm = false;
        if (currentStep === 3) {
          await chrome.storage.local.set({ tutorialTabLimitConfirmed: false });
        }
      } else {
        const validTabLimit = getTabLimitValueOrNull();
        if (validTabLimit !== null) {
          tutorialTabLimitLocked = true;
          tutorialTabLimitRelockSeen = true;
          if (currentStep === 3) {
            await chrome.storage.local.set({ tutorialTabLimitConfirmed: true });
            // Stop the glow the moment the lock actually engages — the
            // pulse was originally a "look at me" cue, and once the user
            // has clicked it, continuing to pulse feels demanding.
            tabLimitLockBtn.classList.remove('pf-tutorial-lock-glow');
            // Confirmation feedback: same pattern as other early tutorial
            // steps ("Great. Now click Next to move on.").
            const textEl = $('tutorText');
            if (textEl) textEl.innerText = 'Locked. Click Next to move on.';
          }
          tutorialTabLimitReadyForConfirm = currentStep === 4;
        } else {
          triggerTabLimitLockShake();
        }
      }
      chrome.storage.local.set({ tabLimitLockState: tutorialTabLimitLocked });
      console.info('[pf-tutor-lock-diag] tutorial toggle', {
        currentStep,
        tutorialTabLimitLocked,
        tutorialTabLimitReadyForConfirm,
        tutorialTabLimitUserEdited
      });
      updateTutorialTabLimitControls();
      void updateTutorNextState();
    };
  }

  $('confirmTabLimit').onclick = async () => {
    const confirmBtn = $('confirmTabLimit');
    if (confirmBtn?.disabled) return;
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (!win) return;
    const tabLimit = getTabLimitValueOrNull() || 5;
    const tutorialIncomplete = !(await isTutorialCompleted());
    if (tutorialIncomplete && currentStep === 3) {
      return;
    }
    if (tutorialIncomplete && currentStep === 4 && getTabLimitValueOrNull() === null) {
      return;
    }
    if (!tutorialIncomplete && !tutorialTabLimitLocked) {
      return;
    }

    const skipFlags = await chrome.storage.local.get(['tutorialSkippedEver']);
    if (skipFlags.tutorialSkippedEver === true) {
      const excessCount = await countExcessTabsForWindow(win.id, tabLimit);
      if (excessCount > 0) {
        const proceed = await showTabLimitSkippedUserConfirm(excessCount);
        if (!proceed) return;
      }
    }

    await applyTabLimitConfirm(win, tabLimit, tutorialIncomplete, confirmBtn);
  };
  updateTutorialTabLimitControls();
}

async function renderOtherWindows() {
  const list = $('otherWindowsList');
  list.replaceChildren();

  const [curr, all] = await Promise.all([
    chrome.windows.getCurrent(),
    chrome.windows.getAll()
  ]);

  const otherWindows = all.filter((w) => w.id !== curr.id);
  const configResponses = await Promise.all(
    otherWindows.map((w) =>
      chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: w.id }).catch(() => null)
    )
  );

  otherWindows.forEach((w, index) => {
    const c = configResponses[index]?.config || {};
    // Friendly fallback name (per user spec 2026-07): raw Chrome window IDs
    // like "Window 1146396648" leaked to the user when they hadn't named
    // a window. Sequentially number unnamed windows as "Window #1",
    // "Window #2", etc. — position among the OTHER windows list, so it
    // stays stable within this render.
    const windowLabel = c.name && String(c.name).trim()
      ? c.name
      : `Window #${index + 1}`;
    const div = document.createElement('div');
    div.className = 'row';
    div.dataset.windowName = windowLabel;
    div.style.cssText = "opacity:0.7; cursor:pointer; border-left:4px solid #6c757d; background:#fff; padding:12px; margin-bottom:8px; border-radius:6px; border:1px solid #eee;";
    const nameSpan = document.createElement('span');
    const nameBold = document.createElement('b');
    nameBold.textContent = windowLabel;
    nameSpan.appendChild(nameBold);
    div.appendChild(nameSpan);
    div.appendChild(createElementWithText('span', `Tab Limit: ${c.tabLimit || 5}`));
    div.appendChild(createElementWithText('span', `Limits: ${c.limitsEnabled ? 'Enabled' : 'Disabled'}`));
    div.appendChild(createElementWithText('span', `Reset: ${c.resetSession ? 'Yes' : 'No'}`));
    div.onclick = () => {
      document.querySelectorAll('#otherWindowsList .row').forEach(row => row.classList.remove('selected'));
      div.classList.add('selected');
    };
    list.appendChild(div);
  });
  const shown = otherWindows.length;

  if (!shown) {
    list.appendChild(createParagraph(
      all.length <= 1
        ? 'No other Chrome windows open right now.'
        : `You have ${all.length} windows open. Other windows will appear here when you open more.`,
      "font-size:0.9em; color:#777;"
    ));
  }
}

async function renderOtherComputers() {
  const list = $('otherComputersList');
  list.replaceChildren();
  if (!currentUser) {
    list.appendChild(createParagraph('Sign in to enable cross-device synchronisation.', "font-size:0.9em; color:#777;"));
    return;
  }
  list.appendChild(createParagraph('This section would display sync data (Backend Required).', "font-size:0.9em; color:#777;"));
}

const SIGN_IN_BANNER_TEXT = "Sign in to activate PlayingFild. The extension does not classify pages or close tabs until you sign in.\n\nPlease sign in to use PlayingFild. This allows us to stop bots and abuse.";

function emailFromAccessToken(accessToken) {
  try {
    const payload = JSON.parse(atob(String(accessToken).split('.')[1]));
    return typeof payload.email === 'string' && payload.email.includes('@') ? payload.email : null;
  } catch (_) {
    return null;
  }
}

function userIdFromAccessToken(accessToken) {
  try {
    const payload = JSON.parse(atob(String(accessToken).split('.')[1]));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch (_) {
    return null;
  }
}

async function checkSignInStatus() {
  const stored = await chrome.storage.local.get(['pfSession', 'pfUserDisplayName']);
  const session = stored.pfSession;
  if (!session?.access_token) return null;

  const email = session.user?.email || emailFromAccessToken(session.access_token);
  if (!email) return null;

  const userId = session.user?.id || userIdFromAccessToken(session.access_token);

  let displayName = typeof stored.pfUserDisplayName === 'string' ? stored.pfUserDisplayName.trim() : '';
  if (!displayName && userId) {
    // Don't block dashboard boot on a network call just to fetch a display name.
    // Fall back to the email username instantly and populate the real name in
    // the background once it resolves. (This was hanging the dashboard for ~2
    // minutes when Supabase was unreachable.)
    displayName = email.split('@')[0];
    fetchUserChosenDisplayName(session.access_token, userId).then((name) => {
      if (name) {
        chrome.storage.local.set({ pfUserDisplayName: name }).then(() => {
          // Refresh the UI in place if the user is still here.
          try { renderAuthUI(); } catch (_) {}
        });
      }
    }).catch(() => {});
  }
  if (!displayName) {
    displayName = email.split('@')[0];
  }

  if (userId) {
    void pfAnalyticsIdentify(userId).catch(() => {});
    // Safety net for sessions that arrive via restore/sync rather than the
    // signup page: if this is a DIFFERENT account than the device's stats
    // owner, the previous user's stats are wiped (user spec 2026-07).
    void pfClaimStatsForAccount(userId).then((wiped) => {
      if (wiped) window.location.reload(); // charts must not show stale data
    }).catch(() => {});
  }
  return { email, displayName };
}

async function refreshAuthFromStorage() {
  currentUser = await checkSignInStatus();
  updateProfileAvatar();
  await renderAuthUI();
  // If the user just signed in, make sure the loading overlay is dropped so
  // they see the signed-in dashboard immediately (not stuck on the loader).
  if (currentUser?.email) {
    document.documentElement.classList.remove('pf-dash-loading');
  }
  if (!currentUser?.email) return;

  const stored = await chrome.storage.local.get([
    'tutorialReachedStep14', 'tutorialPinStepDone', 'tutorialDataModeStepDone',
    'pfSession', 'tutorialState', 'lastTutorialStep', 'tutorialCompleted', 'tutorialComplete'
  ]);
  if (stored.tutorialCompleted === true || stored.tutorialComplete === true) return;

  const stepIdx = Number.isFinite(currentStep)
    ? currentStep
    : (stored.tutorialState?.step ?? stored.lastTutorialStep ?? 0);
  const onSignInStep = stepIdx >= TUTORIAL_MAIN_STEPS - 1;

  if (onSignInStep && !stored.tutorialReachedStep14) {
    await chrome.storage.local.set({ tutorialReachedStep14: true });
    stored.tutorialReachedStep14 = true;
  }

  if (!shouldResumePostSigninTutorial(stored)) return;

  const inTutorialUi = document.body.classList.contains('tutorial-active');
  if (!inTutorialUi && !onSignInStep) return;

  if (!stored.tutorialPinStepDone) {
    await showPostSigninPinStep();
  } else if (!stored.tutorialDataModeStepDone) {
    await showPostSigninDataModeStep();
  } else {
    await showPostSigninStep();
  }
}

async function signIn(options = {}) {
  // The profile "Sign in" button should land on the SIGN-IN step, not the
  // create-account step (per user report 2026-07). The tutorial sign-in
  // still hits the default (Create account) path.
  const wantSignInTab = options.landOnSignin === true;
  const baseUrl = chrome.runtime.getURL('signup.html');
  const url = wantSignInTab ? `${baseUrl}?tab=signin` : baseUrl;
  // Match either the exact URL or a signup tab with any query string, so
  // opening the sign-in variant reuses an existing signup tab and just
  // switches its step.
  const existingTabs = await chrome.tabs.query({ url: `${baseUrl}*` });
  if (existingTabs && existingTabs.length > 0) {
    const existing = existingTabs[0];
    // If we want the sign-in step, navigate the existing tab so it
    // re-parses the ?tab=signin query param on load.
    if (wantSignInTab && existing.id != null) {
      await chrome.tabs.update(existing.id, { active: true, url });
    } else {
      await chrome.tabs.update(existing.id, { active: true });
    }
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab?.id) {
    await chrome.runtime.sendMessage({
      action: 'pfMarkExemptTab',
      tabId: tab.id,
      reason: 'signup'
    });
  }
}

async function signOut() {
  void pfAnalyticsCapture('signout', {});
  await chrome.runtime.sendMessage({
    action: 'cancelPendingSync',
    reason: 'dashboard_sign_out'
  }).catch(() => {});
  await pfSignOut();
  await chrome.storage.local.remove('pfUserDisplayName');
  currentUser = null;
  updateProfileAvatar();
  renderAuthUI();
  await renderOtherWindows();
  await renderOtherComputers();
}

async function render() {
  // Paint the CRITICAL path first — the user's own window settings + tutorial
  // gating — so the gray loading overlay can drop ASAP. The secondary panels
  // ("other windows", "other computers") do per-window SW message round-trips
  // and were blocking the overlay; defer them off the critical render path.
  await Promise.all([renderWindowSettings(), updateTutorNextState()]);
  renderStartupList();
  renderAuthUI();
  // Fire the secondary panels without awaiting — they populate in place.
  void renderOtherWindows().catch((e) => console.warn('[pf-dashboard] renderOtherWindows failed', e));
  void renderOtherComputers().catch((e) => console.warn('[pf-dashboard] renderOtherComputers failed', e));
  if (activeSubTab === 'siteTime') await renderProductiveVsUnproductive();
  isInitialized = true;
}

function formatActiveTime(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Calendar-week view (user spec 2026-07 v11): the chart shows a FIXED
// Monday→Sunday week instead of a rolling last-7-days window. So on a
// Wednesday you see Mon+Tue+Wed filled in and Thu–Sun empty, and the
// bars stay parked on the same day-of-week until Monday rolls over.
// weekOffset=0 → this week; 1 → last week; N → N weeks back.
function pvuWeekBoundaryDates(weekOffset = 0) {
  const now = new Date();
  // JS: Sunday=0, Monday=1, ..., Saturday=6. Convert to Monday=0..Sunday=6.
  const dow = now.getDay();
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const weekShift = Math.max(0, Number(weekOffset) || 0) * 7;
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - daysSinceMonday - weekShift);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start, end };
}

function getLast7StreakDayKeys(weekOffset = 0) {
  // Kept the name for backward compat; now returns Mon..Sun for the
  // target calendar week rather than the trailing 7-day window.
  const keys = [];
  const { start } = pvuWeekBoundaryDates(weekOffset);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    keys.push(streakDayKey(d));
  }
  return keys;
}

function dayKeyToDate(dayKey, weekOffset = pvuWeekOffset) {
  if (!dayKey) return null;
  const keys = getLast7StreakDayKeys(weekOffset);
  const idx = keys.indexOf(dayKey);
  if (idx >= 0) {
    const { start } = pvuWeekBoundaryDates(weekOffset);
    const d = new Date(start);
    d.setDate(start.getDate() + idx);
    return d;
  }
  const now = new Date();
  for (let daysAgo = 0; daysAgo <= 365; daysAgo++) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    if (streakDayKey(d) === dayKey) return d;
  }
  return null;
}

function formatPvuWeekRangeLabel(weekOffset = pvuWeekOffset) {
  const { start, end } = pvuWeekBoundaryDates(weekOffset);
  const opts = { month: 'short', day: 'numeric' };
  const range = `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
  return range;
}

function getMaxPvuWeekOffset(logs = pvuDailySiteLogs) {
  const keys = Object.keys(logs || {});
  if (!keys.length) return 0;
  let oldestTime = Infinity;
  for (const key of keys) {
    const parsed = dayKeyToDate(key, 0);
    if (!parsed) continue;
    oldestTime = Math.min(oldestTime, parsed.getTime());
  }
  if (!Number.isFinite(oldestTime)) return 0;
  const todayTime = pvuWeekBoundaryDates(0).end.getTime();
  const daysSpan = Math.max(0, Math.floor((todayTime - oldestTime) / 86400000));
  return Math.max(0, Math.floor(daysSpan / 7));
}

const PVU_TYPE_COLORS = {
  Neutral: '#9B96A8',
  Productive: '#3A1D6E',
  Unproductive: '#C9A9E8'
};
const REAL_PRODUCTIVITY_COLOR = '#6f42c1';
const REAL_PRODUCTIVITY_MEASURE = 'Engagement score on productive websites (the higher the score, the more productive)';
const PVU_STACK_ORDER = ['Neutral', 'Productive', 'Unproductive'];
let pvuBreakdownPinned = false;
let pvuBreakdownPinnedDayKey = null;
let pvuHoverDayIndex = null;
let pvuHourBreakdownPinned = false;
let pvuHourBreakdownPinnedHour = null;
let pvuHoverHour = null;
let pvuSelectedDayKey = null;
let pvuWrapHoverBound = false;
let pvuHourWrapHoverBound = false;
// Legend "?" dropdown: the document-level click-away + Esc listeners are
// bound ONCE (the legend button/panel are rebuilt on every chart render, so
// per-render document listeners would accumulate). Each render updates these
// refs so the single listener pair always points at the live button/panel.
let pvuLegendHelpBtn = null;
let pvuLegendHelpPanel = null;
let pvuLegendHelpDocListenersBound = false;
let pvuHourlySiteLogs = {};
let pvuDailySiteLogs = {};
let pvuDailyProductiveEngagement = {};
let pvuWeekOffset = 0;
let pvuCurrentDays = [];
// Empty-state flag so the hover tooltip positioner can place the panel
// where users expect it while the chart still has no bars to point at
// (per user report: pinned-top hover felt "way too high up" on empty
// weeks). When there's data we go back to the top-strip position that
// stays out of the way of the bars.
let pvuHasData = false;
let pvuHourHasData = false;
let pvuWeekNavBound = false;
let pvuDayNavBound = false;
let pvuFollowLiveWeek = true;
let pvuFollowLiveDay = true;
let pvuLiveNavWatchId = null;
let pvuLiveNavLastDayKey = null;
let pvuLiveNavLastWeekEndMs = null;

function getCurrentStreakDayKey() {
  return streakDayKey(new Date());
}

function isPvuTodayDayKey(dayKey) {
  return pvuWeekOffset === 0 && dayKey === getCurrentStreakDayKey();
}

function syncPvuLiveDaySelection(days) {
  if (!days?.length) return;
  const todayKey = getCurrentStreakDayKey();
  if (pvuFollowLiveWeek && pvuFollowLiveDay) {
    pvuSelectedDayKey = days.some((d) => d.dayKey === todayKey)
      ? todayKey
      : defaultPvuSelectedDayKey(days);
    return;
  }
  if (!pvuSelectedDayKey || !days.some((d) => d.dayKey === pvuSelectedDayKey)) {
    pvuSelectedDayKey = defaultPvuSelectedDayKey(days);
  }
}

function checkPvuLiveNavRollover() {
  if (activeSubTab !== 'siteTime') return;
  const todayKey = getCurrentStreakDayKey();
  const weekEndMs = pvuWeekBoundaryDates(0).end.getTime();
  const dayChanged = pvuLiveNavLastDayKey != null && todayKey !== pvuLiveNavLastDayKey;
  const weekChanged = pvuLiveNavLastWeekEndMs != null && weekEndMs !== pvuLiveNavLastWeekEndMs;
  pvuLiveNavLastDayKey = todayKey;
  pvuLiveNavLastWeekEndMs = weekEndMs;

  if (!dayChanged && !weekChanged) return;

  let shouldRender = false;
  if (dayChanged && pvuFollowLiveDay) {
    pvuBreakdownPinned = false;
    pvuBreakdownPinnedDayKey = null;
    pvuSelectedDayKey = null;
    shouldRender = true;
  }
  if (weekChanged && pvuFollowLiveWeek) {
    pvuWeekOffset = 0;
    pvuBreakdownPinned = false;
    pvuBreakdownPinnedDayKey = null;
    pvuSelectedDayKey = null;
    shouldRender = true;
  }
  if (shouldRender) {
    renderProductiveVsUnproductive().catch((err) => {
      console.error('[pf-pvu] live nav rollover render failed:', err);
    });
  }
}

function startPvuLiveNavWatcher() {
  stopPvuLiveNavWatcher();
  pvuLiveNavLastDayKey = getCurrentStreakDayKey();
  pvuLiveNavLastWeekEndMs = pvuWeekBoundaryDates(0).end.getTime();
  pvuLiveNavWatchId = setInterval(checkPvuLiveNavRollover, 30000);
  if (!document.pvuLiveNavVisibilityBound) {
    document.pvuLiveNavVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && activeSubTab === 'siteTime') {
        checkPvuLiveNavRollover();
      }
    });
  }
}

function stopPvuLiveNavWatcher() {
  if (pvuLiveNavWatchId != null) {
    clearInterval(pvuLiveNavWatchId);
    pvuLiveNavWatchId = null;
  }
}

function formatPvuDayLabel(dayIndex, totalDays, weekOffset = pvuWeekOffset) {
  // Chart is now a fixed Mon..Sun view (user spec 2026-07 v11), so the
  // label is simply the (Monday + dayIndex) weekday name. totalDays kept
  // in the signature for call-site compat but no longer needed.
  void totalDays;
  const { start } = pvuWeekBoundaryDates(weekOffset);
  const d = new Date(start);
  d.setDate(start.getDate() + dayIndex);
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

function formatPvuDayHeading(dayKey) {
  return dayKey || '';
}

function clearPvuBreakdownPosition() {
  const breakdownEl = $('pvuBreakdown');
  if (!breakdownEl) return;
  // Tutorial PVU step: positioning is CSS-only. Don't clear inline styles,
  // and skip clearing entirely so the !important CSS rules keep the panel
  // pinned below the tutor box.
  if (document.body.classList.contains('tutorial-active')
    && document.body.classList.contains('tutorial-step-pvu')) return;
  breakdownEl.style.left = '';
  breakdownEl.style.right = '';
  breakdownEl.style.top = '';
  breakdownEl.style.bottom = '';
  breakdownEl.style.width = '';
  breakdownEl.style.transform = '';
  breakdownEl.style.position = '';
  breakdownEl.classList.remove('pvu-breakdown--align-left', 'pvu-breakdown--align-right');
}

function positionPvuBreakdownNearBar(dayIndex) {
  const breakdownEl = $('pvuBreakdown');
  const wrap = breakdownEl?.closest('.pvu-chart-wrap');
  if (!breakdownEl || !wrap) return;

  clearPvuBreakdownPosition();

  // TUTORIAL: user spec 2026-07 v50 — "make it mimick the real one where it
  // kinda moves like the real one doesnt stay stationary". Previously the
  // tutorial forced the panel to a fixed centered position via CSS; now we
  // let the SAME positioning logic run so the panel jumps to the hovered
  // bar just like the live dashboard. Z-index still keeps it BEHIND the
  // tutor box (10020 vs 10001).

  const barEl = wrap.querySelector(`.pvu-bar[data-day-index="${dayIndex}"]`);
  if (!barEl) return;

  const wrapRect = wrap.getBoundingClientRect();
  const barRect = barEl.getBoundingClientRect();

  const gap = 10;
  const panelW = breakdownEl.offsetWidth;
  const panelH = breakdownEl.offsetHeight;

  if (wrapRect.width < 640) {
    breakdownEl.style.left = '12px';
    breakdownEl.style.right = '12px';
    breakdownEl.style.width = 'calc(100% - 24px)';
    breakdownEl.style.top = `${Math.max(12, barRect.top - wrapRect.top)}px`;
    return;
  }

  // WIDTH CLAMP (user report 2026-07 v51: "Unproductive Sit..." cut off
  // on the right). Cap the panel width so it always fits inside the
  // chart wrap with 8px padding on each side. Without this, on narrower
  // wraps the 480px min() CSS width exceeded the container width and
  // the right column got clipped.
  const maxPanelW = Math.max(280, wrapRect.width - 16);
  const effectivePanelW = Math.min(panelW, maxPanelW);
  if (effectivePanelW !== panelW) {
    breakdownEl.style.width = `${effectivePanelW}px`;
  }

  // If the hovered day has NO data, center the panel horizontally over
  // that day's column (user report 2026-07 v52: "center it on the day
  // when there is nothing on that day"). Otherwise fall back to the
  // "beside the bar, flip if overflow" logic that keeps a data-bearing
  // bar unobscured.
  const hoveredDayHasData = (pvuCurrentDays?.[dayIndex]?.total || 0) > 0;
  let left;
  if (!hoveredDayHasData) {
    const barCenterInWrap = barRect.left + barRect.width / 2 - wrapRect.left;
    left = barCenterInWrap - effectivePanelW / 2;
  } else {
    left = barRect.right - wrapRect.left + gap;
    if (left + effectivePanelW > wrapRect.width - 8) {
      left = barRect.left - wrapRect.left - effectivePanelW - gap;
    }
  }
  left = Math.max(8, Math.min(left, wrapRect.width - effectivePanelW - 8));

  // TUTORIAL step 13: positioning is CSS-only (position:fixed, centered
  // below the tutor box). Skip JS positioning so the !important CSS
  // rules keep the panel pinned. User reverted the dynamic-per-bar
  // version (v50/v51) — wanted the stationary "below the text box"
  // layout back.
  if (document.body.classList.contains('tutorial-active')
    && document.body.classList.contains('tutorial-step-pvu')) {
    return;
  }

  // EMPTY-STATE POSITIONING (user report 2026-07: "when they first log in
  // don't move the hover out of the way since it's not blocking anything —
  // just show it right above the date"). On empty weeks the pinned-top
  // position feels floaty and disconnected from the day the user is
  // hovering. Instead, park it right above the day label at the bottom
  // of the chart, snapped to the hovered bar's column. Once the user
  // has actual bars to block, we go back to the top-strip position so
  // the panel stays out of the way of the data.
  let top;
  if (!pvuHasData) {
    // Empty-state panel sits above the day-label row. Bumped up from
    // 46px to 90px of bottom margin per user report 2026-07 v52 ("move
    // the hover thing slightly higher") — the panel was sitting too
    // close to the bottom row, felt cramped against the day names.
    const bottomMargin = 90;
    top = wrapRect.height - panelH - bottomMargin;
    top = Math.max(12, top);
  } else {
    // PIN — moved further down (user report 2026-07 v53: "move the
    // hover thing down more"). top:36 was still too close to the top
    // border, top:80 sits it cleanly below the week-nav row.
    top = 80;
    top = Math.min(top, wrapRect.height - panelH - 12);
  }

  breakdownEl.style.left = `${left}px`;
  breakdownEl.style.top = `${top}px`;
}

function getPvuChartBarIndexAtPoint(clientX, clientY, wrap, barSelector, attrName) {
  if (!wrap) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  const bar = hit?.closest?.(barSelector);
  if (!bar || !wrap.contains(bar)) return null;
  const value = Number(bar.getAttribute(attrName));
  return Number.isFinite(value) ? value : null;
}

function activatePvuDayHover(dayIndex) {
  const days = pvuCurrentDays;
  const day = days?.[dayIndex];
  if (!day || tutorialBlocksPvuHover()) return;
  if (!pvuBreakdownPinned && pvuHoverDayIndex === dayIndex) return;
  const dayLabel = formatPvuDayLabel(dayIndex, days.length);
  showPvuBreakdown(day, dayLabel, { pin: false, dayIndex });
}

function getPvuSelectedDayKeyForHourly() {
  const days = pvuCurrentDays;
  if (!days?.length) return null;
  if (pvuSelectedDayKey && days.some((d) => d.dayKey === pvuSelectedDayKey)) {
    return pvuSelectedDayKey;
  }
  return defaultPvuSelectedDayKey(days);
}

function activatePvuHourHover(hour) {
  if (tutorialBlocksPvuHover()) return;
  const dayKey = getPvuSelectedDayKeyForHourly();
  if (!dayKey) return;
  if (!pvuHourBreakdownPinned && pvuHoverHour === hour) return;
  const hourBreakdown = buildHourlyBreakdownFromLogs(pvuHourlySiteLogs, dayKey, hour);
  showPvuHourBreakdown(hourBreakdown, formatPvuHourLabel(hour), { pin: false, hour });
}

function ensurePvuWrapHoverHandlers() {
  if (pvuWrapHoverBound) return;
  const wrap = document.querySelector('.pvu-chart-wrap');
  if (!wrap) return;
  pvuWrapHoverBound = true;
  wrap.addEventListener('mousemove', (e) => {
    if (pvuBreakdownPinned || tutorialBlocksPvuHover()) return;
    const dayIndex = getPvuChartBarIndexAtPoint(
      e.clientX, e.clientY, wrap, '.pvu-bar[data-day-index]', 'data-day-index'
    );
    if (dayIndex == null) return;
    activatePvuDayHover(dayIndex);
  });
  wrap.addEventListener('mouseleave', (e) => {
    if (pvuBreakdownPinned) return;
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    hidePvuBreakdown();
  });
}

function formatPvuAxisValue(value, useMinutes) {
  if (useMinutes) return `${value}m`;
  return value === 1 ? '1h' : `${value}h`;
}

function formatPvuHourLabel(hour) {
  // 12-hour AM/PM format (e.g. "1 AM", "1 PM", "12 AM").
  // Hour 24 = midnight next day = "12 AM" (previously mis-reported as
  // "12 PM" because the period ternary treated any hour >= 12 as PM,
  // which is wrong for the wrap-around).
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12} ${period}`;
}

function buildHourlyPvuFromLogs(hourlySiteLogs, dayKey) {
  return Array.from({ length: 24 }, (_, hour) => {
    const bucket = hourlySiteLogs?.[dayKey]?.[hour] || hourlySiteLogs?.[dayKey]?.[String(hour)] || {};
    const byType = {
      Neutral: Number(bucket.Neutral) || 0,
      Productive: Number(bucket.Productive) || 0,
      Unproductive: Number(bucket.Unproductive) || 0
    };
    const total = byType.Neutral + byType.Productive + byType.Unproductive;
    return { hour, byType, total };
  });
}

function buildHourlyBreakdownFromLogs(hourlySiteLogs, dayKey, hour) {
  const bucket = hourlySiteLogs?.[dayKey]?.[hour] || hourlySiteLogs?.[dayKey]?.[String(hour)] || {};
  const byHost = { Productive: [], Unproductive: [], Neutral: [] };
  const byType = { Productive: 0, Unproductive: 0, Neutral: 0 };
  const hostsMap = bucket.hosts && typeof bucket.hosts === 'object' ? bucket.hosts : {};

  for (const [host, entry] of Object.entries(hostsMap)) {
    const buckets = normalizeDailySiteLogEntry(entry);
    for (const type of PVU_STACK_ORDER) {
      const sec = buckets[type] || 0;
      if (sec <= 0) continue;
      byType[type] += sec;
      byHost[type].push({ host, sec });
    }
  }

  if (!Object.keys(hostsMap).length) {
    for (const type of PVU_STACK_ORDER) {
      byType[type] = Number(bucket[type]) || 0;
    }
  }

  for (const type of PVU_STACK_ORDER) {
    byHost[type].sort((a, b) => b.sec - a.sec || a.host.localeCompare(b.host));
  }

  const total = byType.Productive + byType.Unproductive + byType.Neutral;
  return {
    hour,
    byType,
    byHost,
    total,
    hasHostDetail: Object.keys(hostsMap).length > 0
  };
}

function formatPvuHourTooltip(hour, byType, totalSec) {
  const hourLabel = formatPvuHourLabel(hour);
  if (totalSec <= 0) return `${hourLabel}: No activity`;
  const parts = PVU_STACK_ORDER
    .filter((type) => (byType[type] || 0) > 0)
    .map((type) => `${type} ${formatActiveTime(byType[type] * 1000)}`);
  return `${hourLabel}: ${formatActiveTime(totalSec * 1000)} (${parts.join(', ')})`;
}

function renderPvuStackedBar(svgNs, {
  parent,
  x,
  baseY,
  barW,
  chartH,
  columnWidth,
  maxAxis,
  useMinutes,
  byType,
  className = 'pvu-bar',
  dataAttrs = {},
  labelText = '',
  labelY = 0,
  labelClassName = 'pvu-day-label',
  tooltipText = ''
}) {
  let yCursor = baseY;
  const barGroup = document.createElementNS(svgNs, 'g');
  barGroup.setAttribute('class', className);
  for (const [key, value] of Object.entries(dataAttrs)) {
    barGroup.setAttribute(key, value);
  }

  // Invisible full-column hit target. Widened to `columnWidth` (the full
  // per-day/per-hour column) instead of just `barW` (the narrow visible
  // bar) per user report 2026-07 v53: "make it so if my mouse is over
  // that day's area it should come up". Falls back to barW for older
  // call sites that don't pass columnWidth. User report 2026-07 v36
  // ("hovering the hourly graph does nothing") — the hit rect still
  // exists so empty hours stay hoverable even with no visible stack.
  const hitW = Number.isFinite(columnWidth) && columnWidth > barW ? columnWidth : barW;
  const hitX = x - (hitW - barW) / 2;
  const hitRect = document.createElementNS(svgNs, 'rect');
  hitRect.setAttribute('class', 'pvu-bar-hit');
  hitRect.setAttribute('x', String(hitX));
  hitRect.setAttribute('y', String(baseY - chartH));
  hitRect.setAttribute('width', String(hitW));
  hitRect.setAttribute('height', String(chartH));
  hitRect.setAttribute('fill', 'transparent');
  hitRect.style.pointerEvents = 'all';
  barGroup.appendChild(hitRect);

  const stackGroup = document.createElementNS(svgNs, 'g');
  stackGroup.setAttribute('class', 'pvu-bar-stack');

  const segments = [];
  for (const type of PVU_STACK_ORDER) {
    const sec = byType[type] || 0;
    if (sec <= 0) continue;
    const axisVal = useMinutes ? sec / 60 : sec / 3600;
    const barH = (axisVal / maxAxis) * chartH;
    yCursor -= barH;
    segments.push({ type, y: yCursor, barH });
  }

  segments.forEach((seg, idx) => {
    const isBottom = idx === 0;
    const isTop = idx === segments.length - 1;
    stackGroup.appendChild(createPvuStackSegment(svgNs, {
      x,
      y: seg.y,
      width: barW,
      height: seg.barH,
      fill: PVU_TYPE_COLORS[seg.type],
      roundTop: isTop,
      roundBottom: isBottom,
      radius: 3
    }));
  });

  barGroup.appendChild(stackGroup);

  if (labelText) {
    const label = document.createElementNS(svgNs, 'text');
    label.setAttribute('class', labelClassName);
    label.setAttribute('x', String(x + barW / 2));
    label.setAttribute('y', String(labelY));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = labelText;
    barGroup.appendChild(label);
  }

  if (tooltipText) {
    barGroup.setAttribute('title', tooltipText);
  }

  parent.appendChild(barGroup);
  return barGroup;
}

function renderPvuHourChart(days, selectedDayKey, hourlySiteLogs = pvuHourlySiteLogs) {
  const panel = $('pvuHourPanel');
  const chartEl = $('pvuHourChart');
  const heading = $('pvuHourHeading');
  if (!panel || !chartEl) return;

  if (!days?.length) {
    panel.style.display = 'none';
    renderRealProductivityDaySummary(null, []);
    return;
  }
  panel.style.display = '';

  let dayKey = selectedDayKey;
  if (!dayKey || !days.some((d) => d.dayKey === dayKey)) {
    dayKey = defaultPvuSelectedDayKey(days);
  }
  const dayIndex = days.findIndex((d) => d.dayKey === dayKey);
  const day = dayIndex >= 0 ? days[dayIndex] : days[days.length - 1];
  const dayLabel = formatPvuDayHeading(day.dayKey);

  if (heading) {
    heading.textContent = `Hourly breakdown — ${dayLabel}`;
  }

  renderRealProductivityDaySummary(day, days);
  updatePvuDayNavState(days, day.dayKey);

  chartEl.replaceChildren();
  pvuHourBreakdownPinned = false;
  pvuHourBreakdownPinnedHour = null;
  hidePvuHourBreakdown();

  const hours = buildHourlyPvuFromLogs(hourlySiteLogs, day.dayKey);
  pvuHourHasData = hours.some((h) => (h.total || 0) > 0);
  // Per user spec (2026-07): always show at least a 1-hour axis range, even
  // if no hour has reached that much time today. Without this floor, a quiet
  // day scaled the axis down (e.g. to 30min) which made bars look maxed-out
  // and made it hard to gauge how far below a "full" hour each bar was.
  const maxSec = Math.max(...hours.map((h) => h.total), 3600);
  const useMinutes = maxSec < 3600;
  const maxAxis = maxSec > 0
    ? (useMinutes
      ? Math.max(1, Math.ceil(maxSec / 60))
      : Math.max(1, Math.ceil(maxSec / 3600)))
    : 1;

  const svgNs = 'http://www.w3.org/2000/svg';
  const width = 560;
  const height = 240;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 40;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const barCount = 24;
  const barGap = chartW / barCount;
  const barW = Math.min(14, barGap * 0.55);
  const baseY = padTop + chartH;

  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'pvu-chart-svg pvu-hour-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Productive vs unproductive time by hour for ${dayLabel}`);

  const grid = document.createElementNS(svgNs, 'g');
  grid.setAttribute('class', 'pvu-grid');
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const frac = i / tickCount;
    const y = padTop + chartH - frac * chartH;
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', String(padLeft));
    line.setAttribute('x2', String(width - padRight));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    grid.appendChild(line);

    const label = document.createElementNS(svgNs, 'text');
    label.setAttribute('class', 'pvu-axis-label');
    label.setAttribute('x', String(padLeft - 6));
    label.setAttribute('y', String(y + 4));
    label.setAttribute('text-anchor', 'end');
    const axisVal = useMinutes
      ? Math.round(maxAxis * frac)
      : Math.round(maxAxis * frac * 10) / 10;
    label.textContent = formatPvuAxisValue(axisVal, useMinutes);
    svg.appendChild(label);
  }
  svg.appendChild(grid);

  hours.forEach(({ hour, byType, total }) => {
    const cx = padLeft + barGap * hour + barGap / 2;
    const x = cx - barW / 2;
    const hourLabel = formatPvuHourLabel(hour);
    const hourBreakdown = buildHourlyBreakdownFromLogs(hourlySiteLogs, day.dayKey, hour);
    const barGroup = renderPvuStackedBar(svgNs, {
      parent: svg,
      x,
      baseY,
      barW,
      chartH,
      columnWidth: barGap,
      maxAxis,
      useMinutes,
      byType,
      className: 'pvu-bar pvu-hour-bar',
      dataAttrs: { 'data-hour': String(hour) },
      labelText: hour % 3 === 0 ? hourLabel : '',
      labelY: height - 8,
      labelClassName: 'pvu-hour-label',
      tooltipText: formatPvuHourTooltip(hour, byType, total)
    });
    barGroup.setAttribute('tabindex', '0');
    barGroup.setAttribute('role', 'button');
    barGroup.setAttribute('aria-label', `${hourLabel} breakdown`);
    const activate = () => activatePvuHourHover(hour);
    const selectHour = () => showPvuHourBreakdown(hourBreakdown, hourLabel, { pin: true, hour });
    barGroup.addEventListener('mouseenter', activate);
    barGroup.addEventListener('focus', activate);
    barGroup.addEventListener('blur', () => {
      if (!pvuHourBreakdownPinned) hidePvuHourBreakdown();
    });
    barGroup.addEventListener('click', selectHour);
    barGroup.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectHour();
      }
    });
  });

  // Trailing "12 AM" (end-of-day) tick label removed per user report
  // 2026-07 v49: it sat right next to the "9 PM" tick and made the
  // pair look squished. 9 PM is the last labeled tick — the axis end
  // at 24 is implicit from the tick sequence.

  chartEl.appendChild(svg);
  ensurePvuHourWrapHoverHandlers();

  if (pvuHourBreakdownPinned && pvuHourBreakdownPinnedHour != null) {
    const hourBreakdown = buildHourlyBreakdownFromLogs(hourlySiteLogs, day.dayKey, pvuHourBreakdownPinnedHour);
    showPvuHourBreakdown(hourBreakdown, formatPvuHourLabel(pvuHourBreakdownPinnedHour), {
      pin: true,
      hour: pvuHourBreakdownPinnedHour
    });
  }

  if (maxSec <= 0) {
    const empty = document.createElement('div');
    empty.className = 'pvu-hour-empty';
    empty.textContent = day.total > 0
      ? 'Hourly breakdown is recorded going forward. Daily totals are shown in the chart above.'
      : 'No site activity recorded for this day yet.';
    chartEl.appendChild(empty);
  }
}

function formatRealProductivityScore(score) {
  const s = Math.max(0, Number(score) || 0);
  if (s <= 0) return '0';
  if (s >= 100) return String(Math.round(s));
  return String(Math.round(s * 10) / 10);
}

function formatRealProductivityScoreLabel(score) {
  return `${formatRealProductivityScore(score)} pts`;
}

// Per user spec 2026-07: axis top raised from 20 → 40 (step 10, 4 ticks).
const REAL_PRODUCTIVITY_AXIS_STEP = 10;
const REAL_PRODUCTIVITY_AXIS_TICK_COUNT = 4;

function formatRealProductivityAxisValue(value) {
  const v = Number(value) || 0;
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

/** Axis ceiling for the weekly line chart — 500-pt ticks (0, 500, 1000, …) with headroom above peak. */
function realProductivityChartAxisMax(maxScore) {
  const minMax = REAL_PRODUCTIVITY_AXIS_STEP * REAL_PRODUCTIVITY_AXIS_TICK_COUNT;
  const peak = Math.max(Number(maxScore) || 0, 0);
  if (peak <= 0) return minMax;
  // Headroom proportional to the (now smaller, 0–20) scale. 30% headroom with a
  // small flat bump, then snap up to the nearest tick multiple.
  const withHeadroom = Math.max(peak * 1.3, peak + Math.max(peak * 0.2, 1));
  return Math.max(minMax, Math.ceil(withHeadroom / minMax) * minMax);
}

function summarizeRealProductivity(days) {
  let totalScore = 0;
  let activeDays = 0;
  for (const day of days) {
    const score = day.realProductivityScore || 0;
    totalScore += score;
    if (score > 0) activeDays += 1;
  }
  const dayCount = days.length || 7;
  const avgScore = dayCount > 0 ? totalScore / dayCount : 0;
  return { totalScore, activeDays, avgScore, dayCount };
}

function realProductivityImprovementPct(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (cur <= prev || prev <= 0) return null;
  // Anti-inflation: if yesterday's score was very small (<= 60 sec of
  // engagement), a tiny-baseline comparison produces absurd percentages
  // like "3000% more productive than yesterday". Suppress the message in
  // that case — comparing today to a near-zero baseline isn't meaningful.
  // Per user report 2026-07 ("i think its wrong please check this and fix it").
  if (prev <= 60) return null;
  const raw = ((cur - prev) / prev) * 100;
  // Cap at 100% (i.e. "doubled"). Higher numbers technically make sense but
  // read as unreliable to most users. Above the cap, the caller can render
  // a special "way more productive" copy.
  return Math.round(Math.min(100, raw));
}

function getPreviousStreakDayKey(dayKey) {
  const d = dayKeyToDate(dayKey);
  if (!d) return null;
  d.setDate(d.getDate() - 1);
  return streakDayKey(d);
}

function renderRealProductivity7DaySummary(days) {
  const el = document.getElementById('realProductivity7DaySummary');
  if (!el) return;
  const { totalScore, avgScore } = summarizeRealProductivity(days);
  const weekLabel = pvuWeekOffset === 0 ? 'this week' : formatPvuWeekRangeLabel(pvuWeekOffset).toLowerCase();
  if (totalScore <= 0) {
    // User spec 2026-07 v36: friendlier empty state for brand-new users.
    // Was "No productive site engagement recorded for {week} yet" which
    // read as an error/reproach rather than a welcome.
    el.textContent = `Your stats will appear here once you start browsing. Nothing to show for ${weekLabel} yet.`;
    return;
  }
  let html = `<strong>${formatRealProductivityScoreLabel(totalScore)}</strong> over ${weekLabel} · avg ${formatRealProductivityScoreLabel(avgScore)}/day`;
  const prevDays = buildPvuDaysFromLogs(pvuDailySiteLogs, pvuDailyProductiveEngagement, pvuWeekOffset + 1);
  const prevTotal = summarizeRealProductivity(prevDays).totalScore;
  const pct = realProductivityImprovementPct(totalScore, prevTotal);
  if (pct != null) {
    html += `<span class="real-productivity-comparison-up">It's ${pct}% more productive this week than last.</span>`;
  }
  el.innerHTML = html;
}

function renderRealProductivityDaySummary(day, days) {
  const el = document.getElementById('realProductivityDaySummary');
  if (!el) return;
  const currentScore = day?.realProductivityScore || 0;
  if (currentScore <= 0) {
    el.replaceChildren();
    el.hidden = true;
    return;
  }
  const prevKey = getPreviousStreakDayKey(day.dayKey);
  let prevScore = 0;
  if (prevKey) {
    const inWeek = days.find((d) => d.dayKey === prevKey);
    prevScore = inWeek
      ? (inWeek.realProductivityScore || 0)
      : (Number(pvuDailyProductiveEngagement[prevKey]) || 0);
  }
  const pct = realProductivityImprovementPct(currentScore, prevScore);
  if (pct == null) {
    el.replaceChildren();
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="real-productivity-comparison-up">It's ${pct}% more productive than yesterday.</span>`;
}

function ensureRealProductivityTooltip(wrap) {
  if (!wrap) return null;
  let tip = wrap.querySelector('.real-productivity-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'real-productivity-tooltip';
    tip.hidden = true;
    wrap.appendChild(tip);
  }
  return tip;
}

function showRealProductivityTooltip(wrap, text, evt) {
  if (tutorialBlocksPvuHover()) return;
  const tip = ensureRealProductivityTooltip(wrap);
  if (!tip || !wrap) return;
  const rect = wrap.getBoundingClientRect();
  tip.textContent = text;
  tip.hidden = false;
  tip.style.left = `${evt.clientX - rect.left}px`;
  tip.style.top = `${evt.clientY - rect.top}px`;
}

function hideRealProductivityTooltip(wrap) {
  const tip = wrap?.querySelector('.real-productivity-tooltip');
  if (tip) tip.hidden = true;
}

function ensureRealProductivityTooltipHandlers(wrap) {
  if (!wrap || wrap.dataset.rpTooltipBound === '1') return;
  wrap.dataset.rpTooltipBound = '1';
  wrap.addEventListener('mouseleave', (e) => {
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    hideRealProductivityTooltip(wrap);
  });
}

function bindRealProductivityHoverTarget(target, wrap, getTooltipText) {
  if (!target || !wrap) return;
  target.addEventListener('mouseenter', (evt) => {
    showRealProductivityTooltip(wrap, getTooltipText(), evt);
  });
  target.addEventListener('mousemove', (evt) => {
    showRealProductivityTooltip(wrap, getTooltipText(), evt);
  });
  target.addEventListener('mouseleave', () => {
    hideRealProductivityTooltip(wrap);
  });
}

function formatRealProductivityDayScore(dayLabel, score) {
  if (score > 0) {
    return `${dayLabel}: ${formatRealProductivityScoreLabel(score)}`;
  }
  return `${dayLabel}: No productive engagement`;
}

function appendRealProductivityRightAxis(svg, svgNs, { width, padRight, padTop, chartH, maxEngagement }) {
  const tickCount = REAL_PRODUCTIVITY_AXIS_TICK_COUNT;
  const step = maxEngagement / tickCount;
  for (let i = 0; i <= tickCount; i++) {
    const frac = i / tickCount;
    const y = padTop + chartH - frac * chartH;
    const label = document.createElementNS(svgNs, 'text');
    label.setAttribute('class', 'pvu-axis-label pvu-axis-label--engagement');
    label.setAttribute('x', String(width - padRight + 8));
    label.setAttribute('y', String(y + 4));
    label.setAttribute('text-anchor', 'start');
    label.setAttribute('fill', REAL_PRODUCTIVITY_COLOR);
    label.textContent = formatRealProductivityAxisValue(step * i);
    svg.appendChild(label);
  }
}

function appendRealProductivityLine(svg, svgNs, days, layout, daysLength, chartWrap) {
  const { padLeft, padTop, chartH, barGap, width, padRight } = layout;
  const maxEngagement = layout.maxEngagement || 1;
  const points = days.map((day, i) => {
    const score = day.realProductivityScore || 0;
    const cx = padLeft + barGap * i + barGap / 2;
    const y = padTop + chartH - (score / maxEngagement) * chartH;
    return { x: cx, y, score, dayIndex: i };
  });

  const group = document.createElementNS(svgNs, 'g');
  group.setAttribute('class', 'real-productivity-line-group');

  const visualGroup = document.createElementNS(svgNs, 'g');
  visualGroup.setAttribute('class', 'real-productivity-line-visual');

  if (points.some((p) => p.score > 0)) {
    const polyline = document.createElementNS(svgNs, 'polyline');
    polyline.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', REAL_PRODUCTIVITY_COLOR);
    polyline.setAttribute('stroke-width', '2.5');
    polyline.setAttribute('stroke-linejoin', 'round');
    polyline.setAttribute('stroke-linecap', 'round');
    polyline.setAttribute('class', 'real-productivity-line');
    visualGroup.appendChild(polyline);

    points.forEach((p) => {
      if (p.score <= 0) return;
      const dot = document.createElementNS(svgNs, 'circle');
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      dot.setAttribute('r', '4');
      dot.setAttribute('fill', REAL_PRODUCTIVITY_COLOR);
      dot.setAttribute('stroke', '#fff');
      dot.setAttribute('stroke-width', '1.5');
      visualGroup.appendChild(dot);
    });
  }

  group.appendChild(visualGroup);

  points.forEach((p) => {
    const dayLabel = formatPvuDayLabel(p.dayIndex, daysLength);
    const hitY = p.score > 0 ? p.y : padTop + chartH;
    const hit = document.createElementNS(svgNs, 'circle');
    hit.setAttribute('cx', String(p.x));
    hit.setAttribute('cy', String(hitY));
    hit.setAttribute('r', '14');
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('class', 'real-productivity-hit');
    bindRealProductivityHoverTarget(
      hit,
      chartWrap,
      () => formatRealProductivityDayScore(dayLabel, p.score)
    );
    group.appendChild(hit);
  });

  appendRealProductivityRightAxis(svg, svgNs, { width, padRight, padTop, chartH, maxEngagement });
  svg.appendChild(group);
}

function createPvuStackSegment(svgNs, { x, y, width, height, fill, roundTop = false, roundBottom = false, radius = 3 }) {
  const h = Math.max(height, 1);
  const w = width;
  const r = Math.min(radius, w / 2, h / 2);

  if (roundTop && roundBottom && r > 0) {
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', String(r));
    rect.setAttribute('fill', fill);
    return rect;
  }

  if (!roundTop && !roundBottom) {
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('fill', fill);
    return rect;
  }

  const x0 = x;
  const x1 = x + w;
  const y0 = y;
  const y1 = y + h;
  let d;
  if (roundTop) {
    d = r <= 0
      ? `M ${x0} ${y1} L ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} Z`
      : `M ${x0} ${y1} L ${x0} ${y0 + r} Q ${x0} ${y0} ${x0 + r} ${y0} L ${x1 - r} ${y0} Q ${x1} ${y0} ${x1} ${y0 + r} L ${x1} ${y1} Z`;
  } else {
    d = r <= 0
      ? `M ${x0} ${y0} L ${x0} ${y1} L ${x1} ${y1} L ${x1} ${y0} Z`
      : `M ${x0} ${y0} L ${x0} ${y1 - r} Q ${x0} ${y1} ${x0 + r} ${y1} L ${x1 - r} ${y1} Q ${x1} ${y1} ${x1} ${y1 - r} L ${x1} ${y0} Z`;
  }
  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', fill);
  return path;
}

function clearPvuHourBreakdownPosition() {
  const breakdownEl = $('pvuHourBreakdown');
  if (!breakdownEl) return;
  breakdownEl.style.left = '';
  breakdownEl.style.right = '';
  breakdownEl.style.top = '';
  breakdownEl.style.bottom = '';
  breakdownEl.classList.remove('pvu-breakdown--align-left', 'pvu-breakdown--align-right');
}

function positionPvuHourBreakdownNearBar(hour) {
  const breakdownEl = $('pvuHourBreakdown');
  const wrap = breakdownEl?.closest('.pvu-hour-chart-wrap');
  if (!breakdownEl || !wrap) return;

  clearPvuHourBreakdownPosition();

  const barEl = wrap.querySelector(`.pvu-hour-bar[data-hour="${hour}"]`);
  if (!barEl) return;

  const wrapRect = wrap.getBoundingClientRect();
  const barRect = barEl.getBoundingClientRect();
  const gap = 10;
  const panelW = breakdownEl.offsetWidth;
  const panelH = breakdownEl.offsetHeight;

  if (wrapRect.width < 640) {
    breakdownEl.style.left = '12px';
    breakdownEl.style.right = '12px';
    breakdownEl.style.width = 'calc(100% - 24px)';
    breakdownEl.style.top = `${Math.max(12, barRect.top - wrapRect.top)}px`;
    return;
  }

  let left = barRect.right - wrapRect.left + gap;
  if (left + panelW > wrapRect.width - 8) {
    left = barRect.left - wrapRect.left - panelW - gap;
    breakdownEl.classList.add('pvu-breakdown--align-left');
  } else {
    breakdownEl.classList.add('pvu-breakdown--align-right');
  }
  left = Math.max(8, Math.min(left, wrapRect.width - panelW - 8));
  // EMPTY-STATE POSITIONING mirrors the main chart. When the hourly view
  // has no data (fresh install or a quiet day) the pinned-top tooltip
  // feels floaty and disconnected. Park it right above the hour-label
  // row instead so it sits next to the column the user is hovering.
  let top;
  if (!pvuHourHasData) {
    // Same bump as main PVU (user report 2026-07 v52): from 46 to 90
    // so the empty-state panel doesn't sit right on top of the hour
    // labels.
    const bottomMargin = 90;
    top = wrapRect.height - panelH - bottomMargin;
    top = Math.max(12, top);
  } else {
    // PIN TO TOP (user spec 2026-07 v3, "make that much higher up please"):
    // pin the hover panel to the top strip of the chart wrap regardless of
    // where the hovered bar sits. Bar-relative positioning kept dropping the
    // panel into the axis-label zone on short bars.
    top = 12;
    top = Math.max(12, Math.min(top, wrapRect.height - panelH - 12));
  }

  breakdownEl.style.left = `${left}px`;
  breakdownEl.style.top = `${top}px`;
}

function hidePvuHourBreakdown() {
  if (pvuHourBreakdownPinned) return;
  const breakdownEl = $('pvuHourBreakdown');
  if (breakdownEl) {
    breakdownEl.hidden = true;
    breakdownEl.classList.remove('pvu-breakdown--hover');
  }
  pvuHoverHour = null;
  clearPvuHourBreakdownPosition();
  highlightPvuHourChartBar(-1);
}

function ensurePvuHourWrapHoverHandlers() {
  if (pvuHourWrapHoverBound) return;
  const wrap = document.querySelector('.pvu-hour-chart-wrap');
  if (!wrap) return;
  pvuHourWrapHoverBound = true;
  wrap.addEventListener('mousemove', (e) => {
    if (pvuHourBreakdownPinned || tutorialBlocksPvuHover()) return;
    const hour = getPvuChartBarIndexAtPoint(
      e.clientX, e.clientY, wrap, '.pvu-hour-bar[data-hour]', 'data-hour'
    );
    if (hour == null) return;
    activatePvuHourHover(hour);
  });
  wrap.addEventListener('mouseleave', (e) => {
    if (pvuHourBreakdownPinned) return;
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    hidePvuHourBreakdown();
  });
}

function highlightPvuHourChartBar(hour) {
  document.querySelectorAll('#pvuHourChart .pvu-hour-bar[data-hour]').forEach((el) => {
    el.classList.toggle('pvu-hour-bar--selected', Number(el.getAttribute('data-hour')) === hour);
  });
}

function showPvuHourBreakdown(hourData, hourLabel, { pin = false, hour = 0 } = {}) {
  if (tutorialBlocksPvuHover()) return;
  const breakdownEl = $('pvuHourBreakdown');
  if (!breakdownEl) return;

  pvuHourBreakdownPinned = pin;
  pvuHourBreakdownPinnedHour = pin ? hour : null;
  breakdownEl.hidden = false;
  breakdownEl.classList.toggle('pvu-breakdown--hover', !pin);
  if (!pin) pvuHoverHour = hour;
  breakdownEl.replaceChildren();

  const header = document.createElement('div');
  header.className = 'pvu-breakdown-header';
  const title = document.createElement('div');
  title.className = 'pvu-breakdown-title';
  title.textContent = hourLabel;
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pvu-breakdown-close';
  closeBtn.setAttribute('aria-label', 'Close breakdown');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    pvuHourBreakdownPinned = false;
    pvuHourBreakdownPinnedHour = null;
    pvuHoverHour = null;
    breakdownEl.hidden = true;
    breakdownEl.classList.remove('pvu-breakdown--hover');
    clearPvuHourBreakdownPosition();
    highlightPvuHourChartBar(-1);
  });
  header.appendChild(closeBtn);
  breakdownEl.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'pvu-breakdown-grid';
  // User spec 2026-07 v36: when the hour has type totals but no per-host
  // breakdown (e.g. a Work Timer session credited its productive minutes
  // as a lump sum without per-site attribution), synthesise a "Timer
  // session" row per non-zero type so the user sees the actual time
  // instead of a blank "--". Fixes "hourly analytics don't work — timers
  // show only --".
  const buildColumnRows = (type) => {
    const hosts = hourData.byHost?.[type] || [];
    if (hosts.length > 0) return hosts;
    const typeTotal = Math.floor(Number(hourData.byType?.[type]) || 0);
    if (typeTotal > 0) {
      return [{ host: 'Timer session', sec: typeTotal, __synthetic: true }];
    }
    return [];
  };
  const emptyHourLabel = hourData.hasHostDetail === false && hourData.total > 0
    ? 'No sites logged for this hour yet'
    : '—';
  appendPvuBreakdownColumn(grid, 'Neutral', buildColumnRows('Neutral'), emptyHourLabel);
  appendPvuBreakdownColumn(grid, 'Productive', buildColumnRows('Productive'), emptyHourLabel);
  appendPvuBreakdownColumn(grid, 'Unproductive', buildColumnRows('Unproductive'), emptyHourLabel);
  breakdownEl.appendChild(grid);

  highlightPvuHourChartBar(hour);
  requestAnimationFrame(() => positionPvuHourBreakdownNearBar(hour));
}

function hidePvuBreakdown() {
  if (pvuBreakdownPinned) return;
  const breakdownEl = $('pvuBreakdown');
  if (breakdownEl) {
    breakdownEl.hidden = true;
    breakdownEl.classList.remove('pvu-breakdown--hover');
  }
  pvuHoverDayIndex = null;
  clearPvuBreakdownPosition();
  highlightPvuChartBar(-1);
}

function pvuFaviconUrl(host) {
  const h = String(host || '').replace(/^www\./, '').trim();
  if (!h) return '';
  // Primary: DuckDuckGo icon service — reliably returns a real favicon for
  // virtually every site, unlike Chrome's _favicon API which returns a blank
  // transparent 1x1 for sites it hasn't cached (and that blank loads
  // "successfully" so the onerror fallback never fires). Per user report
  // (2026-07): "some of the favicons like youtube are not showing."
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(h)}.ico`;
}

/**
 * Ordered list of favicon sources to try for a host, primary first. Used by
 * the <img onerror> handler to fall through to the next source if the
 * current one 404s. Allows us to recover when _favicon doesn't have the
 * site cached (user hasn't visited it yet).
 */
function pvuFaviconFallbackChain(host) {
  const h = String(host || '').replace(/^www\./, '').trim();
  if (!h) return [];
  return [
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(h)}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32`,
    `https://${h}/favicon.ico`,
  ];
}

/**
 * Wire an <img> element with the full favicon fallback chain. Each error
 * advances to the next source; final fallback hides the icon.
 */
function pvuAttachFaviconFallback(imgEl, host) {
  if (!imgEl || !host) return;
  const chain = pvuFaviconFallbackChain(host);
  let nextIdx = 0;
  imgEl.addEventListener('error', function onErr() {
    if (nextIdx < chain.length) {
      imgEl.src = chain[nextIdx++];
    } else {
      imgEl.removeEventListener('error', onErr);
      imgEl.style.visibility = 'hidden';
    }
  });
}

// Cap for the PVU hover breakdown columns (daily + hourly popups).
// User spec 2026-07 v35 → v36: each column shows 7 sites, then "and N more"
// for the tail. The separate "Daily Sites" list (daily-sites-* render path)
// is NOT affected — it uses its own row builder and stays uncapped.
const PVU_BREAKDOWN_MAX_ROWS = 7;

function appendPvuBreakdownColumn(parent, title, hosts, emptyLabel = '—') {
  const col = document.createElement('div');
  col.className = 'pvu-breakdown-col';
  const colTitle = document.createElement('h4');
  colTitle.textContent = title;
  col.appendChild(colTitle);
  if (!hosts || hosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pvu-breakdown-row';
    empty.textContent = emptyLabel;
    col.appendChild(empty);
  } else {
    // Hosts are expected to be pre-sorted by time descending (the caller
    // builds them via buildColumnRows). Slicing here keeps the biggest N.
    const shown = hosts.slice(0, PVU_BREAKDOWN_MAX_ROWS);
    const hiddenCount = Math.max(0, hosts.length - shown.length);
    shown.forEach(({ host, sec }) => {
      const row = document.createElement('div');
      row.className = 'pvu-breakdown-row';
      const left = document.createElement('span');
      left.className = 'pvu-breakdown-host';
      const icon = document.createElement('img');
      icon.className = 'pvu-breakdown-favicon';
      icon.src = pvuFaviconUrl(host);
      icon.alt = '';
      icon.width = 16;
      icon.height = 16;
      icon.loading = 'lazy';
      icon.referrerPolicy = 'no-referrer';
      pvuAttachFaviconFallback(icon, host);
      const label = document.createElement('span');
      label.className = 'pvu-breakdown-hostname';
      label.textContent = host;
      left.appendChild(icon);
      left.appendChild(label);
      const right = document.createElement('span');
      right.className = 'pvu-breakdown-time';
      right.textContent = formatActiveTime(sec * 1000);
      row.appendChild(left);
      row.appendChild(right);
      col.appendChild(row);
    });
    if (hiddenCount > 0) {
      const more = document.createElement('div');
      more.className = 'pvu-breakdown-row pvu-breakdown-row--more';
      more.textContent = `and ${hiddenCount} more`;
      more.style.opacity = '0.7';
      more.style.fontStyle = 'italic';
      col.appendChild(more);
    }
  }
  parent.appendChild(col);
}

function showPvuBreakdown(day, dayLabel, { pin = false, dayIndex = 0 } = {}) {
  if (tutorialBlocksPvuHover()) return;
  const breakdownEl = $('pvuBreakdown');
  if (!breakdownEl) return;

  pvuBreakdownPinned = pin;
  pvuBreakdownPinnedDayKey = pin ? day.dayKey : null;
  breakdownEl.hidden = false;
  breakdownEl.classList.toggle('pvu-breakdown--hover', !pin);
  if (!pin) {
    pvuHoverDayIndex = dayIndex;
    highlightPvuChartBar(dayIndex);
  } else {
    pvuHoverDayIndex = null;
  }
  breakdownEl.replaceChildren();

  const header = document.createElement('div');
  header.className = 'pvu-breakdown-header';
  const title = document.createElement('div');
  title.className = 'pvu-breakdown-title';
  title.textContent = dayLabel;
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pvu-breakdown-close';
  closeBtn.setAttribute('aria-label', 'Close breakdown');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    pvuBreakdownPinned = false;
    pvuBreakdownPinnedDayKey = null;
    pvuHoverDayIndex = null;
    breakdownEl.hidden = true;
    breakdownEl.classList.remove('pvu-breakdown--hover');
    clearPvuBreakdownPosition();
    highlightPvuChartBar(-1);
  });
  header.appendChild(closeBtn);
  breakdownEl.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'pvu-breakdown-grid';
  appendPvuBreakdownColumn(grid, 'Neutral', day.byHost.Neutral || []);
  appendPvuBreakdownColumn(grid, 'Productive', day.byHost.Productive || []);
  appendPvuBreakdownColumn(grid, 'Unproductive', day.byHost.Unproductive || []);
  breakdownEl.appendChild(grid);

  // Tutorial step 13: pointy callouts on the TWO youtube.com rows — same
  // site on both sides of the chart, and the bubbles explain why (maths
  // lecture = productive, gaming video = unproductive). Appears on every
  // hovered bar during the tutorial preview; never on the real dashboard.
  pfTutorialAttachYoutubeCallouts(breakdownEl);

  requestAnimationFrame(() => positionPvuBreakdownNearBar(dayIndex));
}

/**
 * During the tutorial PVU step, attach a speech-bubble callout to the
 * youtube.com row in BOTH the Productive and Unproductive columns of the
 * hovered-day breakdown. The two bubbles teach the per-video classification:
 * one YouTube, two verdicts.
 */
function pfTutorialAttachYoutubeCallouts(breakdownEl) {
  if (!document.body.classList.contains('tutorial-step-pvu')) return;
  if (!breakdownEl) return;
  breakdownEl.querySelectorAll('.pvu-breakdown-col').forEach((col) => {
    const title = (col.querySelector('h4')?.textContent || '').toLowerCase();
    const isProd = title.startsWith('productive');
    const isUnprod = title.startsWith('unproductive');
    if (!isProd && !isUnprod) return;
    const hostEl = [...col.querySelectorAll('.pvu-breakdown-hostname')]
      .find((el) => el.textContent.trim().replace(/^www\./, '') === 'youtube.com');
    const row = hostEl?.closest('.pvu-breakdown-row');
    if (!row || row.querySelector('.pf-tutor-callout')) return;
    row.classList.add('pf-tutor-callout-anchor');
    const tip = document.createElement('div');
    tip.className = `pf-tutor-callout ${isProd ? 'pf-tutor-callout--prod' : 'pf-tutor-callout--unprod'}`;
    tip.textContent = isProd
      ? 'You were watching a maths lecture, so it counted as productive.'
      : 'Same site can go both ways. Here you were watching a gaming video.';
    row.appendChild(tip);
  });
}

const PVU_DISPLAY_TYPE_ORDER = ['Productive', 'Unproductive', 'Neutral'];

function groupDayHostsBySite(day) {
  const hostMap = new Map();
  for (const type of PVU_STACK_ORDER) {
    for (const { host, sec } of day.byHost[type] || []) {
      if (!hostMap.has(host)) {
        hostMap.set(host, { Neutral: 0, Productive: 0, Unproductive: 0 });
      }
      hostMap.get(host)[type] += sec;
    }
  }
  return Array.from(hostMap.entries())
    .map(([host, byType]) => {
      const types = PVU_DISPLAY_TYPE_ORDER
        .map((type) => ({ type, sec: byType[type] || 0 }))
        .filter((entry) => entry.sec > 0);
      const totalSec = types.reduce((sum, entry) => sum + entry.sec, 0);
      return { host, types, totalSec, isMultiType: types.length > 1 };
    })
    .sort((a, b) => b.totalSec - a.totalSec || a.host.localeCompare(b.host));
}

function flattenDayHosts(day) {
  const all = [];
  const hostTotals = new Map();
  for (const type of PVU_STACK_ORDER) {
    for (const { host, sec } of day.byHost[type] || []) {
      all.push({ host, sec, type });
      hostTotals.set(host, (hostTotals.get(host) || 0) + sec);
    }
  }
  return all.sort((a, b) => {
    const totalDiff = (hostTotals.get(b.host) || 0) - (hostTotals.get(a.host) || 0);
    if (totalDiff !== 0) return totalDiff;
    if (a.host !== b.host) return a.host.localeCompare(b.host);
    return PVU_STACK_ORDER.indexOf(a.type) - PVU_STACK_ORDER.indexOf(b.type);
  });
}

function appendDailySiteRow(listEl, entry) {
  const row = document.createElement('div');
  row.className = 'daily-sites-row';

  const icon = document.createElement('img');
  icon.className = 'daily-sites-row-favicon';
  icon.src = pvuFaviconUrl(entry.host);
  icon.alt = '';
  icon.width = 16;
  icon.height = 16;
  icon.loading = 'lazy';
  icon.referrerPolicy = 'no-referrer';
  pvuAttachFaviconFallback(icon, entry.host);

  const hostEl = document.createElement('span');
  hostEl.className = 'daily-sites-row-host';
  hostEl.textContent = entry.host;

  row.appendChild(icon);
  row.appendChild(hostEl);

  if (entry.isMultiType) {
    const typesEl = document.createElement('span');
    typesEl.className = 'daily-sites-row-types';
    for (const { type } of entry.types) {
      const pill = document.createElement('span');
      pill.className = `daily-sites-row-type daily-sites-row-type--${type.toLowerCase()}`;
      pill.textContent = type;
      typesEl.appendChild(pill);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'daily-sites-row-time daily-sites-row-time--split';
    timeEl.textContent = entry.types.map(({ sec }) => formatActiveTime(sec * 1000)).join(' / ');

    row.title = entry.types
      .map(({ type, sec }) => `${type} ${formatActiveTime(sec * 1000)}`)
      .join(' · ');
    row.appendChild(typesEl);
    row.appendChild(timeEl);
  } else {
    const { type, sec } = entry.types[0];
    const typeEl = document.createElement('span');
    typeEl.className = `daily-sites-row-type daily-sites-row-type--${type.toLowerCase()}`;
    typeEl.textContent = type;

    const timeEl = document.createElement('span');
    timeEl.className = 'daily-sites-row-time';
    timeEl.textContent = formatActiveTime(sec * 1000);

    row.appendChild(typeEl);
    row.appendChild(timeEl);
  }

  listEl.appendChild(row);
}

function defaultPvuSelectedDayKey(days) {
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].total > 0) return days[i].dayKey;
  }
  return days[days.length - 1]?.dayKey ?? null;
}

function highlightPvuChartBar(dayIndex) {
  document.querySelectorAll('#pvuChart .pvu-bar[data-day-index]').forEach((el) => {
    el.classList.toggle('pvu-bar--selected', Number(el.getAttribute('data-day-index')) === dayIndex);
  });
}

function selectPvuDay(days, dayIndex) {
  const day = days[dayIndex];
  if (!day) return;
  pvuSelectedDayKey = day.dayKey;
  pvuFollowLiveDay = isPvuTodayDayKey(day.dayKey);
  const dayLabel = formatPvuDayLabel(dayIndex, days.length);
  showPvuBreakdown(day, dayLabel, { pin: true, dayIndex });
  renderDailySites(days, pvuSelectedDayKey);
  renderPvuHourChart(days, pvuSelectedDayKey, pvuHourlySiteLogs);
  highlightPvuChartBar(dayIndex);
  updatePvuDayNavState(days, pvuSelectedDayKey);
}

function shiftPvuSelectedDay(delta) {
  const days = pvuCurrentDays;
  if (!days?.length) return;
  let idx = days.findIndex((d) => d.dayKey === pvuSelectedDayKey);
  if (idx < 0) idx = days.findIndex((d) => d.dayKey === defaultPvuSelectedDayKey(days));
  if (idx < 0) idx = days.length - 1;
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= days.length) return;
  if (delta < 0) pvuFollowLiveDay = false;
  selectPvuDay(days, nextIdx);
  if (pvuWeekOffset === 0 && days[nextIdx]?.dayKey === getCurrentStreakDayKey()) {
    pvuFollowLiveDay = true;
  }
}

function shiftPvuWeek(delta) {
  const maxOffset = getMaxPvuWeekOffset(pvuDailySiteLogs);
  const nextOffset = pvuWeekOffset + delta;
  if (nextOffset < 0 || nextOffset > maxOffset) return;
  pvuWeekOffset = nextOffset;
  if (nextOffset === 0) {
    pvuFollowLiveWeek = true;
    pvuFollowLiveDay = true;
  } else if (delta > 0) {
    pvuFollowLiveWeek = false;
    pvuFollowLiveDay = false;
  }
  pvuBreakdownPinned = false;
  pvuBreakdownPinnedDayKey = null;
  pvuSelectedDayKey = null;
  renderProductiveVsUnproductive();
}

function updatePvuWeekNavState() {
  const prevBtn = $('pvuWeekPrev');
  const nextBtn = $('pvuWeekNext');
  const labelEl = $('pvuWeekLabel');
  const maxOffset = getMaxPvuWeekOffset(pvuDailySiteLogs);
  if (labelEl) labelEl.textContent = formatPvuWeekRangeLabel(pvuWeekOffset);
  if (prevBtn) prevBtn.disabled = pvuWeekOffset >= maxOffset;
  if (nextBtn) nextBtn.disabled = pvuWeekOffset <= 0;
}

function updatePvuDayNavState(days = pvuCurrentDays, selectedDayKey = pvuSelectedDayKey) {
  const prevBtn = $('pvuDayPrev');
  const nextBtn = $('pvuDayNext');
  if (!prevBtn || !nextBtn || !days?.length) return;
  const idx = days.findIndex((d) => d.dayKey === selectedDayKey);
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx < 0 || idx >= days.length - 1;
}

function ensurePvuWeekNavHandlers() {
  if (pvuWeekNavBound) return;
  const wrap = $('pvuWeekNavWrap');
  const prevBtn = $('pvuWeekPrev');
  const nextBtn = $('pvuWeekNext');
  if (!wrap || !prevBtn || !nextBtn) return;
  pvuWeekNavBound = true;
  prevBtn.addEventListener('click', () => shiftPvuWeek(1));
  nextBtn.addEventListener('click', () => shiftPvuWeek(-1));
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      shiftPvuWeek(1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      shiftPvuWeek(-1);
    }
  });
}

function ensurePvuDayNavHandlers() {
  if (pvuDayNavBound) return;
  const nav = $('pvuDayNav');
  const prevBtn = $('pvuDayPrev');
  const nextBtn = $('pvuDayNext');
  if (!nav || !prevBtn || !nextBtn) return;
  pvuDayNavBound = true;
  prevBtn.addEventListener('click', () => shiftPvuSelectedDay(-1));
  nextBtn.addEventListener('click', () => shiftPvuSelectedDay(1));
  const onDayKeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    shiftPvuSelectedDay(e.key === 'ArrowLeft' ? -1 : 1);
  };
  nav.addEventListener('keydown', (e) => {
    onDayKeydown(e);
    e.stopPropagation();
  });
  const hourPanel = $('pvuHourPanel');
  if (hourPanel) hourPanel.addEventListener('keydown', onDayKeydown);
}

function renderDailySiteDayBlock(content, day, daysLength) {
  const hosts = flattenDayHosts(day);
  const groupedHosts = groupDayHostsBySite(day);
  const block = document.createElement('div');
  block.className = 'daily-sites-day';
  const dayLabel = formatPvuDayLabel(day.dayIndex, daysLength);

  const header = document.createElement('div');
  header.className = 'daily-sites-day-header';
  const name = document.createElement('div');
  name.className = 'daily-sites-day-name';
  name.textContent = dayLabel;
  const total = document.createElement('div');
  total.className = 'daily-sites-day-total';
  total.textContent = formatActiveTime(day.total * 1000);
  header.appendChild(name);
  header.appendChild(total);
  block.appendChild(header);

  if (day.total <= 0 || hosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'daily-sites-empty';
    empty.textContent = 'No site activity on this day.';
    block.appendChild(empty);
    content.appendChild(block);
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'daily-sites-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `Site mix for ${name.textContent}`);
  for (const entry of hosts) {
    const seg = document.createElement('div');
    seg.className = 'daily-sites-segment';
    seg.style.flex = String(Math.max(entry.sec, 1));
    seg.style.background = PVU_TYPE_COLORS[entry.type];
    seg.title = `${entry.host} — ${formatActiveTime(entry.sec * 1000)} (${entry.type})`;
    bar.appendChild(seg);
  }
  block.appendChild(bar);

  const list = document.createElement('div');
  list.className = 'daily-sites-list';
  for (const entry of groupedHosts) {
    appendDailySiteRow(list, entry);
  }
  block.appendChild(list);
  content.appendChild(block);
}

function renderDailySites(days, selectedDayKey) {
  const content = $('dailySitesContent');
  const heading = document.querySelector('.daily-sites-heading');
  if (!content) return;
  content.replaceChildren();

  const hasAnyData = days.some((d) => d.total > 0);
  if (!hasAnyData) {
    if (heading) heading.textContent = 'Daily Sites';
    const empty = document.createElement('div');
    empty.className = 'daily-sites-empty';
    empty.textContent = 'No site activity recorded yet.';
    content.appendChild(empty);
    return;
  }

  let dayKey = selectedDayKey;
  if (!dayKey || !days.some((d) => d.dayKey === dayKey)) {
    dayKey = defaultPvuSelectedDayKey(days);
    pvuSelectedDayKey = dayKey;
  }

  const dayIndex = days.findIndex((d) => d.dayKey === dayKey);
  if (dayIndex < 0) {
    if (heading) heading.textContent = 'Daily Sites';
    const empty = document.createElement('div');
    empty.className = 'daily-sites-empty';
    empty.textContent = 'No site activity recorded yet.';
    content.appendChild(empty);
    return;
  }

  const day = { ...days[dayIndex], dayIndex };
  const dayLabel = formatPvuDayHeading(day.dayKey);
  if (heading) heading.textContent = `Daily Sites — ${dayLabel}`;
  renderDailySiteDayBlock(content, day, days.length);
}

function buildPvuDaysFromLogs(logs, dailyEngagement = {}, weekOffset = pvuWeekOffset) {
  const dayKeys = getLast7StreakDayKeys(weekOffset);
  return dayKeys.map((dayKey) => {
    const hostMap = logs[dayKey] || {};
    const byType = { Productive: 0, Unproductive: 0, Neutral: 0 };
    const byHost = { Productive: [], Unproductive: [], Neutral: [] };
    for (const [host, entry] of Object.entries(hostMap)) {
      const buckets = normalizeDailySiteLogEntry(entry);
      for (const type of PVU_STACK_ORDER) {
        const sec = buckets[type] || 0;
        if (sec <= 0) continue;
        byType[type] += sec;
        byHost[type].push({ host, sec });
      }
    }
    for (const type of PVU_STACK_ORDER) {
      byHost[type].sort((a, b) => b.sec - a.sec);
    }
    const total = byType.Productive + byType.Unproductive + byType.Neutral;
    const realProductivityScore = Number(dailyEngagement[dayKey]) || 0;
    return { dayKey, byType, byHost, total, realProductivityScore };
  });
}

const PVU_SITE_LOG_STORAGE_KEYS = [
  'dailySiteLogs',
  'hourlySiteLogs',
  'hourlyProductiveLogs',
  'dailyProductiveEngagement',
  'hourlyProductiveEngagement'
];

function pvuSiteLogsPackageFromResponse(resp = {}) {
  return {
    dailySiteLogs: resp.dailySiteLogs || {},
    hourlySiteLogs: resp.hourlySiteLogs || {},
    hourlyProductiveLogs: resp.hourlyProductiveLogs || {},
    dailyProductiveEngagement: resp.dailyProductiveEngagement || {},
    hourlyProductiveEngagement: resp.hourlyProductiveEngagement || {}
  };
}

function pvuSiteLogsAreEmpty(pkg = {}) {
  return !Object.keys(pkg.dailySiteLogs || {}).length
    && !Object.keys(pkg.hourlySiteLogs || {}).length
    && !Object.keys(pkg.dailyProductiveEngagement || {}).length;
}

async function fetchPvuSiteLogsFromStorage() {
  const stored = await chrome.storage.local.get(PVU_SITE_LOG_STORAGE_KEYS);
  return pvuSiteLogsPackageFromResponse(stored);
}

function wakeExtensionServiceWorker() {
  chrome.runtime.sendMessage({ action: 'ping' }).catch((err) => {
    console.info('[pf-pvu] worker wake ping failed (using storage fallback):', err?.message || err);
  });
}

async function fetchPvuSiteLogs() {
  wakeExtensionServiceWorker();

  let workerLogs = null;
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getDailySiteLogs' });
    if (resp && resp.success !== false && !resp.error) {
      workerLogs = pvuSiteLogsPackageFromResponse(resp);
    }
  } catch (err) {
    console.info('[pf-pvu] worker unavailable, falling back to chrome.storage.local:', err?.message || err);
  }

  if (workerLogs && !pvuSiteLogsAreEmpty(workerLogs)) {
    return workerLogs;
  }

  const storageLogs = await fetchPvuSiteLogsFromStorage();
  if (!pvuSiteLogsAreEmpty(storageLogs)) {
    if (workerLogs && pvuSiteLogsAreEmpty(workerLogs)) {
      console.info('[pf-pvu] worker returned empty logs; using cached chrome.storage.local data');
    }
    return storageLogs;
  }

  return workerLogs || storageLogs;
}

let pvuStorageRefreshScheduled = false;
function schedulePvuStorageRefresh() {
  if (tutorialPvuSampleActive || pvuStorageRefreshScheduled || activeSubTab !== 'siteTime') return;
  pvuStorageRefreshScheduled = true;
  requestAnimationFrame(() => {
    pvuStorageRefreshScheduled = false;
    if (tutorialPvuSampleActive) return;
    renderProductiveVsUnproductive().catch((err) => {
      console.error('[pf-pvu] storage refresh render failed:', err);
    });
  });
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      changes.dailySiteLogs
      || changes.hourlySiteLogs
      || changes.dailyProductiveEngagement
    ) {
      schedulePvuStorageRefresh();
    }
  });
}

async function renderProductiveVsUnproductive() {
  const chartEl = $('pvuChart');
  if (!chartEl) return;

  const siteLogs = tutorialPvuSampleActive
    ? buildTutorialPvuSampleLogs()
    : await fetchPvuSiteLogs();
  const logs = siteLogs.dailySiteLogs;
  pvuDailySiteLogs = logs;
  pvuHourlySiteLogs = siteLogs.hourlySiteLogs;
  pvuDailyProductiveEngagement = siteLogs.dailyProductiveEngagement;

  const maxOffset = getMaxPvuWeekOffset(logs);
  if (pvuFollowLiveWeek) {
    pvuWeekOffset = 0;
  } else if (pvuWeekOffset > maxOffset) {
    pvuWeekOffset = maxOffset;
  }

  let days = buildPvuDaysFromLogs(logs, pvuDailyProductiveEngagement);
  let hasData = days.some((d) => d.total > 0 || (d.realProductivityScore || 0) > 0);

  if (!hasData && pvuWeekOffset > 0) {
    pvuWeekOffset = 0;
    pvuFollowLiveWeek = true;
    days = buildPvuDaysFromLogs(logs, pvuDailyProductiveEngagement);
    hasData = days.some((d) => d.total > 0 || (d.realProductivityScore || 0) > 0);
  }

  syncPvuLiveDaySelection(days);
  pvuCurrentDays = days;
  pvuHasData = hasData;

  renderRealProductivity7DaySummary(days);
  ensurePvuWeekNavHandlers();
  ensurePvuDayNavHandlers();
  updatePvuWeekNavState();
  if (!hasData) {
    // EMPTY SHELL (user report 2026-07: "instead of telling the user to wait
    // till they visit sites when they first click on the stats page just say
    // in gray no data until they do but show the full graph"). Don't clear
    // the chart + show a text message — fall through to the full SVG render,
    // which safely draws the axes, grid, day labels, and legend with zero-
    // height bars. Add a small gray "No data yet" label at the top so the
    // empty state is clear without hiding the graph structure.
    pvuBreakdownPinned = false;
    pvuBreakdownPinnedDayKey = null;
    hidePvuBreakdown();
    const breakdownEl = $('pvuBreakdown');
    if (breakdownEl) breakdownEl.replaceChildren();
    renderDailySites(days);
    renderPvuHourChart(days, pvuSelectedDayKey, pvuHourlySiteLogs);
    ensurePvuWeekNavHandlers();
    ensurePvuDayNavHandlers();
    updatePvuWeekNavState();
    updatePvuDayNavState(days, pvuSelectedDayKey);
    // Fall through to the SVG build. The empty-label is appended after the
    // svg is constructed (see the pvuEmptyNotice block below).
  }

  const chartWrap = chartEl.closest('.pvu-chart-wrap');
  hideRealProductivityTooltip(chartWrap);
  ensureRealProductivityTooltipHandlers(chartWrap);

  // Y-axis scaling (user spec 2026-07 v41): auto-scale to the tallest bar
  // in the visible week instead of a fixed 24H cap. If the user's biggest
  // day was 6H, show a 6H max so bar detail is actually visible. TUTORIAL
  // MODE keeps the fixed 24H axis so the mock data + tutorial screenshots
  // still make sense (previous spec v36 was tutorial-scoped in intent).
  //
  // Behavior:
  //  - tutorial-active → fixed 24H (unchanged)
  //  - no data → 1H floor so an empty axis still shows sensible ticks
  //  - < 60min max → switch to minutes axis (0 / 15m / 30m / 45m / 60m)
  //  - otherwise → round max UP to the next integer hour, add a small
  //    headroom (10%) so the tallest bar doesn't kiss the top gridline
  const tutorialActive = document.body.classList.contains('tutorial-active');
  const perDayTotalsSec = (days || []).map((d) =>
    Object.values(d?.byType || {}).reduce((a, b) => a + (Number(b) || 0), 0)
  );
  const observedMaxSec = perDayTotalsSec.length ? Math.max(...perDayTotalsSec) : 0;
  let maxSec;
  let useMinutes;
  let maxAxis;
  if (tutorialActive) {
    maxSec = 24 * 3600;
    useMinutes = false;
    maxAxis = 24;
  } else if (observedMaxSec <= 0) {
    // No data yet — default 1H so ticks aren't all "0h".
    maxSec = 3600;
    useMinutes = false;
    maxAxis = 1;
  } else if (observedMaxSec < 60 * 60) {
    // Under an hour — use minutes.
    useMinutes = true;
    const paddedMin = Math.ceil((observedMaxSec / 60) * 1.1);
    // Snap to nice tick counts (15, 30, 45, 60).
    if (paddedMin <= 15) maxAxis = 15;
    else if (paddedMin <= 30) maxAxis = 30;
    else if (paddedMin <= 45) maxAxis = 45;
    else maxAxis = 60;
    maxSec = maxAxis * 60;
  } else {
    // Over an hour — use hours, round up with 10% headroom, cap at 24H.
    useMinutes = false;
    const paddedHrs = (observedMaxSec / 3600) * 1.1;
    maxAxis = Math.min(24, Math.max(1, Math.ceil(paddedHrs)));
    maxSec = maxAxis * 3600;
  }

  const svgNs = 'http://www.w3.org/2000/svg';
  const width = 560;
  const height = 240;
  const padLeft = 44;
  const padRight = 36;
  const padTop = 12;
  const padBottom = 40;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const barGap = chartW / days.length;
  const barW = Math.min(36, barGap * 0.55);

  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'pvu-chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Productive vs unproductive time by day');

  const grid = document.createElementNS(svgNs, 'g');
  grid.setAttribute('class', 'pvu-grid');
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const frac = i / tickCount;
    const y = padTop + chartH - frac * chartH;
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', String(padLeft));
    line.setAttribute('x2', String(width - padRight));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    grid.appendChild(line);

    const label = document.createElementNS(svgNs, 'text');
    label.setAttribute('class', 'pvu-axis-label');
    label.setAttribute('x', String(padLeft - 6));
    label.setAttribute('y', String(y + 4));
    label.setAttribute('text-anchor', 'end');
    const axisVal = useMinutes
      ? Math.round(maxAxis * frac)
      : Math.round(maxAxis * frac * 10) / 10;
    label.textContent = formatPvuAxisValue(axisVal, useMinutes);
    svg.appendChild(label);
  }
  svg.appendChild(grid);

  days.forEach((day, i) => {
    const cx = padLeft + barGap * i + barGap / 2;
    const x = cx - barW / 2;
    let yCursor = padTop + chartH;
    const dayLabel = formatPvuDayLabel(i, days.length);

    const barGroup = document.createElementNS(svgNs, 'g');
    barGroup.setAttribute('class', 'pvu-bar');
    barGroup.setAttribute('data-day-index', String(i));
    barGroup.setAttribute('tabindex', '0');
    barGroup.setAttribute('role', 'button');
    barGroup.setAttribute('aria-label', `${dayLabel} breakdown`);

    // Column-wide invisible hit target (user report 2026-07 v53: "make
    // it so if my mouse is over that day's area it should come up").
    // Without this, the visible bar is only ~36px wide and hovering the
    // rest of the day's column did nothing. Rect spans the full column
    // width (barGap) so anywhere in the day's vertical slice triggers
    // the hover.
    const columnHit = document.createElementNS(svgNs, 'rect');
    columnHit.setAttribute('class', 'pvu-bar-hit');
    columnHit.setAttribute('x', String(cx - barGap / 2));
    columnHit.setAttribute('y', String(padTop));
    columnHit.setAttribute('width', String(barGap));
    columnHit.setAttribute('height', String(chartH));
    columnHit.setAttribute('fill', 'transparent');
    columnHit.style.pointerEvents = 'all';
    barGroup.appendChild(columnHit);

    const stackGroup = document.createElementNS(svgNs, 'g');
    stackGroup.setAttribute('class', 'pvu-bar-stack');

    const segments = [];
    for (const type of PVU_STACK_ORDER) {
      const sec = day.byType[type] || 0;
      if (sec <= 0) continue;
      const axisVal = useMinutes ? sec / 60 : sec / 3600;
      const barH = (axisVal / maxAxis) * chartH;
      yCursor -= barH;
      segments.push({ type, y: yCursor, barH });
    }

    segments.forEach((seg, idx) => {
      const isBottom = idx === 0;
      const isTop = idx === segments.length - 1;
      stackGroup.appendChild(createPvuStackSegment(svgNs, {
        x,
        y: seg.y,
        width: barW,
        height: seg.barH,
        fill: PVU_TYPE_COLORS[seg.type],
        roundTop: isTop,
        roundBottom: isBottom,
        radius: 3
      }));
    });

    barGroup.appendChild(stackGroup);

    const dayText = document.createElementNS(svgNs, 'text');
    dayText.setAttribute('class', 'pvu-day-label');
    dayText.setAttribute('x', String(cx));
    dayText.setAttribute('y', String(height - 8));
    dayText.setAttribute('text-anchor', 'middle');
    dayText.textContent = dayLabel;
    barGroup.appendChild(dayText);

    const activate = () => activatePvuDayHover(i);
    const selectDay = () => selectPvuDay(days, i);
    barGroup.addEventListener('mouseenter', activate);
    barGroup.addEventListener('focus', activate);
    barGroup.addEventListener('blur', () => {
      if (!pvuBreakdownPinned) hidePvuBreakdown();
    });
    barGroup.addEventListener('click', selectDay);
    barGroup.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDay();
      }
    });

    svg.appendChild(barGroup);
  });

  appendRealProductivityLine(svg, svgNs, days, {
    padLeft,
    padTop,
    chartH,
    barGap,
    maxEngagement: realProductivityChartAxisMax(Math.max(...days.map((d) => d.realProductivityScore || 0), 0)),
    width,
    padRight
  }, days.length, chartWrap);

  chartEl.replaceChildren(svg);

  const legend = document.createElement('div');
  legend.className = 'pvu-legend';
  const lineItem = document.createElement('div');
  lineItem.className = 'pvu-legend-item';
  const lineSwatch = document.createElement('span');
  lineSwatch.className = 'pvu-legend-swatch pvu-legend-swatch--line';
  lineItem.appendChild(lineSwatch);
  lineItem.appendChild(document.createTextNode('Real Productivity'));
  // Circled "?" next to the "Real Productivity" legend entry (user request
  // 2026-07: "add the ? with a circle next to the legend"). Uses the
  // existing .pf-inline-help-btn style + the bindInlineHelpPanels toggle
  // contract (aria-controls → panel id). The panel keeps the
  // #realProductivity7DaySummary element so renderRealProductivity7DaySummary
  // still populates the weekly score summary that used to live under the graph.
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'pf-inline-help-btn';
  helpBtn.setAttribute('aria-expanded', 'false');
  helpBtn.setAttribute('aria-controls', 'realProductivityHelpPanel');
  helpBtn.title = 'What is Real Productivity?';
  helpBtn.textContent = '?';
  lineItem.appendChild(helpBtn);
  legend.appendChild(lineItem);
  for (const type of PVU_STACK_ORDER) {
    const item = document.createElement('div');
    item.className = 'pvu-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'pvu-legend-swatch';
    swatch.style.background = PVU_TYPE_COLORS[type];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(type));
    legend.appendChild(item);
  }
  // The help dropdown panel — same content as the old "below the graph" block.
  const helpPanel = document.createElement('div');
  helpPanel.id = 'realProductivityHelpPanel';
  helpPanel.className = 'real-productivity-help-panel';
  helpPanel.hidden = true;
  const helpTitle = document.createElement('div');
  helpTitle.className = 'real-productivity-help-title';
  helpTitle.textContent = 'Real Productivity';
  const helpMeasure = document.createElement('div');
  helpMeasure.className = 'real-productivity-measure';
  helpMeasure.textContent = 'Engagement score on productive websites (the higher the score, the more productive)';
  const summaryEl = document.createElement('div');
  summaryEl.id = 'realProductivity7DaySummary';
  summaryEl.className = 'real-productivity-summary';
  helpPanel.appendChild(helpTitle);
  helpPanel.appendChild(helpMeasure);
  helpPanel.appendChild(summaryEl);
  legend.appendChild(helpPanel);
  chartEl.appendChild(legend);
  // Wire the legend "?" toggle. The button + panel are rebuilt on every chart
  // render, so update the module-level refs each time and (re)bind the click
  // handler on the fresh button. The document-level click-away + Esc listeners
  // are bound ONCE — they read the current refs — to avoid accumulating
  // listeners across renders.
  pvuLegendHelpBtn = helpBtn;
  pvuLegendHelpPanel = helpPanel;
  const setOpen = (open) => {
    if (!pvuLegendHelpPanel) return;
    pvuLegendHelpPanel.hidden = !open;
    if (pvuLegendHelpBtn) pvuLegendHelpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(helpPanel.hidden);
  });
  if (!pvuLegendHelpDocListenersBound) {
    pvuLegendHelpDocListenersBound = true;
    document.addEventListener('click', (e) => {
      const panel = pvuLegendHelpPanel;
      const btn = pvuLegendHelpBtn;
      if (panel && !panel.hidden && !panel.contains(e.target) && e.target !== btn) {
        setOpen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pvuLegendHelpPanel && !pvuLegendHelpPanel.hidden) setOpen(false);
    });
  }

  // The 7-day summary element now lives inside the legend dropdown (built just
  // above), so populate it AFTER the legend exists. The earlier call near the
  // top of this render no-ops when the element isn't in the DOM yet.
  renderRealProductivity7DaySummary(days);

  // Empty-state notice (user report 2026-07: "show the full graph but say in
  // gray no data"). Now that the full graph shell (axes, grid, day labels,
  // legend) is rendered, overlay a small gray "No data yet" label so the
  // empty state is obvious without hiding the graph structure. Only shown
  // when there's no data for this week.
  const existingNotice = chartEl.querySelector('.pvu-empty-notice');
  if (existingNotice) existingNotice.remove();
  if (!hasData) {
    const notice = document.createElement('div');
    notice.className = 'pvu-empty-notice';
    notice.textContent = 'No data yet';
    chartEl.appendChild(notice);
  }

  ensurePvuWrapHoverHandlers();

  syncPvuLiveDaySelection(days);

  if (pvuBreakdownPinned && pvuBreakdownPinnedDayKey) {
    const pinnedIdx = days.findIndex((d) => d.dayKey === pvuBreakdownPinnedDayKey);
    if (pinnedIdx >= 0) {
      pvuSelectedDayKey = pvuBreakdownPinnedDayKey;
      showPvuBreakdown(days[pinnedIdx], formatPvuDayLabel(pinnedIdx, days.length), {
        pin: true,
        dayIndex: pinnedIdx
      });
      highlightPvuChartBar(pinnedIdx);
    }
  } else {
    const selectedIdx = days.findIndex((d) => d.dayKey === pvuSelectedDayKey);
    if (selectedIdx >= 0) highlightPvuChartBar(selectedIdx);
  }

  renderDailySites(days, pvuSelectedDayKey);
  renderPvuHourChart(days, pvuSelectedDayKey, pvuHourlySiteLogs);
  updatePvuDayNavState(days, pvuSelectedDayKey);
}

/**
 * Toggle the aria-disabled state on the two profile tabs that shouldn't
 * be usable while the user is signed out. Called by renderAuthUI so it
 * flips as soon as the sign-in state changes.
 */
function refreshProfileTabAvailability() {
  const signedIn = !!currentUser?.email;
  document.querySelectorAll('.pf-profile-tab').forEach((tabBtn) => {
    const tab = tabBtn.dataset.profileTab;
    // Wrapped added 2026-07 v30 (user spec: don't even let them click on
    // the tab of it to open it while signed out). Same aria-disabled +
    // click-swallow pattern as windows/settings.
    if (tab === 'windows' || tab === 'settings' || tab === 'wrapped') {
      tabBtn.setAttribute('aria-disabled', signedIn ? 'false' : 'true');
      tabBtn.title = signedIn ? '' : 'Sign in to use this';
    }
  });
  // If the user is currently on a locked tab and we just flipped it off,
  // punt them back to the User tab so they don't stare at a hidden panel.
  if (!signedIn) {
    const active = document.querySelector('.pf-profile-tab.active');
    const t = active?.dataset.profileTab;
    if (t === 'windows' || t === 'settings' || t === 'wrapped') {
      switchProfileTab('user');
    }
  }
  // Re-sync the dark-mode toggle so its disabled state matches the
  // current sign-in state (user spec 2026-07 v30).
  try { void pfSyncDarkModeToggleUI(); } catch (_) { /* not yet bound */ }
}

async function renderAuthUI() {
  // Synchronous avatar/name refresh FIRST — so the header shows the right
  // initial/name even if the async renderProfilePanel below is slow or errors.
  updateProfileAvatar();
  refreshProfileTabAvailability();
  const si = $('dashboardSignInBtn');
  const so = $('headerSignOutBtn');
  const banner = document.getElementById('pfSignInRequiredBanner');
  if (banner) {
    banner.textContent = SIGN_IN_BANNER_TEXT;
    banner.style.display = currentUser?.email ? 'none' : 'block';
    banner.style.whiteSpace = 'pre-line';
  }
  // Global signed-out lock (per user spec 2026-07): while the user isn't
  // signed in, gray the dashboard controls so it's obvious the extension
  // is inert until they sign in. The tutorial overlay has its own signin
  // step and shouldn't be dimmed underneath it — skip while it's active.
  const tutorialActive = document.body.classList.contains('tutorial-active');
  document.body.classList.toggle(
    'pf-signed-out-locked',
    !currentUser?.email && !tutorialActive
  );
  if (currentUser?.email) {
    if (si) {
      si.hidden = true;
      si.style.display = 'none';
    }
    if (so) {
      so.hidden = false;
      so.style.display = 'inline-flex';
      so.style.alignItems = 'center';
      so.style.gap = '6px';
      so.title = `Signed in as ${currentUser.email}`;
      so.disabled = false;
    }
  } else {
    if (so) {
      so.hidden = true;
      so.style.display = 'none';
    }
    if (si) {
      // Show the sign-in button whenever the user is signed out, regardless
      // of tutorial completion. The only time we hide it is while the
      // tutorial overlay is actively running (which has its own tutorSignIn
      // button); the tutorial-active body class is the source of truth.
      const tutorialRunning = document.body.classList.contains('tutorial-active');
      const showSignIn = !tutorialRunning;
      si.hidden = !showSignIn;
      si.style.display = showSignIn ? 'inline-flex' : 'none';
      si.style.alignItems = 'center';
      si.style.gap = '6px';
      si.title = 'Sign in with email and password';
      si.disabled = false;
    }
  }
  await renderProfilePanel();
}

function getProfileDisplayName(user) {
  if (user?.displayName) return user.displayName;
  if (user?.email) return user.email.split('@')[0];
  return 'Guest';
}

// Lightweight avatar + name refresh — sets the header profile button's initial
// and name to match currentUser WITHOUT requiring the profile panel to be open.
// Called everywhere currentUser changes so the avatar never lingers on '?'.
function updateProfileAvatar() {
  const initialEl = document.getElementById('pfProfileAvatarInitial');
  const btnNameEl = document.getElementById('pfProfileBtnName');
  const displayName = getProfileDisplayName(currentUser);
  if (initialEl) {
    initialEl.textContent = (displayName.charAt(0) || '?').toUpperCase();
  }
  if (btnNameEl) {
    btnNameEl.textContent = displayName;
    btnNameEl.hidden = !currentUser?.email;
  }
}

function isProfileDisplayNameEditing() {
  const inputEl = document.getElementById('pfProfileUserNameInput');
  return !!inputEl && !inputEl.hidden;
}

function beginProfileDisplayNameEdit() {
  if (!currentUser?.email) return;
  const nameEl = document.getElementById('pfProfileUserName');
  const inputEl = document.getElementById('pfProfileUserNameInput');
  const editBtn = document.getElementById('pfProfileEditNameBtn');
  if (!nameEl || !inputEl || !editBtn) return;
  inputEl.value = getProfileDisplayName(currentUser);
  nameEl.hidden = true;
  editBtn.hidden = true;
  inputEl.hidden = false;
  inputEl.focus();
  inputEl.select();
}

async function finalizeProfileDisplayNameEdit() {
  const nameEl = document.getElementById('pfProfileUserName');
  const inputEl = document.getElementById('pfProfileUserNameInput');
  const editBtn = document.getElementById('pfProfileEditNameBtn');
  if (!nameEl || !inputEl) return;

  const finishViewMode = () => {
    inputEl.hidden = true;
    nameEl.hidden = false;
    if (editBtn) editBtn.hidden = !currentUser?.email;
  };

  if (!currentUser?.email) {
    finishViewMode();
    if (editBtn) editBtn.hidden = true;
    return;
  }

  const raw = inputEl.value.trim();
  if (raw.length < 2) {
    inputEl.value = getProfileDisplayName(currentUser);
    finishViewMode();
    return;
  }

  const nextName = raw.slice(0, 32);
  if (nextName === getProfileDisplayName(currentUser)) {
    finishViewMode();
    return;
  }

  const stored = await chrome.storage.local.get('pfSession');
  const session = stored.pfSession;
  const userId = session?.user?.id || userIdFromAccessToken(session?.access_token);
  if (!session?.access_token || !userId) {
    finishViewMode();
    return;
  }

  const { ok } = await saveUserChosenDisplayName(session.access_token, userId, nextName);
  if (ok) {
    currentUser.displayName = nextName;
    await chrome.storage.local.set({ pfUserDisplayName: nextName });
    finishViewMode();
    await renderProfilePanel();
    return;
  }

  inputEl.value = getProfileDisplayName(currentUser);
  finishViewMode();
}

async function renderProfilePanel() {
  const nameEl = document.getElementById('pfProfileUserName');
  const nameInputEl = document.getElementById('pfProfileUserNameInput');
  const editNameBtn = document.getElementById('pfProfileEditNameBtn');
  const emailEl = document.getElementById('pfProfileUserEmail');
  const signedInStatusEl = document.getElementById('pfProfileSignedInStatus');
  const tempIdEl = document.getElementById('pfProfileUserTempId');
  const initialEl = document.getElementById('pfProfileAvatarInitial');
  const btnNameEl = document.getElementById('pfProfileBtnName');
  const btn = document.getElementById('pfProfileBtn');
  const summaryEl = document.getElementById('pfProfileUserSummary');
  const displayName = getProfileDisplayName(currentUser);
  const signedIn = !!currentUser?.email;
  const editingName = isProfileDisplayNameEditing();
  if (nameEl && !editingName) nameEl.textContent = displayName;
  if (editNameBtn) editNameBtn.hidden = !signedIn || editingName;
  if (emailEl) {
    if (signedIn) {
      emailEl.hidden = false;
      emailEl.textContent = currentUser.email;
    } else {
      emailEl.hidden = true;
      emailEl.textContent = '';
    }
  }
  if (signedInStatusEl) {
    signedInStatusEl.hidden = !signedIn;
  }
  if (tempIdEl) {
    if (signedIn) {
      const stored = await chrome.storage.local.get(['pfSession', 'telemetryId']);
      const userId = stored.pfSession?.user?.id || '';
      const telemetryId = stored.telemetryId || '';
      const displayId = userId || telemetryId;
      if (displayId) {
        tempIdEl.hidden = false;
        tempIdEl.textContent = `Temp. ID: ${displayId}`;
        tempIdEl.title = telemetryId && userId && telemetryId !== userId
          ? `Account: ${userId}\nDevice telemetry: ${telemetryId}`
          : displayId;
      } else {
        tempIdEl.hidden = true;
        tempIdEl.textContent = '';
        tempIdEl.removeAttribute('title');
      }
    } else {
      tempIdEl.hidden = true;
      tempIdEl.textContent = '';
      tempIdEl.removeAttribute('title');
    }
  }
  if (initialEl) initialEl.textContent = (displayName.charAt(0) || '?').toUpperCase();
  if (btnNameEl) {
    btnNameEl.textContent = displayName;
    btnNameEl.hidden = !signedIn;
  }
  if (btn) {
    btn.classList.toggle('pf-profile-btn--signed-in', signedIn);
    btn.title = signedIn
      ? `Signed in as ${currentUser.email}`
      : 'Profile — sign in to sync';
  }
  if (summaryEl) {
    const displayName = currentUser?.displayName
      || currentUser?.email?.split('@')[0]
      || '';
    summaryEl.textContent = currentUser?.email
      ? `Welcome ${displayName}, more will be here soon.`
      : 'Sign in to sync your profile and settings.';
  }
}

function switchProfileTab(tabId) {
  document.querySelectorAll('.pf-profile-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.profileTab === tabId);
  });
  ['pfProfileTabUser', 'pfProfileTabWrapped', 'pfProfileTabWindows', 'pfProfileTabSettings'].forEach((id) => {
    const panel = document.getElementById(id);
    if (panel) panel.classList.remove('active');
  });
  const panelMap = {
    user: 'pfProfileTabUser',
    wrapped: 'pfProfileTabWrapped',
    windows: 'pfProfileTabWindows',
    settings: 'pfProfileTabSettings'
  };
  const panel = document.getElementById(panelMap[tabId] || panelMap.user);
  if (panel) panel.classList.add('active');
}

function hideProfileLocalModeWarning() {
  const cards = document.getElementById('pfDataModeCards');
  const step1 = document.getElementById('pfDataModeLocalWarnStep1');
  const step2 = document.getElementById('pfDataModeLocalWarnStep2');
  cards?.classList.remove('is-dimmed');
  if (step1) {
    step1.hidden = true;
    step1.setAttribute('aria-hidden', 'true');
  }
  if (step2) {
    step2.hidden = true;
    step2.setAttribute('aria-hidden', 'true');
  }
}

function showProfileLocalModeWarnStep1() {
  hideProfileLocalModeWarning();
  const cards = document.getElementById('pfDataModeCards');
  const step1 = document.getElementById('pfDataModeLocalWarnStep1');
  cards?.classList.add('is-dimmed');
  if (step1) {
    step1.hidden = false;
    step1.setAttribute('aria-hidden', 'false');
  }
  step1?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showProfileLocalModeWarnStep2() {
  const step1 = document.getElementById('pfDataModeLocalWarnStep1');
  const step2 = document.getElementById('pfDataModeLocalWarnStep2');
  if (step1) {
    step1.hidden = true;
    step1.setAttribute('aria-hidden', 'true');
  }
  if (step2) {
    step2.hidden = false;
    step2.setAttribute('aria-hidden', 'false');
  }
  step2?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function loadDataCollectionModeUI() {
  const stored = await chrome.storage.local.get(['dataCollectionMode']);
  const mode = stored.dataCollectionMode === 'local'
    ? 'local'
    : stored.dataCollectionMode === 'standard'
      ? 'standard'
      : 'pending';
  const standardRadio = document.getElementById('pfDataModeStandard');
  const standardCard = document.getElementById('pfDataModeStandardCard');
  const localRadio = document.getElementById('pfDataModeLocal');
  const localCard = document.getElementById('pfDataModeLocalCard');
  const restoreBtn = document.getElementById('pfRestoreStandardModeBtn');
  const isStandard = mode === 'standard' || mode === 'pending';
  if (standardRadio) standardRadio.checked = isStandard;
  if (standardCard) standardCard.classList.toggle('is-selected', isStandard);
  if (localRadio) localRadio.checked = mode === 'local';
  if (localCard) localCard.classList.toggle('is-selected', mode === 'local');
  if (restoreBtn) restoreBtn.style.display = mode === 'local' ? 'inline-block' : 'none';
  hideProfileLocalModeWarning();
}

async function applyDataCollectionMode(mode) {
  await chrome.storage.local.set({
    dataCollectionMode: mode,
    telemetryEnabled: mode === 'local' ? false : true
  });
  await chrome.runtime.sendMessage({ action: 'setDataCollectionMode', mode }).catch(() => {});
  await chrome.runtime.sendMessage({ action: 'onDataCollectionConsentComplete', mode }).catch(() => {});
  const status = document.getElementById('pfDataModeStatus');
  if (status) {
    status.style.display = 'block';
    status.textContent = mode === 'local'
      ? 'Local mode active — no data is collected. You classify every page yourself.'
      : 'Standard mode restored.';
    setTimeout(() => { status.style.display = 'none'; }, 4500);
  }
  await loadDataCollectionModeUI();
}

function openProfilePanel() {
  const modal = document.getElementById('pfProfileModal');
  const btn = document.getElementById('pfProfileBtn');
  if (!modal) return;
  modal.removeAttribute('hidden');
  modal.setAttribute('aria-hidden', 'false');
  btn?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('pf-profile-modal-open');
  switchProfileTab('user');
  refreshAuthFromStorage().catch(() => {
    renderProfilePanel().catch(() => {});
  });
  loadDataCollectionModeUI().catch(() => {});
  // Ensure the close button is bound (in case initProfilePanel ran before the
  // element existed, or the binding was lost). This is what fixes the X button
  // not closing the panel.
  const closeBtn = document.getElementById('pfProfileCloseBtn');
  if (closeBtn && closeBtn.dataset.pfCloseBound !== '1') {
    closeBtn.dataset.pfCloseBound = '1';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProfilePanel();
    });
  }
  document.getElementById('pfProfileCloseBtn')?.focus();
}

function closeProfilePanel() {
  const modal = document.getElementById('pfProfileModal');
  const btn = document.getElementById('pfProfileBtn');
  if (!modal) return;
  modal.setAttribute('hidden', '');
  modal.setAttribute('aria-hidden', 'true');
  btn?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('pf-profile-modal-open');
}

function bindProfilePanelOpenClose() {
  const btn = document.getElementById('pfProfileBtn');
  const modal = document.getElementById('pfProfileModal');
  if (!btn || !modal || btn.dataset.pfOpenBound === '1') return;
  btn.dataset.pfOpenBound = '1';
  btn.addEventListener('click', (e) => {
    if (document.body.classList.contains('tutorial-active')) return;
    e.stopPropagation();
    if (modal.hasAttribute('hidden')) {
      openProfilePanel();
    } else {
      closeProfilePanel();
    }
  });
}

const PF_PROFILE_ANCHOR_REST_TOP = 88;
const PF_PROFILE_ANCHOR_PINNED_TOP = 20;
let profileAnchorScrollRaf = null;

function updateProfileAnchorScrollPosition() {
  profileAnchorScrollRaf = null;
  const anchor = document.getElementById('pfProfileAnchor');
  if (!anchor || document.body.classList.contains('tutorial-active')) return;

  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const nextTop = Math.max(PF_PROFILE_ANCHOR_PINNED_TOP, PF_PROFILE_ANCHOR_REST_TOP - scrollY);
  // Compositor-only path (user report 2026-07 v48: "scrolling on the
  // dashboard on Windows gets really really laggy"). Setting `top` on
  // every scroll frame invalidated layout + paint of the whole anchor
  // subtree; translate stays on the compositor and doesn't dirty the
  // main-thread render tree. Anchor lives at `top: 88px` in CSS so the
  // delta below is scrollY (or capped at the pin point).
  const deltaY = nextTop - PF_PROFILE_ANCHOR_REST_TOP;
  anchor.style.transform = `translateY(${deltaY}px)`;
}

function scheduleProfileAnchorScrollUpdate() {
  if (profileAnchorScrollRaf != null) return;
  profileAnchorScrollRaf = requestAnimationFrame(updateProfileAnchorScrollPosition);
}

function initProfileAnchorScroll() {
  updateProfileAnchorScrollPosition();
  window.addEventListener('scroll', scheduleProfileAnchorScrollUpdate, { passive: true });
  window.addEventListener('resize', scheduleProfileAnchorScrollUpdate, { passive: true });
}

function initProfilePanel() {
  const btn = document.getElementById('pfProfileBtn');
  const modal = document.getElementById('pfProfileModal');
  const backdrop = document.getElementById('pfProfileBackdrop');
  const closeBtn = document.getElementById('pfProfileCloseBtn');
  if (!btn || !modal) return;

  backdrop?.addEventListener('click', () => closeProfilePanel());
  closeBtn?.addEventListener('click', () => closeProfilePanel());
  document.getElementById('pfProfileEditNameBtn')?.addEventListener('click', () => {
    beginProfileDisplayNameEdit();
  });
  const profileNameInput = document.getElementById('pfProfileUserNameInput');
  profileNameInput?.addEventListener('blur', () => {
    void finalizeProfileDisplayNameEdit();
  });
  profileNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      profileNameInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      profileNameInput.value = getProfileDisplayName(currentUser);
      profileNameInput.hidden = true;
      const nameEl = document.getElementById('pfProfileUserName');
      const editBtn = document.getElementById('pfProfileEditNameBtn');
      if (nameEl) nameEl.hidden = false;
      if (editBtn) editBtn.hidden = !currentUser?.email;
    }
  });
  document.getElementById('pfProfilePanel')?.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) {
      closeProfilePanel();
    }
  });

  document.querySelectorAll('.pf-profile-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Per user spec 2026-07: the "Other Windows" and "User Settings"
      // profile tabs are locked while the user is signed out. They still
      // render (so the user can see they exist) but clicking a locked
      // tab does nothing — see the aria-disabled + CSS rules applied
      // by refreshProfileTabAvailability().
      if (tabBtn.getAttribute('aria-disabled') === 'true') return;
      const tab = tabBtn.dataset.profileTab || 'user';
      switchProfileTab(tab);
      if (tab === 'windows') renderOtherWindows().catch(() => {});
      if (tab === 'settings') loadDataCollectionModeUI().catch(() => {});
    });
  });
  refreshProfileTabAvailability();

  const localRadio = document.getElementById('pfDataModeLocal');
  localRadio?.addEventListener('change', async () => {
    if (!localRadio.checked) return;
    const stored = await chrome.storage.local.get(['dataCollectionMode']);
    if (stored.dataCollectionMode === 'local') return;
    localRadio.checked = false;
    await loadDataCollectionModeUI();
    showProfileLocalModeWarnStep1();
  });

  document.getElementById('pfDataModeStandard')?.addEventListener('change', () => {
    const standardRadio = document.getElementById('pfDataModeStandard');
    if (standardRadio?.checked) applyDataCollectionMode('standard').catch(() => {});
  });

  document.getElementById('pfDataModeLocalWarnContinue')?.addEventListener('click', () => {
    showProfileLocalModeWarnStep2();
  });

  document.getElementById('pfDataModeLocalWarnBack')?.addEventListener('click', () => {
    showProfileLocalModeWarnStep1();
  });

  document.getElementById('pfDataModeLocalWarnCancel')?.addEventListener('click', () => {
    loadDataCollectionModeUI().catch(() => {});
  });

  document.getElementById('pfDataModeLocalWarnGlobal')?.addEventListener('click', () => {
    applyDataCollectionMode('standard').catch(() => {});
  });

  document.getElementById('pfDataModeLocalUseGlobal')?.addEventListener('click', () => {
    applyDataCollectionMode('standard').catch(() => {});
  });

  document.getElementById('pfDataModeLocalConfirm')?.addEventListener('click', () => {
    applyDataCollectionMode('local').catch(() => {});
  });

  document.getElementById('pfRestoreStandardModeBtn')?.addEventListener('click', () => {
    applyDataCollectionMode('standard').catch(() => {});
  });

  initProfileAnchorScroll();
}

async function refreshDashboardShortcutTitle() {
  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (!currentTab?.windowId || typeof currentTab.index !== 'number') return;
    const shortcutNumber = Math.min(9, currentTab.index + 1);
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
    const modifierLabel = isMac ? '⌘' : 'Ctrl';
    const cleaned = document.title.replace(/^\s*\[(?:⌘|Ctrl)\+\d+\]\s*/i, '');
    document.title = `[${modifierLabel}+${shortcutNumber}] ${cleaned}`;
  } catch (_) {
    // Ignore title-refresh failures on unsupported contexts.
  }
}

if ($('editNameBtn')) $('editNameBtn').onclick = () => {
  $('windowNameInput').value = $('displayName').innerText;
  $('displayName').style.display = 'none';
  $('editNameBtn').style.display = 'none';
  $('windowNameInput').style.display = 'inline-block';
  $('windowNameInput').focus();
};
const finalizeName = async () => {
  // Fallback name: if the user clears the input, use the numbered "Window
  // #N" default (matches renderWindowSettings). Per user spec 2026-07.
  let fallbackName = 'Window #1';
  try {
    const win = await chrome.windows.getCurrent();
    const all = await chrome.windows.getAll();
    const idx = all.findIndex((w) => w.id === win.id);
    if (idx >= 0) fallbackName = `Window #${idx + 1}`;
  } catch (_) { /* keep default */ }
  $('displayName').innerText = $('windowNameInput').value || fallbackName;
  $('windowNameInput').style.display = 'none';
  $('displayName').style.display = 'inline-block';
  $('editNameBtn').style.display = 'inline-block';
  autoSave();
  if (currentStep === 2 && !(await isTutorialCompleted())) {
    const name = $('displayName').innerText.trim();
    // Tutorial only advances once the user actually edits to a NON-default
    // name — a fresh "Window #N" or "New Window" shouldn't count.
    if (name && name !== 'New Window' && !/^Window #\d+$/.test(name)) {
      await chrome.storage.local.set({ tutorialNameConfirmed: true });
      const textEl = $('tutorText');
      if (textEl) textEl.innerText = 'Good job. Hit Next to continue.';
      updateTutorNextState();
    }
  }
};
if ($('windowNameInput')) {
  $('windowNameInput').onblur = finalizeName;
  $('windowNameInput').onkeydown = (e) => { if (e.key === 'Enter') finalizeName(); };
}

const MAIN_TABS = ['window', 'stats', 'customizations'];
const STATS_SUB_TABS = ['keyLogger', 'siteTime'];
const DASHBOARD_MAIN_TAB_KEY = 'pfDashboardMainTab';
const DASHBOARD_SUB_TAB_KEY = 'pfDashboardSubTab';

function shouldPersistDashboardTabs() {
  return !document.body?.classList.contains('tutorial-active');
}

function switchMainTab(tabName, options = {}) {
  if (!options.force && isTutorialNotebookBackLocked() && tabName !== 'customizations') {
    triggerTutorialShake($(`${tabName}Tab`));
    return;
  }
  const { persist = true } = options;
  const sections = {
    window: $('windowSection'),
    stats: $('statsSection'),
    customizations: $('customizationsSection')
  };
  Object.entries(sections).forEach(([name, el]) => {
    if (el) el.style.display = name === tabName ? 'block' : 'none';
  });
  MAIN_TABS.forEach((name) => {
    const tabEl = $(`${name}Tab`);
    if (!tabEl) return;
    const isActive = name === tabName;
    tabEl.className = isActive ? 'tab active' : 'tab';
    tabEl.style.opacity = isActive ? '1' : '0.55';
  });
  if (persist && MAIN_TABS.includes(tabName) && shouldPersistDashboardTabs()) {
    chrome.storage.local.set({ [DASHBOARD_MAIN_TAB_KEY]: tabName }).catch(() => {});
  }
  if (tabName === 'stats') {
    render();
    // FIRST visit to Stats & Words (user spec 2026-07): land on the
    // Productive vs Unproductive chart, and if there's no data yet, show
    // a note asking them to go look at a tab and come back.
    void pfMaybeFirstStatsVisit();
    requestAnimationFrame(() => {
      if (activeSubTab === 'keyLogger') {
        startWpmPoll();
        drawTypingChart();
      } else if (activeSubTab === 'siteTime') {
        stopWpmPoll();
        renderProductiveVsUnproductive().catch((err) => {
          console.error('[pf-pvu] renderProductiveVsUnproductive failed:', err);
        });
      }
    });
  } else {
    stopWpmPoll();
  }
}

/** One-time Stats & Words landing: force the PVU sub-tab, scroll the chart
 *  into view, and surface a "no data yet" nudge when the logs are empty.
 *  Never runs during the tutorial (step 13 manages its own scroll). */
let pfFirstStatsVisitRan = false;
async function pfMaybeFirstStatsVisit() {
  if (pfFirstStatsVisitRan) return;
  pfFirstStatsVisitRan = true; // per-page-load guard; storage guards forever
  try {
    if (document.body.classList.contains('tutorial-active')) return;
    const stored = await chrome.storage.local.get('pfStatsTabVisited');
    if (stored.pfStatsTabVisited === true) return;
    await chrome.storage.local.set({ pfStatsTabVisited: true });
    switchSubTab('siteTime', { persist: false });
    requestAnimationFrame(() => {
      $('pvuWeekNavWrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // The empty PVU graph now shows its full shell with a gray "No data yet"
    // label (user report 2026-07), so no separate nudge banner is needed.
  } catch (_) { /* best-effort UX sugar */ }
}

async function restoreDashboardTabs() {
  if (!$('windowTab') && !$('statsTab') && !$('customizationsTab')) return;
  if (!(await isTutorialCompleted())) {
    switchSubTab('keyLogger', { persist: false });
    switchMainTab('window', { persist: false });
    return;
  }

  let mainTab = 'window';
  let subTab = 'keyLogger';
  try {
    const stored = await chrome.storage.local.get([DASHBOARD_MAIN_TAB_KEY, DASHBOARD_SUB_TAB_KEY]);
    if (MAIN_TABS.includes(stored[DASHBOARD_MAIN_TAB_KEY])) {
      mainTab = stored[DASHBOARD_MAIN_TAB_KEY];
    }
    if (STATS_SUB_TABS.includes(stored[DASHBOARD_SUB_TAB_KEY])) {
      subTab = stored[DASHBOARD_SUB_TAB_KEY];
    } else if (stored[DASHBOARD_SUB_TAB_KEY] === 'mouseTracker') {
      subTab = 'siteTime';
    }
  } catch (_) { /* keep defaults */ }

  activeSubTab = subTab;
  switchSubTab(subTab, { persist: false });
  switchMainTab(mainTab, { persist: false });
}

function bindMainTabs() {
  if ($('windowTab')) $('windowTab').onclick = () => switchMainTab('window');
  if ($('statsTab')) $('statsTab').onclick = () => {
    // Hide the red "New Wrapped" cue the instant the user clicks the tab
    // (user spec 2026-07: "make the button go away once they click on
    // it"). The underlying render pipeline will keep it hidden while
    // there's still an unseen recap only if the user opens the banner
    // itself — the click on the tab is treated as acknowledgement.
    const badge = document.getElementById('statsTabRecapBadge');
    if (badge) badge.hidden = true;
    switchMainTab('stats');
    // First-time landing (user spec 2026-07 v27): the Stats & Work tab
    // defaults to the Typing-Speed sub-tab, but the Productive-vs-
    // Unproductive chart is the more useful first impression. On the
    // user's FIRST click of this tab (ever), auto-switch to the PVU
    // sub-tab. One-shot flag stored in chrome.storage.local so the
    // choice sticks after — subsequent clicks respect whichever sub-tab
    // the user was last on.
    (async () => {
      try {
        const KEY = 'pfStatsTabFirstClickDone';
        const stored = await chrome.storage.local.get(KEY);
        if (stored[KEY] === true) return;
        await chrome.storage.local.set({ [KEY]: true });
        if (typeof switchSubTab === 'function') switchSubTab('siteTime');
      } catch (_) { /* best-effort */ }
    })();
  };
  if ($('customizationsTab')) $('customizationsTab').onclick = () => switchMainTab('customizations');
}

if ($('returnBtn')) {
  $('returnBtn').onclick = async () => {
    if (isTutorialNotebookBackLocked()) {
      triggerTutorialShake($('returnBtn'));
      return;
    }
    chrome.runtime.sendMessage({ action: 'getPreviousTab' }, async (r) => {
      if (r?.tabId) await chrome.tabs.update(r.tabId, { active: true }).catch(() => {});
      if (!(await isOnboardingIncomplete())) {
        window.close();
      }
    });
  };
}

function bindStatsSubTabs() {
  if ($('keyLoggerTab')) $('keyLoggerTab').onclick = () => switchSubTab('keyLogger');
  if ($('siteTimeTab')) $('siteTimeTab').onclick = () => switchSubTab('siteTime');
}

// Shows a transient toast when the user clicks/taps a control that's locked
// (e.g. study timers while Advanced Earn is on). Locked controls get
// `data-pf-locked="<message>"` + pointer-events:none, so normal clicks pass
// through silently — this capture-phase listener surfaces a message instead.
let __pfLockToastEl = null;
let __pfLockToastTimer = null;
/**
 * Section-level explainer paragraphs ("This is the hourly breakdown…",
 * "This shows you a mix…") — hide on load if the user dismissed them
 * previously, and wire the × close button so click persists the dismissal
 * via chrome.storage.local. User spec 2026-07 v4: these hints shouldn't
 * be permanent on the page.
 */
function bindSectionExplainerDismiss() {
  const explainers = Array.from(document.querySelectorAll('.pf-section-explainer[data-dismiss-key]'));
  if (!explainers.length) return;
  const keys = explainers.map((el) => el.dataset.dismissKey).filter(Boolean);
  // Read all dismiss flags in a single storage call, then paint.
  chrome.storage.local.get(keys).then((stored) => {
    for (const el of explainers) {
      const key = el.dataset.dismissKey;
      if (stored?.[key] === true) el.hidden = true;
    }
  }).catch(() => { /* best-effort */ });
  for (const el of explainers) {
    if (el.dataset.pfDismissBound === '1') continue;
    el.dataset.pfDismissBound = '1';
    const closeBtn = el.querySelector('.pf-section-explainer-close');
    if (!closeBtn) continue;
    const dismiss = (e) => {
      // Stop bubbling so a wrapping tab-switcher / scroll handler can't
      // swallow the click. User report 2026-07 v36: "the popup didn't
      // close for a bit" — some clicks were being consumed by the
      // stats-section click routing before el.hidden could take effect.
      if (e) { e.preventDefault(); e.stopPropagation(); }
      el.hidden = true;
      const key = el.dataset.dismissKey;
      if (key) chrome.storage.local.set({ [key]: true }).catch(() => {});
    };
    // Capture-phase so no ancestor listener can eat the click first.
    closeBtn.addEventListener('click', dismiss, true);
    // Pointerdown backs it up in case a Chrome click event gets dropped
    // (has happened during heavy stats re-renders).
    closeBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dismiss(e);
    }, true);
  }
}

function bindLockedControlHint() {
  // Lazy-create the toast element.
  const ensureToast = () => {
    if (__pfLockToastEl && document.body.contains(__pfLockToastEl)) return __pfLockToastEl;
    const el = document.createElement('div');
    el.id = 'pf-lock-toast';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:90px', 'transform:translate(-50%,12px)',
      'background:rgba(33,37,41,0.96)', 'color:#fff', 'padding:10px 18px',
      'border-radius:10px', 'font:600 13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 30px rgba(0,0,0,0.3)', 'z-index:2147483647',
      'pointer-events:none', 'opacity:0', 'transition:opacity .18s ease,transform .18s ease',
      'max-width:80vw', 'text-align:center'
    ].join(';');
    document.body.appendChild(el);
    __pfLockToastEl = el;
    return el;
  };
  const showToast = (msg) => {
    const el = ensureToast();
    el.textContent = msg || 'Locked';
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translate(-50%,0)';
    });
    if (__pfLockToastTimer) clearTimeout(__pfLockToastTimer);
    __pfLockToastTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,12px)';
    }, 1800);
  };

  // Locked controls have pointer-events:none, so the click's e.target is the
  // element BEHIND them (not the locked control). Use elementsFromPoint to find
  // every element at the cursor — including locked ones — so we can surface a
  // message instead of a silent no-op.
  document.addEventListener('click', (e) => {
    let locked = null;
    // First try the event target + ancestors (catches clicks on a locked
    // control's label/wrapper where pointer-events is still live).
    const target = e.target;
    if (target && typeof target.closest === 'function') {
      locked = target.closest('[data-pf-locked]');
    }
    // Fall back to hit-testing every element at the point (catches the actual
    // locked control sitting under the cursor behind whatever received the click).
    if (!locked && typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of stack) {
        if (el && typeof el.closest === 'function' && el.closest('[data-pf-locked]')) {
          locked = el.closest('[data-pf-locked]');
          break;
        }
      }
    }
    if (!locked) return;
    let msg = locked.getAttribute('data-pf-locked');
    if (!msg || msg === '1') msg = 'Disable Advanced Earn/Spend to use this';
    showToast(msg);
  }, true);
}

function bootDashboardUiBindings() {
  wakeExtensionServiceWorker();
  bindMainTabs();
  bindStatsSubTabs();
  bindProfilePanelOpenClose();
  // Wrapped in try/catch so a binder failure can't cascade and kill
  // subsequent bindings (was suspected of blanking the stats tab).
  try { void bindAnalyticsOptOutToggle(); }
  catch (e) { console.warn('[pf-dashboard] bindAnalyticsOptOutToggle failed', e); }
  try { void bindWrappedNotifToggles(); }
  catch (e) { console.warn('[pf-dashboard] bindWrappedNotifToggles failed', e); }
  bindAdvancedSettingsToggle();
  bindResetPreviewsButton();
  bindRevertTutorialButton();
  bindLockedControlHint();
  bindSectionExplainerDismiss();
  try { void bindReorderTabsToggle(); }
  catch (e) { console.warn('[pf-dashboard] bindReorderTabsToggle failed', e); }
  // Safety: if the tutorial-active body class got stuck on from a previous
  // session (interrupted runTutorial, crashed step, etc.), it hides the
  // dev "Test: Revert Tutorial" button via CSS and forces other UI into
  // tutorial mode. Clear it whenever the tutorial is actually completed.
  (async () => {
    try {
      if (await isTutorialCompleted()) {
        document.body.classList.remove('tutorial-active');
        const sessionFlag = await chrome.storage.session.get('tutorialActive').catch(() => null);
        if (sessionFlag?.tutorialActive === true) {
          await chrome.storage.session.set({ tutorialActive: false }).catch(() => {});
        }
      }
    } catch (_) {}
  })();
  // Body-delegated fallback so the reset-tutorial click always reaches the
  // handler even if a direct bind missed (e.g. button not yet in DOM, or
  // dataset.bound got set without the listener attaching). Idempotent via a
  // dataset flag on <body>.
  if (!document.body.dataset.pfRevertDelegate) {
    document.body.dataset.pfRevertDelegate = '1';
    document.body.addEventListener('click', (event) => {
      const target = event.target?.closest?.('#revertTutorialBtn');
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      void resetTutorialForDevTest().catch((err) => {
        console.error('[pf-tutor] dev reset (delegated) failed:', err);
        alert('Tutorial reset failed — check the dashboard console for details.');
      });
    }, true);
  }
  // Bind the Advanced Earn/Spend chevron EARLY (independent of the heavy
  // DOMContentLoaded listener) so the dropdown always opens on click even if
  // a later render step throws before that listener reaches its own binding.
  try {
    bindAdvancedEarnSpendChevron();
  } catch (err) {
    console.warn('[pf-dashboard] bindAdvancedEarnSpendChevron failed', err);
  }
  try {
    bindUnprodReminderDropdown();
  } catch (err) {
    console.warn('[pf-dashboard] bindUnprodReminderDropdown failed', err);
  }
  restoreDashboardTabs()
    .catch(() => {
      switchMainTab('window', { persist: false });
    })
    .finally(() => {
      if (typeof globalThis.pfMarkDashboardUiReady === 'function') {
        globalThis.pfMarkDashboardUiReady();
      }
    });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootDashboardUiBindings, { once: true });
} else {
  bootDashboardUiBindings();
}

const TUTORIAL_RESET_LOCAL_KEYS = [
  'tutorialState', 'lastTutorialStep', 'tutorialReachedStep14',
  'tutorialUserClickedProductive', 'tutorialNameConfirmed',
  'tutorialTabLimitConfirmed', 'tutorialTabLimitApplied', 'tabLimitLockState',
  'tutorialCloserToggleCycleDone',
  'tutorialWipeTabTimesConfigured',
  'tutorialCustomizationsOpened', 'tutorialSelectedNotebook',
  'tutorialMockToggled', 'tutorialCommitTyped', 'wordsAddedInTutor', 'tabLimitConfirmedInTutor',
  'tutorialPinStepDone', 'tutorialDataModeStepDone', 'tutorialSkippedMain', 'tutorialSkippedEver',
  'tutorialSkipVideoShown'
];

function resetTutorialInMemoryState() {
  currentStep = 0;
  postSigninMode = null;
  tabLimitConfirmedInTutor = false;
  tutorialUserClickedProductive = false;
  tutorialCommitProgress = 0;
  tutorialTabLimitLocked = false;
  tutorialTabLimitReadyForConfirm = false;
  tutorialTabLimitUserEdited = false;
  tutorialTabLimitUnlockSeen = false;
  tutorialTabLimitRelockSeen = false;
  tutorialTabLimitConfirmClicked = false;
  tutorialMockStage = 1;
  tutorialMockIsOn = false;
  tutorialStep9SawOn = false;
  tutorialStep9AutoUnlocked = false;
  tutorialStep8SawOn = false;
  postSigninFinishShownThisSession = false;
  if (tutorCountdownTimer) {
    clearInterval(tutorCountdownTimer);
    tutorCountdownTimer = null;
  }
  tutorCountdownRemaining = 0;
  if (tutorRafId) {
    cancelAnimationFrame(tutorRafId);
    tutorRafId = null;
  }
}

function ensureTutorBoxInWrapper() {
  const box = $('tutorBox');
  const wrapper = $('tutorialContentWrapper');
  if (!box || !wrapper || box.parentElement === wrapper) return;
  wrapper.appendChild(box);
}

function resetTutorialDomState() {
  hideTutorialSkipVideoModal();
  hideTabLimitSkippedUserConfirm();
  // Fresh tutorial run → fresh one-shot Daily Wrapped demo banner (the
  // used flag lives on the element, so removing it re-arms the demo).
  $('pf-tutorial-wrapped-card')?.remove();
  pfClearTabLimitWatchdogStyles();
  const overlay = $('tutorialOverlay');
  if (overlay) {
    overlay.classList.remove('active', 'revealed');
    overlay.style.clipPath = '';
    overlay.style.webkitClipPath = '';
  }
  const wrapper = $('tutorialContentWrapper');
  if (wrapper) wrapper.style.display = 'none';
  ensureTutorBoxInWrapper();
  const tutorBox = $('tutorBox');
  if (tutorBox) {
    tutorBox.style.display = 'block';
    tutorBox.style.visibility = 'hidden';
    tutorBox.style.opacity = '0';
    tutorBox.style.transform = '';
    tutorBox.classList.remove('tutorial-box-large', 'tutorial-box-signin', 'tutor-content-3x', 'tutor-content-lg', 'tutor-content-md', 'tutor-box-wide', 'tutor-box-compact', 'tutor-box-beside-name', 'tutor-box-beside-medium', 'tutor-box-below-expanded', 'tutor-box-below-compact', 'tutor-box-above-expanded', 'tutor-box-beside-right', 'tutor-box-floating-btn');
  }
  const header = $('tutorialHeader');
  if (header) {
    header.style.display = '';
    header.style.opacity = '1';
  }
  const nextBtn = $('tutorNext');
  if (nextBtn) {
    nextBtn.style.display = 'inline-block';
    nextBtn.innerText = 'Next';
  }
  const signInBtn = $('tutorSignIn');
  if (signInBtn) signInBtn.style.display = 'none';
  const skipBtn = $('tutorSkip');
  if (skipBtn) skipBtn.style.display = 'inline-block';
  restoreTutorialDevChrome();
  document.body.style.overflow = '';
  document.body.classList.remove('tutorial-active', 'tutor-data-mode-active', 'pf-profile-modal-open', 'tutorial-step-pvu', 'tutorial-step-wipe', 'tutorial-step-ranking', 'tutorial-step-study', 'tutorial-step-tablimit', 'tutorial-step-theme', 'tutorial-step-wrapped', 'pf-step9-pulse-off');
  document.documentElement.classList.remove('tutorial-preload');
  clearTutorialTutorFontOverrides();
  showTutorPinExtensionGuide(false);
  showTutorDataModeGuide(false);
}

async function resetTutorialForDevTest() {
  const btn = $('revertTutorialBtn');
  const prevLabel = btn?.textContent;
  if (btn) btn.textContent = 'Resetting…';

  try {
    cleanupTutorialExtras();
    clearTutorialHighlight();
    resetTutorialInMemoryState();
    closeProfilePanel();

    await chrome.storage.session.set({ tutorialActive: false });
    await chrome.runtime.sendMessage({ action: 'clearTutorialTimeout' }).catch(() => {});
    await chrome.storage.local.remove(TUTORIAL_RESET_LOCAL_KEYS);
    await chrome.storage.local.set({
      onboardingRequired: true,
      tutorialCompleted: false,
      tutorialComplete: false,
      tutorialState: { step: 0 },
      lastTutorialStep: 0,
      dataCollectionMode: 'pending',
      telemetryEnabled: false
    });

    resetTutorialDomState();
    restoreTutorialDevChrome();
    switchMainTab('window');
    await updateRankingModeDemoVisibility();
    tutorialRunToken += 1;
    await runTutorial({ force: true, startStep: 0 });
  } finally {
    if (btn) btn.textContent = prevLabel || 'Test: Revert Tutorial';
  }
}

function bindRevertTutorialButton() {
  const btn = $('revertTutorialBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void resetTutorialForDevTest().catch((err) => {
      console.error('[pf-tutor] dev reset failed:', err);
      alert('Tutorial reset failed — check the dashboard console for details.');
    });
  });
}

if (typeof window !== 'undefined') {
  window.__pfResetTutorial = () => resetTutorialForDevTest();
}

$('fillStartupFromStatsBtn')?.addEventListener('click', () => { void fillStartupSlotsFromStats(); });
$('fillStartupFromProductiveBtn')?.addEventListener('click', () => { void fillStartupSlotsFromProductiveStats(); });
$('confirmStartupSlots')?.addEventListener('click', () => { void confirmStartupSlots(); });

['wipeTabTimesInterval', 'wipeTabTimesAt'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', () => {
    if (id === 'wipeTabTimesInterval') updateWipeTabTimesAtRowState();
    void autoSave('wipeTabTimes');
    void maybeAdvanceTutorialWipeTabTimesStep();
  });
});
updateWipeTabTimesAtRowState();

const pauseDurationEl = $('pauseDuration');
// Select button UX: once a duration is locked in it's grayed out ("already
// set"). Moving the slider — even by 1 min — unlocks it so the user can
// re-select. Per user spec 2026-07.
function applySelectPauseButtonState(mode) {
  const button = document.getElementById('selectPauseDuration');
  if (!button) return;
  if (mode === 'locked') {
    button.disabled = true;
    button.style.background = '#c8c8d0';
    button.style.cursor = 'not-allowed';
    button.style.opacity = '0.75';
    button.dataset.pfLocked = '1';
    button.innerText = 'Set';
  } else {
    button.disabled = false;
    button.style.background = 'var(--pf-purple-600)';
    button.style.cursor = 'pointer';
    button.style.opacity = '1';
    button.dataset.pfLocked = '';
    button.innerText = 'Select';
  }
}
if (pauseDurationEl) {
  pauseDurationEl.oninput = () => {
    $('pauseDurationLabel').innerText = `${pauseDurationEl.value} min${pauseDurationEl.value == 1 ? '' : 's'}`;
    // Any slider movement unlocks the button.
    applySelectPauseButtonState('unlocked');
  };
}
if ($('selectPauseDuration')) {
  // Reflect any previously-persisted selection on first paint.
  chrome.storage.local.get(['selectedPauseDuration', 'pauseDuration']).then((r) => {
    const sliderVal = parseInt($('pauseDuration')?.value, 10);
    // First-time users have no selectedPauseDuration persisted. Per user
    // spec 2026-07 the "Keep a tab in place" control should default to
    // 0 mins with the Set button ALREADY locked — so the setting appears
    // deliberately off until the user picks a real duration.
    const persisted = Number.isFinite(r?.selectedPauseDuration) ? r.selectedPauseDuration : null;
    const firstTime = persisted === null;
    const locked = firstTime || persisted === sliderVal;
    applySelectPauseButtonState(locked ? 'locked' : 'unlocked');
  }).catch(() => {});
  $('selectPauseDuration').onclick = async () => {
    const button = $('selectPauseDuration');
    if (button?.dataset.pfLocked === '1') return; // no-op when already set
    const selectedDuration = parseInt($('pauseDuration')?.value, 10);
    if (!Number.isFinite(selectedDuration) || selectedDuration < 1) return;
    await chrome.storage.local.set({ selectedPauseDuration: selectedDuration, selectedPauseTime: Date.now() });
    const originalText = button.innerText;
    button.innerText = 'Selected! ' + selectedDuration + ' min';
    button.style.background = '#28a745';
    setTimeout(() => {
      applySelectPauseButtonState('locked');
    }, 1400);
  };
}

function formatDurationFromSeconds(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

let dashboardDisplayReady = false;
let dashboardDisplayInterval = null;
let dashboardStorageRefreshTimer = null;

function ensureDashboardLoadingStyle() {
  if (document.getElementById('pf-dash-loading-style')) return;
  const style = document.createElement('style');
  style.id = 'pf-dash-loading-style';
  style.textContent = `
    html.pf-dash-loading #bankedTimeSection,
    html.pf-dash-loading #bankedTimeContainer,
    html.pf-dash-loading #modeBSpendTimePanel,
    html.pf-dash-loading #unprodTimerStartBtn,
    html.pf-dash-loading #studyTimerStartBtn { visibility: hidden; }
  `;
  document.head.appendChild(style);
}

function showDashboardToast(message, type = 'error') {
  let el = document.getElementById('pfDashboardToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pfDashboardToast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10000;padding:12px 18px;border-radius:10px;font-size:14px;max-width:min(90%,520px);box-shadow:0 4px 20px rgba(0,0,0,0.15);display:none;';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.background = type === 'error' ? '#fee2e2' : '#f0fdf4';
  el.style.color = type === 'error' ? '#991b1b' : '#166534';
  el.style.display = 'block';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 7000);
}

async function resolveWindowName(windowId) {
  if (windowId == null) return null;
  const wnResp = await chrome.runtime.sendMessage({ action: 'getWindowName', windowId }).catch(() => null);
  return wnResp?.windowName || wnResp?.name || null;
}

async function resolveAvailableBankSeconds(windowId, windowName = null) {
  const name = windowName || (windowId != null ? await resolveWindowName(windowId) : null);
  if (windowId == null && !name) return 0;
  const statsResp = windowId != null
    ? await chrome.runtime.sendMessage({ action: 'getFocusedBankStats', windowId }).catch(() => null)
    : null;
  // (Video-overage debt subtraction removed — user spec 2026-07 v41.)
  const stored = await chrome.storage.local.get(['focusedTimeBank', 'bankedReward']);
  const key = name || `Window ${windowId}`;
  let gross;
  if (statsResp?.success) {
    gross = Math.floor(statsResp.stats.bankedSeconds || 0);
  } else {
    const entry = stored.focusedTimeBank?.[key] || { bankedMinutes: 0, bankedSeconds: 0 };
    const legacySec = Math.floor(entry.bankedSeconds || 0) + Math.floor(entry.bankedMinutes || 0) * 60;
    // bankedReward[key] is now an OBJECT keyed by source host
    // ({ "youtube.com": 1800, "_pooled": 900, ... }) since per-source-site
    // tracking was added. Sum all host values. Legacy data may still be a
    // plain number, so fall back to that shape too.
    const raw = stored.bankedReward?.[key];
    let rewardSec = 0;
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(raw)) {
        rewardSec += Math.max(0, Math.floor(Number(raw[k]) || 0));
      }
    } else {
      rewardSec = Math.max(0, Math.floor(Number(raw) || 0));
    }
    gross = Math.max(rewardSec, legacySec);
  }
  return gross;
}

function scheduleDashboardStorageRefresh() {
  if (dashboardStorageRefreshTimer) clearTimeout(dashboardStorageRefreshTimer);
  dashboardStorageRefreshTimer = setTimeout(() => {
    dashboardStorageRefreshTimer = null;
    if (!dashboardDisplayReady) return;
    refreshDashboardDisplay().catch(() => {});
  }, 200);
}

function startDashboardDisplayPoll() {
  if (dashboardDisplayInterval) return;
  dashboardDisplayInterval = setInterval(() => {
    if (document.hidden || !dashboardDisplayReady) return;
    refreshDashboardDisplay().catch(() => {});
  }, 1000);
}

function stopDashboardDisplayPoll() {
  if (dashboardDisplayInterval) {
    clearInterval(dashboardDisplayInterval);
    dashboardDisplayInterval = null;
  }
}

function teardownDashboardIntervals() {
  stopDashboardDisplayPoll();
  stopDashboardTimerPoll();
  stopWpmPoll();
}

let dropdownOpen = false;

if ($('enableBankedTime')) {
  $('enableBankedTime').onchange = async () => {
    const selectedWindowId = await getSelectedWindowId();
    const d = await chrome.storage.local.get("windowConfigs");
    const configs = d.windowConfigs || {};
    const checked = $('enableBankedTime').checked;
    configs[selectedWindowId] = configs[selectedWindowId] || {};
    configs[selectedWindowId].bankedTimeEnabled = checked;
    await chrome.storage.local.set({ windowConfigs: configs });
    if (checked) await checkOtherWindowsBankedTime();
    autoSave('enableBankedTime');
    void refreshSettingDemoVisibility('bankedTime');
  };
}

async function checkOtherWindowsBankedTime() {
  const selectedWindowName = await getSelectedWindowId();
  const result = await chrome.storage.local.get(['windowConfigs', 'bankedTimeData']);
  const configs = result.windowConfigs || {};
  const bankedData = result.bankedTimeData || {};

  for (const [windowName, config] of Object.entries(configs)) {
    if (windowName === selectedWindowName) continue;
    if (config?.bankedTimeEnabled && bankedData[windowName]) {
      bankedData[selectedWindowName] = bankedData[selectedWindowName] || [];
      bankedData[selectedWindowName] = bankedData[selectedWindowName].concat(bankedData[windowName]);
      delete bankedData[windowName];
      await chrome.storage.local.set({ bankedTimeData: bankedData });
      updateBankedTimeDisplay();
      alert(`Transferred banked time from ${windowName} to selected window!`);
      break;
    }
  }
}

if ($('useBankedTime')) {
  $('useBankedTime').onclick = async () => {
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (!win?.id) return;
    const windowName = await getSelectedWindowId();
    const resp = await chrome.runtime.sendMessage({
      action: 'spendLegacyBankedTime',
      windowId: win.id,
      windowName
    }).catch(() => null);
    const totalSec = Math.floor(resp?.deductedSec || 0);
    if (!resp?.success || totalSec < 1) {
      alert('No banked break time yet. Enable Focused Time Banked and spend focused time on a Productive site to earn some first.');
      return;
    }

  writeTimerHmsFromSeconds('unprodTimeLimit', totalSec);
  syncTimerHiddenFromHms('unprodTimeLimit');
  await startUnprodTimer();

  const status = $('bankedTimeStatus');
  if (status) {
    status.textContent = totalSec >= 60
      ? `✓ Unproductive timer loaded with ${Math.floor(totalSec / 60)}m break time`
      : `✓ Unproductive timer loaded with ${totalSec}s break time`;
    status.style.color = '#28a745';
  }
  updateFocusedBankDisplay();
  const wid = await getCurrentWindowIdForTimer();
  const name = wid != null ? await getFriendlyWindowNameForTimer(wid) : windowName;
  await renderModeBSpendUI(name);
  };
}

async function updateFocusedBankDisplay(windowIdHint = null, windowNameHint = null) {
  const win = await chrome.windows.getCurrent();
  const windowId = windowIdHint ?? win?.id ?? null;
  const windowName = windowNameHint
    || (windowId != null ? await resolveWindowName(windowId) : null)
    || await getSelectedWindowId();
  const resolvedSec = await pfComputeCombinedBreakSec(windowName);
  const statsResp = windowId != null
    ? await chrome.runtime.sendMessage({ action: 'getFocusedBankStats', windowId }).catch(() => null)
    : null;
  const display = $('bankedTimeDisplay');
  if (display) {
    display.textContent = resolvedSec >= 3600
      ? `${Math.floor(resolvedSec / 3600)}h ${Math.floor((resolvedSec % 3600) / 60)}m`
      : resolvedSec >= 60
        ? `${Math.floor(resolvedSec / 60)}m ${resolvedSec % 60}s`
        : `${resolvedSec}s`;
  }
  const progressEl = $('focusedBankProgress');
  if (progressEl && statsResp?.success) {
    const s = statsResp.stats;
    progressEl.textContent = s.bankFocusSeconds
      ? `Progress toward next deposit: ${formatDurationFromSeconds(s.progressSeconds)} / ${formatDurationFromSeconds(s.bankFocusSeconds)} (Work/Study timer running)`
      : 'Set a rate above. Time banks while the Work/Study timer runs.';
  }
}

async function refreshDashboardDisplay() {
  if (!dashboardDisplayReady) return;
  const wid = await getCurrentWindowIdForTimer();
  const windowName = wid != null
    ? ((await resolveWindowName(wid)) || await getSelectedWindowId())
    : await getSelectedWindowId();
  await updateFocusedBankDisplay(wid, windowName);
  await renderStudyBreakUI(windowName);
  await renderModeBSpendUI(windowName);
}

function updateBankedTimeDisplay() {
  void refreshDashboardDisplay();
}

chrome.storage.local.get(['bankedTimeData']).then(async () => {
  updateBankedTimeDisplay();
  loadTransferWindowOptions();
});

function loadTransferWindowOptions() {
  const select = document.getElementById('transferTimeWindowSelect');
  if (!select) return;

  chrome.storage.local.get(['windowConfigs']).then(result => {
    const configs = result.windowConfigs || {};
    while (select.children.length > 1) {
      select.removeChild(select.lastChild);
    }
    Object.keys(configs).forEach(windowName => {
      const option = document.createElement('option');
      option.value = windowName;
      option.textContent = windowName;
      select.appendChild(option);
    });
  });
}

const transferTimeBtn = $('transferTimeBtn');
if (transferTimeBtn) {
  transferTimeBtn.style.display = 'none';
}

function saveUnproductiveTimeToWindow(windowId, timeInMinutes, source) {
  chrome.storage.local.get(['bankedTimeData']).then(result => {
    const bankedData = result.bankedTimeData || {};
    if (!bankedData[windowId]) {
      bankedData[windowId] = [];
    }
    const hours = Math.floor(timeInMinutes / 60);
    const minutes = timeInMinutes % 60;
    bankedData[windowId].push({
      hours,
      minutes,
      source: source || 'Unproductive Session',
      timestamp: Date.now(),
      type: 'unproductive'
    });
    chrome.storage.local.set({ bankedTimeData: bankedData });
    console.log(`Saved ${timeInMinutes} minutes of unproductive time to window ${windowId}`);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveUnproductiveTime') {
    chrome.storage.local.get(['bankingWindows']).then(result => {
      const bankingWindows = result.bankingWindows || [];
      if (bankingWindows.length > 0) {
        bankingWindows.forEach(windowId => {
          saveUnproductiveTimeToWindow(windowId, message.timeInMinutes, message.source);
        });
        sendResponse({ success: true, savedTo: bankingWindows.length });
      } else {
        sendResponse({ success: false, error: 'No banking windows configured' });
      }
    });
    return true;
  }
});

async function migrateWindowConfigsToWindowNames() {
  const d = await chrome.storage.local.get(['windowConfigs', 'windowNameList']);
  const configs = d.windowConfigs || {};
  const nameList = d.windowNameList || {};
  const next = {};
  let changed = false;
  for (const [key, config] of Object.entries(configs)) {
    if (/^\d+$/.test(String(key))) {
      const numericId = Number(key);
      const name = nameList[numericId] || config?.name || `Window ${numericId}`;
      next[name] = { ...(next[name] || {}), ...config };
      changed = true;
    } else {
      next[key] = config;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ windowConfigs: next });
    return next;
  }
  return configs;
}

async function getCurrentWindowConfigKey() {
  const win = await chrome.windows.getCurrent();
  return (await resolveWindowName(win.id)) || `Window ${win.id}`;
}

async function getSelectedWindowId() {
  const selectedWindow = document.querySelector('#otherWindowsList .selected');
  if (selectedWindow?.dataset?.windowName) {
    return selectedWindow.dataset.windowName;
  }

  const win = await chrome.windows.getCurrent();
  return (await resolveWindowName(win.id)) || `Window ${win.id}`;
}

async function updateTutorNextState() {
  const n = $('tutorNext');
  if (!n) return;
  const flags = await getTutorialStorageFlags();
  const step = steps[currentStep];
  let ok = true;

  if (!step) {
    ok = true;
  } else if (step.unlock === 'always') {
    ok = true;
  } else if (step.unlock === 'commit-typing') {
    ok = flags.tutorialCommitTyped === true;
  } else if (step.unlock === 'productive-click') {
    ok = flags.tutorialUserClickedProductive === true;
  } else if (step.unlock === 'name-save') {
    ok = flags.tutorialNameConfirmed === true;
  } else if (step.unlock === 'tab-limit') {
    ok = flags.tutorialTabLimitConfirmed === true;
  } else if (step.unlock === 'tab-limit-lock-cycle') {
    ok = flags.tutorialTabLimitConfirmed === true;
  } else if (step.unlock === 'tab-limit-apply') {
    ok = flags.tutorialTabLimitApplied === true;
  } else if (step.unlock === 'customizations-theme') {
    // Either theme choice unlocks Next (was student/notebook-only). Students
    // pick Notebook, professionals pick the classic — both count.
    ok = flags.tutorialSelectedNotebook === true
      || flags.tutorialSelectedProfessional === true;
  } else if (step.unlock === 'closer-toggle-cycle') {
    ok = flags.tutorialCloserToggleCycleDone === true;
  } else if (step.unlock === 'mock-stage-flow') {
    ok = flags.tutorialMockToggled === true;
  } else if (step.unlock === 'wipe-tab-times-setup') {
    ok = flags.tutorialWipeTabTimesConfigured === true;
  } else if (step.unlock === 'wrapped-opened') {
    ok = flags.tutorialWrappedOpened === true;
  }

  const isCommitStep = step?.unlock === 'commit-typing';
  n.disabled = isCommitStep ? false : !ok;
  n.style.backgroundColor = ok ? '#5B4B9F' : '#ccc';
  n.style.color = ok ? 'white' : '#666';
  n.style.cursor = ok ? 'pointer' : (isCommitStep ? 'not-allowed' : 'default');
  updateTutorProgressNote(ok);
}

function isCommitTypingStep(stepIdx = currentStep) {
  return steps[stepIdx]?.unlock === 'commit-typing';
}

function activateTutorialTab(tabKey) {
  if (!tabKey) return;
  if (tabKey === 'window' || tabKey === 'stats' || tabKey === 'customizations') {
    switchMainTab(tabKey, { force: true });
    return;
  }
  const legacy = $(tabKey);
  if (legacy) legacy.click();
}

async function applyTutorialStepEffects(idx) {
  cleanupTutorialExtras();
  // DEFENSE-IN-DEPTH (user report 2026-07: step 14 → step 15 coach-mark box
  // never appeared): the Daily Wrapped crate→story-viewer flow leaves the
  // `pf-recap-fullscreen-open` body class on, and stats.html force-hides
  // #tutorBox with !important while that class is present. The viewer's
  // onClose now clears it, but a step change must NEVER inherit a stranded
  // recap overlay class — strip it on every step entry so the coach-mark
  // is always free to show.
  document.documentElement.classList.remove('pf-recap-fullscreen-open');
  document.body.classList.remove('pf-recap-fullscreen-open');
  const step = steps[idx];
  if (!step) return;
  document.body.classList.toggle('tutorial-step-pvu', idx === 12);
  document.body.classList.toggle('tutorial-step-wrapped', idx === 13);
  document.body.classList.toggle('tutorial-step-wipe', idx === 6);
  document.body.classList.toggle('tutorial-step-ranking', idx === 5);
  document.body.classList.toggle('tutorial-step-study', idx === 10);
  document.body.classList.toggle('tutorial-step-work', idx === 9);
  document.body.classList.toggle('tutorial-step-closer', idx === 7);
  // Tab-limit steps (idx 3 = "Tab limit", idx 4 = "Apply your limit"):
  // both target the SAME tabLimitWrapper element, which by default sits in
  // the top-right header — visually too high. This class pins the wrapper
  // lower on the viewport for BOTH steps so they land in the same spot
  // (user spec 2026-07 v17). See body.tutorial-step-tablimit CSS.
  document.body.classList.toggle('tutorial-step-tablimit', idx === 3 || idx === 4);
  // Deterministic pins: portal the step's pinned target to <body> + inline
  // pin/ring (tab-limit steps 3/4, ranking step 5, wipe step 6); restore
  // every other portaled target the moment a new step renders (keyed on the
  // NEW idx — cleanupTutorialExtras runs before currentStep flips, so it
  // can't be trusted for this).
  const stepPin = PF_TUTORIAL_STEP_PINS[idx];
  pfPortalUnpinAllTutorialTargets(stepPin ? stepPin.id : null);
  if (stepPin) pfPortalPinTutorialTarget(stepPin);
  // Theme step: Professional / Student audience tags above the two owned
  // theme cards render only under this class.
  document.body.classList.toggle('tutorial-step-theme', idx === 11);
  // UNIVERSAL APPEAR-IN-PLACE (2026-07): hide the box on EVERY step entry.
  // It re-appears (fade, no movement) only after its final coords are set.
  // Steps whose box glided visibly across the pinned highlight kept being
  // reported one at a time (6, 7, 8, then 10 after step 9's box moved to
  // the bottom corner made the 9→10 glide dramatic) — hiding at entry for
  // ALL steps ends the whole class of glitch. Both opacity AND visibility
  // are needed — opacity alone still renders the box in its old position.
  {
    const box = $('tutorBox');
    if (box) { box.style.opacity = '0'; box.style.visibility = 'hidden'; box.style.transition = 'none'; }
  }
  if (TUTOR_STACK_CENTERED_STEPS.has(idx)) {
    runTutorialPageScroll((root) => {
      root.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }
  const inTabLimitSteps = idx === 3 || idx === 4;

  activateTutorialTab(step.tab);
  setTutorialThemeCarouselMode(idx === 11);
  setTutorialCommitUIVisible(isCommitTypingStep(idx));

  const b = $('tutorBox');
  if (b) b.classList.toggle('tutorial-box-large', step.boxSize === 'large');
  // Sign-in step (last step) gets an extra-large box (user spec 2026-07 v43:
  // "on step 16 make the whole sign in box a bit bigger please").
  if (b) b.classList.toggle('tutorial-box-signin', idx === TUTORIAL_MAIN_STEPS - 1);
  setTutorialContentScale(idx);

  if (step.showDemoCard) ensureTutorialDemoCard(true);
  if (step.showMockIndicator) ensureTutorialMockIndicator(true);
  if (step.showTimerMock) ensureTutorialTimerMock(true);
  if (step.showWrappedCard) {
    await chrome.storage.local.set({ tutorialWrappedOpened: false });
    ensureTutorialWrappedCard(true);
  }

  $('confirmTabLimit')?.classList.remove('tutorial-active-green', 'tutorial-pulse');
  // Step 3 ("Press the lock to unlock Confirm"): make the lock button GLOW
  // so the eye lands on it (user spec 2026-07). Removed on every other step.
  $('tabLimitLockBtn')?.classList.toggle('pf-tutorial-lock-glow', idx === 3);
  setTutorialNotebookPulse(false);

  const nextBtn = $('tutorNext');
  const signInBtn = $('tutorSignIn');
  const skipBtn = $('tutorSkip');
  if (idx === TUTORIAL_MAIN_STEPS - 1) {
    if (nextBtn) nextBtn.style.display = 'none';
    if (signInBtn) signInBtn.style.display = 'inline-block';
    if (skipBtn) skipBtn.style.display = 'none';
  } else {
    if (nextBtn) {
      nextBtn.style.display = 'inline-block';
      nextBtn.innerText = 'Next';
    }
    if (signInBtn) signInBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'inline-block';
  }

  if (idx === 3) {
    tutorialTabLimitLocked = false;
    tutorialTabLimitReadyForConfirm = false;
    tutorialTabLimitUserEdited = false;
    tutorialTabLimitUnlockSeen = true;
    tutorialTabLimitRelockSeen = false;
    await chrome.storage.local.set({
      tutorialTabLimitConfirmed: false,
      tutorialTabLimitApplied: false
    });
    updateTutorialTabLimitControls();
    void updateTutorNextState();
  }

  if (isCommitTypingStep(idx)) {
    await resetTutorialCommitGate();
    void updateTutorNextState();
  }

  if (idx === 4) {
    tutorialTabLimitConfirmClicked = false;
    tutorialTabLimitLocked = true;
    tutorialTabLimitReadyForConfirm = true;
    tutorialTabLimitUserEdited = false;
    tutorialTabLimitUnlockSeen = true;
    updateTutorialTabLimitControls();
    const confirmBtn = $('confirmTabLimit');
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.style.cursor = 'pointer';
      confirmBtn.style.animation = '';
      console.info('[pf-tutor-confirm] step 5 active, button now green');
    }
    const n = parseInt($('maxTabLimit')?.value, 10) || 5;
    const textEl = $('tutorText');
    if (textEl) textEl.innerHTML = step.text.replace('[N]', String(n));
  }

  if (idx === 8) {
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (win?.id != null) {
      const configResponse = await chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id });
      const limEn = configResponse?.config?.limitsEnabled === true;
      await syncEnforcerToggleLimits(limEn, { persist: false });
    }
    tutorialStep9AutoUnlocked = false;
    await chrome.storage.local.set({ tutorialMockToggled: false });
    tutorialMockStage = 1;
    tutorialMockIsOn = false;
    tutorialStep9SawOn = false;
    tutorialStep9BtnPulseStopped = false;
    // Re-entering step 10 fresh: reset the "pulse off" body class so the
    // initial pulse comes back on the first stage 1 render.
    document.body.classList.remove('pf-step9-pulse-off');
    const mockBtn = $('pfTutorialMockIndicatorBtn');
    const mockStack = mockBtn?.closest('.pf-btn-stack');
    const ring = $('pfTutorialMockProgressRing');
    const countdown = $('pfTutorialMockCountdown');
    const spinAccent = $('pfTutorialMockSpinAccent');
    const timerRing = document.querySelector('#pf-tutorial-timer-mock .pf-progress-ring');
    if (mockBtn) {
      mockBtn.classList.add('pf-off');
      mockBtn.classList.remove('pf-on', 'pf-holding');
      mockBtn.title = 'Closer is OFF, hold 2s to turn ON';
      mockBtn.style.transform = '';
      mockBtn.style.background = 'radial-gradient(circle at 38% 32%, #2a313a 0%, #12151a 72%)';
      mockBtn.style.boxShadow = 'inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -2px 3px rgba(0,0,0,0.55)';
      mockBtn.style.border = 'none';
    }
    if (mockStack) mockStack.classList.remove('pf-holding');
    if (ring) {
      ring.classList.remove('pf-done', 'rotating-unprod', 'pf-visible');
      ring.style.background = '';
    }
    if (countdown) {
      countdown.classList.remove('pf-visible');
      countdown.textContent = '';
    }
    if (spinAccent) {
      spinAccent.classList.remove('pf-visible', 'rotating-unprod', 'rotating-study');
    }
    if (timerRing) timerRing.classList.remove('rotating-unprod');
    const textEl = $('tutorText');
    if (textEl) {
      textEl.innerText = "The floating button on the bottom right of any page also controls this toggle. Try turning it on by holding it for 2 seconds.";
    }
  }

  if (idx === 7) {
    tutorialStep8SawOn = false;
    await chrome.storage.local.set({ tutorialCloserToggleCycleDone: false });
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (win?.id != null) {
      const configResponse = await chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id });
      const limEn = configResponse?.config?.limitsEnabled === true;
      await syncEnforcerToggleLimits(limEn, { persist: false });
    }
    const textEl = $('tutorText');
    if (textEl) {
      textEl.innerText = 'This is the toggle for closing unproductive tabs. Turn it on if you want unproductive tabs to be closed. Leave it off if you want them to stay open.';
    }
  }

  if (idx === 5) {
    const tabRadio = $('rankingModeTab');
    if (tabRadio) tabRadio.checked = true;
    updateWipeTabTimesVisibility();
    syncRankingModeDemo();
    void applyRankingModeChange();
    const rankingMain = $('rankingModeMain');
    if (rankingMain) rankingMain.style.display = '';
    void updateTutorNextState();
  }

  if (idx === 6) {
    await chrome.storage.local.set({ tutorialWipeTabTimesConfigured: false });
    const tabRadio = $('rankingModeTab');
    if (tabRadio) tabRadio.checked = true;
    updateWipeTabTimesVisibility();
    // Default the reset interval to 30 minutes during the tutorial (user
    // spec 2026-07 v43: "step 7 instead of auto on one week put it on 30min
    // not 1 week"). Previously the dropdown fell back to '1w' (1 week) —
    // the select's last option / the autoSave fallback — so a new user
    // enabling the feature during onboarding got a once-per-week reset,
    // which barely affects ranking. 30 minutes keeps scores fresh.
    const wipeInterval = $('wipeTabTimesInterval');
    if (wipeInterval) wipeInterval.value = '30m';
    // Re-run visibility AFTER setting the value so the "Preferred reset
    // time" row hides correctly for the 30m default (user report 2026-07
    // v47: it was still visible at step 7 because visibility was computed
    // from the stale pre-tutorial value).
    updateWipeTabTimesAtRowState();
    const wipeCheck = $('enableWipeTabTimes');
    const wipeSection = $('wipeTabTimesSection');
    const wipeContainer = $('wipeTabTimesContainer');
    if (wipeCheck) {
      wipeCheck.checked = false;
      if (wipeSection) wipeSection.style.display = 'none';
    }
    if (wipeContainer) {
      wipeContainer.style.display = 'block';
      wipeContainer.classList.remove('active');
      wipeContainer.classList.add('inactive');
    }
    void updateTutorNextState();
  }

  if (idx === 11) {
    switchMainTab('customizations', { force: true });
    await selectTheme('tutorial_background');
    await chrome.storage.local.set({
      tutorialSelectedNotebook: false,
      selectedTheme: 'tutorial_background'
    });
    setTutorialNotebookPulse(true);
  }

  if (idx === 12) {
    activateTutorialPvuSample();
    // Stamp the activation time so tutorialBlocksPvuHover suppresses hover for
    // the first 3 seconds (user spec 2026-07 v43: "the hover doesn't work for
    // like 3 seconds... even if they are hovering over it for 3 secs the hover
    // thing won't show up"). Gives the user time to read the intro text.
    pfPvuStepActivatedAt = Date.now();
    switchSubTab('siteTime', { persist: false });
    await renderProductiveVsUnproductive();
  }

  setTutorialTimerFieldsLocked(false);
  if (idx === 9) {
    setTutorialTimerFieldsLocked(true, ['studyTimerBlock']);
    ensureTutorialTimerPreset('unprodTimeLimit', 5 * 60);
  } else if (idx === 10) {
    setTutorialTimerFieldsLocked(true, ['unprodTimerBlock']);
    ensureTutorialTimerPreset('studyTimeLimit', 25 * 60);
    // Per user report 2026-07: step 11 (Reminders) should land with the
    // Reminders panel already open so the highlighted content is
    // visible without the user having to click the dropdown chevron.
    try {
      const rToggle = $('unprodReminderToggle');
      const rPanel = $('unprodReminderPanel');
      if (rPanel && rPanel.style.display === 'none') {
        rPanel.style.display = 'block';
      }
      if (rToggle) rToggle.setAttribute('aria-expanded', 'true');
    } catch (_) { /* best-effort */ }
  } else if (idx < TUTORIAL_MAIN_STEPS) {
    setTutorialTimerFieldsLocked(true, ['unprodTimerBlock', 'studyTimerBlock']);
  }

  if (!inTabLimitSteps) {
    tutorialTabLimitLocked = false;
    tutorialTabLimitReadyForConfirm = false;
    tutorialTabLimitUserEdited = false;
    tutorialTabLimitUnlockSeen = false;
    tutorialTabLimitRelockSeen = false;
    updateTutorialTabLimitControls();
  }

  updateTutorialProgressBar(idx);
}

async function persistTutorialStep(idx) {
  await chrome.storage.local.set({
    tutorialState: { step: idx },
    lastTutorialStep: idx,
    onboardingRequired: true
  });
}

async function persistTutorialProgressOnClose() {
  if (await isTutorialCompleted()) return;
  const stepToSave = Number.isFinite(currentStep) ? currentStep : 0;
  await chrome.storage.local.set({
    tutorialState: { step: stepToSave },
    lastTutorialStep: stepToSave,
    onboardingRequired: true
  });
  await chrome.storage.session.set({
    tutorialActive: true,
    tutorialDashboardTabId: null,
    tutorialDashboardWindowId: null
  }).catch(() => {});
}

function isSignedInSession(session) {
  if (!session?.access_token) return false;
  return Boolean(session.user?.email || emailFromAccessToken(session.access_token));
}

function shouldResumePostSigninTutorial(stored) {
  if (!stored?.tutorialReachedStep14 || !isSignedInSession(stored.pfSession)) {
    return false;
  }
  const stepIdx = stored.tutorialState?.step ?? stored.lastTutorialStep ?? 0;
  return stepIdx >= TUTORIAL_MAIN_STEPS - 1;
}

async function runTutorial(options = {}) {
  if (!options.force && await isTutorialCompleted()) return;

  const d = await chrome.storage.local.get([
    'tutorialState', 'lastTutorialStep', 'tutorialReachedStep14', 'pfSession'
  ]);

  if (!options.force && shouldResumePostSigninTutorial(d)) {
    const postFlags = await chrome.storage.local.get(['tutorialPinStepDone', 'tutorialDataModeStepDone']);
    if (!postFlags.tutorialPinStepDone) {
      await showPostSigninPinStep();
      return;
    }
    if (!postFlags.tutorialDataModeStepDone) {
      await showPostSigninDataModeStep();
      return;
    }
    await showPostSigninStep();
    return;
  }

  await chrome.storage.session.set({ tutorialActive: true });
  closeProfilePanel();
  postSigninMode = null;
  await chrome.runtime.sendMessage({ action: 'startTutorialTimeout' }).catch(() => {});
  await registerTutorialDashboardTab();

  const stepIdx = options.force
    ? (options.startStep ?? 0)
    : (d.tutorialState?.step ?? d.lastTutorialStep ?? 0);
  const overlay = $('tutorialOverlay');
  const wrapper = $('tutorialContentWrapper');
  if (!overlay || !wrapper) {
    console.error('[pf-tutor] tutorial overlay elements missing');
    return;
  }
  ensureTutorBoxInWrapper();
  overlay.classList.add('active');
  overlay.classList.remove('revealed');
  overlay.style.clipPath = '';
  overlay.style.webkitClipPath = '';
  document.body.style.overflow = 'hidden';
  document.body.classList.add('tutorial-active');
  wrapper.style.display = 'block';
  document.documentElement.classList.remove('tutorial-preload');
  const runToken = ++tutorialRunToken;
  const safeStepIdx = Math.min(stepIdx, steps.length - 1);
  try {
    await showStep(safeStepIdx);
  } catch (err) {
    console.error('[pf-tutor] showStep failed during boot:', err, { stepIdx: safeStepIdx });
    if (runToken !== tutorialRunToken) return;
    const b = $('tutorBox');
    const h = $('tutorialHeader');
    ensureTutorBoxInWrapper();
    if (h) {
      h.style.display = 'block';
      h.style.opacity = '1';
      h.innerText = `Step ${safeStepIdx + 1} of ${TUTORIAL_MAIN_STEPS}`;
    }
    if (b) {
      b.style.display = 'block';
      b.style.visibility = 'visible';
      b.style.opacity = '1';
      centerTutorBox();
    }
  }
}

async function showPostSigninPinStep() {
  postSigninMode = 'pin';
  closeProfilePanel();
  await chrome.storage.session.set({ tutorialActive: true });
  await registerTutorialDashboardTab();
  $('tutorialOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
  document.body.classList.add('tutorial-active');
  $('tutorialContentWrapper').style.display = 'block';
  updateTutorialProgressBar(TUTORIAL_MAIN_STEPS);
  const fill = $('tutorialProgressFill');
  if (fill) fill.style.width = '100%';

  const b = $('tutorBox');
  const h = $('tutorialHeader');
  if (h) h.style.display = 'none';
  if (b) {
    b.classList.add('tutorial-box-large');
    $('tutorTitle').innerText = postSigninPinStep.title;
    $('tutorText').replaceChildren();
    $('tutorText').classList.add('tutor-pin-no-body');
    $('tutorText').classList.remove('tutor-readable-text');
    $('tutorTitle').classList.remove('tutor-readable-text');
    showTutorPinExtensionGuide(true);
    showTutorDataModeGuide(false);
    $('tutorNext').innerText = 'Next';
    $('tutorNext').style.display = 'inline-block';
    $('tutorNext').disabled = false;
    const signInBtn = $('tutorSignIn');
    if (signInBtn) signInBtn.style.display = 'none';
    const skipBtn = $('tutorSkip');
    if (skipBtn) skipBtn.style.display = 'inline-block';
    b.style.visibility = 'visible';
    b.style.opacity = '1';
    b.style.display = 'block';
    requestAnimationFrame(() => {
      const { width: boxW, height: boxH } = getTutorBoxLayoutSize(b);
      const y = centerTutorBoxY(boxH);
      b.style.transform = `translate3d(${(window.innerWidth - boxW) / 2}px, ${y}px, 0)`;
    });
  }
  currentStep = TUTORIAL_MAIN_STEPS;
  $('tutorNext').style.backgroundColor = '#5B4B9F';
  updateTutorProgressNote(true);
}

async function showPostSigninDataModeStep() {
  postSigninMode = 'datamode';
  closeProfilePanel();
  await chrome.storage.session.set({ tutorialActive: true });
  await registerTutorialDashboardTab();
  $('tutorialOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
  document.body.classList.add('tutorial-active');
  $('tutorialContentWrapper').style.display = 'block';
  updateTutorialProgressBar(TUTORIAL_MAIN_STEPS);
  const fill = $('tutorialProgressFill');
  if (fill) fill.style.width = '100%';

  const b = $('tutorBox');
  const h = $('tutorialHeader');
  if (h) h.style.display = 'none';
  if (b) {
    b.classList.add('tutorial-box-large');
    $('tutorTitle').innerText = postSigninDataModeStep.title;
    $('tutorText').replaceChildren();
    $('tutorText').classList.add('tutor-pin-no-body');
    $('tutorText').classList.remove('tutor-readable-text');
    showTutorPinExtensionGuide(false);
    showTutorDataModeGuide(true, 'choice');
    $('tutorTitle')?.classList.remove('tutor-readable-text');
    $('tutorNext').style.display = 'none';
    $('tutorNext').disabled = false;
    const signInBtn = $('tutorSignIn');
    if (signInBtn) signInBtn.style.display = 'none';
    const skipBtn = $('tutorSkip');
    if (skipBtn) skipBtn.style.display = 'none';
    b.style.visibility = 'visible';
    b.style.opacity = '1';
    b.style.display = 'block';
    requestAnimationFrame(() => {
      const { width: boxW, height: boxH } = getTutorBoxLayoutSize(b);
      const y = centerTutorBoxY(boxH);
      b.style.transform = `translate3d(${(window.innerWidth - boxW) / 2}px, ${y}px, 0)`;
    });
  }
  currentStep = TUTORIAL_MAIN_STEPS;
  updateTutorProgressNote(true);
}

// One-shot guard for Stick-with-it (user report 2026-07 v31: card was
// appearing twice). finishTutorial has many awaits — during that window a
// second signin-status tick can hit showPostSigninStep before
// tutorialCompleted lands in storage, re-showing the card. This flag pins
// the answer for the rest of the session; a real fresh tutorial run will
// reset it via resetTutorialInMemoryState.
let postSigninFinishShownThisSession = false;

async function showPostSigninStep() {
  // Bail if the Stick-with-it card has already been shown OR is currently
  // showing. Two guards cover both a lingering `finish` mode and a stale
  // "we've shown this once" flag from a prior in-session fire.
  if (postSigninMode === 'finish') return;
  if (postSigninFinishShownThisSession) return;
  postSigninFinishShownThisSession = true;
  postSigninMode = 'finish';
  cleanupTutorialExtras();
  pfUnpinTabLimitAfterTutorial(); // reached from ANY step — never leave the wrapper pinned
  clearTutorialHighlight();
  switchMainTab('window');
  closeProfilePanel();
  await chrome.storage.session.set({ tutorialActive: true });
  await registerTutorialDashboardTab();
  $('tutorialOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
  document.body.classList.add('tutorial-active');
  $('tutorialContentWrapper').style.display = 'block';
  updateTutorialProgressBar(TUTORIAL_MAIN_STEPS);
  const fill = $('tutorialProgressFill');
  if (fill) fill.style.width = '100%';

  const b = $('tutorBox');
  const h = $('tutorialHeader');
  if (h) h.style.display = 'none';
  if (b) {
    b.classList.remove('tutorial-box-large');
    b.classList.add('tutorial-finish-step');
    document.body.classList.add('tutorial-finish-step');
    // Set the readable-text class BEFORE painting the copy so the browser
    // does exactly one style resolution — no font swap flicker (user report
    // 2026-07 v5: the card briefly rendered in handwritten and then
    // flashed to sans-serif). body.theme-notebook is set synchronously by
    // the theme loader, so we can trust it as the source of truth here.
    const isNotebookSync = document.body.classList.contains('theme-notebook');
    $('tutorText').classList.toggle('tutor-readable-text', isNotebookSync);
    $('tutorTitle').classList.toggle('tutor-readable-text', isNotebookSync);
    $('tutorText').classList.remove('tutor-pin-no-body');
    $('tutorText').style.display = '';
    $('tutorTitle').innerText = postSigninStep.title;
    $('tutorText').innerText = postSigninStep.text;
    // Belt-and-braces: reconcile with storage in case the body class
    // hadn't been applied yet (very rare — storage-loaded theme normally
    // beats us here). If storage disagrees we correct AFTER first paint;
    // worst case the reconciliation matches and no repaint happens.
    try {
      const stored = await chrome.storage.local.get('selectedTheme');
      const isNotebook = stored?.selectedTheme === 'notebook' || isNotebookSync;
      if (isNotebook !== isNotebookSync) {
        $('tutorText').classList.toggle('tutor-readable-text', isNotebook);
        $('tutorTitle').classList.toggle('tutor-readable-text', isNotebook);
      }
    } catch (_) { /* body-class fallback already applied */ }
    showTutorPinExtensionGuide(false);
    showTutorDataModeGuide(false);
    $('tutorNext').innerText = 'Finish';
    $('tutorNext').style.display = 'inline-block';
    const signInBtn = $('tutorSignIn');
    if (signInBtn) signInBtn.style.display = 'none';
    const skipBtn = $('tutorSkip');
    if (skipBtn) skipBtn.style.display = 'inline-block';
    b.style.visibility = 'visible';
    b.style.opacity = '1';
    b.style.display = 'block';
    const { width: boxW, height: boxH } = getTutorBoxLayoutSize(b);
    const y = centerTutorBoxY(boxH);
    b.style.transform = `translate3d(${(window.innerWidth - boxW) / 2}px, ${y}px, 0)`;
  }
  currentStep = TUTORIAL_MAIN_STEPS;
  $('tutorNext').disabled = false;
  $('tutorNext').style.backgroundColor = '#5B4B9F';
  updateTutorProgressNote(true);
}

async function showStep(idx) {
  if (tutorCountdownTimer) {
    clearInterval(tutorCountdownTimer);
    tutorCountdownTimer = null;
  }
  tutorCountdownRemaining = 0;
  s = steps[idx];
  if (!s) {
    console.warn('[pf-tutor] showStep called with invalid idx', idx);
    return;
  }
  // Silently skip any step flagged with `skip: true` (see "Name your window"
  // at index 2). Auto-advances FORWARD by default; if we were moving
  // backward (e.g. Back button from step 3), auto-advance backward instead
  // so the user doesn't get stuck on a hidden step.
  if (s.skip === true) {
    const nextIdx = idx > currentStep ? idx + 1 : idx - 1;
    if (nextIdx >= 0 && nextIdx < steps.length && steps[nextIdx]) {
      return showStep(nextIdx);
    }
    // No valid neighbor — fall through and render the step as a safety net.
  }
  postSigninMode = null;
  const prevStep = steps[currentStep] || null;
  currentStep = idx;
  await persistTutorialStep(idx);
  await applyTutorialStepEffects(idx);
  // Anonymous funnel event — sanitized step_name (letters/dashes only) so no
  // free text can leak through. See analytics.js for the sanitizer.
  try {
    const stepName = String(s.title || 'step')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    void pfAnalyticsCapture('tutorial_step_reached', {
      step_index: idx,
      step_name: stepName
    });
    if (idx === 0) void pfAnalyticsCapture('tutorial_started', { tutorial_version: 'v1' });
    if (idx === TUTORIAL_MAIN_STEPS - 1) void pfAnalyticsCapture('signin_reached', {});
  } catch (_) { /* analytics is best-effort */ }

  const b = document.getElementById('tutorBox');
  const h = $('tutorialHeader');
  if (!b) {
    console.error('[pf-tutor] tutorBox missing — cannot show step', idx);
    return;
  }
  if (h) {
    h.style.display = 'block';
    h.style.opacity = '1';
    h.innerText = `Step ${idx + 1} of ${TUTORIAL_MAIN_STEPS}`;
    h.style.color = '#5B4B9F';
  }

  const tutorTextEl = $('tutorText');
  if (tutorTextEl) {
    tutorTextEl.style.display = '';
    tutorTextEl.classList.remove('tutor-pin-no-body');
  }

  const isCentered = !s.target;
  const sameTargetAsPrevious = !!(prevStep && prevStep.target && prevStep.target === s.target);
  const revealDelayMs = isCentered ? 0 : 40;
  const stepStartTs = Date.now();
  const isFirstTutorRender = b.style.visibility !== 'visible' || b.style.opacity !== '1';

  const calculateTargetCoords = () => {
    const { width: boxW, height: boxH } = getTutorBoxLayoutSize(b);
    // WINDOWS PARITY (user report 2026-07): use the documentElement client
    // size, not window.innerWidth/Height. On Windows, classic scrollbars are
    // ~17px wide and INCLUDED in innerWidth, so every centred box sat
    // slightly right of true centre and could clip under the scrollbar.
    // On macOS overlay scrollbars the two values are identical, so this is
    // a no-op there — the tutorial now lays out the same on both.
    const screenW = document.documentElement.clientWidth || window.innerWidth;
    const screenH = document.documentElement.clientHeight || window.innerHeight;
    const pad = 20;
    const { clampX, clampY } = createTutorBoxClamps(boxW, boxH, screenW, screenH, pad);

    if (!s.target) {
      return { x: (screenW - boxW) / 2, y: centerTutorBoxY(boxH, screenH) };
    }

    const target = $(s.target);
    if (!target) return { x: (screenW - boxW) / 2, y: centerTutorBoxY(boxH, screenH) };
    const tr = target.getBoundingClientRect();

    if (idx === 12) {
      const topReserve = getTutorialTopReserve();
      const gap = 12;
      return {
        x: clampX((screenW - boxW) / 2),
        y: topReserve + gap
      };
    }

    if (TUTOR_STACK_CENTERED_STEPS.has(idx)) {
      // NEVER tutorCoordsBelowTarget here: its clampY pulls the box back UP
      // over a low-sitting target — the exact "text box on top of the
      // highlight" the user kept reporting on steps 6/7 (2026-07, ×3). The
      // no-scroll primitive keeps the box strictly below and height-caps it
      // instead.
      const below = repositionTutorBelowTargetNoScroll(target, b, stackCenteredLayoutGap(idx));
      if (below) return below;
      return tutorCoordsBelowTarget(tr, boxW, clampX, clampY, stackCenteredLayoutGap(idx));
    }

    if (TUTOR_BELOW_TARGET_STEPS.has(idx)) {
      const belowGap = idx === 9 ? 20 : 28;
      return tutorCoordsBelowTarget(tr, boxW, clampX, clampY, belowGap);
    }

    if (TUTOR_ABOVE_TARGET_STEPS.has(idx)) {
      return tutorCoordsAboveTarget(tr, boxW, boxH, clampX, clampY, 24);
    }

    if (TUTOR_BESIDE_TARGET_STEPS.has(idx)) {
      const gap = TUTOR_BESIDE_ALIGN_TARGET_STEPS.has(idx) ? 24 : 16;
      const coords = tutorCoordsBesideTargetLeft(tr, boxW, boxH, clampX, clampY, pad, screenW, screenH, gap);
      if (TUTOR_BESIDE_CENTER_Y_STEPS.has(idx)) {
        coords.y = centerTutorBoxY(boxH, screenH);
      } else if (TUTOR_BESIDE_ALIGN_TARGET_STEPS.has(idx)) {
        coords.y = clampY(coords.y + TUTOR_BESIDE_ALIGN_TARGET_Y_OFFSET);
      }
      return coords;
    }

    if (TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) {
      return tutorCoordsBesideTargetRight(tr, boxW, boxH, clampX, clampY, pad, screenW, screenH);
    }

    if (idx === 8) {
      const gap = 16;
      const buttonRect = getTutorialFloatingButtonHighlightEl()?.getBoundingClientRect() || tr;
      // 2026-07 v4 (user: "still too far from the button"): ALWAYS snuggle
      // the box against the bottom-right mock button. Beside-left with a
      // tight 12px gap when it fits; otherwise right-aligned directly ABOVE
      // the button. The old avoiding-fallback could park the box at the
      // bottom-CENTRE — bottom edge correct but half a screen away
      // horizontally, which is what kept reading as "too far".
      // v5 (user: "still too high"): the ONLY way the bottom-anchored box
      // can end up high is an oversized measured height — the old
      // Math.max(topReserve, …) floor then pinned it to the TOP. Cap the
      // box height to the available space (it scrolls internally) so the
      // bottom anchor always holds: bottom edge 12px off the screen bottom,
      // no exceptions.
      const topRes = getTutorialTopReserve();
      let effBoxH = boxH;
      const maxBoxH = screenH - topRes - 24;
      if (effBoxH > maxBoxH) {
        b.style.maxHeight = `${maxBoxH}px`;
        effBoxH = maxBoxH;
      }
      const yBottom = screenH - effBoxH - 12;
      const besideLeft = buttonRect.left - boxW - 12;
      if (besideLeft >= pad) {
        return { x: clampX(besideLeft), y: yBottom };
      }
      return {
        x: clampX(screenW - boxW - 24),
        y: Math.max(topRes, buttonRect.top - effBoxH - 12)
      };
    }

    if (s.boxPosition === 'bottom-right') {
      return computeTutorBoxCoordsAvoidingTarget(
        tr, boxW, boxH, screenW, screenH, pad, ['above', 'left', 'below']
      );
    }

    return computeTutorBoxCoordsAvoidingTarget(
      tr, boxW, boxH, screenW, screenH, pad, ['below', 'above', 'left', 'right']
    );
  };

  tutorialRepositionBox = () => {
    if (Date.now() < pfTutorRepositionMuteUntil) return; // theme-swap window
    const targetEl = s?.target ? $(s.target) : null;
    if ((TUTOR_BESIDE_TARGET_STEPS.has(idx) || TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) && targetEl) {
      if (TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) {
        scrollForTutorBesideTargetRight(targetEl, b);
      } else {
        scrollTutorBesideTargetIntoSafeZone(targetEl);
      }
      setTutorTarget(calculateTargetCoords(), { animate: true });
      return;
    }
    if (TUTOR_STACK_CENTERED_STEPS.has(idx) && targetEl) {
      const coords = layoutHighlightStackCentered(targetEl, b, { gap: stackCenteredLayoutGap(idx) });
      setTutorTarget(coords || calculateTargetCoords(), { animate: true });
      return;
    }
    if (TUTOR_BELOW_TARGET_STEPS.has(idx) && targetEl) {
      scrollForTutorBelowTarget(targetEl, b, 28, tutorBelowScrollOptions(idx));
    } else if (TUTOR_ABOVE_TARGET_STEPS.has(idx) && targetEl) {
      scrollForTutorAboveTarget(targetEl, b);
    } else if (idx === 12 && targetEl) {
      scrollTutorialHighlightBelowHeaderTutor(targetEl, b, TUTOR_PVU_CHART_GAP);
    }
    setTutorTarget(calculateTargetCoords(), { animate: true });
  };

  const setTutorTarget = (coords, { animate = true } = {}) => {
    if (!coords || !b) return;
    tutorMotionCurrent = { x: coords.x, y: coords.y };
    tutorMotionTarget = { x: coords.x, y: coords.y };

    if (!animate) {
      b.style.transition = `opacity ${TUTOR_BOX_GLIDE_MS}ms ${TUTOR_BOX_GLIDE_EASING}`;
      b.style.transform = `translate3d(${coords.x}px, ${coords.y}px, 0)`;
      return;
    }

    const current = readTutorBoxVisualPosition(b);
    b.style.transition = 'none';
    b.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`;
    void b.offsetHeight;
    b.style.transition = `opacity ${TUTOR_BOX_GLIDE_MS}ms ${TUTOR_BOX_GLIDE_EASING}, transform ${TUTOR_BOX_GLIDE_MS}ms ${TUTOR_BOX_GLIDE_EASING}`;
    b.style.transform = `translate3d(${coords.x}px, ${coords.y}px, 0)`;
  };

  tutorialSetTutorTarget = setTutorTarget;
  tutorialCalculateTargetCoords = calculateTargetCoords;

  // Resize adaptation (user report 2026-07 v47: "if they make the screen
  // wider while using something in the tutorial then it will look off").
  // The RAF loop only re-fires when the TARGET's rect changes — but a
  // window resize can leave a fixed-position target unchanged while the
  // rest of the layout reflows. Snap the tutor box + highlight coords
  // once resize settles. Debounced through RAF so we don't thrash on
  // every resize event. Bound once per session.
  if (!tutorialResizeListenerBound) {
    tutorialResizeListenerBound = true;
    window.addEventListener('resize', () => {
      if (!document.body.classList.contains('tutorial-active')) return;
      if (tutorialResizeRafId) cancelAnimationFrame(tutorialResizeRafId);
      tutorialResizeRafId = requestAnimationFrame(() => {
        tutorialResizeRafId = 0;
        if (Date.now() < pfTutorRepositionMuteUntil) return;
        if (!tutorialSetTutorTarget || !tutorialCalculateTargetCoords) return;
        try {
          const coords = tutorialCalculateTargetCoords();
          if (coords) tutorialSetTutorTarget(coords, { animate: false });
        } catch (_) { /* best-effort */ }
      });
    }, { passive: true });
  }

  b.style.display = 'block';
  if (isFirstTutorRender) b.style.opacity = '0';
  ensureTutorBoxInWrapper();

  $('tutorTitle').innerText = s.title;
  if (idx !== 4) {
    const lateFlags = idx === 11
      ? await chrome.storage.local.get('tutorialSelectedNotebook')
      : {};
    if (idx === 11 && lateFlags.tutorialSelectedNotebook === true) {
      $('tutorText').innerText = TUTORIAL_NOTEBOOK_SELECTED_TEXT;
    } else {
      $('tutorText').innerHTML = s.text;
    }
  }
  if (isCommitTypingStep(idx)) setTutorialCommitUIVisible(true);
  await applyTutorialTutorFont(idx);

  await updateTutorNextState();
  if (posInterval) { clearInterval(posInterval); posInterval = null; }
  if (tutorRafId) { cancelAnimationFrame(tutorRafId); tutorRafId = null; }
  lastTutorRect = null;
  if (!sameTargetAsPrevious) {
    document.querySelectorAll('.tutor-highlight').forEach(el => el.classList.remove('tutor-highlight'));
    document.querySelectorAll('.tutor-highlight-fixed').forEach(el => el.classList.remove('tutor-highlight-fixed'));
    document.querySelectorAll('.tutor-highlight-wide').forEach(el => el.classList.remove('tutor-highlight-wide'));
    document.querySelectorAll('.tutor-highlight-wide-fixed').forEach(el => el.classList.remove('tutor-highlight-wide-fixed'));
    document.querySelectorAll('.tutor-soft-highlight').forEach(el => el.classList.remove('tutor-soft-highlight'));
    document.querySelectorAll('.tutor-soft-highlight-fixed').forEach(el => el.classList.remove('tutor-soft-highlight-fixed'));
  }

  let target = s.target ? $(s.target) : null;
  if (idx === 8) {
    target = getTutorialFloatingButtonHighlightEl();
  }
  const skipScroll = TUTORIAL_FIXED_TARGETS.has(s.target);

  // Stack-centered steps (5/6/7/10) are back IN the watch list (2026-07):
  // they were excluded, so when the target shifted late on a cold first run
  // (worker config resolving, fonts, demo cards) the one-shot position was
  // computed against a rect that then moved — box ended up ON TOP of the
  // highlight with nothing to correct it. Watching is safe for them now:
  // their calculateTargetCoords path re-seats strictly below the live rect
  // WITHOUT scrolling, so there's no scroll↔rect feedback loop.
  //
  // idx 11 (theme step, user-facing "step 12") is ALSO excluded from motion
  // tracking (user report 2026-07 v43: "the text box seems to move super
  // weirdly when switching from either themes"). The theme carousel is a
  // FIXED-position element — its coordinates don't change once pinned. But
  // a skin swap re-renders the carousel + swaps fonts, and mid-swap the
  // carousel's rect transitions through intermediate sizes. The RAF loop
  // detected those rect changes and repositioned the box to garbage coords
  // (dipping to mid-screen, gliding left/right). The existing 900ms mute
  // (pfTutorRepositionMuteUntil in selectTheme) + the collapsed-rect guard
  // (< 5×5px) weren't enough — the carousel rect can be > 5×5 but still in
  // a transitional state during font load. Disabling motion tracking for
  // idx 11 entirely means the box is positioned once on step entry and
  // stays put — no more weird movement during theme swaps.
  const trackTargetMotion = !(idx === 8 || idx === 11 || idx === 12);
  const startRafLoop = () => {
    if (!trackTargetMotion) return;
    const rafLoop = () => {
      if (Date.now() < pfTutorRepositionMuteUntil) { tutorRafId = requestAnimationFrame(rafLoop); return; }
      const liveTarget = s.target ? $(s.target) : null;
      if (liveTarget && Date.now() - stepStartTs > 220) {
        const liveRect = liveTarget.getBoundingClientRect();
        // COLLAPSED-RECT GUARD (2026-07): mid theme-swap (step 12) the
        // carousel re-renders and its rect is momentarily 0×0 — computing
        // coords from that sent the box gliding to viewport CENTER and
        // back (user report: "text box moving to the middle when switching
        // between the notepad and tutorial skin"). Hold position until the
        // target has a real rect again.
        if (liveRect.width >= 5 && liveRect.height >= 5) {
          const currentRect = JSON.stringify(liveRect);
          if (currentRect !== lastTutorRect) {
            lastTutorRect = currentRect;
            // Stack-centered steps SNAP on corrections — an animated glide
            // here slid the box across the highlight (user report 2026-07).
            setTutorTarget(calculateTargetCoords(), { animate: !TUTOR_STACK_CENTERED_STEPS.has(idx) });
          }
        }
      }
      tutorRafId = requestAnimationFrame(rafLoop);
    };
    tutorRafId = requestAnimationFrame(rafLoop);
  };

  if (target) {
    if (h) { h.style.display = 'block'; h.style.opacity = '0'; }
    const positionTutorBox = (instant = false) => {
      // Universal appear-in-place: if the box is still hidden from step
      // entry, SNAP to the coords (no transform glide) and fade in there.
      const hiddenEntry = b.style.opacity === '0';
      const shouldAnimate = !instant && !sameTargetAsPrevious && !hiddenEntry;
      setTutorTarget(calculateTargetCoords(), { animate: shouldAnimate });
      b.style.visibility = 'visible';
      b.style.opacity = '1';
      lastTutorRect = JSON.stringify(target.getBoundingClientRect());
      startRafLoop();
      if (h) h.style.opacity = '1';
    };
    const highlightTarget = (immediate = false) => {
      if (idx === 8) {
        applyTutorialFloatingButtonHighlight();
        return;
      }
      const isFixedTarget = TUTORIAL_FIXED_TARGETS.has(target.id);
      const isWideTarget = TUTORIAL_WIDE_HIGHLIGHT_TARGETS.has(target.id);
      const softHighlightClass = isFixedTarget ? 'tutor-soft-highlight-fixed' : 'tutor-soft-highlight';
      const highlightClass = isFixedTarget ? 'tutor-highlight-fixed' : 'tutor-highlight';
      const wideHighlightClass = isFixedTarget ? 'tutor-highlight-wide-fixed' : 'tutor-highlight-wide';
      if (immediate) {
        target.classList.remove(softHighlightClass);
        target.classList.add(highlightClass);
        if (isWideTarget) target.classList.add(wideHighlightClass);
        return;
      }
      target.classList.add(softHighlightClass);
      setTimeout(() => {
        target.classList.remove(softHighlightClass);
        target.classList.add(highlightClass);
        if (isWideTarget) target.classList.add(wideHighlightClass);
      }, revealDelayMs + 200);
    };
    const shouldBatchStepRender = TUTOR_BELOW_TARGET_STEPS.has(idx) || TUTOR_ABOVE_TARGET_STEPS.has(idx) || TUTOR_STACK_CENTERED_STEPS.has(idx) || idx === 12 || TUTOR_BESIDE_TARGET_STEPS.has(idx) || TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx);
    if (skipScroll) {
      highlightTarget(sameTargetAsPrevious);
      requestAnimationFrame(() => positionTutorBox(isFirstTutorRender));
    } else {
      if (shouldBatchStepRender) {
        requestAnimationFrame(() => {
          // Stack-centered AND above-target steps: DON'T highlight yet —
          // the target is still at its pre-scroll spot, so the ring flashed
          // there for a beat before the layout scroll landed (user reports
          // 2026-07: step 8, and the step 9→10 transition). The highlight
          // is applied inside each branch's rAF, after its scroll has run.
          if (!TUTOR_STACK_CENTERED_STEPS.has(idx) && !TUTOR_ABOVE_TARGET_STEPS.has(idx)) highlightTarget(true);
          if (h) { h.style.display = 'block'; h.style.opacity = '1'; }
          if (TUTOR_BESIDE_TARGET_STEPS.has(idx) || TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) {
            requestAnimationFrame(() => {
              if (TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) {
                scrollForTutorBesideTargetRight(target, b);
              } else {
                // Left-beside steps (incl. "Name your window") must scroll
                // the target into the visible safe zone — see helper.
                scrollTutorBesideTargetIntoSafeZone(target);
              }
              // Appear-in-place: snap, then fade in at the final spot.
              setTutorTarget(calculateTargetCoords(), { animate: false });
              b.style.visibility = 'visible';
              void b.offsetHeight;
              b.style.transition = '';
              b.style.opacity = '1';
              lastTutorRect = JSON.stringify(target.getBoundingClientRect());
            });
            startRafLoop();
            // SETTLE RE-PASSES for the Tab-limit lock step (user report
            // 2026-07: "step 4 doesn't appear on first install until you
            // switch tabs and back"). On a fresh install the layout shifts
            // AFTER this one-shot positioning: the cold service worker is
            // still seeding storage when renderWindowSettings runs (its
            // getWindowConfig round-trip resolves late), fonts activate, and
            // the tutorial-step-tablimit CSS pins the wrapper — so the box +
            // ring were computed against a rect that then moved, leaving the
            // step invisible/misplaced until a tab switch forced a repaint.
            // Re-seat everything after the layout has settled.
            // Also the THEME step (idx 11, right-beside): on first install
            // the carousel rendered before late layout (cold worker config,
            // fonts, images) and the skin cards ended up pushed way down /
            // off-screen (user report 2026-07). Same settle-re-pass cure.
            // Windows widened to 0.3s–4s: first-install stalls (cold worker,
            // font downloads) can take seconds, which is why the earlier
            // 280/800ms passes missed (user report: "still broken").
            if (idx === 3 || idx === 4 || idx === 11) {
              for (const ms of [300, 1000, 2000, 4000]) {
                setTimeout(() => {
                  if (currentStep !== idx || !target.isConnected) return;
                  // Tutorial closed since this pass was scheduled? (Skip from
                  // a pinned step leaves currentStep pointing at it — without
                  // this check the pass would RE-PIN the target and re-add
                  // tutorial-active onto the live dashboard.)
                  if (!$('tutorialOverlay')?.classList.contains('active')) return;
                  try {
                    // Re-assert the portal pin (idempotent) — covers cold
                    // first-run layout stalls for tab-limit AND theme steps.
                    if (PF_TUTORIAL_STEP_PINS[idx]) pfPortalPinTutorialTarget(PF_TUTORIAL_STEP_PINS[idx]);
                    // WATCHDOG (tab-limit steps): verify the pinned target is
                    // genuinely visible; if not, force it and log WHY so the
                    // next report tells us the true root cause.
                    if (idx === 3 || idx === 4) pfEnsureTabLimitStepVisible(target);
                    // WATCHDOG (theme step): after an exit + extension
                    // update + resume, the highlight vanished entirely
                    // (user report 2026-07) — the customizations tab wasn't
                    // re-activated, leaving the carousel display:none.
                    // Verify and force it back.
                    if (idx === 11) pfEnsureThemeStepVisible(target);
                    // COLLAPSED-RECT GUARD (2026-07), AFTER the watchdog so a
                    // genuinely hidden carousel still gets force-shown first:
                    // during the step-12 theme swap the carousel re-renders
                    // (rect 0×0) — a settle pass firing right then centered
                    // the box. Skip; a later pass / raf watcher re-seats it.
                    if (idx === 11) {
                      const setRect = target.getBoundingClientRect();
                      if (setRect.width < 5 || setRect.height < 5) return;
                      // THEME-SWAP MUTE GUARD (user report 2026-07 v43: "its
                      // still moving up"). The settle passes at 2s/4s can fire
                      // DURING a theme swap — the carousel's rect is mid-
                      // transition and calculateTargetCoords returns coords
                      // that move the box UP. Skip the reposition while the
                      // selectTheme mute is active; the box stays where the
                      // user last saw it.
                      if (Date.now() < pfTutorRepositionMuteUntil) return;
                    }
                    if (TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) {
                      scrollForTutorBesideTargetRight(target, b);
                    } else {
                      scrollTutorBesideTargetIntoSafeZone(target);
                    }
                    setTutorTarget(calculateTargetCoords(), { animate: false });
                    lastTutorRect = JSON.stringify(target.getBoundingClientRect());
                    positionTutorBox(false);
                  } catch (_) { /* best-effort */ }
                }, ms);
              }
            }
            return;
          }
          if (idx === 12) {
            b.style.visibility = 'hidden';
            b.style.opacity = '0';
            // 2026-07: sit "a bit below the 13/16" — calculateTargetCoords'
            // idx-12 branch already returns topReserve + 12 (just under the
            // progress header), so use it as-is. The old -350 offset shoved
            // the box up OVER the header.
            const c12 = calculateTargetCoords();
            setTutorTarget({ x: c12.x, y: c12.y }, { animate: false });
            requestAnimationFrame(() => {
              // Use the SAME tuned chart gap as every refresh path — the
              // entry call used the default (+12) while refreshes used
              // TUTOR_PVU_CHART_GAP (-260), so the chart visibly jumped on
              // first open (user report 2026-07: "weird formatting glitch
              // when I first opened it").
              scrollTutorialHighlightBelowHeaderTutor(target, b, TUTOR_PVU_CHART_GAP);
              // NO reveal here (2026-07: "box moves down for a second at the
              // start"). The header is still re-measuring at entry (font +
              // progress re-render), so this early snap can land LOW; the
              // 300ms settle pass below re-derives the final Y and is the
              // one that fades the box in — any correction happens while
              // the box is still invisible.
              lastTutorRect = JSON.stringify(target.getBoundingClientRect());
            });
            // Settle re-passes: first-open layout lands late (chart render,
            // fonts) — re-seat chart + box once things stabilize.
            for (const ms of [300, 1000]) {
              setTimeout(() => {
                if (currentStep !== 12 || !target.isConnected) return;
                // Tutorial closed since scheduling → never re-scroll / re-show.
                if (!$('tutorialOverlay')?.classList.contains('active')) return;
                try {
                  scrollTutorialHighlightBelowHeaderTutor(target, b, TUTOR_PVU_CHART_GAP);
                  // Only re-snap the box if it's actually off (>6px) — the
                  // header re-measures slightly as fonts settle, and an
                  // unconditional re-snap made the box visibly bounce
                  // down-then-up (user report 2026-07).
                  const cs = calculateTargetCoords();
                  const curY = tutorMotionTarget ? tutorMotionTarget.y : null;
                  if (curY == null || Math.abs(cs.y - curY) > 6) {
                    setTutorTarget({ x: cs.x, y: cs.y }, { animate: false });
                  }
                  b.style.visibility = 'visible';
                  b.style.opacity = '1';
                  lastTutorRect = JSON.stringify(target.getBoundingClientRect());
                } catch (_) { /* best-effort */ }
              }, ms);
            }
          } else if (TUTOR_ABOVE_TARGET_STEPS.has(idx)) {
            requestAnimationFrame(() => {
              scrollForTutorAboveTarget(target, b);
              highlightTarget(true); // post-scroll — no pre-scroll flash
              // Fit the box between the header and the pinned card's top —
              // cap its height (scrolls inside) so it can NEVER bury the
              // card (2026-07: "step 10 highlight box still not showing").
              const trNow = target.getBoundingClientRect();
              const roomAbove = Math.max(160, trNow.top - getTutorialTopReserve() - 36);
              const { height: bhNow } = getTutorBoxLayoutSize(b);
              b.style.maxHeight = bhNow > roomAbove ? `${roomAbove}px` : '';
              // Appear-in-place: snap + fade in at the spot.
              setTutorTarget(calculateTargetCoords(), { animate: false });
              b.style.visibility = 'visible';
              void b.offsetHeight;
              b.style.transition = '';
              b.style.opacity = '1';
              lastTutorRect = JSON.stringify(target.getBoundingClientRect());
            });
            // SETTLE RE-PASSES + pin watchdog, same as every cured step: on
            // cold first runs the one-shot layout ran against rects that
            // then moved. Re-pin + re-seat once things stabilize.
            for (const ms of [300, 1000, 2000, 4000]) {
              setTimeout(() => {
                if (currentStep !== idx || !target.isConnected) return;
                if (!$('tutorialOverlay')?.classList.contains('active')) return;
                try {
                  if (PF_TUTORIAL_STEP_PINS[idx]) pfPortalPinTutorialTarget(PF_TUTORIAL_STEP_PINS[idx]);
                  highlightTarget(true);
                  const trS = target.getBoundingClientRect();
                  const roomS = Math.max(160, trS.top - getTutorialTopReserve() - 36);
                  const { height: bhS } = getTutorBoxLayoutSize(b);
                  b.style.maxHeight = bhS > roomS ? `${roomS}px` : '';
                  setTutorTarget(calculateTargetCoords(), { animate: false });
                  b.style.visibility = 'visible';
                  b.style.opacity = '1';
                  lastTutorRect = JSON.stringify(target.getBoundingClientRect());
                } catch (_) { /* best-effort */ }
              }, ms);
            }
          } else if (TUTOR_STACK_CENTERED_STEPS.has(idx)) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const coords = layoutHighlightStackCentered(target, b, { gap: stackCenteredLayoutGap(idx) });
                  highlightTarget(true);
                  // SNAP, never glide (2026-07): with animate, the box was
                  // revealed mid-transition and slid ACROSS the pinned
                  // highlight for a beat on every step change (user report:
                  // "glitches the text box over the highlighted area"). It
                  // now materializes directly below the highlight.
                  setTutorTarget(coords || calculateTargetCoords(), { animate: false });
                  // Fade the box back in after positioning is complete.
                  b.style.visibility = 'visible';
                  void b.offsetHeight;
                  b.style.transition = '';
                  b.style.opacity = '1';
                  lastTutorRect = JSON.stringify(target.getBoundingClientRect());
                });
              });
            });
            // SETTLE RE-PASSES (2026-07): same cure the tab-limit + theme
            // steps needed. On a cold first install the target keeps moving
            // AFTER the one-shot layout above (worker config resolves late,
            // fonts activate, demo cards mount) — the box was left sitting
            // ON TOP of the highlight (user report ×3, steps 6/7). Re-run
            // the full centered-stack layout once things settle; between
            // passes the raf watcher keeps the box strictly below the live
            // rect.
            for (const ms of [300, 1000, 2000, 4000]) {
              setTimeout(() => {
                if (currentStep !== idx || !target.isConnected) return;
                // Tutorial closed since scheduling → never re-pin / re-show.
                if (!$('tutorialOverlay')?.classList.contains('active')) return;
                try {
                  // WATCHDOG (ranking/wipe steps): re-assert the body-portal
                  // pin. On genuine first installs the CSS pin path failed
                  // and the step showed NOTHING until exit/re-enter (user
                  // report 2026-07 — same disease the tab-limit step had).
                  // Idempotent: healthy runs just re-apply identical styles.
                  if (PF_TUTORIAL_STEP_PINS[idx]) pfPortalPinTutorialTarget(PF_TUTORIAL_STEP_PINS[idx]);
                  const coords = layoutHighlightStackCentered(target, b, { gap: stackCenteredLayoutGap(idx) });
                  setTutorTarget(coords || calculateTargetCoords(), { animate: false });
                  b.style.visibility = 'visible';
                  b.style.opacity = '1';
                  lastTutorRect = JSON.stringify(target.getBoundingClientRect());
                } catch (_) { /* best-effort */ }
              }, ms);
            }
          } else {
            requestAnimationFrame(() => {
              scrollForTutorBelowTarget(target, b, 28, tutorBelowScrollOptions(idx));
              requestAnimationFrame(() => {
                // Appear-in-place: snap, then fade in at the final spot.
                setTutorTarget(calculateTargetCoords(), { animate: false });
                b.style.visibility = 'visible';
                void b.offsetHeight;
                b.style.transition = '';
                b.style.opacity = '1';
                lastTutorRect = JSON.stringify(target.getBoundingClientRect());
              });
            });
          }
          startRafLoop();
        });
        return;
      }
      requestAnimationFrame(() => {
        if (!TUTOR_BESIDE_TARGET_STEPS.has(idx) && !TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx)) {
          scrollTutorialTargetIntoView(target, { block: 'center', inline: 'center' });
        }
        setTimeout(() => {
          highlightTarget();
          setTimeout(() => {
            positionTutorBox(isFirstTutorRender);
            if (TUTOR_BELOW_TARGET_STEPS.has(idx)) {
              scrollForTutorBelowTarget(target, b, 28, tutorBelowScrollOptions(idx));
              setTutorTarget(calculateTargetCoords(), { animate: false });
            } else if (TUTOR_ABOVE_TARGET_STEPS.has(idx)) {
              scrollForTutorAboveTarget(target, b);
              setTutorTarget(calculateTargetCoords(), { animate: false });
            }
          }, revealDelayMs);
        }, TUTOR_BESIDE_TARGET_STEPS.has(idx) || TUTOR_BESIDE_TARGET_RIGHT_STEPS.has(idx) ? 0 : revealDelayMs);
      });
    }
  } else {
    if (h) {
      h.style.display = 'block';
      h.style.opacity = '1';
    }
    ensureTutorBoxInWrapper();
    // Skip the slide animation when moving between two targetless (centred)
    // steps — both land at viewport center, so the animation only shows the
    // box "flying in from top-left" (which is the base translate3d(0,0,0)
    // the transition reads from getBoundingClientRect if the box was mid-
    // animation on the prior step). Applies especially to step 14 → 15
    // (Final commitment → Sign in). User spec 2026-07 v17.
    const prevWasCentered = !prevStep?.target;
    // hiddenEntry: universal appear-in-place hid the box at step entry —
    // snap to center and fade in there instead of gliding while fading.
    const hiddenEntry = b.style.opacity === '0';
    const shouldAnimate = !isFirstTutorRender && !sameTargetAsPrevious && !prevWasCentered && !hiddenEntry;
    setTutorTarget(calculateTargetCoords(), { animate: shouldAnimate });
    b.style.visibility = 'visible';
    b.style.opacity = '1';
    startRafLoop();
  }

  const gh = document.getElementById('tutorGroupHighlight');
  if (gh) gh.style.display = 'none';
}

async function finishTutorial({ playReveal = false, showTutorialSkipVideo = false } = {}) {
  // Hide the tutor box + wrapper SYNCHRONOUSLY on entry, before any awaits.
  // Previously the hide happened after `await chrome.storage.local.get(...)`
  // — during that async gap the browser could still paint one frame with
  // the "Stick with it" card visible, and the iris reveal would then start
  // WITH the text box still on screen. Doing it up-front closes the race.
  // Also cancel the tutor RAF loop immediately so it can't re-apply
  // visibility during the gap. (User report 2026-07 v8: text box lingered
  // into the reveal animation.)
  if (tutorRafId) { cancelAnimationFrame(tutorRafId); tutorRafId = null; }
  const _tutorBoxEarly = $('tutorBox');
  if (_tutorBoxEarly) {
    _tutorBoxEarly.style.opacity = '0';
    _tutorBoxEarly.style.visibility = 'hidden';
    _tutorBoxEarly.style.display = 'none';
    _tutorBoxEarly.classList.remove('tutorial-finish-step');
  }
  const _wrapperEarly = $('tutorialContentWrapper');
  if (_wrapperEarly) _wrapperEarly.style.display = 'none';
  document.body.classList.remove('tutorial-finish-step');
  // KILL-SWITCH class (2026-07): CSS force-hides #tutorBox for the whole
  // finish sequence — the box was reappearing mid iris-reveal via a late
  // JS reveal path. Removed at the end of this function.
  document.body.classList.add('tutorial-finish-anim');
  // Unpin the portaled tab-limit wrapper UNCONDITIONALLY. cleanupTutorialExtras
  // gates its unpin on currentStep ∉ {3,4} — correct mid-tutorial, but if the
  // user finishes/skips FROM a tab-limit step the wrapper would stay pinned
  // mid-screen on the live dashboard forever. (Also covers the early-return
  // data-mode path below.)
  pfUnpinTabLimitAfterTutorial();

  const modeStored = await chrome.storage.local.get(['dataCollectionMode', 'tutorialDataModeStepDone']);
  if (modeStored.dataCollectionMode !== 'local' && modeStored.dataCollectionMode !== 'standard') {
    // The data-mode step renders INSIDE the tutor box — release the
    // finish-anim kill-switch before showing it.
    document.body.classList.remove('tutorial-finish-anim');
    await showPostSigninDataModeStep();
    return;
  }
  cleanupTutorialExtras();
  clearTutorialHighlight();

  const skipFlags = await chrome.storage.local.get(['tutorialSkippedEver', 'tutorialSkipVideoShown']);
  const shouldShowSkipVideo = (skipFlags.tutorialSkippedEver === true || showTutorialSkipVideo === true)
    && skipFlags.tutorialSkipVideoShown !== true;

  const tutorBox = $('tutorBox');
  if (tutorBox) {
    // Re-apply defensively in case anything above (e.g. cleanupTutorialExtras)
    // toggled inline styles. Cheap and idempotent.
    tutorBox.style.opacity = '0';
    tutorBox.style.visibility = 'hidden';
    tutorBox.style.display = 'none';
    tutorBox.classList.remove('tutorial-finish-step');
    document.body.classList.remove('tutorial-finish-step');
  }

  if (playReveal) {
    $('tutorialContentWrapper').style.display = 'none';
    document.body.style.overflow = '';
    await new Promise((resolve) => setTimeout(resolve, 120));
    await playTutorialIrisReveal();
  }

  await chrome.storage.session.set({ tutorialActive: false });
  await chrome.runtime.sendMessage({ action: 'clearTutorialTimeout' }).catch(() => {});
  if (!playReveal) {
    document.body.style.overflow = '';
  }
  $('tutorialOverlay')?.classList.remove('active', 'revealed');
  $('tutorialOverlay').style.clipPath = '';
  $('tutorialOverlay').style.webkitClipPath = '';
  $('tutorialContentWrapper').style.display = 'none';
  document.body.classList.remove('tutorial-active');
  // SCROLL RESTORE (2026-07, user: "it won't let me scroll the dashboard
  // after finishing — I had to reload"): release EVERY scroll lock any
  // tutorial-era surface may have left behind — the Wrapped demo chest's
  // fullscreen-open class (html + body), plus inline overflow on both
  // roots. The finish animation is over; the dashboard must scroll.
  document.documentElement.classList.remove('pf-recap-fullscreen-open');
  document.body.classList.remove('pf-recap-fullscreen-open');
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
  // Finish sequence done — release the tutor-box kill-switch.
  document.body.classList.remove('tutorial-finish-anim');
  restoreTutorialDevChrome();
  setTutorialTimerFieldsLocked(false);
  postSigninMode = null;
  tutorialTabLimitConfirmClicked = false;
  // Advanced Settings lock (user spec 2026-07 v49): "should only happen
  // once when they finish the tutorial". Stamp pfTutorialFinishedAt ONLY
  // the first time — a Revert-Tutorial-then-refinish path (or any repeat
  // trip through this function) must NOT re-arm the countdown.
  const existingFinishStamp = await chrome.storage.local
    .get('pfTutorialFinishedAt')
    .then((r) => Number(r?.pfTutorialFinishedAt) || 0)
    .catch(() => 0);
  const finishStampWrite = existingFinishStamp > 0
    ? {}
    : { pfTutorialFinishedAt: Date.now() };
  await chrome.storage.local.set({
    tutorialCompleted: true,
    tutorialComplete: true,
    onboardingRequired: false,
    ...finishStampWrite
  });
  // Kick the lock sync so the countdown starts immediately and the row
  // switches to "Unlocks in 1min" without waiting for the next tick.
  try { void pfSyncAdvancedSettingsLock(); } catch (_) { /* best-effort */ }
  // Funnel event — theme_chosen sanitized to the two owned themes only.
  try {
    const themed = await chrome.storage.local.get(['selectedTheme', 'extensionInstallTime']);
    const theme = themed?.selectedTheme === 'notebook' ? 'notebook' : 'tutorial_background';
    const installed = Number(themed?.extensionInstallTime) || Date.now();
    const secondsToFinish = Math.max(0, Math.floor((Date.now() - installed) / 1000));
    void pfAnalyticsCapture('tutorial_completed', {
      seconds_to_finish: secondsToFinish,
      theme_chosen: theme
    });
  } catch (_) { /* best-effort */ }
  // Collapse the Reminders dropdown once the tutorial finishes (user spec
  // 2026-07 v8) — the tutorial forces it open so users see it, but the
  // finished dashboard should default to collapsed. Persist the setting
  // AND update the live DOM if the panel is currently mounted so the
  // collapse takes effect without a reload.
  try {
    const stored = await chrome.storage.local.get('unprodReminderSettings');
    const next = { ...(stored.unprodReminderSettings || {}), dropdownOpen: false };
    await chrome.storage.local.set({ unprodReminderSettings: next });
    const toggleEl = $('unprodReminderToggle');
    const panelEl = $('unprodReminderPanel');
    if (toggleEl) toggleEl.setAttribute('aria-expanded', 'false');
    if (panelEl) panelEl.style.display = 'none';
    const chev = toggleEl?.querySelector('.pf-reminder-chev');
    if (chev) chev.textContent = '▸';
  } catch (_) { /* best-effort collapse */ }
  await chrome.storage.local.remove([
    'tutorialState', 'lastTutorialStep', 'tutorialReachedStep14',
    'tutorialUserClickedProductive', 'tutorialNameConfirmed',
    'tutorialTabLimitConfirmed', 'tutorialTabLimitApplied',
    'tutorialCloserToggleCycleDone',
    'tutorialWipeTabTimesConfigured',
    'tutorialCustomizationsOpened', 'tutorialSelectedNotebook',
    'tutorialMockToggled', 'tutorialCommitTyped', 'wordsAddedInTutor', 'tabLimitConfirmedInTutor',
    'tutorialPinStepDone', 'tutorialDataModeStepDone', 'tutorialSkippedMain'
  ]);

  if (shouldShowSkipVideo) {
    showTutorialSkipVideoModal();
  }
  await updateRankingModeDemoVisibility();
  void refreshSettingDemoVisibility();
  await renderAuthUI();
  revealDashboardAtTop();
}

async function onTutorialSignInClick() {
  await persistTutorialStep(currentStep);
  await signIn();
}

function initTutorialInteractionHandlers() {
  $('tutorDataModeShare')?.addEventListener('click', (e) => {
    void completeTutorialDataModeChoice('standard', e);
  });
  // New Continue button — same behavior as clicking the Global card. Sits
  // below the recommended card so the flow is card → Continue rather than
  // "click one of two equally-weighted cards to commit."
  $('tutorDataModeContinue')?.addEventListener('click', (e) => {
    void completeTutorialDataModeChoice('standard', e);
  });
  // Manual classification link on the initial screen — takes the user
  // straight to the Enterprise-tier info screen. From there they can
  // either commit to Global, or drill deeper into the Manual explanation.
  $('tutorDataModeManualLink')?.addEventListener('click', () => {
    if (postSigninMode !== 'datamode') return;
    $('tutorTitle').innerText = 'Professional Privacy tier / Enterprise tier';
    showTutorDataModeGuide(true, 'enterprise-info');
    centerTutorBox();
  });
  // "Use manual classification" text link on the Enterprise screen — one
  // step deeper: shows the Manual explanation (animation + warning).
  $('tutorDataModeEnterpriseToManual')?.addEventListener('click', () => {
    if (postSigninMode !== 'datamode') return;
    $('tutorTitle').innerText = 'Manual classification';
    showTutorDataModeGuide(true, 'local-warning');
    centerTutorBox();
  });
  // Legacy #tutorDataModeLocal handler retained for the sub-flow's
  // internal navigation buttons that may still reference the ID.
  $('tutorDataModeLocal')?.addEventListener('click', () => {
    if (postSigninMode !== 'datamode') return;
    $('tutorTitle').innerText = 'Manual classification';
    showTutorDataModeGuide(true, 'no-sharing');
    centerTutorBox();
  });
  $('tutorDataModeNoSharingGlobal')?.addEventListener('click', (e) => {
    void completeTutorialDataModeChoice('standard', e);
  });
  $('tutorDataModeEnterprise')?.addEventListener('click', () => {
    if (postSigninMode !== 'datamode') return;
    $('tutorTitle').innerText = 'Professional Privacy tier / Enterprise tier';
    showTutorDataModeGuide(true, 'enterprise-info');
    centerTutorBox();
  });
  $('tutorDataModeLocalPath')?.addEventListener('click', () => {
    if (postSigninMode !== 'datamode') return;
    $('tutorTitle').innerText = 'Empty local database';
    showTutorDataModeGuide(true, 'local-warning');
    centerTutorBox();
  });
  // Back buttons removed from Enterprise + Local screens per user spec
  // (2026-07). If someone still wants to unwind, the extension's top-level
  // Skip Tutorial / Next controls stay available.
  $('tutorDataModeEnterpriseGlobal')?.addEventListener('click', (e) => {
    void completeTutorialDataModeChoice('standard', e);
  });
  $('tutorDataModeEnterpriseWait')?.addEventListener('click', () => {
    if (postSigninMode !== 'datamode') return;
    $('tutorTitle').innerText = 'Empty local database';
    showTutorDataModeGuide(true, 'local-warning');
    centerTutorBox();
  });
  $('tutorDataModeLocalGlobal')?.addEventListener('click', (e) => {
    void completeTutorialDataModeChoice('standard', e);
  });
  $('tutorDataModeLocalConfirm')?.addEventListener('click', (e) => {
    void completeTutorialDataModeChoice('local', e);
  });

  document.addEventListener('keydown', async (e) => {
    if (!isCommitTypingStep(currentStep)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = TUTORIAL_COMMIT_TARGET;
    if (tutorialCommitProgress >= target.length) return;
    if (e.key === 'Backspace') {
      tutorialCommitProgress = Math.max(0, tutorialCommitProgress - 1);
      renderTutorialCommitPlaceholder();
      await chrome.storage.local.set({ tutorialCommitTyped: false });
      await updateTutorNextState();
      return;
    }
    const isSpaceKey = e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar';
    if (isSpaceKey) {
      // Never count spaces toward progress.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key.length !== 1) return;
    const typed = e.key;
    let idx = tutorialCommitProgress;
    while (target[idx] === ' ') idx += 1;
    if (idx >= target.length || typed.toLowerCase() !== target[idx].toLowerCase()) {
      shakeTutorialCommitPlaceholder();
      return;
    }
    tutorialCommitProgress = idx + 1;
    renderTutorialCommitPlaceholder();
    const done = tutorialCommitProgress >= target.length;
    await chrome.storage.local.set({ tutorialCommitTyped: done });
    await updateTutorNextState();
    // Confirmation feedback on completion — same "Great. Click Next..."
    // pattern used on earlier tutorial steps.
    if (done) {
      const textEl = $('tutorText');
      if (textEl) textEl.innerText = 'Great. Now click Next to move on.';
    }
  });
  const demoCard = $('pf-tutorial-demo-card')?.querySelector('.demo-card-inner');
  $('pfTutorialDemoProductive')?.addEventListener('click', async (e) => {
    triggerTutorialDemoRipple(demoCard, e.currentTarget);
    tutorialUserClickedProductive = true;
    if (currentStep === 1) {
      const textEl = $('tutorText');
      if (textEl) {
        textEl.innerText = "Great. Click Next to move on.";
      }
    }
    await chrome.storage.local.set({ tutorialUserClickedProductive: true });
    await updateTutorNextState();
  });
  $('pfTutorialDemoUnproductive')?.addEventListener('click', (e) => {
    triggerTutorialDemoRipple(demoCard, e.currentTarget);
    const note = $('tutorProgressNote');
    if (note) {
      note.style.display = 'block';
      note.innerText = 'Try Productive instead, this is just a demo.';
    }
  });

  $('enforcerToggle')?.addEventListener('change', async (e) => {
    if (currentStep !== 7) return;
    const isOn = e.target.checked === true;
    const textEl = $('tutorText');
    if (isOn) {
      tutorialStep8SawOn = true;
      if (textEl) textEl.innerText = 'Good, now switch it off.';
      await chrome.storage.local.set({ tutorialCloserToggleCycleDone: false });
    } else if (tutorialStep8SawOn) {
      if (textEl) textEl.innerText = 'Great. Now click Next to move on.';
      await chrome.storage.local.set({ tutorialCloserToggleCycleDone: true });
      await updateTutorNextState();
    }
    requestAnimationFrame(() => tutorialRepositionBox?.());
  });

  const mockBtn = $('pfTutorialMockIndicatorBtn');
  const mockStack = mockBtn?.closest('.pf-btn-stack');
  const mockRing = $('pfTutorialMockProgressRing');
  const mockCountdown = $('pfTutorialMockCountdown');
  const mockSpinAccent = $('pfTutorialMockSpinAccent');
  if (mockBtn && mockRing && mockCountdown && mockStack) {
    const HOLD_ON_MS = 2000;
    const HOLD_OFF_MS = 5000; // matches closer_indicator.js (reverted to 5s per user spec 2026-07 v2)
    const RING_GREEN = '#8fd41a';
    const RING_GREEN_HI = '#a3e635';
    const RING_GRAY = '#5c6570';
    const RING_GRAY_HI = '#727c88';
    const RING_TRACK_DARK = '#1f2d26';
    let holdStartTime = 0;
    let holdRafId = null;
    let holdCompleted = false;
    let holdDirection = 'on';
    let holdDuration = HOLD_ON_MS;

    const applyMockCenterPuck = () => {
      mockBtn.style.background = 'radial-gradient(circle at 38% 32%, #2a313a 0%, #12151a 72%)';
      mockBtn.style.boxShadow = 'inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -2px 3px rgba(0,0,0,0.55)';
      mockBtn.style.border = 'none';
    };

    const clearMockRing = () => {
      mockRing.classList.remove('pf-visible', 'pf-done', 'rotating-unprod');
      mockRing.style.background = '';
    };

    const paintMockOnRing = () => {
      applyMockCenterPuck();
      mockRing.classList.remove('pf-done', 'rotating-unprod');
      mockRing.classList.add('pf-visible');
      mockRing.style.background = `
        conic-gradient(
          from 0deg,
          ${RING_GREEN_HI} 0deg,
          ${RING_GREEN} 120deg,
          ${RING_GREEN_HI} 240deg,
          ${RING_GREEN} 360deg)
      `;
    };

    const paintMockHoldRing = (fraction) => {
      const angle = Math.max(0, Math.min(1, fraction)) * 360;
      applyMockCenterPuck();
      mockRing.classList.add('pf-visible');
      mockRing.style.background = `
        conic-gradient(
          from 0deg,
          ${RING_GRAY} 0deg,
          ${RING_GRAY_HI} ${angle * 0.45}deg,
          ${RING_GRAY} ${angle}deg,
          ${RING_TRACK_DARK} ${angle}deg,
          ${RING_TRACK_DARK} 360deg)
      `;
    };

    const renderMockState = () => {
      mockBtn.classList.toggle('pf-on', tutorialMockIsOn);
      mockBtn.classList.toggle('pf-off', !tutorialMockIsOn);
      mockBtn.classList.remove('pf-holding');
      mockStack.classList.remove('pf-holding');
      mockBtn.style.transform = '';
      clearMockRing();
      mockCountdown.classList.remove('pf-visible');
      mockCountdown.textContent = '';
      if (mockSpinAccent) {
        mockSpinAccent.classList.remove('pf-visible', 'rotating-unprod', 'rotating-study');
      }
      if (tutorialMockIsOn) {
        paintMockOnRing();
      }
      mockBtn.title = tutorialMockIsOn ? 'Closer is ON, hold 5s to turn OFF' : 'Closer is OFF, hold 2s to turn ON';
    };

    const animateOnHold = (fraction) => {
      paintMockHoldRing(fraction);
      mockBtn.style.transform = `scale(${0.94 + 0.06 * fraction})`;
      const seconds = Math.min(2, Math.floor(fraction * 2) + 1);
      mockCountdown.textContent = String(seconds);
      mockCountdown.classList.add('pf-visible');
    };

    const animateOffHold = (fraction) => {
      paintMockHoldRing(fraction);
      mockBtn.style.transform = `scale(${1 - 0.06 * fraction})`;
      // Countdown was hardcoded to start at 7 while HOLD_OFF_MS actually
      // completes in 5s — the visible number lied. Count down from 5 so
      // it matches the real hold duration (user spec 2026-07).
      const seconds = Math.max(1, Math.ceil(5 - fraction * 5));
      mockCountdown.textContent = String(seconds);
      mockCountdown.classList.add('pf-visible');
    };

    const cancelHold = () => {
      if (holdRafId) cancelAnimationFrame(holdRafId);
      holdRafId = null;
      holdCompleted = false;
      renderMockState();
    };

    const runHoldAnimation = async () => {
      const elapsed = Date.now() - holdStartTime;
      const fraction = Math.min(1, elapsed / holdDuration);
      if (holdDirection === 'off') {
        animateOffHold(fraction);
      } else {
        animateOnHold(fraction);
      }
      if (fraction >= 1) {
        holdCompleted = true;
        holdRafId = null;
        tutorialMockIsOn = !tutorialMockIsOn;
        renderMockState();
        await syncEnforcerToggleLimits(tutorialMockIsOn, { persist: currentStep !== 8 });
        if (currentStep === 8) {
          const textEl = $('tutorText');
          if (tutorialMockIsOn && tutorialMockStage === 1) {
            tutorialStep9SawOn = true;
            tutorialMockStage = 2;
            // Stop the purple pulse the moment the user successfully
            // completes the first hold. Belt + braces: (1) set the
            // module flag so applyTutorialFloatingButtonHighlight
            // re-adds pf-pulse-done on any later stack swap, (2) add
            // pf-pulse-done to the current stack, (3) add a global body
            // class that unconditionally kills the pulse on ANY future
            // tutorial mock stack — proof against re-renders.
            tutorialStep9BtnPulseStopped = true;
            document.body.classList.add('pf-step9-pulse-off');
            try {
              document.querySelectorAll('.pf-btn-stack.pf-tutorial-btn-glow').forEach((el) => {
                el.classList.add('pf-pulse-done');
              });
            } catch (_) {}
            if (textEl) textEl.innerText = "Good job. This means you don't have to open the dashboard to turn on the toggle.\n\nNow to turn it OFF, hold for 5 seconds.";
          } else if (!tutorialMockIsOn && tutorialStep9SawOn && tutorialMockStage === 2) {
            tutorialMockStage = 3;
            ensureTutorialMockIndicator(false);
            ensureTutorialTimerMock(true);
            startTutorialTimerMockDemo();
            requestAnimationFrame(() => refreshTutorialStep9Layout());
            if (textEl) {
              textEl.innerText = "Once a timer is running, the button cannot be turned off by holding it. Go to the dashboard to stop or pause timers while they're active.\n\nGood job. Now press Next.";
            }
            if (tutorialMockStageTimer) {
              clearTimeout(tutorialMockStageTimer);
              tutorialMockStageTimer = null;
            }
            // Stop the pulse animation once the user has clicked the button.
            try {
              const glowEl = document.querySelector('.pf-btn-stack.pf-tutorial-btn-glow');
              if (glowEl) glowEl.classList.add('pf-pulse-done');
            } catch (_) {}
            tutorialMockStage = 4;
            await chrome.storage.local.set({ tutorialMockToggled: true });
            await updateTutorNextState();
          }
          await updateTutorNextState();
        }
        return;
      }
      holdRafId = requestAnimationFrame(() => { void runHoldAnimation(); });
    };

    const startHold = (e) => {
      if (e) e.preventDefault();
      holdStartTime = Date.now();
      holdCompleted = false;
      holdDirection = tutorialMockIsOn ? 'off' : 'on';
      holdDuration = holdDirection === 'off' ? HOLD_OFF_MS : HOLD_ON_MS;
      mockStack.classList.add('pf-holding');
      // Kill the purple pulse the INSTANT the user touches / clicks the
      // button — no waiting for the hold to complete. Per user report
      // 2026-07. The body class is the strongest kill switch (see the
      // pf-step9-pulse-off CSS rule); we also add pf-pulse-done for
      // belt-and-braces in case some path re-toggles the body class.
      if (currentStep === 8) {
        tutorialStep9BtnPulseStopped = true;
        document.body.classList.add('pf-step9-pulse-off');
        try {
          document.querySelectorAll('.pf-btn-stack.pf-tutorial-btn-glow').forEach((el) => {
            el.classList.add('pf-pulse-done');
          });
        } catch (_) { /* best-effort */ }
      }
      if (holdRafId) cancelAnimationFrame(holdRafId);
      holdRafId = null;
      void runHoldAnimation();
    };

    const endHold = () => {
      if (holdCompleted) return;
      cancelHold();
    };

    mockStack.addEventListener('mousedown', startHold);
    mockStack.addEventListener('mouseup', endHold);
    mockStack.addEventListener('mouseleave', endHold);
    mockStack.addEventListener('touchstart', startHold, { passive: false });
    mockStack.addEventListener('touchend', endHold);
    mockStack.addEventListener('touchcancel', endHold);
    renderMockState();
  }

  $('customizationsTab')?.addEventListener('click', async () => {
    if (currentStep !== 11) return;
    await chrome.storage.local.set({ tutorialCustomizationsOpened: true });
    const stored = await chrome.storage.local.get('selectedTheme');
    syncTutorialTutorFontFromTheme(stored.selectedTheme || 'tutorial_background', 11);
    await updateTutorNextState();
  });
}

async function advanceTutorialSkipToClassifierStep() {
  await chrome.storage.local.set({
    tutorialPinStepDone: true,
    tutorialReachedStep14: true
  });
  await showPostSigninDataModeStep();
}

async function recordTutorialSkipped({ showVideoNow = false, onVideoDismiss } = {}) {
  await chrome.storage.local.set({
    tutorialSkippedMain: true,
    tutorialSkippedEver: true,
    // v19 (user spec): once the user clicks Skip AT ANY STAGE, the
    // "you skipped the tutorial" video must show at the end no matter
    // how they finish (they might click skip, then still go through
    // sign-in / post-signin cards). tutorialSkippedEver already lives
    // across runs, but we also clear tutorialSkipVideoShown here so a
    // stale "already shown" flag from a previous cycle can't suppress
    // the video the next time finishTutorial runs.
    tutorialSkipVideoShown: false
  });
  // Funnel event: at which step did the user bail?
  try { void pfAnalyticsCapture('tutorial_skipped', { at_step: currentStep }); } catch (_) {}
  const { tutorialSkipVideoShown } = await chrome.storage.local.get('tutorialSkipVideoShown');
  if (tutorialSkipVideoShown === true) {
    if (onVideoDismiss) await onVideoDismiss();
    return;
  }
  if (showVideoNow) {
    showTutorialSkipVideoModal({ onDismiss: onVideoDismiss });
    return;
  }
  if (onVideoDismiss) await onVideoDismiss();
}

async function onTutorialSkipClick() {
  const signInStepIdx = steps.length - 1;

  if (postSigninMode === 'pin') {
    // v20 (user spec): the "you skipped the tutorial" video must ONLY
    // show AFTER the final iris-reveal animation at the true end of
    // the tutorial, never mid-flow. Previously skipping at the pin step
    // popped the video immediately and then advanced to the classifier
    // step — now we defer: mark the skip, silently advance to the
    // classifier step, and let finishTutorial pop the video after the
    // reveal once they hit the actual finish.
    await recordTutorialSkipped({ showVideoNow: false });
    await advanceTutorialSkipToClassifierStep();
    return;
  }

  if (postSigninMode === 'finish') {
    await recordTutorialSkipped({ showVideoNow: false });
    await finishTutorial({ playReveal: true, showTutorialSkipVideo: true });
    return;
  }

  if (postSigninMode === 'datamode') {
    return;
  }

  if (currentStep >= signInStepIdx) return;

  const confirmed = window.confirm(
    "Are you sure? There is a lot of very important information in this tutorial. I promise it's worth your time."
  );
  if (!confirmed) return;

  await recordTutorialSkipped({ showVideoNow: false });
  await showStep(signInStepIdx);
}

function hideTutorialSkipVideoModal() {
  const modal = $('pfTutorialSkipVideoModal');
  const wrap = $('pfSkipVideoWrap');
  if (!modal) return;
  modal.classList.remove('is-visible');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const iframe = wrap?.querySelector('iframe');
  if (iframe) iframe.remove();
  void chrome.storage.local.set({ tutorialSkipVideoShown: true });
  const dismissCallback = tutorialSkipVideoDismissCallback;
  tutorialSkipVideoDismissCallback = null;
  if (dismissCallback) {
    Promise.resolve(dismissCallback()).catch((err) => {
      console.warn('[pf-tutor] skip video dismiss callback failed', err);
    });
  }
}

function showTutorialSkipVideoModal(options = {}) {
  tutorialSkipVideoDismissCallback = typeof options.onDismiss === 'function' ? options.onDismiss : null;
  const modal = $('pfTutorialSkipVideoModal');
  const wrap = $('pfSkipVideoWrap');
  const placeholder = $('pfSkipVideoPlaceholder');
  if (!modal || !wrap) return;

  wrap.querySelector('iframe')?.remove();
  // Old fallback link may live inside the wrap (old layout) or as a sibling
  // (new layout, below the wrap). Clean both.
  wrap.querySelector('.pf-skip-video-fallback')?.remove();
  wrap.parentElement?.querySelector(':scope > .pf-skip-video-fallback')?.remove();
  if (TUTORIAL_SKIP_YOUTUBE_VIDEO_ID) {
    if (placeholder) placeholder.hidden = true;
    const iframe = document.createElement('iframe');
    // Minimal nocookie embed — no &origin param (let YouTube infer from
    // the spoofed Referer/Origin headers the DNR rule injects). Extra params
    // were tripping the integrity check in some cases. DNR + referrerpolicy
    // is doing the real work of satisfying YouTube's origin validation.
    iframe.src = `https://www.youtube-nocookie.com/embed/${TUTORIAL_SKIP_YOUTUBE_VIDEO_ID}?rel=0&modestbranding=1&playsinline=1`;
    iframe.title = 'How to use >=PlayingFild';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.frameBorder = '0';
    iframe.setAttribute('frameborder', '0');
    // Explicit native dimensions so YouTube renders the thumbnail at 16:9
    // intended size; CSS then scales the iframe down to fit the wrap exactly
    // without zooming the thumbnail.
    iframe.setAttribute('width', '1280');
    iframe.setAttribute('height', '720');
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    wrap.appendChild(iframe);

    // "Watch on YouTube" fallback link — moved OUTSIDE the wrap so it sits
    // below the player instead of overlaying the thumbnail.
    const fallback = document.createElement('a');
    fallback.className = 'pf-skip-video-fallback';
    fallback.href = `https://www.youtube.com/watch?v=${TUTORIAL_SKIP_YOUTUBE_VIDEO_ID}`;
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.textContent = 'Trouble loading? Watch on YouTube ↗';
    fallback.style.cssText = 'display:block;text-align:center;font-size:0.85em;color:#6b7280;text-decoration:none;margin-top:8px;';
    wrap.parentElement?.insertBefore(fallback, wrap.nextSibling);
  } else if (placeholder) {
    placeholder.hidden = false;
  }

  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  modal.classList.add('is-visible');
  document.body.style.overflow = 'hidden';
  $('pfSkipVideoGotIt')?.focus();
}

function initTutorialSkipVideoModal() {
  const dismiss = () => hideTutorialSkipVideoModal();
  $('pfSkipVideoDismiss')?.addEventListener('click', dismiss);
  $('pfSkipVideoGotIt')?.addEventListener('click', dismiss);
  $('pfSkipVideoBackdrop')?.addEventListener('click', dismiss);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('pfTutorialSkipVideoModal')?.classList.contains('is-visible')) {
      dismiss();
    }
  });
}

function isDashboardTabForLimit(tab) {
  const u = tab?.url || '';
  const pending = tab?.pendingUrl || '';
  return u.includes('stats.html') || pending.includes('stats.html');
}

function tabCountsTowardTabLimitForDashboard(tab) {
  return tabCountsTowardTabLimitShared(tab, { isDashboardTab: isDashboardTabForLimit });
}

// DIRECT tab-limit close (user report 2026-07: "step 5 is still not removing
// the tab limit down to there… nothing happens till the user signs in").
//
// The worker's enforceTabLimit path has many gates that silently no-op before
// sign-in (window-name cold-start, tutorial-active, the requestEviction
// chokepoint). For the tutorial Step-5 Confirm the user has JUST consented to
// closing their overflow tabs, so this function closes them DIRECTLY from the
// dashboard — it never consults the worker, sign-in, classification, or any
// gate. It runs in the dashboard page which holds the `tabs` permission
// (manifest.json) and can call chrome.tabs.remove itself.
//
// Keep policy: lowest-engagement first is impractical here (the dashboard has
// no telemetry), so we use the worker's final tiebreaker — rightmost tabs
// close first, leftmost N stay — which also matches the user's "all but my
// first N tabs" mental model.
async function closeExcessTabsDirectly(windowId, rawLimit) {
  const limit = Math.max(1, Math.min(Number(rawLimit) || 5, MAX_TAB_LIMIT));
  const tabs = await chrome.tabs.query({ windowId });
  // Re-get each so pendingUrl/title are current (mirrors countExcessTabsForWindow).
  const fresh = await Promise.all(
    tabs.map((t) => (t?.id != null ? chrome.tabs.get(t.id).catch(() => t) : Promise.resolve(t)))
  );
  const selfTab = await chrome.tabs.getCurrent?.().catch(() => null);
  const countable = fresh.filter((t) => tabCountsTowardTabLimitForDashboard(t));
  if (countable.length <= limit) {
    console.info('[pf-confirm-direct] no overflow', { count: countable.length, limit });
    return { closedCount: 0, remaining: countable.length };
  }
  const overflowCount = countable.length - limit;
  // Rightmost (highest index) first — keep the earlier/leftmost tabs.
  const sorted = [...countable].sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
  let closed = 0;
  let issued = 0;
  for (const tab of sorted) {
    if (closed >= overflowCount) break;
    if (issued >= sorted.length) break;
    issued += 1;
    // Hard safety skips — never close these even if the filter missed them.
    if (!tab || tab.id == null) continue;
    if (isDashboardTabForLimit(tab)) continue;          // never close a dashboard tab
    if (tab.id === selfTab?.id) continue;                // never close ourselves
    if (tab.pinned) continue;                            // respect pinned tabs
    if (tab.active) continue;                            // respect the focused tab
    await chrome.tabs.remove(tab.id).catch((e) => {
      console.info('[pf-confirm-direct] remove declined', { tabId: tab.id, error: e?.message || String(e) });
    });
    closed += 1;
  }
  console.info('[pf-confirm-direct] closed overflow tabs', { closed, overflowCount, limit });
  return { closedCount: closed, remaining: countable.length - closed };
}

async function countExcessTabsForWindow(windowId, tabLimit) {
  const resp = await chrome.runtime.sendMessage({
    action: 'previewTabLimitOverflow',
    windowId,
    tabLimit
  }).catch(() => null);
  if (resp?.success) return Math.max(0, Number(resp.overflowCount) || 0);
  const tabs = await chrome.tabs.query({ windowId });
  const freshTabs = await Promise.all(
    tabs.map((t) => (t?.id != null ? chrome.tabs.get(t.id).catch(() => t) : Promise.resolve(t)))
  );
  const counted = freshTabs.filter((t) => tabCountsTowardTabLimitForDashboard(t));
  return Math.max(0, counted.length - tabLimit);
}

let tabLimitSkipConfirmResolver = null;

function hideTabLimitSkippedUserConfirm() {
  const modal = $('pfTabLimitSkipConfirmModal');
  if (!modal) return;
  modal.classList.remove('is-visible');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

function showTabLimitSkippedUserConfirm(excessCount) {
  return new Promise((resolve) => {
    const modal = $('pfTabLimitSkipConfirmModal');
    const countEl = $('pfTabLimitSkipConfirmCount');
    if (!modal || !countEl) {
      resolve(true);
      return;
    }
    countEl.textContent = String(excessCount);
    tabLimitSkipConfirmResolver = resolve;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('is-visible');
    $('pfTabLimitSkipConfirmProceed')?.focus();
  });
}

function initTabLimitSkipConfirmModal() {
  const finish = (proceed) => {
    hideTabLimitSkippedUserConfirm();
    const resolver = tabLimitSkipConfirmResolver;
    tabLimitSkipConfirmResolver = null;
    if (resolver) resolver(proceed);
  };
  $('pfTabLimitSkipConfirmCancel')?.addEventListener('click', () => finish(false));
  $('pfTabLimitSkipConfirmProceed')?.addEventListener('click', () => finish(true));
  $('pfTabLimitSkipConfirmBackdrop')?.addEventListener('click', () => finish(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('pfTabLimitSkipConfirmModal')?.classList.contains('is-visible')) {
      finish(false);
    }
  });
}

async function applyTabLimitConfirm(win, tabLimit, tutorialIncomplete, confirmBtn) {
  // BOX-ANCHOR MUTE (user report 2026-07: "the text box does something
  // weird and moves down to the bottom left for a second"): clicking Confirm
  // swaps the confirm button to its green "applied" state AND rewrites
  // #tutorText to "Applied. Click Next to move on." — both change the
  // measured rect of #tabLimitWrapper. The step's continuously-running RAF
  // reposition loop sees that rect change and calls setTutorTarget(…,
  // { animate: true }), so the box visibly glides to its recomputed coords
  // (often toward the bottom-left when the now-shorter text reshuffles the
  // beside-target fit) before settling back. Muting repositioning for the
  // duration of the confirm feedback keeps the box pinned where the user
  // just clicked. Same primitive the theme-swap path uses; restored below.
  const priorMuteUntil = pfTutorRepositionMuteUntil;
  pfTutorRepositionMuteUntil = Date.now() + 1400;
  if (confirmBtn) {
    confirmBtn.classList.add('tutorial-active-green');
    confirmBtn.classList.remove('tutorial-pulse');
    confirmBtn.style.animation = 'none';
  }
  console.info('[pf-confirm] sending saveWindowConfig with updates:', { tabLimit });
  const confirmSaveResp = await chrome.runtime.sendMessage({ action: 'saveWindowConfig', windowId: win.id, updates: { tabLimit } });
  console.info('[pf-confirm] saveWindowConfig response received', confirmSaveResp);
  const tutorialState = await chrome.storage.local.get(['tutorialCompleted', 'tutorialComplete']);
  if (tutorialState.tutorialCompleted === true || tutorialState.tutorialComplete === true) {
    console.warn('[pf-savewindow-call] confirmTabLimit tutorial follow-up saveWindowConfig', { windowId: win.id, updates: { tabLimit } });
    await chrome.runtime.sendMessage({ action: 'saveWindowConfig', windowId: win.id, updates: { tabLimit } });
  }
  $('tabUpdateTick').style.opacity = '1';
  setTimeout(() => $('tabUpdateTick').style.opacity = '0', 1500);
  // ORDER MATTERS (user report 2026-07: step-5 Confirm didn't remove tabs):
  // write tutorialTabLimitApplied BEFORE asking the worker to sweep, so any
  // enforcement path that checks the flag (tab-create events racing the
  // confirm, SW-side gating) sees it as applied. Then AWAIT the sweep so
  // the overflow tabs — including unanalysable ones (chrome://, still-
  // loading, crashed) — visibly close on the click, not "sometime later".
  // ANY successful Confirm means the user consciously applied a tab limit —
  // set the applied flag unconditionally. Previously this only happened at
  // tutorial step 4, so after "Revert Tutorial" (which wipes the flag) a
  // post-revert Confirm swept once but ongoing enforcement stayed disabled
  // ("Tutorial active") — limit 5 yet 6 tabs stayed open.
  await chrome.storage.local.set({ tutorialTabLimitApplied: true });
  if (tutorialIncomplete && currentStep === 4) {
    tutorialTabLimitConfirmClicked = true;
    confirmBtn?.classList.remove('tutorial-pulse');
    // Confirmation feedback — matches the pattern used on the earlier
    // tutorial steps ("Great. Click Next to move on.").
    const textEl = $('tutorText');
    if (textEl) textEl.innerText = 'Applied. Click Next to move on.';
    updateTutorialTabLimitControls();
    updateTutorNextState();
  } else if (!tutorialIncomplete) {
    renderedTabLimit = tabLimit;
    updateTutorialTabLimitControls();
  }
  try {
    // BULLETPROOF DIRECT CLOSE (user report 2026-07: "step 5 is still not
    // removing the tab limit down to there… I think it's because nothing
    // happens till the user signs in"). Close the overflow tabs DIRECTLY from
    // the dashboard — this is "the one thing that happens when they click
    // confirm." It bypasses every worker gate (sign-in, tutorial-active,
    // window-name cold-start, requestEviction chokepoint) because the user
    // has just consented by clicking Confirm. See closeExcessTabsDirectly.
    const direct = await closeExcessTabsDirectly(win.id, tabLimit);
    console.info('[pf-confirm] direct close result', direct);

    // Best-effort worker sync: tell the SW to run its own enforcement so its
    // bookkeeping (analytics, focus-retargeting, reorder) stays consistent.
    // If the direct close already handled everything this reports 0 closes
    // and returns immediately. If the direct close was blocked (e.g. all
    // remaining overflow tabs are pinned/active/dashboard), the worker gets
    // a chance with its richer engagement sort. Failures here are harmless —
    // the tabs are already closed from the direct path.
    try {
      await chrome.runtime.sendMessage({
        action: 'enforceTabLimitNow',
        windowId: win.id
      });
    } catch (e) {
      console.info('[pf-confirm] worker sync sweep skipped', e?.message || String(e));
    }
    // If the direct path closed nothing AND there's still overflow, retry the
    // direct close once after a short settle (covers the rare case where a
    // tab was mid-navigation at click time and reported a stale count).
    if (!(direct?.closedCount > 0)) {
      const stillOver = await countExcessTabsForWindow(win.id, tabLimit);
      if (stillOver > 0) {
        await new Promise((r) => setTimeout(r, 300));
        const retry = await closeExcessTabsDirectly(win.id, tabLimit);
        console.info('[pf-confirm] direct close retry', retry);
      }
    }
  } catch (e) {
    console.warn('[pf-confirm] tab-limit close failed', e);
  } finally {
    // Release the box-anchor mute set at the top of this function. Restore
    // the prior value if a longer mute (e.g. an overlapping theme swap) was
    // already in flight; otherwise clear it so the box can re-seat on real
    // layout changes from here on.
    pfTutorRepositionMuteUntil = Math.max(priorMuteUntil, 0);
  }
}

// ── Tab-limit hard max (10) with an honest popup (user spec 2026-07) ───────
// Typing anything above 10 clamps the field and pops a gentle explainer:
// 10 is the ceiling, it's more manageable than it sounds, and — highlighted
// in red — which tabs get kept. Works on the dashboard AND on the tutorial
// tab-limit steps (same input).
function pfShowTabLimitMaxPopup(keptCount) {
  void keptCount; // arg kept for call-site compat; "keep N tabs" line removed v22
  document.getElementById('pfTabLimitMaxPopup')?.remove();
  const anchor = $('maxTabLimit');
  if (!anchor) return;
  const card = document.createElement('div');
  card.id = 'pfTabLimitMaxPopup';
  card.setAttribute('role', 'alertdialog');
  card.style.cssText = 'position:fixed;z-index:2147483000;width:290px;padding:14px 16px;'
    + 'border-radius:12px;background:#fff;border:1px solid #d8d0f0;'
    + 'box-shadow:0 18px 44px rgba(36,26,68,0.35);font-size:0.88em;line-height:1.5;color:#2a2438;';
  const msg = document.createElement('p');
  msg.style.cssText = 'margin:0 0 10px;';
  // Reworded copy 2026-07 v22, em-dash removed v23.
  msg.textContent = "This might feel weird but we've capped the tab limit at 10. "
    + "It sounds tight, but give it a few days. You'll stop noticing the cap "
    + "is even there.";
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Got it';
  ok.style.cssText = 'padding:7px 14px;border:none;border-radius:8px;cursor:pointer;'
    + 'background:#5B4B9F;color:#fff;font-weight:700;font-size:0.9em;';
  ok.addEventListener('click', () => card.remove());
  card.appendChild(msg);
  card.appendChild(ok);
  document.body.appendChild(card);
  // Anchor near the input, clamped to the viewport.
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  card.style.left = `${Math.max(12, Math.min(vw - 302, r.left - 120))}px`;
  card.style.top = `${Math.min(window.innerHeight - 180, r.bottom + 10)}px`;
  setTimeout(() => { document.getElementById('pfTabLimitMaxPopup')?.remove(); }, 14000);
}

function bindTabLimitMaxGuard() {
  const input = $('maxTabLimit');
  if (!input || input.dataset.maxGuardBound === '1') return;
  input.dataset.maxGuardBound = '1';
  const guard = () => {
    const raw = parseInt(input.value, 10);
    if (Number.isFinite(raw) && raw > MAX_TAB_LIMIT) {
      input.value = String(MAX_TAB_LIMIT);
      pfShowTabLimitMaxPopup(MAX_TAB_LIMIT);
    }
  };
  input.addEventListener('input', guard);
  input.addEventListener('change', guard);
}
bindTabLimitMaxGuard();

initTutorialInteractionHandlers();
initTutorialSkipVideoModal();
initTabLimitSkipConfirmModal();
bindRevertTutorialButton();

window.addEventListener('pagehide', () => {
  if (!document.body.classList.contains('tutorial-active')) return;
  void persistTutorialProgressOnClose();
});

if ($('tutorSkip')) $('tutorSkip').onclick = () => { void onTutorialSkipClick(); };
if ($('tutorNext')) $('tutorNext').onclick = async () => {
  if (isCommitTypingStep(currentStep) && tutorialCommitProgress < TUTORIAL_COMMIT_TARGET.length) {
    shakeTutorialCommitPlaceholder();
    return;
  }
  if (postSigninMode === 'pin') {
    await chrome.storage.local.set({ tutorialPinStepDone: true });
    await showPostSigninDataModeStep();
    return;
  }
  if (postSigninMode === 'finish' || currentStep >= TUTORIAL_MAIN_STEPS) {
    // Completed normally → NO skip video (user report 2026-07: fresh
    // installs who FINISHED the tutorial were greeted with "Watch this
    // video because you skipped the tutorial"). The modal only appears
    // when the user actually clicked Skip at some point — that's the
    // tutorialSkippedEver flag, which finishTutorial checks on its own.
    await finishTutorial({ playReveal: true });
    return;
  }
  if (currentStep < steps.length - 1) showStep(currentStep + 1);
};
$('tutorSignIn')?.addEventListener('click', () => { void onTutorialSignInClick(); });

// Profile "Sign in" button → land directly on the sign-in step (per user
// spec 2026-07). Other call sites (e.g. tutorial signin step) keep the
// default landing which shows the create-account form first.
$('dashboardSignInBtn')?.addEventListener('click', () => { void signIn({ landOnSignin: true }); });
$('headerSignOutBtn')?.addEventListener('click', () => { void signOut(); });

let autoCloseCandidateSince = 0;
let autoCloseTimerId = null;
const AUTO_CLOSE_STABILITY_MS = 1800;
const AUTO_CLOSE_POLL_MS = 300;

function isAutoCloseDashboardEnabled() {
  const checkbox = $('autoCloseDashboard');
  if (checkbox) return checkbox.checked;
  return false; // Default OFF — user must opt in.
}

/**
 * Wire the "Send anonymous product analytics" toggle in Profile → Settings.
 * ON by default; user can opt out at any time. Persisted via chrome.storage
 * local key pfAnalyticsOptOut (owned by analytics.js).
 */
async function bindAnalyticsOptOutToggle() {
  const toggle = document.getElementById('pfAnalyticsEnabledToggle');
  if (!toggle || toggle.dataset.pfBound === '1') return;
  toggle.dataset.pfBound = '1';
  try {
    const { pfAnalyticsOptOut: current } = await chrome.storage.local.get('pfAnalyticsOptOut');
    toggle.checked = current !== true;
  } catch (_) { toggle.checked = true; }
  toggle.addEventListener('change', async () => {
    try {
      if (toggle.checked) await pfAnalyticsOptIn();
      else await pfAnalyticsOptOut();
    } catch (err) {
      console.warn('[pf-analytics] toggle failed', err);
    }
  });
}

/**
 * Wrapped Notifications preference toggles (user spec 2026-07): three
 * checkboxes in the profile → "Wrapped Notifications" tab controlling
 * which Chrome notifications fire when a fresh Daily / Weekly / Monthly
 * recap lands. Defaults: daily=false (fires every day, would nag),
 * weekly=true, monthly=true. Stored under pfWrappedNotifPrefs; the
 * worker reads this before firing each kind.
 */
const PF_WRAPPED_NOTIF_DEFAULTS = { daily: false, weekly: true, monthly: true };
async function bindWrappedNotifToggles() {
  const daily = document.getElementById('pfWrappedNotifDaily');
  const weekly = document.getElementById('pfWrappedNotifWeekly');
  const monthly = document.getElementById('pfWrappedNotifMonthly');
  if (!daily || !weekly || !monthly) return;
  if (daily.dataset.pfBound === '1') return;
  daily.dataset.pfBound = weekly.dataset.pfBound = monthly.dataset.pfBound = '1';
  try {
    const { pfWrappedNotifPrefs } = await chrome.storage.local.get('pfWrappedNotifPrefs');
    const prefs = { ...PF_WRAPPED_NOTIF_DEFAULTS, ...(pfWrappedNotifPrefs || {}) };
    daily.checked = prefs.daily === true;
    weekly.checked = prefs.weekly === true;
    monthly.checked = prefs.monthly === true;
  } catch (_) {
    daily.checked = PF_WRAPPED_NOTIF_DEFAULTS.daily;
    weekly.checked = PF_WRAPPED_NOTIF_DEFAULTS.weekly;
    monthly.checked = PF_WRAPPED_NOTIF_DEFAULTS.monthly;
  }
  const save = async (evt) => {
    // Signed-out gate (user spec 2026-07 v29): reject changes while the
    // dashboard is in signed-out-locked state so the CSS gate can't be
    // bypassed by keyboard focus / assistive tech / a stale race. The
    // .pf-signed-out-locked body class is the same signal the rest of
    // the app uses to gray out UI.
    if (document.body.classList.contains('pf-signed-out-locked')) {
      if (evt?.target && typeof evt.target.checked === 'boolean') {
        evt.target.checked = !evt.target.checked; // undo the visual flip
      }
      return;
    }
    try {
      await chrome.storage.local.set({
        pfWrappedNotifPrefs: {
          daily: daily.checked,
          weekly: weekly.checked,
          monthly: monthly.checked
        }
      });
    } catch (e) {
      console.warn('[pf-wrapped-notif] save failed', e);
    }
  };
  daily.addEventListener('change', save);
  weekly.addEventListener('change', save);
  monthly.addEventListener('change', save);
}

function clearAutoCloseTimer() {
  if (autoCloseTimerId != null) {
    clearTimeout(autoCloseTimerId);
    autoCloseTimerId = null;
  }
}

function scheduleAutoCloseCheck(source) {
  clearAutoCloseTimer();
  const tick = async () => {
    autoCloseTimerId = null;
    if (!document.hidden || document.hasFocus()) {
      autoCloseCandidateSince = 0;
      return;
    }
    if (!autoCloseCandidateSince) autoCloseCandidateSince = Date.now();
    await tryAutoCloseDashboard(source);
    if (document.hidden && !document.hasFocus()) {
      autoCloseTimerId = setTimeout(tick, AUTO_CLOSE_POLL_MS);
    }
  };
  autoCloseTimerId = setTimeout(tick, AUTO_CLOSE_POLL_MS);
}

const tryAutoCloseDashboard = async (source) => {
  if (document.hasFocus()) {
    autoCloseCandidateSince = 0;
    clearAutoCloseTimer();
    return;
  }
  if (document.visibilityState !== 'hidden') {
    autoCloseCandidateSince = 0;
    clearAutoCloseTimer();
    return;
  }
  if (!autoCloseCandidateSince) autoCloseCandidateSince = Date.now();
  const elapsed = Date.now() - autoCloseCandidateSince;
  if (elapsed < AUTO_CLOSE_STABILITY_MS) return;
  const d = await chrome.storage.local.get(['tutorialCompleted', 'tutorialComplete']);
  if (!d.tutorialCompleted && !d.tutorialComplete) return;
  if (!isAutoCloseDashboardEnabled()) return;
  console.info('>=PlayingFild: Auto-closing dashboard after sustained hidden/unfocused state via', source);
  window.close();
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    autoCloseCandidateSince = Date.now();
    scheduleAutoCloseCheck('visibilitychange');
  } else {
    autoCloseCandidateSince = 0;
    clearAutoCloseTimer();
  }
});

window.addEventListener('blur', () => {
  if (document.hidden) {
    if (!autoCloseCandidateSince) autoCloseCandidateSince = Date.now();
    scheduleAutoCloseCheck('blur');
  }
});

let activeSubTab = 'keyLogger';
let mouseClicks = [];
let dailyWPMDataState = {};
// Live session state for the real-time "Current WPM" display.
let liveWpmSession = { start: 0, keys: 0, lastKeyAt: 0 };
let wpmCurrentLabelRefreshId = null;
const WPM_CURRENT_STALE_MS = 10 * 60 * 1000;
const WPM_IDLE_MS = WPM_CURRENT_STALE_MS;

function getLastWpmEntryTime() {
  let latest = 0;
  for (const dayEntries of Object.values(dailyWPMDataState)) {
    for (const entry of (dayEntries || [])) {
      const t = entry?.time;
      if (typeof t === 'number' && t > latest) latest = t;
    }
  }
  return latest;
}

const timeConfig = {
  minute: { buckets: 60, bucketMs: 60 * 1000, label: 'Last 60m', type: 'line' },
  hour: { buckets: 24, bucketMs: 60 * 60 * 1000, label: 'Last 24h', type: 'line' },
  day: { buckets: 7, bucketMs: 24 * 60 * 60 * 1000, label: 'Last 7 Days', type: 'bar' },
  week: { buckets: 7, bucketMs: 7 * 24 * 60 * 60 * 1000, label: 'Last 7 Weeks', type: 'bar' }
};
// Default to the hourly ("Last 24 Hours") view per user spec 2026-07 v43:
// "make the default WPM thing they go to if they click on it the hourly one".
// Previously defaulted to 'minute' (Last 60 Minutes).
let currentTimeView = 'hour';
let wpmRedrawPending = false;
let lastWPMBuckets = null;
let lastWPMHitPoints = null;
let lastWPMViewType = null;
let lastWPMChartGeometry = null; // { chartLeft, chartRight, chartTop, chartBottom, bucketCount, maxWpm, chartType }
const wpmStableMaxY = { minute: 150, hour: 150, day: 100, week: 100 };

function getStableMaxWpm(view, dataMax) {
  const floor = (view === 'minute' || view === 'hour') ? 150 : 100;
  const needed = dataMax <= floor ? floor : Math.ceil(dataMax / 50) * 50;
  if (!wpmStableMaxY[view] || needed > wpmStableMaxY[view]) {
    wpmStableMaxY[view] = needed;
  }
  return wpmStableMaxY[view];
}

function formatWallClockTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function collectWpmEntries() {
  const entries = [];
  for (const dayEntries of Object.values(dailyWPMDataState)) {
    for (const entry of (dayEntries || [])) {
      const wpm = (typeof entry === 'object' && entry?.wpm != null)
        ? entry.wpm
        : (typeof entry === 'number' ? entry : 0);
      const time = (typeof entry === 'object' && entry?.time != null) ? entry.time : null;
      if (wpm > 0 && time != null) entries.push({ wpm, time });
    }
  }
  return entries;
}

function makeFixedWindowBuckets(count, bucketMs, now) {
  const alignedNow = Math.floor(now / bucketMs) * bucketMs;
  const windowStart = alignedNow - (count - 1) * bucketMs;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: windowStart + i * bucketMs,
    sum: 0,
    count: 0,
    peak: 0
  }));
}

function binEntriesIntoFixedBuckets(buckets, entries, bucketMs) {
  if (!buckets.length) return;
  const windowStart = buckets[0].timestamp;
  const windowEnd = buckets[buckets.length - 1].timestamp + bucketMs;
  for (const entry of entries) {
    if (entry.time < windowStart || entry.time >= windowEnd) continue;
    const idx = Math.floor((entry.time - windowStart) / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx].sum += entry.wpm;
    buckets[idx].count += 1;
    if (entry.wpm > buckets[idx].peak) buckets[idx].peak = entry.wpm;
  }
}

function finalizeWpmBuckets(buckets, labelFn) {
  return buckets.map((b) => ({
    timestamp: b.timestamp,
    label: labelFn(b.timestamp),
    avg: b.count > 0 ? Math.round(b.sum / b.count) : null,
    peak: b.peak,
    count: b.count
  }));
}

function getMinuteBuckets(rawEntries) {
  const now = Date.now();
  const bucketMs = 60 * 1000;
  const buckets = makeFixedWindowBuckets(60, bucketMs, now);
  binEntriesIntoFixedBuckets(buckets, rawEntries, bucketMs);
  return finalizeWpmBuckets(buckets, formatWallClockTime);
}

function getHourViewBuckets(rawEntries) {
  const now = Date.now();
  const bucketMs = 60 * 60 * 1000;
  const buckets = makeFixedWindowBuckets(24, bucketMs, now);
  binEntriesIntoFixedBuckets(buckets, rawEntries, bucketMs);
  return finalizeWpmBuckets(buckets, (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  });
}

/** Local-midnight day index for a timestamp: 0 = today, 1 = yesterday…
 *  Math.round soaks up DST hours so boundaries stay on real local days. */
function wpmLocalDaysAgo(ts, todayMidnight) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return Math.round((todayMidnight - d.getTime()) / (24 * 60 * 60 * 1000));
}

// BUG FIX (user report 2026-07 "the typing graph is broken"): the day and
// week views used epoch-aligned buckets (Math.floor(now / 86400000)) which
// are UTC midnights — in any non-UTC timezone the day boundary lands
// mid-morning/afternoon, so typing done before ~10am (AEST) was charted
// under YESTERDAY's bar, and the week view aligned to epoch weeks that
// start on Thursday. Both now bucket by LOCAL calendar days.
function getDayBuckets(rawEntries) {
  const todayMidnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = Array.from({ length: 7 }, (_, i) => ({
    timestamp: todayMidnight - (6 - i) * DAY, sum: 0, count: 0, peak: 0
  }));
  for (const entry of rawEntries) {
    const daysAgo = wpmLocalDaysAgo(entry.time, todayMidnight);
    if (daysAgo < 0 || daysAgo > 6) continue;
    const b = buckets[6 - daysAgo];
    b.sum += entry.wpm;
    b.count += 1;
    if (entry.wpm > b.peak) b.peak = entry.wpm;
  }
  return finalizeWpmBuckets(buckets, (ts) => {
    const daysAgo = wpmLocalDaysAgo(ts, todayMidnight);
    if (daysAgo <= 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  });
}

function getWeekBuckets(rawEntries) {
  const todayMidnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const DAY = 24 * 60 * 60 * 1000;
  // Week i covers local days [i*7 .. i*7+6] ago, newest week last.
  const buckets = Array.from({ length: 7 }, (_, i) => ({
    timestamp: todayMidnight - ((6 - i) * 7 + 6) * DAY, sum: 0, count: 0, peak: 0
  }));
  for (const entry of rawEntries) {
    const daysAgo = wpmLocalDaysAgo(entry.time, todayMidnight);
    if (daysAgo < 0) continue;
    const weeksAgo = Math.floor(daysAgo / 7);
    if (weeksAgo > 6) continue;
    const b = buckets[6 - weeksAgo];
    b.sum += entry.wpm;
    b.count += 1;
    if (entry.wpm > b.peak) b.peak = entry.wpm;
  }
  return finalizeWpmBuckets(buckets, (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
}

function prepareWPMBuckets(view) {
  const rawEntries = collectWpmEntries();
  if (view === 'minute') return getMinuteBuckets(rawEntries);
  if (view === 'hour') return getHourViewBuckets(rawEntries);
  if (view === 'day') return getDayBuckets(rawEntries);
  if (view === 'week') return getWeekBuckets(rawEntries);
  return getMinuteBuckets(rawEntries);
}

function switchSubTab(tabName, options = {}) {
  const { persist = true } = options;
  if (tabName === 'mouseTracker') return;
  activeSubTab = tabName;
  document.querySelectorAll('.sub-tab:not(.sub-tab--coming-soon)').forEach(tab => tab.classList.remove('active'));
  const tabEl = document.getElementById(tabName + 'Tab');
  if (tabEl) tabEl.classList.add('active');
  const keyLoggerContent = document.getElementById('keyLoggerContent');
  const siteTimeContent = document.getElementById('topSitesContent');
  if (keyLoggerContent) keyLoggerContent.style.display = tabName === 'keyLogger' ? 'block' : 'none';
  if (siteTimeContent) siteTimeContent.style.display = tabName === 'siteTime' ? 'block' : 'none';
  if (persist && STATS_SUB_TABS.includes(tabName) && shouldPersistDashboardTabs()) {
    chrome.storage.local.set({ [DASHBOARD_SUB_TAB_KEY]: tabName }).catch(() => {});
  }
  if (tabName === 'keyLogger') {
    stopPvuLiveNavWatcher();
    startWpmPoll();
    initKeyLogger();
  } else {
    stopWpmPoll();
  }
  if (tabName === 'siteTime') {
    startPvuLiveNavWatcher();
    renderProductiveVsUnproductive().catch((err) => {
      console.error('[pf-pvu] renderProductiveVsUnproductive failed:', err);
    });
    initMouseTracker();
  } else {
    stopPvuLiveNavWatcher();
  }
}

function initKeyLogger() {
  loadTypingDataFromStorage()
    .catch(() => {})
    .finally(() => {
      requestAnimationFrame(() => drawTypingChart());
    });
  startWpmCurrentLabelRefresh();
}

function startWpmCurrentLabelRefresh() {
  if (wpmCurrentLabelRefreshId != null) return;
  wpmCurrentLabelRefreshId = setInterval(() => {
    if (activeSubTab === 'keyLogger') updateCurrentWPM();
  }, 30000);
}

function updateCurrentWPM() {
  const currentWpmText = document.getElementById('currentWpmValueText');
  if (!currentWpmText) return;

  // Live WPM from the in-flight session (if the user typed recently).
  const now = Date.now();
  const sess = liveWpmSession;
  if (sess.keys > 0 && sess.start > 0 && (now - sess.lastKeyAt) < 30_000) {
    const elapsedMin = Math.max(1 / 60, (now - sess.start) / 60000);
    const liveWpm = Math.min(200, Math.round((sess.keys / 5) / elapsedMin));
    currentWpmText.textContent = `${liveWpm} WPM`;
    return;
  }

  // Fall back to the last written sample.
  const entries = collectWpmEntries();
  if (entries.length === 0) {
    currentWpmText.textContent = '0 WPM';
    return;
  }
  const lastNonZero = entries.reduce(
    (best, entry) => (entry.time > best.time ? entry : best),
    entries[0]
  );
  currentWpmText.textContent = `${lastNonZero.wpm} WPM`;
}

function updateTypingStats() {
  const buckets = prepareWPMBuckets(currentTimeView);
  const valid = buckets.filter((b) => b.avg !== null);
  const avg = valid.length > 0
    ? Math.round(valid.reduce((s, b) => s + b.avg, 0) / valid.length)
    : 0;

  const labelMap = {
    minute: 'Last 60m Avg',
    hour: 'Last 24h Avg',
    day: 'Weekly Avg',
    week: 'Period Avg'
  };

  const dailyAvgLabelEl = document.getElementById('dailyAvgLabel');
  if (dailyAvgLabelEl) dailyAvgLabelEl.textContent = labelMap[currentTimeView];
  const dailyAvgText = document.getElementById('dailyAvgValueText');
  if (dailyAvgText) dailyAvgText.textContent = `${avg} WPM`;
}

function formatBucketLabel(view, bucketIdx, totalBuckets, bucket) {
  if (bucket?.label) return bucket.label;
  if (view === 'minute') {
    const minsAgo = totalBuckets - 1 - bucketIdx;
    return minsAgo === 0 ? 'Now' : `${minsAgo}m ago`;
  }
  if (view === 'hour') {
    const hour = bucketIdx;
    return `${hour}:00`;
  }
  if (view === 'day') {
    const daysAgo = totalBuckets - 1 - bucketIdx;
    if (daysAgo === 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    return `${daysAgo}d ago`;
  }
  if (view === 'week') {
    const weeksAgo = totalBuckets - 1 - bucketIdx;
    if (weeksAgo === 0) return 'This week';
    return `${weeksAgo}w ago`;
  }
  return `Bucket ${bucketIdx}`;
}

function mapBucketsForLastWPMTooltip(buckets) {
  return buckets.map((b) => {
    let value = null;
    if (b == null) value = null;
    else if (typeof b === 'number') value = b;
    else if (b.avg != null) value = b.avg;
    else if (b.count > 0 && b.sum != null) value = Math.round(b.sum / b.count);
    else if (b.value != null) value = b.value;
    return { value, peak: b?.peak };
  });
}

function attachWPMResizeObserver() {
  const canvas = document.getElementById('typingChart');
  if (!canvas) return;
  if (canvas.dataset.resizeObserved === '1') return;
  canvas.dataset.resizeObserved = '1';
  const obs = new ResizeObserver(() => {
    requestAnimationFrame(() => drawTypingChart());
  });
  obs.observe(canvas);
  // Track for teardown. activeObservers is cleared on tutorial/chart teardown
  // (cleanupTutorialHighlight); without this the observer was orphaned, holding
  // a strong ref to a canvas that gets replaced on sub-tab switches.
  activeObservers.push(obs);
}

function formatWpmTooltipText(hit, view, bucketCount) {
  const timeLabel = hit.label || formatBucketLabel(view, hit.bucketIdx, bucketCount, hit);
  const avgText = `${Math.round(hit.avg)} WPM`;
  if (hit.peak != null && hit.peak > hit.avg) {
    return `${timeLabel}: ${avgText} (peak ${Math.round(hit.peak)})`;
  }
  return `${timeLabel}: ${avgText}`;
}

function findWpmHitPoint(x, y, geometry, hitPoints) {
  if (!geometry || !hitPoints?.length) return null;

  const { chartLeft, chartRight, chartTop, chartBottom, chartType } = geometry;
  if (x < chartLeft || x > chartRight || y < chartTop || y > chartBottom) return null;

  if (chartType === 'bar') {
    return hitPoints.find((p) =>
      x >= p.xLeft && x <= p.xRight && y >= p.barTop && y <= p.barBottom
    ) || null;
  }

  const dotHitRadius = 14;
  let best = null;
  let bestDist = dotHitRadius;
  for (const p of hitPoints) {
    const dist = Math.hypot(x - p.x, y - p.y);
    if (dist <= bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

function attachWPMTooltip() {
  const canvas = document.getElementById('typingChart');
  if (!canvas || canvas.dataset.tooltipAttached === '1') return;
  canvas.dataset.tooltipAttached = '1';

  let tooltipEl = document.getElementById('wpmTooltip');
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'wpmTooltip';
    tooltipEl.style.cssText = `
        position: fixed;
        pointer-events: none;
        background: rgba(33, 37, 41, 0.95);
        color: white;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        font-weight: 500;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.12s ease;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      `;
    document.body.appendChild(tooltipEl);
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = findWpmHitPoint(x, y, lastWPMChartGeometry, lastWPMHitPoints);

    if (!hit || hit.avg == null) {
      tooltipEl.style.opacity = '0';
      canvas.style.cursor = '';
      return;
    }

    tooltipEl.textContent = formatWpmTooltipText(
      hit,
      lastWPMViewType,
      lastWPMChartGeometry?.bucketCount || lastWPMHitPoints.length
    );
    tooltipEl.style.left = `${e.clientX + 12}px`;
    tooltipEl.style.top = `${e.clientY - 36}px`;
    tooltipEl.style.opacity = '1';
    canvas.style.cursor = 'pointer';
  });

  canvas.addEventListener('mouseleave', () => {
    tooltipEl.style.opacity = '0';
    canvas.style.cursor = '';
  });

  attachWPMResizeObserver();
}

// Retry counter for the zero-size-canvas rAF re-arm below. Bounds the wait so
// the chart doesn't spin a callback every animation frame forever when the
// typing panel is hidden but still in the DOM. Reset whenever a real draw lands.
let typingChartZeroSizeRetries = 0;
const TYPING_CHART_MAX_ZERO_RETRIES = 60;

function drawTypingChart() {
  attachWPMTooltip();
  const canvas = document.getElementById('typingChart');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    // Re-arm instead of drawing, but cap the retries — otherwise this spins at
    // ~60fps for the whole lifetime of the tab whenever the canvas is hidden.
    // A real ResizeObserver/visibility re-draw lands once the panel shows again.
    if (typingChartZeroSizeRetries < TYPING_CHART_MAX_ZERO_RETRIES) {
      typingChartZeroSizeRetries += 1;
      requestAnimationFrame(() => drawTypingChart());
    }
    return;
  }
  typingChartZeroSizeRetries = 0;

  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.floor(rect.width * dpr);
  const targetHeight = Math.floor(rect.height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  const config = timeConfig[currentTimeView];
  const buckets = prepareWPMBuckets(currentTimeView);

  const titleMap = {
    minute: 'Typing Speed (WPM) - Last 60 Minutes',
    hour: 'Typing Speed (WPM) - Last 24 Hours',
    day: 'Typing Speed (WPM) - Last 7 Days',
    week: 'Typing Speed (WPM) - Last 7 Weeks'
  };

  // EMPTY STATE (user report 2026-07: "if they have not got any data can you
  // show no data eg if nothing in the last 1h for the wpm thing"). When no
  // bucket in the current view has any typing samples, draw a centered
  // "No typing data yet" message instead of an empty grid with placeholder
  // dashes (which read as "the graph is broken").
  const hasAnyData = buckets.some((b) => b.count > 0 && b.avg != null);
  if (!hasAnyData) {
    drawWPMEmptyState(canvas, titleMap[currentTimeView], dpr, canvas.width / dpr, canvas.height / dpr);
    // Clear tooltip hit state so hovering the empty chart doesn't show a
    // stale tooltip from a previous render.
    lastWPMBuckets = mapBucketsForLastWPMTooltip(buckets);
    lastWPMHitPoints = [];
    lastWPMViewType = currentTimeView;
    lastWPMChartGeometry = null;
    return;
  }

  if (config.type === 'line') {
    drawWPMLineChart(canvas, buckets, titleMap[currentTimeView], config, dpr, canvas.width / dpr, canvas.height / dpr);
  } else {
    drawWPMBarChart(canvas, buckets, titleMap[currentTimeView], config, dpr, canvas.width / dpr, canvas.height / dpr);
  }
}

// Empty-state renderer for the WPM chart: paints the background + title and a
// centered "No typing data yet" message. Matches the themed look of the
// populated chart so the empty→data transition isn't jarring.
function drawWPMEmptyState(canvas, title, dpr = 1, width, height) {
  const ctx = canvas.getContext('2d');
  const ts = getThemeChartStyle();
  if (width == null) width = canvas.width / dpr;
  if (height == null) height = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  ctx.fillStyle = ts.bg;
  ctx.fillRect(0, 0, width, height);

  // Title (same placement as the populated chart).
  ctx.fillStyle = ts.title;
  ctx.font = ts.titleFont;
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 22);

  // Centered message.
  ctx.fillStyle = ts.axis;
  ctx.font = ts.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('No typing data yet for this period.', width / 2, height / 2);
  ctx.textBaseline = 'alphabetic';
}

function bucketIndexToX(i, nBuckets, padding, chartWidth) {
  if (nBuckets <= 1) return padding + chartWidth / 2;
  return padding + (i / (nBuckets - 1)) * chartWidth;
}

function getThemeChartStyle() {
  const nb = document.body.classList.contains('theme-notebook');
  if (!nb) {
    return {
      bg: '#f8f9fa',
      grid: '#e8e8e8',
      axis: '#666',
      title: '#333',
      line: '#6f42c1',
      lineShadow: 'rgba(111, 66, 193, 0.4)',
      fillTop: 'rgba(111, 66, 193, 0.3)',
      fillBottom: 'rgba(111, 66, 193, 0)',
      peak: 'rgba(111, 66, 193, 0.22)',
      barStart: '#8b5cf6',
      barEnd: '#6f42c1',
      font: '12px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
      titleFont: '600 13px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
      dot: '#6f42c1',
      empty: '#d0d0d0'
    };
  }
  return {
    bg: '#FFFEF9',
    grid: 'rgba(74, 61, 156, 0.15)',
    axis: '#4A3D9C',
    title: '#333',
    line: '#4A3D9C',
    lineShadow: 'rgba(74, 61, 156, 0.35)',
    fillTop: 'rgba(92, 79, 181, 0.18)',
    fillBottom: 'rgba(92, 79, 181, 0)',
    peak: 'rgba(74, 61, 156, 0.15)',
    barStart: '#5C4FB5',
    barEnd: '#4A3D9C',
    font: '12px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
    titleFont: '600 13px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
    dot: '#4A3D9C',
    empty: 'rgba(74, 61, 156, 0.25)'
  };
}

function drawEmptyBucketPlaceholder(ctx, cx, baseY, halfW) {
  const ts = getThemeChartStyle();
  ctx.save();
  ctx.strokeStyle = ts.empty;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx - halfW, baseY);
  ctx.lineTo(cx + halfW, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function getIdleDecayTailPoint(buckets, n, paddingX, chartWidth, wpmToY, points) {
  if (!points.length) return null;

  const lastEntryTime = getLastWpmEntryTime();
  if (!lastEntryTime || (Date.now() - lastEntryTime) < WPM_IDLE_MS) return null;

  const lastPoint = points[points.length - 1];
  const lastWpm = buckets[lastPoint.i]?.avg;
  if (lastWpm == null || lastWpm <= 0) return null;

  const bucketMs = timeConfig[currentTimeView]?.bucketMs || 60000;
  const now = Date.now();
  const currentBucket = buckets[n - 1];
  const bucketStart = currentBucket?.timestamp ?? (now - bucketMs);
  const frac = Math.min(1, Math.max(0, (now - bucketStart) / bucketMs));
  const tailX = paddingX + ((n - 1 + frac) / Math.max(n - 1, 1)) * chartWidth;
  const tailY = wpmToY(0);

  if (Math.abs(tailX - lastPoint.x) < 2) return null;
  return { i: n - 1, x: tailX, y: tailY, idleTail: true };
}

function drawWPMLineChart(canvas, buckets, title, config, dpr = 1, width, height) {
  const ctx = canvas.getContext('2d');
  const ts = getThemeChartStyle();
  if (width == null) width = canvas.width / dpr;
  if (height == null) height = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath();

  ctx.fillStyle = ts.bg;
  ctx.fillRect(0, 0, width, height);

  const paddingTop = 28;
  const paddingX = 40;
  const paddingBottom = 40;
  const titleY = 22;
  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingTop - paddingBottom;
  const n = buckets.length;

  let dataMax = 0;
  buckets.forEach((b) => {
    if (b.avg != null) dataMax = Math.max(dataMax, b.avg);
    if (b.peak > 0) dataMax = Math.max(dataMax, b.peak);
  });
  const maxWpm = getStableMaxWpm(currentTimeView, dataMax);

  const baseY = paddingTop + chartHeight;
  const idxToX = (i) => bucketIndexToX(i, n, paddingX, chartWidth);
  const wpmToY = (w) => paddingTop + chartHeight - (w / maxWpm) * chartHeight;

  ctx.strokeStyle = ts.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let v = 0; v <= maxWpm; v += 25) {
    const y = paddingTop + chartHeight - (v / maxWpm) * chartHeight;
    ctx.beginPath();
    ctx.moveTo(paddingX, y);
    ctx.lineTo(width - paddingX, y);
    ctx.stroke();
    ctx.fillStyle = ts.axis;
    ctx.font = ts.font;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), paddingX - 5, y + 3);
  }
  ctx.setLineDash([]);

  const slotHalf = chartWidth / Math.max(n * 2, 1);

  const filledBucketCount = buckets.filter((b) => b.avg != null && b.count > 0).length;
  const useStraightLines = currentTimeView === 'hour' && filledBucketCount < 6;

  const points = [];
  const hitPoints = [];
  for (let i = 0; i < n; i++) {
    if (buckets[i].avg == null || buckets[i].count === 0) continue;
    const point = { i, x: idxToX(i), y: wpmToY(buckets[i].avg) };
    points.push(point);
    hitPoints.push({
      bucketIdx: i,
      x: point.x,
      y: point.y,
      avg: buckets[i].avg,
      peak: buckets[i].peak,
      label: buckets[i].label,
      timestamp: buckets[i].timestamp
    });
  }

  const idleTail = getIdleDecayTailPoint(buckets, n, paddingX, chartWidth, wpmToY, points);
  if (idleTail) points.push(idleTail);

  function segmentTo(p0, p1) {
    if (useStraightLines) {
      ctx.lineTo(p1.x, p1.y);
      return;
    }
    const dx = p1.x - p0.x;
    ctx.bezierCurveTo(
      p0.x + dx * 0.4, p0.y,
      p0.x + dx * 0.6, p1.y,
      p1.x, p1.y
    );
  }

  if (points.length > 0) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, baseY);
    ctx.lineTo(points[0].x, points[0].y);
    for (let j = 1; j < points.length; j++) {
      segmentTo(points[j - 1], points[j]);
    }
    ctx.lineTo(points[points.length - 1].x, baseY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, paddingTop, 0, paddingTop + chartHeight);
    grad.addColorStop(0, ts.fillTop);
    grad.addColorStop(1, ts.fillBottom);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let j = 1; j < points.length; j++) {
      segmentTo(points[j - 1], points[j]);
    }
    ctx.shadowBlur = 8;
    ctx.shadowColor = ts.lineShadow;
    ctx.strokeStyle = ts.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (const p of points) {
      if (p.idleTail) continue;
      ctx.fillStyle = ts.dot;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  for (let i = 0; i < n; i++) {
    if (buckets[i].count === 0 || buckets[i].avg == null) {
      drawEmptyBucketPlaceholder(ctx, idxToX(i), baseY, Math.max(slotHalf * 0.6, 4));
    }
  }

  ctx.fillStyle = ts.axis;
  ctx.font = ts.font;
  ctx.textAlign = 'center';
  if (currentTimeView === 'minute') {
    const marks = [0, 15, 30, 45, 59];
    marks.forEach((mi) => {
      const label = buckets[mi]?.label || formatWallClockTime(buckets[mi]?.timestamp || Date.now());
      ctx.fillText(label, idxToX(mi), height - paddingBottom + 15);
    });
  } else if (currentTimeView === 'hour') {
    for (let i = 0; i < n; i += 4) {
      ctx.fillText(buckets[i]?.label || '', idxToX(i), height - paddingBottom + 15);
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (i % Math.max(1, Math.floor(n / 7)) !== 0 && i !== n - 1) continue;
      ctx.fillText(buckets[i]?.label || '', idxToX(i), height - paddingBottom + 15);
    }
  }

  ctx.fillStyle = ts.title;
  ctx.font = ts.titleFont;
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, titleY);

  const chartLeft = paddingX;
  const chartRight = paddingX + chartWidth;
  const chartTop = paddingTop;
  const chartBottom = paddingTop + chartHeight;
  lastWPMBuckets = mapBucketsForLastWPMTooltip(buckets);
  lastWPMHitPoints = hitPoints;
  lastWPMViewType = currentTimeView;
  lastWPMChartGeometry = {
    chartLeft,
    chartRight,
    chartTop,
    chartBottom,
    bucketCount: buckets.length,
    maxWpm,
    chartType: 'line'
  };
}

function roundBarRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function drawWPMBarChart(canvas, buckets, title, config, dpr = 1, width, height) {
  const ctx = canvas.getContext('2d');
  const ts = getThemeChartStyle();
  if (width == null) width = canvas.width / dpr;
  if (height == null) height = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath();

  ctx.fillStyle = ts.bg;
  ctx.fillRect(0, 0, width, height);

  const paddingTop = 28;
  const paddingX = 40;
  const paddingBottom = 40;
  const titleY = 22;
  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingTop - paddingBottom;
  const n = buckets.length;

  let dataMax = 0;
  buckets.forEach((b) => {
    if (b.avg != null) dataMax = Math.max(dataMax, b.avg);
    if (b.peak > 0) dataMax = Math.max(dataMax, b.peak);
  });
  const maxWpm = getStableMaxWpm(currentTimeView, dataMax);

  const baseY = paddingTop + chartHeight;
  const slotW = chartWidth / n;
  const barW = slotW * 0.42;
  const radius = 6;

  ctx.strokeStyle = ts.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let v = 0; v <= maxWpm; v += 25) {
    const y = paddingTop + chartHeight - (v / maxWpm) * chartHeight;
    ctx.beginPath();
    ctx.moveTo(paddingX, y);
    ctx.lineTo(width - paddingX, y);
    ctx.stroke();
    ctx.fillStyle = ts.axis;
    ctx.font = ts.font;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), paddingX - 5, y + 3);
  }
  ctx.setLineDash([]);

  const barGrad = ctx.createLinearGradient(0, paddingTop, 0, baseY);
  barGrad.addColorStop(0, ts.barStart);
  barGrad.addColorStop(1, ts.barEnd);

  const hitPoints = [];
  for (let i = 0; i < n; i++) {
    const cx = paddingX + i * slotW + slotW / 2;
    if (buckets[i].count === 0) {
      drawEmptyBucketPlaceholder(ctx, cx, baseY, barW * 0.55);
      continue;
    }

    const peakH = buckets[i].peak > 0
      ? (buckets[i].peak / maxWpm) * chartHeight
      : 0;
    const avgH = buckets[i].avg != null
      ? (buckets[i].avg / maxWpm) * chartHeight
      : 0;

    if (peakH > 0) {
      ctx.fillStyle = ts.peak;
      roundBarRect(ctx, cx - barW / 2, baseY - peakH, barW, peakH, radius);
      ctx.fill();
    }

    if (avgH > 0) {
      ctx.fillStyle = barGrad;
      roundBarRect(ctx, cx - barW / 2, baseY - avgH, barW, avgH, radius);
      ctx.fill();
    }

    if (buckets[i].avg != null) {
      hitPoints.push({
        bucketIdx: i,
        x: cx,
        y: baseY - avgH,
        xLeft: cx - barW / 2,
        xRight: cx + barW / 2,
        barTop: baseY - Math.max(avgH, peakH),
        barBottom: baseY,
        avg: buckets[i].avg,
        peak: buckets[i].peak,
        label: buckets[i].label,
        timestamp: buckets[i].timestamp
      });
    }
  }

  ctx.fillStyle = ts.axis;
  ctx.font = ts.font;
  ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    if (i % Math.max(1, Math.floor(n / 7)) !== 0 && i !== n - 1) continue;
    ctx.fillText(buckets[i]?.label || '', paddingX + i * slotW + slotW / 2, height - paddingBottom + 15);
  }

  ctx.fillStyle = ts.title;
  ctx.font = ts.titleFont;
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, titleY);

  const chartLeft = paddingX;
  const chartRight = paddingX + chartWidth;
  const chartTop = paddingTop;
  const chartBottom = paddingTop + chartHeight;
  lastWPMBuckets = mapBucketsForLastWPMTooltip(buckets);
  lastWPMHitPoints = hitPoints;
  lastWPMViewType = currentTimeView;
  lastWPMChartGeometry = {
    chartLeft,
    chartRight,
    chartTop,
    chartBottom,
    bucketCount: buckets.length,
    maxWpm,
    chartType: 'bar'
  };
}

function initMouseTracker() {
  if (!window.modernTrackers) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('modern_trackers.js');
    script.onload = function() {
      if (window.modernTrackers) window.modernTrackers.initialize();
    };
    document.head.appendChild(script);
  } else {
    window.modernTrackers.initialize();
  }
}

function updateMouseStats() {
  const totalEl = document.getElementById('totalClicks');
  if (totalEl) totalEl.innerText = mouseClicks.length;
}

async function loadMouseClicksFromStorage() {
  const r = await chrome.storage.local.get('mouseClicks');
  mouseClicks = r.mouseClicks || [];
  updateMouseStats();
}

async function loadTypingDataFromStorage() {
  const r = await chrome.storage.local.get(['dailyWPMData']);
  dailyWPMDataState = r.dailyWPMData || {};
  drawTypingChart();
  updateTypingStats();
  updateCurrentWPM();
}

document.addEventListener('DOMContentLoaded', async () => {
  console.info('[pf-dash-perf] DOMContentLoaded', { t: performance.now() });
  // Aggressive boot progress logging — if any awaited step hangs the handler,
  // we want to see exactly which step was last reached. Every numbered marker
  // that PRINTS means that step completed. The first one MISSING is the hang.
  console.info('[pf-dash-boot] 1: about to bind early UI');
  try { bindRevertTutorialButton(); } catch (e) { console.error('[pf-dash-boot] bindRevertTutorialButton threw', e); }
  try { bootDashboardUiBindings(); } catch (e) { console.error('[pf-dash-boot] bootDashboardUiBindings threw', e); }
  console.info('[pf-dash-boot] 2: early bindings done, checking chrome');
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || !chrome.runtime || !chrome.windows) {
    console.error('[pf-dash-boot] chrome.* missing — bailing');
    return;
  }
  try { ensureDashboardLoadingStyle(); } catch (e) { console.error('[pf-dash-boot] ensureDashboardLoadingStyle threw', e); }
  document.documentElement.classList.add('pf-dash-loading');
  console.info('[pf-dash-boot] 3: about to await migrate');
  try {
    await migrateWindowConfigsToWindowNames();
    console.info('[pf-dash-boot] 4: migrate resolved');
  } catch (e) {
    console.error('[pf-dash-boot] migrateWindowConfigsToWindowNames threw', e);
  }
  console.info('[pf-dash-boot] 5: about to await renderWindowSettings');
  // Race the render against a 4s timeout so a hang here cannot kill the rest
  // of the boot. If renderWindowSettings stalls (e.g., a dead SW makes a
  // sendMessage await hang despite a .catch), we still attach every listener
  // below and the user can actually use the dashboard. The render will resolve
  // on its own later and update the UI then.
  const renderPromise = renderWindowSettings().catch((e) => {
    console.warn('[pf-dash] initial renderWindowSettings failed', e);
  });
  const renderTimeout = new Promise((res) => setTimeout(() => {
    console.warn('[pf-dash-boot] renderWindowSettings exceeded 4s — proceeding without waiting');
    res();
  }, 4000));
  await Promise.race([renderPromise, renderTimeout]);
  console.info('[pf-dash-boot] 6: past renderWindowSettings (resolved or timed out)');
  isInitialized = true;
  refreshDashboardShortcutTitle().catch(() => {});
  setTimeout(() => refreshDashboardShortcutTitle().catch(() => {}), 300);
  window.addEventListener('focus', () => {
    refreshDashboardShortcutTitle().catch(() => {});
    // Re-check sign-in state when the dashboard regains focus — the user may
    // have just signed in via the signup tab. Without this, the profile button
    // / sign-out button don't reflect the signed-in state until the user opens
    // the profile panel (which calls refreshAuthFromStorage).
    refreshAuthFromStorage().catch(() => {});
  });
  const params = new URLSearchParams(window.location.search);
  const isFirstRun = params.get('firstrun') === 'true';
  if (isFirstRun) {
    await chrome.storage.local.set({
      onboardingRequired: true,
      tutorialCompleted: false,
      tutorialComplete: false,
      tutorialState: { step: 0 },
      lastTutorialStep: 0
    });
  }
  // Wrapped deep-link (user spec 2026-07): Chrome notifications for
  // daily / weekly / monthly recaps all open the dashboard with
  //   stats.html?openWrapped=<kind>
  // Switch to the Stats sub-tab, scroll the recap banner into view, and
  // play a soft purple pulse ring on it so the user sees exactly where
  // to click. Runs after a short delay so the tab machinery has finished
  // wiring up handlers on first paint.
  const openWrappedParam = params.get('openWrapped');
  const openWrappedExample = params.get('example') === '1';
  if (openWrappedParam === 'weekly'
      || openWrappedParam === 'daily'
      || openWrappedParam === 'monthly') {
    // Example toast → inject a synthetic banner so the click has
    // something to reveal (user spec 2026-07 v15).
    if (openWrappedExample) {
      setTimeout(() => {
        try {
          void pfInjectExampleWrappedBanner(openWrappedParam);
        } catch (e) {
          console.warn('[pf-recap] example banner inject failed', e);
        }
      }, 260);
    }
    setTimeout(() => {
      try {
        const statsTabBtn = document.getElementById('statsTab');
        if (statsTabBtn) statsTabBtn.click();
        if (typeof switchSubTab === 'function') switchSubTab('siteTime', { persist: false });
        setTimeout(() => {
          const section = document.getElementById('pfRecapSection');
          if (!section) return;
          section.scrollIntoView({ behavior: 'smooth', block: 'center' });
          section.classList.remove('pf-recap-focus-flash');
          void section.offsetWidth; // re-trigger the animation
          section.classList.add('pf-recap-focus-flash');
          setTimeout(() => section.classList.remove('pf-recap-focus-flash'), 3400);
        }, 200);
      } catch (e) {
        console.warn('[pf-recap] deep-link openWrapped=weekly failed', e);
      }
    }, 300);
  }
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      const advancedLimitsSection = $('advancedLimitsSection');
      if (advancedLimitsSection) {
        const expanded = advancedLimitsSection.style.display === 'none';
        setAdvancedSettingsExpanded(expanded);
      }
      event.preventDefault();
      event.stopPropagation();
    }
    // DEV shortcuts (user spec 2026-07 v11): fire the Weekly / Monthly
    // Wrapped Chrome notifications on demand, on SEPARATE keybinds so
    // they don't stack on top of each other. Number keys avoid the
    // macOS system shortcuts that hijacked Shift+Cmd+I (Mail) and
    // Shift+Cmd+Y (New Quick Note) — those combos never reached our
    // page. Shift+Cmd+3/4/5 are macOS screenshot combos so we skip
    // those; 7 and 8 are unused system-wide.
    //   Shift + ⌘/Ctrl + 7 → Weekly Wrapped
    //   Shift + ⌘/Ctrl + 8 → Monthly Wrapped
    if ((event.metaKey || event.ctrlKey) && event.shiftKey
        && (event.key === '7' || event.key === '&')) {
      console.info('[pf-dev] Shift+Cmd+7 → weekly notification');
      chrome.runtime.sendMessage({ action: 'devFireWrappedNotifications', kind: 'weekly' }).catch(() => {});
      event.preventDefault();
      event.stopPropagation();
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey
        && (event.key === '8' || event.key === '*')) {
      console.info('[pf-dev] Shift+Cmd+8 → monthly notification');
      chrome.runtime.sendMessage({ action: 'devFireWrappedNotifications', kind: 'monthly' }).catch(() => {});
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // Direct click tracking on Stats page itself
  document.addEventListener('click', (e) => {
    try {
      chrome.runtime.sendMessage({
        action: 'trackClick',
        x: e.clientX,
        y: e.clientY,
        vpWidth: window.innerWidth,
        vpHeight: window.innerHeight,
        timestamp: Date.now()
      }).catch(() => {});
    } catch (err) {}
  });

  // Direct keystroke tracking on Stats page (extension URL - no content script).
  // Tracks BOTH via the worker (for persistence) AND locally (for instant
  // display feedback) so the WPM number updates even if the SW is asleep.
  //
  // Local fallback flush (2026-07): user reported WPM was showing 0 even
  // while typing. The worker's addKeystrokeBatch path can silently fail
  // (SW suspended, message dropped, stale session), so if the local
  // session accumulates enough keys we also write a sample DIRECTLY to
  // chrome.storage.local.dailyWPMData. The chart poller reads that same
  // key, so the graph reflects local typing without a round-trip.
  let localWpmKeys = 0;
  let localWpmStart = 0;
  let localWpmLastKey = 0;
  let localWpmLastFlushAt = 0;
  const LOCAL_WPM_FLUSH_MIN_KEYS = 8;
  const LOCAL_WPM_FLUSH_MIN_MS = 10 * 1000;

  async function flushLocalWpmToStorage(force = false) {
    const now = Date.now();
    if (localWpmKeys < LOCAL_WPM_FLUSH_MIN_KEYS && !force) return;
    if (now - localWpmLastFlushAt < LOCAL_WPM_FLUSH_MIN_MS && !force) return;
    const spanMs = Math.max(2000, now - localWpmStart);
    const elapsedMin = spanMs / 60000;
    const wpm = Math.min(200, Math.round((localWpmKeys / 5) / elapsedMin));
    if (!Number.isFinite(wpm) || wpm <= 0) return;
    try {
      const r = await chrome.storage.local.get(['dailyWPMData']);
      const map = r.dailyWPMData || {};
      const today = new Date().toISOString().slice(0, 10);
      if (!map[today]) map[today] = [];
      map[today].push({ wpm, time: now });
      if (map[today].length > 300) map[today] = map[today].slice(-300);
      await chrome.storage.local.set({ dailyWPMData: map });
      dailyWPMDataState = map;
      localWpmLastFlushAt = now;
      // Redraw so the chart reflects this fresh sample immediately.
      if (activeSubTab === 'keyLogger') {
        try { drawTypingChart(); } catch (_) { /* no-op */ }
        try { updateTypingStats(); } catch (_) { /* no-op */ }
      }
    } catch (_) { /* best-effort */ }
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length > 1 && !['Backspace', 'Enter', 'Tab', ' '].includes(e.key)) return;

    const now = Date.now();
    const isContent = !([' ', 'Backspace', 'Enter', 'Tab'].includes(e.key));
    if (isContent) {
      if (localWpmKeys === 0 || (now - localWpmLastKey) > 30_000) {
        localWpmKeys = 0;
        localWpmStart = now;
      }
      localWpmKeys++;
      localWpmLastKey = now;
      // Instant local display update — doesn't wait for the SW round-trip.
      const currentWpmText = document.getElementById('currentWpmValueText');
      if (currentWpmText && localWpmKeys > 0 && localWpmStart > 0) {
        const elapsedMin = Math.max(1 / 60, (now - localWpmStart) / 60000);
        const liveWpm = Math.min(200, Math.round((localWpmKeys / 5) / elapsedMin));
        currentWpmText.textContent = `${liveWpm} WPM`;
      }
      // Opportunistic flush to storage so the chart doesn't sit at 0.
      void flushLocalWpmToStorage();
    }

    // Also send to the worker for persistence (best-effort).
    chrome.runtime.sendMessage({
      action: 'trackKey',
      timestamp: now,
      isContent
    }).catch(() => {});
  });

  // On tab hidden / dashboard close, flush anything buffered so the day's
  // last burst isn't lost.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLocalWpmToStorage(true);
  });
  window.addEventListener('pagehide', () => flushLocalWpmToStorage(true));

  chrome.runtime.sendMessage({ action: 'wpmDashboardOpen' }).catch(() => {});
  // Work Timer preview flag (user spec v43): while the dashboard is open its
  // Work Timer settings preview is on-screen — suppress the earned-time
  // reminder toast for this window. Cleared in onDashboardUnload below.
  try { chrome.storage.local.set({ studyBreakPreviewVisible: true }); } catch (_) {}
  const onDashboardUnload = () => {
    teardownDashboardIntervals();
    chrome.runtime.sendMessage({ action: 'wpmDashboardClosed' }).catch(() => {});
    // Clear the Work Timer preview-visible flag so the earned-time reminder
    // isn't permanently suppressed after the dashboard closes (user spec
    // 2026-07 v43 — the flag is only meaningful while the dashboard is open).
    try { chrome.storage.local.set({ studyBreakPreviewVisible: false }); } catch (_) {}
  };
  window.addEventListener('beforeunload', onDashboardUnload);
  window.addEventListener('pagehide', onDashboardUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      chrome.runtime.sendMessage({ action: 'wpmDashboardClosed' }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ action: 'wpmDashboardOpen' }).catch(() => {});
    }
  });

  const wpmTimeViewToggle = document.getElementById('wpmTimeViewToggle');
  if (wpmTimeViewToggle) {
    wpmTimeViewToggle.querySelectorAll('.time-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === currentTimeView) return;
        const canvas = document.getElementById('typingChart');
        if (canvas) canvas.style.opacity = '0';
        setTimeout(() => {
          currentTimeView = view;
          wpmTimeViewToggle.querySelectorAll('.time-view-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.view === view);
          });
          drawTypingChart();
          updateTypingStats();
          if (canvas) canvas.style.opacity = '1';
        }, 200);
      });
    });
  }

  const devToolsToggle = document.getElementById('devToolsToggle');
  const devToolsContent = document.getElementById('devToolsContent');

  function refreshExtensionVersionLabel() {
    try {
      const version = chrome.runtime.getManifest()?.version;
      if (!version) return;
      const devEl = document.getElementById('extensionVersion');
      const labelEl = document.getElementById('extensionVersionLabel');
      if (devEl) devEl.textContent = version;
      if (labelEl) labelEl.textContent = `v${version}`;
    } catch (_) {
      // Non-extension context.
    }
  }

  async function refreshSnapshotDiagnostics() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getSnapshotMetadata' });
      const meta = resp?.metadata || {};
      const versionEl = document.getElementById('snapshotVersion');
      const trapsEl = document.getElementById('snapshotTrapsCount');
      const hostnamesEl = document.getElementById('snapshotHostnamesCount');
      const tokensEl = document.getElementById('snapshotTokensCount');
      if (versionEl) versionEl.textContent = meta.snapshot_version || '-';
      if (trapsEl) trapsEl.textContent = String(meta.traps_count ?? '-');
      if (hostnamesEl) hostnamesEl.textContent = String(meta.hostnames_count ?? '-');
      if (tokensEl) tokensEl.textContent = String(meta.tokens_count ?? '-');
    } catch (e) {
      console.warn('[pf-global] snapshot diagnostics failed', e);
    }
  }

  refreshExtensionVersionLabel();
  refreshSnapshotDiagnostics();

  if (devToolsToggle && devToolsContent) {
    devToolsToggle.addEventListener('click', () => {
      const expanded = devToolsContent.style.display !== 'none';
      devToolsContent.style.display = expanded ? 'none' : 'block';
      const caret = devToolsToggle.querySelector('.caret');
      if (caret) caret.textContent = expanded ? '▶' : '▼';
      if (!expanded) {
        refreshExtensionVersionLabel();
        refreshSnapshotDiagnostics();
      }
    });
  }

  // Dev: skip the Advanced Settings time lock (user spec 2026-07: "add a
  // skip waiting for unlock of advanced settings thing in the dev tools
  // area"). Backdates pfInstalledAt past PF_ADV_UNLOCK_MS so
  // pfAdvancedSettingsLockedNow() reads it as already unlocked, then
  // re-syncs the lock UI inline — no reload needed. Mirrors the SW-side
  // pf.skipAdvancedLock(true) dev-console command.
  const devSkipAdvancedLockBtn = $('devSkipAdvancedLockBtn');
  if (devSkipAdvancedLockBtn && devSkipAdvancedLockBtn.dataset.bound !== '1') {
    devSkipAdvancedLockBtn.dataset.bound = '1';
    devSkipAdvancedLockBtn.addEventListener('click', async () => {
      try {
        // Backdate BOTH stamps + force tutorialComplete so the new
        // tutorial-anchored lock reads as expired regardless of which
        // path (pfInstalledAt or pfTutorialFinishedAt) is authoritative.
        const oldTs = Date.now() - 60 * 60 * 1000;
        await chrome.storage.local.set({
          pfInstalledAt: oldTs,
          pfTutorialFinishedAt: oldTs,
          tutorialCompleted: true,
          tutorialComplete: true
        });
        await pfSyncAdvancedSettingsLock();
        devSkipAdvancedLockBtn.textContent = '✓ Unlocked';
        setTimeout(() => { devSkipAdvancedLockBtn.textContent = 'Skip Advanced Settings unlock wait'; }, 1800);
      } catch (e) {
        console.warn('[pf-dev] skip advanced lock failed', e);
        devSkipAdvancedLockBtn.textContent = 'Failed — see console';
      }
    });
  }

  // ── DEV: Example Wrapped previews ─────────────────────────────────────
  // Build synthetic recaps from fabricated summaries and INJECT the actual
  // banner into the live recap rail — mirrors exactly what the user sees
  // when a real recap lands (kicker, hero line, "Open →", pulse dot, all
  // of it). Clicking the banner runs the normal chest/modal flow. Nothing
  // is written to storage, so real seen state and rollups are untouched.
  const bindExampleWrappedBtn = (btnId, kind) => {
    const btn = $(btnId);
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      try {
        const now = Date.now();
        const dayAt = (n) => {
          const d = new Date(now - n * 864e5);
          d.setHours(12, 0, 0, 0);
          return d.getTime();
        };
        const day = (n, over = {}) => ({
          ts: dayAt(n),
          p: 3 * 3600 + 12 * 60, u: 42 * 60, n: 18 * 60, eng: 18,
          topHosts: [
            ['docs.google.com', 5400, 'Productive'],
            ['github.com', 3600, 'Productive'],
            ['youtube.com', 1500, 'Unproductive']
          ],
          hourlyP: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 12 ? 2800 : (h >= 14 && h < 17 ? 1800 : 0))),
          closesByHost: { 'youtube.com': 3 },
          reorders: 21, shields: 2, timers: 3, breaks: 2,
          ...over
        });
        let recap = null;
        let bannerKicker = '';
        let bannerLine = '';
        let bannerSub = '';
        // Pre-build the slide deck from the SAME fake summaries the recap
        // was built from — user spec 2026-07 v13: "why did the weekly
        // only show me 1 card not 3". pfRecapOpenChest normally pulls
        // slides via buildRecapSlides(REAL_stored_summaries), which was
        // empty for our synthetic recap → deck fell back to `[recap]`
        // → only 1 card. Passing opts.slides bypasses that lookup and
        // gives the chest the full deck to draw from (1/3/all per kind).
        let demoSummaries = null;
        if (kind === 'daily') {
          demoSummaries = { d1: day(1), d2: day(2, { p: 2 * 3600 + 30 * 60 }) };
          recap = buildDailyRecap(demoSummaries, { now, streak: 4 });
          if (!recap) { console.warn('[pf-dev] daily recap build returned null'); return; }
          bannerKicker = 'DAILY WRAPPED (EXAMPLE)';
          bannerLine = 'We noticed something about how you work.';
          const hero = recapHeroNumber(recap.heroSec);
          bannerSub = `${hero.value} ${hero.unit} ${recap.heroLabel}`;
        } else if (kind === 'weekly') {
          demoSummaries = {};
          for (let i = 1; i <= 7; i++) demoSummaries['w' + i] = day(i);
          recap = buildWeeklyRecap(demoSummaries, { now });
          if (!recap) { console.warn('[pf-dev] weekly recap build returned null'); return; }
          const hero = recapHeroNumber(recap.heroSec);
          bannerKicker = 'WEEKLY WRAPPED (EXAMPLE)';
          bannerLine = `${hero.value} ${hero.unit} of deep focus`;
          bannerSub = recap.dateLabel;
        } else if (kind === 'monthly') {
          demoSummaries = {};
          for (let i = 1; i <= 30; i++) demoSummaries['m' + i] = day(i);
          recap = buildMonthlyRecap(demoSummaries, { now });
          if (!recap) { console.warn('[pf-dev] monthly recap build returned null'); return; }
          const hero = recapHeroNumber(recap.heroSec);
          bannerKicker = 'MONTHLY WRAPPED (EXAMPLE)';
          bannerLine = `${hero.value} ${hero.unit} ${recap.heroLabel}`;
          bannerSub = recap.dateLabel;
        }
        if (!recap) return;
        // Build the full deck from the SAME fake summaries so the chest
        // reveal draws 1 card for daily, 3 for weekly, all for monthly.
        let demoSlides = [];
        try {
          demoSlides = buildRecapSlides(demoSummaries, kind, { now, streak: 4 }) || [];
        } catch (e) {
          console.warn('[pf-dev] buildRecapSlides failed', e);
        }
        if (!demoSlides.length) demoSlides = [recap];
        // NO AUTO-NAVIGATION (user spec 2026-07: "don't take me to the
        // wrapped stats page because I want to see the visual cue you
        // gave for the daily wrapped"). Inject the banner into the rail
        // AND flip the sub-tab badge on directly, so the user stays on
        // the current tab and can watch the pulsing green dot appear on
        // the "Productive vs Unproductive Time" sub-tab — same visual
        // cue as a real fresh recap. When they navigate over on their
        // own the banner is waiting for them.
        const rail = document.getElementById('pfRecapRail');
        const section = document.getElementById('pfRecapSection');
        if (!rail || !section) return;
        // Remove any prior example banner so re-clicking replaces it.
        rail.querySelectorAll('[data-pf-dev-example="1"]').forEach((el) => el.remove());
        const banner = pfRecapBanner({
          kind, kicker: bannerKicker, line: bannerLine, sub: bannerSub, recap
        });
        banner.dataset.pfDevExample = '1';
        // Wrap the original click so opening the chest doesn't try to
        // write "seen" state (this is a demo). ALL three kinds now open
        // the actual loot chest — user spec 2026-07 v12: "for the weekly
        // and monthly it should have the weekly loot crate and the
        // monthly loot crate not what it currently is." The chest itself
        // already themes by kind (daily=green, weekly=pink, monthly=purple).
        banner.onclick = null;
        banner.addEventListener('click', (e) => {
          e.stopImmediatePropagation();
          try { banner.remove(); } catch (_) {}
          void pfRecapOpenChest(recap, {
            forceChest: true,
            demo: true,
            slides: demoSlides
          });
        }, true);
        rail.prepend(banner);
        section.hidden = false;
        // Flip the top-level Stats-tab pulsing-dot badge on so the user
        // can see the in-dashboard cue firing right now (the periodic
        // render will reconcile it back to real state once a real
        // recap is opened).
        const badge = document.getElementById('statsTabRecapBadge');
        if (badge) badge.hidden = false;
      } catch (e) {
        console.warn('[pf-dev] example wrapped inject failed', e);
      }
    });
  };
  bindExampleWrappedBtn('devExampleDailyWrappedBtn', 'daily');
  bindExampleWrappedBtn('devExampleWeeklyWrappedBtn', 'weekly');
  bindExampleWrappedBtn('devExampleMonthlyWrappedBtn', 'monthly');
  // Dev: fire the first-time Tabs Reordered notice on demand (user spec
  // 2026-07 v42). Routes through the worker so the injection happens in
  // the active tab, matching how the real notice fires post-reorder.
  const devReorderNoticeBtn = document.getElementById('devExampleReorderNoticeBtn');
  if (devReorderNoticeBtn && devReorderNoticeBtn.dataset.pfBound !== '1') {
    devReorderNoticeBtn.dataset.pfBound = '1';
    devReorderNoticeBtn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ action: 'pfDevFireReorderNotice' }).catch(() => {});
      } catch (e) {
        console.warn('[pf-dev] reorder notice dispatch failed', e);
      }
    });
  }

  // Activity-Aware Timer toggle removed — idle pause is always on now.
  // Left as a no-op block so any bookmark/hash routing pointing at the
  // former section id doesn't error out.

  const devAskEveryPageToggle = document.getElementById('devAskEveryPageToggle');
  if (devAskEveryPageToggle) {
    chrome.storage.local.get('devAskEveryPage').then(r => {
      devAskEveryPageToggle.checked = r.devAskEveryPage === true;
    });

    devAskEveryPageToggle.addEventListener('change', (e) => {
      console.info('[pf-dev-ask] toggle changed to', e.target.checked);
      chrome.runtime.sendMessage({
        action: 'setDevAskEveryPage',
        enabled: e.target.checked
      }, (response) => {
        if (response?.success) {
          console.info('[pf-dev-ask] UI confirmed toggle:', e.target.checked);
        }
      });
    });
  }

  // Reset all earned break time / spend time / study-break bank for every
  // window. Two entry points wire the same handler:
  //   - Dev Tools: `resetBreakTimeBtn` (original, kept for internal testing).
  //   - Profile → User Settings/Data tab: `profileResetBreakTimeBtn`
  //     (added per user spec 2026-07 — surfaced in the "user settings /
  //     data profile" area for end users).
  const bindResetBreakTimeBtn = (btnId, statusId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Reset ALL earned break time, spend time, and study-break bank across every window? This cannot be undone.')) return;
      const status = document.getElementById(statusId);
      if (status) { status.textContent = 'Resetting…'; status.style.color = '#7a5a00'; }
      const resp = await chrome.runtime.sendMessage({ action: 'resetAllEarnedBreakTime' }).catch(() => null);
      if (resp?.success) {
        if (status) { status.textContent = 'Reset complete.'; status.style.color = '#2d5a2d'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 4000);
      } else {
        if (status) { status.textContent = 'Reset failed. See console.'; status.style.color = '#b03a2e'; }
      }
    });
  };
  bindResetBreakTimeBtn('resetBreakTimeBtn', 'resetBreakTimeStatus');
  bindResetBreakTimeBtn('profileResetBreakTimeBtn', 'profileResetBreakTimeStatus');

  async function wipeHostnameData() {
    const input = document.getElementById('wipeHostnameInput');
    const status = document.getElementById('wipeHostnameStatus');
    const value = input?.value?.trim();
    if (!value) {
      alert('Enter a hostname (e.g. reddit.com)');
      return;
    }
    if (!confirm(`Wipe all training for '${value}'? This cannot be undone.`)) return;

    chrome.runtime.sendMessage({ action: 'wipeHostnameData', hostname: value }, (response) => {
      if (response?.success) {
        console.info('[pf-wipe] hostname data cleared:', response.removed);
        if (input) input.value = '';
        if (status) {
          const removed = response.removed || {};
          status.textContent = `Cleared ${removed.hostnameBias ? 'hostname bias' : 'no bias'} and ${removed.pathScores || 0} path score(s) for ${value}.`;
          status.style.display = 'block';
        }
      } else {
        alert('Wipe failed: ' + (response?.error || 'unknown error'));
      }
    });
  }

  document.getElementById('wipeHostnameBtn')?.addEventListener('click', wipeHostnameData);

  // Dark mode toggle (2026-07 user spec): Default Background skin only.
  {
    const dmToggle = $('pfDarkModeToggle');
    if (dmToggle) {
      dmToggle.addEventListener('change', (evt) => {
        // COMING SOON (user spec 2026-07): dark mode is disabled for now.
        // The checkbox is disabled in markup + kept off by the sync fn;
        // this handler is a belt-and-braces revert in case anything
        // programmatically flips it. No persist, no class change.
        if (evt?.target) evt.target.checked = false;
      });
      // Initial state — applyTheme re-syncs on every skin switch.
      void pfSyncDarkModeToggleUI();
      void pfApplyDarkModeClass();
    }
  }

  // Real Productivity "?" dropdown: the toggle + click-away + Esc now live
  // in the chart legend builder (stats.js, where the legend "?" button is
  // created on each render). The standalone "below the graph" block it used
  // to bind was removed per user request 2026-07.

  if ($('enforcerToggle')) {
    $('enforcerToggle').onchange = async function() {
      // During the "Closer toggle" tutorial step (currentStep === 7), let the
      // tutorial's own ON→OFF cycle run unimpeded. Running the timer/spend lock
      // checks first (which call this.checked = !this.checked) would revert the
      // toggle the instant the user turns it ON, breaking the step.
      if (currentStep === 7) {
        lastRenderedLimEn = this.checked === true;
        return;
      }
      const win = await chrome.windows.getCurrent().catch(() => null);
      const windowName = win?.id != null
        ? await getFriendlyWindowNameForTimer(win.id)
        : null;
      let { bankSpendActive, bankSpendPaused, bankSpendSourceHost } = await chrome.storage.local.get([
        'bankSpendActive', 'bankSpendPaused', 'bankSpendSourceHost'
      ]);
      // PHANTOM SPEND SELF-HEAL (2026-07): only fires on direct user click
      // of the enforcer toggle (never on the periodic broadcast refresh —
      // that would race with legitimate cancel/refund flows). Clears
      // bankSpendActive[wn] when it lingers with:
      //   * Advanced Earn/Spend OFF (config.advancedBankedTimeEnabled=false)
      //   * sourceHost != 'study_break' (not a live Work Timer break)
      //   * no wall-clock timer running at all
      // — the three-way combo means the flag is orphaned, and the toggle
      // was silently reverting every click for the user because of it.
      try {
        const wcStored = await chrome.storage.local.get('windowConfigs');
        const advOn = wcStored.windowConfigs?.[windowName]?.advancedBankedTimeEnabled === true;
        const isStudyBreakOrigin = bankSpendSourceHost?.[windowName] === 'study_break';
        const timerFlags = win?.id != null ? await getWallClockTimerUiFlags(win.id) : null;
        const noWallClockTimer = !timerFlags?.timerSessionActive;
        if (
          windowName
          && bankSpendActive?.[windowName]
          && !advOn
          && !isStudyBreakOrigin
          && noWallClockTimer
        ) {
          console.warn('[pf-enforcer] click-time self-heal: clearing phantom bankSpendActive', { windowName });
          const wipe = (m) => { const c = { ...(m || {}) }; delete c[windowName]; return c; };
          await chrome.storage.local.set({
            bankSpendActive: wipe(bankSpendActive),
            bankSpendPaused: wipe(bankSpendPaused),
            bankSpendSourceHost: wipe(bankSpendSourceHost)
          });
          bankSpendActive = wipe(bankSpendActive);
        }
      } catch (_) { /* best-effort */ }
      // BLANKET TIMER REVERT REMOVED (2026-07): this used to flip the
      // checkbox straight back whenever ANY wall-clock session existed —
      // running, paused, or a break. So when a break timer went off (closer
      // forced ON, session still winding down / next study leg starting),
      // switching the closer OFF was silently undone every time (user
      // report). The current design rule (refreshCloserToggleUI) is that
      // the enforcer toggle stays usable alongside timers; only an ACTIVE
      // SPEND session blocks it, handled below.
      //
      // ASYMMETRIC SPEND LOCK (2026-07): a stale/phantom bankSpendActive
      // was silently reverting toggle-OFFs — user could uncheck the box,
      // it snapped back, no toast, no visible reason. The spend lock is
      // meant to prevent TURNING THE CLOSER ON mid-break (which would
      // gate the break site the user is currently on). Turning it OFF is
      // always safe and should be allowed, so it only blocks the ON path.
      if (
        this.checked === true
        && windowName
        && bankSpendActive?.[windowName]
        && !bankSpendPaused?.[windowName]
      ) {
        this.checked = false;
        console.warn('[pf-enforcer] toggle-ON blocked - Mode B spend session is active');
        return;
      }
      // STUDY-FORCES-ON (user spec 2026-07): while the Work Timer runs the
      // closer stays ON — the user CANNOT turn it off mid-session. The
      // worker also pins limitsEnabled=true on study start and flips it
      // back to false when the timer ends, so the toggle returns to its
      // OFF baseline for manual control after the session.
      try {
        const timerFlags2 = win?.id != null ? await getWallClockTimerUiFlags(win.id) : null;
        const studyRunning = !!(timerFlags2?.timerSessionActive && timerFlags2?.timerMode !== 'break');
        if (studyRunning && this.checked !== true) {
          this.checked = true;
          console.warn('[pf-enforcer] toggle-OFF blocked - Work Timer session is running');
          return;
        }
      } catch (_) { /* best-effort */ }
      if (win?.id != null) {
        console.warn('[pf-savewindow-call] enforcerToggle sending saveWindowConfig', { windowId: win.id, updates: { limitsEnabled: this.checked } });
        await chrome.runtime.sendMessage({
          action: 'saveWindowConfig',
          windowId: win.id,
          updates: { limitsEnabled: this.checked }
        });
      }
      if (currentStep === 4) updateTutorNextState();
    };
  }
  const enforcerWrapper = document.getElementById('enforcerWrapper');
  const enforcerHelpText = document.getElementById('enforcerHelpText');
  let enforcerHelpTimeout;
  if (enforcerWrapper) {
    // WRAPPER CLICK-BLOCK REMOVED (2026-07): the wrapper's preventDefault
    // was silently swallowing legitimate toggle-OFF clicks when the
    // asymmetric-direction check misread the post-toggle checked state
    // (Chrome updates checkbox.checked before OR after the click handler
    // depending on which element inside the wrapper was clicked, so
    // reading it here is unreliable). The onchange handler on the
    // checkbox itself is the authoritative gate — it correctly blocks
    // only ON-direction attempts while spend is active.
    enforcerWrapper.addEventListener('click', () => {
      // No toast for the spend lock — it has its own persistent grayed-out
      // state plus the static explanatory note below the control.
    });
    enforcerWrapper.addEventListener('animationend', () => {
      enforcerWrapper.classList.remove('apply-shake');
    });
  }

  document.querySelectorAll('input, input[type="checkbox"], select').forEach(el => {
    if (!['newUnprodKeyword', 'newProdKeyword', 'maxTabLimit', 'pauseDuration', 'enablePause', 'enableLimits', 'enforcerToggle'].includes(el.id)) {
      el.onchange = async () => {
        await autoSave();
        if (currentStep === 4) updateTutorNextState();
      };
    }
  });

  // Safety net: ensure the dashboard loading overlay (which hides the
  // Start/Stop timer buttons via visibility:hidden) can never get stuck on,
  // even if a render step below throws before reaching the clear line.
  // 4s is well past normal first paint but short enough that a stuck spinner
  // is replaced before the user gives up.
  if (window.__pfDashLoadingSafety) clearTimeout(window.__pfDashLoadingSafety);
  window.__pfDashLoadingSafety = setTimeout(() => {
    document.documentElement.classList.remove('pf-dash-loading');
  }, 4000);
  // Safety net for the black tutorial-preload overlay too: if the render/
  // runTutorial chain stalls or rejects without reaching the clear below, drop
  // the overlay so the user is never trapped on a black screen. 6s gives the
  // tutorial first-step plenty of time to paint normally.
  if (window.__pfTutorialPreloadSafety) clearTimeout(window.__pfTutorialPreloadSafety);
  window.__pfTutorialPreloadSafety = setTimeout(() => {
    document.documentElement.classList.remove('tutorial-preload');
  }, 6000);

  checkSignInStatus().then(async (user) => {
    currentUser = user;
    try {
      updateProfileAvatar();
      await renderAuthUI();
      initProfilePanel();
      await render();
    } catch (err) {
      console.error('[pf-dashboard] initial auth/render failed; UI left in non-fatal state', err);
    } finally {
      // Clear the loading overlay once auth is known. If the user is NOT signed
      // in, keep the loader up a bit longer so they see a connecting state until
      // the sign-in option is surfaced (renderAuthUI shows the sign-in button).
      // The safety timeout below always clears it so nobody is trapped.
      const signedIn = !!currentUser?.email;
      if (signedIn) {
        document.documentElement.classList.remove('pf-dash-loading');
      } else {
        // Not signed in — show the dashboard behind the loader only once the
        // sign-in UI is ready, then drop the loader shortly after so the user
        // can reach the sign-in button. renderAuthUI has already run above.
        setTimeout(() => {
          document.documentElement.classList.remove('pf-dash-loading');
        }, 800);
      }
    }
    console.info('[pf-dash-perf] data ready, painting', { t: performance.now() });
    dashboardDisplayReady = true;
    try {
      await refreshDashboardDisplay();
    } catch (err) {
      console.error('[pf-dashboard] refreshDashboardDisplay failed', err);
    }
    try {
      startDashboardDisplayPoll();
    } catch (err) {
      console.error('[pf-dashboard] startDashboardDisplayPoll failed', err);
    }
    try {
      // FIRST-RUN PARITY (user spec 2026-07: "take the reset-tutorial flow
      // and use it for the first-time one"). The dev reset flow preps the
      // DOM before starting (resetTutorialDomState, window tab, demo
      // visibility) and renders every step correctly; the boot path called
      // bare runTutorial() with none of that prep — which is why layout
      // bugs kept appearing ONLY on genuine first installs. There is now
      // exactly ONE way a tutorial starts.
      if (!(await isTutorialCompleted())) {
        try {
          cleanupTutorialExtras();
          clearTutorialHighlight();
          resetTutorialInMemoryState();
          resetTutorialDomState();
          switchMainTab('window', { force: true });
          await updateRankingModeDemoVisibility();
        } catch (prepErr) {
          console.warn('[pf-tutor] first-run prep failed (continuing)', prepErr);
        }
      }
      await runTutorial();
    } catch (err) {
      console.error('[pf-tutor] runTutorial failed after render:', err);
    }
    // runTutorial() has now decided whether to show the tutorial. showTutorial()
    // clears 'tutorial-preload' itself right as it reveals the polished first
    // step; for every other path (tutorial already complete, skipped, or a
    // post-signin step) clear it here so the black preload overlay never lingers.
    document.documentElement.classList.remove('tutorial-preload');
    loadMouseClicksFromStorage().catch(() => {});
    loadTypingDataFromStorage().catch(() => {});
  }).catch((err) => {
    // If checkSignInStatus itself rejects, still clear BOTH overlays so the
    // dashboard is usable, the Start/Stop buttons are visible, and the user is
    // not stuck on the black preload screen.
    console.error('[pf-dashboard] checkSignInStatus rejected; clearing loading overlay', err);
    document.documentElement.classList.remove('pf-dash-loading');
    document.documentElement.classList.remove('tutorial-preload');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.pfSyncUserNotice?.newValue?.message) {
      showDashboardToast(changes.pfSyncUserNotice.newValue.message, 'error');
    }
    if (changes.pfSession || changes.pfUserDisplayName) {
      refreshAuthFromStorage().catch((e) => {
        console.warn('[pf-dashboard] refreshAuthFromStorage failed', e);
      });
    }
    if (
      changes.focusedTimeBank || changes.bankedProgress
      || changes.studyBreakAvailable || changes.studyBreakActive || changes.studyBreakRemaining
      || changes.bankedReward || changes.bankSpendActive || changes.bankSpendRemaining
      || changes.bankSpendPaused
    ) {
      console.log('[pf-stats-ui] storage update detected, scheduling display refresh...');
      scheduleDashboardStorageRefresh();
    }
    if (
      changes.bankSpendActive || changes.bankSpendPaused || changes.bankSpendRemaining
      // Also re-evaluate the Work Timer / Advanced Earn-Spend lock when the
      // FOCUS cycle state changes (user report 2026-07: "even though I have
      // stopped the advanced earn/spend timer the work timer seems to still
      // be grayed out"). The lock reads bankSpendActive, but the focus→spend
      // hand-off and the focus-end path flip bankFocusActive first; without
      // this the lock stayed stale until the next 1s poll tick.
      || changes.bankFocusActive || changes.bankFocusPaused
    ) {
      lastToggleLockSignature = null; // bypass the idempotency cache — state genuinely changed
      refreshCloserToggleUI().catch((e) => {
        console.warn('[pf-dashboard] refreshCloserToggleUI failed', e);
      });
    }
    if (changes.dailyLogs || changes.dailySiteLogs || changes.currentStreak) {
      chrome.storage.local.get(['currentStreak', 'dailyLogs', 'dailySiteLogs']).then(refreshStreakDisplay);
    }
    if (changes.windowConfigs) {
      refreshCloserToggleUI().catch((e) => {
        console.warn('[pf-dashboard] refreshCloserToggleUI failed', e);
      });
      // Re-enforce the Advanced Settings lock whenever sync mutates
      // windowConfigs — a cloud restore (pfPullSettingsFromProfile /
      // syncPullOnSignin) can land advancedBankedTimeEnabled:true between
      // ticks, and the authoritative-lock path inside pfSyncAdvancedSettingsLock
      // corrects it back to false while the lock is active (user report
      // 2026-07: "advanced earn/spend immediately turned on when I just
      // signed in and can't even access it yet").
      pfSyncAdvancedSettingsLock().catch(() => {});
    }
    if (changes.mouseClicks) {
      mouseClicks = changes.mouseClicks.newValue || [];
      updateMouseStats();
    }
    if (changes.dailyWPMData) {
      const newData = changes.dailyWPMData.newValue;
      dailyWPMDataState = newData != null ? newData : {};

      if (!wpmRedrawPending) {
        wpmRedrawPending = true;
        requestAnimationFrame(() => {
          try {
            drawTypingChart();
            updateTypingStats();
            updateCurrentWPM();
          } catch (e) {
            console.error('[pf-wpm] redraw failed:', e);
          } finally {
            wpmRedrawPending = false;
          }
        });
      }
    }
  });
  const rankingModeWebsiteLabel = $('rankingModeWebsite')?.closest('label');
  if (rankingModeWebsiteLabel && rankingModeWebsiteLabel.dataset.tutorialGuard !== '1') {
    rankingModeWebsiteLabel.dataset.tutorialGuard = '1';
    rankingModeWebsiteLabel.addEventListener('click', (e) => {
      if (!isTutorialRankingPerTabOnlyStep()) return;
      e.preventDefault();
      e.stopPropagation();
      blockTutorialPerWebsiteRankingMode();
    }, true);
  }
  ['rankingModeTab', 'rankingModeWebsite'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
      if (isTutorialRankingPerTabOnlyStep() && id === 'rankingModeWebsite') {
        blockTutorialPerWebsiteRankingMode();
        return;
      }
      updateWipeTabTimesVisibility();
      syncRankingModeDemo();
      void applyRankingModeChange();
    });
  });
  ['autoCloseDashboard', 'autoShieldPopouts', 'autoCloseAutoTabs'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { void autoSave(id); });
  });
  const autoCloseChevron = $('autoCloseDashboardChevron');
  const autoClosePanel = $('autoCloseDashboardPanel');
  if (autoCloseChevron && autoClosePanel) {
    const autoCloseChevronIcon = autoCloseChevron.querySelector('.pf-auto-close-chevron');
    autoCloseChevron.addEventListener('click', () => {
      const open = autoCloseChevron.getAttribute('aria-expanded') === 'true';
      const nextOpen = !open;
      autoCloseChevron.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      autoClosePanel.style.display = nextOpen ? 'block' : 'none';
      if (autoCloseChevronIcon) autoCloseChevronIcon.textContent = nextOpen ? '▲' : '▼';
    });
  }
  bindInlineHelpPanels();
  initRankingModeDemoShell();
  void initSettingDemos();
  bindAdvancedEarnSpendChevron();
  ['studyBreakEnabled'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
      // Mutual exclusivity: turning Study Break ON turns Advanced Earn/Spend OFF
      // (only one break-time feature can be active at once).
      if (id === 'studyBreakEnabled' && el.checked) {
        const modeB = $('enableBankedTimeModeB');
        if (modeB?.checked) {
          modeB.checked = false;
          void saveModeBEarnSpendSettings();
        }
      }
      void saveStudyBreakSettings();
      if (id === 'studyBreakEnabled') void refreshSettingDemoVisibility('studyBreak');
    });
  });
  ['studyBreakEveryTime', 'studyBreakEarnTime'].forEach((hiddenId) => {
    const box = getTimerHmsEl(hiddenId);
    if (!box || box.dataset.studyBreakBound === '1') return;
    box.dataset.studyBreakBound = '1';
    box.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        syncTimerHiddenFromHms(hiddenId);
        void saveStudyBreakSettings();
        void refreshSettingDemoVisibility('studyBreak');
      });
    });
  });
  ['bankSourceSitesInput'].forEach((id) => initModeBSitePillField(id));
  ['enableBankedTimeModeB', 'bankSourceSitesInput'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', async () => {
      if (id === 'enableBankedTimeModeB') {
        // Mutual exclusivity: turning Advanced Earn/Spend ON turns Study Break
        // OFF (only one break-time feature can be active at once).
        if ($('enableBankedTimeModeB')?.checked) {
          const sb = $('studyBreakEnabled');
          if (sb?.checked) {
            sb.checked = false;
            void saveStudyBreakSettings();
          }
        }
        // Apply the gray-out INSTANTLY from the checkbox state — before the
        // save/refresh round-trips — so the user sees the lock/unlock the
        // moment they click, even on a cold service worker. The checkbox has
        // already flipped by the time 'change' fires.
        applyAdvancedEarnLock();
      }
      await saveModeBEarnSpendSettings();
      if (id === 'enableBankedTimeModeB') {
        void refreshSettingDemoVisibility('modeBEarnSpend');
        // Force the lock signature cache to invalidate so refreshCloserToggleUI
        // ALWAYS re-applies the disabled/opacity attrs on the next call —
        // otherwise the cached signature could (rarely) match the previous
        // lock state and skip the unlock render, leaving the UI looking
        // locked even after the toggle turned advanced earn off.
        lastToggleLockSignature = null;
        // Re-evaluate the lock state so toggling advanced earn OFF re-enables
        // the study timers / enforcer toggle / study break settings. Await the
        // save first so refreshCloserToggleUI reads the NEW config from storage.
        await refreshCloserToggleUI();
        // Also re-render the study-break Use button — it has its own
        // independent disabled state managed by renderStudyBreakUI, so a
        // refreshCloserToggleUI alone isn't enough to flip the Use button
        // visually until renderStudyBreakUI happens to fire from another
        // path. Force it here so the gray-out (or un-gray) is INSTANT.
        try {
          const win = await chrome.windows.getCurrent().catch(() => null);
          const wn = win?.id ? await resolveWindowName(win.id) : null;
          if (wn) await renderStudyBreakUI(wn);
        } catch (_) {}
        // A second pass after a short delay catches the case where bankSpendActive
        // teardown (triggered by cancelBankSpendMode in saveModeBEarnSpendSettings)
        // hasn't propagated yet by the time the first refresh ran.
        setTimeout(() => {
          lastToggleLockSignature = null;
          refreshCloserToggleUI().catch(() => {});
          // Mirror the renderStudyBreakUI call in the second pass so the
          // Use button definitely picks up the final lock state even if
          // the storage write hadn't propagated by the first pass.
          (async () => {
            try {
              const win = await chrome.windows.getCurrent().catch(() => null);
              const wn = win?.id ? await resolveWindowName(win.id) : null;
              if (wn) await renderStudyBreakUI(wn);
            } catch (_) {}
          })();
        }, 250);
      }
    });
  });
  ['bankFocusTimeModeB', 'bankEarnedTimeModeB'].forEach((hiddenId) => {
    const box = getTimerHmsEl(hiddenId);
    if (!box || box.dataset.modeBBound === '1') return;
    box.dataset.modeBBound = '1';
    box.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        syncTimerHiddenFromHms(hiddenId);
        void saveModeBEarnSpendSettings();
        void refreshSettingDemoVisibility('modeBEarnSpend');
      });
    });
  });
  // Start-timer buttons for Advanced Earn/Spend. Both buttons kick off the SAME
  // study session using the configured "Every X on source" duration — they're
  // labeled to feel natural after each of the two time-input sentences. Pause,
  // Cancel, and Use buttons were removed; earned time now auto-spends when the
  // user visits an unproductive tab.
  const startBankEarnHandler = async () => {
    // Auto-enable on Start (user spec 2026-07): clicking "Start timer"
    // means the user wants Advanced Earn/Spend ON — don't make them also
    // find the checkbox. Runs the SAME flow as ticking the box by hand
    // (Study Break exclusivity, save, lock refresh), and AWAITS the save
    // so the worker reads advancedBankedTimeEnabled=true before the timer
    // starts — otherwise the earn ring/timer never shows on source sites.
    const enableBox = $('enableBankedTimeModeB');
    if (enableBox && !enableBox.checked) {
      enableBox.checked = true;
      const sb = $('studyBreakEnabled');
      if (sb?.checked) {
        sb.checked = false;
        void saveStudyBreakSettings();
      }
      applyAdvancedEarnLock();
      await saveModeBEarnSpendSettings();
      lastToggleLockSignature = null;
      void refreshSettingDemoVisibility('modeBEarnSpend');
    }
    const wid = await getCurrentWindowIdForTimer();
    if (wid == null) return;
    const windowName = await resolveWindowName(wid);
    if (!windowName) return;
    // OPTIMISTIC swap (user report 2026-07: "stop timer sometimes doesn't
    // come up"): flip Start→Stop immediately on click, before any of the
    // async work below — and suppress the 1s reconcile briefly so it can't
    // stomp the swap before the worker's storage write lands. If the start
    // ultimately fails, the reconcile restores idle within a second.
    pfModeBOptimisticUntil = Date.now() + 2500;
    // Sticky Stop — user just started a session, keep the Stop button
    // visible through every transition until they explicitly click Stop.
    window.pfModeBStickySet();
    applyModeBEarnButtonState('running');
    // Mutual exclusivity, other direction: a running Work Timer session is
    // stopped by the worker inside startBankFocusMode ('focus-timer-override');
    // reflect that in the Study Break buttons immediately.
    try { applyStudyBreakButtonState('idle'); } catch (_) {}
    // Read the configured source-focus duration ("Every X on source") and the
    // earned break duration ("earn Y of spend time"). Both come from the same
    // Advanced Earn/Spend card. Sending startBankFocusMode (not the generic
    // startStudyTimerWithDuration) ensures the credit lands in bankedReward
    // ("Spend time available") — the generic study path credits a different
    // store and was the root cause of "time never appears".
    syncTimerHiddenFromHms('bankFocusTimeModeB');
    syncTimerHiddenFromHms('bankEarnedTimeModeB');
    const focusHms = ($('bankFocusTimeModeB') || {}).value || '0:15:00';
    const focusParts = String(focusHms).split(':').map((n) => Math.max(0, Math.floor(Number(n) || 0)));
    while (focusParts.length < 3) focusParts.unshift(0);
    const earnHms = ($('bankEarnedTimeModeB') || {}).value || '0:05:00';
    const earnParts = String(earnHms).split(':').map((n) => Math.max(0, Math.floor(Number(n) || 0)));
    while (earnParts.length < 3) earnParts.unshift(0);
    // 1-second floor: user reported the previous 60s floor rounded sub-minute
    // configs up to 1 min. The tick fires every 1s, so 1s is the true minimum.
    const focusSec = Math.max(1, focusParts[0] * 3600 + focusParts[1] * 60 + focusParts[2]);
    const earnSec = Math.max(0, earnParts[0] * 3600 + earnParts[1] * 60 + earnParts[2]);
    await chrome.runtime.sendMessage({
      action: 'startBankFocusMode',
      windowId: wid,
      windowName,
      focusSec,
      earnSec
    }).catch(() => {});
    // Error-proofed tail: a throw in either refresh must never leave the
    // buttons un-swapped (the optimistic set above + 1s reconcile cover it,
    // but don't let one failure skip the other refresh either).
    try { await renderModeBSpendUI(windowName); } catch (_) {}
    try { await refreshCloserToggleUI(); } catch (_) {}
  };
  const modeBStartEarnBtn = $('modeBStartEarnBtn');
  if (modeBStartEarnBtn) modeBStartEarnBtn.addEventListener('click', startBankEarnHandler);

  // Advanced Earn/Spend Start / Stop wire-up. Per user spec 2026-07 v34:
  //   • Start Timer button STAYS VISIBLE the whole time — it functions as an
  //     "on" indicator. Clickable when idle; when running, gets an `pf-btn-on`
  //     class + `disabled` so it visually reads as "on" and can't be
  //     re-clicked (already running).
  //   • Stop Timer appears alongside Start whenever a session is active
  //     (running or paused). Pressing Stop returns everything to normal —
  //     Start goes back to its clickable idle look, Stop hides.
  //   • Pause / Resume buttons removed for this timer (Study Break still has
  //     them via applyStudyBreakButtonState below — this change is scoped
  //     to Advanced Earn/Spend only).
  const applyModeBEarnButtonState = (state) => {
    if (state === true) state = 'running';
    else if (state === false || state == null) state = 'idle';
    const startBtn = document.getElementById('modeBStartEarnBtn');
    const pauseBtn = document.getElementById('modeBPauseEarnBtn');
    const resumeBtn = document.getElementById('modeBResumeEarnBtn');
    const stopBtn = document.getElementById('modeBStopEarnBtn');
    // Per user spec 2026-07: mirror the Work Timer — when running ONLY Stop
    // is visible (Start is hidden, not just disabled); when idle ONLY Start
    // is visible. Previously Start was always shown and just disabled, which
    // read as "two start-ish buttons side by side" while the timer ran.
    const isOn = state === 'running' || state === 'paused';
    if (startBtn) {
      startBtn.hidden = isOn;
      startBtn.classList.remove('pf-btn-on');
      startBtn.removeAttribute('disabled');
      startBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    // Pause / Resume no longer used here — force-hide in case they exist.
    if (pauseBtn) pauseBtn.hidden = true;
    if (resumeBtn) resumeBtn.hidden = true;
    if (stopBtn) stopBtn.hidden = !isOn;
  };
  // Expose to renderModeBSpendUI (defined later) via a module-scope handle.
  window.__pfApplyModeBEarnButtonState = applyModeBEarnButtonState;

  // NUCLEAR force-terminate for Advanced Earn/Spend. Wipes spend + focus
  // state for EVERY windowName that has an active session, not just the
  // dashboard's current window. User report 2026-07 v59: previous fixes
  // only targeted getCurrentWindowIdForTimer()'s windowName, but the
  // dashboard can live in a DIFFERENT window from the one running the
  // Adv Earn/Spend session — so wiping the dashboard's windowName was a
  // no-op. This iterates every window with active spend/focus and
  // cancels each one individually.
  async function pfNuclearStopAdvEarnSpend() {
    try { window.pfModeBStickyClear?.(); } catch (_) {}
    const stored = await chrome.storage.local.get([
      'windowConfigs', 'bankSpendActive', 'bankSpendRemaining',
      'bankSpendTotal', 'bankSpendPaused', 'bankSpendSourceHost',
      'bankFocusActive', 'bankFocusRemaining', 'bankFocusTotal',
      'bankFocusStartAt', 'bankFocusPaused', 'bankFocusEarnSec',
      'bankedProgress'
    ]);
    // Collect every windowName that has ANY active adv-earn/spend state.
    const advSpendNames = new Set();
    const focusNames = new Set();
    for (const [wn, active] of Object.entries(stored.bankSpendActive || {})) {
      if (active && (stored.bankSpendSourceHost?.[wn] || '') !== 'study_break') {
        advSpendNames.add(wn);
      }
    }
    for (const [wn, active] of Object.entries(stored.bankFocusActive || {})) {
      if (active) focusNames.add(wn);
    }
    const allNames = new Set([...advSpendNames, ...focusNames]);
    // Also include any window with advancedBankedTimeEnabled=true, so we
    // definitively turn the feature off even if no session is active.
    const wc = { ...(stored.windowConfigs || {}) };
    for (const [wn, cfg] of Object.entries(wc)) {
      if (cfg?.advancedBankedTimeEnabled === true) allNames.add(wn);
    }
    if (allNames.size === 0) return;
    // Build wiped maps directly.
    const wipe = (mapName) => {
      const src = stored[mapName] || {};
      const out = { ...src };
      for (const wn of allNames) delete out[wn];
      return out;
    };
    for (const wn of allNames) {
      if (wc[wn]) wc[wn] = { ...wc[wn], advancedBankedTimeEnabled: false };
    }
    await chrome.storage.local.set({
      windowConfigs: wc,
      bankSpendActive: wipe('bankSpendActive'),
      bankSpendRemaining: wipe('bankSpendRemaining'),
      bankSpendTotal: wipe('bankSpendTotal'),
      bankSpendPaused: wipe('bankSpendPaused'),
      bankSpendSourceHost: wipe('bankSpendSourceHost'),
      bankFocusActive: wipe('bankFocusActive'),
      bankFocusRemaining: wipe('bankFocusRemaining'),
      bankFocusTotal: wipe('bankFocusTotal'),
      bankFocusStartAt: wipe('bankFocusStartAt'),
      bankFocusPaused: wipe('bankFocusPaused'),
      bankFocusEarnSec: wipe('bankFocusEarnSec'),
      bankedProgress: wipe('bankedProgress'),
    });
    // Fire cancel messages for EACH affected window so the worker's
    // per-window state (cooldown timestamp, refund routing) runs. The
    // worker resolves windowId from windowName internally, so we can
    // send windowName alone.
    for (const wn of allNames) {
      await chrome.runtime.sendMessage({ action: 'cancelBankSpendMode', windowName: wn }).catch(() => {});
      await chrome.runtime.sendMessage({ action: 'cancelBankFocusMode', windowName: wn }).catch(() => {});
    }
    // Tear down any lingering popups across every tab (the dismiss handler
    // needs a windowId; iterate all windows).
    try {
      const wins = await chrome.windows.getAll();
      for (const w of wins) {
        await chrome.runtime.sendMessage({ action: 'dismissAllPrompts', windowId: w.id }).catch(() => {});
      }
    } catch (_) {}
    try { await chrome.runtime.sendMessage({ action: 'broadcastCloserState' }); } catch (_) {}
  }
  window.pfNuclearStopAdvEarnSpend = pfNuclearStopAdvEarnSpend;

  const modeBStopEarnBtn = $('modeBStopEarnBtn');
  if (modeBStopEarnBtn) modeBStopEarnBtn.addEventListener('click', async () => {
    // v59: NUCLEAR force-terminate FIRST — wipes every window that has
    // adv-earn/spend state, before anything else runs. Fixes the case
    // where the dashboard's current window != the window running the
    // timer (windowName mismatch made every prior fix a no-op).
    try { await pfNuclearStopAdvEarnSpend(); } catch (_) {}
    // Clear sticky-Stop flag: user is explicitly ending the session.
    window.pfModeBStickyClear();
    const wid = await getCurrentWindowIdForTimer();
    if (wid == null) return;
    const windowName = await resolveWindowName(wid);
    if (!windowName) return;
    // Dismiss any "your time is up" / cycle-complete popup covering the
    // active site tab — the dashboard Stop button is the on/off the user
    // expects to clear it (user report 2026-07).
    await chrome.runtime.sendMessage({ action: 'dismissAllPrompts', windowId: wid }).catch(() => {});
    // Clear the lock idempotency cache so the refreshCloserToggleUI() calls
    // below actually re-style the Work Timer card (user report 2026-07:
    // "even though I have stopped the advanced earn/spend timer the work
    // timer seems to still be grayed out"). Without this, a stale "locked"
    // signature can short-circuit the refresh and leave the card grayed.
    lastToggleLockSignature = null;
    // User spec 2026-07 v40: hitting Stop must stop EVERYTHING Advanced
    // Earn/Spend — active spend session, active focus session, dwell
    // auto-restart counter, source-tab widgets/overlays, cycle-complete
    // popups. Runs BOTH cancel paths (no early return) and clears the
    // feature flag so no future ticks resurrect anything.
    //
    // User report 2026-07 v58: "the stop timer is still not working for
    // advanced earn/spend while the timer is on break mode". Even after
    // sending cancel messages, the break kept ticking. Belt-and-braces
    // approach — write the disable + wipe DIRECTLY from client storage
    // FIRST so the next worker tick (which happens ~1s later) sees the
    // feature off + spend cleared, regardless of whether the cancel
    // messages get processed in time.
    try {
      const wcStored = await chrome.storage.local.get([
        'windowConfigs', 'bankSpendActive', 'bankSpendRemaining',
        'bankSpendTotal', 'bankSpendPaused', 'bankFocusActive',
        'bankFocusRemaining', 'bankFocusPaused'
      ]);
      const wc = { ...(wcStored.windowConfigs || {}) };
      if (wc[windowName]) {
        wc[windowName] = { ...wc[windowName], advancedBankedTimeEnabled: false };
      }
      const wipe = (mapName) => {
        const m = { ...(wcStored[mapName] || {}) };
        if (windowName in m) delete m[windowName];
        return m;
      };
      await chrome.storage.local.set({
        windowConfigs: wc,
        bankSpendActive: wipe('bankSpendActive'),
        bankSpendRemaining: wipe('bankSpendRemaining'),
        bankSpendTotal: wipe('bankSpendTotal'),
        bankSpendPaused: wipe('bankSpendPaused'),
        bankFocusActive: wipe('bankFocusActive'),
        bankFocusRemaining: wipe('bankFocusRemaining'),
        bankFocusPaused: wipe('bankFocusPaused'),
      });
    } catch (_) { /* best-effort — cancels below still run */ }
    // Spend cancel MUST run before focus cancel so refundAndEndBankSpend
    // credits the remainder to bankedReward — clearing focus first would
    // let the tick hit the `spendActive && !focusActive` no-refund branch.
    // Both sends are unconditional (fix v57).
    await chrome.runtime.sendMessage({
      action: 'cancelBankSpendMode', windowId: wid, windowName
    }).catch(() => {});
    await chrome.runtime.sendMessage({
      action: 'cancelBankFocusMode', windowId: wid, windowName
    }).catch(() => {});
    // Dismiss any lingering source-tab overlays / earn-timer widgets /
    // cycle-complete popup that were tied to the session.
    await chrome.runtime.sendMessage({ action: 'dismissAllPrompts', windowId: wid }).catch(() => {});
    // Turn the feature flag OFF (Start = on, Stop = OFF, per v34 design).
    // Dispatch 'change' so the FULL disable flow runs: save, release locks
    // on Work Timer / closer toggle / demos, delayed second pass. Also
    // clears passive drain, dwell auto-restart, and source-blocker overlays.
    const enableBox = $('enableBankedTimeModeB');
    if (enableBox && enableBox.checked) {
      enableBox.checked = false;
      enableBox.dispatchEvent(new Event('change'));
    }
    applyModeBEarnButtonState('idle');
    await renderModeBSpendUI(windowName);
    await refreshCloserToggleUI();
    // Force a fresh broadcast so every content script (source-tab
    // widgets, dwell banners, closer indicators) sees the cleared state
    // within the next tick instead of waiting up to 1 s.
    try { await chrome.runtime.sendMessage({ action: 'broadcastCloserState' }); } catch (_) {}
  });

  // (Advanced earn/spend Pause/Resume removed — user spec 2026-07.)

  // Study Break: Start timer button — parallels advanced earn/spend by kicking
  // off a study session using the configured "Every X" (studyBreakEveryTime)
  // duration. Same mechanism, different config source.
  // Study Break Start/Stop button pair. The Enable checkbox was removed —
  // clicking Start turns the feature on implicitly; clicking Stop turns it
  // off. Per user spec 2026-07.
  // Study Break button state machine — expose one of four states:
  //   'idle'    → Start only
  //   'running' → Pause + Stop
  //   'paused'  → Resume + Stop
  // The `true`/`false` legacy signature (running:bool) is still accepted
  // for older callers; internally it maps to 'running' / 'idle'.
  const applyStudyBreakButtonState = (state) => {
    if (state === true) state = 'running';
    else if (state === false || state == null) state = 'idle';
    const startBtn = document.getElementById('studyBreakStartBtn');
    const pauseBtn = document.getElementById('studyBreakPauseBtn');
    const resumeBtn = document.getElementById('studyBreakResumeBtn');
    const stopBtn = document.getElementById('studyBreakStopBtn');
    const showStart = state === 'idle';
    const showPause = state === 'running';
    const showResume = state === 'paused';
    const showStop = state === 'running' || state === 'paused';
    if (startBtn) startBtn.hidden = !showStart;
    if (pauseBtn) pauseBtn.hidden = !showPause;
    if (resumeBtn) resumeBtn.hidden = !showResume;
    if (stopBtn) stopBtn.hidden = !showStop;
  };
  const studyBreakStartBtn = $('studyBreakStartBtn');
  if (studyBreakStartBtn) {
    studyBreakStartBtn.addEventListener('click', async () => {
      const wid = await getCurrentWindowIdForTimer();
      if (wid == null) return;
      const windowName = await resolveWindowName(wid);
      if (!windowName) return;
      // MUTUAL EXCLUSIVITY TAKEOVER (user spec 2026-07): starting the Work
      // Timer while Advanced Earn/Spend is on shuts advanced down first —
      // cancel any running earn cycle, persist advancedBankedTimeEnabled=false
      // (awaited so the worker never sees both on), and release the locks.
      const advBox = $('enableBankedTimeModeB');
      if (advBox?.checked) {
        await chrome.runtime.sendMessage({
          action: 'cancelBankFocusMode', windowId: wid, windowName
        }).catch(() => {});
        advBox.checked = false;
        await saveModeBEarnSpendSettings();
        applyAdvancedEarnLock(false);
        lastToggleLockSignature = null;
        applyModeBEarnButtonState('idle');
        void refreshSettingDemoVisibility('modeBEarnSpend');
        await renderModeBSpendUI(windowName).catch?.(() => {});
      }
      // Turn on the Study Break feature flag so per-tick earning credits.
      const enableCheckbox = $('studyBreakEnabled');
      if (enableCheckbox && !enableCheckbox.checked) {
        enableCheckbox.checked = true;
        void saveStudyBreakSettings();
      }
      syncTimerHiddenFromHms('studyBreakEveryTime');
      const focusHms = ($('studyBreakEveryTime') || {}).value || '0:25:00';
      const focusParts = String(focusHms).split(':').map((n) => Math.max(0, Math.floor(Number(n) || 0)));
      while (focusParts.length < 3) focusParts.unshift(0);
      // 1-second floor: the wall-clock tick fires every 1s.
      const focusSec = Math.max(1, focusParts[0] * 3600 + focusParts[1] * 60 + focusParts[2]);
      // Optimistic swap BEFORE the round-trip, mirroring the advanced card.
      applyStudyBreakButtonState(true);
      await chrome.runtime.sendMessage({
        action: 'startStudyTimerWithDuration',
        windowId: wid,
        durationSec: focusSec,
        originalInput: focusHms
      }).catch(() => {});
      applyStudyBreakButtonState(true); // re-assert after any config refresh
      try { await refreshCloserToggleUI(); } catch (_) {}
    });
  }
  const studyBreakStopBtn = document.getElementById('studyBreakStopBtn');
  if (studyBreakStopBtn) {
    let stopInFlight = false;
    studyBreakStopBtn.addEventListener('click', async () => {
      console.warn('[pf-worktimer-stop] Stop click fired', { stopInFlight, ts: Date.now() });
      if (stopInFlight) return;
      stopInFlight = true;
      // Safety net (user report 2026-07 v43: "hitting stop timer on the work
      // timer and nothing's happening"). If ANY await in this handler hangs
      // (SW cold-start, ensureReady blocking, message channel disconnect),
      // the finally block never runs and stopInFlight stays true forever —
      // permanently disabling the Stop button. A 5s hard timeout guarantees
      // the guard resets so the user can click again.
      const stopInFlightTimeout = setTimeout(() => { stopInFlight = false; }, 5000);
      try {
      const wid = await getCurrentWindowIdForTimer();
      if (wid == null) return;
      // Dismiss any "your time is up" / cycle-complete popup covering the
      // active site tab — the dashboard Stop button is the on/off the user
      // expects to clear it (user report 2026-07).
      await chrome.runtime.sendMessage({ action: 'dismissAllPrompts', windowId: wid }).catch(() => {});
      // A running spend session (break)? Stopping it ends the break and
      // refunds the unused time. Two origins:
      //   • Work Timer break (bankSpendSourceHost === 'study_break') →
      //     refunds to studyBreakAvailable, feature stays on.
      //   • Adv Earn/Spend break (bankSpendSourceHost === '' or missing) →
      //     was previously NOT handled here (user report 2026-07 v58: "stop
      //     timer on dashboard is still not working" — user was clicking
      //     Work Timer's Stop, expecting it to end whatever was running).
      //     Now: any spend session cancels via cancelBankSpendMode
      //     regardless of origin, and Adv Earn/Spend also flips the
      //     advancedBankedTimeEnabled flag off so the tick doesn't
      //     auto-restart.
      // v59: if ANY window has an Adv Earn/Spend session running (not
      // just the dashboard's current window), nuke it before doing
      // anything else. Handles the windowName mismatch case that made
      // every prior fix silently no-op.
      try {
        const s = await chrome.storage.local.get(['bankSpendActive', 'bankSpendSourceHost', 'bankFocusActive']);
        const hasAdvSpend = Object.entries(s.bankSpendActive || {}).some(([n, a]) =>
          a && (s.bankSpendSourceHost?.[n] || '') !== 'study_break');
        const hasAdvFocus = Object.values(s.bankFocusActive || {}).some(Boolean);
        if (hasAdvSpend || hasAdvFocus) {
          if (typeof window.pfNuclearStopAdvEarnSpend === 'function') {
            await window.pfNuclearStopAdvEarnSpend();
          }
        }
      } catch (_) { /* best-effort — study-break path below still runs */ }
      const wn = await resolveWindowName(wid);
      if (wn) {
        const spendStored = await chrome.storage.local.get(['bankSpendActive', 'bankSpendSourceHost']);
        if (spendStored.bankSpendActive?.[wn]) {
          const isAdvSpend = spendStored.bankSpendSourceHost?.[wn] !== 'study_break';
          if (isAdvSpend) {
            // Direct storage wipe first (defense in depth — same pattern
            // as modeBStopEarnBtn), then send cancel messages.
            try {
              const s = await chrome.storage.local.get([
                'windowConfigs', 'bankSpendActive', 'bankSpendRemaining',
                'bankSpendTotal', 'bankSpendPaused', 'bankFocusActive',
                'bankFocusRemaining', 'bankFocusPaused'
              ]);
              const wc = { ...(s.windowConfigs || {}) };
              if (wc[wn]) wc[wn] = { ...wc[wn], advancedBankedTimeEnabled: false };
              const wipe = (k) => { const m = { ...(s[k] || {}) }; if (wn in m) delete m[wn]; return m; };
              await chrome.storage.local.set({
                windowConfigs: wc,
                bankSpendActive: wipe('bankSpendActive'),
                bankSpendRemaining: wipe('bankSpendRemaining'),
                bankSpendTotal: wipe('bankSpendTotal'),
                bankSpendPaused: wipe('bankSpendPaused'),
                bankFocusActive: wipe('bankFocusActive'),
                bankFocusRemaining: wipe('bankFocusRemaining'),
                bankFocusPaused: wipe('bankFocusPaused'),
              });
              window.pfModeBStickyClear?.();
            } catch (_) { /* best-effort */ }
          }
          await chrome.runtime.sendMessage({
            action: 'cancelBankSpendMode', windowId: wid, windowName: wn
          }).catch(() => {});
          if (isAdvSpend) {
            await chrome.runtime.sendMessage({
              action: 'cancelBankFocusMode', windowId: wid, windowName: wn
            }).catch(() => {});
            await chrome.runtime.sendMessage({ action: 'dismissAllPrompts', windowId: wid }).catch(() => {});
          }
          applyStudyBreakButtonState('idle');
          await renderStudyBreakUI(wn); // Break available updates with the refund
          await refreshCloserToggleUI();
          try { await chrome.runtime.sendMessage({ action: 'broadcastCloserState' }); } catch (_) {}
          // FALL-THROUGH FALLBACK (2026-07): keep going to the stopTimer path
          // below. Previously we `return`ed here, which meant if the spend
          // session was actually a ghost record but a live wall-clock STUDY
          // session was ALSO running (mutual-exclusivity race), the study
          // session kept ticking after the user clicked Stop (user report
          // 2026-07: "nothing happens, buttons don't change"). Calling
          // stopTimer twice is safe — the worker no-ops if there's nothing
          // to stop — so we always run the belt-and-braces stop.
        }
      }
      // Stop the running work/study timer AND flip the Study Break feature off.
      // Race the worker's stopTimer against a 3s timeout so we NEVER hang the
      // Stop button (user report 2026-07 v43, hit 3×: "hitting stop timer on
      // the work timer and nothing's happening"). A pure fire-and-forget
      // didn't reliably stop the timer (the worker message was sometimes lost
      // or the SW was asleep); a pure await could hang on ensureReady(). This
      // waits for confirmation so the timer ACTUALLY stops, then proceeds
      // regardless after 3s.
      const stopPromise = chrome.runtime.sendMessage({ action: 'stopTimer', windowId: wid }).catch(() => null);
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
      await Promise.race([stopPromise, timeoutPromise]);
      const enableCheckbox = $('studyBreakEnabled');
      if (enableCheckbox && enableCheckbox.checked) {
        enableCheckbox.checked = false;
        void saveStudyBreakSettings();
      }
      applyStudyBreakButtonState('idle');
      // User report 2026-07 v35: "click Stop timer on Work Timer, dashboard
      // doesn't update, timer still ticking down". Root cause: the
      // studyBreakStop click hit stopTimer on the worker and flipped this
      // card's own buttons to idle, but the SHARED study-timer card
      // (renderStudyTimerFromSnapshot) kept ticking because nothing in the
      // stop handler forced its re-render OR the Break available line. The
      // next scheduled per-second render eventually caught up, but users
      // see the countdown text drift down for another 1-2s and read that as
      // "Stop didn't work". Now we (a) force a broadcast + snapshot pull
      // so the study card flips to idle immediately, (b) re-render the
      // Work Timer card so Break available and the button state match
      // storage right now.
      await notifyTimerBroadcast().catch(() => {});
      if (wn) {
        try { await renderStudyBreakUI(wn); } catch (_) { /* best-effort */ }
      }
      try {
        const snap = await chrome.runtime.sendMessage({ action: 'getTimerSnapshot', windowId: wid }).catch(() => null);
        if (snap) await renderStudyTimerFromSnapshot(snap, wid);
      } catch (_) { /* best-effort — the tick will heal within 1s */ }
      await refreshCloserToggleUI();
      } finally { clearTimeout(stopInFlightTimeout); stopInFlight = false; }
    });
  }
  // Pause/Resume buttons REMOVED from both timers (user spec 2026-07):
  // the timers already auto-pause while the dashboard is focused, so the
  // manual pair was redundant. Start/Stop is the whole state machine now.
  const tabLifeLimitSelect = $('tabLifeLimit');
  if (tabLifeLimitSelect) {
    tabLifeLimitSelect.addEventListener('change', () => {
      void autoSave('tabLifeLimit');
      void refreshSettingDemoVisibility('tabLife');
    });
  }

  ['resetSessionCheck', 'enablePause', 'enableBankedTime', 'enableWipeTabTimes'].forEach(id => {
    const checkbox = $(id);
    if (!checkbox) return;
    const sectionMap = {
      resetSessionCheck: 'sessionResetSection',
      enablePause: 'pauseSection',
      enableBankedTime: 'bankedTimeSection',
      enableWipeTabTimes: 'wipeTabTimesSection'
    };
    const containerMap = {
      resetSessionCheck: 'sessionResetContainer',
      enablePause: 'pauseContainer',
      enableBankedTime: 'bankedTimeContainer',
      enableWipeTabTimes: 'wipeTabTimesContainer'
    };
    checkbox.addEventListener('change', () => {
      const section = $(sectionMap[id]);
      if (section) section.style.display = checkbox.checked ? 'block' : 'none';
      const container = containerMap[id] ? $(containerMap[id]) : null;
      if (container) {
        if (id === 'enableWipeTabTimes' && isTutorialWipeTabTimesStep()) {
          container.classList.remove('active');
          container.classList.add('inactive');
        } else {
          container.classList.toggle('active', checkbox.checked);
          container.classList.toggle('inactive', !checkbox.checked);
        }
      }
      if (id === 'resetSessionCheck') {
        if (!checkbox.checked) clearStartupSlotsDraftStatus();
        if (checkbox.checked) {
          void chrome.windows.getCurrent().then((win) => {
            chrome.runtime.sendMessage({ action: 'syncLastSessionTabs', windowId: win.id }).catch(() => {});
          });
        }
      }
      const demoId = {
        resetSessionCheck: 'sessionReset',
        enablePause: 'pause',
        enableBankedTime: 'bankedTime'
      }[id];
      if (demoId) void refreshSettingDemoVisibility(demoId);
      if (id === 'enableWipeTabTimes') {
        void maybeAdvanceTutorialWipeTabTimesStep();
      }
      autoSave(id);
    });
  });

  $('wipeTabTimesInterval')?.addEventListener('change', () => {
    updateWipeTabTimesAtRowState();
    void autoSave('wipeTabTimesInterval');
  });
  $('wipeTabTimesAt')?.addEventListener('change', () => {
    void autoSave('wipeTabTimesAt');
  });

});

// === WALL-CLOCK TIMERS (dashboard reads getTimerSnapshot only) ===
let wpmPollInterval = null;

function startWpmPoll() {
  if (wpmPollInterval) return;
  wpmPollInterval = setInterval(async () => {
    if (document.hidden || activeSubTab !== 'keyLogger') return;
    try {
      const wpmStored = await chrome.storage.local.get([
        'dailyWPMData', 'wpmSessionStart', 'wpmSessionKeys', 'wpmLastKeyAt'
      ]);
      dailyWPMDataState = wpmStored.dailyWPMData || {};
      // Compute a LIVE current WPM from the in-flight session, not just the
      // last written sample. This makes the "Current" number respond within
      // a second of typing instead of waiting for a sample flush.
      liveWpmSession = {
        start: Number(wpmStored.wpmSessionStart) || 0,
        keys: Number(wpmStored.wpmSessionKeys) || 0,
        lastKeyAt: Number(wpmStored.wpmLastKeyAt) || 0
      };
      updateCurrentWPM();
      updateTypingStats();
    } catch (_) { /* silent */ }
  }, 1000);
}

function stopWpmPoll() {
  if (!wpmPollInterval) return;
  clearInterval(wpmPollInterval);
  wpmPollInterval = null;
}

async function notifyTimerBroadcast() {
  await chrome.runtime.sendMessage({ action: 'broadcastCloserState' }).catch(() => {});
}

async function getMergedWindowConfig(windowId) {
  if (windowId == null) return {};
  const windowName = await getFriendlyWindowNameForTimer(windowId);
  const [resp, stored] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId }).catch(() => null),
    chrome.storage.local.get('windowConfigs')
  ]);
  const fromStorage = windowName ? (stored.windowConfigs?.[windowName] || {}) : {};
  return { ...fromStorage, ...(resp?.config || {}) };
}

async function logTimerTick(mode, remainingSec) {
  await chrome.runtime.sendMessage({
    action: 'logTimerTick',
    mode,
    remaining: remainingSec
  }).catch(() => {});
}

function formatSeconds(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function fetchTimerSnapshot(windowId) {
  if (windowId == null) return null;
  const resp = await chrome.runtime.sendMessage({ action: 'getTimerSnapshot', windowId }).catch(() => null);
  return resp?.success ? resp.snapshot : null;
}

async function getWallClockTimerUiFlags(windowId) {
  const snap = await fetchTimerSnapshot(windowId);
  const timerSessionActive = snap?.active === true;
  const timerActivelyRunning = timerSessionActive && !snap?.paused;
  // A break session should NOT lock the closer toggle / study buttons — breaks
  // are the reward phase and don't conflict with the closer. Only study/unprod
  // sessions lock the toggle.
  const timerMode = snap?.mode || null;
  return { snap, timerSessionActive, timerActivelyRunning, timerMode };
}

let dashboardTimerInterval = null;
let studySessionWasRunning = false;
let studyEndedFlashUntil = 0;
let breakSessionWasRunning = false;
let unprodWasPaused = false;

function startDashboardTimerPoll() {
  if (dashboardTimerInterval) clearInterval(dashboardTimerInterval);
  dashboardTimerInterval = setInterval(() => {
    if (document.hidden) return;
    void renderTimerUiFromSnapshot();
  }, 1000);
  void renderTimerUiFromSnapshot();
}

function stopDashboardTimerPoll() {
  if (dashboardTimerInterval) {
    clearInterval(dashboardTimerInterval);
    dashboardTimerInterval = null;
  }
}

function startUnprodPoll() {
  startDashboardTimerPoll();
}

function beginStudyTick() {
  startDashboardTimerPoll();
}

async function renderTimerUiFromSnapshot() {
  const wid = await getCurrentWindowIdForTimer();
  const snap = wid != null ? await fetchTimerSnapshot(wid) : null;
  await renderBreakTimerFromSnapshot(snap, wid);
  await renderStudyTimerFromSnapshot(snap, wid);
  await updateTimerMutualExclusivityUI(snap);
  // renderStudyTimerFromSnapshot and updateTimerMutualExclusivityUI both
  // unconditionally set startBtn.disabled based only on timer state, which
  // clobbers the Advanced Earn/Spend lock that refreshCloserToggleUI applies.
  // Force a re-apply (bypass the idempotency guard via the signature reset)
  // so the lock state always wins on every poll tick.
  lastToggleLockSignature = null;
  await refreshCloserToggleUI();
}

async function renderUnprodTimerTick() {
  await renderTimerUiFromSnapshot();
}

async function renderStudyTimerTick() {
  await renderTimerUiFromSnapshot();
}

function setBreakEnforcerUiLocked(locked) {
  if (!locked) {
    void refreshCloserToggleUI();
    return;
  }
  const enforcer = document.getElementById('enforcerToggle');
  if (!enforcer) return;
  if (locked) {
    enforcer.checked = false;
    enforcer.disabled = true;
    enforcer.style.opacity = '0.5';
    enforcer.setAttribute('aria-disabled', 'true');
    enforcer.setAttribute('aria-describedby', 'enforcerHelpText');
    const enforcerLabel = enforcer.parentElement;
    if (enforcerLabel) {
      enforcerLabel.style.opacity = '0.4';
      enforcerLabel.style.cursor = 'not-allowed';
    }
    const slider = document.getElementById('enforcerSlider');
    if (slider) slider.style.filter = 'grayscale(1)';
  } else {
    enforcer.disabled = false;
    enforcer.style.opacity = '1';
    enforcer.style.pointerEvents = '';
    enforcer.removeAttribute('aria-disabled');
    enforcer.removeAttribute('aria-describedby');
    const enforcerLabel = enforcer.parentElement;
    if (enforcerLabel) {
      enforcerLabel.style.opacity = '1';
      enforcerLabel.style.pointerEvents = '';
      enforcerLabel.style.cursor = 'pointer';
    }
    const slider = document.getElementById('enforcerSlider');
    if (slider) slider.style.filter = '';
  }
}

async function renderBreakTimerFromSnapshot(snap, wid) {
  const startBtn = document.getElementById('unprodTimerStartBtn');
  const pauseBtn = document.getElementById('unprodTimerPauseBtn');
  const cancelBtn = document.getElementById('unprodTimerCancelBtn');
  const statusEl = document.getElementById('unprodTimerStatus');
  const trackingEl = document.getElementById('unprodTimerTracking');
  if (!startBtn || !pauseBtn || !statusEl) return;

  const active = snap?.mode === 'break' && snap?.active;
  const remainingSec = Math.max(0, Number(snap?.remainingSec) || 0);
  const originalInput = snap?.originalInput || '';

  if (!active) {
    breakSessionWasRunning = false;
    unprodWasPaused = false;
    if (originalInput) writeTimerHmsFromString('unprodTimeLimit', originalInput);
    setTimerHmsDisabled('unprodTimeLimit', false);
    setTimerHmsRunningStyle('unprodTimeLimit', null);
    if (trackingEl) trackingEl.textContent = '';
    startBtn.style.display = '';
    startBtn.textContent = 'Start';
    pauseBtn.style.display = 'none';
    pauseBtn.textContent = 'Pause';
    pauseBtn.style.background = '#ff9800';
    if (cancelBtn) cancelBtn.style.display = 'none';
    statusEl.textContent = '';
    setBreakEnforcerUiLocked(false);
    return;
  }

  breakSessionWasRunning = true;
  writeTimerHmsFromSeconds('unprodTimeLimit', remainingSec);

  if (snap.paused) {
    if (!unprodWasPaused) {
      writeTimerHmsFromSeconds('unprodTimeLimit', remainingSec);
      unprodWasPaused = true;
    }
    setTimerHmsDisabled('unprodTimeLimit', false);
    setTimerHmsRunningStyle('unprodTimeLimit', 'paused');
    if (trackingEl) trackingEl.textContent = '';
    statusEl.textContent = '';
    startBtn.style.display = 'none';
    pauseBtn.style.display = '';
    // Show "Resume" when paused so the user can SEE the pause took effect.
    // Earlier we tried a single "⏸ Pause" label for both states but with
    // no visual change the user couldn't tell the click had registered and
    // would tap again — accidentally resuming. The label flip is the
    // affordance.
    pauseBtn.textContent = '▶ Resume';
    pauseBtn.style.background = '#4caf50';
    if (cancelBtn) cancelBtn.style.display = '';
  } else {
    unprodWasPaused = false;
    setTimerHmsDisabled('unprodTimeLimit', true);
    setTimerHmsRunningStyle('unprodTimeLimit', 'active');
    if (trackingEl) trackingEl.textContent = '⏱ Wall-clock break (counts on all sites)';
    if (trackingEl) trackingEl.style.color = '#6c757d';
    startBtn.style.display = 'none';
    pauseBtn.style.display = '';
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.style.background = '#ff9800';
    if (cancelBtn) cancelBtn.style.display = 'none';
    statusEl.textContent = `Break session: ${formatSeconds(remainingSec)} remaining`;
    void logTimerTick('unprod', remainingSec);
  }

  pauseBtn.style.minWidth = '110px';
  pauseBtn.style.textAlign = 'center';
  setBreakEnforcerUiLocked(true);
}

async function renderStudyTimerFromSnapshot(snap, wid) {
  const startBtn = document.getElementById('studyTimerStartBtn');
  const pauseBtn = document.getElementById('studyTimerPauseBtn');
  const resumeBtn = document.getElementById('studyTimerResumeBtn');
  const stopBtn = document.getElementById('studyTimerStopBtn');
  const statusEl = document.getElementById('studyTimerStatus');
  if (!startBtn || !statusEl || wid == null) return;

  // Local helper so we don't repeat the four .style.display lines. States:
  // 'idle' | 'running' | 'paused' — mirrors applyStudyBreakButtonState.
  const setStudyTimerBtnState = (state) => {
    const showStart = state === 'idle';
    const showPause = state === 'running';
    const showResume = state === 'paused';
    const showStop = state === 'running' || state === 'paused';
    startBtn.style.display = showStart ? '' : 'none';
    if (pauseBtn) pauseBtn.style.display = showPause ? '' : 'none';
    if (resumeBtn) resumeBtn.style.display = showResume ? '' : 'none';
    if (stopBtn) stopBtn.style.display = showStop ? '' : 'none';
  };

  if (Date.now() < studyEndedFlashUntil) {
    statusEl.textContent = 'Work/Study session ended';
    setStudyTimerBtnState('idle');
    return;
  }

  const active = snap?.mode === 'study' && snap?.active;
  const paused = active && !!snap?.paused;
  const remainingSec = Math.max(0, Number(snap?.remainingSec) || 0);
  const windowName = await getFriendlyWindowNameForTimer(wid);
  const config = await getMergedWindowConfig(wid);

  // SELF-HEALING BUTTON RECONCILE (user report 2026-07: "when I click start
  // the stop timer sometimes doesn't come up"): this renderer ticks every
  // second while the dashboard is open, so the Start/Stop sets on BOTH
  // timer cards are re-derived from the stored truth here — a missed
  // optimistic swap or a race with a slow worker heals within a second.
  await pfReconcileModeBButtonsFromStorage(windowName);

  if (!active) {
    if (studySessionWasRunning) {
      studySessionWasRunning = false;
      studyEndedFlashUntil = Date.now() + 4000;
      statusEl.textContent = 'Work/Study session ended';
      setTimerHmsDisabled('studyTimeLimit', false);
      startBtn.disabled = false;
      setStudyTimerBtnState('idle');
      if (config.studyLimit || snap?.originalInput) {
        writeTimerHmsFromString('studyTimeLimit', config.studyLimit || snap.originalInput);
      }
      await notifyTimerBroadcast();
      pfSetStudyBreakButtonsIdle(); // renderStudyBreakUI re-shows Stop if a break is live
      await renderStudyBreakUI(windowName);
      return;
    }
    statusEl.textContent = '';
    setTimerHmsDisabled('studyTimeLimit', false);
    startBtn.disabled = false;
    setStudyTimerBtnState('idle');
    pfSetStudyBreakButtonsIdle(); // renderStudyBreakUI re-shows Stop if a break is live
    await renderStudyBreakUI(windowName);
    return;
  }

  studySessionWasRunning = true;
  setTimerHmsDisabled('studyTimeLimit', true);
  setStudyTimerBtnState(paused ? 'paused' : 'running');
  statusEl.textContent = paused
    ? `Work/Study session paused: ${formatSeconds(remainingSec)} remaining`
    : `Work/Study session: ${formatSeconds(remainingSec)} remaining`;
  if (!paused) void logTimerTick('study', remainingSec);
  // Mirror the same running/paused state onto the Study Break button set — the
  // two share the underlying study timer, so a Start there should also show a
  // running Study Timer here (and vice-versa) with a matching Pause/Resume.
  const studyBreakStart = document.getElementById('studyBreakStartBtn');
  if (studyBreakStart) {
    const state = paused ? 'paused' : 'running';
    studyBreakStart.hidden = true;
    const sPause = document.getElementById('studyBreakPauseBtn');
    const sResume = document.getElementById('studyBreakResumeBtn');
    const sStop = document.getElementById('studyBreakStopBtn');
    if (sPause) sPause.hidden = state !== 'running';
    if (sResume) sResume.hidden = state !== 'paused';
    if (sStop) {
      sStop.hidden = false;
      // FAIL-SAFE (2026-07): while a study session is live, keep the Stop
      // button fully interactive. User report: "when a tab gets closed by
      // the Work timer it can't be hit stopped" — some other render path
      // was leaving pointer-events:none / disabled=true on it. This
      // guarantees the user can always end the timer they started.
      sStop.disabled = false;
      sStop.style.pointerEvents = '';
      sStop.style.opacity = '1';
      sStop.removeAttribute('aria-disabled');
    }
  } else {
    // No Study Break DOM present — no-op.
  }
  await renderStudyBreakUI(windowName);
}

/** Reset the Work Timer card's buttons to idle (Start visible, Stop hidden).
 *  Callers follow up with renderStudyBreakUI, whose break-reconcile re-shows
 *  Stop when a study-origin break is live. */
function pfSetStudyBreakButtonsIdle() {
  const sbStart = document.getElementById('studyBreakStartBtn');
  const sbPause = document.getElementById('studyBreakPauseBtn');
  const sbResume = document.getElementById('studyBreakResumeBtn');
  const sbStop = document.getElementById('studyBreakStopBtn');
  if (sbStart) sbStart.hidden = false;
  if (sbPause) sbPause.hidden = true;
  if (sbResume) sbResume.hidden = true;
  if (sbStop) sbStop.hidden = true;
}

// Suppression window for the optimistic Start-click swap: the per-second
// reconcile must not stomp it before the worker's storage write lands.
let pfModeBOptimisticUntil = 0;
// STICKY-STOP FLAG (user spec 2026-07 v41): once the user starts Advanced
// Earn/Spend, the dashboard button stays "Stop timer" through EVERY
// transition — cycle-complete popup, Take-a-break, Another N, break
// running, break ending. Only clicked dashboard Stop clears it. Prevents
// the button from flickering back to "Start timer" during the storage-
// write gaps between focus → popup → spend transitions.
window.pfModeBStickyRunning = window.pfModeBStickyRunning || false;
window.pfModeBStickyClear = () => { window.pfModeBStickyRunning = false; };
window.pfModeBStickySet = () => { window.pfModeBStickyRunning = true; };

/** Re-derive the Advanced Earn/Spend Start/Stop buttons from stored truth.
 *  Cheap (one storage read) — runs on the 1s snapshot tick. */
async function pfReconcileModeBButtonsFromStorage(windowName) {
  if (!windowName) return;
  if (Date.now() < pfModeBOptimisticUntil) return;
  try {
    // Include bankSpendActive so a spend/break session also shows the Stop
    // button (desync fix — see renderModeBSpendUI). Also honour the
    // sticky-stop flag so cycle-complete transitions don't flicker.
    const s = await chrome.storage.local.get(['bankFocusActive', 'bankFocusPaused', 'bankSpendActive', 'windowConfigs']);
    // FEATURE-OFF CASCADE (user spec 2026-07 v64): if the feature flag
    // itself is OFF (advancedBankedTimeEnabled=false), auto-clear the
    // sticky flag. Fixes: user clicks "I'm finished" on the cycle
    // popup → worker turns feature off in storage → this reconcile
    // now honours that and clears sticky → button flips back to Start.
    // Also stops the Start/Stop visual glitch where sticky (running)
    // was fighting storage (idle) every tick.
    const featureOn = s.windowConfigs?.[windowName]?.advancedBankedTimeEnabled === true;
    if (!featureOn && window.pfModeBStickyRunning === true) {
      window.pfModeBStickyClear?.();
    }
    const stateActive = !!s.bankFocusActive?.[windowName] || !!s.bankSpendActive?.[windowName];
    // Sticky only counts when the feature is still on — prevents the
    // flip-flop after "I'm finished".
    const active = stateActive || (featureOn && window.pfModeBStickyRunning === true);
    const btnState = !active ? 'idle' : (s.bankFocusPaused?.[windowName] ? 'paused' : 'running');
    if (typeof window.__pfApplyModeBEarnButtonState === 'function') {
      window.__pfApplyModeBEarnButtonState(btnState);
    }
  } catch (_) { /* best-effort */ }
}

async function getCurrentWindowIdForTimer() {
  const win = await chrome.windows.getCurrent().catch(() => null);
  return win?.id ?? null;
}

async function getFriendlyWindowNameForTimer(windowId) {
  if (windowId == null) return null;
  const name = await resolveWindowName(windowId);
  return name || `Window ${windowId}`;
}

async function stopStudyTimerForMutualExclusivity(reason = 'switched') {
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;
  const snap = await fetchTimerSnapshot(wid);
  if (snap?.mode !== 'study' || !snap?.active) return;
  const windowName = await getFriendlyWindowNameForTimer(wid);
  await chrome.runtime.sendMessage({
    action: 'stopTimer',
    windowId: wid,
    windowName,
    reason
  }).catch(() => {});
  await chrome.runtime.sendMessage({
    action: 'logTimerEnded',
    mode: 'study',
    reason,
    windowName
  }).catch(() => {});
  await notifyTimerBroadcast();
}

async function stopUnprodTimerForMutualExclusivity(reason = 'switched') {
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;
  const snap = await fetchTimerSnapshot(wid);
  if (snap?.mode !== 'break' || !snap?.active) return;
  const windowName = await getFriendlyWindowNameForTimer(wid);
  await chrome.runtime.sendMessage({
    action: 'stopTimer',
    windowId: wid,
    windowName,
    reason
  }).catch(() => {});
  await chrome.runtime.sendMessage({
    action: 'logTimerEnded',
    mode: 'unprod',
    reason,
    windowName
  }).catch(() => {});
  await notifyTimerBroadcast();
}

async function updateTimerMutualExclusivityUI(snap = null) {
  const wid = await getCurrentWindowIdForTimer();
  const snapshot = snap || (wid != null ? await fetchTimerSnapshot(wid) : null);
  const breakRunning = snapshot?.mode === 'break' && snapshot?.active && !snapshot?.paused;
  const studyRunning = snapshot?.mode === 'study' && snapshot?.active && !snapshot?.paused;
  const unprodStart = document.getElementById('unprodTimerStartBtn');
  const studyStart = document.getElementById('studyTimerStartBtn');
  if (unprodStart) {
    unprodStart.disabled = studyRunning;
    unprodStart.title = studyRunning ? 'Stop the Work/Study timer first' : '';
    unprodStart.style.opacity = studyRunning ? '0.5' : '';
  }
  if (studyStart) {
    studyStart.disabled = breakRunning;
    studyStart.title = breakRunning ? 'Stop the Break/Unproductive timer first' : '';
    studyStart.style.opacity = breakRunning ? '0.5' : '';
  }
}

async function setEnforcerToggleForTimer(enabled) {
  await syncEnforcerToggleLimits(enabled, { persist: true });
}

async function syncEnforcerToggleLimits(enabled, { persist = true } = {}) {
  const t = $('enforcerToggle');
  if (t && t.checked !== enabled) t.checked = enabled;
  lastRenderedLimEn = enabled === true;
  if (!persist) return;
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;
  console.warn('[pf-savewindow-call] syncEnforcerToggleLimits sending saveWindowConfig', { windowId: wid, updates: { limitsEnabled: enabled } });
  await chrome.runtime.sendMessage({
    action: 'saveWindowConfig',
    windowId: wid,
    updates: { limitsEnabled: enabled }
  }).catch(() => {});
}

async function startUnprodTimer() {
  if (await shouldBlockTutorialTimerStart('unprod')) {
    showTutorialTimerStartBlockedNote();
    return;
  }
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) {
    console.warn('[pf-dashboard-debug] Start aborted - getCurrentWindowIdForTimer returned null');
    return;
  }
  const windowName = await getFriendlyWindowNameForTimer(wid);
  if (currentStep === 9) ensureTutorialTimerPreset('unprodTimeLimit', 5 * 60);
  syncTimerHiddenFromHms('unprodTimeLimit');
  const raw = readTimerHmsString('unprodTimeLimit');
  let durationSec = 0;
  try {
    durationSec = parseTimeToSeconds(raw);
  } catch { durationSec = 0; }

  if (!durationSec || durationSec < 1) {
    alert('Set a duration using hours, minutes, and seconds (at least 1 second total).');
    return;
  }

  await stopStudyTimerForMutualExclusivity('switched');

  const startResp = await chrome.runtime.sendMessage({
    action: 'startTimer',
    windowId: wid,
    windowName,
    mode: 'break',
    limitSec: durationSec,
    originalInput: raw
  }).catch((err) => {
    console.error('[pf-dashboard-debug] startTimer failed:', err);
    return null;
  });

  if (startResp?.success !== true) {
    alert('Could not start break timer. Try reloading the dashboard.');
    return;
  }

  await chrome.runtime.sendMessage({
    action: 'logTimerStarted',
    mode: 'unprod',
    windowName,
    limitSec: durationSec,
    startedAt: Date.now()
  }).catch(() => {});

  startDashboardTimerPoll();
  await notifyTimerBroadcast();
  await renderTimerUiFromSnapshot();
  console.info('[pf-dashboard-debug] Break timer start complete');
}

function parseCommaHosts(str) {
  if (Array.isArray(str)) return normalizeStoredSiteList(str);
  return normalizeStoredSiteList(String(str || '').split(',').map((part) => part.trim()).filter(Boolean));
}

function hostsToCommaInput(hosts) {
  if (!Array.isArray(hosts)) return '';
  return hosts.map((h) => String(h).trim()).filter(Boolean).join(', ');
}

const MODE_B_SITE_PILL_CONTAINERS = {
  bankSourceSitesInput: 'bankSourceSitesPills'
};

function getModeBSitePillsContainer(inputId) {
  const containerId = MODE_B_SITE_PILL_CONTAINERS[inputId];
  return containerId ? $(containerId) : null;
}

function readModeBSitePillsFromUI(inputId) {
  const container = getModeBSitePillsContainer(inputId);
  if (!container) return [];
  return [...container.querySelectorAll('.pf-site-pill')]
    .map((pill) => pill.dataset.site)
    .filter(Boolean);
}

function readModeBSiteListFromUI(inputId, { includePending = false } = {}) {
  const sites = normalizeStoredSiteList(readModeBSitePillsFromUI(inputId));
  if (!includePending) return sites;
  const pending = String($(inputId)?.value || '').trim();
  if (!pending) return sites;
  return normalizeStoredSiteList([...sites, ...parseCommaHosts(pending)]);
}

function modeBSourceListHasAiExcludedHost(sites) {
  return normalizeStoredSiteList(sites).some((pattern) =>
    shouldCoerceAiBankSiteToHostOnly(pattern)
  );
}

function refreshModeBAiSourceNote() {
  const note = $('modeBAiSourceNote');
  if (!note) return;
  const sources = readModeBSitePillsFromUI('bankSourceSitesInput');
  note.hidden = !modeBSourceListHasAiExcludedHost(sources);
}

/**
 * Max source/target sites per window. Hard cap to keep the lists usable —
 * URL pattern matching is O(n·pages) and the focus-mode overlay renders
 * each site as a pill, so 15 keeps the UI readable and matching cheap.
 * Memory: 15 strings × ~80 char avg × 2 lists = ~2.4 KB per window. Negligible.
 */
// Cap on Advanced Earn/Spend source/target site patterns per window. Each entry
// is a short hostname/path string, so even hundreds cost only a few KB in
// storage and in the per-tick host-match loop (which is O(sites) per tab). 200
// is well within memory/budget for any realistic setup; beyond that the LRU
// eviction in addModeBSitePill drops the oldest entry rather than rejecting.
const MODE_B_SITE_LIST_MAX = 200;

function addModeBSitePill(inputId, rawSite) {
  const normalized = normalizeBankSitePattern(rawSite);
  if (!normalized) return false;
  const container = getModeBSitePillsContainer(inputId);
  if (!container) return false;
  if ([...container.querySelectorAll('.pf-site-pill')].some((pill) => pill.dataset.site === normalized)) {
    return false;
  }
  // When at the cap, don't just reject the new entry — evict the OLDEST
  // (first-added) site to make room, then add the new one. Pills are appended
  // in insertion order, so the first .pf-site-pill is the least-recently-added.
  // Show a brief inline note so the eviction isn't silent.
  const pills = container.querySelectorAll('.pf-site-pill');
  if (pills.length >= MODE_B_SITE_LIST_MAX) {
    const which = inputId === 'bankSourceSitesInput' ? 'source' : 'target';
    const oldestSite = pills[0]?.dataset?.site || '';
    pills[0]?.remove();
    try {
      const input = $(inputId);
      const note = input?.parentElement?.querySelector('.pf-site-cap-warning') || (() => {
        const n = document.createElement('div');
        n.className = 'pf-site-cap-warning';
        n.style.cssText = 'color:#8a6d1b;font-size:0.8em;margin-top:6px;font-weight:600;';
        input?.parentElement?.appendChild(n);
        return n;
      })();
      note.textContent = oldestSite
        ? `Max ${MODE_B_SITE_LIST_MAX} ${which} sites — removed your oldest site "${oldestSite}" to add this one.`
        : `Max ${MODE_B_SITE_LIST_MAX} ${which} sites — removed your oldest site to add this one.`;
      clearTimeout(note._hideTimer);
      note._hideTimer = setTimeout(() => { note.remove(); }, 5000);
    } catch (_) {}
  }
  const pill = document.createElement('span');
  pill.className = 'pf-site-pill';
  pill.dataset.site = normalized;
  const label = document.createElement('span');
  label.className = 'pf-site-pill-label';
  label.textContent = normalized;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'pf-site-pill-remove';
  removeBtn.setAttribute('aria-label', `Remove ${normalized}`);
  removeBtn.textContent = '×';
  pill.append(label, removeBtn);
  container.appendChild(pill);
  if (inputId === 'bankSourceSitesInput') refreshModeBAiSourceNote();
  return true;
}

function setModeBSiteListInUI(inputId, sites, { force = false } = {}) {
  const input = $(inputId);
  const container = getModeBSitePillsContainer(inputId);
  if (!input || !container) return;
  if (!force && document.activeElement === input) return;
  container.replaceChildren();
  for (const site of normalizeStoredSiteList(sites)) {
    addModeBSitePill(inputId, site);
  }
  input.value = '';
  if (inputId === 'bankSourceSitesInput') refreshModeBAiSourceNote();
}

function commitModeBSiteInputSegment(inputId, rawSite) {
  const part = String(rawSite || '').trim();
  if (!part) return false;
  return addModeBSitePill(inputId, part);
}

function flushModeBSitePendingInput(inputId) {
  const input = $(inputId);
  if (!input) return;
  const pending = String(input.value || '').trim();
  if (!pending) return;
  if (commitModeBSiteInputSegment(inputId, pending)) {
    input.value = '';
  }
}

function handleModeBSiteInputValue(inputId) {
  const input = $(inputId);
  if (!input) return;
  const val = String(input.value || '');
  if (!val.includes(',')) return;
  const parts = val.split(',');
  for (let i = 0; i < parts.length - 1; i++) {
    commitModeBSiteInputSegment(inputId, parts[i]);
  }
  input.value = parts[parts.length - 1].trim();
}

function initModeBSitePillField(inputId) {
  const input = $(inputId);
  const container = getModeBSitePillsContainer(inputId);
  if (!input || !container || input.dataset.pillBound === '1') return;
  input.dataset.pillBound = '1';

  input.addEventListener('input', () => {
    handleModeBSiteInputValue(inputId);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      flushModeBSitePendingInput(inputId);
      void saveModeBEarnSpendSettings();
      return;
    }
    if (e.key === 'Backspace' && !input.value) {
      const pills = container.querySelectorAll('.pf-site-pill');
      const last = pills[pills.length - 1];
      if (!last) return;
      last.remove();
      void saveModeBEarnSpendSettings();
    }
  });

  input.addEventListener('change', () => {
    flushModeBSitePendingInput(inputId);
    void saveModeBEarnSpendSettings();
  });

  container.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.pf-site-pill-remove');
    if (!removeBtn) return;
    removeBtn.closest('.pf-site-pill')?.remove();
    if (inputId === 'bankSourceSitesInput') refreshModeBAiSourceNote();
    void saveModeBEarnSpendSettings();
  });
}

function syncModeBSiteInputsFromParsed(sourceSites, _targetSites, { force = false } = {}) {
  setModeBSiteListInUI('bankSourceSitesInput', sourceSites, { force });
}

async function saveStudyBreakSettings() {
  if (!isInitialized) return;
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (!win?.id) return;
  syncTimerHiddenFromHms('studyBreakEveryTime');
  syncTimerHiddenFromHms('studyBreakEarnTime');
  await chrome.runtime.sendMessage({
    action: 'saveWindowConfig',
    windowId: win.id,
    updates: {
      studyBreakEnabled: !!$('studyBreakEnabled')?.checked,
      studyBreakEvery: readTimerHmsString('studyBreakEveryTime'),
      studyBreakEverySec: parseTimeToSeconds(readTimerHmsString('studyBreakEveryTime')),
      studyBreakEarn: readTimerHmsString('studyBreakEarnTime'),
      studyBreakEarnSec: parseTimeToSeconds(readTimerHmsString('studyBreakEarnTime'))
    }
  }).catch(() => {});
}

function loadStudyBreakSettings(config = {}) {
  if ($('studyBreakEnabled') && document.activeElement !== $('studyBreakEnabled')) {
    $('studyBreakEnabled').checked = !!config.studyBreakEnabled;
  }
  writeTimerHmsFromString('studyBreakEveryTime', config.studyBreakEvery || '0:25:00');
  writeTimerHmsFromString('studyBreakEarnTime', config.studyBreakEarn || '0:05:00');
}

function syncAdvancedEarnSpendPanelOpen(open) {
  const chevron = $('advancedEarnSpendChevron');
  const panel = $('advancedEarnSpendPanel');
  if (!chevron || !panel) return;
  const isOpen = open ?? chevron.getAttribute('aria-expanded') === 'true';
  // Toggle aria + visibility FIRST so the panel opens even if the demo refresh throws.
  chevron.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  panel.hidden = !isOpen;
  panel.style.display = isOpen ? 'block' : 'none';
  try {
    void refreshSettingDemoVisibility('modeBEarnSpend');
  } catch (err) {
    console.warn('[pf-dashboard] refreshSettingDemoVisibility(modeBEarnSpend) failed', err);
  }
}

// Idempotent: safe to call from both bootDashboardUiBindings (early) and the
// heavy DOMContentLoaded listener. Binds the Advanced Earn/Spend chevron so the
// panel opens on click even if a later render step throws before the listener
// body would otherwise reach its binding.
function bindAdvancedEarnSpendChevron() {
  const chevron = $('advancedEarnSpendChevron');
  if (!chevron || chevron.dataset.bound === '1') return;
  chevron.dataset.bound = '1';
  chevron.addEventListener('click', () => {
    const open = chevron.getAttribute('aria-expanded') === 'true';
    syncAdvancedEarnSpendPanelOpen(!open);
  });
}

/**
 * Bind the "30 min reminder" dropdown under the Break/Unproductive
 * timer card. Persists settings to chrome.storage.local under
 * `unprodReminderSettings = { enabled, thresholdMin, suggestMin,
 * dropdownOpen }` keyed globally (not per-window — the reminder is a user
 * preference). Defaults to enabled=true, threshold=30, suggest=5, and
 * dropdownOpen=true on first ever load so users discover the feature.
 */
function bindUnprodReminderDropdown() {
  const toggle = $('unprodReminderToggle');
  const panel = $('unprodReminderPanel');
  const enabled = $('unprodReminderEnabled');
  const thresholdMin = $('unprodReminderThresholdMin');
  const suggestMin = $('unprodReminderSuggestMin');
  const suggestHours = $('unprodReminderSuggestHours');
  const heading = $('unprodReminderHeading');
  if (!toggle || !panel || !enabled || !thresholdMin || !suggestMin) return;
  if (toggle.dataset.bound === '1') return;
  toggle.dataset.bound = '1';

  const STORAGE_KEY = 'unprodReminderSettings';
  // suggestMin/thresholdMin represent TOTAL minutes (hours*60 + minutes).
  // Storing single fields keeps every existing reader untouched — the
  // dashboard just splits them into hours + minutes for display.
  // includeNeutral: reminder also fires on Neutral tabs ("and neutral" word).
  // dismissPhrase: custom type-to-dismiss sentence ('' = default).
  const DEFAULTS = {
    enabled: true, thresholdMin: 30, suggestMin: 5, dropdownOpen: true,
    includeNeutral: false, dismissPhrase: ''
  };
  const thresholdHours = $('unprodReminderThresholdHours');

  const renderHeading = () => {
    // Heading is static "Reminders" now — number-of-minutes detail lives
    // inside the panel. Keep this function as a no-op so existing call
    // sites don't break.
    heading.textContent = 'Reminders';
  };

  const applyOpen = (open) => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.style.display = open ? '' : 'none';
    const chev = toggle.querySelector('.pf-reminder-chev');
    if (chev) chev.textContent = open ? '▾' : '▸';
  };

  // Load settings, populate inputs, render
  (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const s = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
      enabled.checked = s.enabled !== false;
      // Threshold display: h + min split of the stored total minutes —
      // same convention as the suggested-break inputs.
      const totalThresh = Math.max(1, Math.floor(Number(s.thresholdMin) || 30));
      if (thresholdHours) thresholdHours.value = String(Math.floor(totalThresh / 60));
      thresholdMin.value = String(thresholdHours ? totalThresh % 60 : totalThresh);
      // Split total suggested minutes into hours + minutes for the two-field
      // display. Values 60+ populate the hours box; the "min" box holds the
      // remainder (0–59). E.g. 90 → 1h + 30 min.
      const totalMin = Math.max(0, Math.floor(Number(s.suggestMin) || 0));
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      if (suggestHours) suggestHours.value = String(hh);
      suggestMin.value = String(mm);
      // "and neutral" toggle-word state.
      const neutralBtn = $('unprodReminderNeutralToggle');
      if (neutralBtn) {
        neutralBtn.classList.toggle('is-on', s.includeNeutral === true);
        neutralBtn.setAttribute('aria-pressed', s.includeNeutral === true ? 'true' : 'false');
      }
      // Custom dismiss phrase prefill (empty = default placeholder shows).
      const phraseInput = $('unprodReminderPhraseInput');
      if (phraseInput) phraseInput.value = String(s.dismissPhrase || '');
      applyOpen(s.dropdownOpen !== false);
      renderHeading();
    } catch (_) {
      applyOpen(true);
      renderHeading();
    }
  })();

  const save = async (partial) => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const current = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
      const next = { ...current, ...partial };
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
    } catch (_) { /* best-effort persistence */ }
  };

  toggle.addEventListener('click', async () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    applyOpen(!isOpen);
    await save({ dropdownOpen: !isOpen });
  });
  enabled.addEventListener('change', async () => {
    await save({ enabled: !!enabled.checked });
    // Force a fresh closer broadcast so the bottom-right pill picks up the
    // new state immediately (user report 2026-07 v48: "when I switch off
    // the toggle on the dashboard it should update on the normal button
    // in the bottom right"). Without this the pill can keep showing a
    // stale countdown/state until the next tick.
    try { await notifyTimerBroadcast(); } catch (_) {}
  });
  // Threshold = hours + minutes combined into one stored total (1 min floor,
  // 12h ceiling) — mirrors the suggested-break fields.
  const persistThreshold = () => {
    const h = Math.max(0, Math.min(12, Math.floor(Number(thresholdHours?.value) || 0)));
    const m = Math.max(0, Math.min(59, Math.floor(Number(thresholdMin.value) || 0)));
    const total = Math.max(1, h * 60 + m);
    if (thresholdHours) thresholdHours.value = String(h);
    thresholdMin.value = String(thresholdHours ? m : total);
    renderHeading();
    save({ thresholdMin: total });
  };
  thresholdMin.addEventListener('change', persistThreshold);
  if (thresholdHours) thresholdHours.addEventListener('change', persistThreshold);

  // "and neutral" toggle-word: grayed → semi-normal when on; reminder then
  // also fires on Neutral tabs (worker reads includeNeutral).
  const neutralBtn = $('unprodReminderNeutralToggle');
  if (neutralBtn && neutralBtn.dataset.bound !== '1') {
    neutralBtn.dataset.bound = '1';
    neutralBtn.addEventListener('click', () => {
      const on = !neutralBtn.classList.contains('is-on');
      neutralBtn.classList.toggle('is-on', on);
      neutralBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      void save({ includeNeutral: on });
    });
  }

  // Pencil: edit the type-to-dismiss phrase. Hidden during the tutorial via
  // CSS (body.tutorial-active). Empty save reverts to the default phrase.
  const phrasePencil = $('unprodReminderPhraseEdit');
  const phraseRow = $('unprodReminderPhraseRow');
  const phraseInput = $('unprodReminderPhraseInput');
  const phraseSave = $('unprodReminderPhraseSave');
  const phraseTick = $('unprodReminderPhraseTick');
  if (phrasePencil && phraseRow && phrasePencil.dataset.bound !== '1') {
    phrasePencil.dataset.bound = '1';
    phrasePencil.addEventListener('click', () => {
      const open = phraseRow.hidden;
      phraseRow.hidden = !open;
      phrasePencil.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) phraseInput?.focus();
    });
    const persistPhrase = async () => {
      // Strip angle brackets defensively (the worker escapes too) and cap
      // length; empty string = "use the default phrase".
      const raw = String(phraseInput?.value || '').replace(/[<>]/g, '').trim().slice(0, 120);
      if (phraseInput) phraseInput.value = raw;
      await save({ dismissPhrase: raw });
      if (phraseTick) {
        phraseTick.style.opacity = '1';
        setTimeout(() => { phraseTick.style.opacity = '0'; }, 1400);
      }
    };
    phraseSave?.addEventListener('click', () => { void persistPhrase(); });
    phraseInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void persistPhrase(); }
    });
  }
  // Digit-only strip on the h + min fields — prevent "e", "-", ".", paste
  // of arbitrary text into <input type="number">.
  const stripToDigits = (el) => {
    if (!el) return;
    el.addEventListener('input', () => {
      const cleaned = String(el.value || '').replace(/[^0-9]/g, '');
      if (cleaned !== el.value) el.value = cleaned;
    });
  };
  stripToDigits(suggestMin);
  stripToDigits(suggestHours);

  // Combine hours + minutes into a single total-minutes value that the
  // existing readers (worker.js unprod-reminder popup, YT prompt) already
  // consume. 1-minute floor and 12h ceiling keep values sane.
  const persistSuggested = () => {
    const h = Math.max(0, Math.min(12, Math.floor(Number(suggestHours?.value) || 0)));
    const m = Math.max(0, Math.min(59, Math.floor(Number(suggestMin.value) || 0)));
    const total = Math.max(1, h * 60 + m);
    if (suggestHours) suggestHours.value = String(h);
    suggestMin.value = String(m);
    save({ suggestMin: total });
  };
  suggestMin.addEventListener('change', persistSuggested);
  if (suggestHours) suggestHours.addEventListener('change', persistSuggested);

  // YouTube/video per-video timer prompt — now lives as a single checkbox
  // inside this same Reminders panel. Persists to its own storage key
  // (ytVideoTimerSettings.enabled) which closer_indicator.js reads.
  const ytCheckbox = $('ytVideoTimerEnabled');
  if (ytCheckbox && ytCheckbox.dataset.bound !== '1') {
    ytCheckbox.dataset.bound = '1';
    const YT_KEY = 'ytVideoTimerSettings';
    // Default OFF (user spec 2026-07 v24): during onboarding the "suggest
    // a timer on long YouTube videos" prompt should NOT auto-fire — users
    // opt in. Existing users' saved value overrides this default via the
    // spread below (`...stored`).
    const YT_DEFAULTS = { enabled: false };
    (async () => {
      try {
        const stored = await chrome.storage.local.get(YT_KEY);
        const s = { ...YT_DEFAULTS, ...(stored[YT_KEY] || {}) };
        ytCheckbox.checked = s.enabled === true;
      } catch (_) { /* leave default */ }
    })();
    ytCheckbox.addEventListener('change', async () => {
      try {
        const stored = await chrome.storage.local.get(YT_KEY);
        const current = { ...YT_DEFAULTS, ...(stored[YT_KEY] || {}) };
        await chrome.storage.local.set({
          [YT_KEY]: { ...current, enabled: !!ytCheckbox.checked },
        });
      } catch (_) {}
    });
  }
}

async function saveModeBEarnSpendSettings() {
  if (!isInitialized) return;
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (!win?.id) return;
  syncTimerHiddenFromHms('bankFocusTimeModeB');
  syncTimerHiddenFromHms('bankEarnedTimeModeB');
  const bankSourceSites = readModeBSiteListFromUI('bankSourceSitesInput', { includePending: true });
  // Do NOT force-sync the pill UI back from the parsed list here — the pills
  // were already updated by the input handler (flushModeBSitePendingInput /
  // handleModeBSiteInputValue) before this save was called. Forcing a rebuild
  // with { force: true } cleared the input field (setModeBSiteListInUI line:
  // input.value = '') and stole focus WHILE the user was typing the next URL,
  // making it impossible to add multiple URLs without toggling the feature
  // off and on. Per user report (2026-07).
  // syncModeBSiteInputsFromParsed(bankSourceSites, [], { force: true });
  const enableModeB = !!$('enableBankedTimeModeB')?.checked;
  // If the user just turned advanced earn/spend ON and a break/unprod timer
  // is currently running, stop that timer first — the two systems can't run
  // together (advanced earn/spend manages its own source/target flow and
  // the closer toggle).
  if (enableModeB) {
    try {
      const { timerSessionActive, timerMode } = await getWallClockTimerUiFlags(win.id);
      if (timerSessionActive && timerMode === 'break') {
        await chrome.runtime.sendMessage({
          action: 'stopTimer',
          windowId: win.id,
          reason: 'advanced-earn-enabled'
        }).catch(() => {});
      }
    } catch (_) { /* best-effort */ }
  } else {
    // Symmetric tear-down on DISABLE: if a spend session is active when the
    // user toggles advanced earn off, end it. Otherwise the spend session
    // keeps running and spendSessionLocksToggle stays true in
    // refreshCloserToggleUI, so the closer toggle / timer Start buttons /
    // study-break controls all stay locked — making it look like advanced
    // earn never actually turned off.
    //
    // Guard against a stale async execution racing a re-start (user report
    // 2026-07: "after using advacned earn/spend timer once i tried doing it
    // again but the ui of the timer was not showing"). If the checkbox was
    // re-checked by the time we reach here, the user has already started a
    // new session — don't cancel it.
    if (!$('enableBankedTimeModeB')?.checked) {
      try {
        const wn = await resolveWindowName(win.id);
        if (wn) {
          const stored = await chrome.storage.local.get(['bankSpendActive']);
          if (stored.bankSpendActive?.[wn]) {
            await chrome.runtime.sendMessage({
              action: 'cancelBankSpendMode',
              windowId: win.id,
              windowName: wn
            }).catch(() => {});
          }
        }
      } catch (_) { /* best-effort */ }
    }
  }
  const modeBEnabled = !!$('enableBankedTimeModeB')?.checked;
  await chrome.runtime.sendMessage({
    action: 'saveWindowConfig',
    windowId: win.id,
    updates: {
      advancedBankedTimeEnabled: modeBEnabled,
      bankedTimeEnabled: !!(modeBEnabled || $('enableBankedTime')?.checked),
      bankFocusStr: readTimerHmsString('bankFocusTimeModeB'),
      bankFocus: parseTimeToSeconds(readTimerHmsString('bankFocusTimeModeB')),
      bankEarnedStr: readTimerHmsString('bankEarnedTimeModeB'),
      bankEarned: parseTimeToSeconds(readTimerHmsString('bankEarnedTimeModeB')),
      bankSourceSites
    }
  }).catch(() => {});
  const windowName = await resolveWindowName(win.id);
  await renderModeBSpendUI(windowName);
}

function loadModeBEarnSpendSettings(config = {}) {
  if ($('enableBankedTimeModeB') && document.activeElement !== $('enableBankedTimeModeB')) {
    $('enableBankedTimeModeB').checked = config.advancedBankedTimeEnabled === true;
  }
  // Use the user's saved sites. Only fall back to example defaults on the VERY
  // FIRST load (when the config has never been written for this window). We
  // detect "never written" via the absence of BOTH source and target keys — NOT
  // an empty array, which would mean the user deliberately cleared them. Without
  // this distinction, the defaults clobbered saved settings on every render.
  const hasSourceKey = config.bankSourceSites !== undefined && config.bankSourceSites !== null;
  const everConfigured = hasSourceKey;
  const sourceSites = normalizeStoredSiteList(config.bankSourceSites);
  const useDefaultSources = !everConfigured && !sourceSites.length;
  setModeBSiteListInUI('bankSourceSitesInput',
    useDefaultSources ? ['youtube.com', 'twitch.tv'] : sourceSites);
  // On true first-ever login (config never written), force the Advanced
  // Earn/Spend toggle OFF regardless of any stale/partial state, so the
  // examples sit there visibly but the feature isn't accidentally on.
  if (!everConfigured && $('enableBankedTimeModeB')) {
    $('enableBankedTimeModeB').checked = false;
  }
  writeTimerHmsFromString('bankFocusTimeModeB', config.bankFocusStr || config.bankFocusTime || '0:15:00');
  writeTimerHmsFromString('bankEarnedTimeModeB', config.bankEarnedStr || config.bankEarnedTime || '0:05:00');
  refreshModeBAiSourceNote();
  // Sync the gray-out to the loaded checkbox state so the dashboard opens with
  // the conflicting controls already locked when advanced earn was left on.
  applyAdvancedEarnLock();
}

// SINGLE SOURCE OF TRUTH for the combined break-available balance
// (user spec 2026-07 v62: "if I earn 14 min on advanced timer and then go
// to work timer and earn 5 min it should say I have 19 min and vice versa").
// Sum studyBreakAvailable (Work Timer earnings) + bankedReward (Advanced
// Earn/Spend earnings). Both dashboard cards call this so they can never
// drift out of sync. (Video-overage debt removed — user spec 2026-07 v41.)
async function pfComputeCombinedBreakSec(windowName) {
  if (!windowName) return 0;
  const stored = await chrome.storage.local.get(['studyBreakAvailable', 'bankedReward']);
  const sbSec = Math.max(0, Math.floor(Number(stored.studyBreakAvailable?.[windowName]) || 0));
  const rewardRaw = stored.bankedReward?.[windowName];
  let rewardSec = 0;
  if (rewardRaw && typeof rewardRaw === 'object') {
    for (const k of Object.keys(rewardRaw)) rewardSec += Math.max(0, Math.floor(Number(rewardRaw[k]) || 0));
  } else {
    rewardSec = Math.max(0, Math.floor(Number(rewardRaw) || 0));
  }
  return sbSec + rewardSec;
}

async function renderStudyBreakUI(windowName) {
  const row = $('studyBreakAvailableRow');
  const display = $('studyBreakAvailableDisplay');
  if (!row || !display) return;

  const wid = await getCurrentWindowIdForTimer();
  const name = windowName
    || (wid != null ? await getFriendlyWindowNameForTimer(wid) : null)
    || await getSelectedWindowId();
  const stored = await chrome.storage.local.get(['bankSpendActive', 'bankSpendRemaining']);
  const staticAvailableSec = await pfComputeCombinedBreakSec(name);
  // Live-remaining during a break (user report 2026-07 v43: "if they use
  // 10min of it both available times should show 10min while they're using
  // that time"). When ANY spend session is active (Work Timer break OR
  // Advanced Earn/Spend break — both share bankSpendRemaining), display the
  // live countdown instead of the static post-deduction balance. This keeps
  // this card in sync with the Advanced Earn/Spend card and the floating
  // pill, all of which tick down together. The static balance is already
  // carved down at spend-start, so it stays frozen mid-break; the live
  // remaining is what the user actually cares about.
  const spendActiveNow = !!stored.bankSpendActive?.[name];
  const spendRemainingNow = Math.max(0, Math.floor(stored.bankSpendRemaining?.[name] || 0));
  const availableSec = spendActiveNow ? spendRemainingNow : staticAvailableSec;

  row.hidden = false;
  row.style.display = 'flex';

  // Format including negative (debt) values — e.g. -540s → "-9m 0s" — and
  // tint red so a debt is visually obvious.
  const negA = availableSec < 0;
  const absA = Math.abs(availableSec);
  display.textContent = (negA ? '-' : '') + (absA >= 3600
    ? `${Math.floor(absA / 3600)}h ${Math.floor((absA % 3600) / 60)}m`
    : absA >= 60
      ? `${Math.floor(absA / 60)}m ${absA % 60}s`
      : `${absA}s`);
  if (display.style) display.style.color = negA ? '#c0392b' : '#28a745';

  // A running Work Timer BREAK (study-origin spend session) belongs to THIS
  // card (user spec 2026-07): show Stop timer here while it runs, so the
  // user can end it and bank the unused time back into Break available.
  try {
    const spendStored = await chrome.storage.local.get(['bankSpendActive', 'bankSpendSourceHost']);
    const breakRunning = !!spendStored.bankSpendActive?.[name]
      && spendStored.bankSpendSourceHost?.[name] === 'study_break';
    if (breakRunning) {
      const sStart = $('studyBreakStartBtn');
      const sStop = $('studyBreakStopBtn');
      if (sStart) sStart.hidden = true;
      if (sStop) {
        sStop.hidden = false;
        sStop.disabled = false;
        sStop.style.opacity = '1';
        sStop.style.pointerEvents = '';
        sStop.removeAttribute('aria-disabled');
      }
    }
  } catch (_) { /* best-effort */ }
}

async function renderModeBSpendUI(windowName) {
  const display = $('modeBSpendAvailableDisplay');
  // Break countdown panel removed from the dashboard (user spec 2026-07):
  // no break indication here beyond the Stop timer button — the floating
  // pill carries the countdown. These stay null; guards below no-op.
  const timePanel = null;
  const remainingDisplay = null;
  const sourceSitesEl = null;
  // Pause/cancel/use controls were removed in the button-rework — spend
  // now auto-starts when the user visits an unproductive tab.
  const useBtn = null; const controls = null; const pauseBtn = null;
  if (!display) return;

  // "Spend time available" is a display-only element (not clickable). Per user
  // report (2026-07): clicking it showed an unwanted dropdown popup.
  const availRow = $('modeBSpendAvailableRow');
  if (availRow) {
    availRow.style.cursor = 'default';
    availRow.removeAttribute('role');
    availRow.removeAttribute('tabindex');
    availRow.removeAttribute('title');
  }
  const name = windowName || await getSelectedWindowId();
  const win = await chrome.windows.getCurrent().catch(() => null);
  const [stored, configResp] = await Promise.all([
    chrome.storage.local.get([
      'bankSpendActive', 'bankSpendRemaining', 'bankSpendPaused',
      'bankFocusActive', 'bankFocusPaused'
    ]),
    win?.id
      ? chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: win.id }).catch(() => null)
      : Promise.resolve(null)
  ]);
  // Reconcile the Earn button set — Start / Pause+Stop / Resume+Stop — from
  // the storage-side truth so a page refresh mid-focus lands on the right
  // buttons instead of the default Start.
  try {
    const focusActive = !!stored.bankFocusActive?.[name];
    const focusPaused = !!stored.bankFocusPaused?.[name];
    const spendActive = !!stored.bankSpendActive?.[name];
    // FEATURE-OFF CASCADE (v64): if feature was turned off (via "I'm
    // finished" popup, or dashboard checkbox uncheck), auto-clear sticky.
    // Prevents Start/Stop button flip-flop.
    const featureOn = configResp?.config?.advancedBankedTimeEnabled === true;
    if (!featureOn && window.pfModeBStickyRunning === true) {
      window.pfModeBStickyClear?.();
    }
    // Sticky-Stop flag keeps Stop visible through cycle transitions —
    // only counts when the feature itself is still on.
    const sticky = featureOn && window.pfModeBStickyRunning === true;
    const active = focusActive || spendActive || sticky;
    const btnState = !active ? 'idle' : (focusPaused ? 'paused' : 'running');
    if (typeof window.__pfApplyModeBEarnButtonState === 'function') {
      window.__pfApplyModeBEarnButtonState(btnState);
    }
  } catch (_) { /* best-effort */ }
  // Combined break balance — SAME helper the Work Timer card uses so both
  // cards can never drift (user spec 2026-07 v62: "if I earn 14 min on
  // advanced timer and then go to work timer and earn 5 min it should say
  // I have 19 min and vice versa").
  const staticAvailableSec = await pfComputeCombinedBreakSec(name);
  const spendActive = !!stored.bankSpendActive?.[name];
  const spendRemaining = Math.floor(stored.bankSpendRemaining?.[name] || 0);
  // Live-remaining during a break (user report 2026-07 v43: "if they use
  // 10min of it both available times should show 10min while they're using
  // that time"). When ANY spend session is active (Work Timer break OR
  // Advanced Earn/Spend break — both share bankSpendRemaining), display the
  // live countdown instead of the static post-deduction balance. This keeps
  // this card in sync with the Work Timer card and the floating pill, all of
  // which tick down together.
  const availableSec = spendActive ? Math.max(0, spendRemaining) : staticAvailableSec;
  // Paused = explicitly user-paused only. Removed the document.hidden/
  // hasFocus checks (user report 2026-07: "the timer did not pause it
  // looked like it did but it did not") — those only track the dashboard tab
  // focus, NOT whether the worker actually pauses the timer. The worker uses
  // chrome.windows.onFocusChanged (OS-level Chrome focus) to gate the tick,
  // so matching on tab-level visibility was misleading.
  const spendPaused = !!stored.bankSpendPaused?.[name];
  const showSpendSession = spendActive && spendRemaining > 0;

  // Format including negative (debt) values — e.g. -540s → "-9m 0s" — and
  // tint red so a debt is visually obvious.
  const negB = availableSec < 0;
  const absB = Math.abs(availableSec);
  display.textContent = (negB ? '-' : '') + (absB >= 3600
    ? `${Math.floor(absB / 3600)}h ${Math.floor((absB % 3600) / 60)}m`
    : absB >= 60
      ? `${Math.floor(absB / 60)}m ${absB % 60}s`
      : `${absB}s`);
  display.style.color = negB ? '#c0392b' : '#28a745';

  if (timePanel) {
    timePanel.hidden = !showSpendSession;
    timePanel.setAttribute('aria-hidden', showSpendSession ? 'false' : 'true');
    timePanel.classList.toggle('is-active', showSpendSession);
  }
  if (remainingDisplay) {
    if (showSpendSession) {
      remainingDisplay.textContent = formatSeconds(spendRemaining);
      remainingDisplay.classList.toggle('is-paused', spendPaused);
    } else {
      remainingDisplay.textContent = '00:00:00';
      remainingDisplay.classList.remove('is-paused');
    }
  }
  if (sourceSitesEl) {
    if (showSpendSession) {
      const config = configResp?.config || {};
      const sources = Array.isArray(config.bankSourceSites)
        ? config.bankSourceSites
        : readModeBSiteListFromUI('bankSourceSitesInput');
      renderModeBSpendSourceSites(sourceSitesEl, sources);
    } else {
      sourceSitesEl.replaceChildren();
    }
  }
  // pause/cancel/use controls removed — no-op.
}

function renderModeBSpendSourceSites(container, sites) {
  container.replaceChildren();
  const list = normalizeStoredSiteList(sites);
  if (!list.length) return;
  const visible = list.slice(0, 3);
  const hiddenCount = Math.max(0, list.length - visible.length);

  for (const site of visible) {
    const chip = document.createElement('span');
    chip.className = 'pf-modeb-source-chip';
    chip.textContent = site;
    chip.title = site;
    container.appendChild(chip);
  }

  if (hiddenCount > 0) {
    const more = document.createElement('span');
    more.className = 'pf-modeb-source-more';
    more.setAttribute('tabindex', '0');
    more.textContent = `+${hiddenCount} more`;
    const popover = document.createElement('span');
    popover.className = 'pf-modeb-source-popover';
    popover.setAttribute('role', 'tooltip');
    for (const site of list) {
      const line = document.createElement('div');
      line.textContent = site;
      popover.appendChild(line);
    }
    more.appendChild(popover);
    container.appendChild(more);
  }
}

async function confirmEarlyStudyStop(config, windowName, remainingSecOverride = null) {
  const stored = await chrome.storage.local.get([
    'studyBreakAvailable', 'studyBreakProgress'
  ]);
  const availableSec = Math.floor(stored.studyBreakAvailable?.[windowName] || 0);
  const progressSec = Math.floor(stored.studyBreakProgress?.[windowName] || 0);
  const limitSec = Number(config.studyLimitSec || 0);

  let remainingSec;
  let elapsed;
  if (remainingSecOverride != null) {
    remainingSec = Math.max(0, Number(remainingSecOverride) || 0);
    elapsed = Math.max(0, limitSec - remainingSec);
  } else {
    const wid = await getCurrentWindowIdForTimer();
    const snap = wid != null ? await fetchTimerSnapshot(wid) : null;
    if (snap?.mode === 'study' && snap?.active) {
      remainingSec = Math.max(0, Number(snap.remainingSec) || 0);
      elapsed = Math.max(0, Number(snap.elapsedSec) || 0);
    } else {
      remainingSec = limitSec;
      elapsed = 0;
    }
  }

  if (availableSec > 0) {
    const availLabel = availableSec >= 60 ? `${Math.floor(availableSec / 60)}m` : `${availableSec}s`;
    return window.confirm(
      `You have ${availLabel} of break time banked. Stopping early keeps it. Stop the study session?`
    );
  }
  if (remainingSec > 0 && config.studyBreakEnabled) {
    const remainLabel = formatSeconds(remainingSec);
    if (progressSec > 0) {
      return window.confirm(
        `Your remaining ${remainLabel} will be added to Break available. Stop the study session?`
      );
    }
    return window.confirm(
      `Your remaining ${remainLabel} will be added to Break available. Stop early?`
    );
  }
  if (progressSec > 0 && config.studyBreakEnabled) {
    const everySec = Number(config.studyBreakEverySec || 0);
    const needSec = Math.max(0, everySec - progressSec);
    const needLabel = needSec >= 60 ? `${Math.ceil(needSec / 60)}m` : `${needSec}s`;
    return window.confirm(
      `Progress toward your next break deposit (${needLabel} remaining) will be kept. Stop anyway?`
    );
  }
  if (remainingSec > 60 && elapsed > 0) {
    return window.confirm(
      `You still have ${formatSeconds(remainingSec)} left in this study session. Stop early?`
    );
  }
  if (config.studyBreakEnabled && elapsed > 0) {
    return window.confirm('Stop the study session before it finishes?');
  }
  return true;
}

async function startStudyTimer() {
  if (await shouldBlockTutorialTimerStart('study')) {
    showTutorialTimerStartBlockedNote();
    return;
  }
  if (currentStep === 10) ensureTutorialTimerPreset('studyTimeLimit', 25 * 60);
  syncTimerHiddenFromHms('studyTimeLimit');
  const raw = readTimerHmsString('studyTimeLimit');
  let durationSec = 0;
  try {
    durationSec = parseTimeToSeconds(raw);
  } catch {
    durationSec = 0;
  }
  if (!durationSec || durationSec < 1) {
    alert('Set a duration using hours, minutes, and seconds (at least 1 second total).');
    return;
  }

  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;

  const windowName = await getFriendlyWindowNameForTimer(wid);
  await stopUnprodTimerForMutualExclusivity('switched');

  const startResp = await chrome.runtime.sendMessage({
    action: 'startTimer',
    windowId: wid,
    windowName,
    mode: 'study',
    limitSec: durationSec,
    originalInput: raw,
    windowConfigUpdates: {
      studyBreakEnabled: !!$('studyBreakEnabled')?.checked,
      studyBreakEvery: readTimerHmsString('studyBreakEveryTime'),
      studyBreakEverySec: parseTimeToSeconds(readTimerHmsString('studyBreakEveryTime')),
      studyBreakEarn: readTimerHmsString('studyBreakEarnTime'),
      studyBreakEarnSec: parseTimeToSeconds(readTimerHmsString('studyBreakEarnTime'))
    }
  }).catch(() => null);

  if (startResp?.success !== true) {
    alert('Could not start Work/Study timer. Try reloading the dashboard.');
    return;
  }

  await chrome.runtime.sendMessage({
    action: 'logTimerStarted',
    mode: 'study',
    windowName,
    limitSec: durationSec,
    startedAt: Date.now()
  }).catch(() => {});

  startDashboardTimerPoll();
  await notifyTimerBroadcast();
  await renderTimerUiFromSnapshot();
}

async function stopStudyTimer(reason = 'cancelled') {
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;
  const snap = await fetchTimerSnapshot(wid);
  if (snap?.mode !== 'study' || !snap?.active) return;
  const windowName = await getFriendlyWindowNameForTimer(wid);
  const config = await getMergedWindowConfig(wid);
  const remainingSec = Math.max(0, Number(snap.remainingSec) || 0);

  if (reason === 'cancelled') {
    const ok = await confirmEarlyStudyStop(config, windowName, remainingSec);
    if (!ok) return;
  }

  // NOTE: previously we called creditStudyRemainingToBreak here, which
  // dumped the UNEARNED remaining session seconds directly into the break
  // bank on early-stop. That broke the "every X earn Y" contract — users
  // saw far more banked break time than their actual study time warranted.
  // The correct behaviour is to keep only what tickStudyBreak already
  // deposited per the ratio while the session was running.
  const creditedBreakSec = 0;

  await chrome.runtime.sendMessage({
    action: 'stopTimer',
    windowId: wid,
    windowName,
    reason
  }).catch(() => {});
  await chrome.runtime.sendMessage({
    action: 'logTimerEnded',
    mode: 'study',
    reason,
    windowName
  }).catch(() => {});
  studyEndedFlashUntil = 0;
  await notifyTimerBroadcast();
  await renderTimerUiFromSnapshot();
  await renderStudyBreakUI(windowName);

  if (creditedBreakSec > 0) {
    const statusEl = $('studyBreakStatus');
    if (statusEl) {
      statusEl.textContent = `✓ Added ${formatSeconds(creditedBreakSec)} to Break available`;
    }
  }
}

async function pauseUnprodTimer() {
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;
  const snap = await fetchTimerSnapshot(wid);
  if (snap?.mode !== 'break' || !snap?.active) return;

  const pauseBtn = document.getElementById('unprodTimerPauseBtn');
  if (!snap.paused) {
    await chrome.runtime.sendMessage({ action: 'pauseTimer' }).catch(() => {});
    // Optimistic label flip — next render will confirm via snapshot, but
    // showing "Resume" instantly gives the user visual confirmation that
    // the click registered (instead of the button looking unchanged).
    if (pauseBtn) { pauseBtn.textContent = '▶ Resume'; pauseBtn.style.background = '#4caf50'; }
  } else {
    await chrome.runtime.sendMessage({ action: 'resumeTimer' }).catch(() => {});
    if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; pauseBtn.style.background = '#ff9800'; }
  }
  await notifyTimerBroadcast();
  await renderTimerUiFromSnapshot();
}

async function cancelUnprodTimer() {
  const wid = await getCurrentWindowIdForTimer();
  if (wid == null) return;
  const snap = await fetchTimerSnapshot(wid);
  if (snap?.mode !== 'break' || !snap?.active || !snap?.paused) return;
  const windowName = await getFriendlyWindowNameForTimer(wid);

  await chrome.runtime.sendMessage({
    action: 'stopTimer',
    windowId: wid,
    windowName,
    reason: 'cancelled'
  }).catch(() => {});

  await setEnforcerToggleForTimer(false);
  await renderTimerUiFromSnapshot();
  await notifyTimerBroadcast();
}

async function initThemeCarousel() {
  const carousel = $('themeCarousel');
  if (carousel) orderOwnedThemeCards(carousel);
  const stored = await chrome.storage.local.get('selectedTheme');
  const selected = stored.selectedTheme || 'tutorial_background';
  applyTheme(selected);
  document.querySelectorAll('.theme-card.theme-owned').forEach((card) => {
    card.classList.toggle('theme-selected', card.dataset.themeId === selected);
  });
}

// ── Dark mode — COMING SOON (user spec 2026-07: "dark modes not working
// just add a coming soon to it and make it so that it cant be turned on").
// The class never applies and the stored flag is healed to false so anyone
// who toggled it on while it was live gets reverted to light. The CSS
// stays in the page but is inert without body.pf-dark.
async function pfApplyDarkModeClass() {
  try {
    document.body.classList.remove('pf-dark');
    document.documentElement.classList.remove('pf-dark-root');
    // One-time heal: clear a previously saved preference.
    const { pfDarkModeEnabled } = await chrome.storage.local.get('pfDarkModeEnabled');
    if (pfDarkModeEnabled === true) {
      await chrome.storage.local.set({ pfDarkModeEnabled: false });
    }
  } catch (_) { /* best-effort */ }
}

/** Sync the profile toggle: permanently off + disabled, "Coming soon" note. */
async function pfSyncDarkModeToggleUI() {
  const toggle = $('pfDarkModeToggle');
  const note = $('pfDarkModeNote');
  const label = $('pfDarkModeLabel');
  if (!toggle) return;
  try {
    toggle.checked = false;
    toggle.disabled = true;
    if (label) {
      label.style.opacity = '0.45';
      label.style.cursor = 'not-allowed';
      label.title = 'Coming soon';
    }
    if (note) {
      note.hidden = false;
      note.textContent = 'Coming soon';
    }
  } catch (_) { /* best-effort */ }
}

function applyTheme(themeId) {
  const isNotebook = themeId === 'notebook';
  if (typeof pfCacheSelectedTheme === 'function') {
    pfCacheSelectedTheme(themeId);
  }
  if (isNotebook && typeof pfEnsureNotebookFonts === 'function') {
    void pfEnsureNotebookFonts().then(() => {
      if (typeof drawTypingChart === 'function') {
        try { drawTypingChart(); } catch (_) { /* chart may not be ready yet */ }
      }
      // Notebook is light-only — re-evaluate (removes pf-dark) + regray the toggle.
      void pfApplyDarkModeClass();
      void pfSyncDarkModeToggleUI();
    });
    return;
  }
  document.body.classList.toggle('theme-notebook', isNotebook);
  document.documentElement.classList.toggle('theme-notebook', isNotebook);
  document.documentElement.classList.remove('fonts-loading');
  document.documentElement.classList.add('fonts-ready');
  if (typeof drawTypingChart === 'function') {
    try { drawTypingChart(); } catch (_) { /* chart may not be ready yet */ }
  }
  // Re-evaluate dark mode for the newly applied skin.
  void pfApplyDarkModeClass();
  void pfSyncDarkModeToggleUI();
}

async function selectTheme(themeId) {
  if (!themeId) return;
  // Step 12: a skin swap re-renders the carousel + swaps fonts, and every
  // reposition path that fired mid-swap computed garbage coords (box dipped
  // to mid-screen for a beat — user report ×2). Mute ALL tutor repositioning
  // for the swap window; the step-11 settle passes re-seat cleanly after.
  // Extended from 900ms → 1500ms (user report 2026-07 v43: "its still moving
  // up") to cover font-load completion + the carousel reflow tail, so the
  // 300/1000ms settle passes during the swap are also suppressed.
  if (document.body.classList.contains('tutorial-active') && currentStep === 11) {
    pfTutorRepositionMuteUntil = Date.now() + 1500;
  }
  void pfAnalyticsCapture('theme_selected', { theme: themeId });
  await chrome.storage.local.set({ selectedTheme: themeId });
  applyTheme(themeId);
  document.querySelectorAll('.theme-card.theme-owned').forEach((card) => {
    card.classList.toggle('theme-selected', card.dataset.themeId === themeId);
  });
  if (document.body.classList.contains('tutorial-active') && currentStep >= 11) {
    syncTutorialTutorFontFromTheme(themeId, currentStep);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('unprodTimerStartBtn');
  const pauseBtn = document.getElementById('unprodTimerPauseBtn');
  const cancelBtn = document.getElementById('unprodTimerCancelBtn');
  if (startBtn) startBtn.onclick = () => { void startUnprodTimer(); };
  if (pauseBtn) pauseBtn.onclick = pauseUnprodTimer;
  if (cancelBtn) cancelBtn.onclick = () => { void cancelUnprodTimer(); };
  const studyStartBtn = document.getElementById('studyTimerStartBtn');
  if (studyStartBtn) studyStartBtn.onclick = () => { void startStudyTimer(); };
  const studyStopBtn = document.getElementById('studyTimerStopBtn');
  if (studyStopBtn) studyStopBtn.onclick = () => { void stopStudyTimer('cancelled'); };
  const studyPauseBtn = document.getElementById('studyTimerPauseBtn');
  if (studyPauseBtn) studyPauseBtn.onclick = async () => {
    const wid = await getCurrentWindowIdForTimer();
    if (wid == null) return;
    await chrome.runtime.sendMessage({ action: 'pauseTimer', windowId: wid }).catch(() => {});
    await renderTimerUiFromSnapshot();
  };
  const studyResumeBtn = document.getElementById('studyTimerResumeBtn');
  if (studyResumeBtn) studyResumeBtn.onclick = async () => {
    const wid = await getCurrentWindowIdForTimer();
    if (wid == null) return;
    await chrome.runtime.sendMessage({ action: 'resumeTimer', windowId: wid }).catch(() => {});
    await renderTimerUiFromSnapshot();
  };

  // Theme-card clicks via DELEGATION on the carousel container (user report
  // 2026-07: "clicking the default skin on step 12 doesn't unlock Next").
  // The old direct bindings attached to the card NODES before/around
  // initThemeCarousel(), which can rebuild the carousel's children — the
  // bound node gets detached, the visible card runs only the generic theme
  // select, and the tutorial flags never get written. The container
  // survives rebuilds, so this always fires.
  const themeCarouselEl = document.getElementById('themeCarousel');
  if (themeCarouselEl && themeCarouselEl.dataset.pfTutorialBound !== '1') {
    themeCarouselEl.dataset.pfTutorialBound = '1';
    themeCarouselEl.addEventListener('click', (e) => {
      const card = e.target?.closest?.('#themeCardNotebook, #themeCardTutorialBackground');
      if (!card) return;
      if (card.id === 'themeCardNotebook') void handleTutorialNotebookSelect();
      else void handleTutorialBackgroundSelect();
    });
  }

  void initThemeCarousel();
  bindTimerHmsInputs();

  startDashboardTimerPoll();
  void renderTimerUiFromSnapshot();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.pfTimerSession) return;
    void renderTimerUiFromSnapshot();
  });
});

// ── Recaps: Daily / Weekly Wrapped / Monthly Wrapped ────────────────────────
// Rendered below the Productive vs Unproductive charts. The daily is always
// YESTERDAY's (an unopened one is simply replaced by the next day's), the
// weekly covers the last completed Mon–Sun week, the monthly the last
// completed calendar month. Data source: pfRecapDailySummaries (45-day
// worker-side rollup archive).

let pfRecapCurrent = null;
let pfRecapBound = false;

// FONT ACTIVATION (user report 2026-07: "the fonts are not in there"): the
// Caveat wordmark font IS bundled (fonts/Caveat-Bold.woff2, loaded via
// themes/fonts.css) but a @font-face only ACTIVATES when some CSS uses it —
// and only the notebook theme does. Canvas ignores non-activated webfonts,
// so on the default theme every card's "PlayingFild" wordmark silently fell
// back to cursive. Force-load it before any card render.
let pfRecapFontsReady = null;
function pfEnsureRecapFonts() {
  if (!pfRecapFontsReady) {
    pfRecapFontsReady = Promise.allSettled([
      document.fonts.load('700 48px Caveat'),
      document.fonts.load('400 48px Caveat')
    ]).catch(() => {});
  }
  return pfRecapFontsReady;
}

async function pfRecapLoadState() {
  const stored = await chrome.storage.local.get([
    'pfRecapDailySummaries', 'pfRecapSeen', 'currentStreak'
  ]);
  return {
    summaries: stored.pfRecapDailySummaries || {},
    seen: stored.pfRecapSeen || {},
    streak: Number(stored.currentStreak) || 0
  };
}

function pfRecapBanner({ kind, kicker, line, sub, recap, gentle = false }) {
  const banner = document.createElement('button');
  banner.type = 'button';
  banner.className = 'pf-recap-pill';
  banner.dataset.kind = kind;
  const dot = document.createElement('span');
  dot.className = 'pf-recap-new';
  dot.setAttribute('aria-label', 'New');
  const k = document.createElement('div');
  k.className = 'pf-recap-kicker';
  k.textContent = kicker;
  const body = document.createElement('div');
  body.className = 'pf-recap-body';
  const l = document.createElement('div');
  l.className = 'pf-recap-line';
  l.textContent = line;
  body.appendChild(l);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'pf-recap-sub';
    s.textContent = sub;
    body.appendChild(s);
  }
  const open = document.createElement('span');
  open.className = 'pf-recap-open';
  open.textContent = 'Open →';
  banner.appendChild(dot);
  banner.appendChild(k);
  banner.appendChild(body);
  banner.appendChild(open);
  // Loot-chest flow: the banner opens the sealed chest, NOT the modal.
  // Three clicks pop the locks, then the cards spill out; clicking a card
  // opens the classic breakdown/share modal for that card.
  // GENTLE days skip the chest AND the confetti — a rough day gets a calm
  // reflection, not a celebration.
  banner.addEventListener('click', async () => {
    // INSTANT REMOVE (user spec 2026-07 v12): drop the banner from the
    // DOM synchronously so the user sees it go away the frame they
    // click, not after the async markSeen + re-render round-trip.
    // Belt-and-braces: still call pfRecapMarkSeen + pfRecapRenderRail
    // so persisted state + the tab badge reconcile.
    try { banner.remove(); } catch (_) {}
    try {
      await pfRecapMarkSeen(recap);
      void pfRecapRenderRail();
    } catch (_) { /* best-effort — the open still runs below */ }
    if (gentle) { void pfRecapOpenModal(recap, { celebrate: false }); return; }
    void pfRecapOpenChest(recap);
  });

  // Dismiss ✕ removed per user spec 2026-07 v14 — the banner is dismissed
  // by clicking Open (which marks it seen via the chest reveal / modal
  // path); a separate close button was redundant and visually broke the
  // pill layout under some themes. Applies to both the live rail banner
  // and the tutorial demo banner (which is a clone of this one).
  return banner;
}

/**
 * TRANSIENT banner rail (above the PVU chart): only recaps that are READY
 * and UNSEEN render. Opening or dismissing one marks it seen and it
 * disappears until the next daily/weekly/monthly recap replaces it.
 */
async function pfRecapRenderRail() {
  const rail = $('pfRecapRail');
  const section = $('pfRecapSection');
  if (!rail || !section) return;
  const { summaries, seen, streak } = await pfRecapLoadState();
  const now = Date.now();
  const daily = buildDailyRecap(summaries, { now, streak });
  const weekly = buildWeeklyRecap(summaries, { now });
  const monthly = buildMonthlyRecap(summaries, { now });
  rail.replaceChildren();

  const banners = [];
  // Biggest moment first: monthly > weekly > daily.
  if (monthly && seen.monthly !== monthly.key) {
    const hero = recapHeroNumber(monthly.heroSec);
    banners.push(pfRecapBanner({
      kind: 'monthly', kicker: 'MONTHLY WRAPPED', recap: monthly,
      line: `${hero.value} ${hero.unit} ${monthly.heroLabel}`,
      sub: monthly.dateLabel
    }));
  }
  if (weekly && seen.weekly !== weekly.key) {
    const hero = recapHeroNumber(weekly.heroSec);
    banners.push(pfRecapBanner({
      kind: 'weekly', kicker: 'WEEKLY WRAPPED', recap: weekly,
      line: `${hero.value} ${hero.unit} of deep focus`,
      sub: weekly.dateLabel
    }));
  }
  if (daily && seen.daily !== daily.key) {
    // Mood-adaptive daily banner (user spec 2026-07): celebrate the good
    // days, show progress on average days, be GENTLE on the bad ones.
    if (daily.mood === 'empty') {
      // Barely-used day: show NOTHING (user spec 2026-07: "the old white
      // daily recap shows up even though I have no new data"). A day with
      // almost no tracked time has nothing to open and doesn't deserve a
      // banner — the quiet pill read as clutter on fresh logins.
    } else if (daily.mood === 'reset') {
      // High-distraction day: "Tomorrow is a reset" + settings choice.
      banners.push(pfRecapResetBanner(daily));
    } else if (daily.mood === 'rough') {
      // Low-focus day: gentle reflection + one small improvement. Opens
      // the breakdown DIRECTLY (no loot chest, no confetti — a rough day
      // is not a celebration).
      const hasCount = daily.heroCount != null;
      banners.push(pfRecapBanner({
        kind: 'daily', kicker: 'SMALL STEPS STILL COUNT', recap: daily,
        line: hasCount
          ? `You completed ${daily.heroCount} ${daily.heroCountUnit} yesterday.`
          : (daily.insights[0] || 'A quieter day — that happens.'),
        // Don't repeat the line: sessions-line → improvement sub;
        // improvement-line → weekly tease sub.
        sub: hasCount ? (daily.insights[0] || daily.tease || '') : (daily.tease || ''),
        gentle: true
      }));
    } else {
      // Intrigue copy (user spec 2026-07): lead with the tease, keep the
      // number as the sub — the reveal belongs to the chest.
      banners.push(pfRecapBanner({
        kind: 'daily', kicker: 'DAILY WRAPPED', recap: daily,
        line: 'We noticed something about how you work.',
        sub: `${recapHeroNumber(daily.heroSec).value} ${recapHeroNumber(daily.heroSec).unit} ${daily.heroLabel}`
      }));
    }
  }
  // First-day teaser REMOVED (user spec 2026-07: "I'm still getting the
  // weird popup when I'm a new user without any data"): a brand-new user
  // sees NO recap banner of any kind until a real recap exists.

  for (const b of banners) rail.appendChild(b);
  section.hidden = banners.length === 0;
  // First-time notice below weekly/monthly banners (user spec 2026-07 v15).
  // Only fires once per kind. Runs after banners are appended so the
  // note lands underneath.
  try {
    if (weekly && seen.weekly !== weekly.key) {
      void pfMaybeShowFirstTimeNotifNote('weekly', rail);
    }
    if (monthly && seen.monthly !== monthly.key) {
      void pfMaybeShowFirstTimeNotifNote('monthly', rail);
    }
  } catch (_) { /* best-effort */ }
  // Top-level tab badge (user spec 2026-07): show a pulsing green dot on
  // the "Stats & Words" tab whenever any recap is unseen and ready — the
  // user needs the cue even when they're on a different top-level tab
  // (Windows, Settings, etc.), so it lives on the top tab, not the
  // sub-tab. Hides itself as soon as the last unseen recap is opened
  // (this render re-runs on pfRecapMarkSeen).
  const badge = $('statsTabRecapBadge');
  if (badge) badge.hidden = banners.length === 0;
}

// pfRecapQuietBanner + first-day teaser removed (2026-07): new users
// and empty days show no recap banner at all.

/**
 * Deep-link handler for the in-page Wrapped toast (user spec 2026-07 v15):
 * clicking the toast opens the dashboard with ?openWrapped=<kind>&example=1
 * and this function injects a synthetic banner into the rail so the
 * flash-highlight has something to land on. Falls back to the existing
 * dev-example builder — same recap, same slides, same chest opening.
 */
async function pfInjectExampleWrappedBanner(kind) {
  const rail = document.getElementById('pfRecapRail');
  const section = document.getElementById('pfRecapSection');
  if (!rail || !section) return;
  // Switch to the Stats sub-tab so the rail is visible.
  const statsBtn = document.getElementById('statsTab');
  if (statsBtn) statsBtn.click();
  if (typeof switchSubTab === 'function') switchSubTab('siteTime', { persist: false });
  const now = Date.now();
  const dayAt = (n) => { const d = new Date(now - n * 864e5); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const day = (n, over = {}) => ({
    ts: dayAt(n),
    p: 3 * 3600 + 12 * 60, u: 42 * 60, n: 18 * 60, eng: 18,
    topHosts: [
      ['docs.google.com', 5400, 'Productive'],
      ['github.com', 3600, 'Productive'],
      ['youtube.com', 1500, 'Unproductive']
    ],
    hourlyP: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 12 ? 2800 : (h >= 14 && h < 17 ? 1800 : 0))),
    closesByHost: { 'youtube.com': 3 },
    reorders: 21, shields: 2, timers: 3, breaks: 2,
    ...over
  });
  let recap = null;
  let kicker = '';
  let line = '';
  let sub = '';
  let demoSummaries = null;
  if (kind === 'daily') {
    demoSummaries = { d1: day(1), d2: day(2, { p: 2 * 3600 + 30 * 60 }) };
    recap = buildDailyRecap(demoSummaries, { now, streak: 4 });
    if (!recap) return;
    kicker = 'DAILY WRAPPED (EXAMPLE)';
    line = 'We noticed something about how you work.';
    const h = recapHeroNumber(recap.heroSec);
    sub = `${h.value} ${h.unit} ${recap.heroLabel}`;
  } else if (kind === 'weekly') {
    demoSummaries = {};
    for (let i = 1; i <= 7; i++) demoSummaries['w' + i] = day(i);
    recap = buildWeeklyRecap(demoSummaries, { now });
    if (!recap) return;
    const h = recapHeroNumber(recap.heroSec);
    kicker = 'WEEKLY WRAPPED (EXAMPLE)';
    line = `${h.value} ${h.unit} of deep focus`;
    sub = recap.dateLabel;
  } else if (kind === 'monthly') {
    demoSummaries = {};
    for (let i = 1; i <= 30; i++) demoSummaries['m' + i] = day(i);
    recap = buildMonthlyRecap(demoSummaries, { now });
    if (!recap) return;
    const h = recapHeroNumber(recap.heroSec);
    kicker = 'MONTHLY WRAPPED (EXAMPLE)';
    line = `${h.value} ${h.unit} ${recap.heroLabel}`;
    sub = recap.dateLabel;
  }
  if (!recap) return;
  let demoSlides = [];
  try {
    demoSlides = buildRecapSlides(demoSummaries, kind, { now, streak: 4 }) || [];
  } catch (_) { /* fall back to single-card */ }
  if (!demoSlides.length) demoSlides = [recap];
  // Remove any prior example banner.
  rail.querySelectorAll('[data-pf-dev-example="1"]').forEach((el) => el.remove());
  const banner = pfRecapBanner({ kind, kicker, line, sub, recap });
  banner.dataset.pfDevExample = '1';
  banner.onclick = null;
  banner.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    try { banner.remove(); } catch (_) {}
    void pfRecapOpenChest(recap, {
      forceChest: true,
      demo: true,
      slides: demoSlides
    });
  }, true);
  rail.prepend(banner);
  section.hidden = false;
  // First-time notice below the banner for weekly + monthly (user spec
  // 2026-07 v15: "for the very first time they get the notification for
  // weekly and the very first monthly show a small text box below the
  // banner that can be shut that only appears once that says you can
  // turn off notifications in settings").
  try { await pfMaybeShowFirstTimeNotifNote(kind, rail); } catch (_) {}
  // Scroll it into view + flash the highlight. Do NOT auto-open the
  // chest (user spec 2026-07 v17: "if they click the notification don't
  // open it for them let them click it") — just get the banner in front
  // of them, they'll click it when they want.
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  section.classList.remove('pf-recap-focus-flash');
  void section.offsetWidth;
  section.classList.add('pf-recap-focus-flash');
  setTimeout(() => section.classList.remove('pf-recap-focus-flash'), 3400);
}

/**
 * One-shot first-time notice for weekly + monthly Wrapped (user spec
 * 2026-07 v15). Appears BELOW the banner in the rail, only on the
 * user's first-ever weekly / first-ever monthly. Explains they can turn
 * notifications off in the profile → Wrapped Notifications tab, with a
 * button that takes them straight there. Dismisses via X or the button
 * click; either way the flag is persisted so it never re-appears.
 * Daily is intentionally skipped — it fires every day and doesn't need
 * a one-shot note (the user will see the toggle in settings organically).
 */
async function pfMaybeShowFirstTimeNotifNote(kind, rail) {
  if (kind !== 'weekly' && kind !== 'monthly') return;
  if (!rail) return;
  const stored = await chrome.storage.local.get('pfWrappedFirstNotifSeen');
  const seen = stored.pfWrappedFirstNotifSeen || {};
  if (seen[kind]) return;
  // Build the note card. Whole card is clickable → jumps to the
  // Wrapped Notifications settings tab (user spec 2026-07 v17: "if
  // they click notification take them to the wrapped notification
  // also"). No leading emoji per the same spec.
  const note = document.createElement('div');
  note.className = 'pf-wrapped-firstnote';
  note.dataset.kind = kind;
  note.setAttribute('role', 'button');
  note.setAttribute('tabindex', '0');
  const body = document.createElement('div');
  body.className = 'pf-wrapped-firstnote-body';
  const text = document.createElement('span');
  text.className = 'pf-wrapped-firstnote-text';
  text.textContent = kind === 'monthly'
    ? "That's your first Monthly Wrapped notification. You can turn Wrapped notifications off in Settings anytime."
    : "That's your first Weekly Wrapped notification. You can turn Wrapped notifications off in Settings anytime.";
  body.appendChild(text);
  const actions = document.createElement('div');
  actions.className = 'pf-wrapped-firstnote-actions';
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'pf-wrapped-firstnote-btn';
  settingsBtn.textContent = 'Notification settings';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pf-wrapped-firstnote-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';
  actions.appendChild(settingsBtn);
  note.appendChild(body);
  note.appendChild(actions);
  note.appendChild(closeBtn);
  rail.appendChild(note);
  const markSeen = async () => {
    try {
      const cur = await chrome.storage.local.get('pfWrappedFirstNotifSeen');
      const nextSeen = { ...(cur.pfWrappedFirstNotifSeen || {}), [kind]: true };
      await chrome.storage.local.set({ pfWrappedFirstNotifSeen: nextSeen });
    } catch (_) { /* best-effort */ }
    try { note.remove(); } catch (_) {}
  };
  const goToWrappedNotifSettings = async () => {
    await markSeen();
    const anchor = document.getElementById('pfProfileAnchor');
    if (anchor) anchor.click();
    setTimeout(() => {
      const tabBtn = document.querySelector('.pf-profile-tab[data-profile-tab="wrapped"]');
      if (tabBtn) tabBtn.click();
      const panel = document.getElementById('pfProfileTabWrapped');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 220);
  };
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void markSeen();
  });
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void goToWrappedNotifSettings();
  });
  note.addEventListener('click', () => { void goToWrappedNotifSettings(); });
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void goToWrappedNotifSettings();
    }
  });
  // Also disappear when the banner ABOVE the notice is opened — clicking
  // the banner marks the recap seen; the note has served its purpose.
  const bannerAbove = rail.querySelector('.pf-recap-pill[data-kind="' + kind + '"]');
  if (bannerAbove) {
    bannerAbove.addEventListener('click', () => { void markSeen(); }, { once: true, capture: true });
  }
}


/**
 * Very-bad-day banner (mood: reset): "Tomorrow is a reset" with a real
 * choice instead of a recap — [Keep settings] dismisses, [Adjust limits]
 * scrolls to the Unproductive Tab Closer settings. No chest, no confetti.
 */
function pfRecapResetBanner(recap) {
  const banner = document.createElement('div'); // div: two inner buttons
  banner.className = 'pf-recap-pill pf-recap-reset';
  banner.dataset.kind = 'daily';
  const k = document.createElement('div');
  k.className = 'pf-recap-kicker';
  k.textContent = 'TOMORROW IS A RESET';
  const body = document.createElement('div');
  body.className = 'pf-recap-body';
  const l = document.createElement('div');
  l.className = 'pf-recap-line';
  l.textContent = recap.resetLine || 'Tomorrow is a reset';
  const s = document.createElement('div');
  s.className = 'pf-recap-sub';
  s.textContent = recap.resetSub
    || 'PlayingFild noticed you had a high-distraction day. Want to tighten your focus settings?';
  body.appendChild(l);
  body.appendChild(s);
  const actions = document.createElement('div');
  actions.className = 'pf-recap-reset-actions';
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'pf-recap-reset-btn';
  keep.textContent = 'Keep settings';
  keep.addEventListener('click', async () => {
    await pfRecapMarkSeen(recap);
    void pfRecapRenderRail();
  });
  const adjust = document.createElement('button');
  adjust.type = 'button';
  adjust.className = 'pf-recap-reset-btn pf-recap-reset-primary';
  adjust.textContent = 'Adjust settings';
  adjust.addEventListener('click', async () => {
    await pfRecapMarkSeen(recap);
    void pfRecapRenderRail();
    // Take them straight to the Window tab → Reminders card → highlight the
    // "Remind me on unproductive tabs" checkbox (user spec 2026-07) so they
    // can shorten the timer or turn the reminder off after a distracting day.
    switchMainTab('window', { force: true });
    // Wait one frame so the Window section is displayed before we try to
    // measure the reminder row for scrolling.
    requestAnimationFrame(() => {
      const toggle = $('unprodReminderToggle');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      const target = $('unprodReminderEnabledRow')
        || $('unprodReminderDropdown')
        || $('enforcerToggleRow');
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const row = $('unprodReminderEnabledRow');
      if (row) {
        // Re-triggerable pulse: remove the class first so the animation
        // restarts even if the user clicks Adjust more than once.
        row.classList.remove('pf-adjust-highlight');
        // Force reflow so removing + re-adding actually restarts CSS anim.
        void row.offsetWidth;
        row.classList.add('pf-adjust-highlight');
        window.setTimeout(() => row.classList.remove('pf-adjust-highlight'), 4000);
      }
    });
  });
  actions.appendChild(keep);
  actions.appendChild(adjust);
  banner.appendChild(k);
  banner.appendChild(body);
  banner.appendChild(actions);
  return banner;
}

async function pfRecapMarkSeen(recap) {
  try {
    const stored = await chrome.storage.local.get('pfRecapSeen');
    const seen = { ...(stored.pfRecapSeen || {}) };
    seen[recap.kind] = recap.key;
    await chrome.storage.local.set({ pfRecapSeen: seen });
  } catch (_) { /* best-effort */ }
}

/**
 * Animate a numeric hero value from 0 → target over ~900ms with an ease-out
 * curve so the last third slows and lands with weight. Uses tabular-nums so
 * the digits don't wiggle horizontally as they change.
 */
function pfRecapAnimateHero(heroEl, targetValue) {
  const target = Number(targetValue);
  const numeric = !Number.isNaN(target) && Number.isFinite(target);
  if (!numeric || target <= 0) return;
  const start = performance.now();
  const duration = 900;
  const isInt = String(targetValue).indexOf('.') === -1;
  const decimals = isInt ? 0 : (String(targetValue).split('.')[1] || '').length;
  const smallUnit = heroEl.querySelector('small');
  const unitText = smallUnit?.textContent || '';
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    const cur = target * eased;
    const formatted = decimals > 0 ? cur.toFixed(decimals) : String(Math.round(cur));
    heroEl.firstChild.textContent = formatted;
    if (t < 1) requestAnimationFrame(frame);
    else heroEl.firstChild.textContent = String(targetValue);
  }
  // Text node first, then re-append the small so the animation only touches the digits.
  heroEl.textContent = '0';
  if (unitText) {
    const s = document.createElement('small');
    s.textContent = unitText;
    heroEl.appendChild(s);
  }
  requestAnimationFrame(frame);
}

function pfRecapBuildModalBody(recap, streak = 0) {
  const body = $('pfRecapModalBody');
  if (!body) return;
  body.replaceChildren();
  // 2026-07 (user spec): the modal used to render the recap AGAIN as a
  // plain-text block (title / EXAMPLE tag / hero hours / bullets / streak
  // tease) above the share card — the same info twice. All of it is gone,
  // for demo AND real cards: the rendered card preview + Story/Post +
  // Save/Copy are the whole modal now.
  return;
  // eslint-disable-next-line no-unreachable -- kept for reference; the old
  // text-block builder below is intentionally dead.
  const title = document.createElement('h2');
  title.className = 'pf-recap-modal-title';
  title.textContent = recap.title;
  // Streak chip beside the title — small dopamine hit for consistent users.
  if (streak >= 2) {
    const chip = document.createElement('span');
    chip.className = 'pf-recap-streak';
    const dot = document.createElement('span');
    dot.className = 'pf-recap-streak-dot';
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(`${streak}-day streak`));
    title.appendChild(chip);
  }
  const date = document.createElement('div');
  date.className = 'pf-recap-modal-date';
  date.textContent = recap.dateLabel || '';
  body.appendChild(title); body.appendChild(date);

  // Spotlight slides (Distraction / Streak) carry a raw count instead of
  // seconds — mirror recap_cards.js's hero resolution or they'd show "0 s".
  const hero = recap.heroCount != null
    ? { value: String(recap.heroCount), unit: recap.heroCountUnit || '' }
    : recapHeroNumber(recap.heroSec);
  const heroEl = document.createElement('div');
  heroEl.className = 'pf-recap-hero';
  heroEl.textContent = hero.value;
  const unit = document.createElement('small');
  unit.textContent = hero.unit;
  heroEl.appendChild(unit);
  body.appendChild(heroEl);
  // Kick off the count-up on next frame so layout settles first.
  requestAnimationFrame(() => pfRecapAnimateHero(heroEl, hero.value));
  const heroLabel = document.createElement('div');
  heroLabel.className = 'pf-recap-hero-label';
  heroLabel.textContent = recap.heroLabel || '';
  body.appendChild(heroLabel);
  if (recap.heroDetail) {
    const hd = document.createElement('div');
    hd.className = 'pf-recap-hero-detail';
    hd.textContent = recap.heroDetail;
    body.appendChild(hd);
  }

  if (Array.isArray(recap.stats) && recap.stats.length) {
    const grid = document.createElement('div');
    grid.className = 'pf-recap-statgrid';
    recap.stats.forEach((s, i) => {
      const cell = document.createElement('div');
      cell.className = 'pf-recap-stat';
      // Stagger each cell so they cascade in — 60ms per cell.
      cell.style.animationDelay = `${300 + i * 60}ms`;
      const v = document.createElement('b');
      v.textContent = s.value;
      const l = document.createElement('span');
      l.textContent = s.label;
      cell.appendChild(v); cell.appendChild(l);
      grid.appendChild(cell);
    });
    body.appendChild(grid);
  }

  if (Array.isArray(recap.insights) && recap.insights.length) {
    const ul = document.createElement('ul');
    ul.className = 'pf-recap-insights';
    for (const t of recap.insights) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  if (Array.isArray(recap.bars) && recap.bars.length) {
    const wrap = document.createElement('div');
    wrap.className = 'pf-recap-bars';
    const max = Math.max(...recap.bars.map((b) => b.sec), 1);
    recap.bars.forEach((b, i) => {
      const col = document.createElement('div');
      col.className = 'pf-recap-bar';
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(4, Math.round((b.sec / max) * 70))}px`;
      // Stagger the bar grow-up so it feels like a mini animation.
      bar.style.animationDelay = `${450 + i * 70}ms`;
      bar.title = recapFmtDur(b.sec);
      const label = document.createElement('span');
      label.textContent = b.label;
      col.appendChild(bar); col.appendChild(label);
      wrap.appendChild(col);
    });
    body.appendChild(wrap);
  }

  if (recap.tease) {
    const tease = document.createElement('div');
    tease.className = 'pf-recap-tease';
    tease.textContent = recap.tease;
    body.appendChild(tease);
  }
}

/**
 * Fire a modest confetti burst above the modal card on open. Uses the shared
 * pfFireConfirmConfetti helper (already loaded by other feature paths).
 * Respects prefers-reduced-motion — pfFireConfirmConfetti short-circuits.
 */
function pfRecapFireOpenConfetti() {
  try {
    const modal = $('pfRecapModal');
    if (!modal) return;
    const card = modal.querySelector('.pf-recap-modal-card');
    const rect = card?.getBoundingClientRect();
    const originX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const originY = rect ? rect.top + rect.height * 0.25 : window.innerHeight / 3;
    if (typeof window.pfFireConfirmConfetti === 'function') {
      window.pfFireConfirmConfetti(originX, originY);
    }
  } catch (_) { /* confetti is optional */ }
}

async function pfRecapOpenModal(recap, { markSeen = true, celebrate = true } = {}) {
  const modal = $('pfRecapModal');
  if (!modal) return;
  // Portal to <body> (same reason as the chest layer): shipped nested in the
  // stats-tab subtree, whose stacking context sits below the tutorial
  // overlay — as a body child its z 10050 always wins.
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  pfRecapCurrent = recap;
  const { streak } = await pfRecapLoadState();
  pfRecapBuildModalBody(recap, streak);

  // Re-render the preview in whatever format is currently selected.
  pfRecapRenderPreview();

  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  // Lock body scroll + block background interaction (user spec 2026-07 v14).
  document.documentElement.classList.add('pf-recap-fullscreen-open');
  document.body.classList.add('pf-recap-fullscreen-open');
  // Reveal dopamine: confetti burst above the card. Fires after the modal is
  // visible so the origin coords are correct. SKIPPED for gentle (rough-day)
  // opens — a low-focus day gets a calm reflection, not a party. Also SKIPPED
  // on the Professional skin (user spec 2026-07 v43: "remove the purple
  // confetti if they're on the professional skin and open the card") — the
  // professional theme is the calm/clean aesthetic, so no confetti there.
  // Confetti only fires on the Notebook (Student) skin.
  const themeStored = await chrome.storage.local.get('selectedTheme');
  const isNotebookSkin = themeStored?.selectedTheme === 'notebook';
  if (celebrate && isNotebookSkin) {
    requestAnimationFrame(() => pfRecapFireOpenConfetti());
  }
  // Spotlight slides from the chest must NOT overwrite the seen key — the
  // main recap was already marked seen when the chest opened, and a
  // spotlight's key would break the rail's `seen[kind] !== recap.key` check.
  if (markSeen) {
    await pfRecapMarkSeen(recap);
    void pfRecapRenderRail(); // clear the NEW dot
  }
}

/** Re-render the in-modal preview canvas in the currently-selected format.
 *  Runs the load-in animation; animateRecapPoster self-cancels on re-call
 *  for the same canvas, so rapid format toggles never fight. */
function pfRecapRenderPreview() {
  const preview = $('pfRecapPreviewCanvas');
  if (!preview || !pfRecapCurrent) return;
  void pfEnsureRecapFonts();
  try {
    animateRecapPoster(preview, pfRecapFormat, pfRecapCurrent, { durationMs: 1400 });
  } catch (e) {
    console.warn('[pf-recap] preview render failed', e);
    try { renderRecapPoster(preview, pfRecapFormat, pfRecapCurrent); } catch (_) { /* static fallback */ }
  }
}

// ── Loot-chest reveal ───────────────────────────────────────────────────────
// Banner → sealed ">=" chest (orbiting dots, shock-shake idle, 3 gold lock
// buckles). Each click jolts the chest and pops one buckle; the 3rd bursts
// it open. Daily reveals ONE of the user's cards (seeded by the recap key so
// the same day always reveals the same card); weekly/monthly spill ALL cards,
// each running the poster load-in animation on a stagger.

let pfRecapChestState = null; // { recap, slides, clicks, cancels[] }

/** Tiny FNV-1a hash — stable per-recap-key card pick for the daily chest. */
function pfRecapHashSeed(str) {
  let hsh = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hsh ^= str.charCodeAt(i);
    hsh = Math.imul(hsh, 16777619);
  }
  return hsh >>> 0;
}

async function pfRecapOpenChest(recap, opts = {}) {
  const layer = $('pfRecapChest');
  const box = $('pfRecapChestBox');
  if (!layer || !box) { void pfRecapOpenModal(recap); return; } // graceful fallback
  // PORTAL the layer to <body>: it ships nested inside #topSitesContent →
  // #statsSection → .content-box, and during the tutorial those ancestors
  // form a stacking context BELOW the opaque tutorial overlay (z 10000) —
  // the chest opened invisibly behind it (user report 2026-07). As a direct
  // body child its z 10060 wins everywhere. Listeners survive the move.
  if (layer.parentElement !== document.body) document.body.appendChild(layer);
  // CHEST ON EVERY THEME (user spec 2026-07 v6): "make the daily wrapped
  // on the stats and words for the default the same as the notebook one."
  // The theme gate that fell back to the plain modal on non-notebook skins
  // is removed — professional/default users now get the same crate-opening
  // ceremony. Only exception: never inside the guided tutorial (the
  // fullscreen unboxing would interrupt the step flow).
  if (!opts.forceChest && document.body.classList.contains('tutorial-active')) {
    void pfRecapOpenModal(recap);
    return;
  }
  // Fonts must be ACTIVE before the reveal draws its cards — the 3-click
  // unlock gives this plenty of time, but await anyway for slow disks.
  await pfEnsureRecapFonts();
  let slides = [];
  if (Array.isArray(opts.slides) && opts.slides.length) {
    slides = opts.slides; // demo/preset cards (tutorial example)
  } else {
    try {
      const { summaries, streak } = await pfRecapLoadState();
      slides = buildRecapSlides(summaries, recap.kind, { now: Date.now(), streak }) || [];
    } catch (e) {
      console.warn('[pf-recap] slide build failed', e);
    }
  }
  if (!slides.length) slides = [recap];
  pfRecapChestState = { recap, slides, clicks: 0, cancels: [], demo: !!opts.demo };

  // Reset the chest UI (it may have been opened before this session).
  box.hidden = false;
  box.classList.remove('opening', 'jolt');
  box.classList.add('idle');
  // .pf-chest-buckle was the raytraced fallback layer (removed in v21).
  // querySelectorAll returns an empty NodeList for a missing selector, so
  // the forEach is a safe no-op — kept for the sake of not touching more
  // code, harmless when the fallback markup isn't there.
  box.querySelectorAll('.pf-chest-buckle').forEach((b) => b.classList.remove('popped'));
  const hint = $('pfRecapChestHint');
  if (hint) { hint.hidden = false; hint.textContent = 'Click to unlock'; }
  // Re-arm the locks-remaining dots for a fresh open.
  document.querySelectorAll('#pfRecapChestDots .pf-chest-dot').forEach((d) => d.classList.remove('gone'));
  const cards = $('pfRecapChestCards');
  if (cards) { cards.replaceChildren(); cards.hidden = true; }
  const note = $('pfRecapChestNote');
  if (note) note.hidden = true;
  layer.dataset.kind = recap.kind;
  layer.hidden = false;
  layer.setAttribute('aria-hidden', 'false');
  // is-revealed is added ONLY after the reveal animation completes (in
  // pfRecapChestReveal → spillCards path). Keeps the ✕ hidden during the
  // idle + click-through-buckles + opening-animation phases so it doesn't
  // distract from the ceremony (user spec 2026-07 v14 "till the end").
  layer.classList.remove('is-revealed');
  // Lock body scroll + block background interaction during the entire
  // recap experience — no wheel/keyboard scroll behind the overlay, no
  // stray clicks landing on the dashboard.
  document.documentElement.classList.add('pf-recap-fullscreen-open');
  document.body.classList.add('pf-recap-fullscreen-open');
  // LIVE Three.js crate (chest_scene.bundle.js): mount once and drive it;
  // if WebGL is unavailable the class stays off and the raytraced image
  // fallback (base + clasp overlays + APNG) renders instead.
  try {
    const webglHost = box.querySelector('.pf-chest-webgl');
    if (webglHost && window.PFChestScene) {
      // Theme BEFORE mount so first paint is already tinted (daily = neon
      // green/teal, weekly = reddish-pink, monthly = brand purple).
      window.PFChestScene.setTheme?.(recap.kind);
      const live = window.PFChestScene.active || window.PFChestScene.mount(webglHost);
      box.classList.toggle('pf-webgl-live', !!live);
      if (live) {
        window.PFChestScene.reset();
        window.PFChestScene.setTheme?.(recap.kind);
      }
    }
  } catch (_) { box.classList.remove('pf-webgl-live'); }
  // Wrapped reveals go FULLSCREEN (user spec 2026-07). Banner click is a
  // user gesture so the request is allowed; failure (kiosk policy, iframe,
  // user denies) is non-fatal — the overlay already covers the viewport.
  try {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  } catch (_) { /* best-effort */ }
  box.focus({ preventScroll: true });
}

function pfRecapChestClick() {
  const st = pfRecapChestState;
  const box = $('pfRecapChestBox');
  if (!st || !box || st.clicks >= 3 || box.classList.contains('opening')) return;
  st.clicks++;
  // Pop this click's buckle and replay the jolt (class remove + reflow +
  // re-add restarts the CSS animation reliably).
  box.querySelector(`.pf-chest-buckle[data-i="${st.clicks - 1}"]`)?.classList.add('popped');
  box.classList.remove('jolt');
  void box.offsetWidth;
  box.classList.add('jolt');
  // Live 3D crate: anticipation jolt (shake + strobe + latch release).
  if (box.classList.contains('pf-webgl-live') && window.PFChestScene?.active) {
    try { window.PFChestScene.jolt(st.clicks - 1); } catch (_) { /* fallback visuals continue */ }
  }
  // No lock-countdown text (user spec): the hint simply disappears on the
  // first click and the visuals carry the progression from there. The
  // locks-remaining DOTS carry the count instead — one fades per click.
  const hint = $('pfRecapChestHint');
  if (hint) hint.hidden = true;
  document.querySelector(`#pfRecapChestDots .pf-chest-dot[data-i="${st.clicks - 1}"]`)?.classList.add('gone');
  if (st.clicks === 3) void pfRecapChestReveal();
}

async function pfRecapChestReveal() {
  const st = pfRecapChestState;
  const box = $('pfRecapChestBox');
  if (!st || !box) return;
  // Seen at the moment of reveal: closing mid-locks keeps the banner alive.
  // (Never for the tutorial demo — a fake recap must not pollute the seen
  // map and suppress the user's first REAL banner.)
  if (!st.demo) {
    await pfRecapMarkSeen(st.recap);
    void pfRecapRenderRail();
  }
  const webglLive = box.classList.contains('pf-webgl-live') && window.PFChestScene?.active;
  const spillCards = () => {
    if (pfRecapChestState !== st) return; // closed mid-burst
    // Loot draw (user spec): daily = 1 RANDOM card; weekly = 3 RANDOM cards
    // in a random order; monthly = every card. Fisher–Yates so every
    // pick/order is equally likely — a fresh draw on every open.
    const deck = [...st.slides];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const chosen = st.recap.kind === 'daily' ? deck.slice(0, 1)
      : st.recap.kind === 'weekly' ? deck.slice(0, 3)
      : st.slides;
    // Reveal → STORY VIEWER: tear down the chest but STAY in fullscreen —
    // the whole card experience runs fullscreen and only the viewer's close
    // exits it (user spec 2026-07). Grid clicks open the in-viewer lightbox
    // (big card + copy/download buttons) — identical to the preview site.
    pfRecapCloseChest({ keepFullscreen: true });
    // Stay fullscreen even after the viewer closes (user spec 2026-07) —
    // the browser's native Esc still exits fullscreen whenever they want.
    //
    // BUT the leftover `pf-recap-fullscreen-open` body class force-hides
    // #tutorBox (stats.html CSS uses !important), so if it isn't cleared
    // when the viewer closes, the next tutorial step's coach-mark can never
    // appear (user report 2026-07: "step 14 once I finish opening the box
    // doesnt even show the next text box"). onClose releases both the body
    // class and browser fullscreen the moment the user dismisses the viewer.
    // Capture the recap kind + demo flag NOW — pfRecapChestState is nulled by
    // pfRecapCloseChest above, so `st` (which we captured at the top of
    // pfRecapChestReveal) is the safe reference for the onClose closure.
    const closedRecapKind = st.recap?.kind;
    const closedRecapWasDemo = !!st.demo;
    openRecapStoryViewer(chosen, {
      onClose: () => {
        document.documentElement.classList.remove('pf-recap-fullscreen-open');
        document.body.classList.remove('pf-recap-fullscreen-open');
        pfRecapExitFullscreen();
        // First-monthly-open → prompt for a Chrome Web Store rating
        // (user spec 2026-07 v25). Only for the REAL monthly reveal,
        // never demos or dev triggers. One-shot: `pfMonthlyRatePromptShown`
        // in local storage guards against repeats on subsequent months.
        if (closedRecapKind === 'monthly' && !closedRecapWasDemo) {
          void pfMaybeShowRatePrompt();
        }
      }
    });
  };
  if (webglLive) {
    // LIVE tiered unboxing: build-up shake/strobe (0–0.5s), mechanical
    // release — lid up + armor panels out (0.5–1.2s), then the black loot
    // cards rise + fan by tier (daily 1 / weekly 3 / monthly 5). The scene's
    // "CLICK TO REVEAL" prompt resolves the promise, and the real poster
    // cards spill in beneath the crate at that moment.
    box.classList.remove('idle');
    box.classList.add('opening');
    // No confetti on the crate opening (user spec 2026-07) — the 3D
    // disassembly + light shaft carry the moment on their own.
    try {
      window.PFChestScene.open().then(spillCards);
    } catch (_) {
      setTimeout(spillCards, 1450);
    }
  } else {
    // Fallback: one-shot lid-opening APNG — (re)setting src restarts it
    // (cache-busted so a second open in the same session replays).
    const openAnim = box.querySelector('.pf-chest-openanim');
    if (openAnim) {
      openAnim.src = `${openAnim.getAttribute('data-src')}?t=${Date.now()}`;
    }
    box.classList.remove('idle');
    box.classList.add('opening');
    // 950ms lid swing + light-burst tail.
    setTimeout(spillCards, 950);
  }
}

function pfRecapCloseChest(opts = {}) {
  const layer = $('pfRecapChest');
  if (!layer || layer.hidden) return;
  // Stop any in-flight card animations before tearing down their canvases.
  for (const cancel of (pfRecapChestState?.cancels || [])) {
    try { cancel(); } catch (_) { /* already done */ }
  }
  pfRecapChestState = null;
  layer.hidden = true;
  layer.setAttribute('aria-hidden', 'true');
  layer.classList.remove('is-revealed');
  $('pfRecapChestCards')?.replaceChildren();
  // Release the body-scroll lock — but only if the story viewer isn't
  // taking over next (keepFullscreen indicates the chest→viewer hand-off,
  // and the viewer needs the lock to stay on until IT closes).
  if (!opts.keepFullscreen) {
    document.documentElement.classList.remove('pf-recap-fullscreen-open');
    document.body.classList.remove('pf-recap-fullscreen-open');
  }
  // Leave fullscreen when the reveal closes (only if WE are the reason
  // the page is fullscreen — don't stomp on a fullscreen video).
  // keepFullscreen: the chest→story-viewer hand-off stays fullscreen; the
  // viewer's onClose exits instead (user spec 2026-07).
  if (!opts.keepFullscreen) pfRecapExitFullscreen();
}

function pfRecapExitFullscreen() {
  try {
    if (document.fullscreenElement === document.documentElement) {
      document.exitFullscreen().catch(() => {});
    }
  } catch (_) { /* best-effort */ }
}

// User spec 2026-07 v25: after the user finishes opening their FIRST monthly
// Wrapped chest, ask them (once, ever) to rate the extension on the Chrome
// Web Store. Store-listing URL is fixed. One-shot flag prevents re-asking.
const PF_CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/detail/jacglcjkkcfliokenohoiekpncmbkfhm/preview?hl=en&authuser=0';
const PF_MONTHLY_RATE_PROMPT_KEY = 'pfMonthlyRatePromptShown';

async function pfMaybeShowRatePrompt() {
  try {
    const stored = await chrome.storage.local.get(PF_MONTHLY_RATE_PROMPT_KEY);
    if (stored[PF_MONTHLY_RATE_PROMPT_KEY] === true) return; // already asked
    // Mark FIRST so a mid-render reload doesn't double-fire the prompt.
    await chrome.storage.local.set({ [PF_MONTHLY_RATE_PROMPT_KEY]: true });
  } catch (_) {
    // If storage fails we still want to show it — losing the guard is
    // better than never asking, and the worst case is one extra prompt.
  }
  // Small delay so the story-viewer close animation has time to fade
  // — otherwise the rate modal appears while the viewer is still tearing
  // down and feels stacked/rushed.
  setTimeout(() => { pfShowRatePromptCard(); }, 350);
}

function pfShowRatePromptCard() {
  // Reuse a single host id so a spurious double-fire replaces rather than
  // stacks.
  const HOST_ID = 'pf-rate-prompt-host';
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;color-scheme:light;font-family:-apple-system,system-ui,Segoe UI,sans-serif;pointer-events:none;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      @keyframes pf-rate-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes pf-rate-card-in {
        from { opacity: 0; transform: translateY(12px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0)   scale(1); }
      }
      .backdrop {
        position: fixed; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(20, 16, 40, 0.32);
        -webkit-backdrop-filter: blur(6px) saturate(120%);
        backdrop-filter: blur(6px) saturate(120%);
        animation: pf-rate-fade 0.18s ease;
        pointer-events: auto;
      }
      .card {
        position: relative;
        width: 380px;
        max-width: calc(100vw - 32px);
        padding: 22px 24px 20px;
        border-radius: 18px;
        color: #1f1b2e;
        background: rgba(255, 255, 255, 0.82);
        -webkit-backdrop-filter: blur(22px) saturate(180%);
        backdrop-filter: blur(22px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.55);
        box-shadow: 0 20px 50px rgba(20, 16, 40, 0.28), 0 1px 0 rgba(255, 255, 255, 0.6) inset;
        animation: pf-rate-card-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both;
        text-align: center;
      }
      .stars { font-size: 1.6em; margin: 0 0 8px; color: #f4b400; letter-spacing: 2px; }
      .title { font-weight: 700; color: #5B4B9F; margin: 0 0 6px; font-size: 1.12em; }
      .body { font-size: 0.94em; color: #2a2438; margin: 0 0 16px; line-height: 1.5; }
      .actions { display: flex; gap: 10px; }
      .btn {
        flex: 1; padding: 11px 14px;
        border: none; border-radius: 10px;
        cursor: pointer; font-weight: 600;
        font-size: 0.92em; font-family: inherit;
        transition: background 0.12s ease, transform 0.06s ease;
      }
      .btn:active { transform: translateY(1px); }
      .btn-primary {
        background: linear-gradient(180deg, #6c5cb5 0%, #5B4B9F 100%);
        color: #fff;
        box-shadow: 0 2px 6px rgba(91, 75, 159, 0.35), 0 1px 0 rgba(255, 255, 255, 0.18) inset;
      }
      .btn-primary:hover { background: linear-gradient(180deg, #7869c1 0%, #5040a3 100%); }
      .btn-ignore {
        background: rgba(255, 255, 255, 0.6);
        color: #4a4458;
        border: 1px solid rgba(91, 75, 159, 0.18);
      }
      .btn-ignore:hover { background: rgba(255, 255, 255, 0.85); }
      @media (prefers-color-scheme: dark) {
        .card { background: rgba(30, 28, 46, 0.78); color: #f0eefb; border-color: rgba(255, 255, 255, 0.1); }
        .title { color: #c7bdff; }
        .body { color: #e2dff0; }
        .btn-ignore { background: rgba(255, 255, 255, 0.08); color: #e2dff0; border-color: rgba(255, 255, 255, 0.14); }
      }
    </style>
    <div class="backdrop">
      <div class="card" role="dialog" aria-modal="true" aria-labelledby="pfRateTitle">
        <p class="stars" aria-hidden="true">&#9733;&#9733;&#9733;&#9733;&#9733;</p>
        <p class="title" id="pfRateTitle">Enjoying &gt;=PlayingFild?</p>
        <p class="body">You just opened your first Monthly Wrapped. If it&rsquo;s making a difference, a quick rating on the Chrome Web Store really helps.</p>
        <div class="actions">
          <button class="btn btn-ignore" id="pfRateLater" type="button">Maybe later</button>
          <button class="btn btn-primary" id="pfRateNow" type="button">Rate on Chrome Store</button>
        </div>
      </div>
    </div>
  `;
  const close = () => { try { host.remove(); } catch (_) {} };
  shadow.getElementById('pfRateNow')?.addEventListener('click', () => {
    try { window.open(PF_CHROME_WEB_STORE_URL, '_blank', 'noopener'); } catch (_) {}
    close();
  });
  shadow.getElementById('pfRateLater')?.addEventListener('click', close);
  // Click-outside dismisses (same UX as other modals in the app).
  shadow.querySelector('.backdrop')?.addEventListener('click', (e) => {
    const card = shadow.querySelector('.card');
    if (card && (e.target === card || card.contains(e.target))) return;
    close();
  });
}

function pfRecapSetFormat(fmt) {
  if (fmt !== 'story' && fmt !== 'post') return;
  pfRecapFormat = fmt;
  const s = $('pfRecapFmtStory');
  const p = $('pfRecapFmtPost');
  if (s) s.classList.toggle('is-active', fmt === 'story');
  if (p) p.classList.toggle('is-active', fmt === 'post');
  pfRecapRenderPreview();
}

function pfRecapCloseModal() {
  const modal = $('pfRecapModal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  pfRecapCurrent = null;
  // Release body-scroll lock (user spec 2026-07 v14).
  document.documentElement.classList.remove('pf-recap-fullscreen-open');
  document.body.classList.remove('pf-recap-fullscreen-open');
}

function pfRecapRenderOffscreen(size) {
  const c = document.createElement('canvas');
  renderRecapPoster(c, size, pfRecapCurrent);
  return c;
}

function pfRecapBindOnce() {
  if (pfRecapBound) return;
  pfRecapBound = true;
  $('pfRecapModalClose')?.addEventListener('click', pfRecapCloseModal);
  $('pfRecapModalScrim')?.addEventListener('click', pfRecapCloseModal);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('pfRecapChest')?.hidden) { pfRecapCloseChest(); return; }
    if (!$('pfRecapModal')?.hidden) pfRecapCloseModal();
  });
  // Loot chest: 3 clicks to unlock (keyboard too), ✕/scrim to bail out.
  const chestBox = $('pfRecapChestBox');
  chestBox?.addEventListener('click', pfRecapChestClick);
  chestBox?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pfRecapChestClick(); }
  });
  $('pfRecapChestClose')?.addEventListener('click', pfRecapCloseChest);
  $('pfRecapChestScrim')?.addEventListener('click', pfRecapCloseChest);
  // Format toggle — updates the preview immediately + drives Save/Copy target.
  $('pfRecapFmtStory')?.addEventListener('click', () => pfRecapSetFormat('story'));
  $('pfRecapFmtPost')?.addEventListener('click', () => pfRecapSetFormat('post'));
  // Save image — uses the currently-selected format.
  $('pfRecapSave')?.addEventListener('click', (e) => {
    if (!pfRecapCurrent) return;
    void pfAnalyticsCapture('recap_shared', { kind: pfRecapCurrent.kind || 'unknown', format: pfRecapFormat, action: 'download' });
    const btn = e.currentTarget;
    const variantTag = pfRecapCurrent.variant && pfRecapCurrent.variant !== 'summary'
      ? `-${pfRecapCurrent.variant}` : '';
    void downloadPoster(pfRecapRenderOffscreen(pfRecapFormat),
      `playingfild-${pfRecapCurrent.kind}${variantTag}-${pfRecapFormat}.png`).catch(() => {});
    // Tiny "saved!" confirm on the button so the user sees the click landed.
    const prev = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = prev; }, 1600);
  });
  $('pfRecapCopy')?.addEventListener('click', async (e) => {
    if (!pfRecapCurrent) return;
    void pfAnalyticsCapture('recap_shared', { kind: pfRecapCurrent.kind || 'unknown', format: pfRecapFormat, action: 'copy' });
    const btn = e.currentTarget;
    try {
      await copyPosterToClipboard(pfRecapRenderOffscreen(pfRecapFormat));
      const prev = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = prev; }, 1600);
    } catch (err) {
      console.warn('[pf-recap] clipboard copy failed', err);
      btn.textContent = 'Copy failed — use Save';
      setTimeout(() => { btn.textContent = 'Copy image'; }, 2200);
    }
  });
}

function initRecapSection() {
  if (!$('pfRecapSection')) return;
  pfRecapBindOnce();
  void pfEnsureRecapFonts(); // warm the wordmark font before any card draws
  void pfRecapRenderRail();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initRecapSection(), { once: true });
} else {
  initRecapSection();
}
