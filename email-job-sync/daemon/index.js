/**
 * IMAP IDLE daemon — connects to iCloud, watches INBOX for LinkedIn
 * application confirmation emails, writes directly to ~/.job-tracker/tracker.db.
 *
 * Kept alive by launchd (com.matthewfitzgerald.email-job-sync).
 * Run manually: node daemon/index.js
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig, DEFAULTS } from '../lib/config.js';
import { parseLinkedInConfirmation, fetchJobDetails } from '../lib/linkedin.js';
import { classifyFollowup, matchEmailToApplication } from '../lib/classifier.js';
import { wasProcessed, logEmail, findApplication, createApplication, patchJobUrl, enrichApplication, getActiveApplications, logFollowupInteraction } from '../lib/db.js';

const STATE_PATH = join(homedir(), '.job-tracker', 'email-sync-state.json');

function loadState() {
  if (!existsSync(STATE_PATH)) return { lastUID: 0 };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastUID: 0 }; }
}

function saveState(s) {
  writeFileSync(STATE_PATH, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }));
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function handleMessage(client, uid) {
  if (wasProcessed(uid)) return;

  let parsed;
  try {
    const raw = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!raw?.source) return;
    parsed = await simpleParser(raw.source);
  } catch (e) {
    log(`Fetch/parse error uid=${uid}: ${e.message}`);
    return;
  }

  const fromAddress = parsed.from?.value?.[0]?.address ?? '';
  const emailDate   = parsed.date?.toISOString() ?? null;
  const subject     = parsed.subject ?? '';
  const text        = parsed.text    ?? '';

  // ── 1. LinkedIn application confirmation ───────────────────────────────────
  const linkedinResult = parseLinkedInConfirmation(fromAddress, subject, parsed.html ?? '');

  if (linkedinResult) {
    const existing = findApplication(linkedinResult.company, linkedinResult.role);
    let appId;
    if (existing) {
      appId = existing.id;
      patchJobUrl(appId, linkedinResult.jobUrl);
    } else {
      appId = createApplication({ ...linkedinResult, emailDate });
      log(`LinkedIn confirmation → "${linkedinResult.company}" / "${linkedinResult.role ?? 'unknown role'}" — created ${appId}`);
    }
    if (linkedinResult.jobUrl) {
      const id = appId;
      fetchJobDetails(linkedinResult.jobUrl).then(d => { if (d) enrichApplication(id, d); }).catch(() => {});
    }
    logEmail({ uid, date: emailDate, subject, matched: true, applicationId: appId });
    return;
  }

  // ── 2. Company follow-up email ─────────────────────────────────────────────
  const activeApps = getActiveApplications();
  const matchedApp = matchEmailToApplication(fromAddress, subject, text, activeApps);

  if (matchedApp) {
    const classification = classifyFollowup(subject, text);
    if (classification) {
      const summary = `[${classification.type.replace(/_/g, ' ')}] ${subject}`;
      logFollowupInteraction({
        applicationId: matchedApp.id,
        subject, date: emailDate,
        type:         classification.interactionType,
        summary,
        statusUpdate: classification.statusUpdate,
      });
      log(`Follow-up: ${fromAddress} → ${matchedApp.company} [${classification.type}, ${classification.confidence}]`);
      logEmail({ uid, date: emailDate, subject, matched: true, applicationId: matchedApp.id });
    } else {
      logEmail({ uid, date: emailDate, subject, matched: false });
    }
    return;
  }

  // ── 3. Unrelated ───────────────────────────────────────────────────────────
  logEmail({ uid, date: emailDate, subject, matched: false });
}

async function runOnce(client, state) {
  const mailbox = await client.mailboxOpen('INBOX');
  if (mailbox.exists === 0) return state;

  // On first run (lastUID=0) limit to last 90 days to avoid full inbox scan
  let uids;
  if (state.lastUID === 0) {
    // First run: only fetch LinkedIn emails from the last 90 days instead of the full inbox
    const since = new Date(Date.now() - 90 * 86_400_000);
    uids = await client.search({ since, from: 'linkedin.com' }, { uid: true });
  } else {
    uids = await client.search({ uid: `${state.lastUID + 1}:*` }, { uid: true });
  }

  if (uids.length > 0) {
    log(`Sweeping ${uids.length} new message(s)...`);
    // search already gave us UIDs — iterate directly, no fetch stream needed
    for (const uid of uids) {
      await handleMessage(client, uid);
      if (uid > state.lastUID) {
        state.lastUID = uid;
        saveState(state); // persist after each message so restarts resume here
      }
    }
  }

  return state;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg?.password) {
    log('ERROR: No credentials found. Run the configure_email tool in Claude to set your iCloud app-specific password.');
    process.exit(1);
  }

  const imapOpts = {
    host:   cfg.host   ?? DEFAULTS.host,
    port:   cfg.port   ?? DEFAULTS.port,
    secure: cfg.secure ?? DEFAULTS.secure,
    auth:   { user: cfg.username, pass: cfg.password },
    logger: false,
  };

  let retryDelay = 5_000;
  const state = loadState();

  while (true) {
    const client = new ImapFlow({ ...imapOpts, socketTimeout: 300_000 });
    // Prevent unhandled error events from crashing the process;
    // the broken socket will surface as a thrown error on the next await.
    client.on('error', (err) => log(`IMAP socket error: ${err.message}`));
    try {
      await client.connect();
      log(`Connected to ${imapOpts.host} as ${cfg.username}`);
      retryDelay = 5_000;

      // Catch-up sweep
      await runOnce(client, state);

      // IDLE loop — stays alive until connection drops or new mail arrives
      log('Entering IDLE — watching for LinkedIn emails...');
      const lock = await client.getMailboxLock('INBOX');
      try {
        while (true) {
          await client.idle(); // blocks; resolves on EXISTS/BYE/timeout

          const newUids = await client.search({ uid: `${state.lastUID + 1}:*` }, { uid: true });
          if (newUids.length > 0) {
            for (const uid of newUids) {
              await handleMessage(client, uid);
              if (uid > state.lastUID) state.lastUID = uid;
            }
            saveState(state);
          }
        }
      } finally {
        lock.release();
      }

    } catch (e) {
      log(`Connection error: ${e.message} — reconnecting in ${retryDelay / 1000}s`);
      try { await client.logout(); } catch {}
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 5 * 60_000); // cap at 5 min
    }
  }
}

main();
