// forgot-password.js — Email OTP password reset flow for >=PlayingFild
//
// Flow:
//   1. User enters their email, the 6-digit code from the email, and a new password
//   2. POST /auth/v1/verify { email, token: code, type: 'recovery' } → access_token
//   3. If successful, PUT /auth/v1/user with the token to set the new password
//   4. Show success message
//
// IMPORTANT: uses plain REST via auth.js (same pattern as signup.js) — NOT the
// supabase-js client. The previous version imported
// './node_modules/@supabase/supabase-js/...', but node_modules is EXCLUDED
// from the packaged zip (zip-build.sh), so the module import 404'd and the
// whole page was dead in store builds (it only worked as an unpacked dev
// checkout, where node_modules happens to exist on disk).

import { SUPABASE_URL, SUPABASE_ANON_KEY, callSupabaseUpdatePassword } from './auth.js';

// ── DOM refs ────────────────────────────────────────────────────────────────
const resetSection = document.getElementById('resetSection');
const doneState = document.getElementById('doneState');
const formMessage = document.getElementById('formMessage');
const resetForm = document.getElementById('resetForm');
const emailInput = document.getElementById('email');
const codeInput = document.getElementById('code');
const newPasswordInput = document.getElementById('newPassword');
const submitBtn = document.getElementById('submitBtn');
const submitText = document.getElementById('submitText');

// ── Helpers ─────────────────────────────────────────────────────────────────
function showMessage(text, type = 'error') {
  if (!formMessage) return;
  formMessage.textContent = text;
  formMessage.className = `message ${type}`;
}

function clearMessage() {
  if (!formMessage) return;
  formMessage.textContent = '';
  formMessage.className = 'message';
}

function setLoading(isLoading) {
  if (!submitBtn || !submitText) return;
  submitBtn.disabled = isLoading;
  submitText.innerHTML = isLoading
    ? '<span class="spinner"></span>Verifying…'
    : 'Reset Password';
}

/** Verify the recovery OTP; returns { access_token, ... } on success.
 *
 * Fallback chain (per user report 2026-07: correct code was rejected as
 * "invalid or expired"):
 *   1. type=recovery + email as-typed
 *   2. type=recovery + lowercased email
 *   3. type=email   + lowercased email  (email-OTP verification path,
 *      used by newer Supabase templates that share one verify endpoint)
 * The FIRST 2xx response wins. All 4xx responses collected and, if all
 * fail, the last error is thrown so the user-facing message reflects
 * the real Supabase reply.
 */
async function verifyRecoveryOtp(rawEmail, token) {
  const trimmed = String(rawEmail || '').trim();
  const attempts = [
    { email: trimmed,                  type: 'recovery' },
    { email: trimmed.toLowerCase(),    type: 'recovery' },
    { email: trimmed.toLowerCase(),    type: 'email' }
  ];
  let lastData = null;
  let lastStatus = 0;
  for (const attempt of attempts) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ ...attempt, token })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    // 429 (rate-limit) is not something to retry on with a different email
    // casing — bail immediately with a friendly message.
    if (r.status === 429) {
      throw new Error(data.msg || data.error_description || 'Too many attempts, please wait and try again');
    }
    lastData = data;
    lastStatus = r.status;
    // If Supabase said "token has expired", stop early — no amount of
    // email-casing tweaks will help.
    const msg = String(data?.msg || data?.error_description || data?.message || '');
    if (/expired/i.test(msg)) break;
  }
  throw new Error(
    lastData?.msg
      || lastData?.error_description
      || lastData?.message
      || `Token has expired or is invalid (status ${lastStatus})`
  );
}

// ── Auto-format the code input: digits only, max 6 ─────────────────────────
if (codeInput) {
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/[^0-9]/g, '').slice(0, 6);
  });
}

// ── Handle form submit ─────────────────────────────────────────────────────
if (resetForm) {
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessage();

    // Preserve email casing as typed; verifyRecoveryOtp tries both
    // as-typed and lowercased forms so a case-sensitive Supabase project
    // still validates the code.
    const email = (emailInput?.value || '').trim();
    const code = (codeInput?.value || '').trim();
    const newPassword = newPasswordInput?.value || '';

    // Basic validation
    if (!email || !email.includes('@')) {
      showMessage('Please enter a valid email address.', 'error');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      showMessage('Please enter the 6-digit verification code from your email.', 'error');
      return;
    }
    if (newPassword.length < 6) {
      showMessage('Password must be at least 6 characters long.', 'error');
      return;
    }

    setLoading(true);

    try {
      // Step 1: Verify the OTP code → short-lived recovery access token.
      const verifyData = await verifyRecoveryOtp(email, code);
      const accessToken = verifyData?.access_token;
      if (!accessToken) {
        throw new Error('Token has expired or is invalid');
      }

      // Step 2: Update the password with the recovery token.
      const { ok, data } = await callSupabaseUpdatePassword(accessToken, newPassword);
      if (!ok) {
        throw new Error(data?.msg || data?.error_description || data?.message || 'Could not update the password');
      }

      // Step 3: Show success state. (No sign-out needed — we never persisted
      // a session; the recovery token simply expires.)
      if (resetSection) resetSection.style.display = 'none';
      if (doneState) doneState.style.display = 'block';

    } catch (err) {
      console.error('[pf-forgot-password] reset failed:', err);

      // Map common Supabase error messages to user-friendly text
      const msg = String(err?.message || err || '');
      let friendly;
      if (msg.includes('Token has expired') || msg.includes('invalid') || msg.includes('expired') || msg.includes('otp')) {
        friendly = 'The verification code is invalid or has expired. Please request a new code and try again.';
      } else if (msg.includes('Email not confirmed')) {
        friendly = 'This email has not been confirmed. Please sign up first.';
      } else if (msg.includes('rate limit') || msg.includes('too many')) {
        friendly = 'Too many attempts. Please wait a few minutes before trying again.';
      } else if (msg.includes('should be different')) {
        friendly = 'The new password must be different from your old password.';
      } else {
        friendly = msg + ' Please try again or request a new code.';
      }

      showMessage(friendly, 'error');
    } finally {
      setLoading(false);
    }
  });
}
