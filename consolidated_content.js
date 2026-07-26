// >=PlayingFild Consolidated Content Script
// All functionality in one file - tracking + analysis

(async function bootstrapPfContentScript() {
  'use strict';

  // Bump when listener wiring changes so extension update re-inits once (with cleanup).
  const PF_CONTENT_SCRIPT_BUILD = '1.7.14';
  const root = globalThis;

  // BOT SHADOW-BAN signal (2026-07): automation environments are flagged
  // once, sticky, and silently excluded from the global dataset (analytics
  // + classifier feedback). Everything keeps working locally for them.
  try {
    if (navigator.webdriver === true || /HeadlessChrome|PhantomJS/i.test(navigator.userAgent || '')) {
      chrome.runtime.sendMessage({ action: 'pfFlagBotSuspect' }).catch?.(() => {});
    }
  } catch (_) { /* best-effort */ }

  function cleanupPfContentScript() {
    const pkg = root.__pfContentScript;
    if (!pkg) return;

    try {
      pkg.abortController?.abort();
    } catch (_) {}

    try {
      pkg.engagementTrackingController?.abort();
    } catch (_) {}

    try {
      pkg.urlObserver?.disconnect();
    } catch (_) {}

    try {
      pkg.hydrateObserver?.disconnect();
    } catch (_) {}

    // Remove the runtime message listener — AbortController can't detach
    // chrome.runtime listeners, and a stale one would pin this whole closure
    // (including cached page text) AND answer pfGetCachedPageBody with stale
    // data after a re-init.
    if (pkg.onRuntimeMessage) {
      try { chrome.runtime.onMessage.removeListener(pkg.onRuntimeMessage); } catch (_) {}
      pkg.onRuntimeMessage = null;
    }

    if (pkg.hydrateDebounce != null) {
      clearTimeout(pkg.hydrateDebounce);
      pkg.hydrateDebounce = null;
    }

    if (pkg.messageTimer != null) {
      clearTimeout(pkg.messageTimer);
      pkg.messageTimer = null;
    }

    if (pkg.urlDebounceTimer != null) {
      clearTimeout(pkg.urlDebounceTimer);
      pkg.urlDebounceTimer = null;
    }

    for (const id of pkg.timers || []) clearTimeout(id);
    for (const id of pkg.intervals || []) clearInterval(id);

    root.__pfContentScript = null;
    root.__pfContentScriptLoaded = false;
  }

  root.__pfContentScriptCleanup = cleanupPfContentScript;

  const PF_PRIVACY_GUARD_POLL_MS = 50;
  const PF_PRIVACY_GUARD_MAX_ATTEMPTS = 10;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Fail-closed: wait briefly for privacy_gate.js on fast navigations, then decide.
  async function pfShouldSkipContentScript() {
    for (let attempt = 0; attempt < PF_PRIVACY_GUARD_MAX_ATTEMPTS; attempt++) {
      try {
        if (typeof root.__pfComputeSensitivePageActive === 'function') {
          return root.__pfComputeSensitivePageActive() === true;
        }
        if (root.__pfSensitivePageActive === true) return true;
        if (root.__pfSensitivePageActive === false) return false;
      } catch (_) {
        return true;
      }
      if (attempt < PF_PRIVACY_GUARD_MAX_ATTEMPTS - 1) {
        await sleep(PF_PRIVACY_GUARD_POLL_MS);
      }
    }
    console.warn('[pf-privacy] content script guard missing after retry — fail-closed skip');
    return true;
  }

  if (await pfShouldSkipContentScript()) {
    root.__pfSensitivePageActive = true;
    console.info('[pf-privacy] content script skipped — sensitive/excluded site');
    // WPM-only escape hatch (user report 2026-07 v43: "make the WPM thing
    // actually track more sites since its locally on their thing not sent").
    // The sensitive-page bail above kills the WHOLE content script —
    // engagement tracking, page scraping, AND WPM. But WPM tracking is pure
    // keystroke COUNTS (never key values, never content) sent only to the
    // local worker's typing-speed pipeline (zero network, zero sync —
    // confirmed by grep). It already skips password/CC fields via
    // isSensitiveInputTarget. So it is safe to run on every http(s) page,
    // including banking/webmail/AI sites that the engagement gate excludes.
    // Attach it here, BEFORE the early-return, so typing speed is captured
    // everywhere. The auth-path and payment-path exclusions inside
    // shouldTrackTypingCountsOnly still apply (don't count keys on a login
    // or checkout form even for WPM).
    try {
      if (typeof shouldTrackTypingCountsOnly === 'function'
          && shouldTrackTypingCountsOnly()
          && typeof attachWpmOnlyTracking === 'function') {
        attachWpmOnlyTracking();
      }
    } catch (_) { /* best-effort — don't let WPM break the bail */ }
    return;
  }

  if (root.__pfSensitivePageDetector?.init) {
    await root.__pfSensitivePageDetector.init();
  } else {
    console.error('[pf-sensitive-detector] missing — sensitive_page_detector.js did not load before consolidated_content.js');
  }

  function normalizePageHostname(raw) {
    return String(raw || '').replace(/^www\./, '').toLowerCase();
  }

  function isKnownAiHostFallback() {
    const host = normalizePageHostname(window.location.hostname);
    const AI_HOSTS = [
      'kimi.com', 'kimi.ai', 'moonshot.cn', 'moonshot.ai',
      'chatgpt.com', 'chat.openai.com', 'claude.ai', 'openai.com',
      'gemini.google.com', 'copilot.microsoft.com', 'poe.com',
      'character.ai', 'perplexity.ai', 'deepseek.com', 'mistral.ai',
      'slack.com', 'discord.com', 'teams.microsoft.com'
    ];
    return AI_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  }

  function getSensitivePageState() {
    try {
      const fromDetector = root.__pfSensitivePageDetector?.getEffectiveState?.();
      if (fromDetector?.wouldSkip) return fromDetector;
      if (isKnownAiHostFallback()) {
        return {
          wouldSkip: true,
          category: 'ai_chat',
          reason: 'ai-host-fallback',
          score: 100,
          hostnameNormalized: normalizePageHostname(window.location.hostname)
        };
      }
      return fromDetector || null;
    } catch (_) {
      if (isKnownAiHostFallback()) {
        return { wouldSkip: true, category: 'ai_chat', reason: 'ai-host-fallback', score: 100 };
      }
      return null;
    }
  }

  function isSensitivePageTrackingBlocked() {
    try {
      const state = getSensitivePageState();
      return state?.wouldSkip === true;
    } catch (_) {
      return isKnownAiHostFallback();
    }
  }

  function logSensitiveGate(phase) {
    const state = getSensitivePageState();
    const blocked = isSensitivePageTrackingBlocked();
    if (!PF_DEBUG) return blocked;
    console.info('[pf-sensitive-gate]', phase, {
      blocked,
      detectorLoaded: !!root.__pfSensitivePageDetector,
      hostname: window.location.hostname,
      hostnameNormalized: normalizePageHostname(window.location.hostname),
      wouldSkip: state?.wouldSkip,
      category: state?.category,
      reason: state?.reason,
      score: state?.score
    });
    return blocked;
  }

  function shouldDeferScrapeForSensitiveDetector() {
    if (isSensitivePageTrackingBlocked()) return false;
    try {
      const host = normalizePageHostname(window.location.hostname);
      const path = (window.location.pathname || '').toLowerCase();
      const aiHost = /kimi|moonshot|qwen|openai|claude|chatgpt|gemini|copilot|slack|discord|teams/i.test(host);
      const chatPath = /\/chat|\/c\/|\/conversation/.test(path);
      if (!aiHost && !chatPath) return false;
      // Wait for the detector latch on AI-looking hosts, but CAPPED. The old
      // unconditional `return true` meant any hostname merely CONTAINING one
      // of the regex substrings (e.g. teams.live.com) that never latched as
      // sensitive would re-schedule the analyze pass every 600ms forever —
      // a permanent CPU drain. 20 waits (~12s) is plenty for a real AI chat
      // UI to hydrate and latch.
      if (aiHost) return (contentState.sensitiveRecheckWaits || 0) < 20;
      const evaluate = root.__pfSensitivePageDetector?.evaluate;
      if (!evaluate) return (contentState.sensitiveRecheckWaits || 0) < 8;
      const state = evaluate();
      if (state?.wouldSkip) return false;
      return (contentState.sensitiveRecheckWaits || 0) < 8;
    } catch (_) {
      return false;
    }
  }

  function teardownEngagementIfSensitive() {
    if (!isSensitivePageTrackingBlocked()) return;
    try {
      root.__pfContentScript?.teardownEngagementTracking?.();
    } catch (_) { /* ignore */ }
  }

  // NOTE: the 'pf-sensitive-page-latched' listener is registered further down,
  // AFTER the buildId check and lifecycle creation, and bound to the abort
  // signal. Registering it here (pre-check) added a duplicate on every re-run
  // and — in the same-buildId early-return case — left a listener whose
  // closure referenced consts (signal, contentState) that were never
  // initialized, throwing a TDZ ReferenceError when the event fired.

  if (root.__pfContentScript?.buildId === PF_CONTENT_SCRIPT_BUILD) {
    return;
  }

  cleanupPfContentScript();

  const abortController = new AbortController();
  const signal = abortController.signal;
  const timers = new Set();
  const intervals = new Set();

  const lifecycle = {
    buildId: PF_CONTENT_SCRIPT_BUILD,
    abortController,
    urlObserver: null,
    hydrateObserver: null,
    hydrateDebounce: null,
    messageTimer: null,
    urlDebounceTimer: null,
    onRuntimeMessage: null,
    timers,
    intervals,
    cleanup: cleanupPfContentScript
  };

  root.__pfContentScript = lifecycle;
  root.__pfContentScriptLoaded = true;

  function trackTimeout(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (signal.aborted) return;
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function trackInterval(fn, ms) {
    const id = setInterval(() => {
      if (signal.aborted) return;
      fn();
    }, ms);
    intervals.add(id);
    return id;
  }

  window.addEventListener('pagehide', cleanupPfContentScript, { once: true, signal });

  root.addEventListener('pf-sensitive-page-latched', () => {
    teardownEngagementIfSensitive();
    runAnalyzeWhenReady({ force: true });
  }, { signal });

  // Cross-world takeover: after an extension reload, re-injected copies run
  // in a NEW isolated world — the buildId guard above can't see the old
  // copy's globals, but DOM events cross worlds. Announce ourselves so any
  // previous (orphaned) copy runs its cleanup instead of leaving observers
  // and timers churning forever.
  const PF_CC_TAKEOVER_TOKEN = `${Date.now()}-${Math.random()}`;
  document.addEventListener('pf-content-script-takeover', (e) => {
    if (e?.detail === PF_CC_TAKEOVER_TOKEN) return;
    cleanupPfContentScript();
  }, { signal });
  try {
    document.dispatchEvent(new CustomEvent('pf-content-script-takeover', { detail: PF_CC_TAKEOVER_TOKEN }));
  } catch (_) {}

  const PF_DEBUG = false;
  const PF_EXTRACT_DIAG = false; // DOM timing diagnostics (dev only — noisy on every scrape)
  const PF_MAX_BODY_CHARS = 20000;
  const PF_BODY_LOCK_THRESHOLD = 500;
  const PF_MUTATION_DEBOUNCE_MS = 500;
  const PF_SPA_MUTATION_DEBOUNCE_MS = 800;
  const PF_HYDRATION_MIN_TEXT = 80;
  const PF_HYDRATION_MAX_WAITS = 18;
  const PF_HYDRATION_POLL_MS = 1000;
  const PF_SPA_HYDRATE_OBSERVER_MS = 180000;
  const PF_ROLE_CONTAINER_SELECTORS = [
    '[role="main"]',
    '[role="article"]',
    '[role="feed"]',
    '[role="log"]',
    '[role="region"][aria-label*="chat" i]',
    '[role="region"][aria-label*="conversation" i]',
    '[aria-label*="conversation" i]',
    '[aria-label*="chat history" i]',
    '.message-content',
    '.markdown',
    '.prose',
    '[class*="message-content" i]',
    '[class*="conversation" i]',
    '[class*="chat-history" i]',
    '[data-testid*="conversation" i]',
    '[data-testid*="message" i]'
  ];
  const PF_FORBIDDEN_ANCESTOR = 'input, textarea, select, option, form, fieldset, [contenteditable], [role="textbox"], [role="searchbox"], [type="password"], [type="email"], [type="tel"], [type="search"], [autocomplete], [name="email"], [name="username"], script, style, noscript';
  const PF_SKIP_CHROME_ANCESTOR = 'nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], [hidden]';

  let hasCapturedValidContent = false;
  let lastKnownGoodScrape = '';
  let lastKnownGoodScrapeUrl = '';

  const contentState = {
    messageQueue: [],
    lastUrl: window.location.href,
    lastSentBodyLen: 0,
    bestBodyText: '',
    bestBodyLen: 0,
    bodyLocked: false,
    capturedHostname: '',
    capturedTabId: null,
    hydrationWaits: 0,
    hydrationGiveUp: false,
    sensitiveRecheckWaits: 0
  };

  function isSpaHeavyHost() {
    const host = getPageHostname(window.location.href);
    const spaHosts = [
      'gemini.google.com',
      'chatgpt.com',
      'chat.openai.com',
      'claude.ai',
      'copilot.microsoft.com',
      'poe.com',
      'perplexity.ai'
    ];
    return spaHosts.some((h) => host === h || host.endsWith('.' + h));
  }

  function getMutationDebounceMs() {
    return isSpaHeavyHost() ? PF_SPA_MUTATION_DEBOUNCE_MS : PF_MUTATION_DEBOUNCE_MS;
  }

  function elementVisibleText(el) {
    if (!el) return '';
    return normalizeWhitespace(el.innerText || el.textContent || '');
  }

  function hasRequiredContentShell() {
    const article = document.querySelector('article');
    const contentBody = document.querySelector('.content-body');
    if (article && article.childElementCount > 0) return true;
    if (contentBody && contentBody.childElementCount > 0) return true;
    if (!article && !contentBody) return true;
    return false;
  }

  function isDomLikelyHydrated() {
    if (!document.body) return false;
    if (!hasRequiredContentShell()) return false;
    const quickProbe = Math.max(
      elementVisibleText(document.querySelector('[role="main"]')).length,
      elementVisibleText(document.querySelector('main')).length,
      elementVisibleText(document.querySelector('article')).length,
      elementVisibleText(document.querySelector('.content-body')).length,
      normalizeWhitespace(document.body.innerText || '').length
    );
    return quickProbe >= PF_HYDRATION_MIN_TEXT;
  }

  function getPageHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  contentState.capturedHostname = getPageHostname(window.location.href);

  function onBodyLocked() {
    if (!contentState.bodyLocked) return;
    // Keep hydrate observer alive so we can refresh lastKnownGoodScrape on DOM churn.
  }

  function syncScrapeCacheToSession() {
    const tabId = contentState.capturedTabId;
    if (tabId == null || lastKnownGoodScrape.length < PF_HYDRATION_MIN_TEXT) return;
    const key = `pfLastScrape_${tabId}`;
    chrome.storage.session.set({
      [key]: {
        body: lastKnownGoodScrape.slice(0, PF_MAX_BODY_CHARS),
        url: window.location.href,
        cachedChars: lastKnownGoodScrape.length,
        ts: Date.now()
      }
    }).catch(() => {});
  }

  function clearScrapeCacheFromSession() {
    const tabId = contentState.capturedTabId;
    if (tabId == null) return;
    chrome.storage.session.remove(`pfLastScrape_${tabId}`).catch(() => {});
  }

  function resetExtractionStateForUrlChange(fromUrl, toUrl) {
    if (PF_DEBUG) console.info('[pf-extract-reset]', { from: fromUrl, to: toUrl });
    hasCapturedValidContent = false;
    lastKnownGoodScrape = '';
    lastKnownGoodScrapeUrl = '';
    clearScrapeCacheFromSession();
    contentState.bestBodyText = '';
    contentState.bestBodyLen = 0;
    contentState.lastSentBodyLen = 0;
    contentState.bodyLocked = false;
    contentState.hydrationWaits = 0;
    contentState.hydrationGiveUp = false;
    contentState.sensitiveRecheckWaits = 0;
    contentState.lastUrl = toUrl;
    contentState.capturedHostname = getPageHostname(toUrl);
    try {
      lifecycle.hydrateObserver?.disconnect();
    } catch (_) {}
    lifecycle.hydrateObserver = null;
    resetHydrationExtractionBudget();
    if (document.body) startContentHydrationWatcher();
  }

  function storeLastKnownGoodScrape(text) {
    const normalized = String(text || '');
    if (normalized.length <= contentState.bestBodyLen) return;
    lastKnownGoodScrape = normalized;
    lastKnownGoodScrapeUrl = window.location.href;
    contentState.bestBodyText = normalized;
    contentState.bestBodyLen = normalized.length;
    syncScrapeCacheToSession();
    if (contentState.bestBodyLen >= PF_BODY_LOCK_THRESHOLD) {
      hasCapturedValidContent = true;
      contentState.bodyLocked = true;
      onBodyLocked();
    }
  }

  function getBodyForAnalysis() {
    if (isSensitivePageTrackingBlocked()) {
      return '';
    }

    const currentUrl = window.location.href;
    if (lastKnownGoodScrape && lastKnownGoodScrapeUrl && lastKnownGoodScrapeUrl !== currentUrl) {
      lastKnownGoodScrape = '';
      lastKnownGoodScrapeUrl = '';
      contentState.bestBodyText = '';
      contentState.bestBodyLen = 0;
    }

    const fresh = extractSafePageText();
    const freshLen = fresh.length;

    if (freshLen > contentState.bestBodyLen) {
      storeLastKnownGoodScrape(fresh);
      return lastKnownGoodScrape;
    }

    if (freshLen === 0 && lastKnownGoodScrape && lastKnownGoodScrapeUrl === currentUrl) {
      if (PF_DEBUG) console.info('[pf-extract-debug] using cached content', {
        cachedChars: lastKnownGoodScrape.length,
        freshChars: 0,
        url: currentUrl
      });
      return lastKnownGoodScrape;
    }

    if (freshLen > 0 && freshLen <= contentState.bestBodyLen && lastKnownGoodScrape &&
        lastKnownGoodScrapeUrl === currentUrl) {
      return lastKnownGoodScrape;
    }

    if (lastKnownGoodScrape && lastKnownGoodScrapeUrl === currentUrl) return lastKnownGoodScrape;
    return fresh;
  }

  function resetCapturedBodyForNavigation(url, tabId = contentState.capturedTabId) {
    const tabChanged = Boolean(
      tabId != null &&
      contentState.capturedTabId != null &&
      tabId !== contentState.capturedTabId
    );
    const urlChanged = url !== contentState.lastUrl;

    if (!urlChanged && !tabChanged) return false;

    const fromUrl = contentState.lastUrl;
    if (tabId != null) contentState.capturedTabId = tabId;
    resetExtractionStateForUrlChange(fromUrl, url);
    document.getElementById('pf-feedback-host')?.remove();
    return true;
  }

  function normalizeWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function logExtractDiagnostics(phase) {
    if (!PF_EXTRACT_DIAG) return;
    const body = document.body;
    const articleEl = document.querySelector('article');
    const mainEl = document.querySelector('main');
    const roleMainEl = document.querySelector('[role="main"]');
    const contentBodyEl = document.querySelector('.content-body');
    console.info('[pf-extract-dom]', phase, {
      domain: document.domain,
      readyState: document.readyState,
      bodyChildCount: body ? body.childElementCount : -1,
      articlePresent: Boolean(articleEl),
      articleChildCount: articleEl ? articleEl.childElementCount : -1,
      contentBodyPresent: Boolean(contentBodyEl),
      contentBodyChildCount: contentBodyEl ? contentBodyEl.childElementCount : -1,
      mainPresent: Boolean(mainEl),
      roleMainPresent: Boolean(roleMainEl),
      articleChars: elementVisibleText(articleEl).length,
      mainChars: elementVisibleText(mainEl).length,
      roleMainChars: elementVisibleText(roleMainEl).length,
      roleContainerChars: extractFromRoleContainers().length,
      lastKnownGoodChars: lastKnownGoodScrape.length,
      pTagCount: document.querySelectorAll('p').length,
      contentShellReady: hasRequiredContentShell(),
      hydrated: isDomLikelyHydrated()
    });
  }

  function isForbiddenTextNode(node) {
    const parent = node?.parentElement;
    if (!parent) return true;
    try {
      if (parent.closest(PF_FORBIDDEN_ANCESTOR)) return true;
      if (parent.closest(PF_SKIP_CHROME_ANCESTOR)) return true;
      return false;
    } catch (_) {
      return true;
    }
  }

  function collectVisibleTextFromRoot(rootNode, maxChars = PF_MAX_BODY_CHARS) {
    const parts = [];
    let total = 0;

    function walk(node) {
      if (!node || total >= maxChars) return;

      if (node.nodeType === Node.TEXT_NODE) {
        if (isForbiddenTextNode(node)) return;
        const t = normalizeWhitespace(node.textContent);
        if (!t) return;
        parts.push(t);
        total += t.length;
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName?.toUpperCase?.() || '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (el.matches?.(PF_FORBIDDEN_ANCESTOR)) return;
      if (el.closest?.(PF_SKIP_CHROME_ANCESTOR)) return;

      if (el.shadowRoot) walk(el.shadowRoot);

      for (const child of el.childNodes) {
        walk(child);
        if (total >= maxChars) break;
      }
    }

    walk(rootNode);
    return normalizeWhitespace(parts.join(' ')).slice(0, maxChars);
  }

  function extractFromSemanticRegions() {
    const regionSelectors = [
      'article',
      'main',
      '[role="main"]',
      '[itemprop="articleBody"]',
      '.article-body',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.content-body',
      '#content',
      '.content'
    ];

    for (const sel of regionSelectors) {
      const el = document.querySelector(sel);
      if (!el || el.closest(PF_FORBIDDEN_ANCESTOR) || el.closest(PF_SKIP_CHROME_ANCESTOR)) continue;
      const text = normalizeWhitespace(el.innerText || el.textContent || '');
      if (text.length >= 400) return text.slice(0, PF_MAX_BODY_CHARS);
    }
    return '';
  }

  function extractArticleOrMainText() {
    let best = '';
    for (const sel of ['article', 'main']) {
      const el = document.querySelector(sel);
      if (!el || el.closest(PF_FORBIDDEN_ANCESTOR) || el.closest(PF_SKIP_CHROME_ANCESTOR)) continue;
      const text = normalizeWhitespace(el.innerText || el.textContent || '');
      if (text.length > best.length) best = text;
    }
    return best;
  }

  function extractFromRoleContainers() {
    const parts = [];
    const seen = new Set();

    for (const sel of PF_ROLE_CONTAINER_SELECTORS) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of nodes) {
        if (!el || seen.has(el)) continue;
        if (el.closest(PF_FORBIDDEN_ANCESTOR)) continue;
        const text = elementVisibleText(el);
        if (text.length < 40) continue;
        seen.add(el);
        parts.push(text);
      }
    }

    return normalizeWhitespace(parts.join(' ')).slice(0, PF_MAX_BODY_CHARS);
  }

  function extractFromAllParagraphs() {
    const parts = [];
    for (const p of document.querySelectorAll('p')) {
      if (p.closest(PF_FORBIDDEN_ANCESTOR)) continue;
      if (p.closest(PF_SKIP_CHROME_ANCESTOR)) continue;
      const text = normalizeWhitespace(p.innerText || p.textContent || '');
      if (text) parts.push(text);
    }
    return normalizeWhitespace(parts.join(' ')).slice(0, PF_MAX_BODY_CHARS);
  }

  function extractFromDirectTextNodes() {
    const SAFE_SELECTORS = [
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'article', 'main', 'section',
      'span:not([role="textbox"])',
      'div[role="article"]',
      'li', 'td', 'th',
      'blockquote', 'caption'
    ].join(',');

    const collected = [];
    for (const el of document.querySelectorAll(SAFE_SELECTORS)) {
      if (el.closest(PF_FORBIDDEN_ANCESTOR)) continue;
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => normalizeWhitespace(n.textContent))
        .filter(Boolean)
        .join(' ');
      if (text) collected.push(text);
    }
    return normalizeWhitespace(collected.join(' ')).slice(0, PF_MAX_BODY_CHARS);
  }

  function extractSafePageText() {
    if (logSensitiveGate('extractSafePageText')) {
      return '';
    }

    logExtractDiagnostics('scrape');

    const articleMain = extractArticleOrMainText();
    if (articleMain.length >= 400) {
      return articleMain.slice(0, PF_MAX_BODY_CHARS);
    }

    const roleContainers = extractFromRoleContainers();
    if (roleContainers.length >= 200) {
      return roleContainers;
    }

    const semantic = extractFromSemanticRegions();
    if (semantic.length >= 400) return semantic;

    const deep = document.body ? collectVisibleTextFromRoot(document.body) : '';
    const legacy = extractFromDirectTextNodes();
    const paragraphFallback = extractFromAllParagraphs();

    if (articleMain.length < 80 && roleContainers.length >= 120) {
      if (PF_EXTRACT_DIAG) {
        console.info('[pf-extract-dom] role-container fallback', {
          roleContainerChars: roleContainers.length,
          articleMainChars: articleMain.length
        });
      }
      return roleContainers;
    }

    // Emergency fallback: article/main missing or still empty after SPA hydration.
    if (articleMain.length < 80 && paragraphFallback.length >= 200) {
      if (PF_EXTRACT_DIAG) {
        console.info('[pf-extract-dom] emergency paragraph fallback', {
          paragraphChars: paragraphFallback.length,
          articleMainChars: articleMain.length
        });
      }
      return paragraphFallback;
    }

    const best = [articleMain, roleContainers, semantic, deep, legacy, paragraphFallback]
      .sort((a, b) => b.length - a.length)[0] || '';
    return best.slice(0, PF_MAX_BODY_CHARS);
  }

  function getMetaDescription() {
    const meta = document.querySelector('meta[name="description"]')
      || document.querySelector('meta[property="og:description"]');
    return meta ? meta.getAttribute('content') || '' : '';
  }

  function sendAnalyzePayload() {
    if (signal.aborted) return;

    root.__pfSensitivePageDetector?.runRecheck?.();

    if (logSensitiveGate('sendAnalyzePayload')) {
      const sensitiveState = getSensitivePageState();
      const url = window.location.href;
      const title = document.title;
      const description = getMetaDescription();
      let h1Text = '';
      try {
        h1Text = Array.from(document.querySelectorAll('h1'))
          .map((h) => h.innerText || h.textContent || '')
          .join(' ')
          .slice(0, 500);
      } catch (_) { h1Text = ''; }

      if (PF_DEBUG) console.info('[pf-sensitive] hostname-only analyzePage (content scrape gated)', sensitiveState);

      chrome.runtime.sendMessage({
        action: 'analyzePage',
        url,
        title,
        description,
        body: '',
        h1: h1Text,
        meta: '',
        sensitivePage: true,
        sensitivePageCategory: sensitiveState?.category || null,
        sensitivePageReason: sensitiveState?.reason || null,
        sensitivePageScore: sensitiveState?.score || 0,
        timestamp: Date.now()
      }).catch(() => {});
      return;
    }

    const url = window.location.href;
    const title = document.title;
    const description = getMetaDescription();

    if (shouldDeferScrapeForSensitiveDetector()) {
      contentState.sensitiveRecheckWaits += 1;
      root.__pfSensitivePageDetector?.scheduleRecheck?.();
      trackTimeout(() => runAnalyzeWhenReady({ force: true }), 600);
      return;
    }

    const body = getBodyForAnalysis();
    const bodyLen = body.length;

    // Additive only: never send shorter (or equal) body than we already captured/sent.
    if (bodyLen <= contentState.lastSentBodyLen) return;
    if (bodyLen === 0) return;
    if (bodyLen < PF_HYDRATION_MIN_TEXT && contentState.lastSentBodyLen >= PF_HYDRATION_MIN_TEXT) return;
    if (bodyLen < PF_HYDRATION_MIN_TEXT && !contentState.hydrationGiveUp) return;

    contentState.lastSentBodyLen = bodyLen;
    contentState.lastUrl = url;

    let h1Text = '';
    try {
      h1Text = Array.from(document.querySelectorAll('h1'))
        .map((h) => h.innerText || h.textContent || '')
        .join(' ')
        .slice(0, 500);
    } catch (_) { h1Text = ''; }

    let metaDescription = '';
    try {
      const m = document.querySelector('meta[name="description"]')
        || document.querySelector('meta[property="og:description"]');
      metaDescription = m ? (m.getAttribute('content') || '').slice(0, 500) : '';
    } catch (_) { metaDescription = ''; }

    if (PF_DEBUG) {
      console.info('[pf-extract] sending analyzePage', { url, bodyLen, titleLen: title.length });
    }

    chrome.runtime.sendMessage({
      action: 'analyzePage',
      url,
      title,
      description,
      body,
      h1: h1Text,
      meta: metaDescription,
      timestamp: Date.now()
    }).catch(() => {});
  }

  function scheduleHydrationWait() {
    if (hasCapturedValidContent || contentState.hydrationGiveUp) return;
    if (contentState.hydrationWaits >= PF_HYDRATION_MAX_WAITS) {
      contentState.hydrationGiveUp = true;
      if (PF_EXTRACT_DIAG) {
        console.info('[pf-extract-dom] hydration wait exhausted — sending best effort');
      }
      runAnalyzeWhenReady({ force: true });
      return;
    }
    contentState.hydrationWaits += 1;
    trackTimeout(() => runAnalyzeWhenReady(), PF_HYDRATION_POLL_MS);
  }

  function runAnalyzeWhenReady({ force = false } = {}) {
    const run = () => {
      if (signal.aborted) return;
      if (!force && !hasCapturedValidContent && !isDomLikelyHydrated()) {
        scheduleHydrationWait();
        return;
      }
      sendAnalyzePayload();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2500 });
    } else {
      trackTimeout(run, 0);
    }
  }

  // PERF: extraction passes are EXPENSIVE — extractSafePageText runs up to
  // six full-page text walks, and each innerText read forces style/layout.
  // On churn-heavy pages (chat apps, editors, streaming comments) the old
  // code re-extracted on every 500-800ms debounce FOREVER, competing with
  // the user's typing for the main thread ("browser laggy when I type").
  // Three guards:
  //   1. Once the body is LOCKED (good capture already sent), rescrapes are
  //      throttled to one per PF_LOCKED_RESCRAPE_MIN_MS.
  //   2. A hard per-URL cap (PF_MAX_EXTRACTIONS_PER_URL) disconnects the
  //      observer entirely — navigation resets it (resetExtractionState...).
  //   3. The extraction itself runs in requestIdleCallback so it never
  //      preempts input handling.
  const PF_LOCKED_RESCRAPE_MIN_MS = 10000;
  const PF_MAX_EXTRACTIONS_PER_URL = 40;
  let lastHydrateExtractAt = 0;
  let hydrateExtractCount = 0;

  function resetHydrationExtractionBudget() {
    lastHydrateExtractAt = 0;
    hydrateExtractCount = 0;
  }

  function startContentHydrationWatcher() {
    if (lifecycle.hydrateObserver || !document.body) return;

    lifecycle.hydrateObserver = new MutationObserver(() => {
      if (lifecycle.hydrateDebounce != null) clearTimeout(lifecycle.hydrateDebounce);
      lifecycle.hydrateDebounce = trackTimeout(() => {
        lifecycle.hydrateDebounce = null;
        const now = Date.now();
        if (hydrateExtractCount >= PF_MAX_EXTRACTIONS_PER_URL) {
          // Budget spent for this URL — stop paying for DOM churn entirely.
          try { lifecycle.hydrateObserver?.disconnect(); } catch (_) {}
          lifecycle.hydrateObserver = null;
          return;
        }
        if (contentState.bodyLocked && (now - lastHydrateExtractAt) < PF_LOCKED_RESCRAPE_MIN_MS) {
          return; // locked + recently scraped — churn can wait
        }
        const doExtract = () => {
          if (signal.aborted) return;
          lastHydrateExtractAt = Date.now();
          hydrateExtractCount += 1;
          const prevBestLen = contentState.bestBodyLen;
          const prevSentLen = contentState.lastSentBodyLen;
          if (!isSensitivePageTrackingBlocked()) {
            getBodyForAnalysis();
          }
          if (contentState.bestBodyLen > prevBestLen || contentState.bestBodyLen > prevSentLen) {
            runAnalyzeWhenReady({ force: true });
          }
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(doExtract, { timeout: 3000 });
        } else {
          doExtract();
        }
      }, getMutationDebounceMs());
    });

    lifecycle.hydrateObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function analyzePage() {
    const { protocol, hostname, pathname } = window.location;

    if ((protocol !== 'http:' && protocol !== 'https:') || !hostname) {
      if (PF_DEBUG) console.info('[pf-skip] feedback skipped — invalid location');
      return;
    }

    root.__pfSensitivePageDetector?.runRecheck?.();
    if (isSensitivePageTrackingBlocked()) {
      runAnalyzeWhenReady({ force: true });
      return;
    }

    const path = pathname.toLowerCase();

    const aiDomains = [
      'kimi.com', 'kimi.ai',
      'claude.ai',
      'chatgpt.com',
      'chat.openai.com',
      'gemini.google.com',
      'copilot.microsoft.com',
      'poe.com',
      'character.ai',
      'perplexity.ai'
    ];
    const hostLower = normalizePageHostname(hostname);
    if (aiDomains.some((d) => hostLower === d || hostLower.endsWith('.' + d))) {
      if (PF_DEBUG) console.info('[pf-skip] feedback skipped — AI domain:', hostLower);
      return;
    }

    const searchDomains = ['google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'search.brave.com'];
    if (searchDomains.some((d) => hostname.includes(d))) {
      if (PF_DEBUG) console.info('[pf-skip] feedback skipped — search engine');
      return;
    }

    const authPathPatterns = [
      '/login', '/signin', '/auth/', '/oauth', '/sso/', '/account/login', '/wp-login',
      '/sessions/social/', '/sessions/two-factor', '/saml/', '/o/oauth2/', '/connect/oauth'
    ];
    if (authPathPatterns.some((p) => path.includes(p))) {
      if (PF_DEBUG) console.info('[pf-skip] feedback skipped — auth/login page');
      return;
    }

    const paymentHostPatterns = [
      'stripe.com', 'checkout.', 'payment.', 'pay.', 'billing.',
      'paypal.com', 'square.com', 'venmo.com', 'cash.app', 'wise.com'
    ];
    const paymentPathPatterns = ['/checkout', '/payment', '/billing', '/cart'];
    if (paymentHostPatterns.some((p) => hostname.includes(p)) ||
        paymentPathPatterns.some((p) => path.includes(p))) {
      if (PF_DEBUG) console.info('[pf-skip] feedback skipped — payment context');
      return;
    }

    runAnalyzeWhenReady();
  }

  (function initEngagementTracking() {
    const { protocol, hostname, pathname } = window.location;
    const hostLower = (hostname || '').toLowerCase();
    const path = (pathname || '').toLowerCase();

    function isEditableInteractionTarget(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const tag = el.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      try {
        return !!el.closest(
          'input, textarea, select, option, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="searchbox"], [role="combobox"]'
        );
      } catch (_) {
        return false;
      }
    }

    function isSensitiveInputTarget(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const tag = el.tagName?.toUpperCase();
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || '').toLowerCase();
        if (t === 'password') return true;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (ac.includes('password') || ac.includes('cc-') || ac === 'one-time-code') return true;
      }
      return false;
    }

    function shouldTrackEngagementInteractions() {
      if ((protocol !== 'http:' && protocol !== 'https:') || !hostLower) return false;
      if (isSensitivePageTrackingBlocked()) return false;

      const aiDomains = [
        'claude.ai',
        'chatgpt.com',
        'chat.openai.com',
        'gemini.google.com',
        'copilot.microsoft.com',
        'poe.com',
        'character.ai',
        'perplexity.ai'
      ];
      if (aiDomains.some((d) => hostLower === d || hostLower.endsWith('.' + d))) return false;

      const authPathPatterns = ['/login', '/signin', '/auth/', '/oauth', '/sso/', '/account/login', '/wp-login'];
      if (authPathPatterns.some((p) => path.includes(p))) return false;

      const paymentHostPatterns = [
        'stripe.com', 'checkout.', 'payment.', 'pay.', 'billing.',
        'paypal.com', 'square.com', 'venmo.com', 'cash.app', 'wise.com'
      ];
      const paymentPathPatterns = ['/checkout', '/payment', '/billing', '/cart'];
      if (paymentHostPatterns.some((p) => hostLower.includes(p)) ||
          paymentPathPatterns.some((p) => path.includes(p))) return false;

      return true;
    }

    // TYPING-SPEED-ONLY gate: identical to the engagement gate EXCEPT the
    // AI-domain exclusion. AI chats are excluded from ENGAGEMENT signals
    // (ranking boosts, extraction) for privacy — but typing speed is pure
    // counts + a time span (never key values, never content), and AI chat
    // is exactly where people type the most. Without this, WPM never
    // tracked on claude.ai / chatgpt.com etc. (user report 2026-07:
    // "wpm thing still doesn't work").
    function shouldTrackTypingCountsOnly() {
      if ((protocol !== 'http:' && protocol !== 'https:') || !hostLower) return false;
      if (isSensitivePageTrackingBlocked()) return false;
      const authPathPatterns = ['/login', '/signin', '/auth/', '/oauth', '/sso/', '/account/login', '/wp-login'];
      if (authPathPatterns.some((p) => path.includes(p))) return false;
      const paymentHostPatterns = [
        'stripe.com', 'checkout.', 'payment.', 'pay.', 'billing.',
        'paypal.com', 'square.com', 'venmo.com', 'cash.app', 'wise.com'
      ];
      const paymentPathPatterns = ['/checkout', '/payment', '/billing', '/cart'];
      if (paymentHostPatterns.some((p) => hostLower.includes(p)) ||
          paymentPathPatterns.some((p) => path.includes(p))) return false;
      return true;
    }

    /** Lean keyup listener for WPM-only pages: batches counts exactly like
     *  the engagement path but sends wpmOnly so the worker feeds ONLY the
     *  typing-speed pipeline (no telemetry, no ranking, no engagement). */
    function attachWpmOnlyTracking() {
      const MOD_CODES = new Set([
        'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
        'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
        'CapsLock', 'Tab', 'Escape',
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
      ]);
      const NON_CONTENT = new Set(['Space', 'Backspace', 'Enter']);
      let lastPing = 0, contentDelta = 0, activityDelta = 0, batchStart = 0;
      document.addEventListener('keyup', (e) => {
        if (isSensitiveInputTarget(e.target)) return;
        if (e.isComposing) return;
        if (MOD_CODES.has(e.code)) return;
        if (NON_CONTENT.has(e.code)) {
          activityDelta += 1;
        } else {
          if (contentDelta === 0) batchStart = Date.now();
          contentDelta += 1;
        }
        const now = Date.now();
        if (now - lastPing < 2000) return;
        lastPing = now;
        const inputDelta = contentDelta;
        const actDelta = activityDelta;
        const batchSpanMs = inputDelta > 0 && batchStart > 0 ? Math.max(0, now - batchStart) : 0;
        contentDelta = 0; activityDelta = 0; batchStart = 0;
        if (inputDelta === 0 && actDelta === 0) return;
        chrome.runtime.sendMessage({
          action: 'behaviorPing',
          eventType: 'input',
          wpmOnly: true,
          inputDelta,
          activityDelta: actDelta,
          batchSpanMs
        }).catch(() => {});
      }, { passive: true, capture: true });
    }

    if (!shouldTrackEngagementInteractions()) {
      if (shouldTrackTypingCountsOnly()) attachWpmOnlyTracking();
      return;
    }

    const trackingController = new AbortController();
    const { signal: trackingSignal } = trackingController;

    function teardownEngagementTracking() {
      try {
        trackingController.abort();
      } catch (_) {}
    }

    lifecycle.engagementTrackingController?.abort();
    lifecycle.engagementTrackingController = trackingController;
    lifecycle.teardownEngagementTracking = teardownEngagementTracking;

    window.addEventListener('pagehide', teardownEngagementTracking, { once: true, signal: trackingSignal });

    let lastEngagementHost = hostLower;
    const onEngagementHostChange = () => {
      const nextHost = (window.location.hostname || '').toLowerCase();
      if (nextHost && nextHost !== lastEngagementHost) {
        lastEngagementHost = nextHost;
        teardownEngagementTracking();
      }
    };
    window.addEventListener('popstate', onEngagementHostChange, { signal: trackingSignal });
    window.addEventListener('hashchange', onEngagementHostChange, { signal: trackingSignal });

    let lastClickTime = 0;
    let lastClickTarget = null;
    let sameTargetClickTimes = [];
    const REPEAT_WINDOW_MS = 1500;
    const REPEAT_THRESHOLD = 3;
    const RAPID_INTERVAL_MS = 30;

    let signalWeight = 0;
    let deltaC = 0;
    let rapidPulse = false;
    let repeatBurst = false;

    let lastClickPing = 0;
    const CLICK_PING_THROTTLE_MS = 2000;

    function maybePingPointer() {
      const now = Date.now();
      if (now - lastClickPing < CLICK_PING_THROTTLE_MS) return;
      lastClickPing = now;
      chrome.runtime.sendMessage({
        action: 'behaviorPing',
        eventType: 'pointer',
        signalData: {
          deltaC,
          signalWeight,
          rapidPulse,
          repeatBurst
        }
      }).catch(() => {});
    }

    function onEngagementClick(e) {
      if (isEditableInteractionTarget(e.target)) return;

      const now = Date.now();
      const target = e.target;

      if (lastClickTime > 0 && (now - lastClickTime) < RAPID_INTERVAL_MS) {
        rapidPulse = true;
        lastClickTime = now;
        maybePingPointer();
        return;
      }

      deltaC++;
      lastClickTime = now;

      if (target === lastClickTarget) {
        sameTargetClickTimes.push(now);
        sameTargetClickTimes = sameTargetClickTimes.filter(
          (t) => (now - t) <= REPEAT_WINDOW_MS
        );
        if (sameTargetClickTimes.length >= REPEAT_THRESHOLD) {
          repeatBurst = true;
          signalWeight = Math.max(0, signalWeight - 5);
          sameTargetClickTimes = [];
          maybePingPointer();
          return;
        }
      } else {
        lastClickTarget = target;
        sameTargetClickTimes = [now];
      }

      const tagName = target.tagName?.toUpperCase();
      const isInteractive = (
        tagName === 'A' || tagName === 'BUTTON' ||
        tagName === 'INPUT' || tagName === 'SELECT' ||
        tagName === 'TEXTAREA' || tagName === 'LABEL'
      );
      let isClickable = isInteractive;
      if (!isClickable) {
        try {
          const computed = window.getComputedStyle(target);
          if (computed.cursor === 'pointer') isClickable = true;
        } catch (_) {}
      }

      signalWeight += isClickable ? 2 : 1;
      maybePingPointer();
    }

    document.addEventListener('click', onEngagementClick, { passive: true, capture: true, signal: trackingSignal });

    let scrollPingThrottle = 0;
    const THROTTLE_MS = 2000;

    document.addEventListener('scroll', () => {
      const now = Date.now();
      if (now - scrollPingThrottle < THROTTLE_MS) return;
      scrollPingThrottle = now;
      chrome.runtime.sendMessage({
        action: 'behaviorPing',
        eventType: 'scroll'
      }).catch(() => {});
    }, { passive: true, signal: trackingSignal });

    let lastInputPing = 0;
    let pendingContentDelta = 0;
    let pendingActivityDelta = 0;
    let pendingBatchStart = 0;
    const INPUT_PING_THROTTLE_MS = 2000;
    // Modifier/navigation keys only — never read event.key, event.code values, or timings beyond throttling.
    const INPUT_MODIFIER_CODES = new Set([
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
      'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
      'CapsLock', 'Tab', 'Escape',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
    ]);
    const INPUT_NON_CONTENT_CODES = new Set(['Space', 'Backspace', 'Enter']);

    document.addEventListener('keyup', (e) => {
      if (!shouldTrackEngagementInteractions()) return;
      if (isSensitiveInputTarget(e.target)) return;
      if (e.isComposing) return;
      if (INPUT_MODIFIER_CODES.has(e.code)) return;

      if (INPUT_NON_CONTENT_CODES.has(e.code)) {
        pendingActivityDelta += 1;
      } else {
        if (pendingContentDelta === 0) {
          pendingBatchStart = Date.now();
        }
        pendingContentDelta += 1;
      }

      const now = Date.now();
      if (now - lastInputPing < INPUT_PING_THROTTLE_MS) return;
      lastInputPing = now;

      const inputDelta = pendingContentDelta;
      const activityDelta = pendingActivityDelta;
      const batchSpanMs = inputDelta > 0 && pendingBatchStart > 0
        ? Math.max(0, now - pendingBatchStart)
        : 0;
      pendingContentDelta = 0;
      pendingActivityDelta = 0;
      pendingBatchStart = 0;
      if (inputDelta === 0 && activityDelta === 0) return;

      chrome.runtime.sendMessage({
        action: 'behaviorPing',
        eventType: 'input',
        inputDelta,
        activityDelta,
        batchSpanMs
      }).catch(() => {});
    }, { passive: true, capture: true, signal: trackingSignal });
  })();

  function onPossibleUrlChange() {
    if (lifecycle.urlDebounceTimer != null) clearTimeout(lifecycle.urlDebounceTimer);
    lifecycle.urlDebounceTimer = trackTimeout(() => {
      lifecycle.urlDebounceTimer = null;
      const currentUrl = window.location.href;
      const currentHostname = getPageHostname(currentUrl);
      if (!currentHostname) return;

      if (!contentState.capturedHostname) {
        contentState.capturedHostname = currentHostname;
      }

      if (currentUrl === contentState.lastUrl) return;

      root.__pfSensitivePageDetector?.resetLatchForNavigation?.();
      window.__pfPageLoadTime = Date.now();
      if (resetCapturedBodyForNavigation(currentUrl)) {
        analyzePage();
      }
    }, getMutationDebounceMs());
  }

  // SPA URL-change detection: popstate/hashchange + a cheap 1s href poll.
  // Previously this was a MutationObserver on the WHOLE document (childList +
  // subtree) — every DOM mutation on every page paid for a callback + debounce
  // just to notice URL changes. The poll costs one string compare per second.
  window.addEventListener('popstate', onPossibleUrlChange, { signal });
  window.addEventListener('hashchange', onPossibleUrlChange, { signal });
  trackInterval(() => {
    if (window.location.href !== contentState.lastUrl) onPossibleUrlChange();
  }, 1000);

  function scheduleAnalyzeRetry(delayMs) {
    trackTimeout(() => {
      if (hasCapturedValidContent || contentState.bodyLocked) return;
      runAnalyzeWhenReady();
    }, delayMs);
  }

  logExtractDiagnostics('init');
  runAnalyzeWhenReady();
  scheduleAnalyzeRetry(3000);
  scheduleAnalyzeRetry(12000);
  scheduleAnalyzeRetry(32000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startContentHydrationWatcher, { once: true, signal });
  } else {
    startContentHydrationWatcher();
  }

  chrome.runtime.sendMessage({ action: 'ping' }).then((resp) => {
    if (resp?.tabId != null) {
      contentState.capturedTabId = resp.tabId;
      syncScrapeCacheToSession();
    }
  }).catch(() => {});

  lifecycle.onRuntimeMessage = (message, _sender, sendResponse) => {
    if (message?.action === 'pfGetCachedPageBody') {
      sendResponse({
        success: true,
        readOnly: true,
        body: lastKnownGoodScrape,
        cachedChars: lastKnownGoodScrape.length,
        url: window.location.href
      });
      return false;
    }
    if (message?.action === 'forceAnalyzePage') {
      runAnalyzeWhenReady({ force: true });
      sendResponse({ success: true, queued: true });
      return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(lifecycle.onRuntimeMessage);

  if (PF_DEBUG) console.log('>=PlayingFild: Consolidated content script loaded');
})();
