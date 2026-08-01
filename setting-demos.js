const $ = (id) => document.getElementById(id);

export const SETTING_DEMO_CYCLE_MS = 24000;
const DISMISS_PREFIX = 'pfSettingDemoDismissed_';

let settingDemoPaused = false;
let openSettingDemoId = null;
let settingDemoDevForceShow = false;

export function setSettingDemoDevForceShow(on) {
  settingDemoDevForceShow = !!on;
}

const DEMO_IDS = [
  'tabLife',
  'studyBreak',
  'modeBEarnSpend',
  'bankedTime',
  'timeEarned',
  'pause',
  'sessionReset'
];

function chromeBar() {
  return '<div class="pf-rank-demo-chrome"><span></span><span></span><span></span><span class="pf-rank-demo-limit">5 tab limit</span></div>';
}

function tab(name, color, left, time, extra = '') {
  return `<span class="pf-rank-tab pf-rank-tab--${color} ${extra}" style="left: ${left}px;">${name}<span class="pf-rank-time">${time}</span></span>`;
}

function tabs(html, dense = false) {
  return `<div class="pf-rank-demo-tabs${dense ? ' pf-rank-demo-tabs--dense' : ''}">${html}</div>`;
}

const SHIELD_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>';

function popupShieldMock(state = 'idle') {
  const cls = state === 'armed' ? 'is-armed' : state === 'active' ? 'is-active' : 'is-idle';
  const countdown = state === 'active'
    ? '<span class="pf-rank-demo-popup-countdown">5:00</span>'
    : '';
  return `<div class="pf-rank-demo-popup" aria-hidden="true">
    <div class="pf-rank-demo-popup-shield ${cls}">${SHIELD_SVG}${countdown}</div>
    <div class="pf-rank-demo-popup-title">&gt;=PlayingFild</div>
    <div class="pf-rank-demo-popup-btn"></div>
  </div>`;
}

function pauseDemoBody(tabsHtml, shieldState = null) {
  const popup = shieldState != null ? popupShieldMock(shieldState) : '';
  return `<div class="pf-rank-demo-pause-wrap">${tabs(tabsHtml, true)}${popup}</div>`;
}

function demoFrame(step, body, calloutText = '', calloutClass = '') {
  const callout = calloutText
    ? `<p class="pf-rank-demo-callout${calloutClass ? ` ${calloutClass}` : ''}">${calloutText}</p>`
    : '';
  return `<div class="pf-rank-demo-frame"><p class="pf-rank-demo-step">${step}</p>${body}${callout}</div>`;
}

function meter(text, kind = 'bank') {
  return `<p class="pf-setting-demo-meter pf-setting-demo-meter--${kind}">${text}</p>`;
}

function stage(frames, captions) {
  return `<div class="pf-rank-demo-scale-wrap"><div class="pf-rank-demo-browser">${chromeBar()}<div class="pf-rank-demo-stage">${frames.join('')}</div></div><div class="pf-rank-demo-caption-wrap">${captions.map((c) => `<p class="pf-rank-demo-caption">${c}</p>`).join('')}</div></div>`;
}

function buildDemoInner({ label, note, frames, captions }) {
  return `<p class="pf-rank-demo-label">${label}</p><p class="pf-rank-demo-note">${note}</p>${stage(frames, captions)}`;
}

function parseDemoTimeToSeconds(str) {
  if (!str) return 0;
  const parts = String(str).split(':').map((p) => parseInt(p, 10) || 0);
  if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function readDemoTimerSeconds(hiddenId, fallbackSec) {
  const hidden = $(hiddenId);
  const sec = parseDemoTimeToSeconds(hidden?.value || '');
  return sec > 0 ? sec : fallbackSec;
}

function formatDemoDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  return `${sec}s`;
}

function formatDemoClock(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function rebuildDemoContent(id) {
  const shell = $(`pfSettingDemoShell_${id}`);
  const content = shell?.querySelector(`[data-pf-demo-content="${id}"]`);
  const config = DEMO_CONTENT[id];
  if (!content || !config || typeof config.build !== 'function') return;
  content.innerHTML = config.build();
}

const DEMO_CONTENT = {
  tabLife: {
    title: 'Max Tab Life preview',
    label: 'Tab life preview',
    note: 'Example uses a 5-tab limit (not a timer).',
    build() {
      const frames = [
        demoFrame('1 · Five tabs open. Doc has been open a long time.', tabs([
          tab('Doc', 'doc', 0, '23h'),
          tab('YT', 'yt', 32, '5m'),
          tab('Rd', 'rd', 64, '2m'),
          tab('YT', 'yt', 96, '0m'),
          tab('Mail', 'doc', 128, '1m')
        ].join(''), true), 'Doc tab age: 23h'),
        demoFrame('2 · Doc keeps aging in the background.', tabs([
          tab('Doc', 'doc', 0, '25h ↑'),
          tab('YT', 'yt', 32, '6m ↑', 'is-active'),
          tab('Rd', 'rd', 64, '2m'),
          tab('YT', 'yt', 96, '0m'),
          tab('Mail', 'doc', 128, '1m')
        ].join(''), true), 'Doc tab age: 25h - over 24h limit'),
        demoFrame('3 · Max Tab Life closes stale tabs individually.', tabs([
          tab('Doc', 'doc', 0, '25h', 'is-evict'),
          tab('YT', 'yt', 32, '6m', 'is-active'),
          tab('Rd', 'rd', 64, '2m'),
          tab('YT', 'yt', 96, '0m'),
          tab('Mail', 'doc', 128, '1m')
        ].join(''), true), 'Doc closed - other tabs stay', 'pf-rank-demo-callout--close'),
        demoFrame('4 · Four tabs remain. Ranking scores unchanged.', tabs([
          tab('YT', 'yt', 0, '6m', 'is-active'),
          tab('Rd', 'rd', 50, '2m'),
          tab('YT', 'yt', 100, '0m'),
          tab('Mail', 'doc', 150, '1m')
        ].join(''))),
        demoFrame('5 · Only tabs past your age limit are closed.', tabs([
          tab('YT', 'yt', 0, '7m ↑', 'is-active'),
          tab('Rd', 'rd', 50, '2m'),
          tab('YT', 'yt', 100, '0m'),
          tab('Mail', 'doc', 150, '1m')
        ].join('')), 'Does not wipe scores or reset session')
      ];
      const captions = [
        'Doc tab shows how long it stayed open',
        'Tab age keeps rising in the background',
        'Stale tab closes alone',
        'Other tabs unaffected',
        'Active tabs still gain time normally'
      ];
      return buildDemoInner({ label: this.label, note: this.note, frames, captions });
    }
  },
  studyBreak: {
    title: 'Study Break preview',
    label: 'Study Break preview',
    build() {
      const everySec = readDemoTimerSeconds('studyBreakEveryTime', 25 * 60);
      const earnSec = readDemoTimerSeconds('studyBreakEarnTime', 5 * 60);
      const midEvery = Math.max(1, Math.floor(everySec / 2));
      const breakMidRemaining = Math.max(1, Math.ceil(earnSec / 2));
      const rateLabel = `Every ${formatDemoDuration(everySec)} productive study → +${formatDemoDuration(earnSec)} break`;
      const note = `Uses your Study Break earn rate (${rateLabel}).`;

      const frames = [
        demoFrame('1 · Work/Study timer running - only productive tabs earn break credit.', tabs([
          tab('Doc', 'doc', 0, '↑', 'is-active'),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter('Work/Study timer · Doc is productive', 'study') + meter('Break available · 0', 'bank')),
        demoFrame('2 · Progress ticks while you stay on productive tabs.', tabs([
          tab('Doc', 'doc', 0, '↑', 'is-active'),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Progress · ${formatDemoDuration(midEvery)} / ${formatDemoDuration(everySec)}`, 'bank')),
        demoFrame(`3 · Deposit: +${formatDemoDuration(earnSec)} added to Break available.`, tabs([
          tab('Doc', 'doc', 0, '↑', 'is-active'),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Break available · ${formatDemoDuration(earnSec)}`, 'bank')),
        demoFrame('4 · Click Use - credit adds to your Break/Unproductive budget.', tabs([
          tab('Doc', 'doc', 0, ''),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Use → +${formatDemoDuration(earnSec)} to break budget`, 'bank')),
        demoFrame('5 · Break budget counts down on unproductive tabs.', tabs([
          tab('YT', 'yt', 0, '↑', 'is-active'),
          tab('Doc', 'doc', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Break budget · ${formatDemoClock(earnSec)} total`, 'break') + meter(`Break budget · ${formatDemoClock(breakMidRemaining)} remaining`, 'break'))
      ];
      const captions = [
        'Work/Study timer must be running',
        'Only productive tabs earn credit',
        rateLabel,
        'Use adds time to Break timer budget',
        'Unproductive tabs spend the budget'
      ];
      return buildDemoInner({ label: this.label, note, frames, captions });
    }
  },
  modeBEarnSpend: {
    title: 'Advanced Earn / Spend preview',
    label: 'Advanced Earn / Spend preview',
    build() {
      const focusSec = readDemoTimerSeconds('bankFocusTimeModeB', 30 * 60);
      const earnedSec = readDemoTimerSeconds('bankEarnedTimeModeB', 5 * 60);
      const midFocus = Math.max(1, Math.floor(focusSec / 2));
      const spendMidRemaining = Math.max(1, Math.ceil(earnedSec / 2));
      const rateLabel = `Every ${formatDemoDuration(focusSec)} on source → +${formatDemoDuration(earnedSec)} for targets`;
      const note = `Uses your Mode B rates (${rateLabel}).`;

      const frames = [
        demoFrame('1 · Time on a source site earns spend time.', tabs([
          tab('YT', 'yt', 0, '12m ↑', 'is-active'),
          tab('Rd', 'rd', 58, '0m')
        ].join('')) + meter(`Progress · 0 / ${formatDemoDuration(focusSec)} on youtube.com`, 'reward')),
        demoFrame('2 · Time on the source keeps rising.', tabs([
          tab('YT', 'yt', 0, '18m ↑', 'is-active'),
          tab('Rd', 'rd', 58, '0m')
        ].join('')) + meter(`Progress · ${formatDemoDuration(midFocus)} / ${formatDemoDuration(focusSec)}`, 'reward')),
        demoFrame(`3 · Deposit: +${formatDemoDuration(earnedSec)} spend time for targets.`, tabs([
          tab('YT', 'yt', 0, '25m', 'is-active'),
          tab('Rd', 'rd', 58, '0m')
        ].join('')) + meter(`Spend available · ${formatDemoDuration(earnedSec)}`, 'reward')),
        demoFrame('4 · Click Use - overlay blocks non-target sites.', tabs([
          tab('YT', 'yt', 0, '25m', 'is-evict'),
          tab('Rd', 'rd', 58, '5m ↑', 'is-active')
        ].join(''), 'Non-target tabs blocked during spend', 'pf-rank-demo-callout--close') + meter(`Spend mode · ${formatDemoClock(earnedSec)} on targets`, 'reward')),
        demoFrame('5 · Countdown runs only on allowed target sites.', tabs([
          tab('YT', 'yt', 0, '25m', 'is-evict'),
          tab('Rd', 'rd', 58, '7m ↑', 'is-active')
        ].join('')) + meter(`Spend mode · ${formatDemoClock(spendMidRemaining)} remaining`, 'reward'))
      ];
      const captions = [
        'Earn on configured source sites',
        'Time accrues on any source site',
        rateLabel,
        'Use starts spend with site overlay',
        'Only targets stay open'
      ];
      return buildDemoInner({ label: this.label, note, frames, captions });
    }
  },
  bankedTime: {
    title: 'Focused Time Banked preview',
    label: 'Focused Time Banked preview',
    build() {
      const studySec = readDemoTimerSeconds('studyTimeLimit', 60);
      const bankFocusSec = readDemoTimerSeconds('bankFocusTime', 30);
      const bankEarnedSec = readDemoTimerSeconds('bankEarnedTime', 10);
      const deposits = Math.max(1, Math.floor(studySec / bankFocusSec));
      const totalBankedSec = deposits * bankEarnedSec;
      const midElapsed = Math.max(1, Math.floor(bankFocusSec / 2));
      const midStudyRemaining = Math.max(1, studySec - midElapsed);
      const afterFirstDepositRemaining = Math.max(0, studySec - bankFocusSec);
      const breakMidRemaining = Math.max(1, Math.ceil(totalBankedSec / 2));
      const rateLabel = `Every ${formatDemoDuration(bankFocusSec)} Work/Study = ${formatDemoDuration(bankEarnedSec)} Break`;
      const note = `Uses your Work/Study timer (${formatDemoDuration(studySec)}) and earn rate (${rateLabel}).`;

      const frames = [
        demoFrame(`1 · Start the Work/Study timer (${formatDemoDuration(studySec)} session).`, tabs([
          tab('Doc', 'doc', 0, '↑', 'is-active'),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Work/Study timer · ${formatDemoClock(studySec)} remaining`, 'study') + meter(`Bank · 0 / ${formatDemoDuration(bankFocusSec)} toward +${formatDemoDuration(bankEarnedSec)}`, 'bank')),
        demoFrame('2 · Bank progress ticks up while Work/Study timer runs.', tabs([
          tab('Doc', 'doc', 0, '↑', 'is-active'),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Work/Study timer · ${formatDemoClock(midStudyRemaining)} remaining`, 'study') + meter(`Bank · ${formatDemoDuration(midElapsed)} / ${formatDemoDuration(bankFocusSec)}`, 'bank')),
        demoFrame(`3 · First deposit: +${formatDemoDuration(bankEarnedSec)} banked.`, tabs([
          tab('Doc', 'doc', 0, '↑', 'is-active'),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(afterFirstDepositRemaining > 0
          ? `Work/Study timer · ${formatDemoClock(afterFirstDepositRemaining)} remaining`
          : 'Work/Study timer · session ending', 'study') + meter(`Time banked · ${formatDemoDuration(bankEarnedSec)}`, 'bank')),
        demoFrame('4 · Work/Study timer ends. Click Use to load the Break timer.', tabs([
          tab('Doc', 'doc', 0, ''),
          tab('YT', 'yt', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter('Work/Study session ended', 'study') + meter(`Time banked · ${formatDemoDuration(totalBankedSec)} · Use → Break timer`, 'bank')),
        demoFrame('5 · Break timer counts down your earned break time.', tabs([
          tab('YT', 'yt', 0, '↑', 'is-active'),
          tab('Doc', 'doc', 58, ''),
          tab('Rd', 'rd', 116, '')
        ].join('')) + meter(`Break timer · ${formatDemoClock(totalBankedSec)} loaded`, 'break') + meter(`Break timer · ${formatDemoClock(breakMidRemaining)} remaining`, 'break'))
      ];
      const captions = [
        'Work/Study timer must be running',
        'Bank fills only during Work/Study timer',
        rateLabel,
        'Use loads banked time onto Break timer',
        'Break timer counts down earned time'
      ];
      return buildDemoInner({ label: this.label, note, frames, captions });
    }
  },
  timeEarned: {
    title: 'Advanced Time Banked preview',
    label: 'Advanced Time Banked preview',
    note: 'Example uses a 5-tab limit (not a timer).',
    build() {
      const frames = [
        demoFrame('1 · Work on lecture.com to earn fun-site time.', tabs([
          tab('Lec', 'doc', 0, '45m ↑', 'is-active'),
          tab('YT', 'yt', 58, '0m'),
          tab('Rd', 'rd', 116, '0m')
        ].join('')) + meter('Earn 10m on lecture.com → youtube.com', 'reward')),
        demoFrame('2 · Productive time keeps rising on lecture.com.', tabs([
          tab('Lec', 'doc', 0, '52m ↑', 'is-active'),
          tab('YT', 'yt', 58, '0m'),
          tab('Rd', 'rd', 116, '0m')
        ].join('')) + meter('52m of 1h toward reward', 'reward')),
        demoFrame('3 · You hit 1h on lecture.com.', tabs([
          tab('Lec', 'doc', 0, '1h', 'is-active'),
          tab('YT', 'yt', 58, '0m'),
          tab('Rd', 'rd', 116, '0m')
        ].join('')) + meter('Reward earned: 10m for youtube.com', 'reward')),
        demoFrame('4 · Open YouTube - reward timer starts.', tabs([
          tab('Lec', 'doc', 0, '1h'),
          tab('YT', 'yt', 58, '10m ↑', 'is-active'),
          tab('Rd', 'rd', 116, '0m', 'is-evict')
        ].join('')), 'Reddit blocked while reward active', 'pf-rank-demo-callout--close'),
        demoFrame('5 · Allowed fun-site time keeps counting on YT.', tabs([
          tab('Lec', 'doc', 0, '1h'),
          tab('YT', 'yt', 58, '12m ↑', 'is-active'),
          tab('Rd', 'rd', 116, '0m')
        ].join('')) + meter('YT reward timer · 12m earned', 'reward'))
      ];
      const captions = [
        'Productive site earns reward',
        'Focus time keeps rising',
        'Hit your focus goal',
        'Other fun sites blocked',
        'Reward time shows on allowed site'
      ];
      return buildDemoInner({ label: this.label, note: this.note, frames, captions });
    }
  },
  pause: {
    title: 'Keep a tab in place preview',
    label: 'Tab shield preview',
    note: 'Example uses a 5-tab limit (not a timer).',
    build() {
      const frames = [
        demoFrame('1 · Open the extension popup - shield icon is top right.', pauseDemoBody([
          tab('Doc', 'doc', 0, '5m'),
          tab('YT', 'yt', 32, '3m ↑', 'is-active'),
          tab('Rd', 'rd', 64, '2m'),
          tab('Mail', 'doc', 96, '1m'),
          tab('YT', 'yt', 128, '0m')
        ].join(''), 'idle'), 'YT on the right is lowest (0m)'),
        demoFrame('2 · Click the shield to keep the lowest tab in place.', pauseDemoBody([
          tab('Doc', 'doc', 0, '5m'),
          tab('YT', 'yt', 32, '6m ↑', 'is-active'),
          tab('Rd', 'rd', 64, '2m'),
          tab('Mail', 'doc', 96, '1m'),
          tab('YT', 'yt', 128, '0m', 'is-shielded')
        ].join(''), 'armed'), 'Lowest tab shielded for 5m', 'pf-rank-demo-callout--new'),
        demoFrame('3 · Tabs reorder by usage - shield keeps this slot fixed.', pauseDemoBody([
          tab('YT', 'yt', 0, '8m ↑', 'is-active'),
          tab('Doc', 'doc', 32, '5m'),
          tab('Mail', 'doc', 64, '1m'),
          tab('Rd', 'rd', 96, '2m'),
          tab('YT', 'yt', 128, '0m', 'is-shielded')
        ].join(''), 'active'), 'Would move in ranking - shield holds it here', 'pf-rank-demo-callout--move'),
        demoFrame('4 · You open a 6th tab; limit closing skips the shield.', pauseDemoBody([
          tab('YT', 'yt', 0, '8m ↑', 'is-active'),
          tab('Doc', 'doc', 32, '5m'),
          tab('Mail', 'doc', 64, '1m', 'is-evict'),
          tab('Rd', 'rd', 96, '2m'),
          tab('YT', 'yt', 128, '0m', 'is-shielded'),
          tab('Shop', 'rd', 160, '0m', 'is-new')
        ].join(''), 'active'), 'Mail (2nd lowest) closed - shielded YT kept', 'pf-rank-demo-callout--close'),
        demoFrame('5 · Shield expires; the tab returns to its normal rank.', pauseDemoBody([
          tab('YT', 'yt', 0, '8m ↑', 'is-active'),
          tab('Doc', 'doc', 32, '5m'),
          tab('Rd', 'rd', 64, '2m'),
          tab('Shop', 'rd', 96, '0m'),
          tab('YT', 'yt', 128, '0m')
        ].join('')), 'Shield off - tabs rank normally again')
      ];
      const captions = [
        'Shield lives in the extension popup',
        'Click the shield icon (top right)',
        'Shield pins its slot during reorder',
        'Limit skips shield - closes 2nd lowest',
        'Timer ends - back to normal ranking'
      ];
      return buildDemoInner({ label: this.label, note: this.note, frames, captions });
    }
  },
  sessionReset: {
    title: 'Reset Session preview',
    label: 'Session reset preview',
    note: 'Example uses a 5-tab limit (not a timer).',
    build() {
      const frames = [
        demoFrame('1 · Window open with tabs and ranking times.', tabs([
          tab('Doc', 'doc', 0, '5m'),
          tab('YT', 'yt', 32, '3m ↑', 'is-active'),
          tab('Rd', 'rd', 64, '2m'),
          tab('Mail', 'doc', 96, '1m'),
          tab('YT', 'yt', 128, '0m')
        ].join(''), true)),
        demoFrame('2 · You keep browsing - active tab time rises.', tabs([
          tab('Doc', 'doc', 0, '5m'),
          tab('YT', 'yt', 32, '8m ↑', 'is-active'),
          tab('Rd', 'rd', 64, '2m'),
          tab('Mail', 'doc', 96, '1m'),
          tab('YT', 'yt', 128, '0m')
        ].join(''), true), 'Window closing - session captured', 'pf-rank-demo-callout--close'),
        demoFrame('3 · Session data clears for a fresh start.', tabs([
          tab('Doc', 'doc', 0, '0m'),
          tab('YT', 'yt', 32, '0m'),
          tab('Rd', 'rd', 64, '0m'),
          tab('Mail', 'doc', 96, '0m'),
          tab('YT', 'yt', 128, '0m')
        ].join(''), true), 'Scores wiped on reopen'),
        demoFrame('4 · Next time you open this window…', tabs([
          tab('Doc', 'doc', 0, '0m'),
          tab('YT', 'yt', 58, '0m'),
          tab('Rd', 'rd', 116, '0m')
        ].join('')), 'Startup slots loading…', 'pf-rank-demo-callout--new'),
        demoFrame('5 · Your chosen sites open (up to tab limit).', tabs([
          tab('Doc', 'doc', 0, '0m'),
          tab('YT', 'yt', 32, '0m'),
          tab('Rd', 'rd', 64, '0m'),
          tab('Mail', 'doc', 96, '0m'),
          tab('-', 'rd', 128, '-')
        ].join(''), true), '5 startup slots from your list')
      ];
      const captions = [
        'Active tab time keeps rising',
        'Close triggers reset',
        'Ranking clears on reopen',
        'Window opens again',
        'Startup tabs restore'
      ];
      return buildDemoInner({ label: this.label, note: this.note, frames, captions });
    }
  }
};

function buildDemoShell(id, config) {
  // Pause button REMOVED per user spec 2026-07 — the enlarged preview has
  // manual prev/next arrows + frame dots instead.
  return `<aside id="pfSettingDemoShell_${id}" class="pf-setting-mode-demo pf-ranking-mode-demo" hidden aria-label="${config.title}">
    <div class="pf-rank-demo-toolbar">
      <button type="button" class="pf-rank-demo-expand-btn" data-pf-demo-expand="${id}" aria-haspopup="dialog" aria-label="Open preview" title="Open preview">
        <span class="pf-rank-demo-expand-icon" aria-hidden="true">⤢</span>
      </button>
      <button type="button" class="pf-rank-demo-close-btn" data-pf-demo-dismiss="${id}" aria-label="Hide preview" title="Hide preview">×</button>
    </div>
    <div class="pf-rank-demo is-visible" data-pf-demo-content="${id}">${config.build()}</div>
  </aside>`;
}

function mountDemoShells() {
  DEMO_IDS.forEach((id) => {
    const mount = document.querySelector(`[data-pf-demo-mount="${id}"]`);
    const config = DEMO_CONTENT[id];
    if (!mount || !config) return;
    mount.innerHTML = buildDemoShell(id, config);
  });
}

async function isTutorialCompleted() {
  const d = await chrome.storage.local.get(['tutorialCompleted', 'tutorialComplete']);
  return d.tutorialCompleted === true || d.tutorialComplete === true;
}

function isAdvancedSettingsOpen() {
  const section = $('advancedLimitsSection');
  if (!section) return false;
  return section.classList.contains('is-expanded') || section.style.display === 'block';
}

function isSectionOpen(sectionId) {
  const section = $(sectionId);
  if (!section) return false;
  if (section.hidden) return false;
  const display = section.style.display;
  if (display) return display !== 'none';
  return window.getComputedStyle(section).display !== 'none';
}

function isTabLifeEnabled() {
  const val = $('tabLifeLimit')?.value || '';
  return val !== '';
}

function isAdvancedEarnSpendPanelOpen() {
  const panel = $('advancedEarnSpendPanel');
  const chevron = $('advancedEarnSpendChevron');
  if (!panel) return false;
  if (chevron?.getAttribute('aria-expanded') === 'true') return true;
  return !panel.hidden && panel.style.display !== 'none';
}

function shouldShowDemo(id) {
  switch (id) {
    // studyBreak (Work Timer) lives in its OWN card now (it was moved out of
    // the Advanced Settings collapsible — see stats.html #studyBreakBlock),
    // so it must NOT be gated on Advanced Settings being expanded.
    // User spec 2026-07 v34: also drop the `studyBreakEnabled` gate — the
    // preview should appear as soon as the tutorial ends (or the card is
    // visible), matching the Adv Earn/Spend behaviour. Previously the
    // preview never showed post-tutorial because the user hadn't turned
    // Work Timer on yet, which defeats the purpose of showing them what
    // it does.
    case 'studyBreak':
      return true;
    default:
      break;
  }
  // Every other demo still lives inside the Advanced Settings collapsible,
  // so it only shows when that section is expanded.
  if (!isAdvancedSettingsOpen()) return false;
  switch (id) {
    case 'tabLife':
      return isTabLifeEnabled();
    case 'modeBEarnSpend':
      // User spec 2026-07 v32: the Adv Earn/Spend preview should appear as
      // soon as Advanced Options is opened — same behaviour Reset Previews
      // produces. Was gated on the feature checkbox being checked AND the
      // sub-panel being expanded, so users never saw the preview until they
      // already turned the feature on. That defeats the whole point of a
      // preview. Now the outer Advanced Settings gate (`isAdvancedSettingsOpen`
      // above) is the only requirement.
      return true;
    case 'bankedTime':
      return $('enableBankedTime')?.checked === true && isSectionOpen('bankedTimeSection');
    case 'timeEarned':
      return $('enableBankedTime')?.checked === true && isSectionOpen('timeEarnedPanel');
    case 'pause':
      return $('enablePause')?.checked === true;
    case 'sessionReset':
      return $('resetSessionCheck')?.checked === true;
    default:
      return false;
  }
}

function isDemoDismissed(id) {
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}${id}`) === '1';
  } catch (_) {
    return false;
  }
}

function dismissDemo(id) {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}${id}`, '1');
  } catch (_) {}
  // Per user report 2026-07: dismissed previews were coming back.
  // Root cause was the dev-only "force-show" flag lingering from a
  // previous reset. ANY explicit dismiss should immediately drop that
  // force flag so the preview stays hidden across refreshes — the flag
  // only exists to help devs preview settings during tutorial work.
  settingDemoDevForceShow = false;
}

function clearAllDemoDismissals() {
  try {
    DEMO_IDS.forEach((id) => localStorage.removeItem(`${DISMISS_PREFIX}${id}`));
  } catch (_) {}
}

function getDemoPhaseMs(root) {
  if (!root) return 0;
  const frame = root.querySelector('.pf-rank-demo-frame');
  if (!frame || typeof frame.getAnimations !== 'function') return 0;
  for (const anim of frame.getAnimations()) {
    const name = String(anim.animationName || '');
    if (name.includes('pfRankDemoFrame') && anim.currentTime != null) {
      return Number(anim.currentTime) % SETTING_DEMO_CYCLE_MS;
    }
  }
  return 0;
}

function applyDemoPhase(root, phaseMs) {
  if (!root) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const normalized = ((phaseMs % SETTING_DEMO_CYCLE_MS) + SETTING_DEMO_CYCLE_MS) % SETTING_DEMO_CYCLE_MS;
  const delayMs = -normalized;
  root.querySelectorAll('.pf-rank-demo-frame, .pf-rank-demo-caption').forEach((node) => {
    node.style.animationDelay = `${delayMs}ms`;
  });
}

function restartDemoAnimation(root) {
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
  applyDemoPhase(root, 0);
  syncOpenSettingDemoModalPhase();
}

function syncOpenSettingDemoModalPhase() {
  const modal = $('pfSettingDemoModal');
  if (!modal?.classList.contains('is-open') || !openSettingDemoId) return;
  const source = $(`pfSettingDemoShell_${openSettingDemoId}`)?.querySelector('.pf-rank-demo');
  const clone = $('pfSettingDemoModalBody')?.querySelector('.pf-rank-demo');
  if (!source || !clone) return;
  applyDemoPhase(clone, getDemoPhaseMs(source));
}

function syncSettingDemoPauseButtons() {
  const label = settingDemoPaused ? 'Resume animation' : 'Pause animation';
  const icon = settingDemoPaused ? '▶' : '⏸';
  document.querySelectorAll('[data-pf-demo-pause], #pfSettingDemoModalPause').forEach((btn) => {
    btn.setAttribute('aria-pressed', settingDemoPaused ? 'true' : 'false');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const iconEl = btn.querySelector('.pf-rank-demo-pause-icon');
    if (iconEl) iconEl.textContent = icon;
  });
}

function setSettingDemoPaused(paused) {
  settingDemoPaused = paused;
  document.querySelectorAll('.pf-setting-mode-demo .pf-rank-demo, #pfSettingDemoModalBody .pf-rank-demo').forEach((el) => {
    el.classList.toggle('is-paused', paused);
  });
  syncSettingDemoPauseButtons();
}

function toggleSettingDemoPause() {
  setSettingDemoPaused(!settingDemoPaused);
}

// Manual frame navigation for the ENLARGED preview (user spec 2026-07):
// no pause button — instead ‹ › arrows plus one dot per frame (the dark
// dot marks where you are). The small inline preview keeps auto-cycling.
let settingDemoModalFrame = 0;
let settingDemoModalFrameCount = 0;

function setSettingDemoModalFrame(idx) {
  const body = $('pfSettingDemoModalBody');
  const clone = body?.querySelector('.pf-rank-demo');
  if (!clone || settingDemoModalFrameCount <= 0) return;
  const count = settingDemoModalFrameCount;
  settingDemoModalFrame = ((idx % count) + count) % count;
  const frames = clone.querySelectorAll('.pf-rank-demo-frame');
  const captions = clone.querySelectorAll('.pf-rank-demo-caption');
  frames.forEach((f, i) => f.classList.toggle('is-current', i === settingDemoModalFrame));
  captions.forEach((c, i) => c.classList.toggle('is-current', i === settingDemoModalFrame));
  const dotsWrap = $('pfSettingDemoModalDots');
  if (dotsWrap) {
    [...dotsWrap.children].forEach((dot, i) => {
      dot.classList.toggle('is-active', i === settingDemoModalFrame);
      dot.setAttribute('aria-current', i === settingDemoModalFrame ? 'true' : 'false');
    });
  }
}

function buildSettingDemoModalDots(count) {
  const dotsWrap = $('pfSettingDemoModalDots');
  if (!dotsWrap) return;
  dotsWrap.replaceChildren();
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'pf-rank-demo-dot';
    dot.setAttribute('aria-label', `Go to step ${i + 1}`);
    dot.addEventListener('click', () => setSettingDemoModalFrame(i));
    dotsWrap.appendChild(dot);
  }
}

function openSettingDemoModal(id) {
  const shell = $(`pfSettingDemoShell_${id}`);
  const modal = $('pfSettingDemoModal');
  const body = $('pfSettingDemoModalBody');
  const title = $('pfSettingDemoModalTitle');
  const source = shell?.querySelector('.pf-rank-demo');
  const config = DEMO_CONTENT[id];
  if (!modal || !body || !source || !config) return;
  openSettingDemoId = id;
  if (title) title.textContent = config.title;
  body.innerHTML = '';
  const clone = source.cloneNode(true);
  clone.removeAttribute('id');
  clone.hidden = false;
  clone.classList.add('is-visible', 'is-manual');
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  body.appendChild(clone);
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('pf-rank-demo-modal-open');
  // Manual mode: start on the frame the small preview was showing, so the
  // enlargement feels continuous, then hand control to the arrows/dots.
  settingDemoModalFrameCount = clone.querySelectorAll('.pf-rank-demo-frame').length;
  buildSettingDemoModalDots(settingDemoModalFrameCount);
  const phase = getDemoPhaseMs(source);
  const startIdx = settingDemoModalFrameCount > 0
    ? Math.min(settingDemoModalFrameCount - 1,
        Math.floor((phase / SETTING_DEMO_CYCLE_MS) * settingDemoModalFrameCount))
    : 0;
  setSettingDemoModalFrame(startIdx);
}

function closeSettingDemoModal() {
  const modal = $('pfSettingDemoModal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('pf-rank-demo-modal-open');
  const body = $('pfSettingDemoModalBody');
  if (body) body.innerHTML = '';
  openSettingDemoId = null;
}

export async function refreshSettingDemoVisibility(id = null, options = {}) {
  const forceShow = options.forceShow === true || settingDemoDevForceShow;
  const ids = id ? [id] : DEMO_IDS;
  const tutorialDone = forceShow || await isTutorialCompleted();
  for (const demoId of ids) {
    const shell = $(`pfSettingDemoShell_${demoId}`);
    if (!shell) continue;
    // pause and sessionReset previews ALWAYS require their toggle to be ON,
    // even in dev force-show mode. Per user report 2026-07: previews were
    // visible even when the toggles were off.
    if (demoId === 'pause' || demoId === 'sessionReset') {
      if (!shouldShowDemo(demoId)) {
        shell.hidden = true;
        shell.classList.remove('is-dismissed');
        shell.classList.remove('is-force-visible');
        if (openSettingDemoId === demoId) closeSettingDemoModal();
        continue;
      }
    }
    if (!forceShow && (isDemoDismissed(demoId) || !shouldShowDemo(demoId))) {
      shell.hidden = true;
      shell.classList.remove('is-dismissed');
      shell.classList.remove('is-force-visible');
      if (openSettingDemoId === demoId) closeSettingDemoModal();
      continue;
    }
    if (!tutorialDone) {
      shell.hidden = true;
      shell.classList.remove('is-dismissed');
      shell.classList.remove('is-force-visible');
      if (openSettingDemoId === demoId) closeSettingDemoModal();
      continue;
    }
    shell.hidden = false;
    shell.classList.remove('is-dismissed');
    shell.removeAttribute('hidden');
    shell.classList.toggle('is-force-visible', forceShow);
    if (demoId === 'bankedTime' || demoId === 'studyBreak' || demoId === 'modeBEarnSpend') {
      rebuildDemoContent(demoId);
    }
    const root = shell.querySelector('.pf-rank-demo');
    if (root) requestAnimationFrame(() => restartDemoAnimation(root));
  }
  // Post-loop DOM truth: mirror the studyBreak preview's ACTUAL visibility
  // to storage so the worker can gate the Work Timer reminder on it (user
  // spec 2026-07 v43: "while the preview is there and not x-ed make it so
  // that the reminder ends before the preview"). Reading the shell's real
  // hidden state here catches every hide path (dismiss, tutorial-incomplete,
  // toggle-off, force-show cleared) without patching each branch. Only
  // write when the state genuinely differs so we don't thrash storage.
  try {
    const sbShell = document.getElementById('pfSettingDemoShell_studyBreak');
    const visible = !!(sbShell && !sbShell.hidden && sbShell.isConnected);
    chrome.storage.local.get('studyBreakPreviewVisible').then((cur) => {
      if (!!cur.studyBreakPreviewVisible !== visible) {
        chrome.storage.local.set({ studyBreakPreviewVisible: visible });
      }
    }).catch(() => {});
  } catch (_) { /* best-effort */ }
}

let settingDemoDelegatedClickBound = false;
function bindSettingDemoControls() {
  // Delegated click handler (2026-07): the previous per-node bindings could
  // miss buttons that were re-mounted after refreshSettingDemoVisibility,
  // leaving the X in a stale state and unresponsive. A single delegated
  // listener on `document` catches every current AND future button — no
  // dataset.bound bookkeeping required.
  if (!settingDemoDelegatedClickBound) {
    settingDemoDelegatedClickBound = true;
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const expandBtn = target.closest('[data-pf-demo-expand]');
      if (expandBtn) {
        openSettingDemoModal(expandBtn.getAttribute('data-pf-demo-expand'));
        return;
      }
      const dismissBtn = target.closest('[data-pf-demo-dismiss]');
      if (dismissBtn) {
        const demoId = dismissBtn.getAttribute('data-pf-demo-dismiss');
        closeSettingDemoModal();
        dismissDemo(demoId);
        void refreshSettingDemoVisibility(demoId);
      }
    });
  }

  const modal = $('pfSettingDemoModal');
  const modalClose = $('pfSettingDemoModalClose');
  const modalPrev = $('pfSettingDemoModalPrev');
  const modalNext = $('pfSettingDemoModalNext');
  const scrim = modal?.querySelector('.pf-rank-demo-modal-scrim');
  if (modalPrev && modalPrev.dataset.bound !== '1') {
    modalPrev.dataset.bound = '1';
    modalPrev.addEventListener('click', () => setSettingDemoModalFrame(settingDemoModalFrame - 1));
  }
  if (modalNext && modalNext.dataset.bound !== '1') {
    modalNext.dataset.bound = '1';
    modalNext.addEventListener('click', () => setSettingDemoModalFrame(settingDemoModalFrame + 1));
  }
  if (modalClose && modalClose.dataset.bound !== '1') {
    modalClose.dataset.bound = '1';
    modalClose.addEventListener('click', () => closeSettingDemoModal());
  }
  if (scrim && scrim.dataset.bound !== '1') {
    scrim.dataset.bound = '1';
    scrim.addEventListener('click', () => closeSettingDemoModal());
  }
  if (modal && modal.dataset.bound !== '1') {
    modal.dataset.bound = '1';
    document.addEventListener('keydown', (event) => {
      if (!modal.classList.contains('is-open')) return;
      if (event.key === 'Escape') closeSettingDemoModal();
      else if (event.key === 'ArrowLeft') setSettingDemoModalFrame(settingDemoModalFrame - 1);
      else if (event.key === 'ArrowRight') setSettingDemoModalFrame(settingDemoModalFrame + 1);
    });
  }
}

export async function initSettingDemos() {
  mountDemoShells();
  bindSettingDemoControls();
  await refreshSettingDemoVisibility();
}

export function resetAllSettingDemosForDev() {
  settingDemoDevForceShow = true;
  clearAllDemoDismissals();
  closeSettingDemoModal();
  setSettingDemoPaused(false);
  void refreshSettingDemoVisibility(null, { forceShow: true });
}
