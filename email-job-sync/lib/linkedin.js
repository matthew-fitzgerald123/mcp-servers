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

// Domains that send application confirmation emails we want to parse
export const APPLICATION_SENDER_DOMAINS = new Set([
  'linkedin.com',
  // ATS platforms
  'greenhouse.io', 'app.greenhouse.io',
  'hire.lever.co', 'lever.co',
  'workable.com', 'apply.workable.com',
  'ashbyhq.com', 'ashby.io',
  'smartrecruiters.com',
  'bamboohr.com', 'app.bamboohr.com',
  'jobvite.com',
  'icims.com',
  'myworkdayjobs.com', 'wd1.myworkdayjobs.com',
  'successfactors.com',
  'recruitee.com',
  'breezy.hr',
  'applytojob.com',
]);

// Subject patterns for all application confirmation emails.
// No ^ anchor — LinkedIn prepends the user's first name: "Matthew, your application…"
const SUBJECT_PATTERNS = [
  // LinkedIn Easy Apply: "Matthew, your application was sent to Acme Corp"
  { re: /your (?:easy apply )?application was sent to (.+)/i,         groups: { company: 1 } },
  // "Your application to [Role] at [Company]" (LinkedIn / Workable)
  { re: /your application (?:to|for) (.+?) at (.+)/i,                 groups: { role: 1, company: 2 } },
  // "You applied to [Role] at [Company]"
  { re: /you applied to (.+?) at (.+)/i,                              groups: { role: 1, company: 2 } },
  // "Thanks / Thank you for applying for [Role] at [Company]" (Workable, SmartRecruiters)
  { re: /thank(?:s| you) for applying (?:for|to) (.+?) at (.+)/i,    groups: { role: 1, company: 2 } },
  // "We received your application for [Role] at [Company]"
  { re: /we (?:received|got) your application for (.+?) at (.+)/i,   groups: { role: 1, company: 2 } },
  // "Your application for [Role] at [Company] has been received"
  { re: /your application for (.+?) at (.+?) (?:has been|was)/i,     groups: { role: 1, company: 2 } },
  // "[Company] received your application" (Lever)
  { re: /^(.+?) (?:has )?received your application/i,                 groups: { company: 1 } },
  // "Application received — [Company]" (Lever)
  { re: /application received[^a-z]+(.+)/i,                           groups: { company: 1 } },
  // "Application submitted to / for [Company]" (Greenhouse)
  { re: /application submitted.*?(?:to|for) (.+)/i,                   groups: { company: 1 } },
  // "Thank you for your application to [Company]"
  { re: /thank(?:s| you) for your application (?:to|for|at) (.+)/i,  groups: { company: 1 } },
  // "Your application to [Company]" (Greenhouse generic)
  { re: /your application (?:to|for) (.+)/i,                          groups: { company: 1 } },
];

function senderMatchesApplicationDomain(fromAddress) {
  const domain = fromAddress?.split('@')?.[1]?.toLowerCase() ?? '';
  return [...APPLICATION_SENDER_DOMAINS].some(d => domain === d || domain.endsWith('.' + d));
}

/**
 * Parse any application confirmation email — LinkedIn Easy Apply or ATS platform.
 * Returns { company, role, jobUrl, source, subject } or null.
 */
export function parseLinkedInConfirmation(fromAddress, subject, html) {
  if (!senderMatchesApplicationDomain(fromAddress)) return null;
  if (!subject) return null;

  const domain  = fromAddress?.split('@')?.[1]?.toLowerCase() ?? '';
  const source  = domain.includes('linkedin') ? 'linkedin'
    : domain.includes('greenhouse') ? 'greenhouse'
    : domain.includes('lever')      ? 'lever'
    : domain.includes('workable')   ? 'workable'
    : domain.includes('ashby')      ? 'ashby'
    : 'ats';

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

  return { company, role: role ?? null, jobUrl: jobUrl ?? null, source, subject };
}
