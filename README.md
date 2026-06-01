# mcp-servers

A collection of MCP (Model Context Protocol) servers that give Claude real-world tools for job searching, calendar management, and email intelligence — all running locally with no third-party cloud services.

---

## Servers

### `job-tracker`
SQLite-backed job application lifecycle tracker. Stores applications, contacts, interactions, and prep notes. Exposes 14 MCP tools for querying and updating your pipeline conversationally.

**Tools:** `add_application`, `update_application`, `list_applications`, `get_application`, `delete_application`, `log_interaction`, `list_interactions`, `add_contact`, `list_contacts`, `save_prep_notes`, `get_prep_notes`, `get_pipeline_summary`, `get_followups_due`, `draft_followup_email`

Database lives at `~/.job-tracker/tracker.db`.

---

### `email-job-sync`
Watches your iCloud inbox via IMAP IDLE and automatically imports job applications and follow-up emails into the tracker — no manual input required.

**Application detection:** Parses confirmation emails from LinkedIn Easy Apply and all major ATS platforms. When you apply anywhere and receive a confirmation email, it is automatically imported.

Supported senders:
- LinkedIn (`jobs-noreply@linkedin.com`)
- Greenhouse (`greenhouse.io`)
- Lever (`hire.lever.co`)
- Workable (`workable.com`)
- Ashby (`ashbyhq.com`)
- Workday (`myworkdayjobs.com`)
- SmartRecruiters, BambooHR, iCIMS, Recruitee, and more

**Follow-up detection:** Matches subsequent emails from company domains to existing applications using a multi-signal scorer (sender domain + company name in subject/body + role title). Classifies sentiment and logs as interactions:
- `rejection` / `position_closed` → marks application rejected
- `offer_received` → marks application as offer
- `interview` / `next_steps` → logs interaction, no status change

**Tools:** `configure_email`, `sweep_linkedin_emails`, `sweep_followup_emails`, `get_sync_status`, `enrich_applications`

**Daemon:** `daemon/index.js` runs as a persistent launchd agent, processing every new email in real time via IMAP IDLE. Credentials are stored at `~/.job-tracker/email-config.json` (never committed).

---

### `calendar-eventkit`
Native Apple Calendar integration via a Swift CLI bridge compiled automatically on first run.

**Tools:** `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `search_events`, `get_availability`

---

## Prerequisites

- macOS 13+
- Node.js 18+
- Xcode Command Line Tools (`xcode-select --install`) — required for the calendar server Swift bridge

---

## Setup

```bash
git clone https://github.com/matthew-fitzgerald123/mcp-servers
cd mcp-servers

cd job-tracker    && npm install && cd ..
cd email-job-sync && npm install && cd ..
cd calendar-eventkit && npm install && cd ..
```

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "job-tracker": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/mcp-servers/job-tracker/src/index.js"]
    },
    "email-job-sync": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/mcp-servers/email-job-sync/src/index.js"]
    },
    "calendar-eventkit": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/mcp-servers/calendar-eventkit/src/index.js"]
    }
  }
}
```

### Email sync daemon

1. Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com) → Sign-In & Security → App-Specific Passwords
2. In Claude Desktop: `configure email you@icloud.com with app password xxxx-xxxx-xxxx-xxxx`
3. Start the daemon:

```bash
# Copy the plist, strip the quarantine attribute Safari adds, then load
cp email-job-sync/com.matthewfitzgerald.email-job-sync.plist ~/Library/LaunchAgents/
xattr -d com.apple.provenance ~/Library/LaunchAgents/com.matthewfitzgerald.email-job-sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.matthewfitzgerald.email-job-sync.plist
```

Logs: `~/.job-tracker/daemon.log`

---

## Architecture

```
mcp-servers/
├── job-tracker/
│   └── src/index.js            # MCP server + SQLite schema
├── email-job-sync/
│   ├── src/index.js            # MCP server (sweep, configure, enrich tools)
│   ├── daemon/index.js         # IMAP IDLE background process
│   └── lib/
│       ├── classifier.js       # Email matching + sentiment scoring
│       ├── linkedin.js         # ATS/LinkedIn confirmation parsing + job detail fetching
│       ├── db.js               # Shared DB operations
│       └── config.js           # Credential loading from ~/.job-tracker/email-config.json
└── calendar-eventkit/
    ├── src/index.js            # MCP server
    ├── scripts/build.js        # Auto-compiles Swift bridge on first run
    └── swift/EventKitBridge.swift
```

### Data flow

```
You apply via LinkedIn Easy Apply
  → LinkedIn sends confirmation email
  → IMAP IDLE wakes daemon
  → Parse confirmation → create application
  → Fetch job details from LinkedIn guest API → enrich record

You apply via company website (Greenhouse, Lever, Workday, etc.)
  → ATS sends "thanks for applying" confirmation email
  → IMAP IDLE wakes daemon
  → Parse ATS confirmation → create application

Company sends follow-up (rejection, interview invite, offer)
  → Score email against active applications (domain + subject + body + role)
  → Classify sentiment → log as interaction
  → Auto-update status on rejection or offer
```

---

## Roadmap

### Near-term
- [ ] Auto-create applications from follow-up emails when no matching application exists
- [ ] Gmail / OAuth support alongside iCloud
- [ ] Calendar event creation when an interview is scheduled (detected from email)
- [ ] Status auto-progression suggestions based on email context

### Medium-term
- [ ] Interview prep assistant using job description and prep notes
- [ ] Daily digest: overdue follow-ups, upcoming interviews, pipeline summary
- [ ] Offer comparison tool across multiple simultaneous offers
- [ ] Outreach drafting using contact and company context

### Longer-term
- [ ] Company research enrichment pulled into application notes
- [ ] Recruiter CRM across companies and applications
