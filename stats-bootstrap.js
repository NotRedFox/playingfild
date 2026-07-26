const pfDashBootGate = { fonts: false, ui: false, dismissed: false };

function pfTryDismissDashboardBootLoader() {
  if (pfDashBootGate.dismissed) return;
  if (!pfDashBootGate.fonts || !pfDashBootGate.ui) return;
  pfDashBootGate.dismissed = true;
  const root = document.documentElement;
  root.classList.remove('pf-dash-booting');
  root.classList.add('pf-dash-ready');
  const el = document.getElementById('pfDashBootLoader');
  if (el) {
    el.setAttribute('aria-busy', 'false');
    setTimeout(() => el.remove(), 280);
  }
}

globalThis.pfMarkDashboardFontsReady = function pfMarkDashboardFontsReady() {
  pfDashBootGate.fonts = true;
  pfTryDismissDashboardBootLoader();
};

globalThis.pfMarkDashboardUiReady = function pfMarkDashboardUiReady() {
  pfDashBootGate.ui = true;
  pfTryDismissDashboardBootLoader();
};

try {
  if (typeof pfBootstrapDashboardTheme === 'function') {
    pfBootstrapDashboardTheme();
  } else {
    pfMarkDashboardFontsReady();
  }
} catch (_) {
  document.documentElement.classList.add('fonts-ready');
  pfMarkDashboardFontsReady();
}

const pfIsFirstRunBoot = new URLSearchParams(window.location.search).get('firstrun') === 'true';
if (pfIsFirstRunBoot) {
  document.documentElement.classList.add('tutorial-preload');
}

function clearDashboardInteractionBlockers() {
  // FIRST-RUN (2026-07): do NOT strip the black preload here. This ran at
  // DOMContentLoaded — BEFORE stats.js had activated the tutorial overlay —
  // so the raw dashboard flashed for the gap between the two (user report:
  // "make the black screen load immediately, no flash of the dashboard").
  // stats.js clears tutorial-preload itself the moment the overlay is up,
  // and keeps its own hang safety-net.
  if (!pfIsFirstRunBoot) {
    document.documentElement.classList.remove('tutorial-preload');
  }
  const overlay = document.getElementById('tutorialOverlay');
  if (overlay && !overlay.classList.contains('active') && !pfIsFirstRunBoot) {
    overlay.classList.remove('revealed');
    overlay.style.clipPath = '';
    overlay.style.webkitClipPath = '';
  }
  if (!document.body?.classList.contains('tutorial-active')) {
    document.body.style.overflow = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  clearDashboardInteractionBlockers();
  if (!document.documentElement.classList.contains('fonts-loading')) {
    pfMarkDashboardFontsReady();
  }
  try {
    chrome.storage?.session?.get?.('tutorialActive', (session) => {
      if (session?.tutorialActive !== true && !pfIsFirstRunBoot) {
        document.body?.classList.remove('tutorial-active');
        document.getElementById('tutorialOverlay')?.classList.remove('active', 'revealed');
        document.body.style.overflow = '';
        document.documentElement.classList.remove('tutorial-preload');
      }
    });
  } catch (_) { /* non-extension context */ }
  window.setTimeout(clearDashboardInteractionBlockers, 3000);
  // First-run hard net: if the tutorial somehow never boots, don't leave a
  // black screen forever (stats.js has its own earlier safety too).
  if (pfIsFirstRunBoot) {
    window.setTimeout(() => {
      if (!document.getElementById('tutorialOverlay')?.classList.contains('active')) {
        document.documentElement.classList.remove('tutorial-preload');
      }
    }, 10000);
  }
}, { once: true });

// Safety net: if the fonts/ui gates never fire (a hung font promise or a thrown
// binding), force-dismiss the boot loader. 7s is past the 6s font backstop, so
// genuine font loading always wins and this only catches a true hang. Was 12s.
setTimeout(() => {
  pfDashBootGate.fonts = true;
  pfDashBootGate.ui = true;
  pfTryDismissDashboardBootLoader();
}, 7000);
