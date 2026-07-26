// email_validation.js
// MX record validation via DNS-over-HTTPS (Cloudflare).
// Confirms that an email domain has actual mail servers configured,
// catching typos and fake domains the disposable list doesn't cover.
//
// V1 — uses Cloudflare DoH (no auth needed, fast, privacy-respecting).

// Primary + fallback DoH resolvers. BOTH must also be present in the
// manifest's extension_pages connect-src — a CSP-blocked fetch throws the
// same way a network failure does. (Root cause of the 2026-07 "Network
// error during email check" signup blocker: cloudflare-dns.com was missing
// from connect-src, so the check failed for EVERY user.)
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
];
const MX_TIMEOUT_MS = 4000;

/** One DoH MX query. Returns { ok } / { ok:false, reason } — reason
 *  'unreachable' means THIS resolver couldn't answer (try the next one). */
async function queryMxOnce(endpoint, domain) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MX_TIMEOUT_MS);
  try {
    const url = `${endpoint}?name=${encodeURIComponent(domain)}&type=MX`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/dns-json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!r.ok) return { ok: false, reason: 'unreachable' };
    const data = await r.json();
    // DNS Status: 0 = NOERROR, 3 = NXDOMAIN
    if (data.Status === 3) return { ok: false, reason: 'domain-does-not-exist' };
    if (data.Status !== 0) return { ok: false, reason: 'dns-error' };
    const answers = Array.isArray(data.Answer) ? data.Answer : [];
    const mxRecords = answers.filter(a => a.type === 15); // type 15 = MX
    if (mxRecords.length === 0) return { ok: false, reason: 'no-mx-records' };
    return { ok: true };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, reason: 'unreachable' };
  }
}

// Validates that the email's domain has at least one MX record.
// Returns { ok: true } on success, { ok: false, reason } on failure.
//
// FAIL-OPEN policy (user report 2026-07: signup was hard-blocked by a
// "network error during email check"): this check exists to catch typo'd
// domains, it is NOT a security gate. If every resolver is unreachable
// (offline resolver, corporate firewall, CSP mistake), we let the signup
// proceed — Supabase's confirmation email is the real deliverability test.
async function validateEmailMx(email) {
  try {
    if (!email || typeof email !== 'string') {
      return { ok: false, reason: 'invalid-email-format' };
    }
    const at = email.lastIndexOf('@');
    if (at < 1 || at === email.length - 1) {
      return { ok: false, reason: 'invalid-email-format' };
    }
    const domain = email.slice(at + 1).toLowerCase().trim();
    if (!domain || !domain.includes('.')) {
      return { ok: false, reason: 'invalid-domain' };
    }

    for (const endpoint of DOH_ENDPOINTS) {
      const res = await queryMxOnce(endpoint, domain);
      // A definitive DNS answer (good OR bad) ends the check; only
      // resolver-unreachable falls through to the next endpoint.
      if (res.ok || res.reason !== 'unreachable') return res;
    }
    // Every resolver unreachable → fail OPEN, never block the signup.
    console.warn('[pf-email-mx] all DoH resolvers unreachable — skipping MX check (fail-open)');
    return { ok: true, soft: true, reason: 'mx-check-skipped' };
  } catch (e) {
    return { ok: true, soft: true, reason: 'mx-check-skipped' };
  }
}

// Convenience: combine disposable check + MX check in one call.
// Requires globalThis.isDisposableEmail to already be loaded.
async function validateEmailFull(email) {
  if (typeof globalThis.isDisposableEmail === 'function') {
    if (globalThis.isDisposableEmail(email)) {
      return { ok: false, reason: 'disposable-email' };
    }
  }
  return await validateEmailMx(email);
}

// Export to global scope
if (typeof globalThis !== 'undefined') {
  globalThis.validateEmailMx = validateEmailMx;
  globalThis.validateEmailFull = validateEmailFull;
}

export { validateEmailMx, validateEmailFull };
