/**
 * Local HTTP capture server — listens on localhost:7432.
 * Receives job application data from the browser extension and writes
 * directly to ~/.job-tracker/tracker.db.
 *
 * Start manually: node server/index.js
 * Or via launchd: com.matthewfitzgerald.job-capture.plist
 */

import { createServer } from 'http';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { mkdirSync } from 'fs';

const PORT    = 7432;
const DB_DIR  = join(homedir(), '.job-tracker');
const DB_PATH = join(DB_DIR, 'tracker.db');

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure schema exists (job-tracker server creates it, but run defensively)
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'discovered',
    source TEXT DEFAULT 'other',
    job_url TEXT,
    location TEXT,
    salary_min INTEGER,
    salary_max INTEGER,
    applied_date TEXT,
    last_activity TEXT NOT NULL DEFAULT (datetime('now')),
    next_action TEXT,
    next_action_date TEXT,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    contact_id TEXT,
    date TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    summary TEXT,
    follow_up_needed INTEGER NOT NULL DEFAULT 0,
    follow_up_date TEXT,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
  );
`);

const newId  = () => randomBytes(8).toString('hex');
const nowIso = () => new Date().toISOString();

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── GET /status ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/status') {
    const count = db.prepare('SELECT COUNT(*) as n FROM applications').get();
    respond(res, 200, { ok: true, applications: count.n, host: hostname() });
    return;
  }

  // ── POST /capture ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/capture') {
    let body;
    try { body = await readBody(req); }
    catch { respond(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

    const { company, role, job_url, location, notes, source, status } = body;

    if (!company || typeof company !== 'string') {
      respond(res, 400, { ok: false, error: 'company is required' }); return;
    }

    const id  = newId();
    const ts  = nowIso();
    const src = source ?? 'company_site';
    const st  = status ?? 'applied';

    db.prepare(`
      INSERT INTO applications
        (id, created_at, updated_at, company, role, status, source, job_url, location, applied_date, last_activity, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ts, ts,
      company.trim(),
      (role ?? 'Unknown Role').trim(),
      st, src,
      job_url ?? null,
      location ?? null,
      ts.slice(0, 10),
      ts,
      notes ?? null
    );

    db.prepare(`
      INSERT INTO interactions (id, application_id, date, type, summary)
      VALUES (?, ?, ?, 'applied', 'Captured via browser extension')
    `).run(newId(), id, ts);

    console.log(`[capture] ${company} / ${role ?? 'unknown'} (${src})`);
    respond(res, 201, { ok: true, id, company, role: role ?? 'Unknown Role' });
    return;
  }

  respond(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Job capture server listening on http://localhost:${PORT}`);
});
