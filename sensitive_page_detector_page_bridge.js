/**
 * Page-world bridge for sensitive detector (loaded via extension URL — survives strict CSP).
 */
(function () {
  if (window.__pfSensitiveBridgeInstalled) return;
  window.__pfSensitiveBridgeInstalled = true;

  function readResult() {
    var el = document.getElementById('__pf_sensitive_detector_result');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || 'null');
    } catch (e) {
      return null;
    }
  }

  window.pfSensitiveDetectorPing = function () {
    return document.documentElement.getAttribute('data-pf-sensitive-detector-loaded') === '1';
  };

  window.pfSensitiveDetectorDryRun = function () {
    document.dispatchEvent(new CustomEvent('pf-sensitive-detector-dry-run-request', {
      bubbles: true,
      composed: true
    }));
    var start = Date.now();
    var r = null;
    while (Date.now() - start < 800) {
      r = readResult();
      if (r && r.requestId) break;
    }
    if (!r) {
      console.warn('[pf-sensitive-dry-run] no result yet — content script still loading?');
      return readResult();
    }
    console.info('[pf-sensitive-dry-run] wouldSkip:', r.wouldSkip,
      'category:', r.category, 'reason:', r.reason, 'score:', r.score, 'dryRun:', r.dryRun);
    if (r.breakdown && r.breakdown.length) console.table(r.breakdown);
    return r;
  };
})();
