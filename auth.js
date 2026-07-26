// auth.js — Supabase Auth wrapper for >=PlayingFild

export const SUPABASE_URL = 'https://iaqwfnyspvabtvatkldk.supabase.co';

export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcXdmbnlzcHZhYnR2YXRrbGRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NDExNDcsImV4cCI6MjA5MjQxNzE0N30.W-0aEoI8VLDG1FDsU1_1PcP33X2FV9auMyWSpvSLkQM';

export function parseJwtExpiry(accessToken) {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    if (payload.exp) return payload.exp * 1000;
  } catch (_) { /* ignore */ }
  return null;
}

export function getPfSessionEmail(session) {
  if (!session) return null;
  if (session.user?.email) return session.user.email;
  if (!session.access_token) return null;
  try {
    const payload = JSON.parse(atob(String(session.access_token).split('.')[1]));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch (_) {
    return null;
  }
}

export function isPfEmailVerified(session) {
  return Boolean(session?.user?.email_confirmed_at);
}

// ── Per-account stats isolation (user spec 2026-07) ─────────────────────────
// When a DIFFERENT account signs in on this device, the previous user's
// stats are wiped so nobody inherits (or exposes) someone else's browsing
// stats. The very first sign-in on a device CLAIMS the existing local stats
// without wiping — that's the same human who just did the tutorial.
// Settings/configs (tab limit, themes, source sites) are left alone: this
// clears personal ACTIVITY data, not device preferences.
const PF_STATS_OWNER_KEY = 'pfStatsOwnerId';
const PF_STATS_DATA_KEYS = [
  // Stats page: site time (PVU chart, hourly breakdown, site table)
  'dailySiteLogs', 'hourlySiteLogs', 'dailyLogs',
  'hourlyProductiveLogs', 'hourlyProductiveEngagement',
  // Typing speed
  'dailyWPMData', 'currentWPMSession', 'typingSession',
  'wpmSessionStart', 'wpmSessionKeys', 'wpmLastKeyAt',
  // Clicks
  'mouseClicks',
  // Recaps (Daily/Weekly/Monthly Wrapped) + streak
  'pfRecapDailySummaries', 'pfRecapSeen', 'currentStreak',
  // Earned time balances — personal, not device config
  'studyBreakAvailable', 'studyBreakProgress', 'pendingBreakCredits',
  'bankedReward', 'bankedProgress'
];

/**
 * Call with the signed-in user's stable id after EVERY successful sign-in.
 * No-op when the same account returns; wipes the stats listed above when a
 * different account takes over the device.
 * @returns {boolean} true when a wipe happened.
 */
export async function pfClaimStatsForAccount(userId) {
  if (!userId || typeof userId !== 'string') return false;
  try {
    const stored = await chrome.storage.local.get(PF_STATS_OWNER_KEY);
    const prevOwner = stored?.[PF_STATS_OWNER_KEY];
    if (prevOwner === userId) return false;
    let swapped = false;
    if (prevOwner) {
      // ARCHIVE (not delete — user spec 2026-07: "if you sign back in on the
      // same account the data shows back"): the outgoing account's stats are
      // parked under a per-account key, invisible to the incoming user but
      // fully restorable when that account returns to this device.
      const live = await chrome.storage.local.get(PF_STATS_DATA_KEYS);
      await chrome.storage.local.set({ [`pfStatsArchive:${prevOwner}`]: live });
      await chrome.storage.local.remove(PF_STATS_DATA_KEYS);
      swapped = true;
      console.info('[pf-auth] account change — previous stats archived');
    }
    // Returning account? Restore its archived stats onto the live keys.
    const archKey = `pfStatsArchive:${userId}`;
    const arch = await chrome.storage.local.get(archKey);
    if (arch?.[archKey] && typeof arch[archKey] === 'object') {
      await chrome.storage.local.set(arch[archKey]);
      await chrome.storage.local.remove(archKey);
      swapped = true;
      console.info('[pf-auth] returning account — stats restored from archive');
    }
    if (swapped) {
      // The worker mirrors several of these keys in memory — tell it to
      // re-hydrate from the (now swapped) storage.
      try { await chrome.runtime.sendMessage({ action: 'pfStatsReset' }); } catch (_) {}
    }
    await chrome.storage.local.set({ [PF_STATS_OWNER_KEY]: userId });
    return swapped;
  } catch (e) {
    console.warn('[pf-auth] stats ownership check failed', e);
    return false;
  }
}

export function hasPfSessionIdentity(session) {
  if (!session?.access_token) return false;
  const expMs = parseJwtExpiry(session.access_token);
  if (expMs != null && expMs <= Date.now()) return false;
  return Boolean(getPfSessionEmail(session));
}

export async function callSupabaseSignup(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password })
  });
  const data = await r.json();
  return { ok: r.ok, data };
}

export async function callSupabaseSignin(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password })
  });
  const data = await r.json();
  return { ok: r.ok, data };
}

export async function callSupabaseResend(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ type: 'signup', email })
  });
  return r.ok;
}

export async function callSupabasePasswordReset(email) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email })
    });
    if (r.status === 429) {
      // Try to pass along the response body so the UI can surface why
      // (Supabase includes a Retry-After header and often a body like
      // { error_code: 'over_email_send_rate_limit' } which is critical
      // context for the user — the previous silent 429 handling hid it).
      let data = {};
      try { data = await r.json(); } catch (_) { /* empty body is fine */ }
      const retryAfter = r.headers.get('Retry-After')
        || r.headers.get('X-RateLimit-Reset')
        || null;
      return { ok: false, rateLimited: true, data, status: r.status, retryAfter };
    }
    let data = {};
    try {
      data = await r.json();
    } catch (_) { /* empty body is fine on success */ }
    // 2xx BUT with an error body — Supabase returns 200 for a request
    // it accepted at the API layer even when the mailer failed further
    // downstream (e.g. SMTP over-quota). Detect that by inspecting the
    // response for an error-shaped payload.
    if (r.ok && data && typeof data === 'object') {
      const errMsg = data.msg || data.error_description || data.message || data.error;
      if (errMsg) {
        return { ok: false, mailerError: true, data, status: r.status };
      }
    }
    return { ok: r.ok, data, status: r.status };
  } catch (e) {
    return { ok: false, networkError: true, message: String(e?.message || e) };
  }
}

export async function callSupabaseUpdatePassword(accessToken, newPassword) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ password: newPassword })
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

export async function fetchUserChosenDisplayName(accessToken, userId) {
  if (!accessToken || !userId) return null;
  // Hard 5s timeout. This is called from checkSignInStatus() on the dashboard
  // boot path (BEFORE the loading overlay drops), so an unresponsive Supabase
  // would hang the whole dashboard for ~120s (browser default TCP timeout).
  // Aborting falls through to the email-username fallback instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=preferences`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`
      },
      signal: controller.signal
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const name = rows?.[0]?.preferences?.display_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function saveUserChosenDisplayName(accessToken, userId, displayName) {
  if (!accessToken || !userId) return { ok: false };
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (trimmed.length < 2 || trimmed.length > 32) return { ok: false, error: 'invalid_length' };
  try {
    // MERGE into the existing preferences jsonb — a bare PATCH replaces the
    // whole object, which would wipe pf_settings (the cross-device settings
    // payload) every time the display name was saved.
    let prefs = {};
    try {
      const cur = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=preferences`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` }
      });
      if (cur.ok) {
        const rows = await cur.json().catch(() => null);
        if (rows?.[0]?.preferences && typeof rows[0].preferences === 'object') prefs = rows[0].preferences;
      }
    } catch (_) { /* merge best-effort */ }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ preferences: { ...prefs, display_name: trimmed } })
    });
    return { ok: r.ok };
  } catch (_) {
    return { ok: false };
  }
}

export async function pfSignOut() {
  const stored = await chrome.storage.local.get('pfSession');
  if (stored.pfSession?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${stored.pfSession.access_token}`
        }
      });
    } catch (e) { /* network failure is fine, we still clear local */ }
  }
  await chrome.storage.local.remove('pfSession');
  return { error: null };
}

export async function pfRefreshSession() {
  const { pfSession } = await chrome.storage.local.get('pfSession');
  if (!pfSession?.refresh_token) {
    console.warn('[pf-auth] no refresh_token, cannot refresh');
    return null;
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refresh_token: pfSession.refresh_token })
      }
    );

    if (!res.ok) {
      console.warn('[pf-auth] refresh failed:', res.status);
      if (res.status === 400 || res.status === 401) {
        await chrome.storage.local.remove('pfSession');
      }
      return null;
    }

    const newSession = await res.json();
    const mergedSession = {
      ...pfSession,
      ...newSession,
      user: newSession.user || pfSession.user
    };
    await chrome.storage.local.set({ pfSession: mergedSession });
    console.info('[pf-auth] session refreshed, new exp in',
      mergedSession.expires_in, 'seconds');
    return mergedSession;
  } catch (err) {
    console.warn('[pf-auth] refresh threw:', err.message);
    return null;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.pfSignOut = pfSignOut;
  globalThis.pfRefreshSession = pfRefreshSession;
}
