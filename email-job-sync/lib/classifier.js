// Domains that are never a direct company reply (ATS platforms, email infra, etc.)
export const SKIP_DOMAINS = new Set([
  // Generic providers
  'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','me.com',
  'mac.com','aol.com','protonmail.com','proton.me',
  // ATS / recruiting platforms
  'greenhouse.io','lever.co','workable.com','ashby.io','ashbyhq.com',
  'smartrecruiters.com','jobvite.com','icims.com','bamboohr.com',
  'recruitee.com','breezy.hr','jazz.co','taleo.net','successfactors.com',
  'myworkdayjobs.com','workday.com','applytojob.com','jobscore.com',
  'rippling.com','gusto.com','merge.dev',
  // Job boards
  'linkedin.com','indeed.com','glassdoor.com','ziprecruiter.com',
  'monster.com','dice.com','builtinnyc.com','wellfound.com',
  'angel.co','simplyhired.com',
  // Scheduling / docs
  'calendly.com','cal.com','savvycal.com','docusign.com','hellosign.com',
  // Email infrastructure
  'sendgrid.net','sendgrid.com','mailchimp.com','mailgun.org',
  'amazonses.com','sparkpost.com','postmarkapp.com','mandrillapp.com',
  'mcsv.net','rsgsv.net',
  // Notification catch-alls
  'noreply.com','no-reply.com','notifications.com',
]);

// Ordered by priority — first match wins
const PATTERNS = [
  {
    type:            'offer',
    interactionType: 'offer_received',
    statusUpdate:    'offer',
    signals: [
      'offer letter', 'pleased to extend an offer', 'we would like to offer you',
      'excited to extend', 'formal offer of employment', 'offer of employment',
      'compensation package', 'your start date', 'sign your offer',
    ],
  },
  {
    type:            'rejection',
    interactionType: 'rejection',
    statusUpdate:    'rejected',
    signals: [
      'unfortunately', 'not moving forward', 'decided to go with',
      'position has been filled', 'no longer considering', 'regret to inform',
      'not the right fit', 'not a match', 'pursuing other candidates',
      'have decided not to', 'will not be moving forward',
      'not be proceeding', 'not selected for', 'not be advancing',
      'decided to move forward with other', 'position has been closed',
      'not be continuing', 'decided to pursue other',
    ],
  },
  {
    type:            'position_closed',
    interactionType: 'rejection',
    statusUpdate:    'rejected',
    signals: [
      'position on hold', 'requisition closed', 'role has been cancelled',
      'position no longer available', 'hiring freeze', 'paused our search',
      'put the role on hold', 'position has been put on hold',
      'not be filling', 'cancelled the position',
    ],
  },
  {
    type:            'interview',
    interactionType: 'interview',
    statusUpdate:    null,
    signals: [
      'schedule', 'phone screen', 'technical interview', 'technical screen',
      'onsite interview', 'video interview', 'meet with the team',
      'next round', 'next step is', 'calendly', 'please book',
      'like to set up a', 'like to schedule', 'want to set up',
      'chat with you', 'speak with you', 'meet with you',
    ],
  },
  {
    type:            'next_steps',
    interactionType: 'email_received',
    statusUpdate:    null,
    signals: [
      'next steps', 'moving forward with your application',
      'advance you to', 'advance your application', 'impressed by',
      'excited about your background', 'would like to move you forward',
      'progressing your application', 'shortlisted',
    ],
  },
];

/**
 * Classify a job-related email's sentiment.
 * Returns { type, interactionType, statusUpdate, confidence, matchedSignals } or null.
 */
export function classifyFollowup(subject, text) {
  const content = ((subject ?? '') + ' ' + (text ?? '')).toLowerCase();

  for (const pattern of PATTERNS) {
    const matched = pattern.signals.filter(s => content.includes(s));
    if (matched.length > 0) {
      return {
        type:            pattern.type,
        interactionType: pattern.interactionType,
        statusUpdate:    pattern.statusUpdate,
        confidence:      matched.length >= 2 ? 'high' : 'low',
        matchedSignals:  matched,
      };
    }
  }

  return null;
}

// Strip noise so "VoiceAdmin LLC" and "voiceadmin.com" both reduce to "voiceadmin"
function normalizeForMatch(s) {
  return (s ?? '').toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|company|technologies|tech|ai|labs?|group|services|solutions|consulting|international|global|ventures|partners|staffing|recruitment|talent|systems|software|platform|digital|data|cloud)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Unified email → application matcher using a scoring approach.
 *
 * Scoring (first app to reach threshold wins):
 *   3 pts  sender domain matches company name
 *   2 pts  company name found in subject or body
 *   2 pts  role title found in subject or body
 *
 * Minimum score of 2 required to avoid false positives.
 * Returns the best-matching application row or null.
 */
export function matchEmailToApplication(fromAddress, subject, text, applications) {
  const searchable = `${subject ?? ''} ${(text ?? '').slice(0, 1500)}`;
  const flat = searchable.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');

  // Pre-compute domain roots from sender address
  const senderDomain = fromAddress?.split('@')?.[1]?.toLowerCase() ?? '';
  const domainRoots  = (() => {
    if (!senderDomain || SKIP_DOMAINS.has(senderDomain)) return [];
    const labels = senderDomain.split('.');
    return labels.length >= 3
      ? [labels.slice(0, -2).join(''), labels[0]]
      : [labels[0]];
  })();

  let best = null;
  let bestScore = 1; // must beat threshold

  for (const app of applications) {
    let score = 0;

    const normCompany = normalizeForMatch(app.company);
    const normRole    = app.role && app.role !== 'Unknown Role'
      ? normalizeForMatch(app.role) : '';

    // ── Domain match (3 pts) ────────────────────────────────────────────────
    for (const root of domainRoots) {
      const nd = normalizeForMatch(root);
      if (nd.length >= 3 && normCompany.length >= 3 &&
          (nd === normCompany || nd.includes(normCompany) || normCompany.includes(nd))) {
        score += 3; break;
      }
    }

    // ── Company name in content (2 pts) ─────────────────────────────────────
    if (normCompany.length >= 3) {
      const flatNoSpace = flat.replace(/ /g, '');
      if (flatNoSpace.includes(normCompany) || flat.includes(normCompany)) score += 2;
    }

    // ── Role title in content (2 pts) ────────────────────────────────────────
    if (normRole.length >= 5 && flat.replace(/ /g, '').includes(normRole)) score += 2;

    if (score > bestScore) { bestScore = score; best = app; }
  }

  return best;
}

// Keep these as thin wrappers so old call-sites don't break
export function matchSenderToApplication(from, apps) {
  return matchEmailToApplication(from, '', '', apps);
}
export function matchSubjectToApplication(subject, apps) {
  return matchEmailToApplication('', subject, '', apps);
}

// AI-driven / one-way video assessment platforms — not human interviews
const AI_INTERVIEW_SIGNALS = [
  'hirevue', 'pymetrics', 'spark hire', 'sparkhire', 'modern hire', 'modernhire',
  'vidcruiter', 'wepow', 'montage', 'interviewstream', 'talview', 'codility',
  'one-way video', 'one way video', 'pre-recorded video', 'prerecorded',
  'record your answers', 'record a video', 'video assessment',
  'ai interview', 'speak with our ai', 'chat with our ai', 'speak with an ai',
  'automated interview', 'digital interview', 'on-demand interview',
  'on demand interview',
];

export function isAiInterview(subject, text) {
  const content = `${subject ?? ''} ${(text ?? '').slice(0, 2000)}`.toLowerCase();
  return AI_INTERVIEW_SIGNALS.some(s => content.includes(s));
}
