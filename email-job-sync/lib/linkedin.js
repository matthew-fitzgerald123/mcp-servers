import { load } from 'cheerio';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractJobId(url) {
  const m = url.match(/\/jobs\/view\/(\d+)/);
  return m?.[1] ?? null;
}

/**
 * Fetch structured job details from LinkedIn's guest API.
 * Returns null if the posting is unavailable or the ID can't be parsed.
 */
export async function fetchJobDetails(jobUrl) {
  const jobId = extractJobId(jobUrl);
  if (!jobId) return null;

  let html;
  try {
    const res = await fetch(
      `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
      { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const $ = load(html);
  const details = {};

  const title = $('h2.top-card-layout__title, h1').first().text().trim();
  if (title) details.title = title;

  const company = $('.top-card-layout__company-name, a.topcard__org-name-link').first().text().trim();
  if (company) details.company = company;

  const location = $('.topcard__flavor--bullet, .top-card-layout__first-subline span').first().text().trim();
  if (location) details.location = location;

  // Structured criteria (Seniority, Employment type, etc.)
  $('[class*="job-criteria-item"]').each((_, el) => {
    const label = $(el).find('h3, [class*="subheader"]').text().trim().toLowerCase();
    const val   = $(el).find('span, [class*="text"]').last().text().trim();
    if (!val) return;
    if (label.includes('seniority'))       details.seniorityLevel  = val;
    else if (label.includes('employment')) details.employmentType  = val;
    else if (label.includes('function'))   details.jobFunction     = val;
    else if (label.includes('industr'))    details.industries      = val;
    else if (label.includes('salary') || label.includes('compensation')) {
      details.salaryRaw = val;
    }
  });

  const rawDesc = $('[class*="description__text"]').text().trim().replace(/\s+/g, ' ');
  if (rawDesc) details.description = rawDesc.slice(0, 8000);

  return Object.keys(details).length > 0 ? { ...details, jobId } : null;
}

// Subjects LinkedIn sends for application confirmations.
// No ^ anchor — LinkedIn prepends the user's first name: "Matthew, your application…"
const SUBJECT_PATTERNS = [
  // "Matthew, your application was sent to Acme Corp"
  // "Your Easy Apply application was sent to Acme Corp"
  { re: /your (?:easy apply )?application was sent to (.+)/i,  groups: { company: 1 } },
  // "Your application to Machine Learning Engineer at Acme Corp"
  { re: /your application to (.+?) at (.+)/i,                  groups: { role: 1, company: 2 } },
  // "You applied to Software Engineer at Acme Corp"
  { re: /you applied to (.+?) at (.+)/i,                       groups: { role: 1, company: 2 } },
  // "Application submitted to / for Acme Corp"
  { re: /application submitted.*?(?:to|for) (.+)/i,            groups: { company: 1 } },
  // "Acme Corp received your application"
  { re: /(.+?) received your application/i,                    groups: { company: 1 } },
];

/**
 * Returns { company, role, jobUrl, subject } or null if not a LinkedIn application email.
 * @param {string} fromAddress  e.g. "jobs-noreply@linkedin.com"
 * @param {string} subject
 * @param {string} html         HTML body (may be empty string)
 */
export function parseLinkedInConfirmation(fromAddress, subject, html) {
  if (!fromAddress.toLowerCase().includes('linkedin.com')) return null;
  if (!subject) return null;

  let company = null;
  let role    = null;

  for (const { re, groups } of SUBJECT_PATTERNS) {
    const m = subject.match(re);
    if (!m) continue;
    company = groups.company ? m[groups.company]?.trim() : null;
    role    = groups.role    ? m[groups.role]?.trim()    : null;
    break;
  }

  if (!company) return null;

  // Parse HTML for job URL and (optionally) role
  let jobUrl = null;

  if (html) {
    const $ = load(html);

    // Job URL: look for linkedin.com/.../jobs/view/ links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (/linkedin\.com.*\/jobs\/view\//i.test(href)) {
        // strip tracking params but keep the path
        try { jobUrl = new URL(href).origin + new URL(href).pathname; }
        catch { jobUrl = href.split('?')[0]; }
        return false; // break
      }
    });

    // If role not found in subject, try common HTML selectors
    if (!role) {
      const candidates = [
        $('[class*="job-title"]').first().text().trim(),
        $('[class*="jobtitle"]').first().text().trim(),
        $('h1').first().text().trim(),
        $('h2').first().text().trim(),
      ];
      for (const t of candidates) {
        if (t.length > 2 && t.length < 120) { role = t; break; }
      }
    }
  }

  return { company, role: role ?? null, jobUrl: jobUrl ?? null, subject };
}
