chrome.storage.local.get(["lastClosedContext", "userElo", "feedbackHistory", "urlScores"], async (data) => {
  const ctx = data.lastClosedContext;
  if (!ctx) return;

  let userElo = typeof data.userElo === "number" ? data.userElo : 5.0;
  const feedbackHistory = Array.isArray(data.feedbackHistory) ? data.feedbackHistory : [];
  const urlScores = data.urlScores || {};

  document.getElementById("conf").innerText = Math.round((ctx.confidence || 0) * 100) + "%";
  const wasEnforced = ctx.wasEnforced === true;
  document.getElementById('feedbackQuestion').innerText = wasEnforced
    ? 'Should I have left that open?'
    : 'Was this tab productive?';
  const domain = ctx.url ? (() => { try { return new URL(ctx.url).hostname.replace('www.',''); } catch(e) { return ''; } })() : '';
  document.getElementById('siteFavicon').src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  document.getElementById('siteDomain').innerText = domain;
  document.getElementById('siteTitle').innerText = ctx.title ? ctx.title.substring(0, 20) + (ctx.title.length > 20 ? '...' : '') : '';

  if (ctx.isTrap) {
    document.getElementById("trapWarning").style.display = 'block';
  }

  const sendFeedback = async (userSaysProductive, trusted = true) => {
    if (dismissed) return;
    const isTrap = ctx.isTrap === true;
    const extensionSaidUnproductive = ctx.classification === 'Unproductive';

    // ELO adjustments based on trap feedback and user honesty
    // Trap: high-confidence extension verdict contradicted by user = lower ELO
    // Normal: user confirms unproductive = slight ELO increase
    // User marks productive when extension was wrong = ELO increase (training signal)
    let eloDelta = 0;
    if (isTrap && userSaysProductive) {
      eloDelta = -0.4; // adversarial trap feedback
    } else if (!userSaysProductive && extensionSaidUnproductive) {
      eloDelta = 0.1; // user confirmed unproductive classification
    } else if (userSaysProductive && extensionSaidUnproductive) {
      eloDelta = 0.2; // user corrected a false unproductive classification
    }

    // ELO-weighted keyword deltas (uses stored Elo before worker applies feedback deltas)
    const feedbackWeight = userElo / 10;

    // Also adjust keyword weight if user confirmed unproductive
    if (!userSaysProductive && ctx.dominant_keyword) {
      await chrome.runtime.sendMessage({
        action: 'updateKeywordWeight',
        keyword: ctx.dominant_keyword,
        delta: -0.05 * feedbackWeight
      });
    } else if (userSaysProductive && ctx.dominant_keyword) {
      await chrome.runtime.sendMessage({
        action: 'updateKeywordWeight',
        keyword: ctx.dominant_keyword,
        delta: 0.05 * feedbackWeight
      });
    }

    const feedbackEntry = {
      timestamp: Date.now(),
      url: ctx.url || "",
      title: ctx.title || "",
      confidence: typeof ctx.confidence === "number" ? ctx.confidence : 0,
      classification: ctx.classification || "",
      productivity_score: ctx.productivity_score ?? null,
      dominant_keyword: ctx.dominant_keyword || "",
      keywords: Array.isArray(ctx.words) ? ctx.words.slice(0, 10) : [],
      userSaysProductive,
      isTrap,
      eloDelta,
      urlKey
    };

    feedbackHistory.push(feedbackEntry);

    await chrome.storage.local.set({
      feedbackHistory,
      urlScores,
      lastFeedbackEntry: feedbackEntry
    });

    try {
      await chrome.runtime.sendMessage({
        action: 'feedbackFromCard',
        userSaysProductive,
        isCorrect: !userSaysProductive,
        // Bot shadow-ban signal: false when the vote came from a synthetic
        // (untrusted) event — the worker flags the install sticky and the
        // vote never reaches the global dataset. UX identical either way.
        trusted
      });
    } catch (error) {
      console.warn(">=PlayingFild: Failed to broadcast updated Elo", error);
    }

    dismissed = true;
    if (userSaysProductive === true) {
      document.body.classList.add('success-tint');
    }
    if (userSaysProductive === false) {
      document.body.classList.add('error-tint');
    }
    setTimeout(() => window.close(), 800);
  };

  // Trust rides on the ORIGINATING event: a physical click/keypress is
  // isTrusted:true; script-driven clicks are not. The keyboard shortcuts
  // call sendFeedback directly (btn.click() would synthesize an untrusted
  // click and wrongly flag legitimate keyboard users as bots).
  document.getElementById("yesBtn").onclick = (e) => sendFeedback(false, e?.isTrusted === true); // "Yes, it was" = tab was unproductive
  document.getElementById("noBtn").onclick = async (e) => {
    if (ctx.wasEnforced && ctx.url) {
      chrome.tabs.create({ url: ctx.url });
    }
    await sendFeedback(true, e?.isTrusted === true);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === '.') void sendFeedback(false, e.isTrusted === true);
    if (e.key === ',') {
      if (ctx.wasEnforced && ctx.url) chrome.tabs.create({ url: ctx.url });
      void sendFeedback(true, e.isTrusted === true);
    }
  });
  // Automation environment → flag the install (shadow; nothing changes here).
  if (navigator.webdriver === true || /HeadlessChrome/i.test(navigator.userAgent || '')) {
    try { chrome.runtime.sendMessage({ action: 'pfFlagBotSuspect' }); } catch (_) { /* best-effort */ }
  }
  let dismissed = false;
  let timer = setTimeout(() => { if (!dismissed) window.close(); }, 10000);
  document.body.addEventListener('mouseenter', () => clearTimeout(timer));
  document.body.addEventListener('mouseleave', () => { timer = setTimeout(() => { if (!dismissed) window.close(); }, 5000); });
});
