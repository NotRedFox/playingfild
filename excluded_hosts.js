/** Hosts excluded from classification and Layer 2 telemetry (hostname + optional path prefix). */

export const EXCLUDED_HOST_CATEGORIES = [
  {
    category: 'local_development',
    hosts: ['localhost', '127.0.0.1', 'local']
  },
  {
    category: 'search',
    hosts: ['google.com', 'bing.com', 'duckduckgo.com']
  },
  {
    category: 'code_personal',
    hosts: ['gist.github.com']
  },
  {
    category: 'webmail',
    hosts: [
      'mail.google.com', 'gmail.com',
      'outlook.com', 'outlook.live.com', 'outlook.office.com',
      'mail.yahoo.com',
      'proton.me', 'protonmail.com', 'mail.proton.me',
      'fastmail.com', 'tutanota.com', 'icloud.com'
    ]
  },
  {
    category: 'banking',
    hosts: [
      'chase.com', 'bankofamerica.com', 'wellsfargo.com',
      'citi.com', 'citibank.com', 'usbank.com',
      'capitalone.com', 'discover.com', 'americanexpress.com',
      'paypal.com', 'venmo.com', 'cashapp.com', 'wise.com',
      'revolut.com', 'monzo.com', 'starlingbank.com',
      'hsbc.com', 'barclays.co.uk', 'lloydsbank.com',
      'commbank.com.au', 'westpac.com.au', 'nab.com.au', 'anz.com.au',
      'ing.com.au', 'macquarie.com.au'
    ]
  },
  {
    category: 'healthcare',
    hosts: [
      'mychart.com', 'epicgateway.net', 'patientportal.com',
      'healthcare.gov', 'medicare.gov', 'cms.gov',
      'medibank.com.au', 'bupa.com.au', 'hcf.com.au',
      'nhs.uk'
    ]
  },
  {
    category: 'password_manager',
    hosts: [
      '1password.com', 'lastpass.com', 'bitwarden.com',
      'dashlane.com', 'keepersecurity.com', 'nordpass.com'
    ]
  },
  {
    category: 'government',
    hosts: [
      'gov.uk', 'service.gov.uk',
      'gov.au', 'my.gov.au', 'ato.gov.au',
      'irs.gov', 'ssa.gov', 'usa.gov'
    ]
  },
  {
    category: 'payment',
    hosts: [
      'stripe.com', 'checkout.stripe.com', 'square.com',
      'checkout.shopify.com'
    ]
  },
  {
    category: 'ai',
    hosts: [
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
      'cursor.com', 'cursor.so'
    ]
  },
  {
    category: 'adult',
    hosts: [
      'pornhub.com', 'xvideos.com', 'xhamster.com',
      'onlyfans.com', 'fansly.com'
    ]
  }
];

export const EXCLUDED_HOSTS = EXCLUDED_HOST_CATEGORIES.flatMap((entry) => entry.hosts);

function parseHostAndPath(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      return {
        host: parsed.hostname.toLowerCase().replace(/^www\./, ''),
        path: parsed.pathname || '/'
      };
    }
  } catch (_) {
    return null;
  }
  const trimmed = raw.toLowerCase().replace(/^www\./, '');
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    return { host: trimmed, path: '/' };
  }
  return {
    host: trimmed.slice(0, slash),
    path: trimmed.slice(slash) || '/'
  };
}

export function matchExcludedHost(url) {
  if (!url) return null;
  const parsed = parseHostAndPath(url);
  if (!parsed?.host) return null;
  const { host, path } = parsed;
  let best = null;
  let bestEntryHostLen = -1;
  for (const { category, hosts } of EXCLUDED_HOST_CATEGORIES) {
    for (const entry of hosts) {
      const [entryHost, ...rest] = entry.split('/');
      const entryPath = rest.length ? '/' + rest.join('/') : null;
      const hostMatch = entryHost === 'local'
        ? (host === 'local' || host.endsWith('.local'))
        : (host === entryHost || host.endsWith('.' + entryHost));
      if (!hostMatch) continue;
      if (entryPath && !path.startsWith(entryPath)) continue;
      if (entryHost.length > bestEntryHostLen) {
        bestEntryHostLen = entryHost.length;
        best = { host: entry, category };
      }
    }
  }
  return best;
}

export function probeUrlForHostname(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').trim().toLowerCase();
  if (!h) return null;
  return h.includes('://') ? h : `https://${h}/`;
}

export function isExcludedHostname(hostname) {
  const probe = probeUrlForHostname(hostname);
  return probe ? !!matchExcludedHost(probe) : false;
}

/** Privacy/AI excluded hosts in the `ai` category — always Neutral, no user prod/unprod override. */
export function isAiExcludedHost(url) {
  const match = matchExcludedHost(url);
  return match?.category === 'ai' ? match : null;
}

/** Host-only segment of a normalized Mode B bank-site pattern (no path/query). */
export function bankSitePatternHostOnly(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return '';
  return p.split('/')[0].split('?')[0].replace(/^www\./, '').toLowerCase();
}

/** AI excluded hosts must be host-only in Mode B lists — per-chat URLs never match other tabs. */
export function shouldCoerceAiBankSiteToHostOnly(rawOrNormalized) {
  const s = String(rawOrNormalized || '').trim();
  if (!s) return false;
  const hostProbe = bankSitePatternHostOnly(s);
  if (!hostProbe) return false;
  return !!isAiExcludedHost(probeUrlForHostname(hostProbe));
}

/** Preserve the user's explicit path/query on Mode B patterns, even for AI
 *  excluded hosts. Previously this stripped paths from AI hosts (e.g.
 *  claude.ai/new → claude.ai) under the assumption that per-chat URLs never
 *  match other tabs. But the user may WANT a specific path (e.g. only earn on
 *  the /new page, not the whole site). Per user report (2026-07): "it's just
 *  giving claude.ai not the claude.ai/new specific url I'm typing." */
export function coerceAiExcludedBankSitePattern(normalizedPattern) {
  return String(normalizedPattern || '').trim();
}

export function hostnameFromPathScoreKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (/^https?:\/\//i.test(k)) {
    try {
      return new URL(k).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
      return '';
    }
  }
  const slash = k.indexOf('/');
  const raw = slash === -1 ? k : k.slice(0, slash);
  return raw.replace(/^www\./, '').toLowerCase();
}

export function filterHostnameKeyedMap(map) {
  if (!map || typeof map !== 'object') return { filtered: {}, removed: 0 };
  const filtered = {};
  let removed = 0;
  for (const [key, val] of Object.entries(map)) {
    if (isExcludedHostname(key)) {
      removed++;
      continue;
    }
    filtered[key] = val;
  }
  return { filtered, removed };
}

export function filterPathScoresMap(pathScores) {
  if (!pathScores || typeof pathScores !== 'object') return { filtered: {}, removed: 0 };
  const filtered = {};
  let removed = 0;
  for (const [key, val] of Object.entries(pathScores)) {
    const host = hostnameFromPathScoreKey(key);
    if (host && isExcludedHostname(host)) {
      removed++;
      continue;
    }
    filtered[key] = val;
  }
  return { filtered, removed };
}

export function filterUrlEngagementBuffer(buffer) {
  if (!buffer || typeof buffer !== 'object') return { filtered: {}, removed: 0 };
  const filtered = {};
  let removed = 0;
  for (const [key, rec] of Object.entries(buffer)) {
    if (!rec || typeof rec !== 'object') continue;
    let host = rec.clean_host || '';
    if (!host) {
      const srcUrl = rec.url
        || (typeof key === 'string' && key.startsWith('http') ? key : null)
        || (rec.cleanUrl && String(rec.cleanUrl).startsWith('http') ? rec.cleanUrl : null);
      if (srcUrl) {
        try {
          host = new URL(srcUrl).hostname.replace(/^www\./, '').toLowerCase();
        } catch (_) { /* ignore */ }
      }
      if (!host && typeof key === 'string') {
        host = hostnameFromPathScoreKey(key);
      }
    }
    if (host && isExcludedHostname(host)) {
      removed++;
      continue;
    }
    filtered[key] = rec;
  }
  return { filtered, removed };
}
