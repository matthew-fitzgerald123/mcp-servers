import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── DB setup ─────────────────────────────────────────────────────────────────

const DB_DIR  = join(homedir(), '.job-tracker');
const DB_PATH = join(DB_DIR, 'tracker.db');
mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id               TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    company          TEXT NOT NULL,
    role             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'discovered',
    source           TEXT DEFAULT 'other',
    job_url          TEXT,
    location         TEXT,
    salary_min       INTEGER,
    salary_max       INTEGER,
    applied_date     TEXT,
    last_activity    TEXT NOT NULL DEFAULT (datetime('now')),
    next_action      TEXT,
    next_action_date TEXT,
    notes            TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id             TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    name           TEXT NOT NULL,
    role           TEXT,
    email          TEXT,
    linkedin_url   TEXT,
    phone          TEXT,
    notes          TEXT,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id               TEXT PRIMARY KEY,
    application_id   TEXT NOT NULL,
    contact_id       TEXT,
    date             TEXT NOT NULL DEFAULT (datetime('now')),
    type             TEXT NOT NULL,
    summary          TEXT,
    follow_up_needed INTEGER NOT NULL DEFAULT 0,
    follow_up_date   TEXT,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id)     REFERENCES contacts(id)     ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS prep_notes (
    id             TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE,
    content        TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────

const newId  = () => randomBytes(8).toString('hex');
const nowIso = () => new Date().toISOString();

const STATUS_ENUM = ['discovered','applied','recruiter_screen','technical_screen','onsite','offer','accepted','declined','rejected','no_response','withdrew'];
const SOURCE_ENUM = ['linkedin','company_site','referral','recruiter','other'];
const ITYPE_ENUM  = ['applied','email_sent','email_received','call','interview','offer_received','rejection','note','other'];
const INACTIVE    = ['accepted','declined','rejected','withdrew'];

const zStatus = z.enum(STATUS_ENUM);
const zSource = z.enum(SOURCE_ENUM);
const zIType  = z.enum(ITYPE_ENUM);

function ok(data)  { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function err(msg)  { return { content: [{ type: 'text', text: String(msg) }], isError: true }; }

const getApp = db.prepare('SELECT * FROM applications WHERE id = ?');

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'job-tracker', version: '1.0.0' });

// ── add_application ──────────────────────────────────────────────────────────

server.tool(
  'add_application',
  'Add a new job application. Auto-logs an "applied" interaction when status is "applied".',
  {
    company:          z.string().describe('Company name'),
    role:             z.string().describe('Role / position title'),
    status:           zStatus.optional().describe('Initial status (default: discovered)'),
    source:           zSource.optional().describe('How you found this job (default: other)'),
    job_url:          z.string().optional().describe('URL to the job posting'),
    location:         z.string().optional(),
    salary_min:       z.number().int().optional(),
    salary_max:       z.number().int().optional(),
    applied_date:     z.string().optional().describe('Date applied YYYY-MM-DD (default: today)'),
    next_action:      z.string().optional(),
    next_action_date: z.string().optional().describe('ISO 8601 date for next action'),
    notes:            z.string().optional()
  },
  async (p) => {
    try {
      const id     = newId();
      const ts     = nowIso();
      const status = p.status ?? 'discovered';
      const appDate = p.applied_date ?? ts.slice(0, 10);

      db.prepare(`
        INSERT INTO applications
          (id,created_at,updated_at,company,role,status,source,job_url,location,
           salary_min,salary_max,applied_date,last_activity,next_action,next_action_date,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id,ts,ts,p.company,p.role,status,p.source??'other',
             p.job_url??null,p.location??null,p.salary_min??null,p.salary_max??null,
             appDate,ts,p.next_action??null,p.next_action_date??null,p.notes??null);

      if (status === 'applied') {
        db.prepare(`INSERT INTO interactions (id,application_id,date,type,summary)
                    VALUES (?,?,?,'applied','Application submitted')`
        ).run(newId(), id, appDate);
      }

      return ok(getApp.get(id));
    } catch (e) { return err(e.message); }
  }
);

// ── update_application ───────────────────────────────────────────────────────

server.tool(
  'update_application',
  'Partially update a job application. Always bumps last_activity.',
  {
    id:               z.string(),
    company:          z.string().optional(),
    role:             z.string().optional(),
    status:           zStatus.optional(),
    source:           zSource.optional(),
    job_url:          z.string().optional(),
    location:         z.string().optional(),
    salary_min:       z.number().int().optional(),
    salary_max:       z.number().int().optional(),
    applied_date:     z.string().optional(),
    next_action:      z.string().optional(),
    next_action_date: z.string().optional(),
    notes:            z.string().optional()
  },
  async ({ id, ...updates }) => {
    try {
      if (!getApp.get(id)) return err(`Application not found: ${id}`);
      const ts      = nowIso();
      const clauses = ['updated_at = ?', 'last_activity = ?'];
      const vals    = [ts, ts];
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) { clauses.push(`${k} = ?`); vals.push(v); }
      }
      vals.push(id);
      db.prepare(`UPDATE applications SET ${clauses.join(', ')} WHERE id = ?`).run(...vals);
      return ok(getApp.get(id));
    } catch (e) { return err(e.message); }
  }
);

// ── list_applications ────────────────────────────────────────────────────────

server.tool(
  'list_applications',
  'List applications with filters. active_only=true (default) excludes accepted/declined/rejected/withdrew.',
  {
    status:         zStatus.optional().describe('Filter by exact status'),
    company:        z.string().optional().describe('Partial company name match'),
    active_only:    z.boolean().optional().describe('Exclude terminal statuses (default true)'),
    needs_followup: z.boolean().optional().describe('Only show overdue next actions')
  },
  async ({ status, company, active_only, needs_followup }) => {
    try {
      const useActive = active_only !== false;
      let   q = 'SELECT * FROM applications WHERE 1=1';
      const p = [];
      if (useActive) q += ` AND status NOT IN ('${INACTIVE.join("','")}')`;
      if (status)    { q += ' AND status = ?';      p.push(status); }
      if (company)   { q += ' AND company LIKE ?';  p.push(`%${company}%`); }
      if (needs_followup) q += ` AND next_action_date IS NOT NULL AND next_action_date <= datetime('now')`;
      q += ' ORDER BY last_activity DESC';
      return ok(db.prepare(q).all(...p));
    } catch (e) { return err(e.message); }
  }
);

// ── get_application ──────────────────────────────────────────────────────────

server.tool(
  'get_application',
  'Get full details of one application: fields, contacts, last 10 interactions, prep notes.',
  { id: z.string() },
  async ({ id }) => {
    try {
      const app = getApp.get(id);
      if (!app) return err(`Application not found: ${id}`);
      const contacts     = db.prepare('SELECT * FROM contacts WHERE application_id = ?').all(id);
      const interactions = db.prepare(
        'SELECT * FROM interactions WHERE application_id = ? ORDER BY date DESC LIMIT 10'
      ).all(id);
      const prepNotes = db.prepare('SELECT * FROM prep_notes WHERE application_id = ?').get(id) ?? null;
      return ok({ ...app, contacts, recent_interactions: interactions, prep_notes: prepNotes });
    } catch (e) { return err(e.message); }
  }
);

// ── delete_application ───────────────────────────────────────────────────────

server.tool(
  'delete_application',
  'Permanently delete an application and all associated contacts, interactions, and prep notes.',
  { id: z.string() },
  async ({ id }) => {
    try {
      if (!getApp.get(id)) return err(`Application not found: ${id}`);
      db.prepare('DELETE FROM applications WHERE id = ?').run(id);
      return ok({ deleted: true, id });
    } catch (e) { return err(e.message); }
  }
);

// ── log_interaction ──────────────────────────────────────────────────────────

server.tool(
  'log_interaction',
  'Log an interaction for an application. If follow_up_needed + follow_up_date are set, updates the application\'s next_action fields.',
  {
    application_id:   z.string(),
    type:             zIType,
    summary:          z.string().optional(),
    date:             z.string().optional().describe('ISO 8601 datetime (default: now)'),
    contact_id:       z.string().optional(),
    follow_up_needed: z.boolean().optional(),
    follow_up_date:   z.string().optional().describe('ISO 8601'),
    next_action:      z.string().optional().describe('Next action text — also updates the application')
  },
  async ({ application_id, type, summary, date, contact_id, follow_up_needed, follow_up_date, next_action }) => {
    try {
      if (!getApp.get(application_id)) return err(`Application not found: ${application_id}`);
      const id   = newId();
      const iDate = date ?? nowIso();

      db.prepare(`
        INSERT INTO interactions (id,application_id,contact_id,date,type,summary,follow_up_needed,follow_up_date)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(id, application_id, contact_id??null, iDate, type, summary??null,
             follow_up_needed ? 1 : 0, follow_up_date??null);

      const ts      = nowIso();
      const clauses = ['last_activity = ?', 'updated_at = ?'];
      const vals    = [ts, ts];
      if (follow_up_needed && follow_up_date) {
        clauses.push('next_action_date = ?'); vals.push(follow_up_date);
      }
      if (next_action) { clauses.push('next_action = ?'); vals.push(next_action); }
      vals.push(application_id);
      db.prepare(`UPDATE applications SET ${clauses.join(', ')} WHERE id = ?`).run(...vals);

      return ok(db.prepare('SELECT * FROM interactions WHERE id = ?').get(id));
    } catch (e) { return err(e.message); }
  }
);

// ── list_interactions ────────────────────────────────────────────────────────

server.tool(
  'list_interactions',
  'List interactions for an application, newest first.',
  {
    application_id: z.string(),
    limit:          z.number().int().optional().describe('Max results (default 20)')
  },
  async ({ application_id, limit }) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM interactions WHERE application_id = ? ORDER BY date DESC LIMIT ?'
      ).all(application_id, limit ?? 20);
      return ok(rows);
    } catch (e) { return err(e.message); }
  }
);

// ── add_contact ──────────────────────────────────────────────────────────────

server.tool(
  'add_contact',
  'Add a contact linked to a job application.',
  {
    application_id: z.string(),
    name:           z.string(),
    role:           z.string().optional().describe('Contact\'s title / role'),
    email:          z.string().optional(),
    linkedin_url:   z.string().optional(),
    phone:          z.string().optional(),
    notes:          z.string().optional()
  },
  async ({ application_id, name, role, email, linkedin_url, phone, notes }) => {
    try {
      if (!getApp.get(application_id)) return err(`Application not found: ${application_id}`);
      const id = newId();
      db.prepare(`
        INSERT INTO contacts (id,application_id,name,role,email,linkedin_url,phone,notes)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(id, application_id, name, role??null, email??null, linkedin_url??null, phone??null, notes??null);
      return ok(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
    } catch (e) { return err(e.message); }
  }
);

// ── list_contacts ────────────────────────────────────────────────────────────

server.tool(
  'list_contacts',
  'List all contacts for a job application.',
  { application_id: z.string() },
  async ({ application_id }) => {
    try {
      return ok(db.prepare('SELECT * FROM contacts WHERE application_id = ?').all(application_id));
    } catch (e) { return err(e.message); }
  }
);

// ── save_prep_notes ──────────────────────────────────────────────────────────

server.tool(
  'save_prep_notes',
  'Save or overwrite prep notes (markdown) for a job application.',
  {
    application_id: z.string(),
    content:        z.string().describe('Markdown content')
  },
  async ({ application_id, content }) => {
    try {
      if (!getApp.get(application_id)) return err(`Application not found: ${application_id}`);
      const ts      = nowIso();
      const existing = db.prepare('SELECT id FROM prep_notes WHERE application_id = ?').get(application_id);
      if (existing) {
        db.prepare('UPDATE prep_notes SET content = ?, updated_at = ? WHERE application_id = ?')
          .run(content, ts, application_id);
      } else {
        db.prepare('INSERT INTO prep_notes (id,application_id,content,updated_at) VALUES (?,?,?,?)')
          .run(newId(), application_id, content, ts);
      }
      return ok(db.prepare('SELECT * FROM prep_notes WHERE application_id = ?').get(application_id));
    } catch (e) { return err(e.message); }
  }
);

// ── get_prep_notes ───────────────────────────────────────────────────────────

server.tool(
  'get_prep_notes',
  'Retrieve prep notes for a job application.',
  { application_id: z.string() },
  async ({ application_id }) => {
    try {
      const notes = db.prepare('SELECT * FROM prep_notes WHERE application_id = ?').get(application_id);
      return ok(notes ?? { message: 'No prep notes yet.' });
    } catch (e) { return err(e.message); }
  }
);

// ── get_pipeline_summary ─────────────────────────────────────────────────────

server.tool(
  'get_pipeline_summary',
  'Count applications per status, overdue follow-ups, and stale applications (no activity 10+ days).',
  {},
  async () => {
    try {
      const byStatus = db.prepare(
        'SELECT status, COUNT(*) as count FROM applications GROUP BY status ORDER BY count DESC'
      ).all();
      const overdue = db.prepare(`
        SELECT COUNT(*) as count FROM applications
        WHERE next_action_date IS NOT NULL
          AND next_action_date <= datetime('now')
          AND status NOT IN ('${INACTIVE.join("','")}')
      `).get();
      const stale = db.prepare(`
        SELECT COUNT(*) as count FROM applications
        WHERE last_activity <= datetime('now', '-10 days')
          AND status NOT IN ('${INACTIVE.join("','")}')
      `).get();
      const total = db.prepare('SELECT COUNT(*) as count FROM applications').get();

      return ok({
        total:                total.count,
        by_status:            Object.fromEntries(byStatus.map(r => [r.status, r.count])),
        overdue_followups:    overdue.count,
        stale_no_activity_10d: stale.count
      });
    } catch (e) { return err(e.message); }
  }
);

// ── get_followups_due ────────────────────────────────────────────────────────

server.tool(
  'get_followups_due',
  'List active applications whose next_action_date is today or tomorrow.',
  {},
  async () => {
    try {
      const rows = db.prepare(`
        SELECT * FROM applications
        WHERE next_action_date IS NOT NULL
          AND next_action_date <= datetime('now', '+1 day')
          AND status NOT IN ('${INACTIVE.join("','")}')
        ORDER BY next_action_date ASC
      `).all();
      return ok(rows);
    } catch (e) { return err(e.message); }
  }
);

// ── draft_followup_email ─────────────────────────────────────────────────────

server.tool(
  'draft_followup_email',
  'Generate a ready-to-edit follow-up email draft. Pulls contact info and days since last interaction.',
  {
    application_id: z.string(),
    tone:           z.enum(['professional', 'casual', 'brief'])
  },
  async ({ application_id, tone }) => {
    try {
      const app = getApp.get(application_id);
      if (!app) return err(`Application not found: ${application_id}`);

      const contact = db.prepare(
        'SELECT * FROM contacts WHERE application_id = ? ORDER BY rowid LIMIT 1'
      ).get(application_id);
      const lastInt = db.prepare(
        'SELECT * FROM interactions WHERE application_id = ? ORDER BY date DESC LIMIT 1'
      ).get(application_id);

      const contactName  = contact?.name  ?? 'Hiring Manager';
      const contactEmail = contact?.email ?? '[contact email]';
      const daysSince    = lastInt
        ? Math.round((Date.now() - new Date(lastInt.date).getTime()) / 86_400_000)
        : null;
      const sinceText = daysSince != null ? `${daysSince} day${daysSince !== 1 ? 's' : ''} ago` : 'some time ago';

      let subject, body;

      if (tone === 'professional') {
        subject = `Following up on my application for ${app.role} at ${app.company}`;
        body = `Hi ${contactName},

I hope this message finds you well. I wanted to follow up on my application for the ${app.role} position at ${app.company}. I last reached out ${sinceText} and remain very enthusiastic about the opportunity.

I believe my background would be a strong fit for this role, and I'd welcome the chance to discuss how I can contribute. Could you share any updates on the timeline or next steps?

Thank you for your time and consideration.

Best regards,
[Your name]`;
      } else if (tone === 'casual') {
        subject = `Checking in — ${app.role} at ${app.company}`;
        body = `Hey ${contactName},

Hope you're doing well! Just wanted to touch base on the ${app.role} role at ${app.company} — it's been ${sinceText} since we last connected and I'm still really excited about it.

Any updates on your end? Happy to jump on a call if easier.

Thanks!
[Your name]`;
      } else {
        subject = `Following up — ${app.role} at ${app.company}`;
        body = `Hi ${contactName},

Quick follow-up on the ${app.role} role at ${app.company} (last contact: ${sinceText}). Any news or next steps?

Thanks,
[Your name]`;
      }

      return ok({
        to: contactEmail,
        subject,
        body,
        context: {
          company:                    app.company,
          role:                       app.role,
          contact_name:               contactName,
          days_since_last_interaction: daysSince,
          last_interaction_type:      lastInt?.type ?? null
        }
      });
    } catch (e) { return err(e.message); }
  }
);

// ── connect ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
