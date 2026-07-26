/**
 * Shared tab-limit URL classification.
 *
 * Two independent exclusions (both mean "does not count / not evicted"):
 * (a) Dashboard tabs — extension control surface (checked via isDashboardTab callback).
 * (b) Browser-internal non-content URLs — schemes the limiter cannot manage.
 */

/** Prefixes for browser-internal / non-content URLs. */
export const BROWSER_INTERNAL_URL_PREFIXES = [
  'chrome://',
  'brave://',
  'edge://',
  'about:',
  'chrome-extension://',
  'moz-extension://',
  'brave-extension://',
  'safari-web-extension://',
  'view-source:',
  'devtools://',
  'opera://',
  'vivaldi://'
];

/** Internal new-tab pages that still count toward the limit (user "empty tab" slots). */
export const TAB_LIMIT_COUNTABLE_NEWTAB_URLS = new Set([
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'brave://newtab/',
  'edge://newtab/',
  'about:newtab'
]);

export function normalizeTabLimitUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.split(/[#?]/)[0].toLowerCase();
}

export function isExtensionSchemeUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  return u.startsWith('chrome-extension://')
    || u.startsWith('moz-extension://')
    || u.startsWith('brave-extension://')
    || u.startsWith('safari-web-extension://');
}

export function isTabLimitCountableNewTabUrl(url) {
  const norm = normalizeTabLimitUrl(url);
  if (!norm) return false;
  if (TAB_LIMIT_COUNTABLE_NEWTAB_URLS.has(norm)) return true;
  return norm === 'chrome://newtab'
    || norm === 'brave://newtab'
    || norm === 'edge://newtab';
}

/** True for chrome://, brave://, about:, extension schemes, view-source:, devtools://, etc. */
export function isBrowserInternalUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return false;
  return BROWSER_INTERNAL_URL_PREFIXES.some((prefix) => u.startsWith(prefix));
}

/** Internal pages that are NOT countable content tabs (everything internal except new-tab URLs). */
export function isNonContentBrowserInternalUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (isTabLimitCountableNewTabUrl(u)) return false;
  return isBrowserInternalUrl(u);
}

/** Whether a resolved URL represents a normal content tab for tab-limit counting. */
export function countsAsTabLimitContentUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (isNonContentBrowserInternalUrl(u)) return false;
  if (isTabLimitCountableNewTabUrl(u)) return true;
  return true;
}

export function getEffectiveTabUrl(tab) {
  return String(tab?.url || tab?.pendingUrl || '').trim();
}

/**
 * URLs hosted by THIS extension that should NOT count toward the tab limit.
 * These are the extension's own control surfaces (dashboard, sign-in) — the
 * user shouldn't be forced to evict their own tabs just to use the extension.
 */
const PF_EXEMPT_EXTENSION_PATHS = ['stats.html', 'signup.html', 'signin.html'];

function urlMatchesExemptExtensionPath(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  return PF_EXEMPT_EXTENSION_PATHS.some((p) => u.includes(p));
}

/**
 * Shared tab-limit counting. Per user spec: ALL tabs count toward the limit,
 * including chrome://, brave://, chrome-extension://, etc. — opening a pile
 * of browser-internal tabs to bypass the limit no longer works. The ONLY
 * exemptions are the extension's own dashboard and sign-in pages.
 *
 * Note: this only affects COUNTING. The eviction logic separately refuses to
 * close browser-internal tabs (via getTabLimitEvictionExclusion's
 * isBrowserInternalTabForTabLimit check), so the limit-counter pressuring up
 * just forces other (regular content) tabs to evict instead.
 *
 * @param {chrome.tabs.Tab|object} tab
 * @param {{ isDashboardTab?: (tab: object) => boolean }} options
 */
export function tabCountsTowardTabLimitShared(tab, options = {}) {
  if (!tab) return false;

  const isDashboardTab = options.isDashboardTab;
  if (typeof isDashboardTab === 'function' && isDashboardTab(tab)) return false;

  const url = String(tab.url || '').trim();
  const pending = String(tab.pendingUrl || '').trim();

  // Extension's own control-surface pages (dashboard, sign-in) — exempt.
  if (urlMatchesExemptExtensionPath(url) || urlMatchesExemptExtensionPath(pending)) {
    return false;
  }

  if (typeof isDashboardTab === 'function' && pending) {
    if (isDashboardTab({ id: tab.id, url: pending, pendingUrl: pending })) return false;
  }

  // NOTE: a tab with NO url and NO pendingUrl still counts. Tabs that are
  // still loading, discarded, or crashed can report empty URLs — they are
  // real tab slots the user opened, and excluding them meant a pile of
  // "unanalysable" tabs silently bypassed the limit (user report 2026-07).
  // Everything counts — chrome://, brave://, chrome-extension:// from
  // OTHER extensions (Chrome Web Store etc.), regular https://, URL-less
  // loading tabs, all count.
  return true;
}

/** Eviction-pool helper — browser-internal non-content only (not dashboard). */
export function isBrowserInternalTabForTabLimit(tab) {
  const url = String(tab?.url || '').trim();
  const pending = String(tab?.pendingUrl || '').trim();
  const effectiveUrl = url || pending;
  if (!effectiveUrl) return false;
  return isNonContentBrowserInternalUrl(effectiveUrl);
}
