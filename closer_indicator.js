(function () {
  // Same-world double-injection guard (e.g. both manifest entries matching).
  // NOTE: after an extension reload, programmatic re-injection runs in a NEW
  // isolated world where this flag is invisible — that case is handled by
  // the cross-world takeover below (DOM is shared between worlds; globals
  // are not).
  if (window.__pfCloserIndicatorLoaded) return;
  window.__pfCloserIndicatorLoaded = true;

  // Cross-world takeover: after an extension reload the previous copy is
  // orphaned (dead chrome.runtime — no prompts, no timers, no state pushes)
  // but its DOM and intervals live on. Remove any stale UI it left behind,
  // then announce ourselves so the old copy (which also listens for this
  // event) stands down instead of double-painting/polling forever.
  let pfTakenOver = false;
  const PF_CI_TOKEN = `${Date.now()}-${Math.random()}`;
  // Shared cross-copy secret (security review 2026-07): chrome.runtime.id
  // is the same for every isolated-world content-script copy of the same
  // extension, but page scripts (main world) don't have `chrome` at all,
  // so they cannot read it and cannot forge a takeover event. Using
  // runtime.id as the secret means the takeover mechanic still works
  // between the new isolated-world copy and any orphaned old copy from
  // before an extension reload, while page scripts get filtered out.
  const PF_CI_SHARED_SECRET =
    (typeof chrome !== 'undefined' && chrome?.runtime?.id) || 'pf-ci-fallback-secret';
  for (const staleId of [
    'pf-closer-indicator-host',
    'pf-closer-indicator-iframe-host',
    'pf-yt-video-prompt-host',
    'pf-fs-dialog'
  ]) {
    try { document.getElementById(staleId)?.remove(); } catch (_) {}
  }
  document.addEventListener('pf-closer-indicator-takeover', (e) => {
    const detail = e?.detail;
    // Legacy detail shape (string token) — reject; must be signed object.
    if (!detail || typeof detail !== 'object') return;
    // Missing / wrong secret → came from a page script (no access to
    // chrome.runtime.id) or an unrelated event. Ignore.
    if (detail.secret !== PF_CI_SHARED_SECRET) return;
    // Same token → this is US dispatching to ourselves; do nothing.
    if (detail.token === PF_CI_TOKEN) return;
    // Different token, same secret → a sibling isolated-world copy
    // (orphan from before extension reload) is announcing itself. Stand
    // down so it can take over.
    pfTakenOver = true;
    try { stopLocalTick(); } catch (_) {}
    try { document.getElementById('pf-closer-indicator-host')?.remove(); } catch (_) {}
  });
  try {
    document.dispatchEvent(new CustomEvent('pf-closer-indicator-takeover', {
      detail: { token: PF_CI_TOKEN, secret: PF_CI_SHARED_SECRET }
    }));
  } catch (_) {}

  const PF_DEBUG = false; // Set to true for verbose diagnostics

  // OFF-hold reverted to 5s per user spec 2026-07 v2 (7s felt too long —
  // disarming the closer). ON stays a quick 2s.
  const HOLD_OFF_MS = 5000;
  const HOLD_ON_MS = 2000;
  const UNREADABLE_UI_DELAY_MS = 3000;

  if (!/^https?:$/i.test(location.protocol)) return;

  // When loaded inside an iframe (e.g. a YouTube embed on a third-party
  // page), the only reason we're here is to show the indicator when THIS
  // iframe goes fullscreen — the top-level page already has its own
  // indicator running. Skip the full per-page rendering loop in that case
  // and only register a tiny fullscreen listener that asks the SW to
  // re-broadcast state when the iframe enters fullscreen so we can paint
  // the indicator inside the fullscreen viewport.
  if (window !== window.top) {
    const setupIframeFullscreenIndicator = () => {
      let host = null;
      let attachedTo = null;
      // Per Gemini debug: the YouTube embed iframe runs requestFullscreen on
      // a specific child div (typically `div.html5-video-player`), NOT on
      // the iframe's <html> or <body>. That div is what gets promoted to the
      // browser top layer. Anything inside the iframe BUT outside that div
      // gets blanked. So we must append the pill INSIDE the fullscreen
      // target itself (or one of its ancestors that's also in the top
      // layer) — then position:absolute relative to it.
      const showIndicatorInIframe = () => {
        const fsTarget = document.fullscreenElement || document.webkitFullscreenElement;
        if (!fsTarget) return;
        // If the pill already exists but is parented somewhere stale (e.g.
        // a previous fullscreen target), move it onto the current one.
        if (host && attachedTo !== fsTarget) {
          try { host.remove(); } catch (_) {}
          host = null;
        }
        if (host) return;
        host = document.createElement('div');
        host.id = 'pf-closer-indicator-iframe-host';
        // Wrapper host: pointer-events:none so the area around the pill
        // (within the bounding box) doesn't intercept clicks meant for
        // YouTube's scrubber/controls beneath. z-index pinned to MAX so
        // YouTube's own control bar (.ytp-chrome-bottom etc.) can't paint
        // over the pill — they use their own stacking contexts inside
        // div.html5-video-player.
        host.style.cssText = 'all:initial !important;position:absolute !important;right:24px !important;bottom:80px !important;z-index:2147483647 !important;pointer-events:none !important;';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <style>
            .wrap {
              position: relative;
              width: 36px;
              height: 36px;
              filter: drop-shadow(0 2px 7px rgba(0, 0, 0, 0.28));
              pointer-events: auto !important;
            }
            .ring {
              position: absolute;
              /* v83: matched to .pf-progress-ring so the fullscreen/iframe
                 fallback indicator is the same size as the normal one —
                 outer radius 15, opaque from 11, under the 11.5 button. */
              inset: 3px;
              border-radius: 50%;
              background: conic-gradient(#28a745 0deg, #28a745 0deg, rgba(40,167,69,0.18) 0deg, rgba(40,167,69,0.18) 360deg);
              -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
                      mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
              pointer-events: none;
            }
            .btn {
              position: absolute;
              top: 6.5px;
              left: 6.5px;
              width: 23px;
              height: 23px;
              border-radius: 50%;
              background: radial-gradient(circle at 38% 32%, #2a313a 0%, #12151a 72%);
              box-shadow:
                inset 0 1px 1px rgba(255, 255, 255, 0.12),
                inset 0 -2px 3px rgba(0, 0, 0, 0.55);
              pointer-events: none;
            }
            .time {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              font-family: -apple-system, system-ui, sans-serif;
              font-size: 9px;
              font-weight: 800;
              color: #cdd5e0;
              font-variant-numeric: tabular-nums;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
              pointer-events: none;
              line-height: 1;
              z-index: 2;
              user-select: none;
            }
          </style>
          <div class="wrap">
            <div class="ring" id="pf-iframe-ring"></div>
            <div class="btn"></div>
            <span class="time" id="t">--:--</span>
          </div>
        `;
        // Append directly to whatever element is currently fullscreen — it
        // (and our pill as its descendant) renders in the top layer.
        try {
          fsTarget.appendChild(host);
          attachedTo = fsTarget;
        } catch (e) {
          // Replaced-element (video / canvas) can't have children. Walk up.
          let target = fsTarget.parentNode;
          while (target && target.nodeType === 1 && ['VIDEO','IMG','CANVAS'].includes(target.tagName)) {
            target = target.parentNode;
          }
          if (target && target.nodeType === 1) {
            try { target.appendChild(host); attachedTo = target; }
            catch (_) { host = null; attachedTo = null; }
          } else {
            host = null;
            attachedTo = null;
          }
        }
      };
      const hideIndicatorInIframe = () => {
        if (host) { try { host.remove(); } catch (_) {} host = null; attachedTo = null; }
      };
      const updateText = (text, ringDeg) => {
        if (!host) return;
        const t = host.shadowRoot?.getElementById('t');
        if (t && text) t.textContent = text;
        const ring = host.shadowRoot?.getElementById('pf-iframe-ring');
        if (ring && ringDeg != null) {
          ring.style.background = `conic-gradient(#28a745 0deg, #28a745 ${ringDeg}deg, rgba(40,167,69,0.18) ${ringDeg}deg, rgba(40,167,69,0.18) 360deg)`;
        }
      };
      const onFullscreenChange = () => {
        const fsActive = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (fsActive) {
          showIndicatorInIframe();
          try {
            chrome.runtime?.sendMessage?.({ action: 'pfRequestCloserState' }).catch(() => {});
          } catch (_) {}
        } else {
          hideIndicatorInIframe();
        }
      };
      try {
        chrome.runtime?.onMessage?.addListener?.((msg) => {
          if (msg?.action !== 'pfCloserStateUpdate' || !msg.state) return;
          // If we're fullscreen but missed the change event for some reason,
          // ensure the pill is up.
          const fsActive = !!(document.fullscreenElement || document.webkitFullscreenElement);
          if (fsActive && !host) showIndicatorInIframe();
          if (!host) return;
          const s = msg.state;
          if (!(Number(s.timerStartedAt) > 0 && s.timerActive !== false)) return;
          const remaining = Math.max(0, Math.floor(Number(s.timerRemainingSec) || 0));
          const total = Math.max(0, Math.floor(Number(s.timerTotalSec) || 0));
          const elapsed = total > 0
            ? Math.min(total, Math.max(0, total - remaining))
            : Math.max(0, Math.floor(Number(s.timerElapsedSec) || 0));
          const ringDeg = total > 0 ? Math.min(360, Math.max(0, (elapsed / total) * 360)) : 0;
          const h = Math.floor(remaining / 3600);
          const m = Math.floor((remaining % 3600) / 60);
          const sec = remaining % 60;
          const text = h > 0
            ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
            : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
          updateText(text, ringDeg);
        });
      } catch (_) {}
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    };
    setupIframeFullscreenIndicator();
    return; // Skip the rest of the file — top-level indicator handles everything else.
  }

  const pfSensitivePageOnly = globalThis.__pfSensitivePageActive === true;
  if (pfSensitivePageOnly) {
    console.info('[pf-privacy] closer indicator — toggle-only mode (no page reads)');
  }

  function normalizeSensitiveToggleState(state) {
    if (!pfSensitivePageOnly || !state) return state;
    return {
      ...state,
      hideIndicator: false,
      siteUnreadable: false
    };
  }

  function pfReplaceHtml(parent, html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    parent.replaceChildren(...Array.from(doc.body.childNodes));
  }

  if (PF_DEBUG) console.info('[pf-indicator] script loaded on', location.href);

  // ── Per-video YouTube timer prompt ──────────────────────────────────────
  // When the user starts a new video on YouTube and that tab is classified
  // as Unproductive, ask whether they want to set a timer for either the
  // FULL video length or HALF (for 2x playback). Independent of the
  // cumulative-threshold reminder — fires per video (deduped by video id).
  // Honours the same dashboard enable toggle (unprodReminderSettings.enabled).
  (function setupYouTubePerVideoPrompt() {
    if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;
    const promptedVideoIds = new Set();
    // Re-entry guard for handlePotentialNewVideo — tracks which video id is
    // currently being processed (metadata wait / ad wait / prompt decision).
    // Prevents concurrent retry chains from rapid SPA URL changes.
    let pendingVideoVid = null;
    let activePromptHost = null;

    const currentVideoId = () => {
      try {
        const u = new URL(location.href);
        if (u.pathname !== '/watch') return null;
        return u.searchParams.get('v') || null;
      } catch (_) { return null; }
    };

    const findLongestVideoDuration = () => {
      try {
        let best = 0;
        for (const v of document.querySelectorAll('video')) {
          const d = Number(v.duration);
          if (!Number.isFinite(d) || d <= 0 || d > 24 * 3600) continue;
          if (d > best) best = d;
        }
        return best;
      } catch (_) { return 0; }
    };

    const findMainVideoEl = () => {
      try {
        let best = null;
        let bestD = 0;
        for (const v of document.querySelectorAll('video')) {
          const d = Number(v.duration);
          if (!Number.isFinite(d) || d <= 0 || d > 24 * 3600) continue;
          if (d > bestD) { best = v; bestD = d; }
        }
        return best;
      } catch (_) { return null; }
    };

    // ── Video-end watcher ────────────────────────────────────────────────
    // The wall-clock timer is only an ESTIMATE of when the video will finish
    // (ads, buffering, pauses, and the safety cushion all add drift). The
    // authoritative signal is the video actually reaching its end, at which
    // point the worker expires the break immediately.
    //
    // CRITICAL — ads: YouTube plays ads through the SAME <video> element,
    // temporarily swapping in the ad's duration/currentTime. Without the
    // ad guards below, an ad finishing looks exactly like "remaining <= 1"
    // and the break force-expired mid-video (the "timer is still off" bug).
    const isAdShowing = () => {
      try {
        return !!document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
      } catch (_) { return false; }
    };

    let videoEndWatchId = null;
    let watchedVideoEl = null;
    let onWatchedVideoEnded = null;
    // Cleanup for the 2×-enforcement listeners installed by startTimer.
    // Without this they stayed on the <video> element (which YouTube REUSES
    // across SPA navigations) forever — one "2× speed" choice forced every
    // later video in the tab back to 2×.
    let enforce2xCleanup = null;
    const stopVideoEndWatcher = (opts = {}) => {
      if (videoEndWatchId) { clearInterval(videoEndWatchId); videoEndWatchId = null; }
      if (watchedVideoEl && onWatchedVideoEnded) {
        try { watchedVideoEl.removeEventListener('ended', onWatchedVideoEnded); } catch (_) {}
      }
      watchedVideoEl = null;
      onWatchedVideoEnded = null;
      // keepRateEnforcement: startVideoEndWatcher() restarts the watcher
      // right after startTimer installs fresh 2× enforcement — don't tear
      // that down. Every other stop (video end, URL change, pagehide,
      // takeover) removes it.
      if (!opts.keepRateEnforcement && enforce2xCleanup) {
        try { enforce2xCleanup(); } catch (_) {}
      }
    };
    const startVideoEndWatcher = (vid) => {
      stopVideoEndWatcher({ keepRateEnforcement: true });
      if (!vid) return;
      let lastSeenRealRemainingSec = Infinity;
      // VIDEO-SYNC baseline (2026-07): last tick's rate-adjusted remaining,
      // used to detect JUMPS (seek / speed change) vs natural ~3s decay.
      let lastRealRemainingForSync = null;
      let endSignalSent = false;

      const sendVideoEnded = () => {
        if (endSignalSent) return;
        // Never treat an AD finishing as the video finishing.
        if (isAdShowing()) return;
        endSignalSent = true;
        stopVideoEndWatcher();
        console.info('[pf-yt-timer] video ended — asking worker to finish the break now');
        try {
          chrome.runtime.sendMessage({ action: 'pfVideoBreakVideoEnded' }).catch(() => {});
        } catch (_) {}
      };

      // Primary signal: the real 'ended' event. It's event-driven, so it
      // still fires in throttled background tabs, and it beats autoplay's
      // navigation to the next video.
      onWatchedVideoEnded = () => {
        // Guard: 'ended' also fires when an ad's media resource ends, and
        // ad durations are short — require the element to be carrying the
        // real (long) video, not a clip-length ad.
        const d = Number(watchedVideoEl?.duration);
        if (!Number.isFinite(d) || d < MIN_VIDEO_LENGTH_SEC) return;
        sendVideoEnded();
      };
      const hookEndedListener = () => {
        const v = findMainVideoEl();
        if (!v || v === watchedVideoEl) return;
        if (watchedVideoEl && onWatchedVideoEnded) {
          try { watchedVideoEl.removeEventListener('ended', onWatchedVideoEnded); } catch (_) {}
        }
        watchedVideoEl = v;
        try { v.addEventListener('ended', onWatchedVideoEnded); } catch (_) {}
      };
      hookEndedListener();

      videoEndWatchId = setInterval(() => {
        const nowVid = currentVideoId();
        if (nowVid !== vid) {
          // URL changed. If the watched video was in its final seconds the
          // last time we looked, this is autoplay advancing past an 'ended'
          // we may have missed — count it as the video ending. Otherwise
          // the user navigated manually; leave the timer running.
          if (lastSeenRealRemainingSec <= 20) sendVideoEnded();
          else stopVideoEndWatcher();
          return;
        }
        if (isAdShowing()) return; // duration/currentTime belong to the ad right now
        hookEndedListener(); // YouTube can swap <video> elements mid-page
        const v = watchedVideoEl || findMainVideoEl();
        if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
        // Duration sanity: if the element is carrying a short (ad-length)
        // resource, none of its numbers describe the real video.
        if (v.duration < MIN_VIDEO_LENGTH_SEC) return;
        const rate = Math.max(0.25, Number(v.playbackRate) || 1);
        const realRemaining = (v.duration - (Number(v.currentTime) || 0)) / rate;
        // VIDEO-SYNC (2026-07 user spec: "if they skip a part of the video
        // the timer updates to it"). While playing, the rate-adjusted
        // remaining decays ~3s per 3s tick; a SEEK or SPEED CHANGE shows up
        // as a jump. On a jump, tell the worker to re-anchor the per-video
        // break timer to the video's real remaining. Paused videos (decay 0,
        // deviation 3s) and normal playback stay under the 8s threshold, so
        // the countdown never churns — only genuine skips resync. All the
        // ad-guards above already ran, so these numbers are the REAL video's.
        if (lastRealRemainingForSync != null) {
          const expected = lastRealRemainingForSync - 3;
          if (Math.abs(realRemaining - expected) > 8 && realRemaining > 2) {
            try {
              chrome.runtime.sendMessage({
                action: 'pfVideoScopedSyncRemaining',
                videoId: vid,
                remainingSec: Math.max(1, Math.ceil(realRemaining))
              }).catch(() => {});
            } catch (_) { /* runtime unavailable — next tick retries */ }
          }
        }
        lastRealRemainingForSync = realRemaining;
        lastSeenRealRemainingSec = realRemaining;
        if (v.ended || realRemaining <= 2) sendVideoEnded();
      }, 3000);
    };

    const isCurrentTabUnprod = () => {
      // currentState is declared later in the IIFE (line ~1421) but our
      // callers run via setTimeout / popstate, well after it's initialised.
      // tabClassification is included in the synthesized closer state.
      // Err on the side of NOT prompting if we don't have a fresh
      // classification yet (undefined state).
      try {
        return typeof currentState !== 'undefined' &&
          currentState?.tabClassification === 'Unproductive';
      } catch (_) { return false; }
    };

    // Per-video YouTube prompt has its OWN dashboard setting
    // (ytVideoTimerSettings). Default OFF as of user spec 2026-07 v24 —
    // during onboarding the long-YouTube-video prompt should not auto-fire.
    // Users opt in via the "Suggest a timer on long YouTube videos"
    // checkbox in the Reminders dropdown.
    const isReminderEnabled = () => new Promise((resolve) => {
      try {
        chrome.storage.local.get('ytVideoTimerSettings', (s) => {
          const enabled = s?.ytVideoTimerSettings?.enabled === true;
          resolve(enabled);
        });
      } catch (_) { resolve(false); }
    });

    const injectPrompt = (videoId, durationSec) => {
      if (activePromptHost) return;
      const HOST_ID = 'pf-yt-video-prompt-host';
      if (document.getElementById(HOST_ID)) return;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;color-scheme:light;font-family:-apple-system,system-ui,Segoe UI,sans-serif;pointer-events:none;';
      document.documentElement.appendChild(host);
      activePromptHost = host;
      const shadow = host.attachShadow({ mode: 'open' });
      const fullMin = Math.max(1, Math.min(240, Math.ceil(durationSec / 60)));
      const halfMin = Math.max(1, Math.min(240, Math.ceil(durationSec / 120)));
      const formatDur = (sec) => {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
      };
      shadow.innerHTML = `
        <style>
          @keyframes pf-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes pf-card-in {
            from { opacity: 0; transform: translateY(8px) scale(0.97); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          .backdrop {
            position: fixed; inset: 0;
            display: flex; align-items: center; justify-content: center;
            background: rgba(20, 16, 40, 0.32);
            -webkit-backdrop-filter: blur(6px) saturate(120%);
            backdrop-filter: blur(6px) saturate(120%);
            animation: pf-fade-in 0.18s ease;
            pointer-events: auto;
          }
          .card {
            width: 360px; max-width: calc(100vw - 32px);
            padding: 22px 24px 20px; border-radius: 18px;
            color: #1f1b2e;
            background: rgba(255, 255, 255, 0.78);
            -webkit-backdrop-filter: blur(22px) saturate(180%);
            backdrop-filter: blur(22px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.55);
            box-shadow: 0 20px 50px rgba(20,16,40,0.28), 0 1px 0 rgba(255,255,255,0.6) inset;
            animation: pf-card-in 0.22s cubic-bezier(0.2,0.8,0.2,1) both;
          }
          .title { font-weight:700; color:#5B4B9F; margin:0 0 6px; font-size:1.05em; }
          .body { font-size:0.92em; color:#2a2438; margin:0 0 14px; line-height:1.45; }
          .body small { display:block; margin-top:6px; color:#6b6580; font-size:0.85em; }
          .actions { display:flex; flex-direction:column; gap:8px; }
          .btn {
            padding: 11px 14px; border:none; border-radius:10px;
            cursor:pointer; font-weight:600; font-size:0.92em; font-family:inherit;
            transition: background 0.12s ease, transform 0.06s ease;
          }
          .btn:active { transform: translateY(1px); }
          .btn-primary {
            background: linear-gradient(180deg, #6c5cb5 0%, #5B4B9F 100%);
            color: #fff;
            box-shadow: 0 2px 6px rgba(91,75,159,0.35), 0 1px 0 rgba(255,255,255,0.18) inset;
          }
          .btn-primary:hover { background: linear-gradient(180deg, #7869c1 0%, #5040a3 100%); }
          .btn-half {
            background: rgba(91,75,159,0.12);
            color: #4a3d83;
            border: 1px solid rgba(91,75,159,0.3);
          }
          .btn-half:hover { background: rgba(91,75,159,0.2); }
          .btn-ignore {
            background: transparent; color: #6b6580; font-size: 0.86em;
            padding: 7px 12px;
          }
          .btn-ignore:hover { color: #4a4458; background: rgba(91,75,159,0.06); }
          @media (prefers-color-scheme: dark) {
            .card { background: rgba(30,28,46,0.72); color:#f0eefb; border-color: rgba(255,255,255,0.1); }
            .title { color:#c7bdff; }
            .body { color:#e2dff0; }
            .body small { color:#a5a0c0; }
            .btn-half { background: rgba(199,189,255,0.12); color: #c7bdff; border-color: rgba(199,189,255,0.3); }
            .btn-half:hover { background: rgba(199,189,255,0.2); }
            .btn-ignore { color: #a5a0c0; }
            .btn-ignore:hover { color: #f0eefb; background: rgba(255,255,255,0.06); }
          }
        </style>
        <div class="backdrop">
          <div class="card" role="dialog" aria-modal="false">
            <p class="title">Set a timer for this video?</p>
            <p class="body">
              This video is ${formatDur(durationSec)}. Start an unproductive timer matching the runtime so tabs auto-close when it ends?
              <small>Pick "Half" if you'll watch at 2× speed.</small>
            </p>
            <div class="actions">
              <button class="btn btn-primary" id="pfYtFull" type="button">Watch full (${fullMin}m timer)</button>
              <button class="btn btn-half" id="pfYtHalf" type="button">2× speed (${halfMin}m timer)</button>
              <button class="btn btn-ignore" id="pfYtIgnore" type="button">Not this video</button>
            </div>
          </div>
        </div>
      `;
      // Trap page keys (don't let space toggle play/pause behind modal).
      const keyTrap = (e) => {
        if (e.target === host || (host.contains && host.contains(e.target))) return;
        e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      };
      document.addEventListener('keydown', keyTrap, true);
      document.addEventListener('keyup', keyTrap, true);
      document.addEventListener('keypress', keyTrap, true);
      // Per user spec (2026-07): when the modal blocks interaction with the
      // video behind it, also PAUSE the video. Without this, the audio kept
      // playing while the user was reading the prompt. Track which videos
      // we paused so we don't accidentally resume ones the user had already
      // paused themselves.
      const pausedByPrompt = new Set();
      try {
        const vids = Array.from(document.querySelectorAll('video'));
        for (const v of vids) {
          if (v && !v.paused && !v.ended) {
            pausedByPrompt.add(v);
            try { v.pause(); } catch (_) {}
          }
        }
        // Also nudge the YouTube player API — some pages ignore direct
        // <video>.pause() calls until the player is re-initialised.
        const yt = document.getElementById('movie_player');
        if (yt && typeof yt.pauseVideo === 'function') {
          try { yt.pauseVideo(); } catch (_) {}
        }
      } catch (_) {}
      const close = () => {
        try { document.removeEventListener('keydown', keyTrap, true); } catch (_) {}
        try { document.removeEventListener('keyup', keyTrap, true); } catch (_) {}
        try { document.removeEventListener('keypress', keyTrap, true); } catch (_) {}
        try { host.remove(); } catch (_) {}
        if (activePromptHost === host) activePromptHost = null;
        // Note: we intentionally do NOT auto-resume the video here. If the
        // user clicked "Watch full" / "2× speed" we WANT the video paused
        // for the split-second before the timer widget attaches — they'll
        // hit play themselves. If they clicked "Not this video" they're
        // choosing to not opt in, so leave it paused rather than surprising
        // them with sudden audio.
      };
      const startTimer = (mins, rate = 1) => {
        try {
          // Recompute from the video's ACTUAL remaining runtime at click
          // time (the prompt's minute figures were rounded up from the full
          // duration and go stale if the user is already partway in), at the
          // chosen playback speed. Previously we added a 60s cushion so the
          // wall-clock backstop never fired mid-video, but the user reported
          // the timer running ~1 minute past the real video time — the
          // cushion was that minute. Dropped: the video-end watcher fires
          // the real ended-event and short-circuits the timer, so the
          // cushion isn't needed as long as the countdown matches reality.
          let timerSec = Math.max(1, mins * 60);
          const v = findMainVideoEl();
          // Ad guard: if an ad is playing (or the element is carrying an
          // ad-length resource) the live duration/currentTime are the AD's —
          // fall back to the full-video estimate captured at prompt time.
          if (!isAdShowing() && v && Number.isFinite(v.duration) && v.duration >= MIN_VIDEO_LENGTH_SEC) {
            const remaining = Math.max(0, v.duration - (Number(v.currentTime) || 0));
            timerSec = Math.max(1, Math.ceil(remaining / (rate || 1)));
          } else {
            timerSec = Math.max(1, Math.ceil(durationSec / (rate || 1)));
          }
          // The 2× option assumes 2× playback. Force it now AND re-apply
          // whenever YouTube tries to snap it back (they reset on player
          // events like buffer / ad-transition / next-video preload). Guard
          // is cleared when the video ends or the URL changes.
          if (rate === 2 && v) {
            try { v.playbackRate = 2; } catch (_) {}
            try {
              const enforce2x = () => {
                if (!v || v.playbackRate === 2) return;
                try { v.playbackRate = 2; } catch (_) {}
              };
              // Replace (never stack) any previous enforcement — and make it
              // removable: stopVideoEndWatcher() (video end / URL change /
              // new timer) tears these down so 2× doesn't leak onto the
              // NEXT video played through the same reused <video> element.
              if (enforce2xCleanup) { try { enforce2xCleanup(); } catch (_) {} }
              v.addEventListener('ratechange', enforce2x);
              v.addEventListener('play', enforce2x);
              v.addEventListener('seeked', enforce2x);
              enforce2xCleanup = () => {
                try { v.removeEventListener('ratechange', enforce2x); } catch (_) {}
                try { v.removeEventListener('play', enforce2x); } catch (_) {}
                try { v.removeEventListener('seeked', enforce2x); } catch (_) {}
                enforce2xCleanup = null;
              };
              // Also try the YouTube player API for good measure.
              const yt = document.getElementById('movie_player');
              if (yt && typeof yt.setPlaybackRate === 'function') {
                try { yt.setPlaybackRate(2); } catch (_) {}
              }
            } catch (_) {}
          }
          activeTimerVideoId = videoId;
          chrome.runtime.sendMessage({
            action: 'startUnprodReminderBreak',
            // worker resolves windowName from windowId if not provided —
            // omit it; the message handler falls back to active tab.
            durationSec: timerSec,
            // Video-scoped: this timer belongs to THIS video. The worker
            // pauses it whenever the user isn't watching (other video,
            // other tab, other site), and a new video's prompt can
            // override it.
            videoScoped: true,
            videoId,
          }).catch(() => {});
          startVideoEndWatcher(videoId);
        } catch (_) {}
        close();
      };
      shadow.getElementById('pfYtFull').addEventListener('click', () => startTimer(fullMin, 1));
      shadow.getElementById('pfYtHalf').addEventListener('click', () => startTimer(halfMin, 2));
      shadow.getElementById('pfYtIgnore').addEventListener('click', close);
      // Click-outside dismiss (per user spec 2026-07): clicking anywhere
      // on the backdrop (outside the card) closes the prompt. The card
      // itself stops propagation so button clicks / text selection
      // don't trigger the dismiss.
      const backdrop = shadow.querySelector('.backdrop');
      const card = shadow.querySelector('.card');
      if (backdrop) {
        backdrop.addEventListener('click', (e) => {
          if (card && (e.target === card || card.contains(e.target))) return;
          close();
        });
      }
    };

    // Break-time override prompt: shown when a break/unprod timer is already
    // running and the current video is longer than the remaining break time.
    // Two options: (1) watch the full video — the excess minutes get deducted
    // from the user's other time (open-ended per user spec); (2) accept the
    // cutoff — video will be cut off when the break runs out. A note at the
    // bottom says this can be switched off in the dashboard.
    const injectBreakOverridePrompt = (videoId, videoDurSec, breakRemainingSec) => {
      if (activePromptHost) return;
      const HOST_ID = 'pf-yt-video-prompt-host';
      if (document.getElementById(HOST_ID)) return;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;color-scheme:light;font-family:-apple-system,system-ui,Segoe UI,sans-serif;pointer-events:none;';
      const attachTo = () => document.fullscreenElement || document.documentElement;
      attachTo().appendChild(host);
      const rehome = () => {
        try {
          const dest = attachTo();
          if (host.parentNode !== dest) dest.appendChild(host);
        } catch (_) {}
      };
      document.addEventListener('fullscreenchange', rehome, true);
      activePromptHost = host;
      const shadow = host.attachShadow({ mode: 'open' });
      const videoMin = Math.max(1, Math.ceil(videoDurSec / 60));
      const breakMin = Math.max(1, Math.ceil(breakRemainingSec / 60));
      const deductSec = Math.max(60, videoDurSec - breakRemainingSec);
      const deductMin = Math.max(1, Math.ceil(deductSec / 60));
      shadow.innerHTML = `
        <style>
          @keyframes pf-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes pf-card-in {
            from { opacity: 0; transform: translateY(8px) scale(0.97); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          .backdrop { position: fixed; inset: 0;
            display: flex; align-items: center; justify-content: center;
            background: rgba(20, 16, 40, 0.32);
            -webkit-backdrop-filter: blur(6px) saturate(120%);
            backdrop-filter: blur(6px) saturate(120%);
            animation: pf-fade-in 0.18s ease; pointer-events: auto; }
          .card { width: 400px; max-width: calc(100vw - 32px);
            padding: 22px 24px 20px; border-radius: 18px; color: #1f1b2e;
            background: rgba(255, 255, 255, 0.86);
            -webkit-backdrop-filter: blur(22px) saturate(180%);
            backdrop-filter: blur(22px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.55);
            box-shadow: 0 20px 50px rgba(20,16,40,0.28), 0 1px 0 rgba(255,255,255,0.6) inset;
            animation: pf-card-in 0.22s cubic-bezier(0.2,0.8,0.2,1) both; }
          .title { font-weight: 700; color: #5B4B9F; margin: 0 0 8px; font-size: 1.1em; }
          .body { font-size: 0.94em; color: #2a2438; margin: 0 0 16px; line-height: 1.5; }
          .actions { display:flex; flex-direction:column; gap:8px; }
          .btn { padding: 11px 14px; border:none; border-radius:10px; cursor:pointer;
            font-weight: 600; font-size: 0.92em; font-family: inherit;
            transition: background 0.12s ease, transform 0.06s ease; }
          .btn:active { transform: translateY(1px); }
          .btn-primary { background: linear-gradient(180deg, #6c5cb5 0%, #5B4B9F 100%);
            color: #fff; box-shadow: 0 2px 6px rgba(91,75,159,0.35), 0 1px 0 rgba(255,255,255,0.18) inset; }
          .btn-primary:hover { background: linear-gradient(180deg, #7869c1 0%, #5040a3 100%); }
          .btn-secondary { background: rgba(91,75,159,0.12); color: #4a3d83; border: 1px solid rgba(91,75,159,0.3); }
          .btn-secondary:hover { background: rgba(91,75,159,0.2); }
          .note { margin: 12px 0 0; font-size: 0.8em; color: #6b6580; text-align: center; line-height: 1.4; }
          @media (prefers-color-scheme: dark) {
            .card { background: rgba(30,28,46,0.78); color: #f0eefb; border-color: rgba(255,255,255,0.1); }
            .title { color: #c7bdff; } .body { color: #e2dff0; }
            .btn-secondary { background: rgba(199,189,255,0.12); color: #c7bdff; border-color: rgba(199,189,255,0.3); }
            .btn-secondary:hover { background: rgba(199,189,255,0.2); }
            .note { color: #a5a0c0; }
          }
        </style>
        <div class="backdrop">
          <div class="card" role="dialog" aria-modal="false">
            <p class="title">This video is longer than your break</p>
            <p class="body">Video is ${videoMin}m, you have ${breakMin}m left. You can watch the full thing but ${deductMin}m will be deducted from your other time, or let the video cut off when your break runs out.</p>
            <div class="actions">
              <button class="btn btn-primary" id="pfBOFull" type="button">Watch full (deduct ${deductMin}m)</button>
              <button class="btn btn-secondary" id="pfBOCutoff" type="button">Cut off in ${breakMin}m</button>
            </div>
            <p class="note">This can be switched off in the dashboard.</p>
          </div>
        </div>
      `;
      const keyTrap = (e) => {
        if (e.target === host || (host.contains && host.contains(e.target))) return;
        e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      };
      document.addEventListener('keydown', keyTrap, true);
      document.addEventListener('keyup', keyTrap, true);
      document.addEventListener('keypress', keyTrap, true);
      // Pause the video behind the modal (per user spec 2026-07). Same
      // pattern as the per-video prompt above.
      try {
        for (const v of document.querySelectorAll('video')) {
          if (v && !v.paused && !v.ended) { try { v.pause(); } catch (_) {} }
        }
        const yt = document.getElementById('movie_player');
        if (yt && typeof yt.pauseVideo === 'function') {
          try { yt.pauseVideo(); } catch (_) {}
        }
      } catch (_) {}
      const close = () => {
        try { document.removeEventListener('keydown', keyTrap, true); } catch (_) {}
        try { document.removeEventListener('keyup', keyTrap, true); } catch (_) {}
        try { document.removeEventListener('keypress', keyTrap, true); } catch (_) {}
        try { document.removeEventListener('fullscreenchange', rehome, true); } catch (_) {}
        try { host.remove(); } catch (_) {}
        if (activePromptHost === host) activePromptHost = null;
      };
      shadow.getElementById('pfBOFull').addEventListener('click', () => {
        // Extend the break by the shortfall so the user can finish the video.
        // The worker deducts the extension from their bank (studyBreakAvailable
        // for regular break, banked spend for advanced earn/spend).
        try {
          chrome.runtime.sendMessage({
            action: 'pfVideoBreakExtend',
            addSec: deductSec,
          }).catch(() => {});
        } catch (_) {}
        startVideoEndWatcher(videoId);
        close();
      });
      shadow.getElementById('pfBOCutoff').addEventListener('click', () => {
        // No timer change — accept the current break and let it cut off.
        startVideoEndWatcher(videoId);
        close();
      });
      // Click-outside dismiss (per user spec 2026-07): same treatment as
      // the per-video prompt above — clicking the blurred backdrop closes
      // the modal without picking either option. The card stops
      // propagation so button clicks / text selection still work.
      const boBackdrop = shadow.querySelector('.backdrop');
      const boCard = shadow.querySelector('.card');
      if (boBackdrop) {
        boBackdrop.addEventListener('click', (e) => {
          if (boCard && (e.target === boCard || boCard.contains(e.target))) return;
          close();
        });
      }
    };

    // Minimum video length (seconds) to bother prompting. Shorts and quick
    // clips aren't worth a per-video timer dialog — only ask on "long"
    // videos. 3 minutes is a reasonable cutoff: covers all but the very
    // shortest videos, doesn't bug the user on previews / shorts.
    const MIN_VIDEO_LENGTH_SEC = 180;

    // True if a break/unprod (or any non-study) timer is currently running
    // on this window — in which case prompting again would just shove a
    // second timer over the one already counting. We rely on the latest
    // closer-state broadcast (currentState) to know this.
    const hasActiveUnprodTimer = () => {
      try {
        if (typeof currentState === 'undefined' || !currentState) return false;
        if (currentState.timerActive !== true) return false;
        const mode = currentState.timerMode;
        return mode === 'unprod' || mode === 'break';
      } catch (_) { return false; }
    };

    // Prompt decisions are rare (once per video), so these skip-reason logs
    // stay unconditional — they make "the prompt never showed" reportable.
    const logPromptSkip = (reason, extra) => {
      console.info('[pf-yt-prompt] skipped —', reason, extra || '');
    };

    const handlePotentialNewVideo = async () => {
      if (pfTakenOver) return;
      // Re-entry guard: if a previous invocation's retry chain (tryNow) is
      // still running for this same video, don't start a second one. Without
      // this, rapid SPA URL changes (YouTube fires several popstate/pushState
      // events per navigation) launched multiple concurrent retry chains,
      // each creating DOM elements and setTimeout storms — resource
      // exhaustion that crashed the browser. Per user report (2026-07).
      const vid = currentVideoId();
      if (!vid) return;
      if (vid === pendingVideoVid) {
        logPromptSkip('already processing this video (re-entry guard)', { vid });
        return;
      }
      pendingVideoVid = vid;
      if (promptedVideoIds.has(vid)) {
        logPromptSkip('already prompted for this video this session', { vid });
        pendingVideoVid = null;
        return;
      }
      // NOTE: unprod check dropped earlier — race-prone. Hostname gate covers it.
      if (!(await isReminderEnabled())) {
        logPromptSkip('ytVideoTimerSettings.enabled is off (dashboard checkbox)', { vid });
        pendingVideoVid = null;
        return;
      }
      // Sign-in gate (per user spec 2026-07): the extension does nothing
      // while signed out — no video prompts, no timers, no closes. The
      // broadcast state carries signedIn from the worker; treat missing
      // fields as "not signed in" so we fail closed.
      if (currentState?.signedIn === false) {
        logPromptSkip('user is signed out — extension inert', { vid });
        pendingVideoVid = null;
        return;
      }
      // Wait for video metadata to load — duration is NaN until then.
      let attempts = 0;
      let adWaits = 0;
      const finish = () => { pendingVideoVid = null; };
      const tryNow = () => {
        // A pre-roll ad plays through the same <video> element, so the
        // duration visible right now is the AD's (15–30s). Deciding on it
        // would mark a normal video "too short" and permanently skip the
        // prompt for this session. Wait the ad out instead.
        if (isAdShowing()) {
          if (++adWaits < 90) setTimeout(tryNow, 1000); // up to ~90s of ads
          else { logPromptSkip('ad still showing after 90s — gave up', { vid }); finish(); }
          return;
        }
        const dur = findLongestVideoDuration();
        if (dur >= 1) {
          // Don't prompt for short videos (Shorts, clips, previews).
          if (dur < MIN_VIDEO_LENGTH_SEC) {
            logPromptSkip(`video under ${MIN_VIDEO_LENGTH_SEC}s`, { vid, durationSec: Math.round(dur) });
            // Mark this video as "handled" so we don't keep polling for
            // it on every URL-change check until the user navigates away.
            promptedVideoIds.add(vid);
            finish();
            return;
          }
          // Re-check guards in case anything changed during the metadata
          // wait (user navigated to a different video, an unprod timer
          // started).
          const stillCurrent = currentVideoId();
          if (stillCurrent !== vid || promptedVideoIds.has(vid)) { finish(); return; }
          promptedVideoIds.add(vid);
          // Timer state is evaluated HERE (not at handlePotentialNewVideo
          // entry): a navigation-cancel of the previous per-video timer may
          // still be in flight, and metadata/ad waits give the fresh
          // broadcast time to land. Deciding on a stale snapshot showed the
          // wrong prompt (or none).
          const anyTimerActive = currentState?.timerActive === true;
          const advEarnOn = currentState?.advancedEarnActive === true;
          const timerIsVideoScoped = anyTimerActive &&
            currentState?.timerVideoScoped === true;
          // Per user spec (2026-07 v34): don't show the per-video prompt when
          // ANY of the following is already handling their focus/break time:
          //   • Work Timer session is active (earn OR break phase) — they've
          //     already committed to a timer window
          //   • Advanced Earn/Spend feature is on — same reasoning; they
          //     already have an ambient timer running
          // Was: only skipped for `unprod`/`break` mode. That missed the
          // study phase and the whole Adv Earn/Spend flow, so users doing a
          // 25-minute focus session STILL got asked to set another
          // per-video timer. Video-scoped timers still re-prompt on the
          // NEXT video (they're PER-video by definition — expected to be
          // overridden by the following video's prompt).
          const hasBlockingTimer = (anyTimerActive && !timerIsVideoScoped) || advEarnOn;
          if (!hasBlockingTimer) {
            injectPrompt(vid, dur);
          }
          // else: Work Timer or Adv Earn/Spend already covers this — skip.
          finish();
          return;
        }
        if (++attempts < 30) {
          setTimeout(tryNow, 500); // up to ~15s
        } else {
          logPromptSkip('video metadata (duration) never loaded within 15s', { vid });
          finish();
        }
      };
      tryNow();
    };

    // Per-user-video timer state — the video id we last STARTED a timer for,
    // so URL changes can override it (or cancel it when leaving the site).
    let activeTimerVideoId = null;
    const cancelActiveTimer = (reason) => {
      if (!activeTimerVideoId) return;
      try {
        chrome.runtime.sendMessage({
          action: 'pfVideoBreakCancel',
          reason: reason || 'unknown'
        }).catch(() => {});
      } catch (_) {}
      activeTimerVideoId = null;
    };

    // Watch URL changes. YouTube uses SPA navigation via history.pushState;
    // popstate covers back/forward; a periodic href-poll catches the rest.
    let lastUrl = location.href;
    const onMaybeUrlChange = () => {
      if (pfTakenOver) {
        try { clearInterval(urlPollIntervalId); } catch (_) {}
        return;
      }
      if (location.href === lastUrl) return;
      const previousUrl = lastUrl;
      lastUrl = location.href;
      // Tear down any active prompt — it was for the previous video.
      if (activePromptHost) { try { activePromptHost.remove(); } catch (_) {} activePromptHost = null; }
      // Per user spec (2026-07): switching videos or leaving the watch page
      // OVERRIDES the current per-video timer. Cancel it now, then re-prompt
      // if the new URL is another video.
      const stillOnYouTube = /(^|\.)youtube\.com$/i.test(location.hostname);
      const isWatchPage = stillOnYouTube && location.pathname === '/watch';
      cancelActiveTimer(isWatchPage ? 'video_switch' : 'left_watch');
      // Bound promptedVideoIds so a long-lived YouTube tab doesn't grow it
      // without limit. Past entries only matter for deduping re-visits within
      // the same session, so dropping the oldest batch once it gets large is
      // safe — at worst a video could be re-prompted once after a marathon.
      if (promptedVideoIds.size > 200) promptedVideoIds.clear();
      // Clear the prompted-video cache for the NEW video specifically so the
      // "already prompted" dedupe doesn't stop the re-prompt on URL-driven
      // navigation to a video the user already saw earlier.
      const newVid = currentVideoId();
      if (newVid) promptedVideoIds.delete(newVid);
      stopVideoEndWatcher();
      handlePotentialNewVideo();
    };
    window.addEventListener('popstate', onMaybeUrlChange);
    // Capture the interval id so we can stop the 1s href-poll on pagehide.
    // Without this the interval ran for the whole tab lifetime (and once per
    // embed frame, since this script is injected with all_frames:true).
    const urlPollIntervalId = setInterval(onMaybeUrlChange, 1000);
    // Initial load: kick off after a small delay so currentState has
    // landed from the SW (the unprod check depends on it).
    const initialKickoffId = setTimeout(handlePotentialNewVideo, 1500);
    // Full teardown on pagehide: stop polling and drop the listener so the
    // closure (and the whole module scope it captures) can be GC'd.
    window.addEventListener('pagehide', function onPfYouTubePageHide() {
      window.removeEventListener('popstate', onMaybeUrlChange);
      window.removeEventListener('pagehide', onPfYouTubePageHide);
      clearInterval(urlPollIntervalId);
      clearTimeout(initialKickoffId);
      stopVideoEndWatcher();
      // Cancel any running per-video timer — user is leaving the tab/site.
      cancelActiveTimer('pagehide');
      if (activePromptHost) { try { activePromptHost.remove(); } catch (_) {} activePromptHost = null; }
    });
  })();

  // ── YouTube homepage nudge — REMOVED 2026-07 ────────────────────────────
  // The always-on homepage nudge card was replaced with a targeted message
  // shown ONLY on the tab-close card when the closer shuts a YouTube
  // homepage tab. See buildCloseCardQueueEntry / enqueueCloseFeedbackContext
  // in worker.js and the black-text "Please search using the web to find
  // videos" line rendered inside the tab-close card.

  function triggerProductiveAffirmation(popupElement, buttonElement) {
    if (!popupElement || !buttonElement) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const computedPos = getComputedStyle(popupElement).position;
    if (computedPos === 'static') {
      popupElement.style.position = 'relative';
    }

    const popupRect = popupElement.getBoundingClientRect();
    const buttonRect = buttonElement.getBoundingClientRect();
    const originX = buttonRect.left + buttonRect.width / 2 - popupRect.left;
    const originY = buttonRect.top + buttonRect.height / 2 - popupRect.top;

    const corners = [
      { x: 0, y: 0 },
      { x: popupRect.width, y: 0 },
      { x: 0, y: popupRect.height },
      { x: popupRect.width, y: popupRect.height }
    ];
    const maxDistance = Math.max(...corners.map((c) =>
      Math.hypot(c.x - originX, c.y - originY)
    ));
    const targetDiameter = maxDistance * 2.2;

    const ripple = document.createElement('div');
    ripple.className = 'pf-affirm-ripple';
    ripple.style.cssText = `
      position: absolute;
      left: ${originX}px;
      top: ${originY}px;
      width: 20px;
      height: 20px;
      margin-left: -10px;
      margin-top: -10px;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 50%,
        rgba(74, 222, 128, 0.9) 0%,
        rgba(34, 197, 94, 0.7) 40%,
        rgba(22, 163, 74, 0.4) 70%,
        rgba(34, 197, 94, 0) 100%);
      box-shadow:
        0 0 24px 8px rgba(34, 197, 94, 0.5),
        0 0 8px 2px rgba(74, 222, 128, 0.7) inset;
      pointer-events: none;
      opacity: 1;
      transform: scale(0.1);
      transition:
        transform 1.1s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 1.1s cubic-bezier(0.4, 0, 0.6, 1);
      z-index: 100;
      mix-blend-mode: screen;
    `;
    ripple.style.width = `${targetDiameter}px`;
    ripple.style.height = `${targetDiameter}px`;
    ripple.style.marginLeft = `${-targetDiameter / 2}px`;
    ripple.style.marginTop = `${-targetDiameter / 2}px`;

    popupElement.appendChild(ripple);

    if (PF_DEBUG) {
      console.info('[pf-affirm] ripple from', originX, originY,
        'diameter', targetDiameter);
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ripple.style.transform = 'scale(1)';
        ripple.style.opacity = '0';
      });
    });

    setTimeout(() => {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 1200);
  }

  function triggerUnproductiveAffirmation(popupElement, buttonElement) {
    if (!popupElement || !buttonElement) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const computedPos = getComputedStyle(popupElement).position;
    if (computedPos === 'static') {
      popupElement.style.position = 'relative';
    }

    const popupRect = popupElement.getBoundingClientRect();
    const buttonRect = buttonElement.getBoundingClientRect();
    const originX = buttonRect.left + buttonRect.width / 2 - popupRect.left;
    const originY = buttonRect.top + buttonRect.height / 2 - popupRect.top;

    const corners = [
      { x: 0, y: 0 },
      { x: popupRect.width, y: 0 },
      { x: 0, y: popupRect.height },
      { x: popupRect.width, y: popupRect.height }
    ];
    const maxDistance = Math.max(...corners.map((c) =>
      Math.hypot(c.x - originX, c.y - originY)
    ));
    const targetDiameter = maxDistance * 2.2;

    const ripple = document.createElement('div');
    ripple.className = 'pf-dismiss-ripple';
    ripple.style.cssText = `
      position: absolute;
      left: ${originX}px;
      top: ${originY}px;
      width: 20px;
      height: 20px;
      margin-left: -10px;
      margin-top: -10px;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 50%,
        rgba(148, 163, 184, 0.95) 0%,
        rgba(100, 116, 139, 0.75) 40%,
        rgba(71, 85, 105, 0.45) 70%,
        rgba(100, 116, 139, 0) 100%);
      box-shadow:
        0 0 24px 8px rgba(100, 116, 139, 0.45),
        0 0 8px 2px rgba(148, 163, 184, 0.65) inset;
      pointer-events: none;
      opacity: 1;
      transform: scale(0.1);
      transition:
        transform 1.1s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 1.1s cubic-bezier(0.4, 0, 0.6, 1);
      z-index: 100;
      mix-blend-mode: screen;
    `;
    ripple.style.width = `${targetDiameter}px`;
    ripple.style.height = `${targetDiameter}px`;
    ripple.style.marginLeft = `${-targetDiameter / 2}px`;
    ripple.style.marginTop = `${-targetDiameter / 2}px`;

    popupElement.appendChild(ripple);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ripple.style.transform = 'scale(1)';
        ripple.style.opacity = '0';
      });
    });

    setTimeout(() => {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 1200);
  }

  function triggerPurpleConfetti(sourceElement, container) {
    if (PF_DEBUG) {
      chrome.runtime.sendMessage({
        action: '__pf_debug_log',
        payload: {
          tag: 'pf-confetti',
          msg: 'triggerPurpleConfetti called',
          hasSource: !!sourceElement,
          hasContainer: !!container,
          reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          documentElement: !!document.documentElement
        }
      }).catch(() => {});

      console.info('[pf-confetti] triggerPurpleConfetti called', {
        hasSource: !!sourceElement,
        hasContainer: !!container,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      });
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    // V1.5b: Allow confetti to be anchored to a CSP-safe container
    // (e.g., close-card popup's Shadow DOM root). Falls back to
    // documentElement if no container provided.
    const targetContainer = container || document.documentElement;

    let originX = window.innerWidth / 2;
    let originY = window.innerHeight / 2;
    try {
      if (sourceElement) {
        const r = sourceElement.getBoundingClientRect();
        originX = r.left + r.width / 2;
        originY = r.top + r.height / 2;
      }
    } catch (_) { /* ignore */ }

    const canvas = document.createElement('canvas');
    canvas.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    `;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    try {
      targetContainer.appendChild(canvas);
    } catch (err) {
      console.warn('[pf-confetti] append failed, falling back to documentElement', err);
      try {
        document.documentElement.appendChild(canvas);
      } catch (_) {
        console.warn('[pf-confetti] skipped');
        return;
      }
    }

    if (PF_DEBUG) {
      console.info('[pf-confetti] started', {
        container: targetContainer === document.documentElement ? 'documentElement' : 'custom'
      });
    }

    const ctx2d = canvas.getContext('2d');

    const PURPLE_PALETTE = [
      '#8b5cf6',
      '#a855f7',
      '#c084fc',
      '#9333ea',
      '#7c3aed',
      '#d8b4fe'
    ];

    const particles = [];
    const PARTICLE_COUNT = 70;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const angle = -Math.PI * (0.25 + 0.5 * Math.random()) +
        (Math.random() - 0.5) * 0.4;
      const speed = 8 + Math.random() * 8;
      particles.push({
        x: originX + (Math.random() - 0.5) * 20,
        y: originY + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.4,
        size: 6 + Math.random() * 6,
        color: PURPLE_PALETTE[Math.floor(Math.random() * PURPLE_PALETTE.length)],
        shape: Math.random() < 0.5 ? 'rect' : 'circle',
        opacity: 1
      });
    }

    const startTime = Date.now();
    const DURATION_MS = 2200;
    const GRAVITY = 0.45;
    const AIR_DRAG = 0.99;

    function animate() {
      const elapsed = Date.now() - startTime;
      if (elapsed > DURATION_MS) {
        canvas.remove();
        return;
      }

      ctx2d.clearRect(0, 0, canvas.width, canvas.height);

      const fadeStart = DURATION_MS * 0.7;
      const fadeAlpha = elapsed < fadeStart
        ? 1
        : Math.max(0, 1 - (elapsed - fadeStart) / (DURATION_MS - fadeStart));

      particles.forEach((p) => {
        p.vy += GRAVITY;
        p.vx *= AIR_DRAG;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;

        if (p.y > canvas.height + 30) return;

        ctx2d.save();
        ctx2d.translate(p.x, p.y);
        ctx2d.rotate(p.rotation);
        ctx2d.fillStyle = p.color;
        ctx2d.globalAlpha = fadeAlpha;
        if (p.shape === 'rect') {
          ctx2d.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        } else {
          ctx2d.beginPath();
          ctx2d.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx2d.fill();
        }
        ctx2d.restore();
      });

      requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.pfEffects = {
      triggerProductiveAffirmation,
      triggerUnproductiveAffirmation,
      triggerPurpleConfetti
    };
  }

  function runPfTestCloseCardEffects(detail) {
    const affirm = detail?.affirm !== false;
    const confetti = detail?.confetti !== false;

    if (affirm) {
      const fakePopup = document.createElement('div');
      fakePopup.style.cssText = `
        position: fixed;
        bottom: 100px;
        right: 100px;
        width: 280px;
        height: 140px;
        background: rgba(255,255,255,0.95);
        backdrop-filter: blur(10px);
        border-radius: 12px;
        z-index: 2147483645;
        padding: 16px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
        font-family: system-ui, sans-serif;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      `;
      const fakeLabel = document.createElement('div');
      fakeLabel.style.color = '#333';
      fakeLabel.textContent = 'Test productive-feedback';
      const fakeYesBtn = document.createElement('button');
      fakeYesBtn.id = 'fakeYesBtn';
      fakeYesBtn.textContent = 'Yes';
      fakeYesBtn.style.cssText = `
          align-self: flex-end;
          background: #22c55e; color: white;
          padding: 8px 16px; border: none; border-radius: 6px;
          cursor: pointer;
        `;
      fakePopup.appendChild(fakeLabel);
      fakePopup.appendChild(fakeYesBtn);
      document.documentElement.appendChild(fakePopup);

      triggerProductiveAffirmation(fakePopup, fakeYesBtn);
      setTimeout(() => {
        if (fakePopup.parentNode) fakePopup.parentNode.removeChild(fakePopup);
      }, 2500);
    }

    if (confetti) {
      const fakeBtn = {
        getBoundingClientRect: () => ({
          left: window.innerWidth - 200,
          top: window.innerHeight - 200,
          width: 100,
          height: 40
        })
      };
      setTimeout(() => triggerPurpleConfetti(fakeBtn), 400);
    }
  }

  if (!pfSensitivePageOnly) {
    document.addEventListener('pf-test-close-card', (e) => {
      runPfTestCloseCardEffects(e.detail || {});
    });

    // V1.5b: Listen for close-card confetti trigger from page-world
    // close-card script (which can't access pfEffects directly across
    // world isolation)
    document.addEventListener('pf-trigger-confetti', (e) => {
      if (PF_DEBUG) {
        console.info('[pf-confetti-debug] listener received event', {
          detail: e.detail
        });
      }

      const detail = e.detail || {};
      const origin = detail.origin || null;

      const fakeSource = origin ? {
        getBoundingClientRect: () => ({
          left: origin.x - 30,
          top: origin.y - 20,
          width: 60,
          height: 40
        })
      } : null;

      triggerPurpleConfetti(fakeSource);
    });
  }

  const hostEl = document.createElement('div');
  hostEl.id = 'pf-closer-indicator-host';
  hostEl.style.cssText = 'all: initial; position: fixed; right: 32px; bottom: 12px; z-index: 2147483647; pointer-events: none; transition: bottom 0.3s ease;';

  const shadow = hostEl.attachShadow({ mode: 'closed' });
  pfReplaceHtml(shadow, `
    <style>
      :host { all: initial; }
      .pf-wrap {
        position: relative;
        width: 36px;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .pf-indicator-stack {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        width: auto;
        min-width: 36px;
        pointer-events: none;
      }
      .pf-btn-stack {
        position: relative;
        width: 36px;
        height: 36px;
        pointer-events: auto;
        filter: drop-shadow(0 2px 7px rgba(0, 0, 0, 0.28));
        cursor: pointer;
      }
      .pf-progress-ring {
        position: absolute;
        /* v83 (user spec "make the green and gray circle smaller/skinnier").
           Geometry, since it is easy to break:
             .pf-btn-stack is 36x36, so its centre is at 18,18 and inset:0
             gave the ring an outer radius of 18. .pf-btn is 23px at 6.5,6.5
             — radius 11.5, same centre.
             Was: outer 18, mask opaque from radius 10  -> 6.5px of ring
                  visible outside the button.
             Now: inset 3px -> outer 15, mask opaque from radius 11
                  -> 3.5px visible. Roughly half as thick and 3px smaller
                  all round.
           The opaque inner edge (11) MUST stay under the button radius
           (11.5). The button sits at z-index 2 and covers the overlap; if
           the inner edge moves outside 11.5 a hairline gap appears between
           ring and button, which is the bug the old comment here warned
           about. */
        inset: 3px;
        border-radius: 50%;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s ease;
        transform: none !important;
        animation: none !important;
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
        mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
      }
      .pf-progress-ring.pf-visible {
        opacity: 1;
      }
      .pf-progress-ring.pf-done {
        background: conic-gradient(from 0deg, #5c6570 0deg, #727c88 180deg, #5c6570 360deg) !important;
      }
      .pf-btn {
        width: 23px;
        height: 23px;
        border-radius: 50%;
        cursor: inherit;
        pointer-events: none;
        position: absolute;
        top: 6.5px;
        left: 6.5px;
        display: block;
        user-select: none;
        touch-action: none;
        border: none;
        box-sizing: border-box;
        background: radial-gradient(circle at 38% 32%, #2a313a 0%, #12151a 72%);
        box-shadow:
          inset 0 1px 1px rgba(255, 255, 255, 0.12),
          inset 0 -2px 3px rgba(0, 0, 0, 0.55);
        transition:
          transform 0.1s ease-out,
          filter 0.1s ease-out;
        z-index: 2;
      }
      .pf-spin-accent {
        display: none;
      }
      .pf-btn-countdown {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #5c6570;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 10px;
        font-weight: 800;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
        pointer-events: none;
        user-select: none;
        line-height: 1;
        opacity: 0;
        transition: opacity 0.15s ease-out;
        z-index: 3;
      }
      .pf-btn-countdown.pf-visible {
        opacity: 1;
      }
      .pf-btn.pf-on:hover,
      .pf-btn.pf-off:hover {
        transform: translateY(-1px);
        filter: brightness(1.06);
      }
      .pf-btn.pf-on:active,
      .pf-btn.pf-on.pf-holding,
      .pf-btn.pf-off:active {
        transform: translateY(1px);
        filter: brightness(0.94);
      }
      .pf-btn-pause {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 10px;
        height: 10px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease-out;
        z-index: 3;
      }
      .pf-btn-pause.pf-visible {
        opacity: 1;
      }
      #pf-closer-countdown {
        margin-bottom: 8px;
        margin-top: 0;
        text-align: center;
        pointer-events: none;
        background: linear-gradient(
          155deg,
          rgba(255, 255, 255, 0.68) 0%,
          rgba(248, 250, 255, 0.58) 100%
        );
        backdrop-filter: blur(18px) saturate(165%);
        -webkit-backdrop-filter: blur(18px) saturate(165%);
        border-style: solid;
        border-width: 1px;
        border-color:
          rgba(255, 255, 255, 0.62)
          rgba(255, 255, 255, 0.18)
          rgba(255, 255, 255, 0.12)
          rgba(255, 255, 255, 0.28);
        border-radius: 10px;
        padding: 7px 11px 6px;
        box-shadow:
          0 4px 16px rgba(0, 0, 0, 0.08),
          inset 0 1px 0 rgba(255, 255, 255, 0.35);
        min-width: 72px;
      }
      #pf-closer-countdown.pf-hidden { display: none; }
      .pf-countdown-label {
        font-size: 10px;
        font-family: -apple-system, system-ui, sans-serif;
        color: #6b7280;
        font-weight: 600;
        line-height: 1.2;
        margin-bottom: 3px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .pf-countdown-time {
        font-size: 17px;
        font-family: -apple-system, system-ui, sans-serif;
        color: #16a34a;
        font-weight: 700;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
      }
      .pf-countdown-time.pf-done { color: #9ca3af; }
      .pf-hold-hint {
        position: absolute;
        right: 0;
        bottom: calc(100% + 8px);
        max-width: 180px;
        font-size: 10px;
        line-height: 1.35;
        font-family: -apple-system, system-ui, sans-serif;
        color: #374151;
        background: linear-gradient(
          160deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(255, 255, 255, 0.82) 100%
        );
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        border-style: solid;
        border-width: 1px;
        border-color:
          rgba(255, 255, 255, 0.75)
          rgba(0, 0, 0, 0.04)
          rgba(0, 0, 0, 0.07)
          rgba(255, 255, 255, 0.45);
        border-radius: 8px;
        padding: 6px 8px;
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.09);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        z-index: 5;
      }
      .pf-hold-hint.pf-visible { opacity: 1; }
      /* ── v83 post-onboarding button walkthrough ─────────────────────────
         Replaces the old in-dashboard "Floating button" tutorial step, which
         demoed a FAKE button. This coaches the user on the REAL one. Sits
         above the button, wide enough to read, and is the only element here
         with pointer-events since it owns a Skip control. */
      .pf-coach {
        position: absolute;
        right: 0;
        bottom: calc(100% + 12px);
        width: 250px;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 12.5px;
        line-height: 1.45;
        color: #1f2430;
        background: #fff;
        border: 1px solid #d8d0f0;
        border-radius: 12px;
        padding: 12px 14px;
        box-shadow: 0 14px 40px rgba(20, 14, 45, 0.28);
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.22s ease, transform 0.22s ease;
        pointer-events: none;
        z-index: 8;
      }
      .pf-coach.pf-visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .pf-coach-step {
        display: block;
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #7a6fa8;
        margin-bottom: 4px;
      }
      .pf-coach-title { display: block; font-weight: 700; margin-bottom: 4px; }
      .pf-coach-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
      }
      .pf-coach-skip {
        border: none;
        background: transparent;
        color: #6b7280;
        font: inherit;
        font-size: 11.5px;
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 6px;
      }
      .pf-coach-skip:hover { background: #f3f4f6; color: #1f2430; }
      /* Pulse the button itself so the eye goes to it, not just the card. */
      .pf-btn-stack.pf-coach-target { animation: pfCoachPulse 1.6s ease-in-out infinite; }
      @keyframes pfCoachPulse {
        0%, 100% { filter: drop-shadow(0 2px 7px rgba(0,0,0,0.28)); }
        50% { filter: drop-shadow(0 2px 7px rgba(0,0,0,0.28)) drop-shadow(0 0 12px rgba(91,75,159,0.85)); }
      }
      @media (prefers-reduced-motion: reduce) {
        .pf-btn-stack.pf-coach-target { animation: none; }
        .pf-coach { transition: none; }
      }
      .pf-unreadable-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #f59e0b;
        color: #451a03;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 10px;
        font-weight: 800;
        line-height: 14px;
        text-align: center;
        border: 1.5px solid #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,0.25);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s ease;
        z-index: 4;
      }
      .pf-unreadable-badge.pf-visible { opacity: 1; }
      .pf-unreadable-notice {
        position: absolute;
        right: calc(100% + 10px);
        top: 50%;
        transform: translateY(-50%);
        max-width: 280px;
        width: max-content;
        font-size: 11px;
        line-height: 1.35;
        font-family: -apple-system, system-ui, sans-serif;
        color: #374151;
        background: linear-gradient(
          160deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(255, 255, 255, 0.82) 100%
        );
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        border-style: solid;
        border-width: 1px;
        border-color:
          rgba(255, 255, 255, 0.75)
          rgba(0, 0, 0, 0.04)
          rgba(0, 0, 0, 0.07)
          rgba(255, 255, 255, 0.45);
        border-radius: 10px;
        padding: 8px 10px;
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.09);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        z-index: 5;
      }
      .pf-unreadable-notice::after {
        content: '';
        position: absolute;
        right: -6px;
        top: 50%;
        margin-top: -6px;
        width: 0;
        height: 0;
        border-top: 6px solid transparent;
        border-bottom: 6px solid transparent;
        border-left: 6px solid rgba(0, 0, 0, 0.07);
      }
      .pf-unreadable-notice::before {
        content: '';
        position: absolute;
        right: -5px;
        top: 50%;
        margin-top: -6px;
        width: 0;
        height: 0;
        border-top: 6px solid transparent;
        border-bottom: 6px solid transparent;
        border-left: 6px solid rgba(255, 255, 255, 0.88);
        z-index: 1;
      }
      .pf-unreadable-notice.pf-visible { opacity: 1; }
      .pf-unreadable-notice-title {
        font-weight: 700;
        margin-bottom: 2px;
      }
      .pf-unreadable-notice-sub {
        font-size: 10px;
        color: #6b7280;
      }
      .pf-privacy-disclaimer {
        position: absolute;
        right: 0;
        bottom: calc(100% + 8px);
        max-width: 280px;
        width: max-content;
        font-size: 10px;
        line-height: 1.35;
        font-family: -apple-system, system-ui, sans-serif;
        color: #6b7280;
        text-align: right;
        display: none;
        pointer-events: none;
      }
      .pf-privacy-disclaimer.pf-visible {
        display: block;
      }
      .pf-hidden { display: none !important; }
      /* BOOT GATE (2026-07): the pill stays invisible until its FIRST
         complete paint (ring + countdown + icons together). Users briefly
         saw a bare semi-circle ring with no icons while cached ring state
         landed before the countdown/direct-writer text — never show a
         half-composed pill. Removed by pfRevealIndicatorAfterFirstPaint(). */
      .pf-wrap.pf-boot-hide { opacity: 0 !important; }
      @keyframes pf-rotate-cw {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes pf-rotate-ccw {
        from { transform: rotate(0deg); }
        to { transform: rotate(-360deg); }
      }
    </style>
    <div class="pf-wrap pf-boot-hide">
      <!-- v83 (user spec): the "stop the work timer to do this" hint is
           removed. Element kept because showHoldBlockedHint targets it for
           other messages; it simply starts empty. -->
      <div class="pf-hold-hint" id="pfHoldHint"></div>
      <!-- v83: post-onboarding coach card. Hidden unless the walkthrough is
           armed; see pfCoachStart / pfCoachAdvance below. -->
      <div class="pf-coach" id="pfCoach" role="status" aria-live="polite" hidden>
        <span class="pf-coach-step" id="pfCoachStep">Step 1 of 2</span>
        <span class="pf-coach-title" id="pfCoachTitle">This is your focus button</span>
        <span id="pfCoachBody">It lives on every page. Hold it for 2 seconds to turn the tab closer on.</span>
        <div class="pf-coach-actions">
          <button type="button" class="pf-coach-skip" id="pfCoachSkip">Skip</button>
        </div>
      </div>
      <div class="pf-indicator-stack">
        <div id="pf-closer-countdown" class="pf-hidden">
          <div class="pf-countdown-label" id="pfCountdownLabel">Break</div>
          <div class="pf-countdown-time" id="pfCountdownTime">0:00</div>
        </div>
        <div class="pf-btn-stack">
          <div class="pf-unreadable-notice" id="pfUnreadableNotice">
            <div class="pf-unreadable-notice-title">This site can't be read</div>
            <div class="pf-unreadable-notice-sub">Classified as Neutral</div>
          </div>
          <div class="pf-progress-ring" id="pfProgressRing"></div>
          <div class="pf-btn pf-off" id="pfBtn" title="Closer is OFF. Hold 2s to turn ON">
            <div class="pf-spin-accent" id="pfSpinAccent"></div>
            <span class="pf-unreadable-badge" id="pfUnreadableBadge">!</span>
            <span class="pf-btn-countdown" id="pfCountdown"></span>
          <svg class="pf-btn-pause" id="pfPause" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="1.5" width="2.5" height="9" rx="0.5" fill="#e5e7eb"/>
            <rect x="7.5" y="1.5" width="2.5" height="9" rx="0.5" fill="#e5e7eb"/>
          </svg>
          </div>
        </div>
        <div class="pf-privacy-disclaimer" id="pfPrivacyDisclaimer">
          This site is not classified for privacy reasons
        </div>
      </div>
    </div>
  `);

  // Reveal the pill once its first complete composition has been painted.
  // Safety timeout guarantees it can never stay invisible if no state
  // broadcast arrives (e.g. a page where the worker stays silent).
  let pfIndicatorRevealed = false;
  function pfRevealIndicatorAfterFirstPaint() {
    if (pfIndicatorRevealed) return;
    pfIndicatorRevealed = true;
    try {
      // NOTE: the pill's shadow root is mode:'closed' — hostEl.shadowRoot
      // is null; the captured `shadow` reference is the only way in.
      shadow.querySelector('.pf-wrap')?.classList.remove('pf-boot-hide');
    } catch (_) { /* best-effort */ }
  }
  setTimeout(pfRevealIndicatorAfterFirstPaint, 1200);

  const appendHost = () => {
    const root = document.body || document.documentElement;
    if (!root) return;
    if (!root.contains(hostEl)) root.appendChild(hostEl);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', appendHost, { once: true });
  } else {
    appendHost();
  }

  // Fullscreen handling: a fullscreened <video> (or any element) renders in the
  // browser's "top layer", which sits ABOVE all normal document content no
  // matter how high the z-index. Reparenting the host into the video fails
  // (replaced elements ignore children) or into a wrapper breaks (transform
  // containment). The spec-correct overlay is a modal <dialog>: a dialog shown
  // via showModal() is ALSO in the top layer, and renders above the fullscreen
  // element. We clone the indicator's shadow into a fullscreen dialog while
  // fullscreen is active, then tear it down on exit.
  let fsDialog = null;
  let fsObserver = null;
  let fsOriginalParent = null;
  let fsOriginalNext = null;
  const FS_DEBUG = false;
  const fsLog = (...args) => { if (FS_DEBUG) console.info('[pf-fs]', ...args); };

  // Strategy: when the page enters element-fullscreen, the fullscreen target
  // sits in the browser's top layer above everything else. Old strategy was
  // to append our host as a child of the fullscreen element — but on
  // framework-heavy players (Open edX, React-driven YouTube wrappers) the
  // framework continuously re-renders that subtree and yanks our injected
  // element out within milliseconds.
  //
  // Bulletproof strategy: a transparent fullscreen <dialog> attached to
  // document.body, opened with .showModal(). Modal dialogs are placed in
  // the browser's top layer *independently* of the fullscreen element, so
  // they paint above the video without touching the player's DOM. We move
  // the LIVE host into the dialog (not a clone) so event handlers, the
  // shadow root, and animations carry over 1:1.
  const PF_FS_DIALOG_ID = 'pf-fs-dialog';
  const PF_HOST_FS_STYLE = [
    'position:absolute !important',
    'bottom:80px !important',
    'right:32px !important',
    'top:auto !important',
    'left:auto !important',
    'z-index:2147483647 !important',
    // pointer-events:none on the host — the pill button inside the shadow
    // sets pointer-events:auto on itself, so only its actual hit-target
    // captures clicks. If we set auto on the host the entire bounding box
    // would block clicks to the video underneath.
    'pointer-events:none !important',
  ].join(';');

  const restoreHostFromFullscreen = () => {
    if (!hostEl) return;
    try {
      // Strip the FS overrides so the host returns to its original inline
      // cssText (position:fixed; right:32px; bottom:12px; pointer-events:none).
      ['position', 'right', 'bottom', 'top', 'left', 'z-index', 'pointer-events']
        .forEach((p) => hostEl.style.removeProperty(p));
      hostEl.style.cssText = 'all: initial; position: fixed; right: 32px; bottom: 12px; z-index: 2147483647; pointer-events: none; transition: bottom 0.3s ease;';
      // The cssText reset above WIPES the fullscreen-focus-timer's hide —
      // this function runs from exitFullscreenOverlay right as the big
      // timer opens, which resurrected the pill in the corner (user report
      // 2026-07). Re-assert the hide while the big timer owns the screen.
      // display (NOT visibility): shadow children set explicit
      // visibility:visible, which OVERRIDES an ancestor's hidden — that's
      // why the pill kept painting through. display:none is absolute.
      if (pfFsHost) hostEl.style.display = 'none';
      if (fsOriginalParent && fsOriginalParent.isConnected) {
        if (fsOriginalNext && fsOriginalNext.parentNode === fsOriginalParent) {
          fsOriginalParent.insertBefore(hostEl, fsOriginalNext);
        } else {
          fsOriginalParent.appendChild(hostEl);
        }
        fsLog('restored host to original parent');
      } else {
        // Original parent gone — fall back to body so the indicator stays alive.
        document.body.appendChild(hostEl);
        fsLog('restored host to document.body (original parent missing)');
      }
    } catch (e) {
      fsLog('restore failed', e);
    }
    fsOriginalParent = null;
    fsOriginalNext = null;
  };

  // Detect popover support (Chrome 114+, Firefox 125+, Safari 17+).
  const POPOVER_SUPPORTED = (() => {
    try {
      return typeof HTMLElement !== 'undefined' &&
        'popover' in HTMLElement.prototype &&
        typeof HTMLElement.prototype.showPopover === 'function';
    } catch (_) { return false; }
  })();

  const enterFullscreenViaDialog = () => {
    if (!hostEl) return;
    // Already inside our overlay? Nothing to do.
    if (fsDialog && hostEl.parentNode === fsDialog) return;
    try {
      // 1. Build the transparent fullscreen overlay if missing. Prefer a
      //    <div popover="manual"> — it gets the same top-layer placement
      //    as <dialog>.showModal() but DOESN'T make the rest of the page
      //    inert, so the user can still click the video / player controls
      //    underneath. Fall back to <dialog> when popover isn't supported.
      let dlg = document.getElementById(PF_FS_DIALOG_ID);
      if (!dlg) {
        if (POPOVER_SUPPORTED) {
          dlg = document.createElement('div');
          dlg.setAttribute('popover', 'manual');
        } else {
          dlg = document.createElement('dialog');
        }
        dlg.id = PF_FS_DIALOG_ID;
        dlg.setAttribute('aria-hidden', 'true');
        dlg.style.cssText = [
          'position:fixed !important',
          'inset:0 !important',
          'width:100vw !important',
          'height:100vh !important',
          'max-width:none !important',
          'max-height:none !important',
          'background:transparent !important',
          'border:none !important',
          'margin:0 !important',
          'padding:0 !important',
          'overflow:visible !important',
          'pointer-events:none !important', // clicks pass through to video
          'z-index:2147483647 !important',
          'color-scheme:light',
        ].join(';');
        // Strip the default ::backdrop so we don't dim the video.
        try {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(`#${PF_FS_DIALOG_ID}::backdrop { background: transparent !important; pointer-events: none !important; }`);
          document.adoptedStyleSheets = [...(document.adoptedStyleSheets || []), sheet];
        } catch (_) {
          const s = document.createElement('style');
          s.textContent = `#${PF_FS_DIALOG_ID}::backdrop { background: transparent !important; pointer-events: none !important; }`;
          (document.head || document.documentElement).appendChild(s);
        }
        document.body.appendChild(dlg);
      }
      fsDialog = dlg;

      // 2. Remember where the host lives so we can restore it on exit.
      if (!fsOriginalParent) {
        fsOriginalParent = hostEl.parentNode;
        fsOriginalNext = hostEl.nextSibling;
      }

      // 3. MOVE the live host into the overlay (no cloning — preserves shadow
      //    root, event handlers, animations).
      dlg.appendChild(hostEl);

      // 4. Reposition host inside the overlay.
      hostEl.style.cssText += ';' + PF_HOST_FS_STYLE;

      // 5. Promote overlay to the top layer.
      if (POPOVER_SUPPORTED && typeof dlg.showPopover === 'function') {
        if (!dlg.matches(':popover-open')) {
          try { dlg.showPopover(); } catch (e) { fsLog('showPopover threw', e); }
        }
      } else {
        // Fallback path: <dialog>.show() (NOT showModal — show() avoids
        // making the rest of the page inert, but also doesn't enter the top
        // layer in all browsers). Last-resort showModal would block clicks
        // to the video, so we never use it.
        if (!dlg.open && typeof dlg.show === 'function') {
          try { dlg.show(); } catch (e) { fsLog('dialog.show threw', e); }
        }
      }
      fsLog('host moved into fullscreen overlay', POPOVER_SUPPORTED ? 'popover' : 'dialog');
    } catch (e) {
      fsLog('overlay setup failed', e);
    }
  };

  const exitFullscreenOverlay = () => {
    if (fsObserver) { clearInterval(fsObserver); fsObserver = null; }
    // Move host out of the overlay BEFORE closing/removing it, so the host
    // isn't destroyed alongside the overlay.
    restoreHostFromFullscreen();
    if (fsDialog) {
      try {
        if (POPOVER_SUPPORTED && typeof fsDialog.hidePopover === 'function' &&
            fsDialog.matches(':popover-open')) {
          fsDialog.hidePopover();
        } else if (fsDialog.tagName === 'DIALOG' && fsDialog.open) {
          fsDialog.close();
        }
      } catch (_) {}
      try { fsDialog.remove(); } catch (_) {}
      fsDialog = null;
    }
  };

  const isAnyFullscreenActive = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    // F11 / browser fullscreen — no fullscreenElement but window matches
    // screen dimensions (within a small tolerance for browser chrome).
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (_) {}
    return false;
  };

  const syncFullscreenOverlay = () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    // FULLSCREEN FOCUS TIMER owns the screen: it IS the big timer, so the
    // small pill must not get floated above it in a top-layer dialog —
    // that was the "2 timers at the bottom" bug (user report 2026-07).
    if (fsEl && fsEl.id === 'pf-focus-fullscreen') {
      exitFullscreenOverlay();
      return;
    }
    const anyFs = isAnyFullscreenActive();
    const timerActive = Number(currentState?.timerStartedAt) > 0
      && currentState?.timerActive !== false;
    if (anyFs && timerActive) {
      if (fsEl) {
        // Element fullscreen — always use the modal-dialog overlay.
        // Reparenting into the player's own DOM gets clobbered by frameworks
        // like React (Open edX), so we float a <dialog>.showModal() above
        // the fullscreen element via the top layer instead.
        enterFullscreenViaDialog();
      } else {
        // F11 / display-mode fullscreen — the indicator is already visible
        // because there's no top-layer element covering it. Nothing to do.
      }
      // Watchdog covers fullscreen-exit cases that skip the change event.
      if (!fsObserver) {
        fsObserver = setInterval(() => {
          if (!isAnyFullscreenActive()) exitFullscreenOverlay();
        }, 1000);
      }
    } else {
      exitFullscreenOverlay();
    }
  };
  document.addEventListener('fullscreenchange', syncFullscreenOverlay);
  document.addEventListener('webkitfullscreenchange', syncFullscreenOverlay);
  // Catch F11 browser fullscreen (which never fires fullscreenchange).
  window.addEventListener('resize', () => syncFullscreenOverlay());

  const btn = shadow.getElementById('pfBtn');
  const btnStack = shadow.querySelector('.pf-btn-stack');
  const progressRing = shadow.getElementById('pfProgressRing');
  const spinAccent = shadow.getElementById('pfSpinAccent');
  const countdown = shadow.getElementById('pfCountdown');
  const pauseIcon = shadow.getElementById('pfPause');
  const closerCountdown = shadow.getElementById('pf-closer-countdown');
  const countdownLabel = shadow.getElementById('pfCountdownLabel');
  const countdownTime = shadow.getElementById('pfCountdownTime');
  const holdHint = shadow.getElementById('pfHoldHint');
  const unreadableBadge = shadow.getElementById('pfUnreadableBadge');
  const unreadableNotice = shadow.getElementById('pfUnreadableNotice');
  const privacyDisclaimer = shadow.getElementById('pfPrivacyDisclaimer');

  function shouldForceTimerVisible(state) {
    // Force the indicator visible (overriding siteUnreadable / privacy
    // hide) for ANY active timer — study, break/unprod, advanced earn,
    // advanced spend. Per user spec: on privacy-blocked / unclassified
    // sites the user should STILL see their ticking break timer AND the
    // closer toggle button. studyTimerForcedVisible is set true by the
    // worker for any timer; the legacy direct checks below stay as
    // belt-and-braces for older state snapshots.
    if (state?.studyTimerForcedVisible === true) return true;
    if (state?.timerActive === true && Number(state?.timerTotalSec) > 0) {
      const mode = state?.timerMode;
      if (mode === 'study' || mode === 'unprod' || mode === 'break' ||
          mode === 'earn' || mode === 'spend') {
        return true;
      }
    }
    if (state?.studyTimerEnabled === true && state?.timerActive === true) return true;
    if (state?.unprodTimerEnabled === true && state?.timerActive === true) return true;
    return false;
  }

  let currentState = { limitsEnabled: false, timerActive: false, activeTabIsUnproductive: false };
  // Tracks whether the intro wave animation has already played on this page
  // (it should only fire once, on first indicator reveal).
  let hasPlayedIntro = false;
  // Tracks which timer-session (by timerStartedAt) we've already shown the
  // centerFly "carry-over" preview for. The preview should only appear on the
  // FIRST tab the user opens after starting a timer — not on every subsequent
  // refresh/open of other tabs while that same timer runs.
  let lastCenterFlyShownForStartedAt = 0;
  let tickInterval = null;
  let unreadableShowTimer = null;
  let lastPushTimerElapsedSec = 0;
  let lastPushTimerRemainingSec = null;
  let lastPushAtMs = Date.now();
  let holdStartTime = 0;
  let holdRafId = null;
  let isHoldingActive = false;
  let holdPointerId = null;
  let holdCompleted = false;
  let holdDirection = 'off';
  let holdDuration = HOLD_OFF_MS;
  let holdHintTimer = null;
  let holdCompletedAt = 0;
  let holdCompletedTargetEnabled = null;
  let isAutoHidden = false;
  let hoverTimerId = null;
  const HOVER_HIDE_MS = 1400;
  const HIDE_AREA_BUFFER = 40;

  function stopLocalTick() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function startLocalTick() {
    if (tickInterval) return;
    // 250ms instead of 1000ms — combined with extrapolation in
    // getDisplayRemainingSec, the displayed seconds update within a quarter
    // second of the true tick boundary even if the SW broadcast lands off
    // beat (e.g. SW briefly suspended). Stops the perceived "stutter" where
    // the displayed number paused for >1s before jumping.
    //
    // Self-heal pull: extrapolation is capped at 1.75s (to avoid drifting
    // past real progress when broadcasts STOP, e.g. earn timer on blur).
    // If the SW broadcast stream is delayed by >2s for any reason (MV3 SW
    // idle, runTick coalesce hiccup, slow system, etc.) the display would
    // freeze visually until the next broadcast. To recover gracefully,
    // when we notice no broadcast has arrived for STATE_REFRESH_THRESHOLD_MS
    // and there's an active timer, ask the SW for fresh state. This is
    // what tab-switching back used to silently trigger — now we trigger
    // it ourselves before the user notices.
    const STATE_REFRESH_THRESHOLD_MS = 2500;
    let lastRefreshRequestedAt = 0;
    tickInterval = setInterval(() => {
      if (pfTakenOver) { stopLocalTick(); return; }
      // HOST WATCHDOG (2026-07): SPA re-renders (YouTube, Reddit, some app
      // frameworks) can wipe our hostEl off document.body long after the
      // initial DOMContentLoaded append. Also: intermittent state
      // broadcasts, cssText resets in the fullscreen restore path, or
      // other injected code can leave the host with display:none /
      // visibility:hidden even though a timer is running. Without a
      // watchdog the pill silently vanishes for the rest of the page's
      // life — user reported this at multiple time marks (~1h40, ~46min).
      // Runs at 250ms with the paint loop. Both branches are cheap.
      const shouldShow = (isTimerUiActive(currentState) || shouldForceTimerVisible(currentState));
      if (hostEl && shouldShow) {
        // (a) DOM re-attach if the host was removed from the tree.
        if (!hostEl.isConnected) {
          try {
            (document.body || document.documentElement)?.appendChild(hostEl);
            console.info('[pf-indicator] host re-attached after DOM removal');
          } catch (_) { /* best-effort — next tick tries again */ }
        }
        // (b) Un-hide if the host is display:none / visibility:hidden
        //     but no true-document fullscreen is holding the pfFsHost
        //     overlay open. Fixes the "pill disappears mid-session" bug
        //     caused by a stale hide from a prior fullscreen exit or
        //     a transient state where hideIndicator flipped true.
        const realFullscreenActive = !!(
          document.fullscreenElement || document.webkitFullscreenElement
        );
        if (!pfFsHost && !realFullscreenActive) {
          if (hostEl.style.display === 'none') {
            hostEl.style.display = '';
            console.info('[pf-indicator] cleared stale display:none');
          }
          if (hostEl.style.visibility === 'hidden') {
            hostEl.style.visibility = '';
          }
        }
      }
      if (isHoldInProgress()) return;
      if (isTimerUiActive(currentState) ||
          shouldForceTimerVisible(currentState) ||
          currentState.timerJustCompleted === true) {
        paintTimer(currentState);
      }
      // Self-heal: pull fresh state if last broadcast is getting stale and
      // we have an active timer. Throttle to once per STATE_REFRESH_THRESHOLD_MS
      // so we don't spam the SW.
      const recvAt = Number(currentState?.__receivedAt) || 0;
      const now = Date.now();
      if (recvAt > 0 &&
          (now - recvAt) > STATE_REFRESH_THRESHOLD_MS &&
          (now - lastRefreshRequestedAt) > STATE_REFRESH_THRESHOLD_MS &&
          (isTimerUiActive(currentState) || shouldForceTimerVisible(currentState))) {
        lastRefreshRequestedAt = now;
        try {
          chrome.runtime.sendMessage({ action: 'pfGetCloserState' }, (resp) => {
            if (resp && !chrome.runtime.lastError) {
              resp.__receivedAt = Date.now();
              currentState = resp;
              paintTimer(currentState);
            }
          });
        } catch (_) { /* runtime unavailable — keep going */ }
      }
    }, 250);
  }

  // ── Mode B focus countdown — independent direct DOM writer ───────────────
  // The broadcast → render → paintTimer → updateCountdownPanel chain has
  // multiple layers (extrapolation, monotonic floors, early returns) that kept
  // breaking the focus countdown's visual update. This is a NUCLEAR fallback:
  // a dedicated 500ms interval that asks the worker directly for the current
  // focus remaining seconds and writes them straight to the countdown element,
  // bypassing every layer above. It only runs while a focus session is active
  // and is the single source of truth for the focus countdown's visible text.
  // Per user report (2026-07): the countdown visibly stuck / didn't update
  // despite the worker ticking correctly.
  let focusDirectTickInterval = null;
  let focusDirectActive = false;
  function startFocusDirectTick() {
    if (focusDirectTickInterval) return;
    focusDirectActive = true;
    const fmt = (sec) => {
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    // Last painted values — used to render the FINAL 00:00 frame when the
    // worker completes the session the same second the countdown hits 0
    // (user report 2026-07: the earn countdown "seems to pause on 0:01
    // befor then finishing its not stoping and finishing on 0:00").
    let lastMode = null;
    let lastRemaining = -1;
    let lastTotal = 1;
    const paintFinalZero = () => {
      if (!closerCountdown || !countdownTime || !countdownLabel) return;
      closerCountdown.classList.remove('pf-hidden');
      countdownTime.textContent = '00:00';
      countdownTime.classList.remove('pf-done');
      try {
        paintProgressRing(360, false, {
          timerMode: 'earn', timerActive: true,
          timerTotalSec: lastTotal, timerRemainingSec: 0, timerElapsedSec: lastTotal
        });
      } catch (_) { /* ring is best-effort */ }
      // No auto-hide (user spec 2026-07 v43: "it should just show like 0:00
      // till the user clicks one of the buttons"). The worker now HOLDS the
      // broadcast state at 0:00 while the cycle-complete choice is pending,
      // so the normal render path keeps this frame painted; clicking any
      // popup button changes the state and re-renders naturally.
    };
    const poll = () => {
      if (!focusDirectActive) return;
      try {
        chrome.runtime.sendMessage({ action: 'pfGetFocusRemaining' }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.active) {
            // Session ended. If the EARN countdown was mid-display near 0,
            // the worker completed it the same second the decrement landed
            // on 0 — paint the final 00:00 frame so the countdown visibly
            // finishes at zero instead of freezing on 0:01.
            if (lastMode === 'earn' && lastRemaining > 0 && lastRemaining <= 2) {
              paintFinalZero();
            }
            stopFocusDirectTick();
            return;
          }
          const remaining = Math.max(0, Math.floor(Number(resp.remainingSec) || 0));
          const total = Math.max(1, Math.floor(Number(resp.totalSec) || 0));
          const mode = resp.mode || 'earn';
          // At 0: the EARN countdown shows its final 00:00 frame (user spec
          // 2026-07: "stopping and finishing on 0:00"); the SPEND (break)
          // countdown still hides instantly (v24 spec: "shouldn't show 0:00
          // below the timer once the break ends").
          if (remaining <= 0) {
            if (mode === 'earn') {
              lastTotal = total;
              paintFinalZero();
            } else if (closerCountdown) {
              closerCountdown.classList.add('pf-hidden');
            }
            stopFocusDirectTick();
            return;
          }
          lastMode = mode;
          lastRemaining = remaining;
          lastTotal = total;
          // Write DIRECTLY to the countdown DOM element, unconditionally.
          if (closerCountdown && countdownTime && countdownLabel) {
            closerCountdown.classList.remove('pf-hidden');
            countdownLabel.textContent = mode === 'spend' ? 'Break' : 'Earn break in';
            countdownTime.textContent = fmt(remaining);
            countdownTime.classList.remove('pf-done');
          }
          // Drive the progress ring directly from the same fresh values so it
          // never lags behind the text. Earn = green clockwise, spend = same.
          try {
            const elapsedForRing = Math.max(0, Math.min(total, total - remaining));
            const fraction = total > 0 ? Math.min(1, Math.max(0, elapsedForRing / total)) : 0;
            const angleDeg = fraction * 360;
            paintProgressRing(angleDeg, false, {
              timerMode: mode,
              timerActive: true,
              timerTotalSec: total,
              timerRemainingSec: remaining,
              timerElapsedSec: elapsedForRing
            });
          } catch (_) { /* ring paint is best-effort */ }
        });
      } catch (_) { /* runtime unavailable — retry next tick */ }
    };
    poll();
    focusDirectTickInterval = setInterval(poll, 500);
  }
  function stopFocusDirectTick() {
    focusDirectActive = false;
    if (focusDirectTickInterval) {
      clearInterval(focusDirectTickInterval);
      focusDirectTickInterval = null;
    }
  }

  // ── v83 post-onboarding button walkthrough ──────────────────────────────
  // Two stages only (user spec: "the first two things ... not the last timer
  // one"): hold to turn the closer ON, then hold to turn it back OFF. It
  // coaches the REAL button, so there is no mock state to keep in sync — we
  // just watch for the genuine hold completing and advance.
  const PF_COACH_FLAG = 'pfButtonWalkthroughPending';
  // 0 = not running, 1 = awaiting hold ON, 2 = awaiting hold OFF,
  // 3 = showing the double-click tip (dismissed by Got it, not by a hold).
  let pfCoachStage = 0;

  function pfCoachEls() {
    const root = shadow || null;
    if (!root) return null;
    const card = root.getElementById('pfCoach');
    if (!card) return null;
    return {
      card,
      step: root.getElementById('pfCoachStep'),
      title: root.getElementById('pfCoachTitle'),
      body: root.getElementById('pfCoachBody'),
      skip: root.getElementById('pfCoachSkip'),
      stack: root.querySelector('.pf-btn-stack')
    };
  }

  /**
   * v83 (user spec): during the 30-minute test the closer has nothing to act
   * on — classification is fully local and the user has not labelled anything
   * yet — so holding the button turns on a feature that visibly does nothing.
   * Say so rather than letting them conclude it is broken.
   *
   * Signed in => no note. Signed out with a live trial => note. Read straight
   * from storage: pfSession is written on sign-in, pfTrialState by the worker.
   */
  async function pfCoachTrialNote() {
    try {
      const s = await chrome.storage.local.get(['pfSession', 'pfTrialState']);
      if (s?.pfSession?.access_token) return null;
      const t = s?.pfTrialState;
      const inTrial = !!t && t.consumed !== true && Number(t.startedAt) > 0;
      if (!inTrial) return null;
      return 'This will not do anything until you classify sites yourself or sign in.';
    } catch (_) { return null; }
  }

  function pfCoachRender(stage) {
    const el = pfCoachEls();
    if (!el) return;
    // Append (or clear) the trial caveat under the stage copy.
    void pfCoachTrialNote().then((note) => {
      const card = el.card;
      let n = card.querySelector('.pf-coach-trial');
      if (!note) { n?.remove(); return; }
      if (!n) {
        n = document.createElement('span');
        n.className = 'pf-coach-trial';
        n.style.cssText = 'display:block;margin-top:8px;padding:7px 9px;'
          + 'border-radius:8px;background:#fff4e5;border:1px solid #f0d3a0;'
          + 'color:#8a5a00;font-size:11.5px;line-height:1.4;';
        el.body.insertAdjacentElement('afterend', n);
      }
      n.textContent = note;
    });
    if (stage === 1) {
      el.step.textContent = 'Step 1 of 3';
      el.title.textContent = 'This is your focus button';
      el.body.textContent = 'It sits on every page. Hold it for 2 seconds to turn the tab closer on.';
    } else if (stage === 2) {
      el.step.textContent = 'Step 2 of 3';
      el.title.textContent = 'Closer is on';
      el.body.textContent = 'Unproductive tabs will now close when you hit your limit. Hold the button for 5 seconds to turn it back off.';
    } else {
      // v83 (user spec): the double-click gesture is invisible otherwise —
      // nothing on the button hints that it opens anything.
      el.step.textContent = 'Step 3 of 3';
      el.title.textContent = 'Double-click for quick settings';
      el.body.textContent = 'Double-click the button any time to open your quick settings. While a timer is running you get the full screen timer instead.';
      if (el.skip) el.skip.textContent = 'Got it';
    }
    el.card.hidden = false;
    el.stack?.classList.add('pf-coach-target');
    requestAnimationFrame(() => el.card.classList.add('pf-visible'));
  }

  function pfCoachEnd() {
    pfCoachStage = 0;
    const el = pfCoachEls();
    if (el) {
      el.card.classList.remove('pf-visible');
      el.stack?.classList.remove('pf-coach-target');
      setTimeout(() => { if (el.card) el.card.hidden = true; }, 240);
    }
    try {
      chrome.runtime.sendMessage({ action: 'pfButtonWalkthroughDone' });
    } catch (_) { /* worker asleep — the flag also clears on next arm */ }
  }

  /** Called from runHoldAnimation the moment a real hold completes. */
  function pfCoachOnHoldComplete(direction) {
    if (!pfCoachStage) return;
    if (pfCoachStage === 1 && direction === 'on') {
      pfCoachStage = 2;
      pfCoachRender(2);
    } else if (pfCoachStage === 2 && direction === 'off') {
      // Stage 3 is not hold-driven — it ends on the Got it button.
      pfCoachStage = 3;
      pfCoachRender(3);
    }
  }

  let pfCoachClaimAsked = false;

  async function pfCoachMaybeStart() {
    try {
      // Only on real pages with a real button, and only once.
      if (pfCoachStage || pfCoachClaimAsked) return;
      if (!/^https?:/i.test(location.href)) return;
      const s = await chrome.storage.local.get(PF_COACH_FLAG);
      if (s?.[PF_COACH_FLAG] !== true) return;
      // Ask the worker whether THIS tab owns the walkthrough. Every open tab
      // sees the pending flag, so without this each one drew its own card
      // (user report: "it shows the tutorial steps on every open site").
      // The worker decides from sender.tab.id — a tab cannot read its own id,
      // and cannot claim someone else's.
      pfCoachClaimAsked = true;
      const res = await chrome.runtime
        .sendMessage({ action: 'pfClaimButtonWalkthrough' })
        .catch(() => null);
      if (res?.allowed !== true) return;
      const el = pfCoachEls();
      if (!el) return;
      pfCoachStage = 1;
      pfCoachRender(1);
      // Not { once: true }: the button is relabelled to "Got it" on stage 3
      // and must still work there.
      el.skip?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pfCoachEnd();
      });
    } catch (_) { /* never block the indicator on this */ }
  }

  function isHoldInProgress() {
    return isHoldingActive === true;
  }

  function isPointerInsideHoldTarget(e) {
    const target = holdTarget || btnStack || btn;
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
  }

  function releaseHoldPointerCapture() {
    if (holdPointerId == null || !holdTarget) return;
    try {
      if (holdTarget.hasPointerCapture?.(holdPointerId)) {
        holdTarget.releasePointerCapture(holdPointerId);
      }
    } catch (_) { /* ignore */ }
    holdPointerId = null;
  }

  function isCloserToggleOn(state) {
    return state?.toggleLimitsEnabled === true || state?.limitsEnabled === true;
  }

  function timerSessionKey(state) {
    if (!state) return '';
    return [
      state.timerMode || 'none',
      state.studyTimerEnabled === true ? '1' : '0',
      state.unprodTimerEnabled === true ? '1' : '0',
      Number(state.timerTotalSec) || 0,
      Number(state.timerStartedAt) || 0,
      state.timerPaused === true ? '1' : '0',
      state.timerJustCompleted === true ? '1' : '0',
      state.unprodBudgetTicking === true ? '1' : '0'
    ].join('|');
  }

  // Monotonic-display guard. Within a single timer session (identified by
  // timerStartedAt), the displayed remaining must never INCREASE — that's
  // the visual backward-snap stutter we'd otherwise see when the SW worker
  // tick fires slightly early, skips an increment, and the next broadcast
  // arrives with a remaining HIGHER than what extrapolation already showed.
  // Tracked per-session so a new timer (different startedAt) resets the
  // floor.
  let pfMonotonicSessionKey = '';
  let pfMonotonicMinRemaining = Infinity;
  // Separate monotonic floor for the Mode B focus ('earn') countdown. A simple
  // ratchet that only counts down — does NOT depend on sessionKey, so it can't
  // reset mid-session and cause a snap-back. Reset to Infinity when earn mode
  // is no longer active.
  let pfEarnMonotonicFloor = Infinity;

  function getDisplayRemainingSec(state) {
    const totalSec = Number(state?.timerTotalSec) || 0;
    let remaining = Math.max(0, Number(state?.timerRemainingSec) || 0);

    // Mode B focus session ('earn' mode with a Start-timer-driven countdown):
    // display the broadcast value with LIGHT extrapolation (capped under 1s so
    // it can never overshoot the next 1-second broadcast) and a simple
    // monotonic-only-counts-down guard that does NOT depend on sessionKey.
    // The old extrapolation (1.75s cap) + sessionKey-keyed floor caused a
    // visible snap-back: the display dropped ~3s, then jumped back up when the
    // next broadcast arrived only 1s lower and the floor reset. This guard
    // guarantees the displayed value never increases between renders.
    if (state?.timerMode === 'earn' && state?.timerActive === true && state?.timerPaused !== true) {
      const recvAt = Number(state?.__receivedAt) || Date.now();
      const sinceSec = Math.min(0.9, Math.max(0, (Date.now() - recvAt) / 1000));
      let val = Math.max(0, remaining - sinceSec);
      if (totalSec > 0) val = Math.min(totalSec, val);
      // If the raw broadcast remaining jumped well ABOVE the floor, this is a
      // new session (e.g. user re-clicked Start with a fresh duration). Reset
      // the floor so the new countdown isn't clamped to the old session's low.
      if (remaining > pfEarnMonotonicFloor + 2) {
        pfEarnMonotonicFloor = val;
      }
      // Monotonic: never display more than the last value we showed. This is
      // a single ratchet (no sessionKey), so it can't reset mid-session.
      if (val > pfEarnMonotonicFloor) val = pfEarnMonotonicFloor;
      else pfEarnMonotonicFloor = val;
      return val;
    }
    // Reset the earn floor when earn mode is no longer active.
    if (pfEarnMonotonicFloor !== Infinity && state?.timerMode !== 'earn') {
      pfEarnMonotonicFloor = Infinity;
    }

    // Local extrapolation between broadcasts: subtract wall-clock time
    // elapsed since the SW last sent us a state. Without this, broadcast
    // jitter (SW briefly throttled or off-tick) makes the displayed
    // countdown stutter — value freezes for ~1.3s then jumps 2s. Only
    // extrapolate when the timer is actively running and not paused.
    //
    // CRITICAL: cap extrapolation at MAX_EXTRAPOLATION_SEC. If the SW stops
    // broadcasting (e.g. Chrome loses focus → earn timer freezes), the
    // unbounded extrapolation would keep counting down past the real frozen
    // progress, then snap back when focus returns — looking like a reset.
    // Broadcasts arrive ~every second, so 1.75s is enough to smooth jitter
    // without letting the display drift far past actual progress.
    const MAX_EXTRAPOLATION_SEC = 1.75;
    if (state?.timerActive === true && state?.timerPaused !== true && state?.__receivedAt) {
      const sinceBroadcastSec = Math.min(
        MAX_EXTRAPOLATION_SEC,
        Math.max(0, (Date.now() - state.__receivedAt) / 1000)
      );
      remaining = Math.max(0, remaining - sinceBroadcastSec);
    }
    const capped = totalSec > 0 ? Math.min(totalSec, remaining) : remaining;

    // Apply monotonic floor for active+running sessions ONLY. Paused timers
    // (advanced earn on blur etc.) intentionally HOLD their displayed
    // value rather than ratcheting — but the displayed value comes from
    // the broadcast directly in that case, so monotonic still holds.
    if (state?.timerActive === true && state?.timerPaused !== true) {
      const sessionKey = `${state.timerMode || 'none'}|${Number(state.timerStartedAt) || 0}|${totalSec}`;
      if (sessionKey !== pfMonotonicSessionKey) {
        pfMonotonicSessionKey = sessionKey;
        pfMonotonicMinRemaining = capped;
      } else if (capped < pfMonotonicMinRemaining) {
        pfMonotonicMinRemaining = capped;
      }
      // Never DISPLAY a value larger than what we've already shown — that's
      // the backward-snap bug. If broadcast comes in with higher remaining
      // (e.g. SW tick skipped an increment), clamp to the floor and wait
      // for extrapolation to naturally catch up below the broadcast value.
      return Math.min(capped, pfMonotonicMinRemaining);
    }
    return capped;
  }

  function getDisplayElapsedSec(state) {
    const totalSec = Number(state?.timerTotalSec) || 0;
    const remaining = getDisplayRemainingSec(state);
    return totalSec > 0 ? Math.max(0, totalSec - remaining) : Math.max(0, Number(state?.timerElapsedSec) || 0);
  }

  function syncTimerBaselineFromState() {
    /* wall-clock timers: worker broadcasts authoritative remaining every second */
  }

  function isTimerHoldBlocked(state) {
    return isTimerUiActive(state);
  }

  function formatTimerRemaining(totalSec, elapsedSec, timerState) {
    const total = Number(totalSec) || 0;
    const remainingSec = getDisplayRemainingSec(timerState);
    const elapsed = total > 0
      ? Math.min(total, Math.max(0, total - remainingSec))
      : Math.max(0, Number(elapsedSec) || 0);
    const m = Math.floor(remainingSec / 60);
    const s = Math.floor(remainingSec % 60);
    return { elapsed, remainingSec, text: `${m}:${String(s).padStart(2, '0')}` };
  }

  function applyTimerRotation(state) {
    if (!spinAccent) return;
    spinAccent.classList.remove('rotating-unprod', 'rotating-study', 'pf-visible');
    if (!state?.timerActive || !(Number(state.timerTotalSec) > 0)) return;
    spinAccent.classList.add('pf-visible');
    if (state.studyTimerEnabled === true || state.timerMode === 'study') {
      spinAccent.classList.add('rotating-study');
    } else if (state.unprodTimerEnabled === true || state.timerMode === 'unprod') {
      spinAccent.classList.add('rotating-unprod');
    }
  }

  const RING_GREEN = '#8fd41a';
  const RING_GREEN_HI = '#a3e635';
  const RING_TRACK = '#2f4538';
  const RING_TRACK_DARK = '#1f2d26';
  const RING_GRAY = '#5c6570';
  const RING_GRAY_HI = '#727c88';
  const RING_DONE = '#5c6570';

  function applyCenterPuck() {
    if (!btn) return;
    btn.style.background = 'radial-gradient(circle at 38% 32%, #2a313a 0%, #12151a 72%)';
    btn.style.boxShadow = 'inset 0 1px 1px rgba(255,255,255,0.12), inset 0 -2px 3px rgba(0,0,0,0.55)';
    btn.style.border = 'none';
  }

  function ringSolid(color, hi) {
    return `conic-gradient(from 0deg, ${hi} 0deg, ${color} 120deg, ${hi} 240deg, ${color} 360deg)`;
  }

  function paintCloserOnRing() {
    if (!progressRing) return;
    applyCenterPuck();
    progressRing.classList.remove('pf-done');
    progressRing.classList.add('pf-visible');
    progressRing.style.background = ringSolid(RING_GREEN, RING_GREEN_HI);
  }

  function paintIdleCloserRing(state) {
    if (isHoldInProgress()) return;
    const timerState = state || currentState;
    if (isTimerUiActive(timerState)) return;
    // ── REGRESSION LOCK (user report 2026-07-14): the solid GREEN RING is
    // the toggle's ON indicator. It must be visible whenever the closer is
    // ON and no timer is running — an earlier change cleared it here and
    // the button looked dead right after the 2s hold-to-enable completed
    // (applyOnStateInline painted it, then the next state broadcast wiped
    // it through this function). Do NOT remove the closer-on ring again;
    // timer rings still take over automatically while a timer is active
    // because of the isTimerUiActive early-return above. ─────────────────
    if (isCloserToggleOn(timerState)) {
      paintCloserOnRing();
    } else {
      clearProgressRing();
    }
  }

  function clearProgressRing() {
    if (!progressRing) return;
    progressRing.classList.remove('pf-visible', 'pf-done');
    progressRing.style.background = '';
  }

  function paintProgressRing(angleDeg, isDone, timerState) {
    if (!progressRing) return;
    applyCenterPuck();
    progressRing.classList.add('pf-visible');
    if (isDone) {
      progressRing.classList.add('pf-done');
      progressRing.style.background = ringSolid(RING_DONE, '#727c88');
      return;
    }
    progressRing.classList.remove('pf-done');
    const angle = Math.max(0, Math.min(360, angleDeg));
    // Per user spec:
    //   - Study timer (and earn/spend) progress ring fills CLOCKWISE
    //     (green grows from top going right → down → left → top).
    //   - Break / unprod timer fills ANTI-CLOCKWISE so the two are
    //     visually distinct at a glance.
    // conic-gradient(from 0deg) starts at 12 o'clock and proceeds clockwise.
    const isBreakMode = timerState?.timerMode === 'unprod' ||
                        timerState?.timerMode === 'break';
    if (isBreakMode) {
      // Anti-clockwise growth: green band sits at the END of the gradient
      // (between trackSpan and 360deg, which is just LEFT of top). As angle
      // grows, trackSpan shrinks → green extends further counterclockwise.
      const trackSpan = 360 - angle;
      progressRing.style.background = `
        conic-gradient(
          from 0deg,
          ${RING_TRACK} 0deg,
          ${RING_TRACK} ${trackSpan}deg,
          ${RING_GREEN} ${trackSpan}deg,
          ${RING_GREEN_HI} ${trackSpan + angle * 0.45}deg,
          ${RING_GREEN} 360deg)
      `;
    } else {
      // Clockwise growth (default): green band starts at 0deg (top) and
      // extends to `angle` degrees. As angle grows, green sweeps right.
      progressRing.style.background = `
        conic-gradient(
          from 0deg,
          ${RING_GREEN} 0deg,
          ${RING_GREEN_HI} ${angle * 0.45}deg,
          ${RING_GREEN} ${angle}deg,
          ${RING_TRACK} ${angle}deg,
          ${RING_TRACK_DARK} 360deg)
      `;
    }
  }

  function paintHoldProgressRing(fraction) {
    if (!progressRing) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    const angle = clamped * 360;
    applyCenterPuck();
    progressRing.classList.remove('pf-done');
    progressRing.classList.add('pf-visible');
    progressRing.style.background = `
      conic-gradient(
        from 0deg,
        ${RING_GRAY} 0deg,
        ${RING_GRAY_HI} ${angle * 0.45}deg,
        ${RING_GRAY} ${angle}deg,
        ${RING_TRACK_DARK} ${angle}deg,
        ${RING_TRACK_DARK} 360deg)
    `;
  }

  function clearButtonFill() {
    applyCenterPuck();
  }

  function paintButtonFill(_timerState, _fraction, _isDone) {
    applyCenterPuck();
  }

  function isTimerUiActive(timerState) {
    // Hide-at-zero guard runs BEFORE shouldForceTimerVisible so it applies
    // regardless of the force-visible short-circuit. Per user report 2026-07
    // v20 (screenshot of a stuck "BREAK 0:00" pill after the unprod-reminder
    // break ran out): when a break/unprod timer's countdown reaches 0, there's
    // a ~1s window between the pill showing "0:00" and the worker broadcasting
    // idle/timerActive:false. The old ordering ran shouldForceTimerVisible
    // first, which returned true for any live timer and short-circuited past
    // this check — so the pill sat at "BREAK 0:00" until the next broadcast.
    // Now the zero-out check runs first: as soon as remaining hits 0 for a
    // running (non-paused) break/unprod, the pill hides immediately.
    const modeForZeroCheck = timerState?.timerMode;
    if ((modeForZeroCheck === 'unprod' || modeForZeroCheck === 'break') &&
        timerState?.timerPaused !== true &&
        getDisplayRemainingSec(timerState) <= 0) {
      return false;
    }
    if (shouldForceTimerVisible(timerState)) {
      return timerState?.timerActive === true && Number(timerState?.timerTotalSec) > 0;
    }
    return timerState?.timerActive === true &&
      Number(timerState?.timerTotalSec) > 0 &&
      timerState?.timerMode !== 'none';
  }

  function paintPrivacyDisclaimer(state) {
    // Retired (user spec 2026-07 v18): the floating "This site is not
    // classified for privacy reasons" line above the pill was cluttering
    // the page; the same message now lives in the extension popup below
    // the "Open Dashboard" button (see popup.html #pfPopupPrivacyBlocked).
    // Kept as a no-op so any old caller still resolves cleanly, and the
    // DOM element stays in the shadow tree in case a future revert wants
    // to bring it back with a click-through.
    if (!privacyDisclaimer) return;
    privacyDisclaimer.classList.remove('pf-visible');
    void state;
  }

  function updateCountdownPanel(timerState, remainingText, isDone) {
    if (!closerCountdown || !countdownLabel || !countdownTime) return;
    // When the independent focus-countdown direct writer is active (a Mode B
    // focus/earn session is running), it owns the countdown text — this
    // function must NOT overwrite it. Without this guard, the old render chain
    // and the direct writer fought over the same DOM element every tick,
    // causing the visible flash between the stale broadcast value and the
    // fresh direct-polled value. Per user report (2026-07).
    if (focusDirectActive && (timerState?.timerMode === 'earn' || timerState?.timerMode === 'spend')) return;
    const isStudy = timerState?.studyTimerEnabled === true || timerState?.timerMode === 'study';
    const showPanel = isTimerUiActive(timerState);

    if (!showPanel) {
      // Idle state (per user spec 2026-07): no timer running → the
      // floating button shows the TOGGLE ONLY, no countdown chrome. The
      // previous "Banked X" fallback made it look like a timer was
      // always running whenever the user had Advanced Earn balance
      // saved up; that's now suppressed and the banked balance shows
      // in the dashboard instead.
      closerCountdown.classList.add('pf-hidden');
      countdownLabel.textContent = '';
      countdownTime.textContent = '';
      countdownTime.classList.remove('pf-done');
      return;
    }

    closerCountdown.classList.remove('pf-hidden');
    // Label depends on mode:
    //   study  → "Work/Study"
    //   earn   → "Earn break in"  (Advanced Earn cycle countdown)
    //   spend  → "Spend"           (Advanced Spend countdown)
    //   else   → "Break"           (regular break/unprod timer)
    const mode = timerState?.timerMode;
    let label;
    if (isStudy) label = 'Work/Study';
    else if (mode === 'earn') label = 'Earn break in';
    else if (mode === 'spend') label = 'Break';
    else label = 'Break';
    countdownLabel.textContent = label;
    countdownTime.textContent = remainingText;
    countdownTime.classList.toggle('pf-done', isDone === true);
  }

  // ── Auto-restart dwell banner ────────────────────────────────────────────
  // When the user is mid-break and navigates to a source site, the worker
  // accrues a 30s dwell before auto-starting a fresh focus session (refunding
  // the unused break time). This surfaces that as a small toast so the user
  // knows their break is about to end and a focus block is starting.
  let dwellBannerEl = null;
  function fmtShort(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec >= 3600) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    return `${sec}s`;
  }
  function syncAutoRestartDwellBanner(state) {
    // Per user spec (2026-07): the pill must show ONLY on source sites and
    // update every second. Gate on the worker-computed `onSource` flag so a
    // stale anti-flicker grace period doesn't leave the pill visible off-
    // source; extrapolate `sec` client-side using `lastTickAt` so the
    // countdown ticks every 1s between the ~1 Hz broadcasts.
    const dwell = state?.bankAutoRestartDwell;
    // sec >= 0 (was > 0): the worker now seeds the dwell at 0 the moment
    // the user lands on a source tab, so the banner appears instantly with
    // the full countdown instead of one second late (user spec 2026-07).
    const shouldShow = !!dwell && typeof dwell.sec === 'number' && dwell.sec >= 0
      && typeof dwell.thresholdSec === 'number' && dwell.sec < dwell.thresholdSec
      && dwell.onSource === true;
    if (!shouldShow) {
      if (dwellBannerEl) {
        // Remove the rehome fullscreen listener registered on creation —
        // without this, every banner show/hide cycle leaked one permanent
        // capture-phase listener retaining the detached banner element.
        if (dwellBannerEl.__pfRehome) {
          try { document.removeEventListener('fullscreenchange', dwellBannerEl.__pfRehome, true); } catch (_) {}
        }
        try { dwellBannerEl.remove(); } catch (_) {}
        dwellBannerEl = null;
      }
      return;
    }
    if (!dwellBannerEl) {
      dwellBannerEl = document.createElement('div');
      dwellBannerEl.id = 'pf-auto-restart-dwell-banner';
      // Restyled as a prominent purple pill so users spot it without
      // scanning — matches the closer indicator's timer aesthetic and reads
      // as "a separate timer" per user report 2026-07.
      dwellBannerEl.style.cssText = [
        'position:fixed', 'left:50%', 'top:20px', 'transform:translateX(-50%)',
        'z-index:2147483645', 'pointer-events:none',
        'font-family:-apple-system,system-ui,"Segoe UI",sans-serif',
        'background:linear-gradient(180deg,#6c5cb5 0%,#5B4B9F 100%)',
        'color:#fff',
        'border:1px solid rgba(255,255,255,0.35)', 'border-radius:999px',
        'padding:11px 22px', 'font-size:1em', 'font-weight:700',
        'letter-spacing:0.01em',
        'box-shadow:0 10px 28px rgba(91,75,159,0.42), 0 1px 0 rgba(255,255,255,0.25) inset',
        'color-scheme:light',
        'display:inline-flex', 'align-items:center', 'gap:8px'
      ].join(';');
      const root = document.fullscreenElement || document.body || document.documentElement;
      try { root.appendChild(dwellBannerEl); } catch (_) {}
      // Re-home on fullscreen change so it stays visible over a fullscreen video.
      const rehome = () => {
        try {
          const dest = document.fullscreenElement || document.body || document.documentElement;
          if (dwellBannerEl && dwellBannerEl.parentNode !== dest) dest.appendChild(dwellBannerEl);
        } catch (_) {}
      };
      document.addEventListener('fullscreenchange', rehome, true);
      dwellBannerEl.__pfRehome = rehome;
    }
    // Client-side extrapolation: `sec` came from the worker's last tick.
    // Advance it by the wall-clock time elapsed since that tick (up to
    // thresholdSec) so the pill updates every second even between the
    // 1 Hz broadcasts.
    const lastTickAt = Number(dwell.lastTickAt) || 0;
    const drift = lastTickAt > 0 ? Math.max(0, Math.floor((Date.now() - lastTickAt) / 1000)) : 0;
    const effectiveSec = Math.min(dwell.thresholdSec, Math.max(dwell.sec, dwell.sec + drift));
    const remaining = Math.max(0, dwell.thresholdSec - effectiveSec);
    dwellBannerEl.textContent = `Start Study/Work Timer in ${remaining}s`;
  }

  function applyHostTimerLayout(_timerState) {
    hostEl.style.bottom = '12px';
  }

  function resetTimerVisuals() {
    updateCountdownPanel(null, '', false);
    if (pauseIcon) pauseIcon.classList.remove('pf-visible');
    applyTimerRotation({ timerActive: false });
    paintIdleCloserRing(currentState);
  }

  // Celebration confetti for timer completion: confetti rains down across the
  // FULL screen then disappears. Self-contained canvas animation (does not
  // depend on pf_confirm_confetti.js).
  let timerCompletionConfettiShownFor = 0;
  // Dedup guard for advanced-earn cycle completion confetti (separate from the
  // timer-session guard because earn cycles recur while the timer keeps running).
  let bankCycleConfettiShownFor = 0;
  function fireTimerCompletionConfetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = [
      'position:fixed!important', 'top:0!important', 'left:0!important',
      'width:100vw!important', 'height:100vh!important',
      'pointer-events:none!important', 'z-index:2147483647!important'
    ].join(';');
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    // Attach to document.fullscreenElement if one is active — that element
    // is in the browser top layer, so a child canvas rides along and is
    // visible OVER fullscreen video. Without this, the canvas attaches to
    // document.body and is hidden under the fullscreen overlay (user sees
    // no confetti). Falls back to body for non-fullscreen pages.
    const root = document.fullscreenElement
      || document.webkitFullscreenElement
      || document.body
      || document.documentElement;
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return; }

    const COLORS = ['#28a745', '#8b5cf6', '#f59e0b', '#3b82f6', '#ec4899', '#10b981'];
    const particles = [];
    // Confetti spawns across the top edge and rains down.
    for (let i = 0; i < 140; i++) {
      particles.push({
        x: Math.random() * w,
        y: -20 - Math.random() * h * 0.5,
        vx: (Math.random() - 0.5) * 3,
        vy: 2 + Math.random() * 4,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.3,
        size: 6 + Math.random() * 8,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        shape: Math.random() < 0.5 ? 'rect' : 'circle'
      });
    }
    const startTime = Date.now();
    const DURATION = 3000;
    function animate() {
      const elapsed = Date.now() - startTime;
      if (elapsed > DURATION) { canvas.remove(); return; }
      ctx.clearRect(0, 0, w, h);
      const fadeAlpha = elapsed < DURATION * 0.7
        ? 1
        : Math.max(0, 1 - (elapsed - DURATION * 0.7) / (DURATION * 0.3));
      particles.forEach((p) => {
        p.vy += 0.12;       // gentle gravity
        p.vx *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        if (p.y > h + 30) return;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = fadeAlpha;
        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  function paintTimer(timerState) {
    if (isHoldInProgress()) return;

    applyHostTimerLayout(timerState);

    // Fire celebration confetti ONLY when a genuine timer session completes.
    // Require: a real timer session existed (timerStartedAt > 0) AND the
    // completion flag is set AND we haven't already celebrated this session.
    // This prevents confetti firing on a toggle-on that re-broadcasts a stale
    // timerJustCompleted flag from an earlier (now-ended) session.
    //
    // Suppression rules (per user spec):
    //   - 'unprod' (break) completion: never fires confetti — break ending
    //     is not a celebration moment, the user has to get back to work.
    //   - 'study' completion while Advanced Earn/Spend is active: suppressed
    //     so the user doesn't get a phantom celebration when they turn off
    //     the study timer mid-cycle with earn/spend running. The earn cycle
    //     wrap fires its own confetti when it actually hits its target.
    const completedStartedAt = Number(timerState?.timerStartedAt) || 0;
    const completedMode = timerState?.timerCompletedMode || null;
    const advancedEarnActive = timerState?.advancedEarnActive === true;
    const suppressConfetti =
      completedMode === 'unprod' ||
      (completedMode === 'study' && advancedEarnActive);
    if (
      timerState?.timerJustCompleted === true
      && completedStartedAt > 0
      && completedStartedAt !== timerCompletionConfettiShownFor
      && !suppressConfetti
      && document.visibilityState === 'visible'
    ) {
      timerCompletionConfettiShownFor = completedStartedAt;
      fireTimerCompletionConfetti();
    } else if (completedStartedAt === 0) {
      // No active/completed timer session — reset the guard so the next genuine
      // completion can fire again.
      timerCompletionConfettiShownFor = 0;
    }

    // Advanced-earn cycle completion: when the focus target is hit and a deposit
    // banks, the worker stamps bankCycleHitAt in the broadcast. Fire the same
    // full-screen confetti as the study timer, deduped by the cycle timestamp so
    // each cycle celebrates exactly once (the worker may re-broadcast within the
    // 2.5s window). Separate guard from the timer-session confetti above because
    // earn cycles recur with distinct timestamps while the timer is still running.
    //
    // CRITICAL: only fire on the VISIBLE tab. The broadcast goes to every tab in
    // the window, so without this guard confetti fired on background / unloaded
    // tabs too — the user saw it "randomly show up on another unloaded site."
    // Per user report (2026-07).
    const bankCycleHitAt = Number(timerState?.bankCycleHitAt) || 0;
    if (
      timerState?.bankCycleJustCompleted === true
      && bankCycleHitAt > 0
      && bankCycleHitAt !== bankCycleConfettiShownFor
      && document.visibilityState === 'visible'
    ) {
      bankCycleConfettiShownFor = bankCycleHitAt;
      fireTimerCompletionConfetti();
    } else if (bankCycleHitAt === 0) {
      bankCycleConfettiShownFor = 0;
    }

    if (timerState?.timerJustCompleted === true && timerState?.timerCompletedMode === 'study') {
      resetTimerVisuals();
      const ongoingTimer = timerState?.timerActive === true &&
        Number(timerState?.timerTotalSec) > 0 &&
        !timerState?.studyTimerEnabled;
      if (!ongoingTimer) {
        applyHostTimerLayout({ timerActive: false });
        pfRevealIndicatorAfterFirstPaint();
        return;
      }
    } else if (timerState?.timerJustCompleted === true) {
      resetTimerVisuals();
      pfRevealIndicatorAfterFirstPaint();
      return;
    }

    const totalSec = Number(timerState?.timerTotalSec) || 0;
    const timerVisible = isTimerUiActive(timerState);

    if (!timerState || !timerVisible) {
      paintIdleCloserRing(timerState);
      updateCountdownPanel(timerState, '', false);
      if (pauseIcon) pauseIcon.classList.remove('pf-visible');
      applyTimerRotation({ timerActive: false });
      pfRevealIndicatorAfterFirstPaint();
      return;
    }

    if (pauseIcon) {
      pauseIcon.classList.toggle('pf-visible', timerState.timerPaused === true);
    }

    const { elapsed, remainingSec, text: remainingText } = formatTimerRemaining(
      totalSec,
      timerState.timerElapsedSec || 0,
      timerState
    );
    // Discrete per-second ring stepping: round elapsed to whole seconds so
    // the ring only advances when the displayed countdown text ticks. Using
    // the raw extrapolated `elapsed` made the ring crawl continuously
    // between seconds, which looked jittery and noisy.
    const remainingForRing = Math.floor(remainingSec);
    const elapsedForRing = totalSec > 0
      ? Math.max(0, Math.min(totalSec, totalSec - remainingForRing))
      : Math.floor(elapsed);
    const fraction = totalSec > 0 ? Math.min(1, Math.max(0, elapsedForRing / totalSec)) : 0;
    const angleDeg = fraction * 360;

    // When the focus direct writer owns the display, skip the ring + countdown
    // paint here — the direct writer paints both from the authoritative polled
    // value. Without this guard, paintTimer overwrote the direct writer's ring
    // with a stale broadcast-derived value every 250ms, causing the visible
    // flicker. Per user report (2026-07).
    if (!(focusDirectActive && (timerState?.timerMode === 'earn' || timerState?.timerMode === 'spend'))) {
      paintProgressRing(angleDeg, false, timerState);
      updateCountdownPanel(timerState, remainingText, false);
    }
    applyTimerRotation(timerState);
    // First COMPLETE composition (ring + countdown + icons) is on screen.
    pfRevealIndicatorAfterFirstPaint();
  }

  function hideButtonAutomatically() {
    isAutoHidden = true;
    if (btnStack) {
      btnStack.style.opacity = '0.35';
      btnStack.style.transition = 'opacity 0.4s ease-out';
    }
    console.info('[pf-indicator-debug] auto-hidden (faded) after 1.4s hover',
      { lastPushTimerElapsedSec, lastPushAtMs });
  }

  function showButtonAfterAutoHide() {
    isAutoHidden = false;
    if (btnStack) {
      btnStack.style.opacity = '';
      btnStack.style.transition = '';
    }
    console.info('[pf-indicator-debug] re-shown',
      { lastPushTimerElapsedSec, lastPushAtMs });
  }

  function setIndicatorVisible(visible) {
    if (!hostEl) return;
    // While the fullscreen focus timer is up, the pill stays invisible no
    // matter what the render pipeline decides — it re-runs on every state
    // broadcast and was resurrecting the corner pill (user report 2026-07).
    // display:none (not visibility) — shadow children carry explicit
    // visibility:visible which overrides an ancestor's hidden.
    hostEl.style.display = (visible && !pfFsHost) ? '' : 'none';
  }

  // --- Wave + fly-to-corner reveal animation -------------------------------
  // Plays an "invisible wave" sweeping across the viewport with the timer value
  // (or toggle label) shown big in the center, then the text flies down to the
  // bottom-right where the actual button lives. Used on first page-show and on
  // toggle on/off. `label` is what to show in the center; `accent` is the wave
  // color (#28a745 green for on/first-show, #d9534f red for off).
  // mode 'wave'      = neutral invisible wave expanding from the button, NO
  //                    label, NO green (toggle on/off). Fades as it expands.
  // mode 'fly'       = label previews above the button (green accent), then
  //                    flies down to the bottom-right corner button.
  // mode 'centerFly' = label appears in the MIDDLE of the screen with a green
  //                    fade, then moves down to the bottom-right corner button.
  //                    Used when the user opens the next tab after starting a
  //                    timer (the "carry-over" preview).
  function playWaveAnimation(label, accent, mode = 'wave') {
    if (!hostEl) return;
    const rect = (btn || hostEl).getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const cornerX = window.innerWidth - rect.right + rect.width / 2;
    const cornerY = window.innerHeight - rect.bottom + rect.height / 2;

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'margin:0',
      'pointer-events:none', 'z-index:2147483647', 'overflow:hidden'
    ].join(';');

    // The wave: a FILLED circle (no hole) that expands and fades.
    // Origin depends on mode:
    //  - 'wave' / 'fly': from the button (originX/originY)
    //  - 'centerFly': from the CENTER of the screen (where the numbers appear),
    //    so the green flash emanates from the timer value, not the button.
    const isNeutral = mode === 'wave';
    const waveColor = isNeutral ? 'rgba(255,255,255,0.22)' : accent;
    const waveX = mode === 'centerFly' ? window.innerWidth / 2 : originX;
    const waveY = mode === 'centerFly' ? window.innerHeight / 2 : originY;
    const wave = document.createElement('div');
    wave.style.cssText = [
      'position:absolute',
      `left:${waveX}px`, `top:${waveY}px`,
      'width:12px', 'height:12px', 'border-radius:50%',
      `background:radial-gradient(circle, ${waveColor} 0%, ${waveColor} 55%, rgba(255,255,255,0) 100%)`,
      'border:none',
      'transform:translate(-50%,-50%) scale(0)',
      'opacity:0.85',
      'box-shadow:none'
    ].join(';');
    overlay.appendChild(wave);

    // The preview label is created in 'fly' and 'centerFly' modes.
    let text = null;
    let textAnim = null;
    if ((mode === 'fly' || mode === 'centerFly') && label) {
      text = document.createElement('div');
      text.textContent = String(label);
      const baseTextStyles = [
        'position:absolute',
        'z-index:2',
        'font-family:-apple-system,Segoe UI,Roboto,sans-serif',
        'font-size:clamp(34px,7vw,72px)',
        'font-weight:800',
        `color:${accent}`,
        'text-shadow:0 6px 30px rgba(0,0,0,0.35)',
        'letter-spacing:-0.02em',
        'opacity:0',
        'white-space:nowrap',
        'will-change:transform,opacity'
      ];
      if (mode === 'centerFly') {
        // Start in the middle of the screen.
        baseTextStyles.push(`left:50%`, `top:50%`, 'transform:translate(-50%,-50%) scale(0.6)');
      } else {
        // Start just above the button.
        baseTextStyles.push(`left:${originX}px`, `top:${originY - rect.height / 2 - 24}px`, 'transform:translate(-50%,-50%) scale(0.6)');
      }
      text.style.cssText = baseTextStyles.join(';');
      overlay.appendChild(text);
    }

    try {
      (document.body || document.documentElement).appendChild(overlay);
    } catch (_) {
      try { shadow.appendChild(overlay); } catch (__) { return; }
    }

    // Wave expands from the button outward and fades.
    const maxScale = Math.hypot(window.innerWidth, window.innerHeight) / 6;
    const waveAnim = wave.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: 0.9, offset: 0 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.85, offset: 0.15 },
        { transform: `translate(-50%,-50%) scale(${maxScale})`, opacity: 0, offset: 1 }
      ],
      { duration: 950, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' }
    );

    const anims = [waveAnim];

    if (text) {
      if (mode === 'centerFly') {
        // Pop in at center, hold, then fly to the bottom-right corner.
        textAnim = text.animate(
          [
            { transform: 'translate(-50%,-50%) scale(0.6)', opacity: 0, offset: 0 },
            { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.3 },
            { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.6 },
            // Fly to the corner button, shrinking as it lands.
            { transform: `translate(${cornerX}px, ${cornerY}px) scale(0.2)`, opacity: 0, offset: 1 }
          ],
          { duration: 1500, easing: 'cubic-bezier(0.45,0,0.2,1)', fill: 'forwards' }
        );
      } else {
        // 'fly' mode: preview above button, then fly down to the corner.
        textAnim = text.animate(
          [
            { transform: 'translate(-50%,-50%) scale(0.5)', opacity: 0, offset: 0 },
            { transform: 'translate(-50%,-110%) scale(1)', opacity: 1, offset: 0.28 },
            { transform: 'translate(-50%,-110%) scale(1)', opacity: 1, offset: 0.55 },
            { transform: `translate(${cornerX}px, ${cornerY}px) scale(0.2)`, opacity: 0, offset: 1 }
          ],
          { duration: 1300, easing: 'cubic-bezier(0.45,0,0.2,1)', fill: 'forwards' }
        );
      }
      anims.push(textAnim);
    }

    Promise.all(anims.map((a) => a.finished))
      .catch(() => {})
      .finally(() => { overlay.remove(); });
  }

  function clearUnreadableShowTimer() {
    if (unreadableShowTimer) {
      clearTimeout(unreadableShowTimer);
      unreadableShowTimer = null;
    }
  }

  function showUnreadableUiNow() {
    if (unreadableBadge) unreadableBadge.classList.add('pf-visible');
    if (unreadableNotice) unreadableNotice.classList.add('pf-visible');
  }

  function hideUnreadableUi() {
    clearUnreadableShowTimer();
    if (unreadableBadge) unreadableBadge.classList.remove('pf-visible');
    if (unreadableNotice) unreadableNotice.classList.remove('pf-visible');
  }

  function scheduleUnreadableUi() {
    if (unreadableShowTimer) return;
    if (unreadableNotice?.classList.contains('pf-visible')) return;
    unreadableShowTimer = setTimeout(() => {
      unreadableShowTimer = null;
      if (currentState?.siteUnreadable === true && !shouldForceTimerVisible(currentState)) {
        showUnreadableUiNow();
      }
    }, UNREADABLE_UI_DELAY_MS);
  }

  function paintUnreadableUi(state) {
    if (pfSensitivePageOnly) {
      hideUnreadableUi();
      return false;
    }
    if (shouldForceTimerVisible(state)) {
      hideUnreadableUi();
      return false;
    }
    const unreadable = state?.siteUnreadable === true;
    if (!unreadable) {
      hideUnreadableUi();
      return false;
    }
    const cls = state?.tabClassification || 'Neutral';
    const subEl = unreadableNotice?.querySelector('.pf-unreadable-notice-sub');
    if (subEl) subEl.textContent = `Classified as ${cls}`;
    scheduleUnreadableUi();
    return unreadable;
  }

  function render(state, prevOverride) {
    state = normalizeSensitiveToggleState(state);
    const prevState = prevOverride !== undefined ? prevOverride : currentState;
    currentState = state;
    // Gated: this fires ~1/s per tab while a timer runs; unconditional
    // logging retains every state object in the console.
    if (PF_DEBUG) {
      console.info('[pf-indicator-debug] render called, state:', state,
        'about to call paintTimer');
    }

    // Signed-out gate (per user spec 2026-07): hide the entire floating
    // button and everything attached (dwell banner, hold animations,
    // countdown, focus direct writer) whenever the worker broadcast
    // says the user isn't signed in. Nothing about the extension
    // should be interactive from the page until they sign in.
    if (state?.signedIn === false) {
      setIndicatorVisible(false);
      stopLocalTick();
      stopFocusDirectTick();
      if (isHoldInProgress()) cancelHold();
      if (dwellBannerEl) { try { dwellBannerEl.remove(); } catch (_) {} dwellBannerEl = null; }
      currentState.__visible = false;
      return;
    }

    const willBeVisible = !(state.hideIndicator === true && !shouldForceTimerVisible(state));
    // __visible is only set AFTER the first render, so treat "undefined" as
    // "not yet seen visible" (wasVisible = false on first render) — otherwise
    // the intro never fires and nothing downstream triggers.
    const wasVisible = prevState && prevState.__visible === true;

    if (state.hideIndicator === true && !shouldForceTimerVisible(state)) {
      setIndicatorVisible(false);
      stopLocalTick();
      if (isHoldInProgress()) cancelHold();
      if (dwellBannerEl) { try { dwellBannerEl.remove(); } catch (_) {} dwellBannerEl = null; }
      currentState.__visible = false;
      return;
    }
    setIndicatorVisible(true);
    currentState.__visible = true;

    // Per user spec: removed the centerFly/fly/wave preview animations that
    // fired on first reveal, on closer toggle ON, on timer-start, and on
    // advancedEarnActive ON. They were causing a green flash + big-green-text
    // popup every tick on the synthesized earn timer (whose timerStartedAt
    // changes each tick by design) and were also unwanted on the regular
    // study/break timers. Indicator now updates silently.
    if (willBeVisible && !wasVisible && !hasPlayedIntro) {
      hasPlayedIntro = true;
    }

    const siteUnreadable = paintUnreadableUi(state);
    paintPrivacyDisclaimer(state);

    if (isHoldInProgress()) return;

    const closerOn = isCloserToggleOn(state);
    if (closerOn) {
      btn.classList.add('pf-on');
      btn.classList.remove('pf-off');
    } else {
      btn.classList.add('pf-off');
      btn.classList.remove('pf-on');
    }

    if (siteUnreadable && !shouldForceTimerVisible(state)) {
      // Per user spec: still allow the user to arm/disarm the closer on
      // privacy-blocked / unreadable sites. The unreadable notice stays
      // visible but the button is fully interactive — cursor:pointer and
      // a title that nudges them about classification.
      const cls = state?.tabClassification || 'Neutral';
      btn.title = closerOn
        ? `Closer is ON. Hold 5s to turn OFF (site classified as ${cls})`
        : `Closer is OFF. Hold 2s to turn ON (site classified as ${cls})`;
      if (btnStack) btnStack.style.cursor = 'pointer';
    } else if (state.showPrivacyDisclaimer === true && shouldForceTimerVisible(state)) {
      btn.title = 'Work/Study timer active — site not classified for privacy';
      btn.style.cursor = 'default';
    } else if (isTimerUiActive(state)) {
      btn.title = 'Timer running';
      if (btnStack) btnStack.style.cursor = 'default';
    } else if (closerOn) {
      btn.title = 'Closer is ON. Hold 5s to turn OFF';
      if (btnStack) btnStack.style.cursor = 'pointer';
    } else {
      btn.title = 'Closer is OFF. Hold 2s to turn ON';
      if (btnStack) btnStack.style.cursor = 'pointer';
    }

    countdown.classList.remove('pf-visible');
    countdown.textContent = '';
    if (pauseIcon) pauseIcon.classList.remove('pf-visible');

    applyHostTimerLayout(state);

    if (isAutoHidden && !siteUnreadable && !shouldForceTimerVisible(state)) {
      if (btnStack) {
        btnStack.style.opacity = '0.35';
        btnStack.style.transition = 'opacity 0.4s ease-out';
      }
    } else if (btnStack) {
      btnStack.style.opacity = '';
      btnStack.style.transition = '';
    }

    syncTimerBaselineFromState();

    if (isTimerUiActive(state) ||
        shouldForceTimerVisible(state) ||
        (state.timerJustCompleted === true && state.timerCompletedMode !== 'study')) {
      startLocalTick();
    } else {
      stopLocalTick();
    }

    applyTimerRotation(state);
    paintTimer(state);
    syncAutoRestartDwellBanner(state);

    // The live host is moved into the FS dialog (not cloned), so updates to
    // its shadow root propagate automatically. We just need to (re)evaluate
    // whether the overlay should be shown for the current timer state.
    syncFullscreenOverlay();
  }

  function applyOffStateInline() {
    applyCenterPuck();
    clearProgressRing();
    btn.style.transform = '';
  }

  function applyOnStateInline() {
    applyCenterPuck();
    paintCloserOnRing();
    btn.style.transform = '';
  }

  function animateOffHold(fraction) {
    paintHoldProgressRing(fraction);
    btn.style.transform = `scale(${1 - 0.06 * fraction})`;

    const holdSeconds = Math.max(1, Math.ceil(holdDuration / 1000));
    const secondsRemaining = Math.max(1, Math.ceil(holdSeconds * (1 - fraction)));
    if (countdown.textContent !== String(secondsRemaining)) {
      countdown.textContent = String(secondsRemaining);
    }
    countdown.classList.add('pf-visible');
  }

  function animateOnHold(fraction) {
    paintHoldProgressRing(fraction);
    btn.style.transform = `scale(${0.94 + 0.06 * fraction})`;

    const holdSeconds = Math.max(1, Math.ceil(holdDuration / 1000));
    const seconds = Math.min(holdSeconds, Math.max(1, Math.ceil(holdSeconds * (1 - fraction))));
    if (countdown.textContent !== String(seconds)) {
      countdown.textContent = String(seconds);
    }
    countdown.classList.add('pf-visible');
  }

  function runHoldAnimation() {
    if (!isHoldingActive) {
      holdRafId = null;
      return;
    }

    const elapsed = Date.now() - holdStartTime;
    const fraction = Math.min(1, elapsed / holdDuration);

    if (closerCountdown) closerCountdown.classList.add('pf-hidden');

    if (holdDirection === 'off') {
      animateOffHold(fraction);
    } else {
      animateOnHold(fraction);
    }

    if (fraction >= 1) {
      holdCompleted = true;
      isHoldingActive = false;
      releaseHoldPointerCapture();

      const targetEnabled = holdDirection === 'on';
      if (holdDirection === 'off') {
        applyOffStateInline();
      } else {
        applyOnStateInline();
      }

      countdown.classList.remove('pf-visible');
      countdown.textContent = '';

      if (PF_DEBUG) {
        console.info('[pf-indicator-debug] hold completed, sent set limits, direction:', holdDirection,
          'targetEnabled:', targetEnabled);
      }
      if (isAutoHidden) showButtonAfterAutoHide();
      // v83: advance the post-onboarding walkthrough off the REAL hold, so
      // the coaching can never disagree with what the button actually did.
      try { pfCoachOnHoldComplete(holdDirection); } catch (_) { /* non-critical */ }
      holdCompletedAt = Date.now();
      holdCompletedTargetEnabled = targetEnabled;
      // Snapshot the PREVIOUS state BEFORE mutating currentState, so render's
      // prevState comparison actually detects the toggle change (otherwise
      // prevState === state and no transition wave fires).
      const preToggleState = currentState;
      currentState = {
        ...currentState,
        limitsEnabled: targetEnabled,
        toggleLimitsEnabled: targetEnabled
      };
      render(currentState, preToggleState);
      // The toggle just flipped to ON via the hold — fire the wave directly
      // Per user spec: removed the wave animation on hold-complete toggle ON.
      chrome.runtime.sendMessage({ action: 'pfToggleCloser', enabled: targetEnabled });

      if (holdRafId) cancelAnimationFrame(holdRafId);
      holdRafId = null;
      btn.classList.remove('pf-holding');
      if (btnStack) btnStack.classList.remove('pf-holding');
      return;
    }

    holdRafId = requestAnimationFrame(runHoldAnimation);
  }

  function cancelHold() {
    if (holdRafId) cancelAnimationFrame(holdRafId);
    holdRafId = null;
    isHoldingActive = false;
    holdCompleted = false;
    releaseHoldPointerCapture();
    btn.classList.remove('pf-holding');
    if (btnStack) btnStack.classList.remove('pf-holding');
    btn.style.transform = '';
    countdown.classList.remove('pf-visible');
    countdown.textContent = '';
    render(currentState);
  }

  function showHoldBlockedHint(message) {
    if (!holdHint) return;
    if (message && holdHint.textContent !== undefined) {
      // Prefer a dedicated text node if present, else set textContent.
      const sub = holdHint.querySelector('.pf-hold-hint-text');
      if (sub) sub.textContent = message;
      else holdHint.textContent = message;
    }
    holdHint.classList.add('pf-visible');
    if (holdHintTimer) clearTimeout(holdHintTimer);
    holdHintTimer = setTimeout(() => {
      holdHint.classList.remove('pf-visible');
      holdHintTimer = null;
    }, 2000);
  }

  function startHold(e) {
    // DOUBLE-TAP → FULLSCREEN FOCUS TIMER. Detected manually here because
    // the timer-running branches below call e.preventDefault() on
    // pointerdown, which suppresses the browser's synthesized click AND
    // dblclick events — so a native 'dblclick' listener can never fire
    // while a timer is active (user report 2026-07: "tried double clicking,
    // could not"). Two pointerdowns within 400ms count as a double-tap.
    const tapNow = Date.now();
    if (tapNow - pfFsLastTapAt < 400) {
      pfFsLastTapAt = 0;
      // Works for EVERY countdown the pill can show — wall-clock timers and
      // advanced earn/spend alike (pfFsHasTimerSource covers both).
      if (e) e.preventDefault();
      pfHandleDoubleTap();
      return;
    }
    pfFsLastTapAt = tapNow;

    // Advanced earn/spend disables the closer toggle — the two systems are
    // mutually exclusive. Show a message instead of starting the hold.
    if (currentState?.advancedEarnActive === true) {
      if (e) e.preventDefault();
      showHoldBlockedHint('Disable Advanced Earn/Spend to use this');
      return;
    }

    if (isTimerUiActive(currentState)) {
      // Per-timer hint (2026-07): when a timer is running and the user
      // tries to hold the closer, tell them why nothing's happening AND
      // how to end it. Each of these timers is ended a different way, so
      // the guidance is tailored.
      if (e) e.preventDefault();
      const mode = currentState?.timerMode;
      const videoScoped = currentState?.timerVideoScoped === true;
      if (mode === 'break' && videoScoped) {
        // Video-scoped YouTube timer: a tap on the floating button is the
        // cancel gesture. The worker fires a red pulse in the tied tab
        // for ~4s, then ends the timer. Give visual feedback here too so
        // the user knows the tap registered.
        showHoldBlockedHint('Ending YouTube timer…');
        try {
          chrome.runtime.sendMessage({ action: 'pfCancelVideoScopedTimer' }, () => {
            // Response is best-effort; the pulse + stop happen in the worker.
            void chrome.runtime.lastError;
          });
        } catch (_) { /* worker unavailable — hint stays */ }
      } else if (mode === 'break') {
        showHoldBlockedHint('Break time left — turn off notifications to stop this');
      } else {
        // v83 (user spec: remove "stop the work timer to do this"). The
        // work/study and generic messages are gone. The hold is still
        // blocked while a timer runs — that exclusivity lives in the worker,
        // not here — so this must NOT be silent, or the gesture just dies
        // with no explanation. Left as a bare pulse of the button instead of
        // a sentence telling them to stop their timer.
        if (btnStack) {
          btnStack.classList.remove('pf-holding');
          void btnStack.offsetWidth;
          btnStack.classList.add('pf-holding');
          setTimeout(() => btnStack.classList.remove('pf-holding'), 220);
        }
      }
      return;
    }

    // Note: previously siteUnreadable would short-circuit the hold and just
    // show the "site can't be read" notice. Per user spec the closer toggle
    // should still work on privacy-blocked / unclassified pages, so we let
    // the hold proceed — the unreadable badge remains visible but the
    // user can still arm/disarm the closer.

    holdDirection = isCloserToggleOn(currentState) ? 'off' : 'on';

    if (isTimerHoldBlocked(currentState, holdDirection)) {
      showHoldBlockedHint();
      return;
    }

    if (hoverTimerId) {
      clearTimeout(hoverTimerId);
      hoverTimerId = null;
    }
    if (isAutoHidden) showButtonAfterAutoHide();
    e.preventDefault();
    holdStartTime = Date.now();
    holdCompleted = false;
    isHoldingActive = true;
    holdPointerId = e.pointerId;
    try {
      holdTarget.setPointerCapture(e.pointerId);
    } catch (_) { /* ignore */ }
    holdDuration = (holdDirection === 'off') ? HOLD_OFF_MS : HOLD_ON_MS;
    if (PF_DEBUG) {
      console.info('[pf-indicator-debug] pointerdown hold started', {
        holdDirection,
        holdDuration,
        limitsEnabled: currentState.limitsEnabled,
        toggleLimitsEnabled: currentState.toggleLimitsEnabled
      });
    }
    btn.classList.add('pf-holding');
    if (btnStack) btnStack.classList.add('pf-holding');
    if (holdRafId) cancelAnimationFrame(holdRafId);
    holdRafId = null;
    runHoldAnimation();
  }

  function onHoldPointerMove(e) {
    if (!isHoldingActive || holdCompleted) return;
    if (!isPointerInsideHoldTarget(e)) {
      endHold(e);
    }
  }

  function endHold() {
    if (PF_DEBUG) {
      console.info('[pf-indicator-debug] pointerup/endHold', {
        holdCompleted,
        holdDirection
      });
    }
    if (holdCompleted) return;
    cancelHold();
  }

  const holdTarget = btnStack || btn;
  if (holdTarget) {
    holdTarget.style.pointerEvents = 'auto';
    holdTarget.addEventListener('pointerdown', startHold);
    holdTarget.addEventListener('pointermove', onHoldPointerMove);
    holdTarget.addEventListener('pointerup', endHold);
    holdTarget.addEventListener('pointercancel', endHold);
    holdTarget.addEventListener('lostpointercapture', endHold);
    // Double-click → FULLSCREEN FOCUS TIMER (user spec 2026-07): a big
    // named session view of whichever timer is running (basic break/work
    // or advanced earn/spend). Elapsed time is credited as PRODUCTIVE on
    // the stats dashboard under the typed session name.
    holdTarget.addEventListener('dblclick', (e) => {
      // Backup path only — the primary detector is the manual double-tap in
      // startHold (native dblclick is suppressed whenever a pointerdown
      // branch calls preventDefault). openFocusFullscreen is idempotent.
      e.preventDefault();
      e.stopPropagation();
      pfHandleDoubleTap();
    });
  }

  // ── v83: quick panel ──────────────────────────────────────────────────────
  // A far-left drawer styled like the dashboard's settings drawer, but living
  // on whatever page you are on. Only the controls worth changing mid-browse:
  // timers first, then the four Basic ones. Advanced is a link rather than a
  // copy — those controls are ~300 lines of dashboard markup and duplicating
  // them here would mean two implementations to keep in step.
  //
  // Everything writes through the SAME channels the dashboard uses
  // (chrome.storage.local for the toggles, pfToggleCloser for the closer), so
  // there is no second source of truth to drift.
  const PF_QP_ID = 'pfQuickPanel';

  /** 1s repaint while the panel is open, and the repaint function itself.
   *  Both live out here because pfCloseQuickPanel has to tear the interval
   *  down, and the click handlers inside the panel call the refresh. */
  let pfQpRefreshTimer = null;
  let pfQpRefreshTimers = async () => {};

  function pfCloseQuickPanel() {
    const el = shadow.getElementById(PF_QP_ID);
    if (!el) return;
    el.style.transform = 'translateX(-100%)';
    setTimeout(() => el.remove(), 200);
    document.removeEventListener('keydown', pfQuickPanelKey, true);
    document.removeEventListener('pointerdown', pfQuickPanelOutside, true);
    if (pfQpRefreshTimer) { clearInterval(pfQpRefreshTimer); pfQpRefreshTimer = null; }
  }
  function pfQuickPanelKey(e) {
    if (e.key === 'Escape') pfCloseQuickPanel();
  }
  /**
   * v84 (user spec): clicking anywhere outside the drawer shuts it.
   *
   * Capture phase so it runs before the page's own handlers, and the floating
   * button is excluded — a click there already toggles the panel, and letting
   * both fire would close and immediately reopen it.
   */
  function pfQuickPanelOutside(e) {
    if (!shadow.getElementById(PF_QP_ID)) return;
    // Same closed-shadow-root problem as the radial menu: composedPath is
    // truncated at the host out here, so it could never see the panel and
    // every click INSIDE the drawer would have closed it. The floating
    // button is under the same host, which is also what we want: it toggles
    // the panel itself and must not close it from underneath.
    if (pfEventInsideOurUi(e)) return;
    pfCloseQuickPanel();
  }

  function pfQpRow(label, sub) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'gap:10px;padding:9px 0;border-bottom:1px solid #efedf6;';
    const t = document.createElement('div');
    t.style.cssText = 'min-width:0;';
    const a = document.createElement('div');
    a.textContent = label;
    a.style.cssText = 'font-weight:650;font-size:12.5px;color:#1f2430;';
    t.appendChild(a);
    if (sub) {
      const b = document.createElement('div');
      b.textContent = sub;
      b.style.cssText = 'font-size:11px;color:#8a8399;margin-top:1px;';
      t.appendChild(b);
      // Exposed so the 1s refresh can retitle a row without rebuilding it.
      row.pfSubEl = b;
    }
    row.appendChild(t);
    return row;
  }

  /**
   * A switch whose value the CALLER owns. It was previously storage-backed
   * with its own key, which meant the closer row wrote to a key nothing read
   * (pfCloserEnabledMirror) and showed a state unrelated to the real closer.
   * Now every row passes in the true current value and an async writer.
   */
  function pfQpToggle(initialOn, write) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.style.cssText = 'flex:0 0 auto;width:40px;height:22px;border-radius:22px;'
      + 'border:none;background:#ccc;position:relative;cursor:pointer;'
      + 'transition:background .2s ease;';
    const knob = document.createElement('span');
    knob.style.cssText = 'position:absolute;top:3px;left:3px;width:16px;height:16px;'
      + 'border-radius:50%;background:#fff;transition:transform .2s ease;'
      + 'box-shadow:0 1px 3px rgba(0,0,0,.3);';
    btn.appendChild(knob);
    const paint = (on) => {
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.style.background = on ? '#5B4B9F' : '#ccc';
      knob.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
    };
    let value = initialOn === true;
    btn.addEventListener('click', async () => {
      value = !value;
      paint(value);
      try {
        await write(value);
      } catch (_) {
        // Revert so the switch never shows a state that did not save.
        value = !value;
        paint(value);
      }
    });
    paint(value);
    return btn;
  }

  async function pfOpenQuickPanel() {
    pfCloseRadialMenu();
    if (shadow.getElementById(PF_QP_ID)) { pfCloseQuickPanel(); return; }

    const panel = document.createElement('div');
    panel.id = PF_QP_ID;
    panel.style.cssText = 'position:fixed;left:0;top:0;bottom:0;width:min(320px,86vw);'
      + 'background:#fff;border-right:1px solid #e6e2f2;z-index:2147483000;'
      + 'box-shadow:18px 0 48px rgba(15,23,42,.22);overflow-y:auto;'
      + 'padding:18px 16px 28px;box-sizing:border-box;'
      + 'font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;'
      + 'color:#1f2430;transform:translateX(-100%);transition:transform .2s ease;'
      // THE PANEL WAS DEAD WITHOUT THIS. The indicator host is
      // `pointer-events:none` (so the empty area around the floating button
      // stays click-through to the page), and that inherits. Every
      // interactive descendant has to opt back in — .pf-btn-stack and
      // .pf-coach both do. The panel rendered and animated perfectly and
      // swallowed nothing, which is exactly why it looked fine but no
      // button, switch or stepper responded.
      + 'pointer-events:auto;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
    const h = document.createElement('div');
    h.textContent = 'Quick settings';
    h.style.cssText = 'font-weight:750;font-size:15px;';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close');
    x.style.cssText = 'border:none;background:transparent;font-size:20px;'
      + 'line-height:1;cursor:pointer;color:#6b7280;padding:2px 6px;';
    x.addEventListener('click', pfCloseQuickPanel);
    head.appendChild(h); head.appendChild(x);
    panel.appendChild(head);

    const section = (label) => {
      const s = document.createElement('div');
      s.textContent = label;
      s.style.cssText = 'margin:16px 0 2px;font-size:10.5px;font-weight:750;'
        + 'letter-spacing:.06em;text-transform:uppercase;color:#7a6fa8;';
      panel.appendChild(s);
    };

    // Real values, read from the worker. currentState only carries indicator
    // fields — no tab limit, no banked break — so the panel used to render
    // placeholders and a closer switch wired to nothing.
    const qs = await chrome.runtime.sendMessage({ action: 'pfGetQuickSettings' })
      .catch(() => null);
    const ok = qs?.success === true;

    // ── Timers first (user spec) ────────────────────────────────────────────
    section('Timers');

    /**
     * Start/Stop pair for one timer. v84 (user spec): the panel used to be
     * read-only here — a "Break available" badge and an Open button that
     * punted to the dashboard.
     *
     * Stop is the destructive-looking one, so it gets the red outline; the
     * two never show at once, matching the dashboard's own state machine.
     * The worker owns the transition, and the dashboard re-derives its
     * buttons from storage every second, so stopping here stops it there
     * too without either surface messaging the other.
     */
    const pfQpTimerBtn = (which, initialRunning) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      let running = initialRunning === true;
      let busy = false;
      const paint = () => {
        btn.textContent = running ? 'Stop' : 'Start';
        btn.style.cssText = 'flex:0 0 auto;padding:5px 14px;border-radius:8px;'
          + 'font:600 11.5px sans-serif;cursor:pointer;min-width:58px;'
          + (running
            ? 'border:1px solid #e3b8b8;background:#fff5f5;color:#a13b3b;'
            : 'border:1px solid #cfc4ee;background:#5B4B9F;color:#fff;');
        btn.style.opacity = busy ? '0.6' : '1';
      };
      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const next = !running;
        running = next;      // optimistic, same as the dashboard buttons
        paint();
        const res = await chrome.runtime.sendMessage({
          action: 'pfQuickTimer', which, op: next ? 'start' : 'stop'
        }).catch(() => null);
        busy = false;
        if (!res?.success) {
          // Never leave the button claiming a state that did not take.
          running = !next;
          if (res?.decline === 'signed_out') {
            btn.title = 'Sign in to use timers';
          }
        }
        paint();
        // Reflect the new state everywhere immediately rather than waiting
        // up to a second for the next refresh.
        void pfQpRefreshTimers();
      });
      paint();
      // v84: the 1s refresh drives the button from real worker state, so
      // clicking "I'm finished" on a cycle popup (or Stop on the dashboard)
      // flips this back to Start on its own. `busy` is respected so a
      // refresh landing mid-click cannot stomp the optimistic swap.
      btn.pfSetRunning = (v) => {
        if (busy) return;
        if (running === v) return;
        running = v;
        paint();
      };
      return btn;
    };

    /**
     * v84 (user spec): "make sure that the text below says the time".
     * Both timer rows show a clock value, never prose and never rounded
     * minutes. "1 min banked" was the complaint: 59s and 89s both printed
     * as "1 min", so the number moved in jumps and looked broken.
     * Hours are only shown once there are any.
     */
    const pfClock = (totalSec) => {
      const s = Math.max(0, Math.floor(Number(totalSec) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
    };

    const workSub = (s) => !s
      ? 'Unavailable'
      : (s.workRunning ? `${pfClock(s.workRemainingSec)} left` : pfClock(s.workConfiguredSec));
    const earnSub = (s) => !s
      ? 'Unavailable'
      : (s.earnRunning
        ? `${pfClock(s.earnRemainingSec || s.earnConfiguredSec)} left`
        : `${pfClock(s.breakAvailableSec)} banked`);

    // v84 (user spec): the "Open" shortcut to the dashboard card is gone.
    // Start/Stop is the whole point of the row now, and the Advanced section
    // at the bottom already links out to the dashboard.
    const workRow = pfQpRow('Work Timer', workSub(ok ? qs : null));
    const workBtn = pfQpTimerBtn('work', ok && qs.workRunning === true);
    workRow.appendChild(workBtn);
    panel.appendChild(workRow);

    // Replaces the old "Break available" row (user spec). While a cycle runs
    // this shows time remaining in it; otherwise the banked balance, which is
    // the number the row used to carry.
    const earnRow = pfQpRow('Advanced Earn / Spend', earnSub(ok ? qs : null));
    const earnBtn = pfQpTimerBtn('earn', ok && qs.earnRunning === true);
    earnRow.appendChild(earnBtn);
    panel.appendChild(earnRow);

    /**
     * v84 (user spec): "if the user hits I'm finished on the popups, make
     * sure the quick side bar also stops, but if it's a break timer it
     * doesn't stop."
     *
     * Rather than have every popup notify the panel, the panel re-reads the
     * worker's real state once a second while it is open. That covers "I'm
     * finished", Stop on the dashboard, a cycle completing on its own, and
     * anything added later, with no new wiring. It also makes the clock
     * subtitles above actually tick.
     *
     * The break case needs no special handling and must not get any: a
     * running break IS a live session, so earnRunning stays true and the row
     * correctly keeps showing Stop. Hard-coding "ignore break timers" here
     * would be the thing that broke it.
     */
    pfQpRefreshTimers = async () => {
      if (!shadow.getElementById(PF_QP_ID)) return;
      const s = await chrome.runtime.sendMessage({ action: 'pfGetQuickSettings' })
        .catch(() => null);
      const live = s?.success === true ? s : null;
      if (workRow.pfSubEl) workRow.pfSubEl.textContent = workSub(live);
      if (earnRow.pfSubEl) earnRow.pfSubEl.textContent = earnSub(live);
      workBtn.pfSetRunning?.(live?.workRunning === true);
      earnBtn.pfSetRunning?.(live?.earnRunning === true);
    };
    if (pfQpRefreshTimer) clearInterval(pfQpRefreshTimer);
    pfQpRefreshTimer = setInterval(() => { void pfQpRefreshTimers(); }, 1000);

    // ── Basic ───────────────────────────────────────────────────────────────
    section('Basic');
    const limitRow = pfQpRow('Tab limit', 'Tabs allowed open at once');
    const limitBox = document.createElement('div');
    limitBox.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:6px;';
    const limitVal = document.createElement('span');
    limitVal.style.cssText = 'min-width:18px;text-align:center;font-weight:700;';
    limitVal.textContent = ok ? String(qs.tabLimit) : '—';
    const step = (delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = delta > 0 ? '+' : '−';
      b.style.cssText = 'width:24px;height:24px;border-radius:6px;border:1px solid #d8d0f0;'
        + 'background:#fff;color:#4A3D85;font:700 13px sans-serif;cursor:pointer;';
      b.addEventListener('click', () => {
        const next = Math.max(1, Math.min(20, (Number(limitVal.textContent) || 5) + delta));
        limitVal.textContent = String(next);
        chrome.runtime.sendMessage({ action: 'pfSetTabLimit', limit: next }).catch(() => {});
      });
      return b;
    };
    limitBox.appendChild(step(-1));
    limitBox.appendChild(limitVal);
    limitBox.appendChild(step(1));
    limitRow.appendChild(limitBox);
    panel.appendChild(limitRow);

    const closerRow = pfQpRow('Unproductive Tab Closer', 'Closes unproductive tabs at your limit');
    closerRow.appendChild(pfQpToggle(
      ok ? qs.closerEnabled : currentState?.limitsEnabled === true,
      // Same message the hold gesture sends — one path, one source of truth.
      (on) => chrome.runtime.sendMessage({ action: 'pfToggleCloser', enabled: on })
    ));
    panel.appendChild(closerRow);

    const reorderRow = pfQpRow('Reorder Tabs', 'Most important stay leftmost');
    reorderRow.appendChild(pfQpToggle(
      ok ? qs.reorderEnabled : true,
      (on) => chrome.storage.local.set({ pfReorderTabsEnabled: on })
    ));
    panel.appendChild(reorderRow);

    const groupRow = pfQpRow('Auto group similar tabs', 'Keeps related tabs together');
    groupRow.appendChild(pfQpToggle(
      ok ? qs.groupEnabled : false,
      async (on) => {
        await chrome.storage.local.set({ pfGroupSimilarTabsEnabled: on });
        // Apply straight away, same as the dashboard toggle does.
        if (on) chrome.runtime.sendMessage({ action: 'reorderTabsNow' }).catch(() => {});
      }
    ));
    panel.appendChild(groupRow);

    // ── Advanced (link, not a copy) ─────────────────────────────────────────
    section('Advanced');
    const adv = document.createElement('button');
    adv.type = 'button';
    adv.textContent = 'Open advanced settings ›';
    adv.style.cssText = 'width:100%;margin-top:6px;padding:10px 12px;border-radius:9px;'
      + 'border:1px solid #d8d0f0;background:#faf9fd;color:#4A3D85;'
      + 'font:600 12.5px sans-serif;text-align:left;cursor:pointer;';
    adv.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'pfOpenDashboardFocus', drawer: 'advanced' })
        .catch(() => {});
      pfCloseQuickPanel();
    });
    panel.appendChild(adv);

    shadow.appendChild(panel);
    requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; });
    document.addEventListener('keydown', pfQuickPanelKey, true);
    // Deferred a tick, exactly like the radial menu's outside handler: the
    // double-tap that opened the panel is still propagating, and binding
    // synchronously would let it close the panel it just opened.
    setTimeout(() => {
      document.addEventListener('pointerdown', pfQuickPanelOutside, true);
    }, 0);
  }

  // ── v83: double-tap surfaces ──────────────────────────────────────────────
  // One entry point for both detectors (the manual double-tap in startHold and
  // the native dblclick backup), so the two can never disagree.
  //
  //   timer running  → radial menu: Full screen timer (top arc),
  //                    Open quick dashboard (bottom arc)
  //   no timer       → quick panel drawer on the far left
  function pfHandleDoubleTap() {
    if (pfFsHasTimerSource()) pfOpenRadialMenu();
    else pfOpenQuickPanel();
  }

  function pfCloseRadialMenu() {
    shadow.getElementById('pfRadial')?.remove();
    document.removeEventListener('pointerdown', pfRadialOutside, true);
  }
  /**
   * Did this document-level event originate inside our own UI?
   *
   * THE SHADOW ROOT IS `mode: 'closed'` (see hostEl.attachShadow above), and
   * that is the whole difficulty. Two things people reach for do not work:
   *
   *   el.contains(e.target)   — e.target is retargeted to the HOST for any
   *                             event from inside, so this is always false.
   *   e.composedPath()        — for a CLOSED root the path is TRUNCATED at
   *                             the host when the listener lives outside the
   *                             tree. It never reveals inner nodes either.
   *
   * I used composedPath here first and it silently behaved exactly like the
   * contains() version it replaced, which is why the radial options stayed
   * unclickable across two "fixes": the outside-handler fired on pointerdown,
   * removed the menu, and pointerup landed on nothing.
   *
   * Retargeting to the host is the only signal available out here, so that is
   * what we test. Everything of ours lives under this one host.
   */
  function pfEventInsideOurUi(e) {
    if (!hostEl) return false;
    if (e.target === hostEl) return true;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(hostEl);
  }

  function pfRadialOutside(e) {
    if (!shadow.getElementById('pfRadial')) return;
    if (pfEventInsideOurUi(e)) return;
    pfCloseRadialMenu();
  }

  const PF_SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Two arc segments wrapped around the floating button.
   *
   * v84 (user spec): "make them a half semi circle each, not pill boxes that
   * come off the button." These are now real annular sectors drawn as SVG
   * paths, so together they form a half ring hugging the button rather than
   * two lozenges floating on spokes.
   *
   * GEOMETRY, and why these numbers:
   *
   * The button sits 12px off the bottom-right of the viewport, so the only
   * direction with room is up and to the left. Angles use the maths
   * convention (0 = east, counter-clockwise positive) and screen Y is
   * negated when plotting. Every angle here stays in 90..180, which is the
   * top-left quadrant, so nothing can be drawn below the button or off the
   * right edge. That is the constraint the previous version got wrong: it
   * used 200 and 235, which are BELOW the horizontal, and drew off-screen.
   *
   * SIZE, and the chain of consequences (asked for twice: smaller, and more
   * connected to the dot).
   *
   * .pf-btn-stack is 36x36, so the button's radius is exactly 18. The inner
   * radius is now 18 too: flush against the button with no seam at all. A
   * 3px gap was tried first and still read as floating.
   *
   * Shrinking the outer radius costs label space, and that is the real
   * constraint here, not taste. Arc length at the mid radius is what has to
   * hold the text:
   *     r_mid = (18 + 80) / 2 = 49,  49 degrees -> about 42px of arc.
   * At 9px, six characters is roughly 30px, so labels are capped at two
   * short lines of six. That is why they read "Full / screen" rather than
   * "Full screen timer". tests/host_importance.test.mjs measures this
   * against the real strings, so lengthening one fails the suite instead of
   * silently spilling over the sector edge.
   */
  const PF_RADIAL_R_OUT = 80;
  const PF_RADIAL_R_IN = 18;
  const PF_RADIAL_GAP_DEG = 2.5;
  const PF_RADIAL_FONT = 9;
  /** Where the label block sits across the ring, 0 = inner edge, 1 = outer.
   *  Pushed past the middle because arc width grows with radius and the
   *  longest word has to fit. */
  const PF_RADIAL_TEXT_F = 0.66;

  function pfArcSectorPath(cx, cy, rIn, rOut, a0Deg, a1Deg) {
    const pt = (r, deg) => {
      const a = (deg * Math.PI) / 180;
      return [cx + Math.cos(a) * r, cy - Math.sin(a) * r];
    };
    const [x0o, y0o] = pt(rOut, a0Deg);
    const [x1o, y1o] = pt(rOut, a1Deg);
    const [x1i, y1i] = pt(rIn, a1Deg);
    const [x0i, y0i] = pt(rIn, a0Deg);
    const large = Math.abs(a1Deg - a0Deg) > 180 ? 1 : 0;
    // sweep 0 travels counter-clockwise on screen (increasing angle), which
    // is the direction a0 -> a1 runs. The inner arc comes back, so sweep 1.
    return `M ${x0o.toFixed(2)} ${y0o.toFixed(2)}`
      + ` A ${rOut} ${rOut} 0 ${large} 0 ${x1o.toFixed(2)} ${y1o.toFixed(2)}`
      + ` L ${x1i.toFixed(2)} ${y1i.toFixed(2)}`
      + ` A ${rIn} ${rIn} 0 ${large} 1 ${x0i.toFixed(2)} ${y0i.toFixed(2)}`
      + ' Z';
  }

  function pfOpenRadialMenu() {
    if (shadow.getElementById('pfRadial')) { pfCloseRadialMenu(); return; }
    const host = shadow.querySelector('.pf-btn-stack');
    if (!host) return;

    const S = PF_RADIAL_R_OUT;
    const svg = document.createElementNS(PF_SVG_NS, 'svg');
    svg.id = 'pfRadial';
    svg.setAttribute('width', String(S * 2));
    svg.setAttribute('height', String(S * 2));
    svg.setAttribute('viewBox', `0 0 ${S * 2} ${S * 2}`);
    // Centred on the button. pointer-events:none on the svg box so the large
    // transparent square does not swallow clicks on the page behind it; each
    // path opts back in.
    svg.style.cssText = 'position:absolute;left:50%;top:50%;'
      + `transform:translate(-50%,-50%);z-index:9;pointer-events:none;`
      + 'overflow:visible;opacity:0;transition:opacity .16s ease;';

    // v84 (user report: "a strange box comes up"). Each sector carries
    // tabindex="0" so it can be reached by keyboard, and Chrome answers a
    // MOUSE click on a focusable SVG group by drawing the default focus ring
    // around its BOUNDING BOX — a rectangle enclosing the whole arc, which
    // looks like a stray box appearing over the page.
    //
    // Suppressed for pointer input only. :focus-visible still fires for
    // keyboard focus, and that case gets a thicker stroke on the arc itself
    // rather than a rectangle, so tabbing to an option is still obvious.
    const style = document.createElementNS(PF_SVG_NS, 'style');
    style.textContent = 'g{outline:none;}'
      + 'g:focus{outline:none;}'
      + 'g:focus-visible>path{stroke:#5B4B9F;stroke-width:2;}';
    svg.appendChild(style);

    const defs = document.createElementNS(PF_SVG_NS, 'defs');
    const filt = document.createElementNS(PF_SVG_NS, 'filter');
    filt.setAttribute('id', 'pfRadialShadow');
    filt.setAttribute('x', '-40%');
    filt.setAttribute('y', '-40%');
    filt.setAttribute('width', '180%');
    filt.setAttribute('height', '180%');
    const drop = document.createElementNS(PF_SVG_NS, 'feDropShadow');
    drop.setAttribute('dx', '0');
    // Tight shadow: at this size a soft one made the ring look like it was
    // hovering above the button rather than joined to it.
    drop.setAttribute('dy', '3');
    drop.setAttribute('stdDeviation', '5');
    drop.setAttribute('flood-color', 'rgba(20,14,45,0.26)');
    filt.appendChild(drop);
    defs.appendChild(filt);
    svg.appendChild(defs);

    const seg = (lines, a0, a1, onPick) => {
      const g = document.createElementNS(PF_SVG_NS, 'g');
      g.style.cursor = 'pointer';
      g.style.pointerEvents = 'auto';
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', lines.join(' '));

      const path = document.createElementNS(PF_SVG_NS, 'path');
      path.setAttribute('d', pfArcSectorPath(
        S, S, PF_RADIAL_R_IN, PF_RADIAL_R_OUT,
        a0 + PF_RADIAL_GAP_DEG / 2, a1 - PF_RADIAL_GAP_DEG / 2
      ));
      path.setAttribute('fill', '#ffffff');
      path.setAttribute('stroke', '#d8d0f0');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('filter', 'url(#pfRadialShadow)');
      g.appendChild(path);

      // ONE anchor, lines stacked VERTICALLY beneath it.
      //
      // The previous attempt gave each line its own radius to win extra arc
      // width. It does win the width, but both lines then sit on the same
      // RAY, so for a sector centred at 114 degrees the second word lands up
      // and to the left of the first instead of underneath it. The label
      // read as two scattered words rather than one stacked phrase (user
      // report: "you messed up the formatting"). Do not reintroduce it.
      //
      // Width is bought instead by anchoring the block at 0.66 of the way
      // out rather than at the mid radius: arc grows with radius, so r=59
      // gives about 50px against the mid radius's 42px, and "settings" at
      // 9px needs roughly 40px.
      const mid = (a0 + a1) / 2;
      const rad = (mid * Math.PI) / 180;
      const band = PF_RADIAL_R_OUT - PF_RADIAL_R_IN;
      const rAnchor = PF_RADIAL_R_IN + band * PF_RADIAL_TEXT_F;
      const tx = S + Math.cos(rad) * rAnchor;
      const ty = S - Math.sin(rad) * rAnchor;
      const lh = PF_RADIAL_FONT * 1.18;
      const text = document.createElementNS(PF_SVG_NS, 'text');
      text.setAttribute('x', tx.toFixed(2));
      text.setAttribute('y', ty.toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('fill', '#4A3D85');
      text.setAttribute('font-size', String(PF_RADIAL_FONT));
      text.setAttribute('font-weight', '600');
      text.setAttribute('font-family', '-apple-system,system-ui,"Segoe UI",Roboto,sans-serif');
      text.style.pointerEvents = 'none';
      lines.forEach((line, i) => {
        const ts = document.createElementNS(PF_SVG_NS, 'tspan');
        ts.setAttribute('x', tx.toFixed(2));
        // Centre the stack on the anchor: lift the first line by half the
        // block height, then step one line height for each after it.
        ts.setAttribute('dy', i === 0
          ? (-((lines.length - 1) * lh) / 2).toFixed(2)
          : lh.toFixed(2));
        ts.textContent = line;
        text.appendChild(ts);
      });
      g.appendChild(text);

      // THE OPTIONS WERE UNCLICKABLE (user report, three times). Two causes,
      // both fixed here, and the fix deliberately does NOT rely on `click`.
      //
      // 1. The menu is appended inside .pf-btn-stack, and startHold is bound
      //    to that element's pointerdown. When a timer is running — the ONLY
      //    time this menu can be open — startHold takes the isTimerUiActive
      //    branch and calls preventDefault(). preventDefault on pointerdown
      //    suppresses the browser's synthesized click, so a click listener
      //    can never fire here. stopPropagation below keeps the hold logic
      //    from seeing these events at all.
      // 2. Even with that, depending on click means depending on the browser
      //    synthesising one from a pointerdown/pointerup pair that several
      //    other handlers are also touching. So the action fires on POINTERUP
      //    directly, which nothing upstream can suppress, and `click` is kept
      //    only as a fallback for keyboard and assistive tech.
      //
      // stopPropagation, never preventDefault: preventDefault here would
      // recreate cause 1 from the inside.
      for (const t of ['pointerdown', 'mousedown', 'mouseup']) {
        g.addEventListener(t, (e) => { e.stopPropagation(); });
      }
      let picked = false;
      const activate = (e) => {
        if (picked) return;      // pointerup and click both land; run once
        picked = true;
        if (e?.stopPropagation) e.stopPropagation();
        pfCloseRadialMenu();
        onPick();
      };
      g.addEventListener('pointerup', (e) => { e.stopPropagation(); activate(e); });
      g.addEventListener('click', activate);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      });
      g.addEventListener('pointerenter', () => { path.setAttribute('fill', '#f4f1fd'); });
      g.addEventListener('pointerleave', () => { path.setAttribute('fill', '#ffffff'); });
      return g;
    };

    // 90 to 188 degrees: a half ring across the top-left, split in two. The
    // lower end dips 14px below the button centre at the outer radius, which
    // still clears the viewport because the button sits 12px up from the
    // bottom and is 36px tall. Anything past about 195 would be cut off.
    // Longer word goes on the SECOND line, which sits at the larger radius
    // and therefore has more arc to play with. See the per-line radius note
    // in seg(). The test measures each line against its own radius.
    svg.appendChild(seg(['Full', 'screen'], 90, 139, () => openFocusFullscreen()));
    svg.appendChild(seg(['Quick', 'settings'], 139, 188, () => pfOpenQuickPanel()));

    host.appendChild(svg);
    requestAnimationFrame(() => { svg.style.opacity = '1'; });
    // Capture phase, and deferred a tick so the double-tap that opened this
    // does not immediately close it.
    setTimeout(() => document.addEventListener('pointerdown', pfRadialOutside, true), 0);
  }

  // ── FULLSCREEN FOCUS TIMER ────────────────────────────────────────────────
  // Mirrors the active timer at display size with an editable session name.
  // While open, elapsed time streams to the worker in ≤60s slices and lands
  // on the dashboard as Productive under "⏱ <name>". Completion is untouched:
  // the worker still owns the timer, so the break award / "do another hour"
  // flow fires exactly like a normal session.
  let pfFsHost = null;
  let pfFsTick = null;
  let pfFsLastCreditAt = 0;
  let pfFsLastTapAt = 0; // double-tap detector (see startHold)
  let pfFsName = 'Focus session';
  let pfFsMaxSeen = 0; // largest remaining seen — drives the progress bar
  let pfFsLastPingAt = 0; // accrual-mute keepalive (see pfFsPing)

  /** Tell the worker the big timer is open/closed on THIS tab so the page
   *  underneath stops accruing stats — only the named session counts. */
  function pfFsPing(on) {
    try {
      chrome.runtime?.sendMessage?.({ action: 'pfFocusFsPing', on }).catch?.(() => {});
    } catch (_) { /* worker asleep — next ping re-arms the mute */ }
  }

  /** True when the bottom-right pill is showing ANY countdown — wall-clock
   *  timers AND the advanced earn/spend direct-writer both qualify. This is
   *  the double-click gate, so fullscreen works for every timer the pill
   *  can display. */
  function pfFsHasTimerSource() {
    if (isTimerUiActive(currentState)) return true;
    return !!(closerCountdown
      && !closerCountdown.classList.contains('pf-hidden')
      && countdownTime && countdownTime.textContent.trim());
  }

  /** Parse the pill's clock text ("MM:SS" or "H:MM:SS") to seconds. */
  function pfFsParseClock(text) {
    const parts = String(text || '').trim().split(':').map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function pfFsSendCredit(now) {
    const sec = Math.round((now - pfFsLastCreditAt) / 1000);
    if (sec < 1) return;
    pfFsLastCreditAt = now;
    try {
      chrome.runtime?.sendMessage?.({
        action: 'pfFocusSessionCredit',
        seconds: Math.min(sec, 120),
        label: pfFsName
      }).catch?.(() => {});
    } catch (_) { /* worker asleep — next slice catches up (capped) */ }
  }

  function closeFocusFullscreen() {
    if (!pfFsHost) return;
    if (pfFsTick) { clearInterval(pfFsTick); pfFsTick = null; }
    pfFsSendCredit(Date.now()); // final partial slice
    pfFsPing(false); // un-mute the page's normal stat accrual
    try {
      if (document.fullscreenElement === pfFsHost) document.exitFullscreen().catch(() => {});
    } catch (_) {}
    try { pfFsHost.remove(); } catch (_) {}
    pfFsHost = null;
    pfFsMaxSeen = 0;
    // bring the small pill back (the render pipeline re-applies its own
    // display state on the next broadcast)
    try { if (hostEl) { hostEl.style.display = ''; hostEl.style.visibility = ''; } } catch (_) {}
  }

  function openFocusFullscreen() {
    if (pfFsHost) return;
    pfFsHost = document.createElement('div');
    pfFsHost.id = 'pf-focus-fullscreen';
    pfFsHost.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
    const sh = pfFsHost.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
          justify-content:center;gap:28px;background:radial-gradient(120% 120% at 50% 30%,#1c1830 0%,#0b0a14 70%);
          font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#f5f1ff;}
        .name{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);
          border-radius:16px;color:#fff;font-size:22px;font-weight:700;text-align:center;
          padding:14px 24px;outline:none;width:min(60vw,480px);box-sizing:border-box;
          font-family:inherit;letter-spacing:0.01em;
          transition:border-color .2s ease,background .2s ease,box-shadow .2s ease;}
        .name:hover{background:rgba(255,255,255,0.09);}
        .name:focus{border-color:rgba(154,132,255,0.85);background:rgba(255,255,255,0.08);
          box-shadow:0 0 0 4px rgba(122,98,255,0.18),0 10px 40px rgba(122,98,255,0.12);}
        .name::placeholder{color:rgba(255,255,255,0.32);font-weight:600;}
        .name::selection{background:rgba(122,98,255,0.45);}
        .clock{font-size:min(10vw,96px);font-weight:800;font-variant-numeric:tabular-nums;
          letter-spacing:0.02em;line-height:1;text-shadow:0 12px 60px rgba(122,98,255,0.35);}
        .mode{font-size:13px;font-weight:700;letter-spacing:0.35em;text-indent:0.35em;
          text-transform:uppercase;color:rgba(199,189,255,0.75);user-select:none;}
        /* purple progress RING around the clock — fills clockwise as the
           session elapses (same language as the small pill's ring) */
        .ringwrap{position:relative;width:min(58vh,460px);height:min(58vh,460px);
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;}
        .ring{position:absolute;inset:0;border-radius:50%;
          -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 14px),#000 calc(100% - 13px));
          mask:radial-gradient(farthest-side,transparent calc(100% - 14px),#000 calc(100% - 13px));
          filter:drop-shadow(0 0 22px rgba(122,98,255,0.35));}
        .hint{font-size:12px;letter-spacing:0.14em;color:rgba(255,255,255,0.4);user-select:none;}
        .prod{font-size:12px;letter-spacing:0.06em;color:rgba(125,255,176,0.75);user-select:none;}
      </style>
      <div class="wrap">
        <input class="name" id="pfFsName" maxlength="40" placeholder="Name this focus session" />
        <div class="ringwrap">
          <div class="ring" id="pfFsRing"></div>
          <div class="mode" id="pfFsMode"></div>
          <div class="clock" id="pfFsClock">--:--</div>
        </div>
        <div class="prod">counts as productive time on your dashboard</div>
        <div class="hint">ESC TO EXIT</div>
      </div>`;
    (document.body || document.documentElement).appendChild(pfFsHost);
    const nameEl = sh.getElementById('pfFsName');
    nameEl.value = pfFsName === 'Focus session' ? '' : pfFsName;
    nameEl.addEventListener('input', () => {
      pfFsName = nameEl.value.trim().slice(0, 40) || 'Focus session';
    });
    // Keystrokes stay in the input — the page underneath must not see them.
    for (const evt of ['keydown', 'keyup', 'keypress']) {
      sh.addEventListener(evt, (ev) => ev.stopPropagation());
    }

    try { pfFsHost.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch (_) {}
    const onFsChange = () => {
      if (!document.fullscreenElement && pfFsHost) {
        document.removeEventListener('fullscreenchange', onFsChange);
        closeFocusFullscreen();
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);

    // Hide the small pill entirely while the big version owns the screen —
    // exactly ONE timer visible (user report 2026-07: "there are 2 timers
    // in the bottom when I fullscreen it"). visibility (not display) so the
    // render pipeline keeps writing the countdown text we mirror. Also tear
    // down any top-layer fullscreen dialog copy of the pill immediately —
    // syncFullscreenOverlay's guard catches the change event, but this
    // covers the race where the dialog was already up.
    try { if (hostEl) hostEl.style.display = 'none'; } catch (_) {}
    try { exitFullscreenOverlay(); } catch (_) {}
    // Mute the page-behind's stat accrual for this tab (re-pinged in paint).
    pfFsLastPingAt = Date.now();
    pfFsPing(true);

    pfFsLastCreditAt = Date.now();
    pfFsMaxSeen = 0;
    const modeEl = sh.getElementById('pfFsMode');
    const clockEl = sh.getElementById('pfFsClock');
    const ringEl = sh.getElementById('pfFsRing');
    const MODE_LABELS = {
      study: 'Work timer', unprod: 'Break timer', break: 'Break timer',
      earn: 'Earning break time', spend: 'Break time'
    };
    const paint = () => {
      if (!pfFsHasTimerSource()) {
        // Timer finished or was stopped — hand back to the normal
        // completion flow (popup / break award / "do another hour").
        document.removeEventListener('fullscreenchange', onFsChange);
        closeFocusFullscreen();
        return;
      }
      // SELF-HEAL every tick: nothing but the big timer may be visible.
      // The pill's render pipeline and the top-layer fullscreen dialog have
      // several code paths that re-show the corner pill (state broadcasts,
      // cssText resets, the fullscreen watchdog) — rather than chase each
      // one, enforce the invariant here twice a second.
      try { if (fsDialog) exitFullscreenOverlay(); } catch (_) {}
      try { if (hostEl && hostEl.style.display !== 'none') hostEl.style.display = 'none'; } catch (_) {}
      // MIRROR the pill 1:1 (user spec 2026-07: "just a bigger version of
      // the bottom right timer" + "the timers are not in sync"): the pill's
      // countdown text is the single source of truth — wall-clock render AND
      // the earn/spend direct writer both land there — so the big clock can
      // never drift from the small one. Fallback computes only if the pill
      // text is momentarily empty.
      const pillText = (countdownTime?.textContent || '').trim();
      let remaining = pfFsParseClock(pillText);
      if (remaining == null) {
        remaining = Math.max(0, Math.floor(getDisplayRemainingSec(currentState)));
      }
      clockEl.textContent = pillText || (() => {
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        const s = remaining % 60;
        return h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      })();
      // Mode line mirrors the pill's own label when it has one.
      const pillLabel = (countdownLabel?.textContent || '').trim();
      modeEl.textContent = pillLabel || MODE_LABELS[currentState?.timerMode] || 'Focus timer';
      // Purple ring fills CLOCKWISE as the session elapses. Total prefers
      // the state's wall-clock total; for earn/spend (no wall-clock total)
      // fall back to the largest remaining we've seen this session.
      pfFsMaxSeen = Math.max(pfFsMaxSeen, remaining);
      const total = Math.max(Math.floor(Number(currentState?.timerTotalSec) || 0), pfFsMaxSeen);
      if (total > 0 && ringEl) {
        const a = Math.min(360, Math.max(0, ((total - remaining) / total) * 360));
        ringEl.style.background = `conic-gradient(from 0deg,
          #8a6cff 0deg,
          #b9a4ff ${a * 0.45}deg,
          #8a6cff ${a}deg,
          rgba(255,255,255,0.10) ${a}deg,
          rgba(255,255,255,0.10) 360deg)`;
      }
      // Stream productive credit in ~60s slices so a crash never loses
      // more than a minute and the worker clamp (120s) is never hit.
      const now = Date.now();
      if (now - pfFsLastCreditAt >= 60_000) pfFsSendCredit(now);
      // Keep the accrual mute alive (worker expires it after 45s).
      if (now - pfFsLastPingAt >= 15_000) { pfFsLastPingAt = now; pfFsPing(true); }
    };
    paint();
    pfFsTick = setInterval(paint, 500);
  }

  chrome.runtime.sendMessage({ action: 'pfGetCloserState' }, (response) => {
    if (response && !chrome.runtime.lastError) {
      render(response);
      if ((response?.timerMode === 'earn' || response?.timerMode === 'spend') && response?.timerActive === true) {
        startFocusDirectTick();
      }
    }
  });

  // v83: arm the post-onboarding coach card. Runs once per page load; it
  // self-checks the storage flag and no-ops unless the tutorial just
  // finished. Deferred a beat so the button has rendered and the card has
  // something to point at.
  setTimeout(() => { void pfCoachMaybeStart(); }, 900);
  // Also react if the flag flips while this tab is already open — that is
  // the normal case, since the worker switches TO this tab right after the
  // dashboard finishes, and the tab may have been loaded long before.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[PF_COACH_FLAG]) return;
      if (changes[PF_COACH_FLAG].newValue !== true) return;
      // Re-arm the claim guard: this is a genuinely new walkthrough, not the
      // same one this tab already declined.
      pfCoachClaimAsked = false;
      void pfCoachMaybeStart();
    });
  } catch (_) { /* storage events unavailable — the timeout above still runs */ }

  chrome.runtime.onMessage.addListener((msg) => {
    // Earn-cycle completion confetti — same celebration as the study/break
    // timer completion. Fired from worker.js tickBankedTime when bankResult
    // .hitTarget is true.
    if (msg.action === 'pfPlayConfetti') {
      try { fireTimerCompletionConfetti(); } catch (_) {}
      return;
    }
    if (msg.action === 'showConfetti') {
      if (PF_DEBUG) {
        chrome.runtime.sendMessage({
          action: '__pf_debug_log',
          payload: { tag: 'pf-confetti-debug', msg: 'showConfetti received', origin: msg.origin }
        }).catch(() => {});

        console.info('[pf-confetti-debug] showConfetti message received',
          { origin: msg.origin });
      }
      const fakeSource = msg.origin ? {
        getBoundingClientRect: () => ({
          left: msg.origin.x - 30,
          top: msg.origin.y - 20,
          width: 60,
          height: 40
        })
      } : null;
      triggerPurpleConfetti(fakeSource);

      if (PF_DEBUG) {
        chrome.runtime.sendMessage({
          action: '__pf_debug_log',
          payload: { tag: 'pf-confetti-debug', msg: 'triggerPurpleConfetti invoked' }
        }).catch(() => {});
      }

      return;
    }
    if (msg.action === 'pfCloserStateUpdate' && msg.state && !isHoldInProgress()) {
      // Stamp the arrival time so getDisplayRemainingSec can extrapolate
      // smoothly between broadcasts (covers SW tick drift).
      msg.state.__receivedAt = Date.now();
      let nextState = msg.state;
      if (holdCompletedAt && Date.now() - holdCompletedAt < 3000 && holdCompletedTargetEnabled != null) {
        nextState = {
          ...nextState,
          limitsEnabled: holdCompletedTargetEnabled,
          toggleLimitsEnabled: holdCompletedTargetEnabled
        };
      }
      if (holdCompletedAt && Date.now() - holdCompletedAt >= 3000) {
        holdCompletedAt = 0;
        holdCompletedTargetEnabled = null;
      }
      if (PF_DEBUG) console.info('[pf-indicator-debug] state push received, will render', nextState);
      render(nextState);
      // Start/stop the independent focus-countdown direct DOM writer based on
      // whether a focus session is active. This bypasses the render chain
      // entirely and polls the worker every 500ms for the authoritative
      // remaining value — it's the visible source of truth for the focus
      // countdown. Per user report (2026-07): the normal render path's
      // countdown visually stuck despite the worker ticking correctly.
      // Extra gate per user report 2026-07: the "EARN BREAK IN 00:10"
      // chrome kept showing after Advanced Earn/Spend was toggled off.
      // If the broadcast says advancedEarnActive is false AND we're not
      // in a real user-started study/break session, treat the earn ring
      // as stale and stop the direct-tick writer.
      const modeIsEarnSpend = nextState?.timerMode === 'earn'
        || nextState?.timerMode === 'spend';
      const wantEarn = modeIsEarnSpend
        && nextState?.timerActive === true
        && !(nextState?.timerMode === 'earn' && nextState?.advancedEarnActive === false);
      if (wantEarn) {
        startFocusDirectTick();
      } else {
        stopFocusDirectTick();
      }
    }
  });

  // ── NON-SOURCE VIDEO AUTO-PAUSE ───────────────────────────────────────
  // User spec 2026-07 v33: "if the site is a non-source site please make
  // it if it's a video site like Instagram pause the video." When
  // Advanced Earn/Spend is configured for the current window AND the
  // current tab is NOT one of the configured source sites, any <video>
  // that starts playing (Instagram reels, TikTok, etc.) gets auto-paused
  // so it can't drain time passively. Source sites (YouTube-as-source,
  // etc.) are untouched — the user is deliberately earning there.
  //
  // Runs a one-time worker query on injection; re-checks on SPA URL
  // changes and on wall-clock closer-state broadcasts so a mid-session
  // config edit (adding/removing a source) takes effect without reload.
  (() => {
    let pfIsSource = null;               // null = unknown, true/false = known
    let pfAdvEarnConfigured = false;
    let pfPauseObserver = null;
    let pfPauseAttached = new WeakSet(); // videos we've hooked
    let pfLastCheckedUrl = '';

    const shouldPauseNow = () => pfAdvEarnConfigured === true && pfIsSource === false;

    const pauseIfPlaying = (v) => {
      if (!v || !shouldPauseNow()) return;
      try { if (!v.paused) v.pause(); } catch (_) { /* muted iframe / DRM */ }
    };

    const hookVideo = (v) => {
      if (!v || pfPauseAttached.has(v)) return;
      pfPauseAttached.add(v);
      // Autoplay after user navigation counts as "playing" — pause the
      // moment the play event fires (also catches HTMLMediaElement.play()
      // programmatic calls from SPA video players like Instagram reels).
      const onPlay = () => pauseIfPlaying(v);
      try {
        v.addEventListener('play', onPlay, true);
        v.addEventListener('playing', onPlay, true);
      } catch (_) {}
      pauseIfPlaying(v);
    };

    const sweepAllVideos = () => {
      if (!shouldPauseNow()) return;
      try {
        for (const v of document.querySelectorAll('video')) hookVideo(v);
      } catch (_) {}
    };

    const startObserver = () => {
      if (pfPauseObserver || !document.body) return;
      pfPauseObserver = new MutationObserver((muts) => {
        if (!shouldPauseNow()) return;
        for (const m of muts) {
          for (const n of m.addedNodes || []) {
            if (n?.nodeType !== 1) continue;
            if (n.tagName === 'VIDEO') hookVideo(n);
            else if (n.querySelectorAll) {
              for (const v of n.querySelectorAll('video')) hookVideo(v);
            }
          }
        }
      });
      try {
        pfPauseObserver.observe(document.body, { childList: true, subtree: true });
      } catch (_) { pfPauseObserver = null; }
    };

    const stopObserver = () => {
      if (!pfPauseObserver) return;
      try { pfPauseObserver.disconnect(); } catch (_) {}
      pfPauseObserver = null;
    };

    const querySourceStatus = () => {
      const url = location.href;
      if (!url || !url.startsWith('http')) return;
      // De-dup: don't re-ask the worker for the same URL we just checked.
      if (url === pfLastCheckedUrl && pfIsSource !== null) return;
      pfLastCheckedUrl = url;
      try {
        chrome.runtime.sendMessage(
          { action: 'isBankSourceForUrl', url },
          (resp) => {
            if (chrome.runtime.lastError) return;
            if (!resp?.success) return;
            pfAdvEarnConfigured = resp.advancedEarnConfigured === true;
            pfIsSource = resp.isSource === true;
            if (shouldPauseNow()) {
              startObserver();
              sweepAllVideos();
            } else {
              stopObserver();
              // Do NOT un-hook already-attached listeners — they'll
              // no-op naturally since shouldPauseNow() gates each pause.
            }
          }
        );
      } catch (_) { /* worker restarting */ }
    };

    // Kick off after DOM is ready enough for a <video> query.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', querySourceStatus, { once: true });
    } else {
      querySourceStatus();
    }

    // SPA route changes (Instagram / TikTok / Reddit) don't fire full
    // page loads — poll location.href every 1.5s and re-query on change.
    setInterval(() => {
      if (location.href !== pfLastCheckedUrl) querySourceStatus();
    }, 1500);

    // Config-edit re-check: whenever the worker broadcasts a new closer
    // state, refresh our source-status snapshot. Cheap — same fetch path.
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.action === 'closerStateUpdate' || msg?.action === 'closerStateChanged') {
          pfLastCheckedUrl = ''; // force re-ask on next tick
          querySourceStatus();
        }
      });
    } catch (_) {}
  })();
})();
