// signup.js - Logic for signup.html
// Wires Supabase Auth via auth.js + email validation via email_validation.js

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  callSupabaseSignup,
  callSupabaseSignin,
  callSupabaseResend,
  callSupabasePasswordReset,
  callSupabaseUpdatePassword,
  fetchUserChosenDisplayName,
  isPfEmailVerified,
  pfClaimStatsForAccount
} from './auth.js';
import { syncPullOnSignin } from './sync.js';
import { createSpinnerButtonContent } from './dom_safe.js';
import { isDisposableEmail } from './disposable_email_domains.js';
import { validateEmailMx } from './email_validation.js';
import { capture as pfAnalyticsCapture, identify as pfAnalyticsIdentify } from './analytics.js';

const PRIVACY_POLICY_URL = 'https://gist.github.com/NotRedFox/e400c02894f215b20b805e16eda7aa88';
const TERMS_OF_SERVICE_URL = 'https://gist.github.com/NotRedFox/6b727ed9ff6a2e8dd4c319d3c7fc8536';

async function patchUserAgreementMetadata(accessToken, userId, metadata) {
  const body = {
    user_id: userId,
    agreed_to_privacy_at: metadata.agreed_to_privacy_at,
    agreed_to_age_at: metadata.agreed_to_age_at,
    email_opt_in: metadata.email_opt_in === true
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const brief = (await r.text()).slice(0, 200);
    console.warn('[pf-signup] user_data agreement patch failed:', r.status, brief);
    return false;
  }
  return true;
}

async function applyPendingUserAgreement(session) {
  if (!session?.access_token || !session?.user?.id) return;
  const stored = await chrome.storage.local.get('pfPendingAgreement');
  const pending = stored.pfPendingAgreement;
  if (!pending) return;
  const sessionEmail = (session.user?.email || '').trim().toLowerCase();
  const pendingEmail = (pending.pending_email || '').trim().toLowerCase();
  if (pendingEmail && sessionEmail && pendingEmail !== sessionEmail) {
    console.warn('[pf-signup] pfPendingAgreement email mismatch — discarding stale agreement', {
      pendingEmail,
      sessionEmail
    });
    await chrome.storage.local.remove('pfPendingAgreement');
    return;
  }
  const ok = await patchUserAgreementMetadata(session.access_token, session.user.id, pending);
  if (ok) {
    await chrome.storage.local.remove('pfPendingAgreement');
    console.info('[pf-signup] user_data agreement metadata saved');
  }
}

const STEPS = ['pfStepSignup', 'pfStepVerify', 'pfStepSignin', 'resetStep', 'pfStepNewPassword', 'pfStepDone'];
let currentEmail = '';
let _recoveryAccessToken = null;
let _pfVerifyPollInterval = null;
let _pfVerifyPollAttempts = 0;

// Show only one step, hide the others
function showStep(stepId) {
  STEPS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === stepId);
  });
  clearMessage();
  clearResetMessage();
  if (stepId === 'pfStepSignup') {
    updateSignupButtonGate();
  }
}

function showMessage(text, type = 'error') {
  const el = document.getElementById('pfMessage');
  el.textContent = text;
  el.className = `message ${type}`;
}

function clearMessage() {
  const el = document.getElementById('pfMessage');
  el.textContent = '';
  el.className = 'message';
}

function showResetMessage(text, type = 'error') {
  const el = document.getElementById('pfResetMessage');
  if (!el) return;
  el.textContent = text;
  el.className = `message ${type}`;
}

function clearResetMessage() {
  const el = document.getElementById('pfResetMessage');
  if (!el) return;
  el.textContent = '';
  el.className = 'message';
}

function setButtonLoading(btn, loading, originalText) {
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.replaceChildren(createSpinnerButtonContent());
    btn.disabled = true;
  } else {
    btn.textContent = originalText || btn.dataset.originalText || btn.textContent;
    if (btn.id === 'pfSignupBtn') {
      updateSignupButtonGate();
    } else {
      btn.disabled = false;
    }
  }
}

function signupRequirementsMet() {
  const agreeAge = document.getElementById('pfAgreeAge')?.checked === true;
  const agreePrivacy = document.getElementById('pfAgreePrivacy')?.checked === true;
  return agreeAge && agreePrivacy;
}

function shakeSignupRequirementLabels() {
  const ageLabel = document.getElementById('pfAgreeAgeLabel');
  const privacyLabel = document.getElementById('pfAgreePrivacyLabel');
  const pairs = [
    { label: ageLabel, checked: document.getElementById('pfAgreeAge')?.checked === true },
    { label: privacyLabel, checked: document.getElementById('pfAgreePrivacy')?.checked === true }
  ];
  pairs.forEach(({ label, checked }) => {
    if (checked) return;
    const el = label;
    if (!el) return;
    el.classList.remove('req-shake');
    void el.offsetWidth;
    el.classList.add('req-shake');
    setTimeout(() => el.classList.remove('req-shake'), 360);
  });
}

function updateSignupButtonGate() {
  const btn = document.getElementById('pfSignupBtn');
  if (!btn) return;
  btn.disabled = !signupRequirementsMet();
}

function showSignupRequirementsHint() {
  showMessage('Please confirm you are 13 or older and agree to the Terms of Service and Privacy Policy to continue.');
  shakeSignupRequirementLabels();
}

/** Parse URL fragment from reset email (#access_token=...&type=recovery). */
function parseRecoveryFromHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const type = params.get('type');
  if (!accessToken || type !== 'recovery') return null;
  return {
    accessToken,
    refreshToken: params.get('refresh_token'),
    expiresIn: params.get('expires_in'),
    tokenType: params.get('token_type') || 'bearer'
  };
}

function stopVerificationPolling() {
  if (_pfVerifyPollInterval) {
    clearInterval(_pfVerifyPollInterval);
    _pfVerifyPollInterval = null;
  }
  _pfVerifyPollAttempts = 0;
}

function startVerificationPolling(email, password) {
  stopVerificationPolling();
  _pfVerifyPollAttempts = 0;
  const maxAttempts = 150; // 150 * 4s = 10 minutes
  _pfVerifyPollInterval = setInterval(async () => {
    _pfVerifyPollAttempts++;
    if (_pfVerifyPollAttempts > maxAttempts) {
      stopVerificationPolling();
      return;
    }
    const { ok, data } = await callSupabaseSignin(email, password);
    console.info(`[pf-poll] attempt ${_pfVerifyPollAttempts}: ok=${ok}, has_token=${!!data?.access_token}, msg=${data?.msg || data?.error_description || 'none'}`);
    if (ok && data?.access_token) {
      stopVerificationPolling();
      void pfAnalyticsCapture('signup_completed', {});
      void pfAnalyticsCapture('signin_success', { is_new_account: true });
      if (data.user?.id) void pfAnalyticsIdentify(data.user.id).catch(() => {});
      // Different account than last time? Previous user's stats are wiped
      // BEFORE this session lands (user spec 2026-07).
      if (data.user?.id) await pfClaimStatsForAccount(data.user.id);
      await chrome.storage.local.set({ pfSession: data });
      // Pull this account's settings onto this device (cross-device sync).
      try { await chrome.runtime.sendMessage({ action: 'pfSettingsSyncNow', direction: 'pull' }); } catch (_) {}
      await applyPendingUserAgreement(data);
      try {
        const stored = await chrome.storage.local.get('pfPendingUsername');
        const username = stored.pfPendingUsername;
        if (username && data.user?.id) {
          await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${data.user.id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${data.access_token}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ preferences: { display_name: username } })
          });
          await chrome.storage.local.set({ pfUserDisplayName: username });
        }
        await chrome.storage.local.remove(['pfPendingUsername', 'pfPendingEmail']);
      } catch (e) {
        console.warn('Failed to save display name:', e);
      }
      showStep('pfStepDone');
      // Auto-redirect to dashboard after 2 seconds
      setTimeout(() => {
        redirectToDashboard();
      }, 2000);
    }
  }, 4000);
}

async function redirectToDashboard() {
  try {
    const dashboardUrl = chrome.runtime.getURL('stats.html');
    // Find the dashboard tab if it's already open; otherwise open one
    const tabs = await chrome.tabs.query({ url: dashboardUrl });
    if (tabs && tabs.length > 0) {
      // Focus the existing dashboard tab
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      // Tell the dashboard to refresh its signin status
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { action: 'pfRefreshSigninStatus' });
      } catch (e) { /* dashboard listener may be unavailable */ }
    } else {
      // Open a new dashboard tab in the foreground
      await chrome.tabs.create({ url: dashboardUrl, active: true });
    }
    // Close the signup tab
    window.close();
  } catch (e) {
    console.warn('redirectToDashboard failed:', e);
  }
}

// ===== Event handlers =====
async function handleSignup() {
  if (!signupRequirementsMet()) {
    showSignupRequirementsHint();
    return;
  }

  const btn = document.getElementById('pfSignupBtn');
  const username = document.getElementById('pfUsername').value.trim();
  const email = document.getElementById('pfEmail').value.trim().toLowerCase();
  const password = document.getElementById('pfPassword').value;
  const passwordConfirm = document.getElementById('pfPasswordConfirm').value;
  const agreeAge = document.getElementById('pfAgreeAge')?.checked === true;
  const agreePrivacy = document.getElementById('pfAgreePrivacy')?.checked === true;
  const emailOptIn = document.getElementById('pfOptInEmail')?.checked === true;

  if (!username || username.length < 2) {
    showMessage('Display name must be at least 2 characters.');
    return;
  }
  if (username.length > 32) {
    showMessage('Display name is too long (max 32 characters).');
    return;
  }
  if (!email || !email.includes('@')) {
    showMessage('Please enter a valid email address.');
    return;
  }
  if (!password || password.length < 8) {
    showMessage('Password must be at least 8 characters.');
    return;
  }
  if (password !== passwordConfirm) {
    showMessage('Passwords do not match.');
    return;
  }
  if (!agreeAge || !agreePrivacy) {
    showSignupRequirementsHint();
    return;
  }

  setButtonLoading(btn, true);
  clearMessage();
  void pfAnalyticsCapture('signup_submitted', {});

  try {
  if (isDisposableEmail(email)) {
    setButtonLoading(btn, false);
    showMessage('Disposable email services are not allowed. Please use a real email.');
    return;
  }

  showMessage('Verifying email domain...', 'info');
  const mx = await validateEmailMx(email);
  if (!mx.ok) {
    setButtonLoading(btn, false);
    const reasons = {
      'invalid-format': 'That email format looks wrong.',
      'invalid-email-format': 'That email format looks wrong.',
      'invalid-domain': 'That email domain looks wrong.',
      'domain-does-not-exist': 'That email domain does not exist. Did you mean a real domain?',
      'no-mx-records': 'That email domain cannot receive mail. Please double-check it.',
      'dns-error': 'Could not verify that email domain. Try again or use a different email.',
      'dns-failed': 'Email verification service is unreachable. Try again in a moment.',
      'dns-query-failed': 'Email verification service is unreachable. Try again in a moment.',
      'timeout': 'Email check timed out. Try again.',
      'dns-timeout': 'Email check timed out. Try again.',
      'network-error': 'Network error during email check. Try again.'
    };
    showMessage(reasons[mx.reason] || 'Email validation failed.');
    return;
  }

  showMessage('Creating account...', 'info');

  const agreementNow = new Date().toISOString();
  await chrome.storage.local.set({
    pfPendingAgreement: {
      agreed_to_privacy_at: agreementNow,
      agreed_to_age_at: agreementNow,
      email_opt_in: emailOptIn,
      pending_email: email
    },
    emailOptIn
  });

  const { ok, data } = await callSupabaseSignup(email, password);
  console.info('[pf-signup] response:', { ok, status: data?.code, data });

  // Detect duplicate signup - Supabase has multiple response shapes for this case
  const isDuplicate = (() => {
    // Shape A: ok=false with explicit error message
    if (!ok) {
      const errMsg = (data?.msg || data?.error_description || data?.error?.message || data?.message || '').toLowerCase();
      const code = (data?.code || data?.error_code || '').toString().toLowerCase();
      if (errMsg.includes('already registered') ||
          errMsg.includes('already exists') ||
          errMsg.includes('user already') ||
          errMsg.includes('email address has already been registered') ||
          code === 'user_already_exists' ||
          code === 'email_exists') {
        return true;
      }
    }
    // Shape B: ok=true but identities is empty (duplicate signup response)
    // Supabase returns user fields spread directly on data, not under data.user
    const userObj = data?.user || data;
    if (ok && userObj && Array.isArray(userObj.identities) && userObj.identities.length === 0) {
      return true;
    }
    // Shape C: ok=true with user id, no email_confirmed_at, but identities empty already handled above
    // Conservative duplicate guard when confirmation_sent_at is absent
    if (ok && userObj?.id && !userObj.confirmation_sent_at && !userObj.email_confirmed_at) {
      return true;
    }
    return false;
  })();

  if (isDuplicate) {
    setButtonLoading(btn, false);
    showMessage('You already have an account with that email. Switching you to sign in.', 'info');
    document.getElementById('pfSigninEmail').value = email;
    setTimeout(() => showStep('pfStepSignin'), 1500);
    return;
  }

  if (!ok) {
    const errMsg = (data?.msg || data?.error_description || data?.error?.message || '').toLowerCase();
    if (errMsg.includes('password')) {
      showMessage('Password issue: ' + (data.msg || 'try a stronger password.'));
    } else {
      showMessage(data?.msg || data?.error_description || 'Sign up failed. Please try again.');
    }
    return;
  }

  // Stash username + email in chrome.storage so we can apply it after signin completes
  await chrome.storage.local.set({ pfPendingUsername: username, pfPendingEmail: email, pfUserDisplayName: username });

  currentEmail = email;
  document.getElementById('pfVerifyEmail').textContent = email;
  showStep('pfStepVerify');
  showMessage('Check your inbox (and spam folder) for the verification link.', 'success');
  // Start auto-checking verification every 4 seconds, up to 10 minutes
  startVerificationPolling(email, password);
  } finally {
    setButtonLoading(btn, false);
  }
}

async function handleVerifyCheck() {
  stopVerificationPolling();
  const btn = document.getElementById('pfVerifyCheckBtn');
  const password = document.getElementById('pfPassword').value;

  if (!currentEmail || !password) {
    showMessage('Missing credentials. Try the signin flow instead.');
    showStep('pfStepSignin');
    return;
  }

  setButtonLoading(btn, true);
  clearMessage();
  showMessage('Checking verification status...', 'info');

  const { ok, data } = await callSupabaseSignin(currentEmail, password);
  setButtonLoading(btn, false);

  if (!ok) {
    const errMsg = (data?.msg || data?.error_description || '').toLowerCase();
    if (errMsg.includes('email not confirmed') || errMsg.includes('not been confirmed')) {
      showMessage('Email not yet verified. Click the link in your email, then try again.');
    } else {
      showMessage('Verification check failed: ' + (data?.msg || 'try again.'));
    }
    return;
  }

  await chrome.storage.local.set({ pfSession: data });
  await applyPendingUserAgreement(data);

  // Write username to public.users table now that we have a valid auth session
  try {
    const stored = await chrome.storage.local.get('pfPendingUsername');
    const username = stored.pfPendingUsername;
    if (username && data.user?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${data.user.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${data.access_token}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          preferences: { display_name: username }
        })
      });
      await chrome.storage.local.set({ pfUserDisplayName: username });
    }
    await chrome.storage.local.remove(['pfPendingUsername', 'pfPendingEmail']);
  } catch (e) {
    console.warn('Failed to save display name:', e);
    // Sign-in succeeded; profile update failure is non-blocking
  }

  showStep('pfStepDone');
  setTimeout(() => { redirectToDashboard(); }, 2000);
}

async function handleResend() {
  const btn = document.getElementById('pfResendBtn');
  if (!currentEmail) {
    showMessage('No email on record. Please sign up again.');
    return;
  }
  setButtonLoading(btn, true);
  const ok = await callSupabaseResend(currentEmail);
  setButtonLoading(btn, false);
  if (ok) {
    showMessage('Verification email resent. Check your inbox.', 'success');
  } else {
    showMessage('Could not resend. Try again in a moment.');
  }
}

async function handleSignin() {
  const btn = document.getElementById('pfSigninBtn');
  const email = document.getElementById('pfSigninEmail').value.trim().toLowerCase();
  const password = document.getElementById('pfSigninPassword').value;

  if (!email || !email.includes('@')) {
    showMessage('Please enter a valid email.');
    return;
  }
  if (!password) {
    showMessage('Please enter your password.');
    return;
  }

  setButtonLoading(btn, true);
  void pfAnalyticsCapture('signin_submitted', {});
  const { ok, data } = await callSupabaseSignin(email, password);
  setButtonLoading(btn, false);

  if (!ok) {
    const errMsg = (data?.msg || data?.error_description || '').toLowerCase();
    if (errMsg.includes('email not confirmed')) {
      showMessage('Your email is not yet verified. Check your inbox for the verification link.');
    } else if (errMsg.includes('invalid')) {
      showMessage('Wrong email or password.');
    } else {
      showMessage(data?.msg || 'Sign in failed.');
    }
    return;
  }

  void pfAnalyticsCapture('signin_success', { is_new_account: false });
  if (data.user?.id) void pfAnalyticsIdentify(data.user.id).catch(() => {});
  // Different account than last time? Previous user's stats are wiped
  // BEFORE this session lands (user spec 2026-07).
  if (data.user?.id) await pfClaimStatsForAccount(data.user.id);
  await chrome.storage.local.set({ pfSession: data });
  // Pull this account's settings onto this device (cross-device sync).
  try { await chrome.runtime.sendMessage({ action: 'pfSettingsSyncNow', direction: 'pull' }); } catch (_) {}
  await applyPendingUserAgreement(data);

  const chosenName = await fetchUserChosenDisplayName(data.access_token, data.user?.id);
  if (chosenName) {
    await chrome.storage.local.set({ pfUserDisplayName: chosenName });
  }

  const { dataCollectionMode } = await chrome.storage.local.get('dataCollectionMode');
  if (dataCollectionMode === 'standard') {
    const pullResult = await syncPullOnSignin();
    if (pullResult?.skipped && pullResult.reason === 'email_unverified') {
      showMessage('Verify your email to sync your data across devices.');
    }
  } else if (!isPfEmailVerified(data)) {
    showMessage('Verify your email to sync your data across devices.');
  }

  showStep('pfStepDone');
  setTimeout(() => { redirectToDashboard(); }, 2000);
}

function handleForgotPasswordClick(e) {
  e.preventDefault();
  const signinEmail = document.getElementById('pfSigninEmail')?.value?.trim().toLowerCase() || '';
  const resetEmailInput = document.getElementById('pfResetEmail');
  if (resetEmailInput && signinEmail) {
    resetEmailInput.value = signinEmail;
  }
  clearResetMessage();
  showStep('resetStep');
}

const PF_LAST_RESET_KEY = 'pfLastResetRequestAt';
const PF_RESET_COOLDOWN_MS = 60 * 1000; // Supabase's floor is ~60s

function formatDurationShort(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem > 0 ? `${h}h ${mRem}m` : `${h}h`;
}

function getLastResetRequestAt() {
  try {
    const raw = localStorage.getItem(PF_LAST_RESET_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

function markResetRequestNow() {
  try { localStorage.setItem(PF_LAST_RESET_KEY, String(Date.now())); } catch (_) {}
}

/**
 * "Enter your code here" jump button appended to the reset panel so the
 * user can go straight to the code-entry form when they already have the
 * code from a previous send (per user report 2026-07 — hitting "Send"
 * again just re-triggers Supabase's 60s rate limit).
 */
function appendEnterCodeLink() {
  try {
    const box = document.getElementById('pfResetMessage');
    if (!box || box.querySelector('.pf-enter-code-link')) return;
    const link = document.createElement('a');
    link.href = 'forgot-password.html';
    link.textContent = 'Enter your code here';
    link.className = 'pf-enter-code-link';
    link.style.cssText = 'display:inline-block;margin-top:10px;padding:8px 12px;background:#5B4B9F;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:0.88em;';
    box.appendChild(document.createElement('br'));
    box.appendChild(link);
  } catch (_) { /* best-effort */ }
}

async function handleSendReset() {
  const btn = document.getElementById('pfSendResetBtn');
  const email = document.getElementById('pfResetEmail')?.value?.trim().toLowerCase() || '';

  if (!email || !email.includes('@')) {
    showResetMessage('Please enter a valid email address.');
    return;
  }

  // ALWAYS attempt the send (per user report 2026-07: the previous local
  // 60s cooldown blocked the button before Supabase was even called, so
  // if the first email never arrived the user could never resend it).
  // Supabase's own 429 remains the real limiter; we surface a friendly
  // "already sent" message + jump link when it fires. We do keep the
  // local timestamp so we can show "sent Ns ago" context.
  const now = Date.now();
  const lastAt = getLastResetRequestAt();
  const elapsedMs = lastAt > 0 ? now - lastAt : 0;

  setButtonLoading(btn, true);
  clearResetMessage();

  const result = await callSupabasePasswordReset(email);
  setButtonLoading(btn, false);

  // Console-log the full result for diagnosis (per user report 2026-07 —
  // emails weren't arriving and the UI gave no signal why). The most
  // common causes are Supabase's built-in mailer rate limit (roughly
  // 2–4 emails/hour on the free tier) and downstream SMTP issues.
  console.info('[pf-forgot-password] send result', result);

  if (result.rateLimited) {
    // Honest messaging (per user report 2026-07: the previous "in a
    // minute" copy was misleading — Supabase's mailer bucket resets
    // hourly on the free tier, so 12+ minute waits are common). Prefer
    // the actual Retry-After header if the server returned one, and
    // ALSO stash the FIRST time we started getting 429s so we can
    // estimate when the hourly bucket most likely resets.
    const stashKey = 'pfFirstResetRateLimitAt';
    let firstRateLimitAt = 0;
    try {
      firstRateLimitAt = Number(localStorage.getItem(stashKey)) || 0;
      if (!firstRateLimitAt) {
        firstRateLimitAt = Date.now();
        localStorage.setItem(stashKey, String(firstRateLimitAt));
      }
    } catch (_) { /* best-effort */ }

    // Format the retry hint. `retryAfter` from Supabase is either an
    // integer seconds string or an HTTP date. If it's neither, fall
    // back to "up to an hour" (the free-tier default).
    let retryHint = 'You may need to wait up to an hour before the reset email works again.';
    const rawRetry = result.retryAfter;
    if (rawRetry) {
      const secs = Number(rawRetry);
      if (Number.isFinite(secs) && secs > 0) {
        retryHint = `Try again in ~${formatDurationShort(secs)}.`;
      } else {
        const at = Date.parse(rawRetry);
        if (Number.isFinite(at) && at > Date.now()) {
          const secs2 = Math.max(1, Math.ceil((at - Date.now()) / 1000));
          retryHint = `Try again in ~${formatDurationShort(secs2)}.`;
        }
      }
    } else if (firstRateLimitAt > 0) {
      // No Retry-After header — fall back to "assume hourly bucket".
      const bucketResetsAt = firstRateLimitAt + 60 * 60 * 1000;
      const secs = Math.max(1, Math.ceil((bucketResetsAt - Date.now()) / 1000));
      if (secs < 60 * 60) {
        retryHint = `The mailer bucket usually resets about ${formatDurationShort(secs)} from now.`;
      }
    }

    showResetMessage(
      `Reset emails are temporarily rate-limited by our mailer. ${retryHint} If you already got a code, click below to enter it — otherwise sit tight, no re-clicking needed.`,
      'error'
    );
    appendEnterCodeLink();
    return;
  }
  // Successful send clears the "first rate-limited at" stash so a
  // future 429 estimates from the RIGHT starting point.
  try { localStorage.removeItem('pfFirstResetRateLimitAt'); } catch (_) {}
  if (result.mailerError) {
    // Supabase accepted the request but the mailer bounced.
    const detail = result.data?.msg || result.data?.error_description || result.data?.message || 'mailer failed';
    showResetMessage(
      `The reset email couldn't be sent: ${detail}. Please try again in a few minutes, or contact support if it keeps happening.`,
      'error'
    );
    return;
  }
  if (result.networkError) {
    showResetMessage(
      `Couldn't reach the server (${result.message || 'network error'}). Check your connection and try again.`,
      'error'
    );
    return;
  }
  if (!result.ok) {
    const detail = result.data?.msg || result.data?.error_description || result.data?.message;
    showResetMessage(
      detail
        ? `Couldn't send the reset email: ${detail}. Please try again.`
        : "Couldn't send, try again.",
      'error'
    );
    return;
  }

  markResetRequestNow();
  void pfAnalyticsCapture('password_reset_requested', {});
  // Supabase sends a 6-digit code (not a magic link). Point the user
  // at forgot-password.html which has the code + new-password form.
  showResetMessage(
    "If that email is registered, you'll get a 6-digit code shortly. Check your inbox (and spam). It can take a minute or two to arrive.",
    'success'
  );
  appendEnterCodeLink();
}

async function handleSetNewPassword() {
  const btn = document.getElementById('pfSetPasswordBtn');
  const password = document.getElementById('pfNewPassword')?.value || '';
  const passwordConfirm = document.getElementById('pfNewPasswordConfirm')?.value || '';

  if (!_recoveryAccessToken) {
    showStep('resetStep');
    showResetMessage('Reset link expired or missing. Request a new reset link.');
    return;
  }
  if (!password || password.length < 8) {
    showMessage('Password must be at least 8 characters.');
    return;
  }
  if (password !== passwordConfirm) {
    showMessage('Passwords do not match.');
    return;
  }

  setButtonLoading(btn, true);
  clearMessage();

  const { ok, data } = await callSupabaseUpdatePassword(_recoveryAccessToken, password);
  setButtonLoading(btn, false);

  if (!ok) {
    showMessage(data?.msg || data?.error_description || 'Could not update password. Try requesting a new reset link.');
    return;
  }

  const email = document.getElementById('pfResetEmail')?.value?.trim().toLowerCase()
    || document.getElementById('pfSigninEmail')?.value?.trim().toLowerCase()
    || data?.user?.email
    || '';
  const signinResult = email
    ? await callSupabaseSignin(email, password)
    : { ok: false, data: null };
  if (signinResult.ok && signinResult.data?.access_token) {
    await chrome.storage.local.set({ pfSession: signinResult.data });
    await applyPendingUserAgreement(signinResult.data);
    _recoveryAccessToken = null;
    showStep('pfStepDone');
    showMessage('Password updated. Taking you to the dashboard...', 'success');
    setTimeout(() => { redirectToDashboard(); }, 2000);
    return;
  }

  const session = {
    access_token: _recoveryAccessToken,
    refresh_token: data?.refresh_token || null,
    token_type: data?.token_type || 'bearer',
    expires_in: data?.expires_in,
    user: data?.user || data
  };
  await chrome.storage.local.set({ pfSession: session });
  await applyPendingUserAgreement(session);
  _recoveryAccessToken = null;

  showStep('pfStepDone');
  showMessage('Password updated. Taking you to the dashboard...', 'success');
  setTimeout(() => { redirectToDashboard(); }, 2000);
}

async function initSignupTheme() {
  try {
    const { selectedTheme } = await chrome.storage.local.get('selectedTheme');
    const isNotebook = selectedTheme === 'notebook';
    document.body.classList.toggle('theme-notebook', isNotebook);
    document.documentElement.classList.toggle('theme-notebook', isNotebook);
  } catch (_) {
    // Storage unavailable outside extension context.
  }
}

// ===== Password show/hide (eye icon in every password field) =====
const PF_EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const PF_EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function initPasswordEyeToggles() {
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.pfEyeBound === '1') return;
    input.dataset.pfEyeBound = '1';
    // Wrap the input so the eye can sit inside the field's right edge.
    const wrap = document.createElement('div');
    wrap.className = 'pf-pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pf-pw-eye';
    btn.setAttribute('aria-label', 'Show password');
    btn.title = 'Show password';
    btn.innerHTML = PF_EYE_SVG;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? PF_EYE_OFF_SVG : PF_EYE_SVG;
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.title = show ? 'Hide password' : 'Show password';
      input.focus({ preventScroll: true });
    });
    wrap.appendChild(btn);
  });
}

// ===== Wire up event listeners on page load =====
document.addEventListener('DOMContentLoaded', () => {
  void initSignupTheme();
  initPasswordEyeToggles();
  const privacyLink = document.getElementById('pfPrivacyPolicyLink');
  if (privacyLink) {
    privacyLink.href = PRIVACY_POLICY_URL;
  }
  const termsLink = document.getElementById('pfTermsOfServiceLink');
  if (termsLink) {
    termsLink.href = TERMS_OF_SERVICE_URL;
  }

  const recovery = parseRecoveryFromHash();
  if (recovery?.accessToken) {
    _recoveryAccessToken = recovery.accessToken;
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (_) { /* ignore */ }
    showStep('pfStepNewPassword');
  } else {
    // Per user spec 2026-07: the profile "Sign in" button appends
    // ?tab=signin so the page lands on the sign-in form instead of the
    // create-account form. Other entry points (tutorial, first launch)
    // omit the param and get the default landing.
    try {
      const params = new URLSearchParams(window.location.search);
      const tab = (params.get('tab') || '').toLowerCase();
      if (tab === 'signin') {
        showStep('pfStepSignin');
      }
    } catch (_) { /* URLSearchParams not supported — keep default */ }
  }

  const ageCheckbox = document.getElementById('pfAgreeAge');
  const privacyCheckbox = document.getElementById('pfAgreePrivacy');
  ageCheckbox?.addEventListener('change', updateSignupButtonGate);
  privacyCheckbox?.addEventListener('change', updateSignupButtonGate);
  updateSignupButtonGate();

  const signupStep = document.getElementById('pfStepSignup');
  signupStep?.addEventListener('mousedown', (e) => {
    const trigger = e.target instanceof Element ? e.target.closest('#pfSignupBtn') : null;
    if (!trigger) return;
    if (!signupRequirementsMet()) {
      e.preventDefault();
      showSignupRequirementsHint();
    }
  }, true);

  document.getElementById('pfSignupBtn').addEventListener('click', handleSignup);
  document.getElementById('pfSwitchToSignin').addEventListener('click', () => showStep('pfStepSignin'));
  document.getElementById('pfSwitchToSignup').addEventListener('click', () => showStep('pfStepSignup'));
  document.getElementById('pfVerifyCheckBtn').addEventListener('click', handleVerifyCheck);
  document.getElementById('pfResendBtn').addEventListener('click', handleResend);
  document.getElementById('pfSigninBtn').addEventListener('click', handleSignin);
  document.getElementById('forgotPasswordLink')?.addEventListener('click', handleForgotPasswordClick);
  document.getElementById('pfSendResetBtn')?.addEventListener('click', handleSendReset);
  document.getElementById('pfBackToSignin')?.addEventListener('click', () => showStep('pfStepSignin'));
  document.getElementById('pfSetPasswordBtn')?.addEventListener('click', handleSetNewPassword);
  document.getElementById('pfCloseBtn').addEventListener('click', async () => {
    stopVerificationPolling();
    await redirectToDashboard();
  });

  function trySubmitSignupFromEnter(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!signupRequirementsMet()) {
      showSignupRequirementsHint();
      return;
    }
    handleSignup();
  }

  // Allow Enter key to submit (still blocked until age + Terms are checked)
  document.getElementById('pfPassword')?.addEventListener('keydown', trySubmitSignupFromEnter);
  document.getElementById('pfPasswordConfirm')?.addEventListener('keydown', trySubmitSignupFromEnter);
  document.getElementById('pfSigninPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSignin();
  });
  document.getElementById('pfResetEmail')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendReset();
  });
  document.getElementById('pfNewPasswordConfirm')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSetNewPassword();
  });
});
