// constants.js — single source of truth for anchored hosts and other shared constants.
// Anchored hosts are domains where:
// - Title-based classification is the only reliable signal (page content classifier blocked by SPA architecture or shields)
// - The closer should auto-fire on Unproductive classification with lower confidence threshold (0.20 vs 0.50)

/** Maximum tabs a user may configure per window (enforcement ceiling).
 *  Raised 8 → 10 per user spec 2026-07; going above 10 shows the
 *  "10 is the max" popup on the dashboard/tutorial. */
export const MAX_TAB_LIMIT = 10;

/** Minimum |score| for closer / budget enforcement to treat a tab as Unproductive. */
export const ANCHORED_UNPROD_THRESHOLD = 0.20;

export const ANCHORED_UNPROD_HOSTS = [
  'youtube.com', 'www.youtube.com',
  'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com',
  'reddit.com', 'www.reddit.com',
  'twitter.com', 'www.twitter.com',
  'x.com', 'www.x.com',
  'facebook.com', 'www.facebook.com',
  'twitch.tv', 'www.twitch.tv'
];

/** Check if a hostname matches any anchored unproductive host (subdomain-aware).
 *  e.g. matches "m.youtube.com" against "youtube.com", but does NOT match
 *  "notyoutube.com" against "youtube.com" (boundary check). */
export function isAnchoredHost(hostname, hostList) {
  if (!hostname || !hostList) return false;
  const h = hostname.toLowerCase();
  return hostList.some(anchor => {
    const a = anchor.toLowerCase();
    return h === a || h.endsWith('.' + a);
  });
}
