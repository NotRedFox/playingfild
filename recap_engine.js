/**
 * recap_engine.js — pure computation for the Daily / Weekly / Monthly recaps.
 *
 * Inputs are "day summaries": compact per-day rollups written by the worker
 * (pfRecapDailySummaries). Raw site logs only live ~7 days, so the summaries
 * ARE the long-term memory that makes weekly/monthly possible.
 *
 * Day summary shape (all fields optional-safe):
 * {
 *   ts,            // epoch ms ~noon of that local day (ordering without locale parsing)
 *   p, u, n,       // productive / unproductive / neutral seconds
 *   eng,           // real-productivity engagement points that day
 *   topHosts,      // [[hostname, totalSec, 'Productive'|'Unproductive'|'Neutral'], ...] max 6
 *   hourlyP,       // 24-array of productive seconds per local hour
 *   closesByHost,  // { hostname: closeCount }
 *   reorders, shields, timers, breaks   // feature counters
 * }
 *
 * No chrome.* usage — imported by both the worker and the dashboard, and unit
 * tested directly under node.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ── formatting ──────────────────────────────────────────────────────────────

export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Big-number split for the poster hero: { value: '3.4', unit: 'hours' } */
export function heroNumber(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s >= 3600) {
    const h = s / 3600;
    return { value: h >= 10 ? String(Math.round(h)) : (Math.round(h * 10) / 10).toFixed(1).replace(/\.0$/, ''), unit: 'hours' };
  }
  if (s >= 60) return { value: String(Math.round(s / 60)), unit: 'minutes' };
  return { value: String(Math.round(s)), unit: 'seconds' };
}

export function fmtHour(h) {
  const hh = ((Math.round(h) % 24) + 24) % 24;
  if (hh === 0) return '12am';
  if (hh === 12) return '12pm';
  return hh < 12 ? `${hh}am` : `${hh - 12}pm`;
}

export function prettyHost(host) {
  return String(host || '').replace(/^www\./, '');
}

/**
 * Hosts that make a terrible reveal on a Wrapped card (user spec 2026-07).
 *
 * The cards pick a top site purely by total seconds, and search engines win
 * that on volume every time. "google.com was your top tab" is technically
 * true and completely uninteresting: it is a corridor, not a destination.
 * Nobody wants their year in review to be a hallway. The point of the card
 * is to surprise you with where the time actually went.
 *
 * MATCHING IS EXACT, on purpose. docs.google.com, mail.google.com and
 * drive.google.com are among the most interesting things a card can name,
 * and a suffix match would wipe all of them out. Only the bare search
 * front door is excluded.
 */
const PF_CORRIDOR_HOSTS = new Set([
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'search.brave.com',
  'search.yahoo.com',
  'ecosia.org',
  'startpage.com',
  'yandex.com',
  'baidu.com',
  'newtab',
  'localhost'
]);

export function isCorridorHost(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  return PF_CORRIDOR_HOSTS.has(h);
}

/**
 * Drop corridor hosts, but never hand back an empty list. Someone whose
 * whole day really was one search engine should still get a card rather
 * than a blank space.
 */
function withoutCorridorHosts(list, getHost) {
  const kept = list.filter((item) => !isCorridorHost(getHost(item)));
  return kept.length > 0 ? kept : list;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ── deterministic rotation (same day → same picks; new day → fresh feel) ────

function hashString(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rand = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── shared aggregation helpers ──────────────────────────────────────────────

function sumField(summaries, field) {
  return summaries.reduce((acc, s) => acc + (Number(s?.[field]) || 0), 0);
}

function mergeCloses(summaries) {
  const merged = {};
  for (const s of summaries) {
    for (const [host, n] of Object.entries(s?.closesByHost || {})) {
      merged[host] = (merged[host] || 0) + (Number(n) || 0);
    }
  }
  return merged;
}

export function topClosedHost(summaries) {
  const merged = mergeCloses(summaries);
  let best = null;
  for (const [host, n] of Object.entries(merged)) {
    if (n > 0 && (!best || n > best.count)) best = { host, count: n };
  }
  return best;
}

function mergeTopHosts(summaries, limit = 5) {
  const totals = new Map(); // host -> {sec, byClass}
  for (const s of summaries) {
    for (const [host, sec, cls] of (s?.topHosts || [])) {
      const cur = totals.get(host) || { sec: 0, cls: {} };
      cur.sec += Number(sec) || 0;
      cur.cls[cls] = (cur.cls[cls] || 0) + (Number(sec) || 0);
      totals.set(host, cur);
    }
  }
  const ranked = [...totals.entries()]
    .map(([host, v]) => ({
      host,
      sec: v.sec,
      cls: Object.entries(v.cls).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Neutral'
    }))
    .sort((a, b) => b.sec - a.sec);
  // Corridors are stripped BEFORE the slice, so removing google.com promotes
  // a real site into the list rather than just leaving a shorter one.
  return withoutCorridorHosts(ranked, (r) => r.host).slice(0, limit);
}

function mergeHourlyP(summaries) {
  const hours = new Array(24).fill(0);
  for (const s of summaries) {
    const arr = Array.isArray(s?.hourlyP) ? s.hourlyP : [];
    for (let h = 0; h < 24; h++) hours[h] += Number(arr[h]) || 0;
  }
  return hours;
}

/** Longest contiguous run of hours with productive time (daily "focus block"). */
export function bestFocusBlock(hourlyP) {
  const arr = Array.isArray(hourlyP) ? hourlyP : [];
  let best = null;
  let runStart = -1;
  let runSec = 0;
  for (let h = 0; h <= 24; h++) {
    const v = h < 24 ? (Number(arr[h]) || 0) : 0;
    if (v >= 5 * 60) { // an hour "counts" with at least 5 focused minutes
      if (runStart === -1) { runStart = h; runSec = 0; }
      runSec += v;
    } else if (runStart !== -1) {
      if (!best || runSec > best.sec) best = { startHour: runStart, endHour: h, sec: runSec };
      runStart = -1;
    }
  }
  return best;
}

/** Best rolling 4-hour window across a period ("4pm–8pm was your golden window"). */
export function bestFocusWindow(hourlyP, windowHours = 4) {
  const arr = mergeGuard(hourlyP);
  let best = null;
  for (let start = 0; start <= 24 - windowHours; start++) {
    let sec = 0;
    for (let h = start; h < start + windowHours; h++) sec += arr[h];
    if (sec > 0 && (!best || sec > best.sec)) {
      best = { startHour: start, endHour: start + windowHours, sec };
    }
  }
  return best;
}

function mergeGuard(hourlyP) {
  const out = new Array(24).fill(0);
  const arr = Array.isArray(hourlyP) ? hourlyP : [];
  for (let h = 0; h < 24; h++) out[h] = Number(arr[h]) || 0;
  return out;
}

// ── period selection ────────────────────────────────────────────────────────

function summariesSorted(summaryMap) {
  return Object.entries(summaryMap || {})
    .map(([dayKey, s]) => ({ dayKey, ...s }))
    .filter((s) => Number(s.ts) > 0)
    .sort((a, b) => a.ts - b.ts);
}

function sameLocalDay(tsA, tsB) {
  const a = new Date(tsA); const b = new Date(tsB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function summaryForYesterday(summaryMap, now = Date.now()) {
  const yts = now - DAY_MS;
  return summariesSorted(summaryMap).find((s) => sameLocalDay(s.ts, yts)) || null;
}

function summaryForDaysAgo(summaryMap, daysAgo, now = Date.now()) {
  const target = now - daysAgo * DAY_MS;
  return summariesSorted(summaryMap).find((s) => sameLocalDay(s.ts, target)) || null;
}

/** Monday 00:00 of the week containing ts (local). */
function mondayOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

/** Last COMPLETED Mon–Sun week strictly before today. */
export function lastCompletedWeekRange(now = Date.now()) {
  const thisMonday = mondayOf(now);
  const start = thisMonday - 7 * DAY_MS;
  const end = thisMonday; // exclusive
  return { start, end };
}

/** Last COMPLETED calendar month strictly before the current one. */
export function lastCompletedMonthRange(now = Date.now()) {
  const d = new Date(now);
  const firstOfThis = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const firstOfLast = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  return { start: firstOfLast, end: firstOfThis };
}

function summariesInRange(summaryMap, start, end) {
  return summariesSorted(summaryMap).filter((s) => s.ts >= start && s.ts < end);
}

// ── insight generation (the personalization core) ───────────────────────────

/**
 * Candidate insights for a single day. Each: { id, score, text, emoji }.
 * Only candidates whose underlying data EXISTS are produced — that's what
 * makes the daily feel personal (reorder stats only for reorder users, etc).
 */
export function dailyInsightCandidates(day, summaryMap, now = Date.now()) {
  const out = [];
  if (!day) return out;

  // Skip past search engines to the first site worth naming. See
  // isCorridorHost: "google.com was your top tab" is a dud reveal.
  const topHost = withoutCorridorHosts(day.topHosts || [], (h) => h[0])[0];
  if (topHost && topHost[1] >= 10 * 60) {
    out.push({
      id: 'topTab',
      score: 60 + Math.min(30, topHost[1] / 600),
      text: `${prettyHost(topHost[0])} was your top tab at ${fmtDur(topHost[1])}`
    });
  }

  const block = bestFocusBlock(day.hourlyP);
  if (block && block.sec >= 20 * 60) {
    out.push({
      id: 'focusBlock',
      score: 70 + Math.min(25, block.sec / 3600 * 10),
      text: `Your best focus block ran ${fmtHour(block.startHour)}–${fmtHour(block.endHour)} (${fmtDur(block.sec)})`
    });
  }

  // vs same weekday last week ("up 22% from last Monday")
  const lastSame = summaryForDaysAgo(summaryMap, 8, now); // yesterday-7
  if (lastSame && (Number(lastSame.p) || 0) >= 15 * 60 && (Number(day.p) || 0) > 0) {
    const delta = Math.round(((day.p - lastSame.p) / lastSame.p) * 100);
    if (Math.abs(delta) >= 10 && Math.abs(delta) <= 500) {
      const dayName = WEEKDAY[new Date(day.ts).getDay()];
      out.push({
        id: 'vsLastWeek',
        score: 65 + Math.min(20, Math.abs(delta) / 5),
        text: delta > 0
          ? `You're up ${delta}% on focused time vs last ${dayName}`
          : `Down ${Math.abs(delta)}% vs last ${dayName}. Today's a fresh start`
      });
    }
  }

  const closes = day.closesByHost || {};
  const closeEntries = Object.entries(closes).sort((a, b) => b[1] - a[1]);
  if (closeEntries.length && closeEntries[0][1] >= 2) {
    out.push({
      id: 'blockedHost',
      score: 68 + Math.min(22, closeEntries[0][1] * 2),
      text: `${prettyHost(closeEntries[0][0])} got shut down ${closeEntries[0][1]} times`
    });
  }

  if ((Number(day.reorders) || 0) >= 10) {
    out.push({
      id: 'reorders',
      score: 55 + Math.min(20, day.reorders / 5),
      text: `Your tab bar re-ranked itself ${day.reorders} times`
    });
  }

  if ((Number(day.shields) || 0) >= 1) {
    out.push({
      id: 'shields',
      score: 58,
      text: `You shielded ${day.shields} tab${day.shields === 1 ? '' : 's'} from the closer`
    });
  }

  if ((Number(day.timers) || 0) >= 1) {
    out.push({
      id: 'timers',
      score: 56,
      text: `${day.timers} focus timer${day.timers === 1 ? '' : 's'} run`
    });
  }

  if ((Number(day.eng) || 0) >= 5) {
    out.push({
      id: 'engagement',
      score: 50,
      text: `${Math.round(day.eng)} real-productivity points earned`
    });
  }

  const unprod = Number(day.u) || 0;
  const prod = Number(day.p) || 0;
  if (prod > 0 && unprod > 0 && prod > unprod * 1.5) {
    out.push({
      id: 'ratio',
      score: 62,
      text: `${Math.round(prod / 60)}m focused vs ${Math.round(unprod / 60)}m distracted. You won the day`
    });
  }

  // ── BEHAVIORAL observations (user spec 2026-07) ───────────────────────
  // Not productivity scores — patterns. "You are a night researcher" beats
  // "You were 62% productive" because nobody feels judged by a pattern.
  // Each is data-gated AND seeded-rare (they appear only some days, so a
  // sighting feels like the extension noticed something, not a template).
  const daySeed = hashString(day.dayKey || String(day.ts));
  const rare = (id, pct) => (hashString(`${id}:${daySeed}`) % 100) < pct;

  // Weekday baseline comparison: "38 more focused minutes than your average
  // Tuesday" — needs ≥2 prior same-weekday samples. Positive deltas only;
  // a below-average day never gets rubbed in.
  const dow = new Date(day.ts).getDay();
  const priorSameDays = summariesSorted(summaryMap)
    .filter((s) => s.ts < day.ts && new Date(s.ts).getDay() === dow && (Number(s.p) || 0) > 0)
    .slice(-6);
  if (priorSameDays.length >= 2 && rare('weekdayAvg', 60)) {
    const avg = priorSameDays.reduce((a, s) => a + (Number(s.p) || 0), 0) / priorSameDays.length;
    const deltaMin = Math.round((prod - avg) / 60);
    if (deltaMin >= 15) {
      out.push({
        id: 'weekdayAvg',
        score: 78,
        text: `${deltaMin} more focused minutes than your average ${WEEKDAY[dow]}`
      });
    }
  }

  // Hidden early-start streak: consecutive days (ending yesterday) with real
  // focus before 9am. Streaks people didn't know existed.
  const before9 = (s) => (Array.isArray(s?.hourlyP) ? s.hourlyP : [])
    .slice(0, 9).reduce((a, v) => a + (Number(v) || 0), 0) >= 5 * 60;
  if (before9(day)) {
    let streakDays = 1;
    for (let ago = 2; ago <= 14; ago++) {
      const prev = summaryForDaysAgo(summaryMap, ago, now);
      if (prev && before9(prev)) streakDays++;
      else break;
    }
    if (streakDays >= 3 && rare('earlyStreak', 70)) {
      out.push({
        id: 'earlyStreak',
        score: 80,
        text: `You've started before 9am ${streakDays} days in a row, a streak you didn't know you had`
      });
    }
  }

  // Recovered attention: closes happened AND real focus still got done —
  // celebrate the returning, not the stumbling.
  const totalCloses = Object.values(closes).reduce((a, b) => a + (Number(b) || 0), 0);
  if (totalCloses >= 3 && prod >= 30 * 60 && rare('recovered', 55)) {
    out.push({
      id: 'recovered',
      score: 76,
      text: `You got distracted ${totalCloses} times yesterday… and came back every single time`
    });
  }

  // Identity: where in the day the focus actually lives.
  const hourly = Array.isArray(day.hourlyP) ? day.hourlyP : [];
  const hourlyTotal = hourly.reduce((a, v) => a + (Number(v) || 0), 0);
  if (hourlyTotal >= 45 * 60 && rare('identity', 40)) {
    const night = hourly.slice(20).reduce((a, v) => a + (Number(v) || 0), 0);
    const morning = hourly.slice(5, 12).reduce((a, v) => a + (Number(v) || 0), 0);
    if (night / hourlyTotal >= 0.6) {
      out.push({ id: 'identity', score: 74, text: 'Most of your focus happens after 8pm. You work like a night researcher' });
    } else if (morning / hourlyTotal >= 0.6) {
      out.push({ id: 'identity', score: 74, text: 'You do your best work before noon. The afternoon is just cleanup' });
    }
  }

  return out;
}

/**
 * Classify yesterday's "mood" tier — drives the ADAPTIVE tone of the daily
 * recap (user spec 2026-07: never rub a bad day in; celebrate good ones).
 *
 *   empty  — Chrome was barely open (<10 min tracked total): nothing to
 *            recap; the banner just says the workspace is ready.
 *   reset  — high-distraction day (1h+ unproductive AND 3× the focus):
 *            "Tomorrow is a reset" + offer to tighten settings.
 *   rough  — under 30 min of focus: gentle reflection, one small
 *            improvement — NOT "you only focused 18 minutes".
 *   great  — 2h+ of focus that also beat distraction: full celebration.
 *   steady — everything else: progress + one insight.
 *
 * `sessions` = hours of the day with ≥5 focused minutes — the "small steps"
 * count used for rough-day copy ("You completed 2 focused sessions").
 */
export function classifyDayMood(day) {
  if (!day) return { mood: 'empty', sessions: 0 };
  const p = Number(day.p) || 0;
  const u = Number(day.u) || 0;
  const sessions = (Array.isArray(day.hourlyP) ? day.hourlyP : [])
    .filter((sec) => (Number(sec) || 0) >= 5 * 60).length;
  if (p + u < 10 * 60) return { mood: 'empty', sessions };
  // 'reset' — heavy-distraction day: ≥1h unprod AND unprod > 3× prod.
  // (User spec 2026-07 v36: reverted the "low-focus promotes to reset"
  // path from v35 — rough days keep their "Small steps still count"
  // card. Only genuine high-distraction days get the settings-nudge.)
  if (u >= 3600 && u > 3 * p) return { mood: 'reset', sessions };
  if (p < 30 * 60) return { mood: 'rough', sessions };
  if (p >= 2 * 3600 && p >= u) return { mood: 'great', sessions };
  return { mood: 'steady', sessions };
}

/**
 * Build the DAILY recap for yesterday. Brief by design; rotates 2 insights
 * per day (seeded by the dayKey so it's stable within the day but fresh the
 * next), and always teases the weekly. Tone adapts to the day's mood (see
 * classifyDayMood) — bad days get gentleness, not a scoreboard.
 */
export function buildDailyRecap(summaryMap, { now = Date.now(), streak = 0 } = {}) {
  const day = summaryForYesterday(summaryMap, now);
  if (!day) return null;

  const dateObj = new Date(day.ts);
  const candidates = dailyInsightCandidates(day, summaryMap, now)
    .sort((a, b) => b.score - a.score);
  // Take the strongest, then seeded-rotate the remainder for slot 2 so the
  // second line varies day to day even with similar data.
  const picks = [];
  if (candidates.length) picks.push(candidates[0]);
  const rest = seededShuffle(candidates.slice(1), hashString(day.dayKey || String(day.ts)));
  if (rest.length) picks.push(rest[0]);

  // Weekly tease: days until the recap "lands" (Monday, covering last week).
  const dow = new Date(now).getDay(); // 0=Sun
  const daysToMonday = ((8 - dow) % 7) || 7;
  const { end } = lastCompletedWeekRange(now);
  const weeklyFresh = (now - end) < 2 * DAY_MS; // Mon/Tue right after a week completed
  const tease = weeklyFresh
    ? 'Your Weekly Wrapped is ready. Open it below'
    : (streak >= 2
        ? `${streak}-day streak. Keep it alive for your Weekly Wrapped (${daysToMonday === 1 ? 'tomorrow' : `in ${daysToMonday} days`})`
        : `Weekly Wrapped ${daysToMonday === 1 ? 'lands tomorrow' : `lands in ${daysToMonday} days`}. The full week, in depth`);

  const { mood, sessions } = classifyDayMood(day);

  const base = {
    kind: 'daily',
    key: day.dayKey || String(day.ts),
    ts: day.ts,
    mood,
    sessions,
    title: `${WEEKDAY[dateObj.getDay()]} in review`,
    dateLabel: `${WEEKDAY[dateObj.getDay()]} ${dateObj.getDate()} ${MONTH[dateObj.getMonth()].slice(0, 3)}`,
    heroSec: Number(day.p) || 0,
    heroLabel: 'focused yesterday',
    insights: picks.map((p) => p.text),
    tease,
    shareText: `Yesterday: ${fmtDur(day.p)} of real focus. Tracked by >=PlayingFild.`
  };

  if (mood === 'rough') {
    // Gentle reflection + ONE small improvement — never "you only focused
    // 18 minutes". Prefer the best focus window as the improvement anchor;
    // fall back to a concrete tiny commitment.
    const win = bestFocusBlock(day.hourlyP);
    const improvement = win
      ? `Your best focus window was ${fmtHour(win.startHour)}. Try protecting this time tomorrow.`
      : 'Pick one 25-minute block tomorrow and guard it. That’s all it takes.';
    if (sessions >= 1) {
      // Hero is the SESSION COUNT, not the minutes: "2 focused sessions".
      base.heroSec = 0;
      base.heroCount = sessions;
      base.heroCountUnit = sessions === 1 ? 'focused session' : 'focused sessions';
      base.heroLabel = 'completed yesterday';
    }
    base.title = 'Small steps still count';
    base.heroDetail = 'Small steps still count.';
    base.insights = [improvement];
    base.shareText = `Small steps still count: ${sessions >= 1 ? `${sessions} focused session${sessions === 1 ? '' : 's'}` : fmtDur(day.p)} yesterday. Tracked by >=PlayingFild.`;
  } else if (mood === 'reset') {
    // Very bad day: the banner leads with a reset, not a recap. These
    // strings are consumed by the dashboard banner (buttons live there).
    base.title = 'Tomorrow is a reset';
    base.resetLine = 'Tomorrow is a reset';
    base.resetSub = 'PlayingFild noticed you had a high-distraction day. Want to tighten your focus settings?';
    base.heroDetail = 'Every day starts from zero.';
  } else if (mood === 'empty') {
    // Barely-used day: nothing worth opening — the banner shows a single
    // quiet line and a dismiss, exactly like the first-day teaser.
    base.emptyLine = 'Your workspace is ready whenever you are.';
  }

  return base;
}

/** Build the WEEKLY recap for the last completed Mon–Sun week. */
export function buildWeeklyRecap(summaryMap, { now = Date.now() } = {}) {
  const { start, end } = lastCompletedWeekRange(now);
  const days = summariesInRange(summaryMap, start, end);
  if (days.length < 2) return null; // not enough recorded days to be worth it

  const totalP = sumField(days, 'p');
  const totalU = sumField(days, 'u');
  const closes = mergeCloses(days);
  const closeTotal = Object.values(closes).reduce((a, b) => a + b, 0);
  const topBlocked = topClosedHost(days);
  const window4 = bestFocusWindow(mergeHourlyP(days));
  const topHosts = mergeTopHosts(days, 3);
  const biggest = [...days].sort((a, b) => (b.p || 0) - (a.p || 0))[0];
  const reorders = sumField(days, 'reorders');
  const timers = sumField(days, 'timers');
  const shields = sumField(days, 'shields');

  const s = new Date(start); const e = new Date(end - 1);
  const rangeLabel = `${s.getDate()} ${MONTH[s.getMonth()].slice(0, 3)} – ${e.getDate()} ${MONTH[e.getMonth()].slice(0, 3)}`;

  const stats = [];
  if (window4) stats.push({ label: 'Golden window', value: `${fmtHour(window4.startHour)}–${fmtHour(window4.endHour)}` });
  if (topBlocked) stats.push({ label: `${prettyHost(topBlocked.host)} blocked`, value: `${topBlocked.count}×` });
  if (biggest) stats.push({ label: 'Biggest day', value: `${WEEKDAY[new Date(biggest.ts).getDay()]} · ${fmtDur(biggest.p)}` });
  if (topHosts[0]) stats.push({ label: 'Top tab', value: `${prettyHost(topHosts[0].host)} · ${fmtDur(topHosts[0].sec)}` });
  if (reorders >= 20) stats.push({ label: 'Tab re-ranks', value: `${reorders}` });
  if (timers >= 2) stats.push({ label: 'Focus timers', value: `${timers}` });
  if (shields >= 1) stats.push({ label: 'Tabs shielded', value: `${shields}` });
  if (closeTotal >= 1) stats.push({ label: 'Distractions closed', value: `${closeTotal}` });

  // Day-by-day bars for the modal (label + productive sec).
  const bars = days.map((d) => ({
    label: WEEKDAY[new Date(d.ts).getDay()].slice(0, 3),
    sec: Number(d.p) || 0
  }));

  const monthName = MONTH[new Date(now).getMonth()];

  // "Alive" comparative line (user spec 2026-07): beat-your-own-baseline
  // beats a raw total. Positive deltas only — a down week isn't rubbed in.
  const insights = [];
  const prevWeek = summariesInRange(summaryMap, start - 7 * DAY_MS, start);
  if (prevWeek.length >= 2) {
    const prevP = sumField(prevWeek, 'p');
    const deltaSec = totalP - prevP;
    if (prevP > 0 && deltaSec >= 20 * 60) {
      insights.push(`You finished this week ${fmtDur(deltaSec)} ahead of last week`);
    }
  }
  const recovered = closeTotal >= 5 && totalP >= 3600
    ? `${closeTotal} detours this week and you came back from every one`
    : null;
  if (recovered) insights.push(recovered);

  return {
    kind: 'weekly',
    key: `w:${start}`,
    ts: end - 1,
    title: 'Your Weekly Wrapped',
    dateLabel: rangeLabel,
    heroSec: totalP,
    heroLabel: 'focused this week',
    stats: stats.slice(0, 6),
    insights: insights.slice(0, 2),
    bars,
    totalU,
    tease: `The ${monthName} Monthly Wrapped goes deeper than daily and weekly combined. It drops on the 1st.`,
    shareText: `My week: ${fmtDur(totalP)} of deep focus${topBlocked ? `, ${prettyHost(topBlocked.host)} blocked ${topBlocked.count}×` : ''}. Tracked by >=PlayingFild.`
  };
}

// ── spotlight cards (Spotify-Wrapped-style variants) ───────────────────────
// Each recap kind expands into MULTIPLE cards the user swipes through —
// not one dense summary. Each spotlight is a shareable poster on its own.
// Availability is data-gated: no top-tab spotlight if no meaningful tab,
// no golden-hour spotlight if the day was too sparse, etc.

function _tenseCopy(kind) {
  if (kind === 'daily') return { when: 'yesterday' };
  if (kind === 'monthly') return { when: 'this month' };
  return { when: 'this week' };
}

/** Top-tab spotlight — dedicated card for the top host + duration. */
export function buildTopTabSpotlight(days, kind, kickerDate) {
  const merged = mergeTopHosts(days, 1);
  const top = merged[0];
  if (!top || top.sec < 15 * 60) return null;
  const t = _tenseCopy(kind);
  const host = prettyHost(top.host);
  // Editorial label — narrative framing per class, so cards read as story
  // beats not stat lines. "docs.google.com quietly became your second brain"
  // beats "on docs.google.com this week" for share-worthiness.
  let heroLabel;
  let heroDetail = null;
  if (top.cls === 'Productive') {
    heroLabel = `${host} quietly became your second brain`;
    heroDetail = t.when === 'yesterday' ? 'That counted as focused time.' : null;
  } else if (top.cls === 'Unproductive') {
    heroLabel = `${host} kept pulling you back`;
  } else {
    heroLabel = `${host} was where you spent most of your time`;
  }
  return {
    kind, variant: 'topTab',
    key: `${kind}:topTab:${top.host}:${kickerDate}`,
    title: 'Your top tab',
    dateLabel: kickerDate,
    heroSec: top.sec,
    heroLabel,
    heroDetail,
    stats: [], insights: [],
    shareText: top.cls === 'Productive'
      ? `${host} quietly became my second brain ${t.when}. Tracked by >=PlayingFild.`
      : `${fmtDur(top.sec)} on ${host} ${t.when}. Tracked by >=PlayingFild.`
  };
}

/** Golden-hour spotlight — best 4-hour focus window. */
export function buildGoldenHourSpotlight(days, kind, kickerDate) {
  const win = bestFocusWindow(mergeHourlyP(days), 4);
  if (!win || win.sec < 45 * 60) return null;
  const t = _tenseCopy(kind);
  const range = `${fmtHour(win.startHour)}–${fmtHour(win.endHour)}`;
  return {
    kind, variant: 'goldenHour',
    key: `${kind}:golden:${win.startHour}:${kickerDate}`,
    title: 'Your golden window',
    dateLabel: kickerDate,
    heroSec: win.sec,
    heroLabel: `${range} is when your brain shows up`,
    heroDetail: 'Protect this stretch of the day.',
    stats: [], insights: [],
    shareText: `${range} is when my brain shows up. Tracked by >=PlayingFild.`
  };
}

/** Distraction spotlight — top blocked host with its count. */
export function buildDistractionSpotlight(days, kind, kickerDate) {
  const blocked = topClosedHost(days);
  if (!blocked || blocked.count < 3) return null;
  const t = _tenseCopy(kind);
  const host = prettyHost(blocked.host);
  // Editorial label — reframe blocks as agency: "You chose work N times",
  // "moments where distraction didn't win". Much more share-worthy than
  // the flat "N blocks on youtube.com" original.
  const isOne = blocked.count === 1;
  // Alternate label per period so daily/weekly/monthly don't read identical.
  const label = kind === 'weekly'
    ? `moments where distraction didn't win`
    : kind === 'monthly'
      ? `times you chose work over ${host}`
      : `times you closed ${host} and got back to it`;
  return {
    kind, variant: 'distraction',
    key: `${kind}:distraction:${blocked.host}:${kickerDate}`,
    title: 'You chose work',
    dateLabel: kickerDate,
    heroSec: 0,
    heroCount: blocked.count,
    heroCountUnit: isOne ? 'time' : 'times',
    heroLabel: label,
    heroDetail: null,
    stats: [], insights: [],
    shareText: kind === 'weekly'
      ? `${blocked.count} moments this week where distraction didn't win. Tracked by >=PlayingFild.`
      : `Chose work over ${host} ${blocked.count}× ${t.when}. Tracked by >=PlayingFild.`
  };
}

/** Streak spotlight — only if streak is meaningful (3+). */
export function buildStreakSpotlight(streak, kind, kickerDate) {
  const s = Math.max(0, Math.floor(Number(streak) || 0));
  if (s < 3) return null;
  return {
    kind, variant: 'streak',
    key: `${kind}:streak:${s}:${kickerDate}`,
    title: 'Streak alive',
    dateLabel: kickerDate,
    heroSec: 0,
    heroCount: s,
    heroCountUnit: s === 1 ? 'day' : 'days',
    heroLabel: 'of focused practice in a row',
    heroDetail: 'One day at a time.',
    stats: [], insights: [],
    shareText: `${s}-day focus streak alive. Tracked by >=PlayingFild.`
  };
}

/** Identity spotlight — "how you work" pattern card (night researcher /
 *  morning brain). Data-gated on a meaningful hourly distribution. */
export function buildIdentitySpotlight(days, kind, kickerDate) {
  const hourly = mergeHourlyP(days);
  const total = hourly.reduce((a, v) => a + v, 0);
  if (total < 45 * 60) return null;
  const night = hourly.slice(20).reduce((a, v) => a + v, 0);
  const morning = hourly.slice(5, 12).reduce((a, v) => a + v, 0);
  const t = _tenseCopy(kind);
  let title = null; let label = null; let heroSec = 0;
  if (night / total >= 0.6) {
    title = 'You are a night researcher';
    label = `of your focus landed after 8pm ${t.when}`;
    heroSec = night;
  } else if (morning / total >= 0.6) {
    title = 'You are a morning brain';
    label = `of your focus landed before noon ${t.when}`;
    heroSec = morning;
  }
  if (!title) return null;
  return {
    kind, variant: 'identity',
    key: `${kind}:identity:${kickerDate}`,
    title,
    dateLabel: kickerDate,
    heroSec,
    heroLabel: label,
    heroDetail: 'A pattern, not a score.',
    stats: [], insights: [],
    shareText: `${title}. Tracked by >=PlayingFild.`
  };
}

/** Recovered-attention spotlight — celebrate the RETURNING, not the focus
 *  total. "You got distracted six times… and came back every time." */
export function buildRecoverySpotlight(days, kind, kickerDate) {
  const closes = mergeCloses(days);
  const total = Object.values(closes).reduce((a, b) => a + b, 0);
  const p = sumField(days, 'p');
  if (total < 3 || p < 30 * 60) return null;
  const t = _tenseCopy(kind);
  return {
    kind, variant: 'recovery',
    key: `${kind}:recovery:${total}:${kickerDate}`,
    title: 'You kept coming back',
    dateLabel: kickerDate,
    heroSec: 0,
    heroCount: total,
    heroCountUnit: total === 1 ? 'detour' : 'detours',
    heroLabel: `${t.when}, and you returned every single time`,
    heroDetail: 'Recovered attention is the real skill.',
    stats: [], insights: [],
    shareText: `Got distracted ${total} times ${t.when} and came back every single time. Tracked by >=PlayingFild.`
  };
}

/** Hidden-streak spotlight — early starts N days in a row (daily only;
 *  needs the day-by-day archive). */
export function buildHiddenStreakSpotlight(summaryMap, kickerDate, now = Date.now()) {
  const before9 = (s) => (Array.isArray(s?.hourlyP) ? s.hourlyP : [])
    .slice(0, 9).reduce((a, v) => a + (Number(v) || 0), 0) >= 5 * 60;
  const yest = summaryForYesterday(summaryMap, now);
  if (!yest || !before9(yest)) return null;
  let run = 1;
  for (let ago = 2; ago <= 21; ago++) {
    const prev = (function () {
      const target = now - ago * DAY_MS;
      return summariesSorted(summaryMap).find((s) => sameLocalDay(s.ts, target)) || null;
    })();
    if (prev && before9(prev)) run++;
    else break;
  }
  if (run < 3) return null;
  return {
    kind: 'daily', variant: 'hiddenStreak',
    key: `daily:hiddenStreak:${run}:${kickerDate}`,
    title: 'A streak you didn’t know you had',
    dateLabel: kickerDate,
    heroSec: 0,
    heroCount: run,
    heroCountUnit: 'mornings',
    heroLabel: 'in a row starting before 9am',
    heroDetail: 'Quietly, without trying.',
    stats: [], insights: [],
    shareText: `${run} mornings in a row starting before 9am. Tracked by >=PlayingFild.`
  };
}

/**
 * MEME spotlight (monthly, VERY rare — self-deprecating internet humor).
 * Data-gated: needs a top unproductive host with real hours. Seeded gate
 * keeps it to roughly one month in eight, so a sighting feels like an
 * event, and templates rotate so screenshots differ between users.
 */
export function buildMemeSpotlight(days, kickerDate, monthKey) {
  // ~12% of months, seeded by the month so it's stable within the month.
  if (hashString(`meme:${monthKey}`) % 100 >= 12) return null;
  const merged = mergeTopHosts(days, 6);
  const unprodTop = merged.find((h) => h.cls === 'Unproductive' && h.sec >= 3 * 3600);
  if (!unprodTop) return null;
  const prodTop = merged.find((h) => h.cls === 'Productive');
  const uh = fmtDur(unprodTop.sec);
  const templates = [
    `You spent ${uh} on ${prettyHost(unprodTop.host)} this month. It's called research.`,
    prodTop && prodTop.sec < unprodTop.sec
      ? `${fmtDur(prodTop.sec)} on ${prettyHost(prodTop.host)}. ${uh} on ${prettyHost(unprodTop.host)}. Priorities.`
      : null,
    `${prettyHost(unprodTop.host)} got ${uh} of your one wild and precious life. Go outside.`,
    `POV: you opened ${prettyHost(unprodTop.host)} "for a second". ${uh} later…`
  ].filter(Boolean);
  const text = templates[hashString(`memeTpl:${monthKey}`) % templates.length];
  return {
    kind: 'monthly', variant: 'meme',
    key: `monthly:meme:${monthKey}`,
    title: 'This one stays between us',
    dateLabel: kickerDate,
    heroSec: unprodTop.sec,
    heroLabel: `on ${prettyHost(unprodTop.host)} this month`,
    heroDetail: null,
    stats: [], insights: [text],
    shareText: `${text} · >=PlayingFild`
  };
}

/**
 * Build the ordered list of "slides" for a recap kind: the main summary
 * card first, then applicable spotlights. Nulls (no data) are filtered.
 */
export function buildRecapSlides(summaryMap, kind, { now = Date.now(), streak = 0 } = {}) {
  const slides = [];
  if (kind === 'daily') {
    const daily = buildDailyRecap(summaryMap, { now, streak });
    if (!daily) return [];
    slides.push(daily);
    const day = summaryForYesterday(summaryMap, now);
    if (day) {
      const kickerDate = daily.dateLabel;
      const days = [day];
      // Deliberate STAGGER (user spec 2026-07): the classic spotlights are
      // always candidates, but the behavioral ones (identity / recovery /
      // hidden streak) are seeded-gated per day so the daily pool rotates —
      // some days the chest holds a pattern card, some days it doesn't.
      const seed = hashString(daily.key || kickerDate);
      const gate = (id, pct) => (hashString(`${id}:${seed}`) % 100) < pct;
      [
        buildTopTabSpotlight(days, 'daily', kickerDate),
        buildGoldenHourSpotlight(days, 'daily', kickerDate),
        buildDistractionSpotlight(days, 'daily', kickerDate),
        buildStreakSpotlight(streak, 'daily', kickerDate),
        gate('identity', 45) ? buildIdentitySpotlight(days, 'daily', kickerDate) : null,
        gate('recovery', 45) ? buildRecoverySpotlight(days, 'daily', kickerDate) : null,
        gate('hiddenStreak', 60) ? buildHiddenStreakSpotlight(summaryMap, kickerDate, now) : null,
      ].forEach((s) => { if (s) slides.push(s); });
    }
    return slides;
  }
  if (kind === 'weekly') {
    const weekly = buildWeeklyRecap(summaryMap, { now });
    if (!weekly) return [];
    slides.push(weekly);
    const { start, end } = lastCompletedWeekRange(now);
    const days = summariesInRange(summaryMap, start, end);
    const kickerDate = weekly.dateLabel;
    [
      buildTopTabSpotlight(days, 'weekly', kickerDate),
      buildGoldenHourSpotlight(days, 'weekly', kickerDate),
      buildDistractionSpotlight(days, 'weekly', kickerDate),
      buildIdentitySpotlight(days, 'weekly', kickerDate),
      buildRecoverySpotlight(days, 'weekly', kickerDate),
    ].forEach((s) => { if (s) slides.push(s); });
    return slides;
  }
  if (kind === 'monthly') {
    const monthly = buildMonthlyRecap(summaryMap, { now });
    if (!monthly) return [];
    slides.push(monthly);
    const { start, end } = lastCompletedMonthRange(now);
    const days = summariesInRange(summaryMap, start, end);
    const kickerDate = monthly.dateLabel;
    [
      buildTopTabSpotlight(days, 'monthly', kickerDate),
      buildGoldenHourSpotlight(days, 'monthly', kickerDate),
      buildDistractionSpotlight(days, 'monthly', kickerDate),
      buildIdentitySpotlight(days, 'monthly', kickerDate),
      buildRecoverySpotlight(days, 'monthly', kickerDate),
      // VERY rare self-deprecating meme card (~1 month in 8, data-gated).
      buildMemeSpotlight(days, kickerDate, `m:${start}`),
    ].forEach((s) => { if (s) slides.push(s); });
    return slides;
  }
  return [];
}

/** Build the MONTHLY recap for the last completed calendar month. */
export function buildMonthlyRecap(summaryMap, { now = Date.now() } = {}) {
  const { start, end } = lastCompletedMonthRange(now);
  const days = summariesInRange(summaryMap, start, end);
  if (days.length < 5) return null;

  const totalP = sumField(days, 'p');
  const totalU = sumField(days, 'u');
  const closes = mergeCloses(days);
  const closeTotal = Object.values(closes).reduce((a, b) => a + b, 0);
  const topBlocked = topClosedHost(days);
  const window4 = bestFocusWindow(mergeHourlyP(days));
  const topHosts = mergeTopHosts(days, 5);
  const biggest = [...days].sort((a, b) => (b.p || 0) - (a.p || 0))[0];
  const activeDays = days.filter((d) => (d.p || 0) >= 15 * 60).length;
  const timers = sumField(days, 'timers');
  const reorders = sumField(days, 'reorders');

  // ── HERO (reserved for monthly — never spoiled by daily/weekly) ──────────
  // "You reclaimed Nh from <host>": estimated from blocked closes of the top
  // distraction × the median unproductive dwell it cost when it DID get
  // through (approximated from this month's own data: unprod seconds per
  // close on that host, clamped 5–20 min so the estimate stays honest).
  let hero = null;
  if (topBlocked && topBlocked.count >= 5) {
    let hostUnprodSec = 0;
    for (const d of days) {
      const th = (d.topHosts || []).find(([h]) => h === topBlocked.host);
      if (th) hostUnprodSec += Number(th[1]) || 0;
    }
    const perVisit = Math.min(20 * 60, Math.max(5 * 60, hostUnprodSec / Math.max(1, topBlocked.count)));
    const reclaimedSec = Math.round(topBlocked.count * perVisit);
    hero = {
      sec: reclaimedSec,
      line: `reclaimed from ${prettyHost(topBlocked.host)}`,
      detail: `${topBlocked.count} blocked visits × ~${Math.round(perVisit / 60)}m each`
    };
  }

  const monthDate = new Date(start);
  const monthLabel = `${MONTH[monthDate.getMonth()]} ${monthDate.getFullYear()}`;

  const stats = [];
  stats.push({ label: 'Deep focus', value: fmtDur(totalP) });
  if (activeDays) stats.push({ label: 'Active days', value: `${activeDays}/${days.length}` });
  if (window4) stats.push({ label: 'Golden window', value: `${fmtHour(window4.startHour)}–${fmtHour(window4.endHour)}` });
  if (topBlocked) stats.push({ label: `${prettyHost(topBlocked.host)} blocked`, value: `${topBlocked.count}×` });
  if (closeTotal) stats.push({ label: 'Distractions closed', value: `${closeTotal}` });
  if (biggest) stats.push({ label: 'Biggest day', value: `${new Date(biggest.ts).getDate()} ${MONTH[new Date(biggest.ts).getMonth()].slice(0, 3)} · ${fmtDur(biggest.p)}` });
  if (timers >= 3) stats.push({ label: 'Focus timers', value: `${timers}` });
  if (reorders >= 50) stats.push({ label: 'Tab re-ranks', value: `${reorders}` });

  return {
    kind: 'monthly',
    key: `m:${start}`,
    ts: end - 1,
    title: `${MONTH[monthDate.getMonth()]} Wrapped`,
    dateLabel: monthLabel,
    heroSec: hero ? hero.sec : totalP,
    heroLabel: hero ? hero.line : 'of deep focus this month',
    heroDetail: hero ? hero.detail : null,
    stats: stats.slice(0, 8),
    topHosts,
    totalU,
    tease: null,
    shareText: hero
      ? `I reclaimed ${fmtDur(hero.sec)} from ${prettyHost(topBlocked.host)} in ${MONTH[monthDate.getMonth()]}. Tracked by >=PlayingFild.`
      : `${MONTH[monthDate.getMonth()]}: ${fmtDur(totalP)} of deep focus. Tracked by >=PlayingFild.`
  };
}
