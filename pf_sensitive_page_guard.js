/**
 * Shared sensitive/excluded-page guard for content scripts.
 * Loaded before privacy_gate.js and consolidated_content.js (manifest + reinject).
 * Exposes globalThis.__pfComputeSensitivePageActive().
 */
(function () {
  if (globalThis.__pfSensitivePageGuardLoaded) return;
  globalThis.__pfSensitivePageGuardLoaded = true;

  // Keep in sync with privacy_gate.js / excluded_hosts.js categories.
  const EXCLUDED_HOSTS = [
    'google.com', 'bing.com', 'duckduckgo.com',
    'gist.github.com',
    'mail.google.com', 'gmail.com',
    'outlook.com', 'outlook.live.com', 'outlook.office.com',
    'mail.yahoo.com',
    'proton.me', 'protonmail.com', 'mail.proton.me',
    'fastmail.com', 'tutanota.com', 'icloud.com',
    'chase.com', 'bankofamerica.com', 'wellsfargo.com',
    'citi.com', 'citibank.com', 'usbank.com',
    'capitalone.com', 'discover.com', 'americanexpress.com',
    'paypal.com', 'venmo.com', 'cashapp.com', 'wise.com',
    'revolut.com', 'monzo.com', 'starlingbank.com',
    'hsbc.com', 'barclays.co.uk', 'lloydsbank.com',
    'commbank.com.au', 'westpac.com.au', 'nab.com.au', 'anz.com.au',
    'ing.com.au', 'macquarie.com.au',
    'mychart.com', 'epicgateway.net', 'patientportal.com',
    'healthcare.gov', 'medicare.gov', 'cms.gov',
    'medibank.com.au', 'bupa.com.au', 'hcf.com.au',
    'nhs.uk',
    '1password.com', 'lastpass.com', 'bitwarden.com',
    'dashlane.com', 'keepersecurity.com', 'nordpass.com',
    'gov.uk', 'service.gov.uk',
    'gov.au', 'my.gov.au', 'ato.gov.au',
    'irs.gov', 'ssa.gov', 'usa.gov',
    'stripe.com', 'checkout.stripe.com', 'square.com',
    'checkout.shopify.com',
    'claude.ai',
    'chatgpt.com', 'chat.openai.com',
    'gemini.google.com', 'aistudio.google.com', 'bard.google.com',
    'grok.com', 'x.ai',
    'perplexity.ai',
    'copilot.microsoft.com',
    'chat.deepseek.com', 'deepseek.com',
    'mistral.ai', 'chat.mistral.ai',
    'huggingface.co',
    'poe.com', 'character.ai',
    'pi.ai', 'you.com', 'phind.com',
    'cursor.com', 'cursor.so',
    'pornhub.com', 'xvideos.com', 'xhamster.com',
    'onlyfans.com', 'fansly.com',
    'accounts.google.com', 'login.microsoftonline.com', 'login.yahoo.com',
    'appleid.apple.com', 'auth0.com', 'okta.com',
    'paypal.me', 'squareup.com', 'braintreepayments.com',
    'adyen.com', 'klarna.com', 'afterpay.com',
    'pnc.com', 'tdbank.com', 'natwest.com', 'santander.com', 'rbc.com',
    'mail.aol.com',
    'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com'
  ];

  const SENSITIVE_PATH_PATTERNS = [
    /\/login(\/|$|\?)/i,
    /\/signin(\/|$|\?)/i,
    /\/sign-in(\/|$|\?)/i,
    /\/signup(\/|$|\?)/i,
    /\/register(\/|$|\?)/i,
    /\/checkout(\/|$|\?)/i,
    /\/cart(\/|$|\?)/i,
    /\/payment(\/|$|\?)/i,
    /\/billing(\/|$|\?)/i,
    /\/account\/(security|password|payment|billing)/i,
    /\/oauth\/(authorize|callback)/i,
    /\/auth\//i,
    /\/password(\/|$|\?)/i,
    /\/reset-password/i,
    /\/forgot-password/i,
    /\/2fa(\/|$|\?)/i,
    /\/verify(\/|$|\?)/i,
    /\/sessions\/social\//i,
    /\/sessions\/two-factor/i,
    /\/sso\//i,
    /\/saml\//i,
    /\/o\/oauth2\//i,
    /\/connect\/oauth/i,
    /\/authorize\b/i
  ];

  function hostMatchesExcluded(hostname) {
    const host = String(hostname || '').replace(/^www\./, '').toLowerCase();
    if (!host) return false;
    return EXCLUDED_HOSTS.some((entry) => host === entry || host.endsWith('.' + entry));
  }

  globalThis.__pfComputeSensitivePageActive = function pfComputeSensitivePageActive() {
    try {
      if (!/^https?:$/i.test(location.protocol)) return false;
      const host = location.hostname.replace(/^www\./, '').toLowerCase();
      if (hostMatchesExcluded(host)) return true;
      return SENSITIVE_PATH_PATTERNS.some((rx) => rx.test(location.pathname));
    } catch (_) {
      return true;
    }
  };
})();
