// Runs on job listing pages. Extracts structured job data and makes it
// available to the popup via chrome.runtime.sendMessage.

(function () {
  const host = window.location.hostname;
  const href = window.location.href;

  function text(selector, root = document) {
    return root.querySelector(selector)?.innerText?.trim() ?? null;
  }
  function attr(selector, attribute, root = document) {
    return root.querySelector(selector)?.getAttribute(attribute)?.trim() ?? null;
  }
  function meta(name) {
    return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
      ?.getAttribute('content')?.trim() ?? null;
  }

  // ── LinkedIn ───────────────────────────────────────────────────────────────
  function extractLinkedIn() {
    const role    = text('.job-details-jobs-unified-top-card__job-title h1')
                 ?? text('.jobs-unified-top-card__job-title h1')
                 ?? text('h1.t-24');
    const company = text('.job-details-jobs-unified-top-card__company-name a')
                 ?? text('.jobs-unified-top-card__company-name a')
                 ?? text('.topcard__org-name-link');
    const location = text('.job-details-jobs-unified-top-card__primary-description-without-modal .tvm__text')
                  ?? text('.jobs-unified-top-card__subtitle-primary-grouping .tvm__text');
    return { role, company, location, source: 'linkedin' };
  }

  // ── Greenhouse ─────────────────────────────────────────────────────────────
  function extractGreenhouse() {
    const role    = text('.app-title') ?? text('h1.job-title') ?? text('h1');
    // Company name often in the page title or URL: boards.greenhouse.io/COMPANY/jobs/ID
    const urlParts = window.location.pathname.split('/');
    const company  = text('.company-name')
                  ?? (urlParts.length >= 2 ? decodeURIComponent(urlParts[1]).replace(/-/g, ' ') : null);
    const location = text('.location') ?? text('[class*="location"]');
    return { role, company, location, source: 'greenhouse' };
  }

  // ── Lever ──────────────────────────────────────────────────────────────────
  function extractLever() {
    const role    = text('.posting-headline h2') ?? text('h2') ?? text('h1');
    // URL: jobs.lever.co/COMPANY/JOB-ID
    const urlParts = window.location.pathname.split('/');
    const company  = text('.main-header-text .posting-category-title')
                  ?? (urlParts.length >= 2 ? decodeURIComponent(urlParts[1]).replace(/-/g, ' ') : null);
    const location = text('.posting-category.location .posting-category-title')
                  ?? text('[class*="location"]');
    return { role, company, location, source: 'lever' };
  }

  // ── Ashby ──────────────────────────────────────────────────────────────────
  function extractAshby() {
    const role    = text('h1') ?? text('[data-testid="job-title"]');
    const urlParts = window.location.pathname.split('/');
    const company  = text('[data-testid="organization-name"]')
                  ?? (urlParts.length >= 2 ? decodeURIComponent(urlParts[1]).replace(/-/g, ' ') : null);
    const location = text('[data-testid="job-location"]') ?? text('[class*="location"]');
    return { role, company, location, source: 'ashby' };
  }

  // ── Workday ────────────────────────────────────────────────────────────────
  function extractWorkday() {
    const role    = text('[data-automation-id="jobPostingHeader"]') ?? text('h2') ?? text('h1');
    const company = meta('og:site_name') ?? text('[data-automation-id="company-name"]');
    const location = text('[data-automation-id="locations"]') ?? text('[class*="location"]');
    return { role, company, location, source: 'workday' };
  }

  // ── Workable ───────────────────────────────────────────────────────────────
  function extractWorkable() {
    const role    = text('[data-ui="job-title"]') ?? text('h1');
    const urlParts = window.location.pathname.split('/');
    const company  = text('[data-ui="company-name"]')
                  ?? (urlParts.length >= 2 ? decodeURIComponent(urlParts[1]).replace(/-/g, ' ') : null);
    const location = text('[data-ui="job-location"]') ?? text('[class*="location"]');
    return { role, company, location, source: 'workable' };
  }

  // ── Generic fallback ───────────────────────────────────────────────────────
  function extractGeneric() {
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(el => { try { return JSON.parse(el.textContent); } catch { return null; } })
      .find(d => d?.['@type'] === 'JobPosting');

    if (jsonLd) {
      return {
        role:     jsonLd.title,
        company:  jsonLd.hiringOrganization?.name,
        location: typeof jsonLd.jobLocation === 'object'
          ? jsonLd.jobLocation?.address?.addressLocality
          : null,
        source: 'company_site',
      };
    }

    return {
      role:     meta('og:title') ?? text('h1') ?? document.title,
      company:  meta('og:site_name'),
      location: null,
      source:   'company_site',
    };
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  function extract() {
    if (host.includes('linkedin.com'))    return extractLinkedIn();
    if (host.includes('greenhouse.io'))   return extractGreenhouse();
    if (host.includes('lever.co'))        return extractLever();
    if (host.includes('ashbyhq.com') || host.includes('ashby.io')) return extractAshby();
    if (host.includes('workday') || host.includes('myworkdayjobs')) return extractWorkday();
    if (host.includes('workable.com'))    return extractWorkable();
    return extractGeneric();
  }

  // Store results so the popup can request them
  const result = extract();
  window.__jobTrackerCapture = {
    ...result,
    job_url: href,
    extractedAt: Date.now(),
  };

  // Also listen for popup requests
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_JOB_DETAILS') {
      sendResponse(window.__jobTrackerCapture ?? { error: 'Could not extract job details' });
    }
    return true;
  });
})();
