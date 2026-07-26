/** Layer 2 telemetry URL sanitization — per-site path allowlist + identity stripping. */

import { matchExcludedHost } from './excluded_hosts.js';

/**
 * Hosts that receive rich path + allowlisted query context for the global classifier.
 * Tier 1 — not in Tier 2 shallow lists (rich rules take precedence).
 */
export const FULL_CONTEXT_TELEMETRY_HOSTS = [
  'youtube.com',
  'reddit.com',
  'twitter.com',
  'x.com',
  'medium.com',
  'github.com',
  'wikipedia.org',
  'stackoverflow.com',
  'stackexchange.com',
  'linkedin.com',
  'amazon.com',
  'twitch.tv'
];

/**
 * Tier 2 — shallow path depth of 2 segments (pathname or hash route), no query string.
 * Used when host is not Tier 1 rich and not excluded.
 */
export const TIER2_SHALLOW_PATH_SEGMENT_DEPTH = 2;

export const TIER2_SHALLOW_PATH_CATEGORIES = {
  ecommerce: [
    'ebay.com', 'ebay.co.uk', 'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com',
    'newegg.com', 'aliexpress.com', 'shopify.com', 'costco.com', 'homedepot.com', 'lowes.com'
  ],
  code_repository: [
    'gitlab.com', 'bitbucket.org', 'npmjs.com', 'pypi.org', 'crates.io', 'packagist.org',
    'rubygems.org', 'nuget.org', 'mvnrepository.com', 'hub.docker.com'
  ],
  documentation: [
    'readthedocs.io', 'readthedocs.org', 'developer.mozilla.org', 'mdn.io',
    'docs.python.org', 'kubernetes.io', 'learn.microsoft.com', 'docs.microsoft.com',
    'cloud.google.com', 'developers.google.com', 'developer.apple.com', 'docs.aws.amazon.com',
    'docs.github.com', 'swagger.io', 'postman.com', 'notion.site'
  ]
};

/** Flat export for manifests / audits. */
export const TIER2_SHALLOW_PATH_HOSTS = [
  ...new Set(Object.values(TIER2_SHALLOW_PATH_CATEGORIES).flat())
];

/** Hostname labels that imply docs/API guides → Tier 2 depth. */
const TIER2_HOST_LABEL_PREFIXES = ['docs.', 'developer.', 'developers.', 'api.', 'learn.'];

/**
 * Query keys preserved on default (Tier 2/3) shallow paths — all other params stripped.
 * Tier 1 rich hosts use per-host allowlists instead.
 */
export const GLOBAL_SAFE_PARAMS = ['q', 'k', 'search', 'category', 'sort', 'tab', 'lang', 'page'];

const SEARCH_LIKE_SAFE_PARAMS = new Set(['q', 'k', 'search', 'search_query', 'keywords', 'term']);

/** Query params never collected (sessions, OAuth, tracking cookies, secrets). */
const GLOBAL_DENIED_QUERY_PARAMS = new Set([
  'access_token', 'refresh_token', 'token', 'auth', 'session', 'sessionid', 'session_id',
  'sid', 'ssid', 'password', 'passwd', 'credential', 'code', 'state', 'oauth_token',
  'api_key', 'apikey', 'key', 'secret', 'signature', 'sig', 'hash',
  'user_id', 'userid', 'uid', 'customer_id', 'account_id',
  'fbclid', 'gclid', 'mc_eid', 'igshid', 'igsh', 'si', 'feature', 'app', 'utm_source',
  'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'ref_src', 'ref_url',
  'spm', 'ncid', 'cmpid', 'gi', 'ei', '_ga', '_gl', 'cvid', 'correlator', 'continue',
  'login_hint', 'client_id', 'redirect_uri', 'response_type', 'scope', 'nonce', 'id_token',
  'setlang', 'hl', 'gl', 'pp', 'ecver'
]);

const EMAIL_IN_TEXT = /\S+@\S+\.\S+/;
const SSN_IN_TEXT = /\b\d{3}-\d{2}-\d{4}\b/;

function sanitizeSearchQuery(raw) {
  const s = String(raw || '').trim().slice(0, 120);
  if (!s || s.length < 2) return null;
  if (EMAIL_IN_TEXT.test(s)) return null;
  if (SSN_IN_TEXT.test(s)) return null;
  return s;
}

function safePathSegment(seg, { maxLen = 80 } = {}) {
  const s = String(seg || '').trim();
  if (!s || s.length > maxLen) return null;
  if (/%/.test(s)) return null;
  if (/[<>"'`\\]/.test(s)) return null;
  return s;
}

function sanitizeGenericSafeParam(raw) {
  const s = String(raw || '').trim().slice(0, 80);
  if (!s) return null;
  if (EMAIL_IN_TEXT.test(s) || SSN_IN_TEXT.test(s)) return null;
  if (/\b\d{5,}\b/.test(s)) return null;
  return s;
}

function hashQueryParams(hash) {
  const raw = String(hash || '');
  const idx = raw.indexOf('?');
  if (idx === -1) return null;
  try {
    return new URLSearchParams(raw.slice(idx + 1));
  } catch (_) {
    return null;
  }
}

/** Allowlisted query string for default (shallow) sites — GLOBAL_SAFE_PARAMS only. */
export function buildGlobalSafeQuery(parsed) {
  if (!parsed?.search && !parsed?.hash) return '';
  const filtered = new URLSearchParams();
  const hashParams = hashQueryParams(parsed.hash);

  for (const param of GLOBAL_SAFE_PARAMS) {
    const keyLower = String(param).toLowerCase();
    if (GLOBAL_DENIED_QUERY_PARAMS.has(keyLower)) continue;

    let val = null;
    if (parsed.searchParams?.has(param)) {
      val = parsed.searchParams.get(param);
    } else if (hashParams?.has(param)) {
      val = hashParams.get(param);
    }
    if (val == null) continue;

    if (SEARCH_LIKE_SAFE_PARAMS.has(keyLower)) {
      val = sanitizeSearchQuery(val);
    } else {
      val = sanitizeGenericSafeParam(val);
    }
    if (!val) continue;
    filtered.set(param, val);
  }

  const str = filtered.toString();
  return str ? `?${str}` : '';
}

/**
 * Build ?query from an allowlist only. Drops denied keys and cookie/session params.
 */
function buildAllowlistedQuery(parsed, allowedParams) {
  if (!parsed?.search || !allowedParams?.length) return '';
  const filtered = new URLSearchParams();
  for (const param of allowedParams) {
    const key = String(param).toLowerCase();
    if (GLOBAL_DENIED_QUERY_PARAMS.has(key)) continue;
    if (!parsed.searchParams.has(param)) continue;
    let val = parsed.searchParams.get(param);
    if (val == null) continue;
    if (SEARCH_LIKE_SAFE_PARAMS.has(key)) {
      val = sanitizeSearchQuery(val);
      if (!val) continue;
    } else {
      val = sanitizeGenericSafeParam(val);
      if (!val) continue;
    }
    filtered.set(param, val);
  }
  const str = filtered.toString();
  return str ? `?${str}` : '';
}

function youTubeVideoId(v) {
  const id = String(v || '').trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
}

function youTubePlaylistId(list) {
  const id = String(list || '').trim();
  return /^[a-zA-Z0-9_-]{10,}$/.test(id) ? id.slice(0, 64) : null;
}

function isAmazonTelemetryHost(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  if (/\.amazon\.com$/.test(h)) return true;
  return /^(?:smile\.)?amazon\.(com|co\.uk|de|fr|ca|com\.au|co\.jp|in|es|it|nl|se|pl|com\.mx|com\.br)$/.test(h);
}

function appendAllowlistedQuery(pathBase, parsed, allowedParams) {
  const qs = buildAllowlistedQuery(parsed, allowedParams);
  return qs ? `${pathBase}${qs}` : pathBase;
}

function resolveStackOverflowSafePath(path, parsed, allowedQueryParams) {
  const p = (path || '').toLowerCase();

  const tagged = path.match(/^\/questions\/tagged\/([^/?#]+)/i);
  if (tagged) {
    const tag = safePathSegment(decodeURIComponent(tagged[1]), { maxLen: 64 });
    return tag ? appendAllowlistedQuery(`/questions/tagged/${tag}`, parsed, allowedQueryParams) : null;
  }

  const qMatch = p.match(/^\/questions\/(\d+)/);
  if (qMatch) return `/questions/${qMatch[1]}`;

  if (p === '/questions' || p.startsWith('/questions/')) {
    return appendAllowlistedQuery('/questions', parsed, allowedQueryParams);
  }

  const tagMatch = p.match(/^\/tags\/([^/?#]+)/);
  if (tagMatch) {
    const tag = safePathSegment(decodeURIComponent(tagMatch[1]), { maxLen: 64 });
    return tag ? appendAllowlistedQuery(`/tags/${tag}`, parsed, allowedQueryParams) : null;
  }

  const coll = path.match(/^\/collectives\/([^/?#]+)/i);
  if (coll) {
    const slug = safePathSegment(coll[1], { maxLen: 64 });
    return slug ? `/collectives/${slug}` : null;
  }

  const answerMatch = p.match(/^\/a\/(\d+)/);
  if (answerMatch) return `/a/${answerMatch[1]}`;

  return null;
}

function resolveAmazonSafePath(path, parsed, allowedQueryParams) {
  const pl = (path || '/').toLowerCase();

  if (pl === '/s' || pl.startsWith('/s/')) {
    return appendAllowlistedQuery('/s', parsed, allowedQueryParams);
  }

  const dp = path.match(/^\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (dp) return `/dp/${dp[1].toUpperCase()}`;

  const browse = path.match(/^\/b\/([^/?#]+)/i);
  if (browse) {
    const node = safePathSegment(browse[1], { maxLen: 32 });
    if (!node) return null;
    return appendAllowlistedQuery(`/b/${node}`, parsed, allowedQueryParams);
  }

  const catMatch = path.match(/^\/([a-z0-9-]+)\/?$/i);
  if (catMatch) {
    const seg = safePathSegment(catMatch[1], { maxLen: 48 });
    const skip = new Set(['s', 'dp', 'gp', 'b', 'ap', 'cart', 'login', 'signin', 'hz']);
    if (seg && !skip.has(seg.toLowerCase())) {
      return appendAllowlistedQuery(`/${seg}`, parsed, allowedQueryParams);
    }
  }

  return null;
}

/**
 * Per-host rules: default-deny paths. resolveSafePath(path, parsed) returns path+allowlisted
 * query or null (hostname-only). blockedPaths always strip to hostname-only.
 */
export const DEEP_PATH_ALLOWLIST = {
  'youtube.com': {
    allowedQueryParams: ['v', 'list', 't', 'search_query'],
    blockedPaths: [
      /^\/account/,
      /^\/settings/,
      /^\/feed\/history/,
      /^\/feed\/library/,
      /^\/feed\/subscriptions/,
      /^\/login/,
      /^\/logout/,
      /^\/premium/,
      /^\/paid_memberships/,
      /^\/notifications/,
      /^\/redeem/,
      /^\/profile/
    ],
    resolveSafePath(path, parsed) {
      const pl = (path || '/').toLowerCase();
      const q = buildAllowlistedQuery(parsed, this.allowedQueryParams);

      if (/^\/watch(\/|$)/.test(pl)) {
        const v = youTubeVideoId(parsed.searchParams.get('v'));
        if (v) {
          const list = youTubePlaylistId(parsed.searchParams.get('list'));
          const t = parsed.searchParams.get('t');
          let base = `/watch?v=${v}`;
          if (list) base += `&list=${list}`;
          if (t && /^\d{1,6}(s)?$/.test(String(t).trim())) base += `&t=${String(t).trim()}`;
          return base;
        }
        return q ? `/watch${q}` : '/watch';
      }

      const shortsMatch = path.match(/^\/shorts\/([^/?#]+)/i);
      if (shortsMatch) {
        const id = safePathSegment(shortsMatch[1], { maxLen: 32 });
        return id ? `/shorts/${id}` : '/shorts';
      }

      const handleMatch = path.match(/^\/@([^/?#]+)/i);
      if (handleMatch) {
        const handle = safePathSegment(handleMatch[1], { maxLen: 64 });
        return handle ? `/@${handle}` : null;
      }

      const channelMatch = path.match(/^\/channel\/([^/?#]+)/i);
      if (channelMatch) {
        const id = safePathSegment(channelMatch[1], { maxLen: 64 });
        return id ? `/channel/${id}` : null;
      }

      const cMatch = path.match(/^\/c\/([^/?#]+)/i);
      if (cMatch) {
        const slug = safePathSegment(cMatch[1], { maxLen: 64 });
        return slug ? `/c/${slug}` : null;
      }

      if (/^\/playlist/.test(pl)) {
        const list = youTubePlaylistId(parsed.searchParams.get('list'));
        return list ? `/playlist?list=${list}` : '/playlist';
      }

      if (/^\/results/.test(pl)) {
        const sq = sanitizeSearchQuery(parsed.searchParams.get('search_query'));
        return sq ? `/results?search_query=${encodeURIComponent(sq)}` : '/results';
      }

      return null;
    }
  },
  'reddit.com': {
    allowedQueryParams: ['q'],
    blockedPaths: [
      /^\/u\//,
      /^\/user\//,
      /^\/message/,
      /^\/messages/,
      /^\/settings/,
      /^\/login/,
      /^\/prefs/,
      /^\/account/,
      /^\/submit/,
      /^\/notifications/,
      /^\/wiki\/settings/,
      /^\/api\//,
      /^\/dev\//
    ],
    resolveSafePath(path, parsed) {
      const parts = (path || '/').split('/').filter(Boolean);

      if (parts[0] === 'search' || /^\/search/i.test(path || '')) {
        const q = sanitizeSearchQuery(parsed.searchParams.get('q'));
        return q ? `/search?q=${encodeURIComponent(q)}` : '/search';
      }

      if (parts[0] !== 'r' || !parts[1]) return null;
      const sub = safePathSegment(parts[1], { maxLen: 64 });
      if (!sub || sub === 'users' || sub === 'user') return null;

      if (parts[2] === 'comments' && parts[3]) {
        const postId = safePathSegment(parts[3], { maxLen: 16 });
        if (postId && /^[a-z0-9]+$/i.test(postId)) {
          return `/r/${sub}/comments/${postId}`;
        }
      }

      if (parts.length >= 2) return `/r/${sub}`;
      return null;
    }
  },
  'twitter.com': {
    allowedQueryParams: ['q'],
    blockedPaths: [
      /^\/messages/,
      /^\/notifications/,
      /^\/settings/,
      /^\/i\/account/,
      /^\/i\/flow/,
      /^\/home/,
      /^\/login/,
      /^\/logout/,
      /^\/account/,
      /^\/compose/,
      /^\/intent\/dm/
    ],
    resolveSafePath(path, parsed) {
      if (/^\/search/i.test(path || '')) {
        const q = sanitizeSearchQuery(parsed.searchParams.get('q'));
        return q ? `/search?q=${encodeURIComponent(q)}` : '/search';
      }

      const statusMatch = path.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (statusMatch) {
        const user = safePathSegment(statusMatch[1], { maxLen: 32 });
        const statusId = safePathSegment(statusMatch[2], { maxLen: 32 });
        const reserved = new Set([
          'home', 'search', 'i', 'messages', 'settings', 'notifications',
          'login', 'logout', 'account', 'explore', 'compose'
        ]);
        if (user && statusId && !reserved.has(user.toLowerCase())) {
          return `/${user}/status/${statusId}`;
        }
      }

      const profileMatch = path.match(/^\/([^/]+)\/?$/i);
      if (profileMatch) {
        const user = safePathSegment(profileMatch[1], { maxLen: 32 });
        const reserved = new Set([
          'home', 'search', 'i', 'messages', 'settings', 'notifications',
          'login', 'logout', 'account', 'explore', 'compose', 'intent'
        ]);
        if (user && !reserved.has(user.toLowerCase())) {
          return `/${user}`;
        }
      }

      return null;
    }
  },
  'x.com': {
    allowedQueryParams: ['q'],
    blockedPaths: [
      /^\/messages/,
      /^\/notifications/,
      /^\/settings/,
      /^\/i\/account/,
      /^\/i\/flow/,
      /^\/home/,
      /^\/login/,
      /^\/logout/,
      /^\/account/,
      /^\/compose/,
      /^\/intent\/dm/
    ],
    resolveSafePath(path, parsed) {
      return DEEP_PATH_ALLOWLIST['twitter.com'].resolveSafePath(path, parsed);
    }
  },
  'wikipedia.org': {
    allowedQueryParams: [],
    blockedPaths: [/^\/wiki\/Special:/, /^\/wiki\/User:/, /^\/wiki\/User_talk:/],
    resolveSafePath(path) {
      const m = (path || '').match(/^\/wiki\/([^/]+)/i);
      if (!m) return null;
      const title = safePathSegment(decodeURIComponent(m[1]), { maxLen: 120 });
      return title ? `/wiki/${title}` : null;
    }
  },
  'github.com': {
    allowedQueryParams: [],
    blockedPaths: [
      /^\/settings/,
      /^\/account/,
      /^\/security/,
      /^\/notifications/,
      /^\/sponsors/,
      /^\/billing/,
      /^\/marketplace\/billing/,
      /^\/codespaces/,
      /^\/orgs\/[^/]+\/(settings|billing|security|people)/,
      /^\/apps\/[^/]+\/installations/,
      /^\/enterprises\//,
      /^\/search/,
      /^\/pulls$/,
      /^\/issues$/,
      /^\/watching/,
      /^\/stars/
    ],
    resolveSafePath(path) {
      const parts = (path || '/').split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const org = safePathSegment(parts[0], { maxLen: 64 });
      const repo = safePathSegment(parts[1], { maxLen: 100 });
      if (!org || !repo) return null;
      let base = `/${org}/${repo}`;
      if (parts[2] === 'issues' && parts[3]) {
        const n = safePathSegment(parts[3], { maxLen: 16 });
        if (n && /^\d+$/.test(n)) return `${base}/issues/${n}`;
      }
      if (parts[2] === 'pull' && parts[3]) {
        const n = safePathSegment(parts[3], { maxLen: 16 });
        if (n && /^\d+$/.test(n)) return `${base}/pull/${n}`;
      }
      return base;
    }
  },
  'stackoverflow.com': {
    allowedQueryParams: ['tab', 'sort', 'tags', 'tagged', 'page', 'lang'],
    blockedPaths: [
      /^\/users\//,
      /^\/account/,
      /^\/messages/,
      /^\/login/,
      /^\/signup/,
      /^\/settings/,
      /^\/privacy/
    ],
    resolveSafePath(path, parsed) {
      return resolveStackOverflowSafePath(path, parsed, this.allowedQueryParams);
    }
  },
  'stackexchange.com': {
    allowedQueryParams: ['tab', 'sort', 'tags', 'tagged', 'page', 'lang'],
    blockedPaths: [/^\/users\//, /^\/account/, /^\/login/, /^\/signup/],
    resolveSafePath(path, parsed) {
      return resolveStackOverflowSafePath(path, parsed, this.allowedQueryParams);
    }
  },
  'linkedin.com': {
    allowedQueryParams: ['keywords', 'location', 'q', 'tab', 'sort'],
    blockedPaths: [
      /^\/in\//,
      /^\/profile\//,
      /^\/messaging/,
      /^\/settings/,
      /^\/manage/,
      /^\/u\//,
      /^\/login/,
      /^\/signup/,
      /^\/checkpoint/,
      /^\/psettings/,
      /^\/feed\/update/,
      /^\/analytics/,
      /^\/preload/,
      /^\/notifications/
    ],
    resolveSafePath(path, parsed) {
      const pl = (path || '/').toLowerCase();

      if (/^\/jobs/.test(pl)) {
        if (/^\/jobs\/search/.test(pl) || parsed.searchParams.has('keywords') || parsed.searchParams.has('q')) {
          return appendAllowlistedQuery('/jobs/search', parsed, this.allowedQueryParams);
        }
        return '/jobs';
      }

      if (/^\/learning/.test(pl)) {
        const topic = path.match(/^\/learning\/(?:topics\/)?([^/?#]+)/i);
        if (topic) {
          const slug = safePathSegment(topic[1], { maxLen: 64 });
          return slug ? `/learning/${slug}` : '/learning';
        }
        return '/learning';
      }

      const company = path.match(/^\/company\/([^/?#]+)/i);
      if (company) {
        const slug = safePathSegment(company[1], { maxLen: 64 });
        return slug ? `/company/${slug}` : null;
      }

      const school = path.match(/^\/school\/([^/?#]+)/i);
      if (school) {
        const slug = safePathSegment(school[1], { maxLen: 64 });
        return slug ? `/school/${slug}` : null;
      }

      if (/^\/search\/results/.test(pl)) {
        return appendAllowlistedQuery('/search/results', parsed, this.allowedQueryParams);
      }

      if (/^\/pulse\/topic/.test(pl)) {
        const topic = path.match(/^\/pulse\/topic\/([^/?#]+)/i);
        const slug = topic ? safePathSegment(topic[1], { maxLen: 64 }) : null;
        return slug ? `/pulse/topic/${slug}` : '/pulse/topic';
      }

      return null;
    }
  },
  'amazon.com': {
    allowedQueryParams: ['k', 'i', 'node', 'rh', 'page', 'language', 'sort'],
    blockedPaths: [
      /^\/ap\//,
      /^\/gp\/css/,
      /^\/your-account/,
      /^\/account/,
      /^\/cart/,
      /^\/checkout/,
      /^\/order/,
      /^\/hz\/contact/,
      /^\/signin/,
      /^\/login/,
      /^\/gp\/profile/,
      /^\/gp\/wishlist/,
      /^\/gp\/registry/,
      /^\/gp\/browse\.html/,
      /^\/addresses/,
      /^\/payments/
    ],
    resolveSafePath(path, parsed) {
      return resolveAmazonSafePath(path, parsed, this.allowedQueryParams);
    }
  },
  'twitch.tv': {
    allowedQueryParams: ['term', 'q', 'sort', 'lang', 'page'],
    blockedPaths: [
      /^\/settings/,
      /^\/messages/,
      /^\/dashboard/,
      /^\/inventory/,
      /^\/wallet/,
      /^\/subs/,
      /^\/login/,
      /^\/signup/,
      /^\/moderator/,
      /^\/u\//,
      /^\/user\//,
      /^\/preferences/,
      /^\/password/
    ],
    resolveSafePath(path, parsed) {
      const parts = (path || '/').split('/').filter(Boolean);

      if (parts[0] === 'directory') {
        if (parts[1] === 'game' && parts[2]) {
          const game = safePathSegment(decodeURIComponent(parts[2]), { maxLen: 64 });
          return game ? `/directory/game/${game}` : '/directory/game';
        }
        if (parts[1] === 'category' && parts[2]) {
          const cat = safePathSegment(decodeURIComponent(parts[2]), { maxLen: 64 });
          return cat ? `/directory/category/${cat}` : '/directory/category';
        }
        return appendAllowlistedQuery('/directory', parsed, this.allowedQueryParams);
      }

      if (parts[0] === 'videos' && parts[1]) {
        const id = safePathSegment(parts[1], { maxLen: 32 });
        return id ? `/videos/${id}` : null;
      }

      if (parts[0] === 'clips') {
        if (parts[1]) {
          const slug = safePathSegment(parts[1], { maxLen: 64 });
          return slug ? `/clips/${slug}` : '/clips';
        }
        return '/clips';
      }

      if (parts[0] === 'collections' && parts[1]) {
        const slug = safePathSegment(parts[1], { maxLen: 64 });
        return slug ? `/collections/${slug}` : null;
      }

      return null;
    }
  },
  'medium.com': {
    allowedQueryParams: [],
    blockedPaths: [/^\/me/, /^\/settings/, /\/settings$/, /^\/m\/signin/],
    resolveSafePath(path) {
      const authorArticle = path.match(/^\/@([^/]+)\/([^/?#]+)/i);
      if (authorArticle) {
        const author = safePathSegment(authorArticle[1], { maxLen: 64 });
        const slug = safePathSegment(authorArticle[2], { maxLen: 120 });
        if (author && slug) return `/@${author}/${slug}`;
      }
      const pubArticle = path.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)/i);
      if (pubArticle) {
        const pub = safePathSegment(pubArticle[1], { maxLen: 64 });
        const slug = safePathSegment(pubArticle[2], { maxLen: 120 });
        if (pub && slug && pub !== 'me') return `/${pub}/${slug}`;
      }
      return null;
    }
  }
};

export function isFullContextTelemetryHost(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  if (isAmazonTelemetryHost(h)) return true;
  return FULL_CONTEXT_TELEMETRY_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * Default (Tier 3) path depth: first segment only.
 * Tier 2 hosts use TIER2_SHALLOW_PATH_SEGMENT_DEPTH (2).
 * Shallow tiers append GLOBAL_SAFE_PARAMS query keys only.
 */
export const DEFAULT_SHALLOW_PATH_SEGMENTS = 1;

function hostMatchesTelemetryDomain(hostname, domain) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/** Tier 2: two path segments for ecommerce, package repos, and documentation hosts. */
export function isTier2ShallowPathHost(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  if (!h || isFullContextTelemetryHost(h)) return false;
  if (TIER2_HOST_LABEL_PREFIXES.some((prefix) => h.startsWith(prefix))) return true;
  for (const hosts of Object.values(TIER2_SHALLOW_PATH_CATEGORIES)) {
    if (hosts.some((domain) => hostMatchesTelemetryDomain(h, domain))) return true;
  }
  return false;
}

export function resolveShallowPathDepth(hostname) {
  if (isTier2ShallowPathHost(hostname)) return TIER2_SHALLOW_PATH_SEGMENT_DEPTH;
  return DEFAULT_SHALLOW_PATH_SEGMENTS;
}

/** Common locale roots — skipped so /en/blog → /blog; lone /en → hostname-only. */
const LOCALE_PATH_PREFIXES = new Set([
  'en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'it', 'nl', 'pl', 'ru', 'ar',
  'hi', 'tr', 'vi', 'th', 'id', 'cs', 'sv', 'da', 'fi', 'no', 'he', 'uk', 'br',
  'cn', 'tw', 'hk', 'mx', 'ca', 'au', 'gb', 'us'
]);

const STATIC_INDEX_SEGMENTS = new Set([
  'index.html', 'index.htm', 'index.php', 'default.aspx', 'default.html'
]);

function isLocalePathSegment(seg) {
  const s = String(seg || '').toLowerCase();
  if (!s) return false;
  if (LOCALE_PATH_PREFIXES.has(s)) return true;
  const m = s.match(/^([a-z]{2})-([a-z]{2})$/);
  return !!(m && LOCALE_PATH_PREFIXES.has(m[1]));
}

function isStaticIndexSegment(seg) {
  return STATIC_INDEX_SEGMENTS.has(String(seg || '').toLowerCase());
}

/** Collapse duplicate slashes and trailing slash; bare root → '/' */
export function normalizePathnameForTelemetry(pathname) {
  const raw = String(pathname || '/').trim();
  if (!raw || raw === '/') return '/';
  const collapsed = raw.replace(/\/+/g, '/');
  const trimmed = collapsed.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Path-only string safe for storage keys — never '/', never trailing slash. */
export function normalizeCleanPath(cleanPath) {
  const raw = String(cleanPath || '').trim();
  if (!raw || raw === '/') return '';
  const pathOnly = raw.split('?')[0].split('#')[0];
  const normalized = normalizePathnameForTelemetry(pathOnly);
  if (normalized === '/') return '';
  return normalized;
}

/** Stable chrome.storage / Supabase key: host or host/path (no trailing slash on path). */
export function formatTelemetryStorageKey(hostname, cleanPath) {
  const host = String(hostname || '').replace(/^www\./, '').toLowerCase().trim();
  if (!host) return '';
  const raw = String(cleanPath || '').trim();
  if (!raw) return host;
  const qIndex = raw.indexOf('?');
  const pathPart = normalizeCleanPath(qIndex === -1 ? raw : raw.slice(0, qIndex));
  const queryPart = qIndex === -1 ? '' : raw.slice(qIndex);
  if (!pathPart) return queryPart ? `${host}${queryPart}` : host;
  return `${host}${pathPart}${queryPart}`;
}

function shallowPathFromPathname(pathname, maxSegments = DEFAULT_SHALLOW_PATH_SEGMENTS) {
  let segments = normalizePathnameForTelemetry(pathname).split('/').filter(Boolean);
  if (!segments.length) return '';

  if (segments.length === 1 && isLocalePathSegment(segments[0])) return '';
  if (segments.length > 1 && isLocalePathSegment(segments[0])) {
    segments = segments.slice(1);
  }
  if (!segments.length) return '';
  if (segments.length === 1 && isStaticIndexSegment(segments[0])) return '';

  segments = segments.slice(0, maxSegments);
  const safe = segments
    .map((seg) => safePathSegment(seg, { maxLen: 64 }))
    .filter(Boolean);
  if (!safe.length) return '';
  return normalizeCleanPath(`/${safe.join('/')}`);
}

function isRootPathname(pathname) {
  return normalizePathnameForTelemetry(pathname || '/') === '/';
}

/** SPA hash routes: #/analytics/reports → virtual pathname /analytics/reports (query stripped). */
function hashToVirtualPathname(hash) {
  const raw = String(hash || '').trim();
  if (!raw || raw === '#') return '/';
  let route = raw.replace(/^#/, '').trim();
  if (!route) return '/';
  route = route.split('?')[0].split('&')[0];
  if (!route.startsWith('/')) route = `/${route}`;
  return normalizePathnameForTelemetry(route);
}

/**
 * Shallow path for non–Tier 1 hosts: pathname (and hash when root-only),
 * plus GLOBAL_SAFE_PARAMS on the query string.
 */
function appendGlobalSafeParamsToShallowPath(pathOnly, parsed) {
  const safeQuery = buildGlobalSafeQuery(parsed);
  if (!pathOnly) return safeQuery ? safeQuery : '';
  return `${pathOnly}${safeQuery}`;
}

function shallowPathForDefaultSite(parsed) {
  const depth = resolveShallowPathDepth(parsed.hostname);
  let pathOnly = shallowPathFromPathname(parsed.pathname || '/', depth);
  if (!pathOnly) {
    if (!isRootPathname(parsed.pathname)) {
      return appendGlobalSafeParamsToShallowPath('', parsed);
    }
    const hash = String(parsed.hash || '').trim();
    if (!hash || hash === '#') return '';
    const virtualPath = hashToVirtualPathname(hash);
    pathOnly = shallowPathFromPathname(virtualPath, depth);
  }
  return appendGlobalSafeParamsToShallowPath(pathOnly, parsed);
}

function telemetryResult(hostname, cleanPath) {
  const host = String(hostname || '').replace(/^www\./, '').toLowerCase().trim();
  const raw = String(cleanPath || '').trim();
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex === -1 ? normalizeCleanPath(raw) : normalizeCleanPath(raw.slice(0, qIndex));
  const queryPart = qIndex === -1 ? '' : raw.slice(qIndex);
  const finalPath = pathPart ? `${pathPart}${queryPart}` : queryPart;
  return {
    hostname: host,
    cleanPath: finalPath,
    cleanUrl: formatTelemetryStorageKey(host, finalPath)
  };
}

function findAllowlistEntry(hostname) {
  const h = String(hostname || '').replace(/^www\./, '').toLowerCase();
  if (isAmazonTelemetryHost(h)) {
    return { key: 'amazon.com', rule: DEEP_PATH_ALLOWLIST['amazon.com'] };
  }
  const matchedKey = Object.keys(DEEP_PATH_ALLOWLIST).find((domain) =>
    h === domain || h.endsWith('.' + domain)
  );
  return matchedKey ? { key: matchedKey, rule: DEEP_PATH_ALLOWLIST[matchedKey] } : null;
}

/**
 * Sanitize a URL for Layer 2 telemetry push.
 * Returns { hostname, cleanPath, cleanUrl } or null if excluded / invalid.
 * Cookies are never read. Hash fragments are read only for default sites when pathname is /.
 */
export function sanitizeUrlForTelemetry(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  if (!rawUrl.startsWith('http')) return null;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return null;
  }

  const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();

  const excluded = matchExcludedHost(rawUrl);
  if (excluded) {
    console.info('[pf-privacy-strip] excluded host, no telemetry', {
      hostname,
      category: excluded.category
    });
    return null;
  }

  const match = findAllowlistEntry(hostname);
  const path = normalizePathnameForTelemetry(parsed.pathname || '/');

  if (!match) {
    const shallow = shallowPathForDefaultSite(parsed);
    const tier = isTier2ShallowPathHost(hostname) ? 2 : 3;
    console.info('[pf-privacy-strip] shallow path (default)', {
      hostname,
      tier,
      depth: resolveShallowPathDepth(hostname),
      cleanPath: shallow || '(hostname-only)',
      hashRoute: isRootPathname(parsed.pathname) && parsed.hash ? true : false
    });
    return telemetryResult(hostname, shallow);
  }

  const { rule: entry } = match;

  if (entry.blockedPaths?.some((re) => re.test(path))) {
    console.info('[pf-privacy-strip] blocked path, hostname-only', {
      hostname,
      path
    });
    return telemetryResult(hostname, '');
  }

  const safePath = entry.resolveSafePath?.(path, parsed);
  if (!safePath) {
    const depth = resolveShallowPathDepth(hostname);
    let shallow = shallowPathFromPathname(path, depth);
    if (!shallow && isRootPathname(parsed.pathname) && parsed.hash) {
      shallow = shallowPathFromPathname(hashToVirtualPathname(parsed.hash), depth);
    }
    shallow = appendGlobalSafeParamsToShallowPath(shallow, parsed);
    console.info('[pf-privacy-strip] shallow path (no rich rule match)', {
      hostname,
      depth,
      cleanPath: shallow || '(hostname-only)'
    });
    return telemetryResult(hostname, shallow);
  }

  console.info('[pf-privacy-strip] deep path allowed', {
    hostname,
    cleanPath: safePath
  });

  return telemetryResult(hostname, safePath);
}

function probeUrlFromPathScoreKey(pathKey) {
  const k = String(pathKey || '').trim();
  if (!k) return null;
  if (/^https?:\/\//i.test(k)) return k;
  const slash = k.indexOf('/');
  if (slash === -1) return `https://${k.replace(/^www\./, '')}/`;
  const host = k.slice(0, slash).replace(/^www\./, '');
  const path = k.slice(slash);
  return `https://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

function isBlockedTelemetryPath(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) return true;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return true;
  }
  const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const match = findAllowlistEntry(hostname);
  if (!match) return false;
  const path = parsed.pathname || '/';
  if (match.rule.blockedPaths?.some((re) => re.test(path))) return true;
  if (match.rule.resolveSafePath?.(path, parsed)) return false;
  return false;
}

/**
 * Path-score keys allowed for a URL — mirrors Layer 2 telemetry path policy.
 * Blocked account/settings paths return [] (no path_scores writes).
 */
export function getPathScoreKeysForUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) return [];
  if (isBlockedTelemetryPath(rawUrl)) {
    let hostname = '';
    try {
      hostname = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) { /* ignore */ }
    console.info('[pf-path-score] skip — blocked path', { hostname, url: rawUrl });
    return [];
  }

  const sanitized = sanitizeUrlForTelemetry(rawUrl);
  if (!sanitized) return [];

  const keys = [sanitized.hostname];
  if (!sanitized.cleanPath) return keys;

  const storageKey = formatTelemetryStorageKey(sanitized.hostname, sanitized.cleanPath);
  if (storageKey !== sanitized.hostname) {
    keys.push(storageKey);
  }

  const pathOnly = sanitized.cleanPath.split('?')[0];
  const segments = normalizeCleanPath(pathOnly).replace(/^\//, '').split('/').filter(Boolean);
  let acc = sanitized.hostname;
  for (let i = 0; i < Math.min(segments.length, 10); i++) {
    acc += `/${segments[i]}`;
    if (!keys.includes(acc)) keys.push(acc);
  }
  return keys;
}

/** True if an existing path_scores storage key may be kept or synced. */
export function isPathScoreKeyStorable(pathKey) {
  const probe = probeUrlFromPathScoreKey(pathKey);
  if (!probe) return false;
  if (isBlockedTelemetryPath(probe)) return false;

  const sanitized = sanitizeUrlForTelemetry(probe);
  if (!sanitized) return false;

  const keyNorm = String(pathKey || '').trim().toLowerCase().replace(/^www\./, '');
  const allowedKeys = getPathScoreKeysForUrl(probe);
  return allowedKeys.includes(keyNorm);
}

export function filterPathScoresForPrivacy(pathScores) {
  if (!pathScores || typeof pathScores !== 'object') return { filtered: {}, removed: 0 };
  const filtered = {};
  let removed = 0;
  for (const [key, val] of Object.entries(pathScores)) {
    if (isPathScoreKeyStorable(key)) {
      filtered[key] = val;
    } else {
      removed++;
    }
  }
  return { filtered, removed };
}
