import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { loadConfig, saveConfig, DEFAULTS } from '../lib/config.js';
import { parseLinkedInConfirmation, fetchJobDetails, APPLICATION_SENDER_DOMAINS } from '../lib/linkedin.js';
import { classifyFollowup, matchEmailToApplication, isAiInterview } from '../lib/classifier.js';
import { wasProcessed, logEmail, findApplication, createApplication, patchJobUrl, enrichApplication, getActiveApplications, logFollowupInteraction, recentSyncLog, getEmailSyncStats } from '../lib/db.js';

const db = new Database(join(homedir(), '.job-tracker', 'tracker.db'));

const STATE_PATH = join(homedir(), '.job-tracker', 'email-sync-state.json');

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function err(msg) { return { content: [{ type: 'text', text: String(msg) }], isError: true }; }

async function sweep({ daysBack = 90 } = {}) {
  const cfg = loadConfig();
  if (!cfg?.password) throw new Error('Email not configured. Run configure_email first.');

  const client = new ImapFlow({
    host:   cfg.host   ?? DEFAULTS.host,
    port:   cfg.port   ?? DEFAULTS.port,
    secure: cfg.secure ?? DEFAULTS.secure,
    auth:   { user: cfg.username, pass: cfg.password },
    logger: false,
  });

  const results = { scanned: 0, matched: 0, created: 0, patched: 0, details: [] };

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since   = new Date(Date.now() - daysBack * 86_400_000);
    const batches = await Promise.all(
      [...APPLICATION_SENDER_DOMAINS].map(d => client.search({ since, from: d }, { uid: true }).catch(() => []))
    );
    const uids = [...new Set(batches.flat())];
    results.scanned = uids.length;

    for await (const msg of client.fetch(uids, { uid: true }, { uid: true })) {
      const uid = msg.uid;
      if (wasProcessed(uid)) continue;

      let parsed;
      try {
        const raw = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!raw?.source) continue;
        parsed = await simpleParser(raw.source);
      } catch { continue; }

      const fromAddress = parsed.from?.value?.[0]?.address ?? '';
      const emailDate   = parsed.date?.toISOString() ?? null;
      const result = parseLinkedInConfirmation(fromAddress, parsed.subject ?? '', parsed.html ?? '');

      if (!result) {
        logEmail({ uid, date: emailDate, subject: parsed.subject, matched: false });
        continue;
      }

      results.matched++;
      const existing = findApplication(result.company, result.role);
      let appId, action;

      if (existing) {
        appId  = existing.id;
        action = 'patched';
        patchJobUrl(appId, result.jobUrl);
        results.patched++;
      } else {
        appId  = createApplication({ ...result, emailDate });
        action = 'created';
        results.created++;
      }

      logEmail({ uid, date: parsed.date?.toISOString(), subject: parsed.subject, matched: true, applicationId: appId });
      results.details.push({ company: result.company, role: result.role, jobUrl: result.jobUrl, appId, action });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return results;
}

const server = new McpServer({ name: 'email-job-sync', version: '1.0.0' });

// ── configure_email ───────────────────────────────────────────────────────────

server.tool(
  'configure_email',
  'Save iCloud IMAP credentials for the email-job-sync daemon. Generate an app-specific password at appleid.apple.com → Sign-In & Security → App-Specific Passwords.',
  {
    username:        z.string().describe('iCloud email address (e.g. you@icloud.com)'),
    app_password:    z.string().describe('App-specific password from appleid.apple.com (format: xxxx-xxxx-xxxx-xxxx)'),
    host:            z.string().optional().describe('IMAP host (default: imap.mail.me.com)'),
    port:            z.number().int().optional().describe('IMAP port (default: 993)'),
  },
  async ({ username, app_password, host, port }) => {
    try {
      // Quick connection test
      const client = new ImapFlow({
        host:   host ?? DEFAULTS.host,
        port:   port ?? DEFAULTS.port,
        secure: true,
        auth:   { user: username, pass: app_password },
        logger: false,
      });
      try {
        await client.connect();
        await client.logout();
      } catch (e) {
        return err(`Connection test failed: ${e.message}\n\nDouble-check the app-specific password (not your Apple ID password).`);
      }

      saveConfig({ host: host ?? DEFAULTS.host, port: port ?? DEFAULTS.port, secure: true, username, password: app_password });

      return ok({
        status: 'configured',
        username,
        host: host ?? DEFAULTS.host,
        message: 'Credentials saved and verified. Start the daemon with:\n  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.matthewfitzgerald.email-job-sync.plist\n\nCheck it is running:\n  launchctl list | grep email-job-sync'
      });
    } catch (e) { return err(e.message); }
  }
);

// ── sweep_linkedin_emails ─────────────────────────────────────────────────────

server.tool(
  'sweep_linkedin_emails',
  'Manually scan your inbox for LinkedIn application confirmation emails and import them into the job tracker.',
  {
    days_back: z.number().int().optional().describe('How many days back to search (default 90)')
  },
  async ({ days_back }) => {
    try {
      const results = await sweep({ daysBack: days_back ?? 90 });
      return ok(results);
    } catch (e) { return err(e.message); }
  }
);

// ── get_sync_status ───────────────────────────────────────────────────────────

server.tool(
  'get_sync_status',
  'Show daemon state, last sync time, and the most recent email matches.',
  {},
  async () => {
    try {
      const cfg        = loadConfig();
      const configured = !!(cfg?.password);

      let daemonState = null;
      if (existsSync(STATE_PATH)) {
        try { daemonState = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
      }

      const health = getEmailSyncStats();

      return ok({
        configured,
        username:     cfg?.username ?? null,
        daemon_state: daemonState,
        health,
      });
    } catch (e) { return err(e.message); }
  }
);

// ── sweep_followup_emails ─────────────────────────────────────────────────────

// Return calendar event spec for a confirmed human interview, or { ai_interview: true } for automated ones.
function buildCalendarSuggestion(app, subject, body) {
  if (isAiInterview(subject, body)) return { ai_interview: true };
  return {
    calendar_suggestion: {
      title:         `Interview: ${app.role ?? 'Position'} at ${app.company}`,
      notes:         `Interview for the ${app.role ?? 'position'} at ${app.company}.${app.job_url ? `\n\nJob: ${app.job_url}` : ''}`,
      email_excerpt: body.slice(0, 800).trim(),
    },
  };
}

// Pull the first meaningful word from a company name to use as an IMAP FROM search term.
// "VoiceAdmin" → "voiceadmin"  |  "Protech Talent" → "protech"  |  "Stand8 Tech" → "stand8"
function companySearchTerm(company) {
  const noise = new Set([
    'the','and','for','inc','llc','ltd','corp','co','company','group','tech',
    'technologies','solutions','services','consulting','international','global',
    'ventures','partners','staffing','recruitment','talent','digital','cloud',
    'software','platform','data','labs','systems','agency','associates',
  ]);
  const words = company.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !noise.has(w));
  return words[0] ?? null;
}

server.tool(
  'sweep_followup_emails',
  'Scan inbox for follow-up emails from companies you applied to. Uses a targeted per-company IMAP search so only relevant emails are downloaded. Classifies sentiment (rejection, interview, offer, next steps) and logs each as an interaction.',
  {
    days_back:      z.number().int().optional().describe('How many days back to scan per application (default 90)'),
    application_id: z.string().optional().describe('Limit scan to one specific application'),
  },
  async ({ days_back, application_id }) => {
    try {
      const cfg = loadConfig();
      if (!cfg?.password) return err('Email not configured. Run configure_email first.');

      const apps = application_id
        ? [db.prepare('SELECT id, company, role, status, applied_date, job_url FROM applications WHERE id = ?').get(application_id)].filter(Boolean)
        : getActiveApplications();

      if (apps.length === 0) return ok({ message: 'No active applications found.', scanned: 0, logged: 0 });

      const client = new ImapFlow({
        host: cfg.host ?? DEFAULTS.host, port: cfg.port ?? DEFAULTS.port,
        secure: true, auth: { user: cfg.username, pass: cfg.password },
        logger: false, socketTimeout: 30_000,
      });

      const results = { companies_searched: 0, emails_fetched: 0, logged: 0, details: [] };

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for (const app of apps) {
          const term = companySearchTerm(app.company);
          if (!term) continue;

          // Two server-side searches: by FROM domain AND by subject keyword.
          // Catches both "eshan@voiceadmin.ai" and "your application to VoiceAdmin" via ATS.
          const since = app.applied_date
            ? new Date(app.applied_date)
            : new Date(Date.now() - (days_back ?? 90) * 86_400_000);

          const [fromUids, subjectUids] = await Promise.all([
            client.search({ since, from: term }, { uid: true }),
            client.search({ since, subject: term }, { uid: true }),
          ]);
          const uids = [...new Set([...fromUids, ...subjectUids])];
          results.companies_searched++;

          // Cap per-company to avoid any single company flooding the sweep
          const toProcess = uids.slice(0, 20);

          for (const uid of toProcess) {
            if (wasProcessed(uid)) continue;

            let parsed;
            try {
              const raw = await client.fetchOne(uid, { source: true }, { uid: true });
              if (!raw?.source) continue;
              parsed = await simpleParser(raw.source);
            } catch { continue; }

            results.emails_fetched++;
            const fromAddress = parsed.from?.value?.[0]?.address ?? '';
            const emailDate   = parsed.date?.toISOString() ?? null;
            const subject     = parsed.subject ?? '';
            const body        = parsed.text ?? '';

            if (fromAddress.toLowerCase().includes('linkedin.com')) {
              logEmail({ uid, date: emailDate, subject, matched: false }); continue;
            }

            const classification = classifyFollowup(subject, body);
            const matchedApp     = matchEmailToApplication(fromAddress, subject, body, [app]);

            if (!matchedApp) {
              // Email came back in a company-specific IMAP search — if it has a clear
              // classification, log it directly rather than silently dropping it.
              if (classification) {
                logFollowupInteraction({
                  applicationId: app.id, subject, date: emailDate,
                  type:         classification.interactionType,
                  summary:      `[${classification.type.replace(/_/g, ' ')}] ${subject}`,
                  statusUpdate: classification.statusUpdate,
                });
                logEmail({ uid, date: emailDate, subject, matched: true, applicationId: app.id, classificationType: classification.type });
                results.logged++;
                const detail = {
                  company: app.company, from: fromAddress, subject,
                  type: classification.type, confidence: classification.confidence,
                  statusUpdate: classification.statusUpdate,
                  match_method: 'company_search_fallback',
                };
                if (classification.type === 'interview') Object.assign(detail, buildCalendarSuggestion(app, subject, body));
                results.details.push(detail);
              } else {
                logEmail({ uid, date: emailDate, subject, matched: false });
              }
              continue;
            }

            if (classification) {
              logFollowupInteraction({
                applicationId: app.id, subject, date: emailDate,
                type:         classification.interactionType,
                summary:      `[${classification.type.replace(/_/g, ' ')}] ${subject}`,
                statusUpdate: classification.statusUpdate,
              });
              logEmail({ uid, date: emailDate, subject, matched: true, applicationId: app.id, classificationType: classification.type });
              results.logged++;
              const detail = {
                company:        app.company,
                from:           fromAddress,
                subject,
                type:           classification.type,
                confidence:     classification.confidence,
                statusUpdate:   classification.statusUpdate,
                matchedSignals: classification.matchedSignals,
              };
              if (classification.type === 'interview') Object.assign(detail, buildCalendarSuggestion(app, subject, body));
              results.details.push(detail);
            } else {
              logEmail({ uid, date: emailDate, subject, matched: false });
            }
          }
        }
      } finally {
        lock.release();
        await client.logout();
      }

      return ok(results);
    } catch (e) { return err(e.message); }
  }
);

// ── enrich_applications ───────────────────────────────────────────────────────

server.tool(
  'enrich_applications',
  'Fetch job details (title, description, location, seniority, employment type) from LinkedIn for applications that have a job URL. Rate-limited to ~1 req/sec.',
  {
    application_id: z.string().optional().describe('Enrich one specific application by ID, or omit to process all'),
    limit:          z.number().int().optional().describe('Max applications to process in one call (default 20)')
  },
  async ({ application_id, limit }) => {
    try {
      let apps;
      if (application_id) {
        const a = db.prepare('SELECT id, company, role, job_url, location FROM applications WHERE id = ?').get(application_id);
        apps = a ? [a] : [];
      } else {
        apps = db.prepare(
          `SELECT id, company, role, job_url, location FROM applications
           WHERE job_url IS NOT NULL ORDER BY applied_date DESC LIMIT ?`
        ).all(limit ?? 20);
      }

      const results = { processed: 0, enriched: 0, failed: 0, details: [] };

      for (const app of apps) {
        results.processed++;
        const details = await fetchJobDetails(app.job_url);
        if (details) {
          enrichApplication(app.id, details);
          results.enriched++;
          results.details.push({
            id:             app.id,
            company:        app.company,
            title:          details.title ?? null,
            location:       details.location ?? null,
            employmentType: details.employmentType ?? null,
            seniorityLevel: details.seniorityLevel ?? null,
            hasDescription: !!details.description,
          });
        } else {
          results.failed++;
          results.details.push({ id: app.id, company: app.company, error: 'no data returned' });
        }
        // ~1 req/sec to avoid rate limiting
        await new Promise(r => setTimeout(r, 1100));
      }

      return ok(results);
    } catch (e) { return err(e.message); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
