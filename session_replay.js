/**
 * session_replay.js — masked PostHog session replay for the dashboard.
 *
 * WHY THE MASKING IS NOT OPTIONAL
 * The page this records is stats.html, which puts the user's real browsing on
 * screen: hostnames, per-site times, window names, their display name and
 * email. PRIVACY.md promises that data never leaves the device. An unmasked
 * recording would ship all of it to PostHog and make that promise false.
 *
 * So this runs in maximum-mask mode:
 *   • maskAllInputs      — every field value becomes asterisks
 *   • maskTextSelector '*' — EVERY text node is masked, not just inputs
 *   • .ph-no-capture on the panels that render hostnames, so those subtrees
 *     are blocked wholesale rather than merely text-masked
 * What survives is layout, clicks, scrolls, rage-clicks and navigation —
 * where people get stuck — with no readable content. That is the whole point:
 * find the dead ends in onboarding without collecting browsing history.
 *
 * If you ever relax a mask here, update PRIVACY.md in the same commit.
 *
 * Gating, in order: the vendor bundle must exist, analytics must not be
 * opted out, and the install must not be bot-flagged. Same switches as
 * analytics.js, so the one "Send anonymous product analytics" toggle in User
 * Settings turns replay off too.
 */
import posthog from './vendor/posthog.js';

const PF_PH_KEY = 'phc_BrxiwatUaghrGAPGGWY5LwUeEaBH5aPbinKgtxnBvEHR';
const PF_PH_HOST = 'https://eu.i.posthog.com';

/** Subtrees that must never be recorded, even masked. */
const PF_BLOCKED_SELECTORS = [
  '#pvuWeekNavWrap',        // productive-vs-unproductive chart (hostnames)
  '#siteTimeSection',       // per-site time list
  '#topTenList',            // most-used sites
  '#pfProfileModal',        // settings drawer: display name + email
  '#startupSlotsList',      // saved startup URLs
  '.pf-recap-modal',        // Wrapped cards embed site names
  '#bankSourceSitesInput',  // earn/spend host chips
  '#pfBankedList'
];

async function pfReplayAllowed() {
  try {
    const { pfAnalyticsOptOut, pfBotSuspect } = await chrome.storage.local.get([
      'pfAnalyticsOptOut', 'pfBotSuspect'
    ]);
    if (pfAnalyticsOptOut === true) return false;
    if (pfBotSuspect === true) return false;
    return true;
  } catch (_) {
    return false; // fail closed — never record when the switch is unreadable
  }
}

/** Random per-install id, reused from analytics.js so the two line up. */
async function pfAnonId() {
  try {
    const { pfAnonId: id } = await chrome.storage.local.get('pfAnonId');
    return id || null;
  } catch (_) { return null; }
}

export async function initSessionReplay() {
  if (!(await pfReplayAllowed())) {
    console.info('[pf-replay] disabled (opted out, bot-flagged, or unreadable)');
    return;
  }
  const distinctId = await pfAnonId();
  try {
    posthog.init(PF_PH_KEY, {
      api_host: PF_PH_HOST,
      // Events already ship via analytics.js's own batched sender, which
      // enforces the event + property allowlists. Letting posthog-js capture
      // as well would bypass that entirely and start sending $pageview,
      // $autocapture and element text.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_surveys: true,
      // Never let the SDK invent its own id — it must be the same random
      // install UUID analytics.js uses, and nothing account-derived.
      bootstrap: distinctId ? { distinctID: distinctId } : undefined,
      persistence: 'memory', // no cookies / localStorage writes on the page
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*',
        blockSelector: PF_BLOCKED_SELECTORS.join(','),
        // Network payloads would carry Supabase responses (email, ids).
        recordHeaders: false,
        recordBody: false,
        recordCrossOriginIframes: false
      }
    });
    if (distinctId) posthog.identify(distinctId);
    posthog.startSessionRecording?.();
    console.info('[pf-replay] started (masked)');
  } catch (e) {
    // Replay is diagnostics. It must never take the dashboard down with it.
    console.warn('[pf-replay] init failed', e);
  }
}

/** Stop and forget — called when the user opts out at runtime. */
export function stopSessionReplay() {
  try {
    posthog.stopSessionRecording?.();
    posthog.opt_out_capturing?.();
  } catch (_) { /* best-effort */ }
}
