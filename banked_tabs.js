/**
 * banked_tabs.js — the "Banked Tabs" stash.
 *
 * When a user applies a tab limit while they already have more tabs open than
 * the limit allows, the overflow does not have to be thrown away. Banking
 * captures each overflow tab's url / title / favicon, closes the real tab, and
 * parks the record here. One stash tab then lists everything banked so the
 * user can restore what they actually wanted at their own pace.
 *
 * LIFETIME — read this before changing anything here.
 * Banked records are deleted permanently after PF_BANK_TTL_MS (24h) or as soon
 * as the stash tab is closed, whichever comes first (user spec 2026-07-30).
 * That is genuinely destructive: a user who closes the stash tab loses every
 * URL in it with no undo. Two deliberate mitigations:
 *   1. Closing the stash tab shows a confirm first (banked.js), so it cannot
 *      happen on a stray Cmd+W.
 *   2. Every banked URL is written to the daily recap log on the way in, so
 *      Daily Wrapped still remembers what was closed even after the purge.
 * If you remove either, the feature becomes a data-loss trap.
 *
 * Storage shape (chrome.storage.local):
 *   pfBankedTabs = {
 *     createdAt: <epoch ms>,     // when this stash was opened
 *     stashTabId: <number|null>, // the one tab showing the stash
 *     items: [{ id, url, title, favIconUrl, bankedAt }]
 *   }
 */

export const PF_BANKED_KEY = 'pfBankedTabs';
/** How long a stash survives before it is purged. */
export const PF_BANK_TTL_MS = 24 * 60 * 60 * 1000;
/** Overflow behaviour the user picked during onboarding. */
export const PF_OVERFLOW_MODE_KEY = 'pfTabOverflowMode'; // 'close' | 'bank'

/** Only http(s) tabs can be meaningfully restored later. */
export function isBankableUrl(url) {
  return typeof url === 'string' && /^https?:/i.test(url);
}

export async function readBank() {
  try {
    const { [PF_BANKED_KEY]: bank } = await chrome.storage.local.get(PF_BANKED_KEY);
    if (!bank || !Array.isArray(bank.items)) return null;
    return bank;
  } catch (_) { return null; }
}

export async function writeBank(bank) {
  try { await chrome.storage.local.set({ [PF_BANKED_KEY]: bank }); }
  catch (_) { /* best-effort */ }
}

export async function clearBank() {
  try { await chrome.storage.local.remove(PF_BANKED_KEY); }
  catch (_) { /* best-effort */ }
}

/** Milliseconds until this stash is purged; 0 once it has lapsed. */
export function bankMsRemaining(bank, now = Date.now()) {
  if (!bank?.createdAt) return 0;
  return Math.max(0, bank.createdAt + PF_BANK_TTL_MS - now);
}

/**
 * Drop the stash if it has outlived its TTL.
 * @returns {boolean} true when a purge actually happened.
 */
export async function purgeBankIfExpired(now = Date.now()) {
  const bank = await readBank();
  if (!bank) return false;
  if (bankMsRemaining(bank, now) > 0) return false;
  await clearBank();
  return true;
}

/**
 * Build stash records from live tabs. Pure so it can be unit-tested without
 * the chrome API: the caller does the closing.
 */
export function toBankRecords(tabs, now = Date.now()) {
  return (tabs || [])
    .filter((t) => isBankableUrl(t?.url))
    .map((t) => ({
      id: `${now}-${t.id}`,
      url: t.url,
      title: (t.title || t.url || '').slice(0, 300),
      favIconUrl: isBankableUrl(t.favIconUrl) ? t.favIconUrl : '',
      bankedAt: now
    }));
}
