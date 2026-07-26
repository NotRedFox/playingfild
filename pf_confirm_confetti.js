/**
 * Universal confirm confetti for feedback / close cards.
 * Injected via chrome.scripting.executeScript alongside card UI —
 * does not depend on closer_indicator.js or runtime message relay.
 */
(function initPfConfirmConfetti() {
  if (typeof globalThis.pfFireConfirmConfetti === 'function') return;

  function pfFireConfirmConfetti(originX, originY) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ox = Number.isFinite(originX) ? originX : window.innerWidth / 2;
    const oy = Number.isFinite(originY) ? originY : window.innerHeight / 2;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = [
      'position:fixed!important',
      'top:0!important',
      'left:0!important',
      'width:100vw!important',
      'height:100vh!important',
      'pointer-events:none!important',
      'z-index:2147483648!important'
    ].join(';');

    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;

    let mounted = false;
    try {
      document.documentElement.appendChild(canvas);
      mounted = true;
    } catch (_) {
      try {
        (document.body || document.documentElement).appendChild(canvas);
        mounted = true;
      } catch (_) { /* ignore */ }
    }
    if (!mounted) return;

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) {
      canvas.remove();
      return;
    }

    const PURPLE_PALETTE = ['#8b5cf6', '#a855f7', '#c084fc', '#9333ea', '#7c3aed', '#d8b4fe'];
    const particles = [];
    for (let i = 0; i < 70; i++) {
      const angle = -Math.PI * (0.25 + 0.5 * Math.random()) + (Math.random() - 0.5) * 0.4;
      const speed = 8 + Math.random() * 8;
      particles.push({
        x: ox + (Math.random() - 0.5) * 20,
        y: oy + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.4,
        size: 6 + Math.random() * 6,
        color: PURPLE_PALETTE[Math.floor(Math.random() * PURPLE_PALETTE.length)],
        shape: Math.random() < 0.5 ? 'rect' : 'circle'
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

      ctx2d.clearRect(0, 0, w, h);
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
        if (p.y > h + 30) return;

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

  function pfFireConfirmConfettiFromButton(btn) {
    try {
      const rect = btn?.getBoundingClientRect?.();
      if (rect) {
        pfFireConfirmConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return;
      }
    } catch (_) { /* ignore */ }
    pfFireConfirmConfetti();
  }

  globalThis.pfFireConfirmConfetti = pfFireConfirmConfetti;
  globalThis.pfFireConfirmConfettiFromButton = pfFireConfirmConfettiFromButton;
})();
