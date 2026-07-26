// global_seed.js — embedded global classifier snapshot (read once at bootstrap)

let cachedSnapshot = null;
let loadPromise = null;

function normalizeTrapHostname(hostname) {
  return String(hostname || '').replace(/^www\./, '').trim().toLowerCase();
}

function trapLookupKeys(hostname, pageUrl) {
  const h = normalizeTrapHostname(hostname);
  const keys = [];
  if (!h) return keys;
  keys.push(h);
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      const host = normalizeTrapHostname(u.hostname);
      const path = (u.pathname || '').replace(/\/$/, '');
      if (path && path !== '/') {
        keys.unshift(`${host}${path}`);
      }
    } catch (_) { /* ignore */ }
  }
  return [...new Set(keys)];
}

export async function loadSnapshot() {
  if (cachedSnapshot) return cachedSnapshot;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const url = chrome.runtime.getURL('global_seed.json');
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status}`);
      }
      const data = await response.json();

      const stored = await chrome.storage.local.get('snapshotVersionCached');
      if (stored.snapshotVersionCached !== data.snapshot_version) {
        await chrome.storage.local.remove([
          'globalDeltaCache',
          'trapPoolCache',
          'trapPoolCacheUpdatedAt'
        ]);
        await chrome.storage.local.set({ snapshotVersionCached: data.snapshot_version });
      }

      cachedSnapshot = {
        snapshot_version: data.snapshot_version,
        snapshot_generated_at: data.snapshot_generated_at,
        traps: data.traps || {},
        global_hostnames: data.global_hostnames || {},
        global_tokens: data.global_tokens || {},
        hostname_tokens: data.hostname_tokens || {}
      };

      console.info('[pf-global] snapshot loaded', {
        version: cachedSnapshot.snapshot_version,
        traps: Object.keys(cachedSnapshot.traps).length,
        hostnames: Object.keys(cachedSnapshot.global_hostnames).length,
        tokens: Object.keys(cachedSnapshot.global_tokens).length,
        scopedHosts: Object.keys(cachedSnapshot.hostname_tokens).length
      });

      return cachedSnapshot;
    } catch (err) {
      console.info('[pf-global] snapshot load failed — falling back to local-only classification');
      cachedSnapshot = null;
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export function getSnapshotTrap(hostname, pageUrl = '') {
  if (!cachedSnapshot?.traps) return null;
  for (const key of trapLookupKeys(hostname, pageUrl)) {
    const hit = cachedSnapshot.traps[key];
    if (hit) return hit;
  }
  return null;
}

export function getSnapshotHostname(hostname) {
  if (!cachedSnapshot?.global_hostnames || !hostname) return null;
  const key = normalizeTrapHostname(hostname);
  const entry = cachedSnapshot.global_hostnames[key];
  return entry || null;
}

export function getSnapshotToken(token) {
  if (!cachedSnapshot?.global_tokens || !token) return null;
  const key = String(token).toLowerCase();
  const entry = cachedSnapshot.global_tokens[key];
  return entry || null;
}

export function getSnapshotHostnameToken(hostname, token) {
  if (!cachedSnapshot?.hostname_tokens) {
    console.debug('[pf-seed-debug] no hostname_tokens in snapshot');
    return null;
  }
  if (!hostname || !token) return null;
  const host = normalizeTrapHostname(hostname);
  const tokens = cachedSnapshot.hostname_tokens[host];
  if (!tokens) {
    if (host === 'youtube.com' || host === 'en.wikipedia.org') {
      console.debug('[pf-seed-debug] expected scoped host missing', {
        host,
        available: Object.keys(cachedSnapshot.hostname_tokens)
      });
    }
    return null;
  }
  return tokens[String(token).toLowerCase()] || null;
}

export function hasHostnameScopedTokens(hostname) {
  if (!cachedSnapshot?.hostname_tokens) return false;
  const host = normalizeTrapHostname(hostname);
  return host in cachedSnapshot.hostname_tokens;
}

export function getSnapshotMetadata() {
  if (!cachedSnapshot) {
    return {
      snapshot_version: null,
      snapshot_generated_at: null,
      traps_count: 0,
      hostnames_count: 0,
      tokens_count: 0,
      scoped_hosts_count: 0
    };
  }
  return {
    snapshot_version: cachedSnapshot.snapshot_version,
    snapshot_generated_at: cachedSnapshot.snapshot_generated_at,
    traps_count: Object.keys(cachedSnapshot.traps || {}).length,
    hostnames_count: Object.keys(cachedSnapshot.global_hostnames || {}).length,
    tokens_count: Object.keys(cachedSnapshot.global_tokens || {}).length,
    scoped_hosts_count: Object.keys(cachedSnapshot.hostname_tokens || {}).length
  };
}
