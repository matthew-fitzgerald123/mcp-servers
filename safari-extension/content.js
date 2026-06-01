// Runs on job listing and application pages.
// - Auto-captures when user clicks a submit/apply button
// - Responds to popup requests for manual one-click capture

(function () {
  if (window.__jobTrackerLoaded) return;
  window.__jobTrackerLoaded = true;

  const host = window.location.hostname;
  const href = window.location.href;

  // ── Extraction ─────────────────────────────────────────────────────────────

  function q(sel, root = document) {
    return root.querySelector(sel)?.innerText?.trim() || null;
  }
  function meta(name) {
    return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
      ?.getAttribute('content')?.trim() || null;
  }

  function extract() {
    if (host.includes('linkedin.com'))    return extractLinkedIn();
    if (host.includes('greenhouse.io'))   return extractGreenhouse();
    if (host.includes('lever.co'))        return extractLever();
    if (host.includes('ashbyhq.com') || host.includes('ashby.io')) return extractAshby();
    if (host.includes('workday') || host.includes('myworkdayjobs')) return extractWorkday();
    if (host.includes('workable.com'))    return extractWorkable();
    if (host.includes('smartrecruiters')) return extractSmartRecruiters();
    return extractGeneric();
  }

  function extractLinkedIn() {
    return {
      role:    q('.job-details-jobs-unified-top-card__job-title h1') ?? q('.jobs-unified-top-card__job-title h1') ?? q('h1.t-24'),
      company: q('.job-details-jobs-unified-top-card__company-name a') ?? q('.jobs-unified-top-card__company-name a'),
      location:q('.tvm__text--low-emphasis') ?? null,
      source: 'linkedin',
    };
  }

  function extractGreenhouse() {
    const slug = location.pathname.split('/').find((p, i, a) => a[i-1] === '' || a[i-1] === undefined);
    return {
      role:     q('.app-title') ?? q('h1.job-title') ?? q('h1'),
      company:  q('.company-name') ?? (slug ? decodeURIComponent(slug).replace(/-/g,' ') : null),
      location: q('.location') ?? null,
      source:   'greenhouse',
    };
  }

  function extractLever() {
    const slug = location.pathname.split('/')[1];
    return {
      role:     q('.posting-headline h2') ?? q('h2') ?? q('h1'),
      company:  q('[class*="company"]') ?? (slug ? decodeURIComponent(slug).replace(/-/g,' ') : null),
      location: q('.sort-by-time.posting-category-title') ?? q('[class*="location"]'),
      source:   'lever',
    };
  }

  function extractAshby() {
    const slug = location.pathname.split('/')[1];
    return {
      role:     q('[data-testid="job-title"]') ?? q('h1'),
      company:  q('[data-testid="organization-name"]') ?? (slug ? decodeURIComponent(slug).replace(/-/g,' ') : null),
      location: q('[data-testid="job-location"]') ?? null,
      source:   'ashby',
    };
  }

  function extractWorkday() {
    return {
      role:     q('[data-automation-id="jobPostingHeader"]') ?? q('h2') ?? q('h1'),
      company:  meta('og:site_name') ?? q('[data-automation-id="company-name"]'),
      location: q('[data-automation-id="locations"]') ?? null,
      source:   'workday',
    };
  }

  function extractWorkable() {
    const slug = location.pathname.split('/')[1];
    return {
      role:     q('[data-ui="job-title"]') ?? q('h1'),
      company:  q('[data-ui="company-name"]') ?? (slug ? decodeURIComponent(slug).replace(/-/g,' ') : null),
      location: q('[data-ui="job-location"]') ?? null,
      source:   'workable',
    };
  }

  function extractSmartRecruiters() {
    return {
      role:     q('.job-title') ?? q('h1'),
      company:  q('.company-name') ?? meta('og:site_name'),
      location: q('.job-location') ?? null,
      source:   'smartrecruiters',
    };
  }

  function extractGeneric() {
    const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(el => { try { return JSON.parse(el.textContent); } catch { return null; } })
      .find(d => d?.['@type'] === 'JobPosting');
    if (ld) return {
      role:     ld.title,
      company:  ld.hiringOrganization?.name,
      location: ld.jobLocation?.address?.addressLocality ?? null,
      source:   'company_site',
    };
    return {
      role:     meta('og:title') ?? q('h1') ?? document.title,
      company:  meta('og:site_name'),
      location: null,
      source:   'company_site',
    };
  }

  // ── Submit detection ───────────────────────────────────────────────────────

  // Phrases that indicate "submit my application" (not just "next step")
  const SUBMIT_PHRASES = [
    'submit application', 'submit my application', 'submit your application',
    'apply now', 'apply for this job', 'apply for this position',
    'complete application', 'send application', 'send my application',
    'easy apply', 'quick apply', 'one-click apply',
  ];

  function looksLikeSubmit(el) {
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
    return SUBMIT_PHRASES.some(p => text.includes(p));
  }

  let captured = false;

  document.addEventListener('click', (e) => {
    if (captured) return;
    const el = e.target.closest('button, [role="button"], input[type="submit"], a[class*="apply"]');
    if (!el || !looksLikeSubmit(el)) return;

    const details = extract();
    if (!details?.company && !details?.role) return; // nothing useful extracted

    captured = true; // only capture once per page load
    sendCapture(details, true);
  }, true);

  // ── Capture ────────────────────────────────────────────────────────────────

  function sendCapture(details, auto = false) {
    const payload = {
      company:  details.company,
      role:     details.role,
      location: details.location,
      job_url:  href,
      source:   details.source ?? 'company_site',
      status:   'applied',
    };
    // Route through background service worker — content scripts can't
    // reach localhost directly in Safari due to CSP restrictions.
    chrome.runtime.sendMessage({ type: 'CAPTURE', payload }, (res) => {
      if (chrome.runtime.lastError) {
        if (!auto) showToast('Extension error: ' + chrome.runtime.lastError.message, true);
        return;
      }
      if (res?.ok) showToast(auto ? `Captured: ${res.company}` : `Saved: ${res.company}`);
      else if (!auto) showToast('Capture server not running — check Terminal', true);
    });
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  function showToast(msg, isError = false) {
    const existing = document.getElementById('__jt_toast');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = '__jt_toast';
    el.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
      `background:${isError ? '#b31a1a' : '#0a66c2'}`, 'color:#fff',
      'padding:12px 16px', 'border-radius:10px', 'font-size:14px',
      'font-family:-apple-system,sans-serif', 'font-weight:500',
      'box-shadow:0 4px 16px rgba(0,0,0,0.25)', 'max-width:280px',
      'line-height:1.4', 'transition:opacity 0.3s',
    ].join(';');
    el.textContent = '💼 ' + msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2800);
  }

  // ── Popup communication ────────────────────────────────────────────────────

  window.__jobTrackerCapture = { ...extract(), job_url: href };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'GET_JOB_DETAILS') {
      reply(window.__jobTrackerCapture);
    }
    if (msg.type === 'CAPTURE_NOW') {
      sendCapture(window.__jobTrackerCapture, false).then(() => reply({ ok: true }));
      return true;
    }
  });
})();
