// constants.js — single source of truth for anchored hosts and other shared constants.
// Anchored hosts are domains where:
// - Title-based classification is the only reliable signal (page content classifier blocked by SPA architecture or shields)
// - The closer should auto-fire on Unproductive classification with lower confidence threshold (0.20 vs 0.50)

/** Maximum tabs a user may configure per window (enforcement ceiling).
 *  Raised 8 → 10 per user spec 2026-07, then 10 → 20 per user spec
 *  2026-07-30; going above the cap shows the "N is the max" popup on the
 *  dashboard/tutorial. Every clamp in worker.js and stats.js reads this
 *  constant, and pfShowTabLimitMaxPopup interpolates it into its copy, so
 *  this line is the only place the number needs to change. */
export const MAX_TAB_LIMIT = 20;

/**
 * Date of the last material change to PRIVACY.md, as a plain YYYY-MM-DD string.
 *
 * BUMP THIS whenever PRIVACY.md changes in a way a user would care about. That
 * is the entire trigger for the "our privacy policy has changed" banner on the
 * dashboard: the banner shows whenever the stored pfPrivacyPolicyAckVersion
 * does not equal this value, and dismissing it writes this value back.
 *
 * It deliberately does NOT track the extension version. Most releases do not
 * touch the policy, and a banner that reappeared every update would be noise
 * that people learn to click past, which defeats the point of having it.
 *
 * EXISTING USERS ONLY: worker.js stamps a fresh install with this value at
 * install time, so somebody installing today has, by definition, already seen
 * the current policy and never gets the banner. Only a profile that predates
 * the change is left without a matching stamp, which is exactly who should be
 * told. See the onInstalled handler.
 */
export const PRIVACY_POLICY_VERSION = '2026-07-30';

/**
 * ── PER-WEBSITE IMPORTANCE (website ranking mode only) ────────────────────
 *
 * User spec: "keep track of how important a website is by looking at how much
 * they use it, like constantly reopen, not just engagement as a whole thing.
 * Make that the website one so it orders by most important websites so the
 * important tabs don't get closed. Also make sure that one important doesn't
 * get too higher."
 *
 * Engagement already measures how hard you work inside a tab. It says nothing
 * about how often you come BACK to a site across separate tabs and separate
 * days. A docs site you open thirty times a week for two minutes each is
 * plainly important, and on engagement alone it looks disposable.
 *
 * Three separate brakes stop one site running away with the ranking, which is
 * the "don't let one get too high" requirement:
 *
 *  1. PF_HOST_OPEN_MAX caps what is stored. Opens beyond it are not recorded,
 *     so a site cannot accumulate an unbounded number.
 *  2. The score curve is logarithmic and clamped to 1, so the difference
 *     between 30 opens and 300 is nearly nothing.
 *  3. PF_HOST_IMPORTANCE_WEIGHT caps the contribution at 0.25/1.25 = 20% of
 *     the range. A site you never really use cannot outrank one you work in,
 *     no matter how many times you have opened it.
 *
 * PF_HOST_OPEN_MIN_GAP_MS stops a redirect chain or a refresh loop counting
 * as ten separate opens.
 */
export const PF_HOST_OPEN_MAX = 40;
export const PF_HOST_OPEN_MIN_GAP_MS = 60 * 1000;
export const PF_HOST_IMPORTANCE_WEIGHT = 0.25;

/** Bounded 0-1 "how often do you come back to this site" score. */
export function hostImportanceComponent(openCount) {
  const n = Math.max(0, Math.min(PF_HOST_OPEN_MAX, Math.floor(Number(openCount) || 0)));
  if (n <= 0) return 0;
  return Math.min(1, Math.log(n + 1) / Math.log(PF_HOST_OPEN_MAX + 1));
}

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
