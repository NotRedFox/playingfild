/**
 * recap_cards.js — poster-quality share cards for the Daily / Weekly /
 * Monthly recaps. Distinct palette per kind (not everything purple), bolder
 * typographic contrast, subtle grain, kind-specific mini-visualization
 * (weekly = day bars, monthly = top hosts). Watermark ">=PlayingFild"
 * bottom-right. Rendered straight to <canvas> at exact share dimensions:
 *   story: 1080×1920 (IG/TikTok stories)
 *   post:  1200×675  (X/Twitter, LinkedIn)
 */

import { heroNumber, fmtDur, prettyHost } from './recap_engine.js';

export const CARD_SIZES = {
  story: { w: 1080, h: 1920 },
  post: { w: 1200, h: 675 }
};

// Per-kind palette. Each has: gradient (bg), ink (foreground), splash (accent).
// Chosen for high visual contrast so someone scrolling a feed stops on it.
const PALETTES = {
  daily: {
    bgTop: '#0a3a2b', bgBottom: '#1d7a55',
    ink: '#f2fff5', inkSoft: 'rgba(242,255,245,0.72)', inkFaint: 'rgba(242,255,245,0.42)',
    splash: '#ffd166', splashSoft: 'rgba(255,209,102,0.28)',
    accent: '#7fffb0'
  },
  weekly: {
    bgTop: '#2b0f36', bgBottom: '#8a2c66',
    ink: '#fff2f7', inkSoft: 'rgba(255,242,247,0.72)', inkFaint: 'rgba(255,242,247,0.42)',
    splash: '#ffcf5a', splashSoft: 'rgba(255,207,90,0.28)',
    accent: '#ff8fb1'
  },
  monthly: {
    bgTop: '#0b0f3a', bgBottom: '#3b2d8a',
    ink: '#f4f0ff', inkSoft: 'rgba(244,240,255,0.72)', inkFaint: 'rgba(244,240,255,0.42)',
    splash: '#f3b13a', splashSoft: 'rgba(243,177,58,0.28)',
    accent: '#c7bdff'
  }
};

// Kicker resolves either by variant (spotlight cards get their own label)
// or by kind (summary card falls back to the recap-kind label).
const VARIANT_KICKER = {
  topTab: 'TOP TAB',
  goldenHour: 'GOLDEN WINDOW',
  distraction: 'DISTRACTION BEATEN',
  streak: 'STREAK ALIVE',
  identity: 'HOW YOU WORK',
  recovery: 'RECOVERED ATTENTION',
  hiddenStreak: 'HIDDEN STREAK',
  meme: 'NO NOTES'
};
const KIND_KICKER = {
  daily: 'DAILY WRAPPED',
  weekly: 'WEEKLY WRAPPED',
  monthly: 'MONTHLY WRAPPED'
};
function kickerFor(recap) {
  if (recap.variant && VARIANT_KICKER[recap.variant]) return VARIANT_KICKER[recap.variant];
  return KIND_KICKER[recap.kind] || 'RECAP';
}

const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const SANS = '-apple-system, "Segoe UI", system-ui, sans-serif';

// Editorial phrases painted above the hero — they turn a bare stat into a
// moment ("You found your rhythm" → 20 hours). Grouped by variant, then
// by kind for the summary card. Deterministic pick from the recap.key so
// the phrase is stable within a day but rotates across days/kinds.
const POETIC = {
  summary: {
    daily: [
      'A day you showed up.',
      'You kept the thread.',
      'Small wins, added up.',
      'The quiet work paid off.'
    ],
    weekly: [
      'You found your rhythm.',
      "The week you didn't blink.",
      'Consistency, quietly.',
      'Seven small acts of focus.'
    ],
    monthly: [
      'The month you took back.',
      'You bent the curve.',
      'Time, reclaimed.',
      'The habit is real now.'
    ]
  },
  topTab: [
    'Where your best work happened.',
    'The place you kept returning to.',
    'Your home base.'
  ],
  goldenHour: [
    'When your brain hit its stride.',
    'The zone you found.',
    'Your peak stretch.'
  ],
  distraction: [
    "Tabs that didn't win.",
    'Every close, a small no.',
    'You made the harder click.'
  ],
  streak: [
    'Consistency, in motion.',
    'One day at a time.',
    'The streak keeps you honest.'
  ],
  identity: [
    'A pattern only you have.',
    'This is your signature.',
    'How you actually work.'
  ],
  recovery: [
    'Falling is fine. You got up.',
    'Every return is a rep.',
    'Attention, reclaimed.'
  ],
  hiddenStreak: [
    "A streak you didn't know existed.",
    'Quietly, without trying.',
    'The habit found you.'
  ],
  meme: [
    'We have questions.',
    'No judgment. Some judgment.',
    'The data speaks for itself.'
  ]
};

function _hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function poeticFor(recap) {
  const variant = recap.variant || 'summary';
  let pool = null;
  if (variant === 'summary') pool = POETIC.summary[recap.kind] || POETIC.summary.daily;
  else pool = POETIC[variant] || null;
  if (!pool || !pool.length) return null;
  const seed = _hash(String(recap.key || `${variant}:${recap.dateLabel || ''}`));
  return pool[seed % pool.length];
}

// ── low-level draw helpers ──────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Fit-to-width text sizer — shrinks until it fits maxWidth or hits 12px. */
function fitText(ctx, text, maxWidth, basePx, font, weight = '400') {
  let px = basePx;
  do {
    ctx.font = `${weight} ${px}px ${font}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    px -= Math.max(2, Math.round(px * 0.05));
  } while (px > 12);
  return px;
}

/**
 * Word-wrap into at most maxLines lines at a FIXED font (set on ctx before
 * calling). Returns the lines; the last line is ellipsized on overflow.
 * Replaces shrink-to-fit for long insight strings — shrinking made them
 * unreadably small (user report 2026-07: "font is too small and crowded").
 */
function wrapText(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (ctx.measureText(probe).width <= maxWidth || !line) {
      line = probe;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line) lines.push(line);
  // Ellipsize the final line if leftover words exist or it overflows.
  const consumed = lines.join(' ').split(/\s+/).length;
  if (consumed < words.length || ctx.measureText(lines[lines.length - 1]).width > maxWidth) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

// ── animation timeline helpers ──────────────────────────────────────────────
// renderRecapPoster accepts a progress t ∈ [0,1]. t=1 (the default) renders
// the EXACT static card — every reveal helper is a no-op at 1, so animated
// and static output are pixel-identical on the final frame.

function easeOutCubic(t) {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** Local phase: maps global t onto [start,end] as an eased 0..1. */
function phase(t, start, end) {
  if (t >= 1) return 1;
  return easeOutCubic((t - start) / Math.max(0.0001, end - start));
}

/** Reveal-multiplier consumed by drawBlob/drawShape so drawBackground's ~30
 *  call sites don't all need a new parameter. Set per render, reset after. */
let __bgReveal = 1;

/**
 * Subtle grain overlay — gives the poster a tactile feel vs. flat digital.
 * Uses an offscreen canvas + drawImage so it BLENDS on top of previous
 * drawing (globalAlpha) rather than replacing pixels — the earlier
 * putImageData version overwrote every prior draw call and left the card
 * blank except for whatever was drawn AFTER the grain.
 */
const GRAIN_CACHE = new Map(); // `${w}x${h}` → pre-rendered noise canvas
function getGrainCanvas(w, h) {
  const key = `${w}x${h}`;
  let noise = GRAIN_CACHE.get(key);
  if (noise) return noise;
  noise = document.createElement('canvas');
  noise.width = w; noise.height = h;
  const nctx = noise.getContext('2d');
  const img = nctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random() * 255;
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
  // Only two sizes exist (story/post) — tiny cache, huge win: regenerating
  // ~2M random pixels EVERY frame is what would make animation janky.
  if (GRAIN_CACHE.size > 4) GRAIN_CACHE.clear();
  GRAIN_CACHE.set(key, noise);
  return noise;
}

function drawGrain(ctx, w, h, alpha = 0.05) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'overlay';
  ctx.drawImage(getGrainCanvas(w, h), 0, 0);
  ctx.restore();
}

/**
 * Soft blob — radial gradient that fades to transparent, drawn on top of
 * the base gradient with a screen/lighter blend to build up Wrapped-style
 * organic color texture without needing raster assets.
 */
function drawBlob(ctx, w, h, cx, cy, r, color, alpha) {
  const a = alpha * __bgReveal;
  if (a <= 0.002) return;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, color);
  g.addColorStop(0.55, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalAlpha = a;
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Geometric accent — a rotated square outline, filled diamond, triangle, or
 * cross. Adds architectural variety alongside the organic blobs on the
 * Story cards. Post cards omit these — the landscape composition felt
 * cluttered with them.
 */
function drawShape(ctx, cx, cy, size, angle, color, alpha, shape, style) {
  const a = alpha * __bgReveal;
  if (a <= 0.002) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(cx, cy);
  ctx.rotate((angle || 0) * Math.PI / 180);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, size * 0.05);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (shape === 'square') {
    if (style === 'fill') ctx.fillRect(-size / 2, -size / 2, size, size);
    else ctx.strokeRect(-size / 2, -size / 2, size, size);
  } else if (shape === 'diamond') {
    ctx.beginPath();
    ctx.moveTo(0, -size / 2); ctx.lineTo(size / 2, 0);
    ctx.lineTo(0, size / 2); ctx.lineTo(-size / 2, 0);
    ctx.closePath();
    if (style === 'fill') ctx.fill(); else ctx.stroke();
  } else if (shape === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(0, -size / 2); ctx.lineTo(size / 2, size / 2); ctx.lineTo(-size / 2, size / 2);
    ctx.closePath();
    if (style === 'fill') ctx.fill(); else ctx.stroke();
  } else if (shape === 'cross') {
    ctx.beginPath();
    ctx.moveTo(-size / 2, -size / 2); ctx.lineTo(size / 2, size / 2);
    ctx.moveTo(size / 2, -size / 2); ctx.lineTo(-size / 2, size / 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw the card background: base diagonal gradient + variant-specific blob
 * composition. STORY cards also get one or two geometric accents (rotated
 * squares, diamonds, triangles, X-crosses) which read as design flourishes
 * in the poster format. POST cards use blobs only — the landscape composition
 * felt cluttered with hard-edge shapes competing with the hero.
 */
function drawBackground(ctx, w, h, palette, kind, variant, layout) {
  // Base diagonal gradient.
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, palette.bgTop);
  g.addColorStop(1, palette.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const v = variant || 'summary';
  const isStory = layout === 'story';

  if (v === 'summary') {
    // Calm 3-blob aura. Story frames the hero from top-left; Post pushes
    // decoration to the right half so the left-column hero has room.
    if (isStory) {
      drawBlob(ctx, w, h, w * 0.22, h * 0.35, w * 0.55, palette.accent, 0.32);
      drawBlob(ctx, w, h, w * 0.95, h * 0.12, w * 0.35, palette.splash, 0.22);
      drawBlob(ctx, w, h, w * 0.85, h * 0.92, w * 0.4,  palette.accent, 0.18);
    } else {
      drawBlob(ctx, w, h, w * 0.65, h * 0.4,  w * 0.45, palette.accent, 0.32);
      drawBlob(ctx, w, h, w * 0.95, h * 0.85, w * 0.35, palette.splash, 0.22);
      drawBlob(ctx, w, h, w * 0.15, h * 0.9,  w * 0.32, palette.accent, 0.18);
    }
  } else if (v === 'topTab') {
    // Two TIGHT bright "spotlight" blobs at opposite corners — feels like
    // stage lighting on the top tab. Story adds a pair of rotated open
    // squares for architectural texture.
    if (isStory) {
      drawBlob(ctx, w, h, w * 0.92, h * 0.16, w * 0.35, palette.splash, 0.38);
      drawBlob(ctx, w, h, w * 0.08, h * 0.78, w * 0.32, palette.accent, 0.32);
      drawBlob(ctx, w, h, w * 0.7, h * 0.55, w * 0.22, palette.splash, 0.14);
      drawShape(ctx, w * 0.86, h * 0.75, w * 0.16, 18, palette.splash, 0.5, 'square', 'stroke');
      drawShape(ctx, w * 0.06, h * 0.14, w * 0.09, -12, palette.accent, 0.5, 'square', 'stroke');
    } else {
      drawBlob(ctx, w, h, w * 0.88, h * 0.22, w * 0.28, palette.splash, 0.38);
      drawBlob(ctx, w, h, w * 0.62, h * 0.9,  w * 0.28, palette.accent, 0.28);
      drawBlob(ctx, w, h, w * 0.98, h * 0.7,  w * 0.22, palette.splash, 0.16);
    }
  } else if (v === 'goldenHour') {
    // SUNBURST — one bright central blob + a ring of smaller blobs
    // radiating outward. The blob primitive alone builds a "sun" without
    // needing polygon shapes.
    const cx = isStory ? w * 0.55 : w * 0.72;
    const cy = isStory ? h * 0.28 : h * 0.32;
    drawBlob(ctx, w, h, cx, cy, w * (isStory ? 0.42 : 0.34), palette.splash, 0.4);
    const rays = 6;
    const rayR = w * (isStory ? 0.55 : 0.42);
    const raySize = w * (isStory ? 0.12 : 0.09);
    for (let i = 0; i < rays; i++) {
      const ang = (Math.PI * 2 * i) / rays + 0.3;
      const rx = cx + Math.cos(ang) * rayR;
      const ry = cy + Math.sin(ang) * rayR;
      drawBlob(ctx, w, h, rx, ry, raySize, palette.splash, 0.22);
    }
    // Anchor blob in bottom-left so composition doesn't feel top-heavy.
    drawBlob(ctx, w, h, w * (isStory ? 0.15 : 0.12), h * (isStory ? 0.88 : 0.85), w * 0.3, palette.accent, 0.2);
    // Story-only: diamond accents (a "gem" motif for golden window).
    if (isStory) {
      drawShape(ctx, w * 0.88, h * 0.7, w * 0.13, 0, palette.splash, 0.5, 'diamond', 'stroke');
      drawShape(ctx, w * 0.11, h * 0.22, w * 0.06, 0, palette.accent, 0.7, 'diamond', 'fill');
    }
  } else if (v === 'distraction') {
    // Scattered noise pattern — many small blobs like TV static, evoking
    // the chaos of tabs you had to shut down. Grounded main blob anchors
    // the composition; the scatter builds atmosphere.
    const main = { cx: isStory ? w * 0.72 : w * 0.75, cy: isStory ? h * 0.35 : h * 0.4, r: w * (isStory ? 0.55 : 0.42) };
    drawBlob(ctx, w, h, main.cx, main.cy, main.r, palette.accent, 0.28);
    // Deterministic scatter of small blobs. Seed just from variant so the
    // pattern is stable, not random each render.
    const seed = 0x9e3779b1;
    let s = seed;
    const scatterN = isStory ? 9 : 7;
    for (let i = 0; i < scatterN; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const rx = (s / 0x7fffffff) * w;
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const ry = (s / 0x7fffffff) * h;
      // Skip scatter that would fall inside the safe hero zone.
      const heroCx = isStory ? w * 0.35 : w * 0.28;
      const heroCy = isStory ? h * 0.5 : h * 0.65;
      const dHero = Math.hypot(rx - heroCx, ry - heroCy);
      if (dHero < w * 0.28) continue;
      drawBlob(ctx, w, h, rx, ry, w * 0.06, i % 2 ? palette.splash : palette.accent, 0.16);
    }
    // Story-only: X-cross accents (the "no" to every blocked tab).
    if (isStory) {
      drawShape(ctx, w * 0.85, h * 0.8, w * 0.08, 0, palette.splash, 0.6, 'cross');
      drawShape(ctx, w * 0.07, h * 0.32, w * 0.06, 0, palette.splash, 0.5, 'cross');
      drawShape(ctx, w * 0.92, h * 0.5, w * 0.05, 0, palette.accent, 0.55, 'cross');
    }
  } else if (v === 'streak') {
    // VERTICAL FLAME STACK — a candle-like column of blobs building up
    // behind the hero. Each successive blob is smaller + brighter, giving
    // a real flame silhouette without polygon shapes.
    if (isStory) {
      const cx = w * 0.5;
      drawBlob(ctx, w, h, cx, h * 0.72, w * 0.42, palette.accent, 0.28); // base glow
      drawBlob(ctx, w, h, cx, h * 0.55, w * 0.36, palette.splash, 0.34);
      drawBlob(ctx, w, h, cx, h * 0.4,  w * 0.28, palette.splash, 0.38);
      drawBlob(ctx, w, h, cx, h * 0.28, w * 0.2,  palette.splash, 0.42);
      drawBlob(ctx, w, h, cx, h * 0.18, w * 0.12, palette.splash, 0.5);
    } else {
      // Landscape — flame runs left→right, anchored on the right side.
      const cy = h * 0.55;
      drawBlob(ctx, w, h, w * 0.9,  cy, w * 0.28, palette.accent, 0.28);
      drawBlob(ctx, w, h, w * 0.78, cy, w * 0.24, palette.splash, 0.34);
      drawBlob(ctx, w, h, w * 0.66, cy, w * 0.18, palette.splash, 0.36);
      drawBlob(ctx, w, h, w * 0.55, cy, w * 0.12, palette.splash, 0.4);
    }
    // Story-only: triangle "flames" for the streak energy motif.
    if (isStory) {
      drawShape(ctx, w * 0.85, h * 0.15, w * 0.1, 0, palette.splash, 0.7, 'triangle', 'fill');
      drawShape(ctx, w * 0.12, h * 0.82, w * 0.08, 20, palette.accent, 0.6, 'triangle', 'stroke');
    }
  }

  // Vignette — anchor per layout so the eye lands on the hero.
  const vcx = isStory ? w * 0.4 : w * 0.28;
  const vcy = isStory ? h * 0.45 : h * 0.6;
  const rg = ctx.createRadialGradient(vcx, vcy, w * 0.1, vcx, vcy, Math.max(w, h) * 0.9);
  rg.addColorStop(0, 'rgba(255,255,255,0.04)');
  rg.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Big geometric shapes — the "designed" feel. Never behind hero text.
 * Post layout uses a smaller top-right ring so it doesn't crash into the
 * right column (bars/top-hosts), and moves the accent chevron of dots to a
 * truly decorative bottom-left corner instead of the top-left where it
 * collided with the kicker + date text.
 */
function drawDecor(ctx, w, h, palette, kind, layout, t = 1) {
  ctx.save();
  const isPost = layout === 'post';
  // Rings "draw themselves in" during animation: the arc sweep scales with
  // the eased phase. At t=1 the sweep multiplier is exactly 1 → static parity.
  const ringSweep = phase(t, 0.05, 0.55);
  const ringAlpha = phase(t, 0.05, 0.4);

  // Big offset ring, splash color. Post gets a smaller, tighter ring so
  // it doesn't visually eat the right-column content.
  if (ringSweep > 0.01) {
    ctx.strokeStyle = palette.splash;
    ctx.globalAlpha = 0.85 * ringAlpha;
    ctx.lineWidth = Math.max(10, w * (isPost ? 0.012 : 0.018));
    ctx.beginPath();
    const ringR = isPost ? w * 0.14 : w * 0.24;
    ctx.arc(w * 1.02, h * 0.03, ringR, Math.PI * 0.4, Math.PI * (0.4 + 0.9 * ringSweep));
    ctx.stroke();

    // Accent ring bottom-left.
    ctx.strokeStyle = palette.accent;
    ctx.globalAlpha = 0.35 * ringAlpha;
    ctx.lineWidth = Math.max(6, w * 0.012);
    ctx.beginPath();
    ctx.arc(-w * 0.05, h * 0.94, w * (isPost ? 0.18 : 0.28), Math.PI * 1.4, Math.PI * (1.4 + 0.95 * ringSweep));
    ctx.stroke();
  }

  // Chevron of dots REMOVED — it was rendering as a floating cluster in
  // the bottom-left near the stats section, reading as an accidental
  // smudge rather than a design flourish. The composition looks cleaner
  // with just the two rings + palette-specific blobs.
  ctx.restore();
}

/**
 * Watermark — reproduces the real brand mark in canvas: a dashed rounded
 * rectangle containing ">=" (bold sans) plus "PlayingFild" in a handwritten
 * script (Caveat) to the right. All in ink-soft so it reads as "signature"
 * not "primary content." Anchored bottom-right with generous padding.
 *
 * IMPORTANT: `Caveat` must already be loaded (in-extension: bundled via the
 * notebook theme; in the preview page: Google Fonts link tag). Falls back to
 * a cursive stack if unavailable.
 */
function drawWatermark(ctx, w, h, palette) {
  ctx.save();
  const pad = Math.round(w * 0.045);
  const gtSize = Math.max(18, Math.round(w * 0.026));
  const scriptSize = Math.max(24, Math.round(w * 0.038));
  const HANDWRITE = `700 ${scriptSize}px Caveat, "Bradley Hand", "Segoe Script", "Comic Sans MS", cursive`;

  // Measure ">=" bounds.
  ctx.font = `800 ${gtSize}px ${SANS}`;
  const gtW = ctx.measureText('>=').width;
  const boxW = gtW + gtSize * 1.4;
  const boxH = gtSize * 1.85;

  // Measure the script wordmark.
  ctx.font = HANDWRITE;
  const wordText = 'PlayingFild';
  const wordW = ctx.measureText(wordText).width;

  const gap = Math.round(w * 0.012);
  const totalW = boxW + gap + wordW;
  const originX = w - pad - totalW;
  const originY = h - pad - boxH;

  // Dashed rounded box around ">=".
  ctx.strokeStyle = palette.inkSoft;
  ctx.lineWidth = Math.max(1.5, w * 0.0022);
  ctx.setLineDash([Math.max(4, w * 0.008), Math.max(3, w * 0.006)]);
  roundRect(ctx, originX, originY, boxW, boxH, boxH * 0.22);
  ctx.stroke();
  ctx.setLineDash([]);

  // ">=" inside the box.
  ctx.fillStyle = palette.inkSoft;
  ctx.font = `800 ${gtSize}px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('>=', originX + boxW / 2, originY + boxH / 2 + gtSize * 0.06);

  // Handwritten "PlayingFild" beside the box.
  ctx.fillStyle = palette.inkSoft;
  ctx.font = HANDWRITE;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Vertical center-align with the box.
  const wordY = originY + boxH * 0.72;
  ctx.fillText(wordText, originX + boxW + gap, wordY);

  ctx.restore();
}

// ── kicker + divider (per-variant signature marks) ─────────────────────────

/**
 * Draw the kicker — bigger, more designed, with a small colored dot before
 * the text, wide letter tracking, and a print-mag underline sweep. This is
 * the first thing the eye lands on, so it earns real presence instead of a
 * tiny pill.
 */
function drawKicker(ctx, w, x, y, text, palette, layout) {
  ctx.save();
  const isStory = layout === 'story';
  // Post kicker bumped from w*0.028 → w*0.04 so it doesn't get dwarfed by
  // the huge left-column hero.
  const px = Math.round(w * (isStory ? 0.048 : 0.04));
  const dotR = px * 0.32;
  // Tilt for dynamism — small enough it doesn't read as "typo," big enough
  // it doesn't look like an accident.
  const tilt = -1.5 * Math.PI / 180;
  ctx.font = `900 ${px}px ${SANS}`;
  const tw = ctx.measureText(text).width;
  ctx.translate(x, y);
  ctx.rotate(tilt);
  // Splash-color dot as a "bullet" before the kicker.
  ctx.beginPath();
  ctx.arc(dotR * 0.9, -px * 0.35, dotR, 0, Math.PI * 2);
  ctx.fillStyle = palette.splash;
  ctx.fill();
  // Kicker text with wide tracking. Canvas has no letter-spacing prop, so
  // draw character-by-character with a computed advance.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const trackPx = Math.round(px * 0.08);
  let cx = dotR * 2.2 + Math.round(px * 0.3);
  for (const ch of text) {
    ctx.fillStyle = palette.ink;
    ctx.fillText(ch, cx, 0);
    cx += ctx.measureText(ch).width + trackPx;
  }
  // Underline sweep (splash color) — half-width, feels like a print-mag kicker.
  ctx.fillStyle = palette.splash;
  const underlineY = Math.round(px * 0.18);
  const underlineW = Math.round((tw + dotR * 2.2 + Math.round(px * 0.3)) * 0.55);
  ctx.fillRect(0, underlineY, underlineW, Math.max(2, Math.round(px * 0.08)));
  ctx.restore();
}

/**
 * Divider "signature" — different geometric mark per variant so every card
 * has a distinct visual accent instead of the same flat bar.
 */
function drawDivider(ctx, x, y, w, palette, variant) {
  // New spotlight variants reuse an existing divider signature so every
  // card gets a mark without new geometry.
  const DIVIDER_ALIAS = {
    identity: 'goldenHour', recovery: 'distraction',
    hiddenStreak: 'streak', meme: 'topTab'
  };
  const kind = DIVIDER_ALIAS[variant] || variant || 'summary';
  ctx.save();
  ctx.fillStyle = palette.splash;
  ctx.strokeStyle = palette.splash;
  const stripW = w * 0.24;
  const thick = Math.max(3, w * 0.006);
  if (kind === 'summary') {
    // Chunky sawtooth zigzag.
    const teeth = 5;
    const toothW = stripW / teeth;
    const toothH = toothW * 0.55;
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
      ctx.moveTo(x + i * toothW, y + toothH);
      ctx.lineTo(x + i * toothW + toothW / 2, y);
      ctx.lineTo(x + (i + 1) * toothW, y + toothH);
    }
    ctx.lineWidth = thick;
    ctx.lineJoin = 'round';
    ctx.stroke();
  } else if (kind === 'topTab') {
    // Morse-code style: dashes of varying widths.
    const parts = [0.14, 0.06, 0.22, 0.06, 0.1, 0.06, 0.18];
    let cx = x;
    const gapRatio = 0.03;
    for (const p of parts) {
      const pw = stripW * p;
      ctx.fillRect(cx, y, pw, thick);
      cx += pw + stripW * gapRatio;
    }
  } else if (kind === 'goldenHour') {
    // Sunburst rays. The fan points UP toward a center point, so anchor the
    // center a full ray-length BELOW y — the mark then occupies [y, y+rLen]
    // like every other divider variant. (It previously fanned up FROM y and
    // drew straight through the hero label above it.)
    const rays = 7;
    const rLen = stripW * 0.35;
    const cx = x + stripW * 0.5;
    const cy = y + rLen + thick;
    ctx.lineWidth = thick;
    ctx.lineCap = 'round';
    for (let i = 0; i < rays; i++) {
      const angle = -Math.PI + (Math.PI / (rays - 1)) * i;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * rLen * 0.35, cy + Math.sin(angle) * rLen * 0.35);
      ctx.lineTo(cx + Math.cos(angle) * rLen, cy + Math.sin(angle) * rLen);
      ctx.stroke();
    }
  } else if (kind === 'distraction') {
    // Broken line with an X-mark in the gap.
    const seg = stripW * 0.35;
    ctx.fillRect(x, y, seg, thick);
    ctx.fillRect(x + stripW - seg, y, seg, thick);
    const xg = stripW * 0.15;
    const cxg = x + stripW / 2;
    const cyg = y + thick / 2;
    ctx.lineWidth = thick * 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cxg - xg * 0.35, cyg - xg * 0.35);
    ctx.lineTo(cxg + xg * 0.35, cyg + xg * 0.35);
    ctx.moveTo(cxg + xg * 0.35, cyg - xg * 0.35);
    ctx.lineTo(cxg - xg * 0.35, cyg + xg * 0.35);
    ctx.stroke();
  } else if (kind === 'streak') {
    // Chevron chain: connected < < < shapes.
    const chevrons = 4;
    const chW = stripW / chevrons;
    ctx.lineWidth = thick;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 0; i < chevrons; i++) {
      const cx = x + i * chW;
      ctx.beginPath();
      ctx.moveTo(cx, y + chW * 0.35);
      ctx.lineTo(cx + chW * 0.5, y);
      ctx.lineTo(cx + chW, y + chW * 0.35);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Weekly-specific mini bar chart of daily productive time (mon–sun).
 *  Bars grow bottom-up with a per-bar stagger when animating (t < 1). */
function drawMiniBars(ctx, x, y, w, h, bars, palette, t = 1) {
  const max = Math.max(1, ...bars.map((b) => b.sec));
  const gap = w * 0.04;
  const bw = (w - gap * (bars.length - 1)) / bars.length;
  const stag = 0.28 / Math.max(1, bars.length);
  bars.forEach((b, i) => {
    const barT = phase(t, 0.55 + i * stag, 0.8 + i * stag);
    if (barT <= 0.01) return;
    const bh = Math.max(4, (b.sec / max) * h * 0.82) * barT;
    const bx = x + i * (bw + gap);
    const by = y + h - bh - h * 0.14;
    // Bar.
    ctx.save();
    ctx.globalAlpha = barT;
    ctx.fillStyle = palette.splash;
    roundRect(ctx, bx, by, bw, bh, Math.min(bw * 0.35, 12));
    ctx.fill();
    // Label under bar.
    ctx.fillStyle = palette.inkFaint;
    ctx.font = `600 ${Math.round(w * 0.024)}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(b.label, bx + bw / 2, y + h - h * 0.02);
    ctx.restore();
  });
  ctx.textAlign = 'left';
}

/**
 * Post-format top-hosts strip — everything sized to compete with the
 * giant left-column hero. Rank numbers are near-hero-scale, host names
 * heading-scale, durations still legible on a laptop display. Wide row
 * gap and generous host→duration spacing so nothing feels squashed.
 */
function drawTopHostsBig(ctx, x, y, w, hosts, palette, t = 1) {
  // Row block: host baseline at +0.03w, duration baseline at +0.095w.
  // rowGap must exceed the block height (0.095w + descenders) or rank N+1
  // crowds row N's duration — that was the "squashed" look in review.
  const rowGap = w * 0.17;
  hosts.slice(0, 3).forEach((h, i) => {
    const rowT = phase(t, 0.55 + i * 0.1, 0.8 + i * 0.1);
    if (rowT <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = rowT;
    ctx.translate(0, (1 - rowT) * w * 0.03);
    const ry = y + i * rowGap;
    // Rank number — big serif in splash, vertically centred on the block.
    ctx.fillStyle = palette.splash;
    ctx.font = `800 ${Math.round(w * 0.075)}px ${SERIF}`;
    ctx.fillText(`${i + 1}`, x, ry + w * 0.06);
    // Host name (shrink-to-fit so long hosts stay inside the column).
    ctx.fillStyle = palette.ink;
    const hostPx = fitText(ctx, prettyHost(h.host), w * 0.88, Math.round(w * 0.048), SANS, '700');
    ctx.font = `700 ${hostPx}px ${SANS}`;
    ctx.fillText(prettyHost(h.host), x + w * 0.11, ry + w * 0.03);
    // Duration — a clear line below the host, never touching the next row.
    ctx.fillStyle = palette.inkSoft;
    ctx.font = `600 ${Math.round(w * 0.034)}px ${SANS}`;
    ctx.fillText(fmtDur(h.sec), x + w * 0.11, ry + w * 0.095);
    ctx.restore();
  });
}

/**
 * Monthly-specific top-hosts strip. `rowSpace` lets the caller override
 * the vertical spacing — post format needs more room because the two-line
 * host+duration block was overlapping the next rank when spacing was tight.
 */
function drawTopHosts(ctx, x, y, w, hosts, palette, rowSpace, t = 1) {
  // SINGLE-LINE rows: rank + host on the left, duration RIGHT-ALIGNED on
  // the same baseline. The old two-line layout (duration under the host)
  // was taller than the row gap, so row N's duration collided with row
  // N+1's host — the cramped look in review.
  const gap = rowSpace != null ? rowSpace : w * 0.055;
  hosts.slice(0, 3).forEach((h, i) => {
    const rowT = phase(t, 0.58 + i * 0.09, 0.82 + i * 0.09);
    if (rowT <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = rowT;
    ctx.translate(0, (1 - rowT) * w * 0.02);
    const ry = y + i * gap + w * 0.03;
    // Rank number.
    ctx.fillStyle = palette.splash;
    ctx.font = `800 ${Math.round(w * 0.036)}px ${SERIF}`;
    ctx.fillText(`${i + 1}`, x, ry);
    // Duration — right edge, measured first so the host can't run into it.
    ctx.fillStyle = palette.inkSoft;
    ctx.font = `700 ${Math.round(w * 0.028)}px ${SERIF}`;
    const durText = fmtDur(h.sec);
    const durW = ctx.measureText(durText).width;
    ctx.textAlign = 'right';
    ctx.fillText(durText, x + w, ry);
    ctx.textAlign = 'left';
    // Host — shrink-to-fit into the space left of the duration.
    ctx.fillStyle = palette.ink;
    const hostMax = w - w * 0.06 - durW - w * 0.03;
    const hostPx = fitText(ctx, prettyHost(h.host), hostMax, Math.round(w * 0.03), SANS, '700');
    ctx.font = `700 ${hostPx}px ${SANS}`;
    ctx.fillText(prettyHost(h.host), x + w * 0.06, ry);
    ctx.restore();
  });
}

// ── main render ─────────────────────────────────────────────────────────────

/**
 * Render a recap poster onto the given canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {'story'|'post'} size
 * @param {object} recap  output of buildDailyRecap/buildWeeklyRecap/buildMonthlyRecap
 * @param {number} progress  animation progress 0..1 (default 1 = static).
 *   The t=1 frame is pixel-identical to the pre-animation static render.
 */
export function renderRecapPoster(canvas, size, recap, progress = 1) {
  const dims = CARD_SIZES[size] || CARD_SIZES.story;
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext('2d');
  const { w, h } = { w: dims.w, h: dims.h };
  const palette = PALETTES[recap.kind] || PALETTES.weekly;
  const pad = Math.round(w * 0.085);
  const t = Math.min(1, Math.max(0, Number(progress) ?? 1));

  // Reveal wrapper for a text/content block: eased alpha + gentle rise.
  // No-op at t=1. Callers pass phase window [a,b] in global-t space.
  const reveal = (a, b, dy, fn) => {
    const bt = phase(t, a, b);
    if (bt <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = bt;
    if (dy) ctx.translate(0, dy * (1 - bt));
    fn(bt);
    ctx.restore();
  };

  // Blobs/shapes fade up first (module-scoped multiplier consumed inside
  // drawBlob/drawShape — see __bgReveal).
  __bgReveal = phase(t, 0, 0.35);
  drawBackground(ctx, w, h, palette, recap.kind, recap.variant, size);
  __bgReveal = 1;
  drawDecor(ctx, w, h, palette, recap.kind, size, t);

  // Hero can be either seconds (default) or a raw count (spotlight variants
  // like Distraction / Streak use { heroCount, heroCountUnit }).
  const heroFinal = recap.heroCount != null
    ? { value: String(recap.heroCount), unit: recap.heroCountUnit || '' }
    : heroNumber(recap.heroSec);
  // Count-up: interpolate the displayed number during its reveal window,
  // preserving the final string's decimal format. Width/layout always uses
  // the FINAL value so nothing shifts while the number climbs.
  const heroPhaseT = phase(t, 0.3, 0.75);
  let heroDisplay = heroFinal.value;
  if (heroPhaseT < 1) {
    const target = parseFloat(heroFinal.value);
    if (Number.isFinite(target)) {
      const decimals = heroFinal.value.includes('.') ? 1 : 0;
      heroDisplay = (target * heroPhaseT).toFixed(decimals);
    }
  }
  const hero = { value: heroFinal.value, display: heroDisplay, unit: heroFinal.unit };
  const stats = (recap.stats || []).slice(0, size === 'story' ? 4 : 3);
  const insights = (recap.insights || []).slice(0, 2);
  const bars = Array.isArray(recap.bars) ? recap.bars : null;
  const topHosts = Array.isArray(recap.topHosts) ? recap.topHosts : null;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (size === 'story') {
    // ── 1080×1920 vertical poster ──────────────────────────────────────────
    let y = h * 0.14;

    // Big designed kicker (see drawKicker) — bullet dot + wide-tracked
    // caps + underline sweep + slight tilt for personality.
    const kickerText = kickerFor(recap);
    reveal(0.08, 0.3, w * 0.02, () => {
      drawKicker(ctx, w, pad, y, kickerText, palette, 'story');
    });

    y += Math.round(w * 0.07);
    reveal(0.14, 0.36, w * 0.015, () => {
      ctx.fillStyle = palette.inkSoft;
      ctx.font = `600 ${Math.round(w * 0.026)}px ${SANS}`;
      ctx.fillText(recap.dateLabel || '', pad, y);
    });

    // Poetic subtitle — italic serif, ink-soft. Moved up (h*0.24) so it
    // clears the top of the hero glyphs — earlier position (h*0.29) put
    // the poetic ~50px INSIDE the hero's visual bounding box for tall
    // Georgia digits at heroPx=w*0.36.
    const poetic = poeticFor(recap);
    if (poetic) {
      reveal(0.2, 0.42, w * 0.015, () => {
        const py = h * 0.24;
        ctx.fillStyle = palette.inkSoft;
        const ppx = fitText(ctx, poetic, w - pad * 2, Math.round(w * 0.042), SERIF, '400 italic');
        ctx.font = `italic 400 ${ppx}px ${SERIF}`;
        ctx.fillText(poetic, pad, py);
      });
    }

    // HERO number — pushed down (h*0.42) to give real clearance beneath
    // the poetic subtitle. Layout metrics always use the FINAL value; the
    // displayed string counts up during the reveal window.
    y = h * 0.42;
    const heroPx = fitText(ctx, hero.value, w - pad * 2 - w * 0.25, Math.round(w * 0.36), SERIF, '900');
    ctx.font = `900 ${heroPx}px ${SERIF}`;
    const heroMetrics = ctx.measureText(hero.value);
    const numW = heroMetrics.width;
    reveal(0.3, 0.75, 0, (bt) => {
      // Gentle settle: 0.96 → 1 scale around the hero baseline origin.
      const s = 0.96 + 0.04 * bt;
      ctx.translate(pad, y);
      ctx.scale(s, s);
      ctx.translate(-pad, -y);
      ctx.fillStyle = palette.ink;
      ctx.font = `900 ${heroPx}px ${SERIF}`;
      ctx.fillText(hero.display, pad, y);
    });
    reveal(0.45, 0.68, w * 0.01, () => {
      ctx.fillStyle = palette.splash;
      ctx.font = `700 ${Math.round(w * 0.058)}px ${SERIF}`;
      ctx.fillText(hero.unit, Math.min(pad + numW + w * 0.03, w - pad - ctx.measureText(hero.unit).width), y);
    });

    // Position the label BELOW the actual descender of the hero digits
    // (Georgia has real descender space even for digits that don't visually
    // dip). Measure it instead of guessing with a magic offset — earlier
    // versions used w * 0.075 which pushed the label INSIDE the hero at
    // this heroPx size.
    ctx.font = `900 ${heroPx}px ${SERIF}`;
    const heroDescent = heroMetrics.actualBoundingBoxDescent || heroPx * 0.18;
    ctx.font = `700 ${Math.round(w * 0.048)}px ${SANS}`;
    const labelMetrics = ctx.measureText(recap.heroLabel || '');
    const labelAscent = labelMetrics.actualBoundingBoxAscent || Math.round(w * 0.048) * 0.85;
    y = y + heroDescent + labelAscent + Math.round(w * 0.022);
    reveal(0.5, 0.72, w * 0.015, () => {
      ctx.fillStyle = palette.ink;
      const heroLabelPx = fitText(ctx, recap.heroLabel || '', w - pad * 2, Math.round(w * 0.048), SANS, '700');
      ctx.font = `700 ${heroLabelPx}px ${SANS}`;
      ctx.fillText(recap.heroLabel || '', pad, y);
    });
    if (recap.heroDetail) {
      y += Math.round(w * 0.045);
      reveal(0.56, 0.78, w * 0.012, () => {
        ctx.fillStyle = palette.inkFaint;
        ctx.font = `500 ${Math.round(w * 0.026)}px ${SANS}`;
        ctx.fillText(recap.heroDetail, pad, y);
      });
    }

    // Variant-signature divider — zigzag, morse, sunburst, x-mark, or
    // chevron depending on the card kind. Revealed with a left→right clip
    // sweep so it "draws" across. Anchored BELOW whatever the hero block
    // actually used (tall heroes + detail lines used to run into the fixed
    // h*0.53 anchor — the sunburst-through-the-label bug in review).
    y = Math.max(h * 0.53, y + Math.round(w * 0.035));
    reveal(0.55, 0.75, 0, (bt) => {
      const dy = y;
      if (bt < 1) {
        ctx.beginPath();
        ctx.rect(pad - 4, dy - w * 0.02, (w * 0.26) * bt + 8, w * 0.14);
        ctx.clip();
      }
      drawDivider(ctx, pad, dy, w, palette, recap.variant || 'summary');
    });

    // Middle content: weekly gets bars, monthly gets top-hosts, daily gets insight rows.
    y += h * 0.045;
    if (recap.kind === 'weekly' && bars && bars.length) {
      drawMiniBars(ctx, pad, y, w - pad * 2, h * 0.19, bars, palette, t);
      y += h * 0.22;
    } else if (recap.kind === 'monthly' && topHosts && topHosts.length) {
      reveal(0.55, 0.75, w * 0.012, () => {
        ctx.fillStyle = palette.inkSoft;
        ctx.font = `700 ${Math.round(w * 0.024)}px ${SANS}`;
        ctx.fillText('TOP TABS', pad, y);
      });
      y += w * 0.035;
      drawTopHosts(ctx, pad, y, w - pad * 2, topHosts, palette, undefined, t);
      y += h * 0.19;
    }

    // Stat rows (up to 4 total — trimmed to fit). Insight rows wrap to two
    // lines at a readable size instead of shrinking to fit one line.
    const rowLimit = (recap.kind === 'weekly' || recap.kind === 'monthly') ? 3 : 4;
    const rows = stats.length
      ? stats.slice(0, rowLimit).map((s) => ({ left: s.label, right: s.value }))
      : insights.map((txt) => ({ left: txt, right: '' }));
    let rowIndex = 0;
    for (const row of rows) {
      const rowStart = 0.62 + rowIndex * 0.07;
      if (row.right) {
        const rowY = y;
        reveal(rowStart, rowStart + 0.24, w * 0.015, () => {
          ctx.fillStyle = palette.inkSoft;
          ctx.font = `600 ${Math.round(w * 0.03)}px ${SANS}`;
          ctx.fillText(row.left, pad, rowY);
          ctx.textAlign = 'right';
          ctx.fillStyle = palette.ink;
          ctx.font = `800 ${Math.round(w * 0.036)}px ${SERIF}`;
          ctx.fillText(row.right, w - pad, rowY);
          ctx.textAlign = 'left';
        });
        y += Math.round(h * 0.048);
      } else {
        // Insight row: fixed readable size, wrapped to ≤2 lines.
        const insightPx = Math.round(w * 0.033);
        ctx.font = `600 ${insightPx}px ${SANS}`;
        const lines = wrapText(ctx, `• ${row.left}`, w - pad * 2, 2);
        const rowY = y;
        reveal(rowStart, rowStart + 0.24, w * 0.015, () => {
          ctx.fillStyle = palette.ink;
          ctx.font = `600 ${insightPx}px ${SANS}`;
          lines.forEach((line, li) => {
            ctx.fillText(line, pad, rowY + li * Math.round(insightPx * 1.35));
          });
        });
        y += Math.round(h * 0.048) + (lines.length - 1) * Math.round(insightPx * 1.35);
      }
      rowIndex++;
    }
  } else {
    // ── 1200×675 landscape post ───────────────────────────────────────────
    // Top-left column is laid out SEQUENTIALLY (kicker → date → poetic),
    // each block positioned from the previous one's measured baseline.
    // The old fixed anchors (date at kicker+w*0.055 ≈ h*0.318 vs poetic at
    // h*0.35) left only ~20px between two text baselines → visible overlap.
    const kickerText = kickerFor(recap);
    let y = h * 0.18;
    reveal(0.08, 0.3, w * 0.012, () => {
      drawKicker(ctx, w, pad, y, kickerText, palette, 'post');
    });

    // Date sits a measured step below the kicker.
    const datePx = Math.round(w * 0.017);
    y += Math.round(w * 0.045);
    const dateY = y;
    reveal(0.14, 0.36, w * 0.01, () => {
      ctx.fillStyle = palette.inkSoft;
      ctx.font = `600 ${datePx}px ${SANS}`;
      ctx.fillText(recap.dateLabel || '', pad, dateY);
    });

    // Poetic subtitle — wrapped to ≤2 lines at a fixed readable size
    // instead of shrink-to-fit, and positioned below the date with a real
    // gap. Line height feeds into where the hero starts so nothing can
    // collide even for long poetic strings.
    const poeticP = poeticFor(recap);
    let poeticBottom = y;
    if (poeticP) {
      const ppx = Math.round(w * 0.024);
      ctx.font = `italic 400 ${ppx}px ${SERIF}`;
      const pLines = wrapText(ctx, poeticP, w * 0.46, 2);
      const pTop = y + Math.round(ppx * 1.7);
      reveal(0.2, 0.42, w * 0.01, () => {
        ctx.fillStyle = palette.inkSoft;
        ctx.font = `italic 400 ${ppx}px ${SERIF}`;
        pLines.forEach((line, li) => {
          ctx.fillText(line, pad, pTop + li * Math.round(ppx * 1.35));
        });
      });
      poeticBottom = pTop + (pLines.length - 1) * Math.round(ppx * 1.35);
    }

    // HERO on the left half — anchored to clear the poetic block. The
    // NUMBER + UNIT must both fit inside the left column: size the number
    // against the space left over after the unit, or "hours" spills into
    // the right column's rank numbers (review screenshot).
    const heroY = Math.max(h * 0.6, poeticBottom + h * 0.26);
    ctx.font = `700 ${Math.round(w * 0.034)}px ${SERIF}`;
    const unitW = ctx.measureText(hero.unit || '').width;
    const heroMaxW = Math.min(w * 0.46, (w * 0.5 - pad) - unitW - w * 0.015);
    const heroPx = fitText(ctx, hero.value, Math.max(w * 0.2, heroMaxW), Math.round(w * 0.18), SERIF, '900');
    ctx.font = `900 ${heroPx}px ${SERIF}`;
    const heroMetricsP = ctx.measureText(hero.value);
    const numW = heroMetricsP.width;
    reveal(0.3, 0.75, 0, (bt) => {
      const s = 0.96 + 0.04 * bt;
      ctx.translate(pad, heroY);
      ctx.scale(s, s);
      ctx.translate(-pad, -heroY);
      ctx.fillStyle = palette.ink;
      ctx.font = `900 ${heroPx}px ${SERIF}`;
      ctx.fillText(hero.display, pad, heroY);
    });
    reveal(0.45, 0.68, w * 0.008, () => {
      ctx.fillStyle = palette.splash;
      ctx.font = `700 ${Math.round(w * 0.034)}px ${SERIF}`;
      ctx.fillText(hero.unit, pad + numW + w * 0.015, heroY);
    });
    // Label BELOW the measured glyph bottom. Georgia uses OLD-STYLE figures:
    // digits like 3/4/5/7/9 have real descenders that reach ~0.2em below the
    // baseline, so a fixed offset from the baseline lands INSIDE the number
    // (the "4.8"/"5.4" overlap in review). Measure, like the story layout.
    const heroDescentP = heroMetricsP.actualBoundingBoxDescent || heroPx * 0.2;
    const labelPxP = Math.round(w * 0.026);
    const heroLabelY = heroY + heroDescentP + Math.round(labelPxP * 0.9) + Math.round(w * 0.012);
    reveal(0.5, 0.72, w * 0.01, () => {
      ctx.fillStyle = palette.ink;
      const hl = fitText(ctx, recap.heroLabel || '', w * 0.5, labelPxP, SANS, '700');
      ctx.font = `700 ${hl}px ${SANS}`;
      ctx.fillText(recap.heroLabel || '', pad, heroLabelY);
    });

    // Variant-signature divider — spaced from the LABEL's baseline (not the
    // hero's) so it never crowds the label, with a left→right clip sweep.
    // All divider variants render DOWNWARD from their anchor now, so the
    // clip window sits mostly below the anchor.
    const dividerY = heroLabelY + Math.round(w * 0.035);
    reveal(0.55, 0.75, 0, (bt) => {
      if (bt < 1) {
        ctx.beginPath();
        ctx.rect(pad - 4, dividerY - w * 0.02, (w * 0.26) * bt + 8, w * 0.14);
        ctx.clip();
      }
      drawDivider(ctx, pad, dividerY, w, palette, recap.variant || 'summary');
    });

    // Post right column — colW widened to 0.34, all fonts near-hero scale.
    // Content starts BELOW the kicker band (h*0.26+): the kicker's tracked
    // caps run well past mid-canvas, so a right column heading at the same
    // height collided with it ("MONTHLY WRAPPED" over "TOP TABS" in review).
    const colX = w * 0.52;
    const colW = w * 0.34;
    if (recap.kind === 'weekly' && bars && bars.length) {
      drawMiniBars(ctx, colX, h * 0.26, colW, h * 0.52, bars, palette, t);
    } else if (recap.kind === 'monthly' && topHosts && topHosts.length) {
      reveal(0.5, 0.7, w * 0.01, () => {
        ctx.fillStyle = palette.inkSoft;
        ctx.font = `800 ${Math.round(w * 0.028)}px ${SANS}`;
        ctx.fillText('TOP TABS', colX, h * 0.28);
      });
      drawTopHostsBig(ctx, colX, h * 0.37, colW, topHosts, palette, t);
    } else {
      // Insights + stat rows — sized to compete with the giant hero.
      // Insight text wraps to ≤2 lines at a fixed size instead of
      // shrinking (long insights used to end up tiny AND misaligned
      // against the stat rows' baselines).
      let cy = insights.length ? h * 0.4 : h * 0.33;
      const rows = stats.length
        ? stats.map((s) => ({ left: s.label, right: s.value }))
        : insights.map((txt) => ({ left: txt, right: '' }));
      const rowGap = insights.length ? Math.round(h * 0.24) : Math.round(h * 0.22);
      let ri = 0;
      for (const row of rows) {
        const rowStart = 0.6 + ri * 0.09;
        const rowY = cy;
        if (row.right) {
          reveal(rowStart, rowStart + 0.24, w * 0.012, () => {
            // Stat pair: caption label ABOVE big serif value.
            ctx.fillStyle = palette.inkSoft;
            ctx.font = `700 ${Math.round(w * 0.026)}px ${SANS}`;
            ctx.fillText(row.left, colX, rowY);
            ctx.fillStyle = palette.ink;
            ctx.font = `800 ${Math.round(w * 0.05)}px ${SERIF}`;
            ctx.fillText(row.right, colX, rowY + Math.round(w * 0.062));
          });
        } else {
          // Insights: 3 lines at a moderate size beats 2 lines at headline
          // size — the review screenshots showed "— Your best focus
          // block…" chopped mid-sentence with ellipses.
          const px = Math.round(w * 0.028);
          ctx.font = `600 ${px}px ${SANS}`;
          const lines = wrapText(ctx, `• ${row.left}`, colW, 3);
          reveal(rowStart, rowStart + 0.24, w * 0.012, () => {
            ctx.fillStyle = palette.ink;
            ctx.font = `600 ${px}px ${SANS}`;
            lines.forEach((line, li) => {
              ctx.fillText(line, colX, rowY + li * Math.round(px * 1.35));
            });
          });
        }
        cy += rowGap;
        ri++;
      }
    }
  }

  // Grain overlay LAST (except for the watermark which sits on top).
  // Both fade in late so the settle at t→1 is a soft "print" moment; at
  // t=1 the multipliers are exactly 1 → pixel-identical to a static draw.
  ctx.save();
  ctx.globalAlpha = phase(t, 0.5, 0.9);
  if (ctx.globalAlpha > 0.01) drawGrain(ctx, w, h, 0.04);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = phase(t, 0.7, 0.95);
  if (ctx.globalAlpha > 0.01) drawWatermark(ctx, w, h, palette);
  ctx.restore();
  return canvas;
}

/**
 * Animate a poster load-in on `canvas`. Drives renderRecapPoster's
 * `progress` from 0 → 1 with requestAnimationFrame; the final frame is
 * ALWAYS an exact `progress = 1` render, so the animated result is
 * pixel-identical to the static poster (Save/Copy can reuse the canvas).
 *
 * - Re-calling on the same canvas cancels the previous run (WeakMap token).
 * - prefers-reduced-motion → skips straight to the static render.
 * - Returns a cancel() function.
 */
const ANIM_TOKENS = new WeakMap();
export function animateRecapPoster(canvas, size, recap, opts = {}) {
  const durationMs = Math.max(300, Number(opts.durationMs) || 1800);
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;

  // Cancel any in-flight animation on this canvas.
  const prev = ANIM_TOKENS.get(canvas);
  if (prev) prev.cancelled = true;
  const token = { cancelled: false };
  ANIM_TOKENS.set(canvas, token);

  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    renderRecapPoster(canvas, size, recap, 1);
    if (onDone) onDone();
    return () => {};
  }

  const start = performance.now();
  const frame = (now) => {
    if (token.cancelled) return;
    const t = Math.min(1, (now - start) / durationMs);
    try {
      renderRecapPoster(canvas, size, recap, t);
    } catch (err) {
      // A draw error mid-animation must not strand a blank canvas.
      token.cancelled = true;
      renderRecapPoster(canvas, size, recap, 1);
      if (onDone) onDone();
      return;
    }
    if (t < 1) {
      requestAnimationFrame(frame);
    } else if (onDone) {
      onDone();
    }
  };
  requestAnimationFrame(frame);
  return () => { token.cancelled = true; };
}

/** Canvas → PNG blob. */
export function posterToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/** Trigger a download of the poster PNG. */
export async function downloadPoster(canvas, filename) {
  const blob = await posterToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Copy the poster PNG to the clipboard (so it can be pasted into a composer). */
export async function copyPosterToClipboard(canvas) {
  const blob = await posterToBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// ─────────────────────────────────────────────────────────────────────────────
// STORY VIEWER — the post-chest reveal experience.
// One card at a time over a blurred backdrop; the user drags (mouse or touch)
// left/right to move between cards, Instagram-story style. After the last
// card, a grid of everything they got appears with a Story ⇄ Post format
// toggle. Returns { close } — Esc or ✕ also close it.
// ─────────────────────────────────────────────────────────────────────────────

const RSV_CSS = `
.pf-rsv{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  background:rgba(9,8,16,0.62);backdrop-filter:blur(22px) saturate(1.1);-webkit-backdrop-filter:blur(22px) saturate(1.1);
  opacity:0;transition:opacity .35s ease;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;}
.pf-rsv.in{opacity:1;}
.pf-rsv-close{position:absolute;top:18px;right:22px;width:40px;height:40px;border-radius:50%;
  border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#fff;
  font-size:16px;line-height:1;cursor:pointer;z-index:3;padding:0;box-sizing:border-box;
  display:flex;align-items:center;justify-content:center;font-family:inherit;}
.pf-rsv-close:hover{background:rgba(255,255,255,0.18);}
/* the ✕ only exists on the final "Your cards" grid — never over a story card */
.pf-rsv:not(.grid) .pf-rsv-close{display:none;}
.pf-rsv-segs{position:absolute;top:20px;left:50%;transform:translateX(-50%);display:flex;gap:6px;z-index:2;}
.pf-rsv-seg{width:44px;height:4px;border-radius:2px;background:rgba(255,255,255,0.22);overflow:hidden;}
.pf-rsv-seg > i{display:block;height:100%;width:0;background:#fff;border-radius:2px;transition:width .3s ease;}
.pf-rsv-seg.done > i{width:100%;}
.pf-rsv-stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:18px;perspective:1400px;}
.pf-rsv-wrap{position:relative;touch-action:none;cursor:grab;will-change:transform;transition:transform .3s cubic-bezier(.22,.8,.3,1),opacity .3s ease;}
.pf-rsv-wrap.dragging{transition:none;cursor:grabbing;}
/* longer, cinematic exit for the LAST card only */
.pf-rsv-wrap.flyout{transition:transform .9s cubic-bezier(.3,.55,.35,1),opacity .9s ease;}
.pf-rsv-wrap canvas{display:block;height:min(66vh,640px);width:auto;border-radius:22px;
  box-shadow:0 30px 90px rgba(0,0,0,0.6);user-select:none;-webkit-user-drag:none;}
.pf-rsv-hint{color:rgba(255,255,255,0.55);font-size:12px;letter-spacing:0.18em;text-transform:uppercase;user-select:none;}
.pf-rsv-grid-view{display:none;flex-direction:column;align-items:center;gap:20px;max-width:min(92vw,1000px);
  max-height:88vh;overflow-y:auto;padding:20px;}
.pf-rsv.grid .pf-rsv-stage,.pf-rsv.grid .pf-rsv-segs,.pf-rsv.grid .pf-rsv-hint{display:none;}
@keyframes pf-rsv-gridin{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:none;}}
.pf-rsv.grid .pf-rsv-grid-view{display:flex;animation:pf-rsv-gridin .45s ease both;}
.pf-rsv-title{color:#fff;font-size:20px;font-weight:700;letter-spacing:0.04em;user-select:none;}
.pf-rsv-toggle{display:flex;gap:4px;padding:4px;border-radius:999px;background:rgba(255,255,255,0.1);
  border:1px solid rgba(255,255,255,0.18);}
.pf-rsv-toggle button{padding:7px 20px;border-radius:999px;border:none;background:transparent;
  color:rgba(255,255,255,0.65);font-size:12px;font-weight:700;letter-spacing:0.12em;cursor:pointer;}
.pf-rsv-toggle button.is-active{background:#fff;color:#111;}
/* tease: ONLY the white pill background (::before) nudges a little to the
   right — the STORY text stays put — then springs back with a small,
   satisfying overshoot. Starts the moment the grid appears (no hover
   needed) and repeats until a format is clicked. */
.pf-rsv-toggle button{position:relative;z-index:0;}
.pf-rsv-toggle button.is-active{background:transparent;color:#111;}
.pf-rsv-toggle button.is-active::before{content:'';position:absolute;inset:0;border-radius:999px;background:#fff;z-index:-1;}
@keyframes pf-rsv-tease{
  0%,100%{transform:translateX(0);}
  10%{transform:translateX(18%);}
  18%{transform:translateX(18%);}
  27%{transform:translateX(-2.5%);}
  33%{transform:translateX(1%);}
  38%{transform:translateX(0);}
}
.pf-rsv-toggle button.is-active.pf-rsv-teasing::before{
  animation:pf-rsv-tease 3s cubic-bezier(.4,.1,.35,1) .35s infinite;
}
.pf-rsv-grid{display:flex;flex-wrap:wrap;gap:16px;justify-content:center;}
.pf-rsv-grid canvas{display:block;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,0.5);
  cursor:pointer;transition:transform .18s ease;}
.pf-rsv-grid canvas:hover{transform:translateY(-4px) scale(1.02);}
.pf-rsv-grid canvas.fmt-story{height:min(450px,52vh);width:auto;}
.pf-rsv-grid canvas.fmt-post{width:min(530px,55vw);height:auto;}
/* hover actions: copy + download live ON each grid card (user spec 2026-07:
   visible on hover, no need to click into the card first) */
.pf-rsv-cell{position:relative;}
.pf-rsv-cell-actions{position:absolute;top:10px;right:10px;display:flex;gap:8px;
  opacity:0;pointer-events:none;transition:opacity .16s ease;z-index:2;}
.pf-rsv-cell:hover .pf-rsv-cell-actions,.pf-rsv-cell-actions:hover{opacity:1;pointer-events:auto;}
.pf-rsv-cell-actions button{width:36px;height:36px;border:none;border-radius:10px;padding:0;
  background:rgba(20,20,28,0.78);color:#fff;display:flex;align-items:center;justify-content:center;
  cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.35);}
/* stroke:#fff explicitly — currentColor resolved black in some contexts and
   the icons rendered as blank dark squares (user report 2026-07) */
.pf-rsv-cell-actions button svg{width:17px;height:17px;display:block;stroke:#fff;}
.pf-rsv-cell-actions button:hover{background:rgba(91,75,159,0.95);}
/* lightbox: a grid card blown up to full size, with an icon copy button */
.pf-rsv-big{position:absolute;inset:0;z-index:5;display:none;align-items:center;justify-content:center;
  background:rgba(5,5,10,0.6);}
.pf-rsv-big.on{display:flex;}
.pf-rsv-big-inner{position:relative;animation:pf-rsv-gridin .3s ease both;}
.pf-rsv-big-inner canvas{display:block;border-radius:20px;box-shadow:0 34px 100px rgba(0,0,0,0.7);}
.pf-rsv-big-inner canvas.fmt-story{height:min(80vh,760px);width:auto;}
.pf-rsv-big-inner canvas.fmt-post{width:min(84vw,900px);height:auto;}
.pf-rsv-big-actions{position:absolute;top:12px;right:12px;display:flex;gap:8px;}
.pf-rsv-big-actions button{width:40px;height:40px;border-radius:12px;border:none;padding:0;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(20,20,28,0.78);color:#fff;backdrop-filter:blur(6px);}
.pf-rsv-big-actions button:hover{background:rgba(46,46,60,0.9);}
.pf-rsv-big-actions svg{width:19px;height:19px;display:block;}
`;

function rsvEnsureStyle() {
  if (document.getElementById('pf-rsv-style')) return;
  const s = document.createElement('style');
  s.id = 'pf-rsv-style';
  s.textContent = RSV_CSS;
  document.head.appendChild(s);
}

export function openRecapStoryViewer(slides, opts = {}) {
  rsvEnsureStyle();
  const cancels = [];
  let idx = 0;
  let closed = false;
  let fmt = 'story';

  const overlay = document.createElement('div');
  overlay.className = 'pf-rsv';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Your recap cards');
  overlay.innerHTML = `
    <button class="pf-rsv-close" aria-label="Close">✕</button>
    <div class="pf-rsv-segs"></div>
    <div class="pf-rsv-stage">
      <div class="pf-rsv-wrap"><canvas></canvas></div>
      <div class="pf-rsv-hint">drag left</div>
    </div>
    <div class="pf-rsv-grid-view">
      <div class="pf-rsv-title">Your cards</div>
      <div class="pf-rsv-toggle">
        <button data-fmt="story" class="is-active pf-rsv-teasing">STORY</button>
        <button data-fmt="post">POST</button>
      </div>
      <div class="pf-rsv-grid"></div>
    </div>
    <div class="pf-rsv-big">
      <div class="pf-rsv-big-inner">
        <canvas></canvas>
        <div class="pf-rsv-big-actions">
          <button class="pf-rsv-copy" aria-label="Copy image" title="Copy image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="8" width="13" height="13" rx="2.5"></rect>
              <path d="M16 4.5A2.5 2.5 0 0 0 13.5 2h-8A2.5 2.5 0 0 0 3 4.5v8A2.5 2.5 0 0 0 5.5 15"></path>
            </svg>
          </button>
          <button class="pf-rsv-download" aria-label="Download image" title="Download image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v12"></path>
              <path d="m6.5 10.5 5.5 5.5 5.5-5.5"></path>
              <path d="M4.5 21h15"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));

  const segsEl = overlay.querySelector('.pf-rsv-segs');
  const wrap = overlay.querySelector('.pf-rsv-wrap');
  const canvas = overlay.querySelector('.pf-rsv-wrap canvas');
  const gridEl = overlay.querySelector('.pf-rsv-grid');

  slides.forEach(() => {
    const seg = document.createElement('div');
    seg.className = 'pf-rsv-seg';
    seg.appendChild(document.createElement('i'));
    segsEl.appendChild(seg);
  });
  const segs = [...segsEl.children];

  function stopAnims() {
    while (cancels.length) { try { cancels.pop()(); } catch (_) {} }
  }
  function show(i) {
    idx = i;
    segs.forEach((s, j) => s.classList.toggle('done', j <= i));
    stopAnims();
    // cards show face-up immediately — no reveal step
    try { cancels.push(animateRecapPoster(canvas, 'story', slides[i], { durationMs: 1400 })); }
    catch (_) { try { renderRecapPoster(canvas, 'story', slides[i]); } catch (_) {} }
  }
  function slideTo(i, dir) {
    // fly current card out, swap content, fly the next in from the other side
    wrap.style.transform = `translateX(${dir * -420}px) rotate(${dir * -7}deg)`;
    wrap.style.opacity = '0';
    setTimeout(() => {
      if (closed) return;
      wrap.classList.add('dragging'); // kill transition for the teleport
      wrap.style.transform = `translateX(${dir * 420}px) rotate(${dir * 7}deg)`;
      show(i);
      void wrap.offsetWidth;
      wrap.classList.remove('dragging');
      wrap.style.transform = '';
      wrap.style.opacity = '1';
    }, 220);
  }
  function flyOutToGrid() {
    // the last card's swipe follows all the way through — a long, slow sail
    // off-screen with a gentle fade, and only then does the grid arrive
    wrap.classList.add('flyout');
    wrap.style.transform = 'translateX(-620px) rotate(-10deg)';
    wrap.style.opacity = '0';
    setTimeout(() => { if (!closed) showGrid(); }, 820);
  }
  function next() { (idx < slides.length - 1) ? slideTo(idx + 1, 1) : flyOutToGrid(); }
  function prev() { if (idx > 0) slideTo(idx - 1, -1); else { wrap.style.transform = ''; } }

  // ── lightbox: click a grid card → big version + icon copy button ──
  const bigEl = overlay.querySelector('.pf-rsv-big');
  const bigCanvas = overlay.querySelector('.pf-rsv-big canvas');
  const copyBtn = overlay.querySelector('.pf-rsv-copy');
  const dlBtn = overlay.querySelector('.pf-rsv-download');
  const COPY_SVG = copyBtn.innerHTML;
  const DL_SVG = dlBtn.innerHTML;
  const TICK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';
  let bigSlide = null;
  function openBig(slide) {
    bigSlide = slide;
    bigCanvas.className = `fmt-${fmt}`;
    try { renderRecapPoster(bigCanvas, fmt, slide); } catch (_) {}
    copyBtn.innerHTML = COPY_SVG;
    dlBtn.innerHTML = DL_SVG;
    bigEl.classList.add('on');
  }
  function closeBig() { bigEl.classList.remove('on'); }
  bigEl.addEventListener('click', (e) => { if (e.target === bigEl) closeBig(); });
  copyBtn.addEventListener('click', async () => {
    try {
      await copyPosterToClipboard(bigCanvas);
      copyBtn.innerHTML = TICK_SVG;
      setTimeout(() => { if (!closed) copyBtn.innerHTML = COPY_SVG; }, 1300);
    } catch (_) { /* clipboard unavailable (permissions/insecure ctx) */ }
  });
  dlBtn.addEventListener('click', async () => {
    try {
      await downloadPoster(bigCanvas, `wrapped-${(bigSlide && bigSlide.kind) || 'card'}-${fmt}.png`);
      dlBtn.innerHTML = TICK_SVG;
      setTimeout(() => { if (!closed) dlBtn.innerHTML = DL_SVG; }, 1300);
    } catch (_) { /* download blocked */ }
  });

  // (2026-07: hover copy/download on the SWIPE stage removed per user spec —
  // the actions belong to the grid cells only; the story stage stays clean.)

  function renderGrid() {
    stopAnims();
    gridEl.replaceChildren();
    slides.forEach((slide) => {
      const cell = document.createElement('div');
      cell.className = 'pf-rsv-cell';
      const c = document.createElement('canvas');
      c.className = `fmt-${fmt}`;
      c.title = 'Open this card';
      cell.appendChild(c);
      // Hover actions ON the card (user spec 2026-07): copy + download show
      // on hover — no need to click into the lightbox first. Clicking the
      // card itself still opens the big view.
      const actions = document.createElement('div');
      actions.className = 'pf-rsv-cell-actions';
      const cCopy = document.createElement('button');
      cCopy.type = 'button';
      cCopy.setAttribute('aria-label', 'Copy image');
      cCopy.title = 'Copy image';
      cCopy.innerHTML = COPY_SVG;
      const cDl = document.createElement('button');
      cDl.type = 'button';
      cDl.setAttribute('aria-label', 'Download image');
      cDl.title = 'Download image';
      cDl.innerHTML = DL_SVG;
      actions.appendChild(cCopy);
      actions.appendChild(cDl);
      cell.appendChild(actions);
      gridEl.appendChild(cell);
      try { renderRecapPoster(c, fmt, slide); } catch (_) {}
      c.addEventListener('click', () => openBig(slide));
      cCopy.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await copyPosterToClipboard(c);
          cCopy.innerHTML = TICK_SVG;
          setTimeout(() => { if (!closed) cCopy.innerHTML = COPY_SVG; }, 1300);
        } catch (_) { /* clipboard unavailable (permissions/insecure ctx) */ }
      });
      cDl.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await downloadPoster(c, `wrapped-${slide.kind || 'card'}-${fmt}.png`);
          cDl.innerHTML = TICK_SVG;
          setTimeout(() => { if (!closed) cDl.innerHTML = DL_SVG; }, 1300);
        } catch (_) { /* download blocked */ }
      });
    });
  }
  function showGrid() {
    overlay.classList.add('grid');
    renderGrid();
  }
  // On the grid page, clicking the empty backdrop (outside the cards/toggle)
  // closes the viewer — same as the ✕.
  overlay.addEventListener('click', (e) => {
    if (overlay.classList.contains('grid') && e.target === overlay) close();
  });
  overlay.querySelectorAll('.pf-rsv-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      fmt = b.dataset.fmt;
      overlay.querySelectorAll('.pf-rsv-toggle button')
        .forEach((x) => { x.classList.toggle('is-active', x === b); x.classList.remove('pf-rsv-teasing'); });
      renderGrid();
    });
  });

  // mouse/touch swipe via pointer events
  let dragX0 = null, dragDx = 0;
  wrap.addEventListener('pointerdown', (e) => {
    dragX0 = e.clientX; dragDx = 0;
    wrap.classList.add('dragging');
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  });
  wrap.addEventListener('pointermove', (e) => {
    if (dragX0 === null) return;
    dragDx = e.clientX - dragX0;
    wrap.style.transform = `translateX(${dragDx}px) rotate(${dragDx * 0.02}deg)`;
  });
  const endDrag = () => {
    if (dragX0 === null) return;
    dragX0 = null;
    wrap.classList.remove('dragging');
    if (dragDx <= -70) next();
    else if (dragDx >= 70) { (idx > 0) ? prev() : (wrap.style.transform = ''); }
    else wrap.style.transform = '';
    dragDx = 0;
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  function onKey(e) {
    if (e.key === 'Escape') { if (bigEl.classList.contains('on')) closeBig(); else close(); }
    else if (!overlay.classList.contains('grid')) {
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    }
  }
  document.addEventListener('keydown', onKey);

  function close() {
    if (closed) return;
    closed = true;
    stopAnims();
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 360);
    if (opts.onClose) { try { opts.onClose(); } catch (_) {} }
  }
  overlay.querySelector('.pf-rsv-close').addEventListener('click', close);

  show(0);
  return { close };
}
