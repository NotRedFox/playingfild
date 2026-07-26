/**
 * Notebook theme font bootstrap — hide UI until Patrick Hand / Caveat are ready.
 */
(function initPfFontLoad(global) {
  const SESSION_KEY = 'pf_selectedTheme';
  const NOTEBOOK_FONT_SPECS = [
    "400 18px 'Patrick Hand'",
    "700 1em 'Caveat'",
    "400 1em 'Caveat'"
  ];

  let notebookFontPromise = null;

  function markFontsReady() {
    document.documentElement.classList.remove('fonts-loading');
    document.documentElement.classList.add('fonts-ready');
    if (typeof globalThis.pfMarkDashboardFontsReady === 'function') {
      globalThis.pfMarkDashboardFontsReady();
    }
  }

  function applyNotebookThemeClasses() {
    document.documentElement.classList.add('theme-notebook');
    if (document.body) {
      document.body.classList.add('theme-notebook');
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.classList.add('theme-notebook');
      }, { once: true });
    }
  }

  function clearNotebookThemeClasses() {
    document.documentElement.classList.remove('theme-notebook');
    document.body?.classList.remove('theme-notebook');
  }

  function waitForNotebookFonts() {
    if (!notebookFontPromise) {
      if (!document.fonts?.load) {
        notebookFontPromise = Promise.resolve();
      } else {
        notebookFontPromise = Promise.all(
          NOTEBOOK_FONT_SPECS.map((spec) => document.fonts.load(spec).catch(() => {}))
        ).then(() => document.fonts.ready).catch(() => {});
      }
    }
    return notebookFontPromise;
  }

  global.pfCacheSelectedTheme = function pfCacheSelectedTheme(themeId) {
    try {
      sessionStorage.setItem(SESSION_KEY, themeId || 'tutorial_background');
    } catch (_) { /* ignore */ }
  };

  global.pfEnsureNotebookFonts = function pfEnsureNotebookFonts() {
    document.documentElement.classList.add('fonts-loading');
    applyNotebookThemeClasses();
    // Wait for the real notebook fonts so they load alongside the UI (no
    // system-font flash). 6s backstop only fires if document.fonts.ready hangs
    // (blocked network / cold SW) so the UI is never permanently stuck.
    const safety = new Promise((resolve) => setTimeout(resolve, 6000));
    return Promise.race([waitForNotebookFonts(), safety]).finally(markFontsReady);
  };

  function applyThemeFromStorage(themeId) {
    global.pfCacheSelectedTheme(themeId);
    if (themeId === 'notebook') {
      void global.pfEnsureNotebookFonts();
      return;
    }
    clearNotebookThemeClasses();
    markFontsReady();
  }

  global.pfBootstrapDashboardTheme = function pfBootstrapDashboardTheme() {
    let cached = null;
    try {
      cached = sessionStorage.getItem(SESSION_KEY);
    } catch (_) { /* ignore */ }

    if (cached === 'notebook') {
      document.documentElement.classList.add('fonts-loading');
      applyNotebookThemeClasses();
      // Wait for the REAL notebook fonts (Patrick Hand / Caveat) so the dashboard
      // and its fonts become ready together — no system-font flash. We MUST call
      // markFontsReady when fonts finish (the old code did `void
      // waitForNotebookFonts()` and discarded the promise, so markFontsReady
      // never ran and the gray boot loader hung until the 12s fallback).
      // 6s backstop only covers a hung document.fonts.ready (blocked network) —
      // on normal/cached loads the real promise resolves much faster and wins.
      const safety = new Promise((resolve) => setTimeout(resolve, 6000));
      Promise.race([waitForNotebookFonts(), safety]).finally(markFontsReady);
    }

    try {
      chrome.storage?.local?.get?.('selectedTheme', (stored) => {
        const themeId = stored?.selectedTheme || 'tutorial_background';
        applyThemeFromStorage(themeId);
      });
    } catch (_) {
      applyThemeFromStorage('tutorial_background');
    }
  };
})(globalThis);
