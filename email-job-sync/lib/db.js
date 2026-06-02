import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

const DB_DIR  = join(homedir(), '.job-tracker');
const DB_PATH = join(DB_DIR, 'tracker.db');

mkdirSync(DB_DIR, { recursive: true });

let _db = null;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    // Migrate: add job_description column if not present
    try { _db.exec(`ALTER TABLE applications ADD COLUMN job_description TEXT`); } catch {}

    // Extend tracker schema with email sync log
    _db.exec(`
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

      CREATE TABLE IF NOT EXISTS interactions (
        id               TEXT PRIMARY KEY,
        application_id   TEXT NOT NULL,
        contact_id       TEXT,
        date             TEXT NOT NULL DEFAULT (datetime('now')),
        type             TEXT NOT NULL,
        summary          TEXT,
        follow_up_needed INTEGER NOT NULL DEFAULT 0,
        follow_up_date   TEXT,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS email_sync_log (
        id              TEXT PRIMARY KEY,
        email_uid       INTEGER UNIQUE,
        email_date      TEXT,
        subject         TEXT,
        matched         INTEGER NOT NULL DEFAULT 0,
        application_id  TEXT,
        processed_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    try { _db.exec('ALTER TABLE email_sync_log ADD COLUMN classification_type TEXT'); } catch {}
  }
  return _db;
}

const newId = () => randomBytes(8).toString('hex');

export function wasProcessed(uid) {
  return !!getDb().prepare('SELECT 1 FROM email_sync_log WHERE email_uid = ?').get(uid);
}

export function logEmail({ uid, date, subject, matched, applicationId = null, classificationType = null }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO email_sync_log (id, email_uid, email_date, subject, matched, application_id, classification_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId(), uid, date ?? null, subject ?? null, matched ? 1 : 0, applicationId, classificationType);
}

/** Find an existing open application by company+role (fuzzy). */
export function findApplication(company, role) {
  const db  = getDb();
  const inactive = `'accepted','declined','rejected','withdrew'`;
  if (role) {
    return db.prepare(
      `SELECT id, job_url FROM applications
       WHERE company LIKE ? AND role LIKE ? AND status NOT IN (${inactive}) LIMIT 1`
    ).get(`%${company}%`, `%${role}%`);
  }
  return db.prepare(
    `SELECT id, job_url FROM applications
     WHERE company LIKE ? AND status NOT IN (${inactive}) LIMIT 1`
  ).get(`%${company}%`);
}

/** Create a new application from a LinkedIn email detection. */
export function createApplication({ company, role, jobUrl, emailDate, source }) {
  const db  = getDb();
  const id  = newId();
  const ts  = new Date().toISOString();
  const appliedDate = emailDate ? emailDate.slice(0, 10) : ts.slice(0, 10);
  const src = source ?? 'linkedin';

  db.prepare(`
    INSERT INTO applications
      (id, created_at, updated_at, company, role, status, source, job_url, applied_date, last_activity)
    VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)
  `).run(id, ts, ts, company, role ?? 'Unknown Role', src, jobUrl ?? null, appliedDate, ts);

  db.prepare(`
    INSERT INTO interactions (id, application_id, date, type, summary)
    VALUES (?, ?, ?, 'applied', 'Auto-detected from LinkedIn confirmation email')
  `).run(newId(), id, emailDate ?? ts);

  return id;
}

/** Patch job_url onto an existing application if it doesn't have one yet. */
export function patchJobUrl(appId, jobUrl) {
  if (!jobUrl) return;
  const ts = new Date().toISOString();
  getDb().prepare(
    `UPDATE applications SET job_url = ?, updated_at = ? WHERE id = ? AND job_url IS NULL`
  ).run(jobUrl, ts, appId);
}

/**
 * Update an application with details fetched from the LinkedIn job page.
 * Only overwrites fields that are currently empty / unknown.
 */
export function getActiveApplications() {
  return getDb().prepare(
    `SELECT id, company, role, status, applied_date, job_url FROM applications
     WHERE status NOT IN ('rejected','withdrew','declined','accepted')
     ORDER BY last_activity DESC`
  ).all();
}

export function logFollowupInteraction({ applicationId, subject, date, type, summary, statusUpdate }) {
  const db  = getDb();
  const ts  = new Date().toISOString();

  db.prepare(`
    INSERT INTO interactions (id, application_id, date, type, summary)
    VALUES (?, ?, ?, ?, ?)
  `).run(newId(), applicationId, date ?? ts, type, summary ?? subject ?? '');

  const sets = ['last_activity = ?', 'updated_at = ?'];
  const vals = [ts, ts];
  if (statusUpdate) { sets.push('status = ?'); vals.push(statusUpdate); }
  vals.push(applicationId);
  db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function enrichApplication(appId, details) {
  const db  = getDb();
  const ts  = new Date().toISOString();
  const app = db.prepare('SELECT role, location FROM applications WHERE id = ?').get(appId);
  if (!app) return;

  const sets = ['updated_at = ?'];
  const vals = [ts];

  if (details.description) { sets.push('job_description = ?'); vals.push(details.description); }
  if (details.location && !app.location) { sets.push('location = ?'); vals.push(details.location); }
  if (details.title && (app.role === 'Unknown Role' || !app.role)) {
    sets.push('role = ?'); vals.push(details.title);
  }

  vals.push(appId);
  db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function recentSyncLog(limit = 30) {
  return getDb().prepare(
    'SELECT * FROM email_sync_log ORDER BY processed_at DESC LIMIT ?'
  ).all(limit);
}

export function getEmailSyncStats() {
  const db      = getDb();
  const all     = db.prepare('SELECT COUNT(*) as n FROM email_sync_log').get().n;
  const matched = db.prepare('SELECT COUNT(*) as n FROM email_sync_log WHERE matched = 1').get().n;
  const byType  = db.prepare(
    `SELECT classification_type, COUNT(*) as n FROM email_sync_log
     WHERE classification_type IS NOT NULL GROUP BY classification_type ORDER BY n DESC`
  ).all();
  const recent  = db.prepare(
    `SELECT el.*, a.company, a.role
     FROM email_sync_log el LEFT JOIN applications a ON el.application_id = a.id
     ORDER BY el.processed_at DESC LIMIT 20`
  ).all();
  return {
    all_time: {
      total_processed: all,
      matched,
      unmatched: all - matched,
      match_rate_pct: all > 0 ? Math.round(matched / all * 100) : 0,
    },
    by_classification: Object.fromEntries(byType.map(r => [r.classification_type, r.n])),
    recent_20: recent,
  };
}
