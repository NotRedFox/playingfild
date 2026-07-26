import { capture as pfAnalyticsCapture } from './analytics.js';
import { matchExcludedHost } from './excluded_hosts.js';

try {
  chrome.runtime.sendMessage({ action: 'ping' }).catch(() => {});
} catch (_) { /* non-extension context */ }

// Apply the user's saved theme to the popup BEFORE rendering anything so the
// notebook (or any other) skin doesn't flash in over the default style. The
// pf-popup class scopes notebook.css's popup overrides; theme-notebook is
// the same class the dashboard uses. If the user has tutorial_background or
// no theme selected, the popup falls through to the default styles in
// popup.html's <style> block.
(async () => {
  try {
    const stored = await chrome.storage.local.get('selectedTheme');
    const themeId = stored.selectedTheme || 'tutorial_background';
    document.body.classList.add('pf-popup');
    document.documentElement.classList.add('pf-popup');
    if (themeId === 'notebook') {
      document.body.classList.add('theme-notebook');
      document.documentElement.classList.add('theme-notebook');
    }
  } catch (_) { /* no storage access — fall back to default */ }
})();

let shieldCountdownInterval = null;

function getDashboardUrl() {
  return chrome.runtime.getURL('stats.html');
}

// Returns a promise — callers MUST await it before window.close(), otherwise
// the popup context dies mid-chain and the tabs.create in the .then callback
// never runs (same class of race as the shield-persist fix below).
function openDashboardFast() {
  const dashboardUrl = getDashboardUrl();
  return chrome.tabs.query({ url: `${dashboardUrl}*` })
    .then((tabs) => {
      const matches = (tabs || []).filter((t) => String(t.url || '').includes('stats.html'));
      if (matches.length) {
        const keep = matches[matches.length - 1];
        if (keep.id != null) chrome.tabs.update(keep.id, { active: true }).catch(() => {});
        if (keep.windowId != null) chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
        return;
      }
      return chrome.tabs.create({ url: dashboardUrl, active: true }).catch(() => {});
    })
    .catch(() => {
      return chrome.runtime.sendMessage({ action: 'openDashboard' }).catch(() => {});
    });
}

function setShieldVisualState(state) {
  const shieldIcon = document.getElementById('topRightShield');
  if (!shieldIcon) return;
  shieldIcon.classList.remove('is-active', 'is-armed', 'is-idle');
  if (state) shieldIcon.classList.add(state);
}

function startShieldCountdownDisplay(expiryTime) {
  const shieldIcon = document.getElementById('topRightShield');
  const countdownEl = document.getElementById('shieldCountdown');
  if (!shieldIcon || !countdownEl) return;

  if (shieldCountdownInterval) {
    clearInterval(shieldCountdownInterval);
    shieldCountdownInterval = null;
  }

  setShieldVisualState('is-active');

  const tick = () => {
    const remaining = Math.max(0, expiryTime - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    countdownEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    if (remaining <= 0) {
      clearInterval(shieldCountdownInterval);
      shieldCountdownInterval = null;
      setShieldVisualState('is-idle');
      countdownEl.textContent = '';
    }
  };
  tick();
  shieldCountdownInterval = setInterval(tick, 1000);
}

function setTopRightShieldVisible(visible) {
  const wrapper = document.getElementById('topRightShieldWrapper');
  if (wrapper) wrapper.classList.toggle('is-visible', !!visible);
}

function updateTopRightShieldArmedState(selectedDuration, shieldActive) {
  const topRightShield = document.getElementById('topRightShield');
  if (!topRightShield || shieldActive) return;
  setShieldVisualState(selectedDuration ? 'is-armed' : 'is-idle');
  if (selectedDuration) {
    topRightShield.title = `Click shield to keep this tab in place (${selectedDuration} min)`;
  } else {
    topRightShield.title = 'Select a duration in Advanced Settings first';
  }
}

async function persistTabLockRecord(tab, minutes, expiryTime) {
  const tabLocks = (await chrome.storage.local.get(['tabLocks'])).tabLocks || {};
  tabLocks[tab.id] = {
    tabId: tab.id,
    originalIndex: tab.index,
    startTime: Date.now(),
    endTime: expiryTime,
    duration: minutes
  };
  await chrome.storage.local.set({ tabLocks });
}

function displayShields(shields) {
  const shieldDropdown = document.getElementById('shieldDropdown');
  const shieldList = document.getElementById('shieldList');
  if (!shieldDropdown || !shieldList) return;

  while (shieldList.firstChild) {
    shieldList.removeChild(shieldList.firstChild);
  }

  const now = Date.now();
  const activeShields = shields.filter((shield) => shield.endTime > now);

  if (activeShields.length > 0) {
    shieldDropdown.style.display = 'block';
    const fragment = document.createDocumentFragment();

    activeShields.forEach((shield) => {
      const remainingTime = Math.ceil((shield.endTime - now) / 60000);
      const shieldItem = document.createElement('div');
      shieldItem.className = 'shield-item';

      const leftDiv = document.createElement('div');
      const iconSpan = document.createElement('span');
      iconSpan.className = 'shield-icon';
      iconSpan.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'shield-time';
      timeSpan.textContent = `${remainingTime} min`;

      leftDiv.appendChild(iconSpan);
      leftDiv.appendChild(timeSpan);

      const urlSpan = document.createElement('span');
      urlSpan.className = 'shield-url';
      try {
        urlSpan.textContent = new URL(shield.url).hostname;
      } catch (_) {
        urlSpan.textContent = shield.url || '';
      }
      urlSpan.title = shield.url;

      shieldItem.appendChild(leftDiv);
      shieldItem.appendChild(urlSpan);
      fragment.appendChild(shieldItem);
    });

    shieldList.appendChild(fragment);
  } else {
    shieldDropdown.style.display = 'none';
  }
}

async function enrichPopupAsync() {
  let currentTab = null;
  try {
    // Phase 1 — paint from LOCAL/SESSION data immediately (no service-worker
    // round-trips). This is what makes the dropdown feel instant: shields list
    // and the classification badge show as soon as cheap storage reads resolve.
    const [localResult, sessionResult, tabs] = await Promise.all([
      chrome.storage.local.get(['selectedPauseDuration']),
      chrome.storage.session.get(['tabShields']),
      chrome.tabs.query({ active: true, currentWindow: true })
    ]);

    const tabShields = Array.isArray(sessionResult.tabShields) ? sessionResult.tabShields : [];
    const selectedDuration = localResult.selectedPauseDuration;
    currentTab = tabs?.[0];

    // Per user spec 2026-07: brave://extensions/, chrome://, chrome-
    // extension://foo/, edge://, about: pages, PDFs, etc. can't be
    // analyzed (content scripts don't run there). Surface a short notice
    // so the user knows why the floating button never appeared, and
    // that the tab still counts toward the tab limit.
    try {
      const notice = document.getElementById('pfPopupUnanalyzable');
      if (notice && currentTab?.url) {
        const url = String(currentTab.url).toLowerCase();
        const isInternal = /^(chrome|brave|edge|opera|vivaldi|about|view-source|devtools|chrome-extension|moz-extension|brave-extension|safari-web-extension|file):/.test(url);
        // Chrome hard-blocks content-script injection on the Web Store (and
        // its developer console) even though it's a normal https:// page, so
        // the floating indicator never appears there — surface the notice
        // instead. User report 2026-07 v38: "im still not seeing the this
        // site cant be classified thing in the drop down thing where it
        // should be" on chrome.google.com/webstore/devconsole/...
        const isWebStore = /^https:\/\/chrome\.google\.com\/webstore\//.test(url)
          || /^https:\/\/chromewebstore\.google\.com\//.test(url);
        // Newtab pages are technically internal but the user thinks of them
        // as "empty" tabs, not un-analyzable, so skip the notice there.
        const isNewTab = /^(chrome|brave|edge):\/\/newtab\/?$|^(chrome|brave|edge):\/\/new-tab-page\/?$|^about:newtab$/.test(url);
        // Extension's own pages (dashboard/signin) are fine.
        const isOurExtension = url.startsWith(chrome.runtime.getURL(''));
        notice.style.display = ((isInternal || isWebStore) && !isNewTab && !isOurExtension) ? 'block' : 'none';
      }
    } catch (_) { /* best-effort */ }
    // Privacy-blocked hint (user spec 2026-07 v18): a real http/https
    // site that lives in the excluded_hosts list (banking, gmail,
    // health, AI tools, etc.) never gets classified because the
    // content script intentionally doesn't read the page. The old
    // floating disclaimer above the pill is being retired — surface
    // the reason HERE in the popup, but only if this site isn't
    // already covered by the "can't be analyzed" notice above.
    try {
      const privacyNotice = document.getElementById('pfPopupPrivacyBlocked');
      const upperNotice = document.getElementById('pfPopupUnanalyzable');
      if (privacyNotice && currentTab?.url) {
        const upperShown = upperNotice?.style.display === 'block';
        const url = String(currentTab.url);
        const isHttp = /^https?:/i.test(url);
        const isExcluded = isHttp ? !!matchExcludedHost(url) : false;
        privacyNotice.style.display = (isExcluded && !upperShown) ? 'block' : 'none';
      }
    } catch (_) { /* best-effort */ }

    if (tabShields.length > 0) {
      displayShields(tabShields);
    }

    // Phase 2 — service-worker round-trips (shield status + window config).
    // These can be slow on a cold worker, so run them AFTER local paint. If
    // they fail or lag, the popup is already fully usable.
    if (currentTab) {
      deferShieldStateLoad(currentTab, selectedDuration);
    }
  } catch (_) {
    /* popup enrichment is best-effort */
  }
}

// Loads the shield armed/active state via two SW message round-trips, kept off
// the critical paint path. Wrapped so any failure just leaves the shield hidden
// rather than throwing out of the popup init.
function deferShieldStateLoad(currentTab, selectedDuration) {
  Promise.all([
    chrome.runtime.sendMessage({ action: 'getShieldStatus', tabId: currentTab.id }).catch(() => null),
    currentTab.windowId != null
      ? chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: currentTab.windowId }).catch(() => null)
      : Promise.resolve(null)
  ]).then(([shieldResponse, configResponse]) => {
    const pauseEnabled = configResponse?.config?.pauseActive === true;
    let shieldActive = false;
    if (shieldResponse?.shieldActive && shieldResponse.expiryTime > Date.now()) {
      shieldActive = true;
      startShieldCountdownDisplay(shieldResponse.expiryTime);
    }
    const showShield = pauseEnabled || shieldActive;
    setTopRightShieldVisible(showShield);
    if (showShield) {
      updateTopRightShieldArmedState(selectedDuration, shieldActive);
    }
  }).catch(() => { /* shield state is best-effort */ });
}

function initPopup() {
  // Kick off local-data paint immediately (don't wait a frame) so the shields
  // appear as fast as possible. The SW round-trips inside are deferred and
  // won't block this.
  void enrichPopupAsync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}

const topRightShieldEl = document.getElementById('topRightShield');
if (topRightShieldEl) {
  topRightShieldEl.onclick = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs[0];
    if (!currentTab) return;

    const configResponse = currentTab.windowId != null
      ? await chrome.runtime.sendMessage({ action: 'getWindowConfig', windowId: currentTab.windowId }).catch(() => null)
      : null;
    if (configResponse?.config?.pauseActive !== true) {
      return;
    }

    const existing = await chrome.runtime.sendMessage({
      action: 'getShieldStatus',
      tabId: currentTab.id
    }).catch(() => null);

    if (existing?.shieldActive && existing.expiryTime > Date.now()) {
      window.close();
      return;
    }

    const stored = await chrome.storage.local.get(['selectedPauseDuration']);
    const minutes = stored.selectedPauseDuration;
    if (!minutes) return;

    const sessionExisting = await chrome.storage.session.get(['activeShieldTabId']);
    if (sessionExisting.activeShieldTabId && sessionExisting.activeShieldTabId !== currentTab.id) {
      chrome.runtime.sendMessage({ action: 'removeActiveShield', tabId: sessionExisting.activeShieldTabId });
    }

    const expiryTime = Date.now() + (minutes * 60000);
    // MUST await the full persistence chain BEFORE window.close() — closing
    // the popup destroys this JS context, so a sendMessage callback would
    // never run and the session/tabLocks writes would be silently dropped.
    try {
      const r = await chrome.runtime.sendMessage({
        action: 'updateActiveShield',
        tabId: currentTab.id,
        shield: { endTime: expiryTime, durationMinutes: minutes }
      }).catch(() => null);
      if (r?.success) {
        void pfAnalyticsCapture('shield_activated', { duration_min: minutes }).catch(() => {});
        await chrome.storage.session.set({ activeShieldTabId: currentTab.id });
        await persistTabLockRecord(currentTab, minutes, expiryTime);
      }
    } catch (_) { /* best-effort — never trap the popup open */ }
    window.close();
  };
}

// Null-guarded: an unguarded `.onclick =` on a missing element throws at
// module top level and kills EVERY handler below it — the whole popup dies.
const openDashboardBtn = document.getElementById('openDashboard');
if (openDashboardBtn) {
  openDashboardBtn.onclick = async () => {
    try { await openDashboardFast(); } catch (_) { /* best-effort */ }
    window.close();
  };
}

