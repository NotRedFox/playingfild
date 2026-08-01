/**
 * tab_grouping.js — keep related tabs next to each other.
 *
 * WHAT THIS DOES
 * Given the tabs in a window, cluster the ones that look like they are about
 * the same thing (five coronavirus articles across five sites, or eight tabs
 * on one docs site) and emit an order where each cluster is contiguous.
 *
 * WHAT THE SIMILARITY SIGNAL ACTUALLY IS — read this before trusting it.
 * Titles and hostnames. Nothing else. Specifically NOT the MiniLM embeddings
 * the classifier uses: those are keyed by keyword in state.keywordEmbeddings,
 * not per tab, so using them would mean running ONNX inference over every tab
 * title on every reorder. Reorders fire on tab switches — that would be
 * hundreds of inferences a minute in a service worker that Chrome is trying
 * to kill. Lexical matching is cheap, synchronous and deterministic, which is
 * also what makes it testable.
 *
 * The honest limit: this groups "Coronavirus - Wikipedia" with "Coronavirus
 * live updates - BBC" because they share a rare token. It will NOT group
 * "COVID-19 vaccine" with "Coronavirus vaccine" — different surface words. If
 * that matters later, the upgrade is a small per-tab embedding cache keyed by
 * title hash, computed lazily off the hot path, feeding the same
 * `similarity()` seam this module already exposes.
 *
 * ORDERING RULES (user spec 2026-07-30)
 *   engagementEnabled = true   clusters sort by their strongest member's
 *                              engagement score, and members sort by score
 *                              inside each cluster.
 *   engagementEnabled = false  no engagement anywhere: clusters and members
 *                              keep current left-to-right order. Tabs still
 *                              get pulled together, but nothing is promoted,
 *                              so the bar stays as close to how the user left
 *                              it as grouping allows.
 *
 * This module is PURE — no chrome APIs, no imports, no I/O.
 */

/** Words too common to say anything about what a page is about. */
const PF_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'from', 'this', 'that', 'are',
  'was', 'were', 'how', 'what', 'why', 'when', 'who', 'all', 'can', 'get',
  'new', 'not', 'but', 'has', 'have', 'his', 'her', 'its', 'their', 'our',
  'about', 'into', 'over', 'more', 'most', 'some', 'them', 'then', 'than',
  'home', 'page', 'search', 'results', 'official', 'site', 'www', 'com',
  'org', 'net', 'html', 'index', 'login', 'sign', 'free', 'online', 'best',
  'top', 'guide', 'video', 'videos', 'watch', 'news', 'google', 'youtube'
]);

/**
 * Same host alone is exactly enough to group — eight tabs on one docs site
 * are obviously related.
 */
export const PF_HOST_WEIGHT = 0.5;
/** Full title-token containment scores 1.0; half scores 0.5. */
export const PF_TOKEN_WEIGHT = 1.0;
/** At or above this, two tabs belong together. */
export const PF_GROUP_THRESHOLD = 0.5;

/**
 * Two-label public suffixes. Without these, "last two labels" collapses
 * learn.uq.edu.au to "edu.au" — so every Australian university would group
 * together, and bbc.co.uk would group with guardian.co.uk. Not the full
 * Public Suffix List (that is thousands of entries and needs updating); just
 * the ones a real browsing session actually hits.
 */
const PF_MULTI_SUFFIXES = new Set([
  'co.uk', 'ac.uk', 'gov.uk', 'org.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au', 'asn.au', 'id.au',
  'co.nz', 'ac.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.br', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in', 'ac.in', 'edu.in', 'gov.in',
  'co.za', 'org.za', 'com.sg', 'edu.sg', 'com.hk', 'edu.hk',
  'com.mx', 'com.ar', 'com.tr', 'com.tw', 'edu.tw', 'com.my', 'edu.my',
  'co.il', 'ac.il', 'com.pl', 'com.es', 'com.pk', 'com.ph', 'co.id'
]);

/**
 * Registrable domain, so docs.foo.com ≈ foo.com and learn.uq.edu.au ≈
 * my.uq.edu.au — one institution, one group.
 */
export function hostKey(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
    const parts = h.split('.');
    if (parts.length <= 2) return h;
    const lastTwo = parts.slice(-2).join('.');
    // uq.edu.au, not edu.au.
    if (PF_MULTI_SUFFIXES.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return lastTwo;
  } catch (_) { return ''; }
}

/** Meaningful lowercase tokens from a page title. */
export function titleTokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !PF_STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * 0..1. Containment rather than Jaccard: a three-word title that is entirely
 * contained in a ten-word one is still the same topic, and Jaccard would
 * score that 0.3 and split them.
 */
/** A shared distinctive token is worth this on its own. */
export const PF_DISTINCTIVE_WEIGHT = 0.5;
/** Shorter than this is too generic to carry a topic ("app", "docs"). */
const PF_DISTINCTIVE_MIN_LEN = 5;
/** A token in more than this share of open tabs is boilerplate, not a topic. */
const PF_DISTINCTIVE_MAX_DF = 0.5;

/**
 * @param {object} a  { host, tokens }
 * @param {object} b  { host, tokens }
 * @param {{df: Map<string, number>, total: number}} [ctx]  document
 *   frequency across the tabs being grouped. Optional: without it, only the
 *   containment signal is used.
 */
export function similarity(a, b, ctx = null) {
  // MAX, not sum. Two independent reasons to group should not compound into
  // "extra grouped" — and an additive version needed each signal to be worth
  // half the threshold, which meant two pages on the SAME topic across
  // different sites scored 0.25 and never grouped. That is the exact case
  // this feature exists for.
  const hostScore = (a.host && a.host === b.host) ? PF_HOST_WEIGHT : 0;

  let tokenScore = 0;
  const smaller = a.tokens.size <= b.tokens.size ? a.tokens : b.tokens;
  const larger = smaller === a.tokens ? b.tokens : a.tokens;
  let distinctive = 0;
  if (smaller.size > 0) {
    let shared = 0;
    for (const t of smaller) {
      if (!larger.has(t)) continue;
      shared++;
      // Containment alone under-rates a shared course code or product name:
      // "[MATH1050/7050] Mathematical Foundations II" and "MATH1050 lecture
      // notes" share the one token that matters and score 1/3. A long token
      // that appears in only a couple of the open tabs is a topic marker, so
      // treat it as sufficient on its own.
      if (ctx && t.length >= PF_DISTINCTIVE_MIN_LEN) {
        const df = ctx.df.get(t) || 0;
        if (df >= 2 && df / Math.max(1, ctx.total) <= PF_DISTINCTIVE_MAX_DF) {
          distinctive = PF_DISTINCTIVE_WEIGHT;
        }
      }
    }
    tokenScore = PF_TOKEN_WEIGHT * (shared / smaller.size);
  }
  return Math.min(1, Math.max(hostScore, tokenScore, distinctive));
}

/**
 * Cluster tabs so related ones end up adjacent, then order them.
 *
 * @param {Array<{id:*, index:number, title:string, url:string, score:number}>} tabs
 * @param {{ engagementEnabled?: boolean, threshold?: number }} [opts]
 * @returns {Array} the same tab objects, in their new order
 */
export function groupAndOrderTabs(tabs, opts = {}) {
  const engagementEnabled = opts.engagementEnabled !== false;
  const threshold = typeof opts.threshold === 'number'
    ? opts.threshold : PF_GROUP_THRESHOLD;
  const list = Array.isArray(tabs) ? tabs : [];
  if (list.length < 2) return [...list];

  // Always cluster in current left-to-right order. Clustering must not depend
  // on engagement, or the same tabs would form different groups depending on
  // a toggle that is only supposed to affect ORDER.
  const items = [...list]
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((tab) => ({
      tab,
      host: hostKey(tab.url),
      tokens: titleTokens(tab.title)
    }));

  // Document frequency across THIS window's tabs, so "distinctive" means
  // rare here and now rather than rare in English. Two tabs sharing a course
  // code out of twenty open tabs is a strong signal; twenty tabs all sharing
  // "inbox" is not.
  const df = new Map();
  for (const item of items) {
    for (const t of item.tokens) df.set(t, (df.get(t) || 0) + 1);
  }
  const ctx = { df, total: items.length };

  /** @type {Array<{members: Array<object>}>} */
  const clusters = [];
  for (const item of items) {
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      // Single linkage: closeness to the nearest member, not to an average.
      // A topic accumulates vocabulary as it grows, and averaging dilutes the
      // rare token that identified it in the first place.
      let s = 0;
      for (const m of cluster.members) {
        const sim = similarity(item, m, ctx);
        if (sim > s) s = sim;
        if (s >= 1) break;
      }
      if (s >= threshold && s > bestScore) { bestScore = s; best = cluster; }
    }
    if (best) best.members.push(item);
    else clusters.push({ members: [item] });
  }

  const scoreOf = (m) => Number(m.tab.score) || 0;
  const indexOf = (m) => Number(m.tab.index) || 0;

  for (const c of clusters) {
    c.members.sort(engagementEnabled
      // Ties fall back to current position so equal-scoring tabs (very common
      // — most tabs score 0) do not shuffle on every pass.
      ? (x, y) => (scoreOf(y) - scoreOf(x)) || (indexOf(x) - indexOf(y))
      : (x, y) => indexOf(x) - indexOf(y));
    c.rank = engagementEnabled
      ? Math.max(...c.members.map(scoreOf))
      : Math.min(...c.members.map(indexOf));
    c.firstIndex = Math.min(...c.members.map(indexOf));
  }

  clusters.sort(engagementEnabled
    ? (a, b) => (b.rank - a.rank) || (a.firstIndex - b.firstIndex)
    : (a, b) => a.firstIndex - b.firstIndex);

  return clusters.flatMap((c) => c.members.map((m) => m.tab));
}
