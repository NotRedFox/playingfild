/**
 * DOM-level sensitive-page detector (content script).
 * Skips body scrape / keyword extraction when page IS a credential, payment, or AI-chat surface.
 * Ships with dryRun:true — call pfSensitiveDetectorDryRun() to test; set dryRun:false to enforce.
 */
(function initPfSensitivePageDetector() {
  'use strict';

  const root = globalThis;
  if (root.__pfSensitivePageDetectorLoaded) return;
  root.__pfSensitivePageDetectorLoaded = true;

  const DEFAULT_CONFIG = {
    enabled: true,
    /** When true, logs extra dry-run diagnostics; scrape is still gated when wouldSkip. */
    dryRun: true,
    skipScore: 100,
    primaryMinViewportRatio: 0.12,
    passwordPrimaryScore: 55,
    usernameSameFormScore: 35,
    passwordFocusedScore: 25,
    loginHeadingScore: 20,
    loginPathBoostScore: 15,
    // OTP / 2FA split-input group (≥ 4 sibling single-char inputs).
    // Score is above loginSkipMinCredentialScore (90) so a bare 2FA page
    // with nothing else on it still trips the skip — nothing else on the
    // web uses 4+ single-character inputs in a row like this.
    otpFieldGroupScore: 95,
    paymentFieldScore: 50,
    paymentNamePatternScore: 45,
    paymentBundleScore: 90,
    chatPromptScore: 45,
    chatMessageListScore: 50,
    chatPlaceholderBoostScore: 15,
    chatPathBoostScore: 15,
    chatSendBoostScore: 15,
    largePromptMinHeightPx: 80,
    largePromptMinRows: 3,
    largePromptMinWidthRatio: 0.4,
    messageListMinBlocks: 2,
    messageBlockMinChars: 40,
    loginSkipMinCredentialScore: 90,
    loginSkipMinFocusedScore: 80,
    aiChatSkipMinScore: 95,
    settingsOutsideFormMinChars: 300,
    settingsFormDominanceMaxRatio: 0.5,
    recheckDebounceMs: 800,
    debugLog: false
  };

  const CHROME_ANCESTOR =
    'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], ' +
    '.site-header, .global-nav, .top-bar, #header';

  const PRIMARY_SELECTORS = [
    'main',
    'article',
    '[role="main"]',
    '[role="article"]',
    '#content',
    '.content-body',
    '.content'
  ];

  const LOGIN_HEADING_RX = /\b(sign in|log in|login|create account|reset password|forgot password)\b/i;

  const LOGIN_PATH_PATTERNS = [
    /\/login(\/|$|\?)/i,
    /\/signin(\/|$|\?)/i,
    /\/sign-in(\/|$|\?)/i
  ];

  const CHAT_PATH_PATTERNS = [
    /\/chat(\/|$|\?)/i,
    /\/c\/[^/]+/i,
    /\/conversation(\/|$|\?)/i,
    /\/g\/[^/]+/i
  ];

  const PAYMENT_AUTOCOMPLETE = new Set(['cc-number', 'cc-csc', 'cc-exp', 'cc-name']);

  const PAYMENT_NAME_RX = /card.?number|cvv|cvc|expir/i;

  const USERNAME_MATCH_RX = /user|email|login/i;

  const CHAT_MESSAGE_SELECTORS = [
    '[role="log"] > *',
    '.message-content',
    '[class*="message-content"]',
    '[class*="MessageContent"]',
    '[data-testid*="message"]',
    '[class*="chat-message"]',
    '[class*="ChatMessage"]',
    '[class*="conversation-turn"]',
    '[data-message-author-role]',
    '[class*="markdown"]',
    '[class*="assistant"]',
    '[class*="user-message"]',
    '[class*="bot-message"]'
  ];

  const CHAT_CONTAINER_SELECTORS = [
    '[role="log"]',
    '[role="region"][aria-label*="chat"]',
    '[role="region"][aria-label*="conversation"]',
    '[aria-label*="conversation"]',
    '[class*="chat-history"]',
    '[class*="ChatHistory"]',
    '[class*="conversation"]',
    '[data-testid*="conversation"]',
    '[class*="message-list"]',
    '[class*="MessageList"]'
  ];

  const PROMPT_INPUT_SELECTORS = [
    'textarea',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    'div[role="textbox"]',
    '[class*="prompt"] textarea',
    '[class*="composer"] textarea',
    '[class*="input"] textarea'
  ];

  function queryAllDeep(selector, rootNode = document) {
    const out = [];
    const seen = new Set();
    function add(el) {
      if (el && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
    function walk(node) {
      if (!node) return;
      try {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches?.(selector)) add(node);
          if (node.shadowRoot) walk(node.shadowRoot);
          for (const child of node.children || []) walk(child);
        } else if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          for (const child of node.children || node.childNodes || []) walk(child);
        }
      } catch (_) { /* ignore invalid selector on node */ }
    }
    try {
      for (const el of rootNode.querySelectorAll(selector)) add(el);
    } catch (_) { /* ignore */ }
    walk(rootNode.body || rootNode.documentElement || rootNode);
    return out;
  }

  function isLikelyChatPath() {
    try {
      const path = location.pathname || '/';
      return CHAT_PATH_PATTERNS.some((rx) => rx.test(path));
    } catch (_) {
      return false;
    }
  }

  function normalizeHostname(raw) {
    return String(raw || '').replace(/^www\./, '').toLowerCase();
  }

  function isLikelyAiHost() {
    try {
      const host = normalizeHostname(location.hostname);
      const AI_HOSTS = [
        'kimi.com', 'kimi.ai', 'moonshot.cn', 'moonshot.ai',
        'chatgpt.com', 'chat.openai.com', 'claude.ai', 'openai.com',
        'gemini.google.com', 'copilot.microsoft.com', 'poe.com',
        'character.ai', 'perplexity.ai', 'deepseek.com', 'mistral.ai',
        'slack.com', 'discord.com', 'teams.microsoft.com'
      ];
      if (AI_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
      const first = host.split('.')[0] || '';
      return /^(kimi|moonshot|qwen|groq|chatgpt|claude|copilot|poe|perplexity)$/i.test(first);
    } catch (_) {
      return false;
    }
  }

  const PROMPT_PLACEHOLDER_RX = /\b(ask|message|prompt|chat with|send a message|type a message|kimi)\b/i;

  let configCache = { ...DEFAULT_CONFIG };
  let latchedResult = null;
  let observer = null;
  let debounceTimer = null;
  // Consecutive non-sensitive evaluations triggered by DOM mutations. Once a
  // page has been evaluated this many times without latching, it's almost
  // certainly a normal page — disconnect the observer so we stop paying for
  // full-DOM re-evaluation on every mutation batch forever. Re-armed on SPA
  // navigation (resetLatchForNavigation).
  const STABLE_EVALS_BEFORE_DISCONNECT = 12;
  let stableEvalCount = 0;
  let bridgeInitDone = false;

  function mergeConfig(partial) {
    configCache = { ...DEFAULT_CONFIG, ...(partial || {}) };
    return configCache;
  }

  async function refreshConfig() {
    try {
      const stored = await chrome.storage.local.get('pfSensitiveDetectorConfig');
      mergeConfig(stored.pfSensitiveDetectorConfig);
    } catch (_) {
      mergeConfig(null);
    }
    return configCache;
  }

  function cfg() {
    return configCache;
  }

  function logDebug(...args) {
    if (cfg().debugLog) console.info('[pf-sensitive-detector]', ...args);
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.closest('[aria-hidden="true"], [hidden]')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) return false;
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    return true;
  }

  function isInChrome(el) {
    try {
      return !!el?.closest?.(CHROME_ANCESTOR);
    } catch (_) {
      return false;
    }
  }

  function viewportAreaRatio(el) {
    const rect = el.getBoundingClientRect();
    const vp = Math.max(window.innerWidth * window.innerHeight, 1);
    return (rect.width * rect.height) / vp;
  }

  function isInPrimaryZone(el) {
    if (!el || !isElementVisible(el)) return false;
    if (isInChrome(el)) return false;

    for (const sel of PRIMARY_SELECTORS) {
      try {
        const region = el.closest(sel);
        if (region && !isInChrome(region)) return true;
      } catch (_) { /* ignore */ }
    }

    if (viewportAreaRatio(el) >= cfg().primaryMinViewportRatio) return true;

    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    const vw = window.innerWidth || 1;
    const centerY = rect.top + rect.height / 2;
    const inMiddleBand = centerY >= vh * 0.15 && centerY <= vh * 0.85;
    const wideEnough = rect.width >= vw * 0.35;
    if (inMiddleBand && wideEnough) return true;

    const form = el.closest('form');
    if (form && isElementVisible(form) && viewportAreaRatio(form) >= 0.08) return true;

    return false;
  }

  function findPrimaryRoot(fromEl) {
    if (fromEl) {
      for (const sel of PRIMARY_SELECTORS) {
        try {
          const region = fromEl.closest(sel);
          if (region && !isInChrome(region)) return region;
        } catch (_) { /* ignore */ }
      }
    }
    for (const sel of PRIMARY_SELECTORS) {
      try {
        const region = document.querySelector(sel);
        if (region && !isInChrome(region)) return region;
      } catch (_) { /* ignore */ }
    }
    return document.body;
  }

  function visibleTextIn(el, excludeSubtree = null) {
    if (!el) return 0;
    let total = 0;

    function walk(node) {
      if (!node) return;
      if (excludeSubtree && node !== excludeSubtree && excludeSubtree.contains(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        total += normalizeText(node.textContent).length;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName?.toUpperCase?.() || '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (isInChrome(node)) return;
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.childNodes) walk(child);
    }

    walk(el);
    return total;
  }

  /**
   * Settings carve-out: bare login pages are dominated by the credential form;
   * logged-in settings pages have substantial content outside that form.
   */
  function isBareLoginSurface(credentialFormEl) {
    if (!credentialFormEl) return true;

    const primaryRoot = findPrimaryRoot(credentialFormEl);
    const totalPrimaryChars = visibleTextIn(primaryRoot);
    const formChars = visibleTextIn(credentialFormEl);
    const outsideFormChars = visibleTextIn(primaryRoot, credentialFormEl);
    const dominanceRatio = formChars / Math.max(totalPrimaryChars, 1);

    const dominated = dominanceRatio >= (1 - cfg().settingsFormDominanceMaxRatio);
    const littleOutside = outsideFormChars < cfg().settingsOutsideFormMinChars;
    const bare = dominated && littleOutside;

    logDebug('settings carve-out', {
      totalPrimaryChars,
      formChars,
      outsideFormChars,
      dominanceRatio: dominanceRatio.toFixed(2),
      bare
    });

    return bare;
  }

  function findPrimaryPasswordFields() {
    // Security review 2026-07: extended beyond bare `input[type="password"]`
    // to also match inputs carrying the WHATWG-standard autocomplete hints
    // for credentials. Many custom-component login forms use type="text"
    // (so they can render their own visibility toggle) but still set
    // autocomplete correctly for password managers. Also uses queryAllDeep
    // (traverses open shadow DOM) so shadow-hosted login inputs are found.
    //
    // FALLBACK: if no password field is in the primary zone but one IS
    // visible in the viewport, treat it as primary. This covers login
    // modals rendered into a body-level portal (React modals, floating
    // dialogs) that live outside <main> / [role="main"]. If a real
    // password field is on screen, we treat the page as sensitive
    // regardless of its DOM ancestry.
    const primary = [];
    const anywhere = [];
    const seenPrimary = new Set();
    const seenAny = new Set();
    const selectors = [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
    ];
    for (const sel of selectors) {
      for (const el of queryAllDeep(sel)) {
        if (!el || !isElementVisible(el)) continue;
        if (isInPrimaryZone(el)) {
          if (!seenPrimary.has(el)) {
            seenPrimary.add(el);
            primary.push(el);
          }
        } else if (!seenAny.has(el)) {
          seenAny.add(el);
          anywhere.push(el);
        }
      }
    }
    return primary.length ? primary : anywhere;
  }

  /**
   * OTP / 2FA split-input detector (security review 2026-07).
   * Many 2FA UIs use N sibling `<input maxlength="1">` boxes (or type="tel"
   * with maxlength 1) for the 6-digit code. None of these individually
   * match the password heuristics, and the surrounding page often has no
   * "sign in" heading (the user is already authenticated to this point).
   * Return true if we find a group of ≥ 4 short-length inputs sharing a
   * common parent — a strong OTP signature.
   */
  function hasOtpFieldGroup() {
    const parents = new Map(); // parent element → count
    const shortInputSelectors = [
      'input[maxlength="1"]',
      'input[maxlength="2"]',
    ];
    for (const sel of shortInputSelectors) {
      for (const el of queryAllDeep(sel)) {
        if (!isElementVisible(el)) continue;
        const type = (el.getAttribute('type') || '').toLowerCase();
        // Text-like inputs only. Skip hidden / checkbox / radio / etc.
        if (type && !['text', 'tel', 'number', 'password', ''].includes(type)) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        parents.set(parent, (parents.get(parent) || 0) + 1);
      }
    }
    for (const count of parents.values()) {
      if (count >= 4) return true;
    }
    return false;
  }

  function hasUsernameInForm(formEl) {
    if (!formEl) return false;
    for (const el of formEl.querySelectorAll('input, textarea')) {
      if (!isElementVisible(el)) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'email') return true;
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac === 'username' || ac === 'email') return true;
      const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`;
      if (USERNAME_MATCH_RX.test(name) && type !== 'password' && type !== 'hidden') return true;
    }
    return false;
  }

  function isCredentialFieldFocused(formEl, passwordEl) {
    const active = document.activeElement;
    if (!active) return false;
    if (active === passwordEl) return true;
    if (formEl && formEl.contains(active)) {
      const tag = active.tagName?.toUpperCase?.() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    }
    return false;
  }

  function hasLoginHeadingInPrimary() {
    const candidates = document.querySelectorAll('h1, [role="heading"][aria-level="1"], h2');
    for (const el of candidates) {
      if (!isElementVisible(el) || isInChrome(el)) continue;
      if (!isInPrimaryZone(el)) continue;
      const text = normalizeText(el.innerText || el.textContent);
      if (LOGIN_HEADING_RX.test(text)) return true;
    }
    return false;
  }

  function pathBoost(patterns) {
    try {
      const path = location.pathname || '/';
      return patterns.some((rx) => rx.test(path)) ? cfg().loginPathBoostScore : 0;
    } catch (_) {
      return 0;
    }
  }

  function chatPathBoost() {
    try {
      const path = location.pathname || '/';
      return CHAT_PATH_PATTERNS.some((rx) => rx.test(path)) ? cfg().chatPathBoostScore : 0;
    } catch (_) {
      return 0;
    }
  }

  function findPrimaryPaymentFields() {
    const found = [];
    const seen = new Set();

    function add(el, kind) {
      if (!el || seen.has(el)) return;
      if (!isElementVisible(el) || !isInPrimaryZone(el)) return;
      seen.add(el);
      found.push({ el, kind });
    }

    for (const el of document.querySelectorAll('input, textarea')) {
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (PAYMENT_AUTOCOMPLETE.has(ac)) add(el, 'autocomplete');
      const blob = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`;
      if (PAYMENT_NAME_RX.test(blob)) add(el, 'name');
    }
    return found;
  }

  function findLargePromptInput() {
    const vw = window.innerWidth || 1;
    const aiContext = isLikelyAiHost() || isLikelyChatPath();
    const minH = aiContext ? Math.min(cfg().largePromptMinHeightPx, 48) : cfg().largePromptMinHeightPx;
    const minW = aiContext ? Math.min(cfg().largePromptMinWidthRatio, 0.28) : cfg().largePromptMinWidthRatio;

    const candidates = [];
    const seen = new Set();
    for (const sel of PROMPT_INPUT_SELECTORS) {
      for (const el of queryAllDeep(sel)) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
    }

    for (const el of candidates) {
      if (!isElementVisible(el) || isInChrome(el)) continue;
      if (el.closest('form[role="search"], [role="search"]')) continue;
      if (!isInPrimaryZone(el)) continue;
      const rect = el.getBoundingClientRect();
      const rows = Number(el.getAttribute('rows') || 0);
      const tag = el.tagName?.toUpperCase?.() || '';
      const isPrompt = tag === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox';
      if (!isPrompt) continue;
      if (rect.height >= minH || rows >= cfg().largePromptMinRows || rect.width >= vw * minW) {
        return el;
      }
    }

    return null;
  }

  function countChatMessageBlocks() {
    const blocks = [];
    const seen = new Set();

    function addBlock(el) {
      if (!el || seen.has(el)) return;
      if (!isElementVisible(el) || isInChrome(el)) return;
      if (!isInPrimaryZone(el)) return;
      const text = normalizeText(el.innerText || el.textContent);
      if (text.length < cfg().messageBlockMinChars) return;
      seen.add(el);
      blocks.push(el);
    }

    for (const sel of CHAT_MESSAGE_SELECTORS) {
      let nodes = [];
      try {
        nodes = queryAllDeep(sel);
      } catch (_) {
        continue;
      }
      for (const el of nodes) addBlock(el);
    }

    if (blocks.length >= cfg().messageListMinBlocks) return blocks.length;

    for (const sel of CHAT_CONTAINER_SELECTORS) {
      let containers = [];
      try {
        containers = queryAllDeep(sel);
      } catch (_) {
        continue;
      }
      for (const container of containers) {
        if (!container || !isElementVisible(container) || isInChrome(container)) continue;
        if (!isInPrimaryZone(container)) continue;
        let rich = 0;
        for (const child of container.children || []) {
          const text = normalizeText(child.innerText || child.textContent);
          if (text.length >= cfg().messageBlockMinChars) rich++;
        }
        if (rich >= cfg().messageListMinBlocks) return rich;
      }
    }

    return blocks.length;
  }

  function hasPromptBoost(promptEl) {
    if (!promptEl) return false;
    const placeholder = promptEl.getAttribute('placeholder') || '';
    const aria = promptEl.getAttribute('aria-label') || '';
    return PROMPT_PLACEHOLDER_RX.test(`${placeholder} ${aria}`);
  }

  function hasAdjacentSendButton(promptEl) {
    if (!promptEl) return false;
    const container = promptEl.closest('form') ||
      promptEl.closest('[class*="composer"]') ||
      promptEl.closest('[class*="input-area"]') ||
      promptEl.closest('[class*="prompt"]') ||
      promptEl.parentElement;
    if (!container) return false;
    for (const btn of container.querySelectorAll('button, [role="button"]')) {
      if (!isElementVisible(btn)) continue;
      const label = normalizeText(`${btn.innerText || ''} ${btn.getAttribute('aria-label') || ''}`).toLowerCase();
      if (label === 'send' || label.includes('send message') || label.includes('submit')) return true;
    }
    return false;
  }

  function evaluateSensitivePage(options = {}) {
    const c = cfg();
    const breakdown = [];
    const signals = {};

    if (!c.enabled) {
      return {
        active: false,
        wouldSkip: false,
        enforced: false,
        dryRun: c.dryRun,
        category: null,
        reason: null,
        score: 0,
        breakdown,
        signals
      };
    }

    const hostNorm = normalizeHostname(location.hostname);
    if (isLikelyAiHost()) {
      breakdown.push({
        signal: 'H1',
        score: 100,
        detail: `known AI host (normalized: ${hostNorm})`
      });
      signals.H1 = true;
      signals.aiHost = hostNorm;
      const result = {
        active: true,
        wouldSkip: true,
        enforced: true,
        dryRun: c.dryRun,
        category: 'ai_chat',
        reason: 'ai-host',
        score: 100,
        breakdown,
        signals,
        evaluatedAt: Date.now()
      };
      if (options.forceLog || c.debugLog) {
        console.info('[pf-sensitive-detector] evaluate (AI host fast-path)', result);
      }
      return result;
    }

    let A1 = 0;
    let A2 = 0;
    let A3 = 0;
    let A4 = 0;
    let A5 = 0;
    let credentialForm = null;

    const passwordFields = findPrimaryPasswordFields();
    if (passwordFields.length) {
      const passwordEl = passwordFields[0];
      A1 = c.passwordPrimaryScore;
      credentialForm = passwordEl.closest('form') || passwordEl.parentElement;
      breakdown.push({ signal: 'A1', score: A1, detail: 'primary visible password field' });
      signals.A1 = true;

      if (hasUsernameInForm(credentialForm)) {
        A2 = c.usernameSameFormScore;
        breakdown.push({ signal: 'A2', score: A2, detail: 'username/email in same form' });
        signals.A2 = true;
      }
      if (isCredentialFieldFocused(credentialForm, passwordEl)) {
        A3 = c.passwordFocusedScore;
        breakdown.push({ signal: 'A3', score: A3, detail: 'credential field focused' });
        signals.A3 = true;
      }
    }

    if (hasLoginHeadingInPrimary()) {
      A4 = c.loginHeadingScore;
      breakdown.push({ signal: 'A4', score: A4, detail: 'login heading in primary zone' });
      signals.A4 = true;
    }

    A5 = pathBoost(LOGIN_PATH_PATTERNS);
    if (A5) {
      breakdown.push({ signal: 'A5', score: A5, detail: 'login path boost' });
      signals.A5 = true;
    }

    // A6: OTP / 2FA split-input group. Independent of A1 — a 2FA page
    // often has no password field, just the code inputs. (Security review
    // 2026-07: previously such pages passed through as normal content and
    // were scraped.)
    let A6 = 0;
    if (hasOtpFieldGroup()) {
      A6 = c.otpFieldGroupScore;
      breakdown.push({ signal: 'A6', score: A6, detail: 'OTP/2FA split-input group (4+ short inputs)' });
      signals.A6 = true;
    }

    const paymentFields = findPrimaryPaymentFields();
    let paymentScore = 0;
    if (paymentFields.length) {
      for (const pf of paymentFields.slice(0, 2)) {
        const pts = pf.kind === 'autocomplete' ? c.paymentFieldScore : c.paymentNamePatternScore;
        paymentScore += pts;
        breakdown.push({ signal: pf.kind === 'autocomplete' ? 'P1' : 'P2', score: pts, detail: 'payment field in primary' });
      }
      signals.paymentFieldCount = paymentFields.length;
    }

    const promptEl = findLargePromptInput();
    let B1 = 0;
    let B2 = 0;
    let B3 = 0;
    let B4 = 0;
    let B5 = 0;

    if (promptEl) {
      B1 = c.chatPromptScore;
      breakdown.push({ signal: 'B1', score: B1, detail: 'large prompt input in primary' });
      signals.B1 = true;
      if (isLikelyAiHost()) {
        breakdown.push({ signal: 'B0', score: 0, detail: `known AI host: ${location.hostname}` });
        signals.B0 = true;
      }
      if (hasPromptBoost(promptEl)) {
        B3 = c.chatPlaceholderBoostScore;
        breakdown.push({ signal: 'B3', score: B3, detail: 'prompt placeholder/aria boost' });
        signals.B3 = true;
      }
      if (hasAdjacentSendButton(promptEl)) {
        B5 = c.chatSendBoostScore;
        breakdown.push({ signal: 'B5', score: B5, detail: 'send button near prompt' });
        signals.B5 = true;
      }
    }

    const messageBlocks = countChatMessageBlocks();
    if (messageBlocks >= c.messageListMinBlocks) {
      B2 = c.chatMessageListScore;
      breakdown.push({ signal: 'B2', score: B2, detail: `${messageBlocks} chat message blocks` });
      signals.B2 = true;
      signals.messageBlocks = messageBlocks;
    }

    B4 = chatPathBoost();
    if (B4) {
      breakdown.push({ signal: 'B4', score: B4, detail: 'chat path boost' });
      signals.B4 = true;
    }

    const credentialScore = A1 + A2 + A3 + A4 + A5 + A6;
    const aiScore = B1 + B2 + B3 + B4 + B5;

    let wouldSkip = false;
    let category = null;
    let reason = null;
    let score = 0;

    if (paymentFields.length >= 2) {
      wouldSkip = true;
      category = 'payment';
      reason = 'P3';
      score = c.paymentBundleScore;
      breakdown.push({ signal: 'P3', score: c.paymentBundleScore, detail: 'payment bundle (2+ fields)' });
    } else if (B1 + B2 >= c.aiChatSkipMinScore || (B1 + B2 + B4 >= c.skipScore)) {
      wouldSkip = true;
      category = 'ai_chat';
      reason = B4 ? 'B1+B2+B4' : 'B1+B2';
      score = B1 + B2 + B3 + B4 + B5;
    } else if (B1 && isLikelyAiHost() && (B3 || B5 || B4 || isLikelyChatPath())) {
      wouldSkip = true;
      category = 'ai_chat';
      reason = 'B1+ai-host';
      score = B1 + B3 + B4 + B5;
      breakdown.push({ signal: 'B1+host', score: 0, detail: 'AI host + composer (empty chat)' });
    } else if (
      A1 + A2 >= c.loginSkipMinCredentialScore ||
      A1 + A3 >= c.loginSkipMinFocusedScore ||
      (A1 + A2 + A4 >= c.skipScore) ||
      // A6 standalone: an OTP/2FA page often has no password field, no
      // username, no "sign in" heading — just the code inputs. The signal
      // is highly specific, so it skips on its own. Bypasses the
      // isBareLoginSurface settings-carve-out because 2FA screens rarely
      // live in "settings" surfaces (they're one-purpose pages).
      A6 >= c.loginSkipMinCredentialScore
    ) {
      // OTP-standalone skip: don't require bare-login-surface check.
      if (A6 >= c.loginSkipMinCredentialScore && A1 === 0) {
        wouldSkip = true;
        category = 'credential';
        reason = 'A6-otp';
        score = credentialScore;
      } else if (isBareLoginSurface(credentialForm)) {
        wouldSkip = true;
        category = 'credential';
        reason = A1 + A2 >= c.loginSkipMinCredentialScore ? 'A1+A2' : (A1 + A3 >= c.loginSkipMinFocusedScore ? 'A1+A3' : 'A1+A2+A4');
        score = credentialScore;
      } else {
        breakdown.push({
          signal: 'settings-carve-out',
          score: 0,
          detail: `credential form not dominant (outsideFormChars >= ${c.settingsOutsideFormMinChars} or form < 50% of primary)`
        });
        signals.settingsCarveOut = true;
      }
    } else if (paymentScore >= c.skipScore) {
      wouldSkip = true;
      category = 'payment';
      reason = 'P1+P2';
      score = paymentScore;
    } else if (aiScore >= c.skipScore) {
      wouldSkip = false;
      score = aiScore;
    } else {
      score = Math.max(credentialScore, paymentScore, aiScore);
    }

    const enforced = wouldSkip && c.enabled;
    const result = {
      active: enforced,
      wouldSkip,
      enforced,
      dryRun: c.dryRun,
      category,
      reason,
      score,
      breakdown,
      signals,
      evaluatedAt: Date.now()
    };

    if (options.forceLog || c.debugLog) {
      console.info('[pf-sensitive-detector] evaluate', result);
    }

    return result;
  }

  // PERF-CRITICAL TTL cache. getEffectiveState() is called from HOT paths in
  // consolidated_content — including the engagement tracker's per-KEYSTROKE
  // keyup handler — and evaluateSensitivePage() is a full-DOM walk (deep
  // querySelectorAll incl. shadow roots + getComputedStyle per candidate).
  // Without this cache, every keystroke on a non-latched page ran a full
  // page scan: the "browser is laggy and takes ages when I type" bug.
  const EFFECTIVE_STATE_CACHE_MS = 3000;
  let effectiveStateCache = null;
  let effectiveStateCachedAt = 0;

  function invalidateEffectiveStateCache() {
    effectiveStateCache = null;
    effectiveStateCachedAt = 0;
  }

  function cacheEffectiveState(result) {
    effectiveStateCache = result;
    effectiveStateCachedAt = Date.now();
  }

  function getEffectiveState() {
    if (latchedResult?.latched && latchedResult.wouldSkip) return latchedResult;
    const now = Date.now();
    if (effectiveStateCache && (now - effectiveStateCachedAt) < EFFECTIVE_STATE_CACHE_MS) {
      return effectiveStateCache;
    }
    const latest = evaluateSensitivePage();
    if (latest.wouldSkip && cfg().enabled) {
      latchedResult = { ...latest, latched: true, latchedAt: Date.now() };
      root.__pfSensitivePageDomActive = true;
      root.__pfSensitivePageDomResult = latchedResult;
      publishResultToPage(latchedResult);
      cacheEffectiveState(latchedResult);
      return latchedResult;
    }
    cacheEffectiveState(latest);
    return latest;
  }

  function shouldSkipTracking() {
    if (!cfg().enabled) return false;
    const state = getEffectiveState();
    return state.wouldSkip === true;
  }

  function shouldSkipTrackingDryRunPreview() {
    const state = evaluateSensitivePage();
    return state.wouldSkip === true;
  }

  function runRecheck() {
    if (latchedResult?.latched && latchedResult.wouldSkip) return latchedResult;
    const result = evaluateSensitivePage();
    // Fresh full evaluation — feed the hot-path cache so keyup/scroll
    // handlers reuse it instead of re-walking the DOM.
    cacheEffectiveState(result);
    publishResultToPage(result);
    if (result.wouldSkip && cfg().enabled) {
      latchedResult = { ...result, latched: true, latchedAt: Date.now() };
      root.__pfSensitivePageDomActive = true;
      root.__pfSensitivePageDomResult = latchedResult;
      publishResultToPage(latchedResult);
      root.dispatchEvent(new CustomEvent('pf-sensitive-page-latched', { detail: latchedResult }));
      logDebug('latched sensitive page', latchedResult);
      // Latched — no further mutation-driven evaluation needed on this page.
      stopMutationObserver();
    } else {
      stableEvalCount += 1;
      if (stableEvalCount >= STABLE_EVALS_BEFORE_DISCONNECT) {
        logDebug('page stable after', stableEvalCount, 'evaluations — disconnecting observer');
        stopMutationObserver();
      }
    }
    return result;
  }

  function scheduleRecheck() {
    if (latchedResult?.latched && latchedResult.wouldSkip) return;
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runRecheck();
    }, cfg().recheckDebounceMs);
  }

  function startMutationObserver() {
    if (observer) return;
    if (!document.documentElement) return;
    observer = new MutationObserver(() => scheduleRecheck());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'type']
    });
  }

  function stopMutationObserver() {
    if (!observer) return;
    try { observer.disconnect(); } catch (_) { /* ignore */ }
    observer = null;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function resetLatchForNavigation() {
    latchedResult = null;
    root.__pfSensitivePageDomActive = false;
    root.__pfSensitivePageDomResult = null;
    invalidateEffectiveStateCache();
    // New page content incoming — re-arm mutation-driven evaluation.
    stableEvalCount = 0;
    startMutationObserver();
    scheduleRecheck();
  }

  function publishResultToPage(result) {
    try {
      const rootEl = document.documentElement;
      if (rootEl) {
        rootEl.setAttribute('data-pf-sensitive-detector-loaded', '1');
        rootEl.dataset.pfSensitiveWouldSkip = result?.wouldSkip ? '1' : '0';
        rootEl.dataset.pfSensitiveCategory = result?.category || '';
        rootEl.dataset.pfSensitiveReason = result?.reason || '';
        rootEl.dataset.pfSensitiveHostNorm = normalizeHostname(location.hostname);
      }
      let el = document.getElementById('__pf_sensitive_detector_result');
      if (!el) {
        el = document.createElement('script');
        el.id = '__pf_sensitive_detector_result';
        el.type = 'application/json';
        el.setAttribute('data-pf-internal', '1');
        (document.documentElement || document.head || document.body).appendChild(el);
      }
      el.textContent = JSON.stringify({
        ...result,
        requestId: Date.now(),
        hostname: location.hostname,
        hostnameNormalized: normalizeHostname(location.hostname),
        path: location.pathname
      });
    } catch (_) { /* ignore */ }
  }

  function injectPageConsoleBridge() {
    try {
      // bridgeInitDone guards the sync-parse + init() double call — the
      // dataset flag alone is only set in onload, so both calls could land
      // before it and inject two script tags.
      if (bridgeInitDone) return;
      bridgeInitDone = true;
      if (document.documentElement?.dataset?.pfSensitiveBridge === '1') return;
      const script = document.createElement('script');
      script.setAttribute('data-pf-internal', '1');
      script.src = chrome.runtime.getURL('sensitive_page_detector_page_bridge.js');
      script.onload = () => {
        document.documentElement.dataset.pfSensitiveBridge = '1';
        logDebug('page bridge loaded via extension URL');
      };
      script.onerror = () => {
        console.warn('[pf-sensitive-detector] page bridge script failed — use document.documentElement.dataset.pfSensitiveWouldSkip in page console');
        publishResultToPage(evaluateSensitivePage());
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (err) {
      console.warn('[pf-sensitive-detector] page bridge injection failed', err);
    }
  }

  let bridgeListenersInstalled = false;
  function installPageBridgeListeners() {
    if (bridgeListenersInstalled) return;
    bridgeListenersInstalled = true;
    document.addEventListener('pf-sensitive-detector-dry-run-request', () => {
      const result = evaluateSensitivePage({ forceLog: true });
      publishResultToPage(result);
      console.info('[pf-sensitive-dry-run]', result);
      if (result.breakdown?.length) console.table(result.breakdown);
    });
  }

  async function init() {
    await refreshConfig();
    injectPageConsoleBridge();
    installPageBridgeListeners();
    try {
      document.documentElement?.setAttribute('data-pf-sensitive-detector-loaded', '1');
    } catch (_) { /* ignore */ }
    logDebug('loaded on', location.hostname, '(dryRun:', cfg().dryRun, ')');

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.pfSensitiveDetectorConfig) {
          mergeConfig(changes.pfSensitiveDetectorConfig.newValue);
        }
      });
    } catch (_) { /* ignore */ }

    runRecheck();
    startMutationObserver();

    window.addEventListener('popstate', resetLatchForNavigation);
    window.addEventListener('hashchange', resetLatchForNavigation);
  }

  root.pfSensitiveDetectorDryRun = function pfSensitiveDetectorDryRun() {
    const result = evaluateSensitivePage({ forceLog: true });
    publishResultToPage(result);
    console.info('[pf-sensitive-dry-run] wouldSkip:', result.wouldSkip,
      'enforced:', result.enforced, '(dryRun:', result.dryRun, ')');
    console.info('[pf-sensitive-dry-run] category:', result.category, 'reason:', result.reason, 'score:', result.score);
    if (result.breakdown?.length) console.table(result.breakdown);
    if (result.signals?.settingsCarveOut) {
      console.info('[pf-sensitive-dry-run] settings carve-out ACTIVE — page would track normally');
    }
    return result;
  };

  // Synchronous init so API exists before consolidated_content.js runs.
  injectPageConsoleBridge();
  installPageBridgeListeners();
  try {
    document.documentElement?.setAttribute('data-pf-sensitive-detector-loaded', '1');
  } catch (_) { /* ignore */ }
  logDebug('script parsed on', location.hostname);

  root.__pfSensitivePageDetector = {
    init,
    refreshConfig,
    evaluate: evaluateSensitivePage,
    runRecheck,
    scheduleRecheck,
    shouldSkipTracking,
    shouldSkipTrackingDryRunPreview,
    getEffectiveState,
    resetLatchForNavigation,
    getConfig: () => ({ ...cfg() }),
    normalizeHostname,
    isLikelyAiHost
  };

  // Latch AI hosts before consolidated_content.js runs scrape path.
  try {
    runRecheck();
  } catch (err) {
    console.error('[pf-sensitive-detector] initial runRecheck failed', err);
  }
})();
