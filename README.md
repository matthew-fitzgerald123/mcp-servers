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
Watches your iCloud inbox via IMAP IDLE and automatically imports job applications and follow-up emails into the tracker.

**What it does:**
- Detects LinkedIn "application sent" confirmation emails and creates tracker entries
- Fetches job details (title, description, location, seniority) from LinkedIn's guest API
- Matches follow-up emails from companies to existing applications using a multi-signal scorer (sender domain + company name in subject/body + role title in body)
- Classifies email sentiment: `rejection`, `interview`, `offer`, `next_steps`, `position_closed`
- Logs each match as an interaction and auto-updates application status on clear signals (rejections, offers)

**Tools:** `configure_email`, `sweep_linkedin_emails`, `sweep_followup_emails`, `get_sync_status`, `enrich_applications`

**Daemon:** `daemon/index.js` runs as a persistent launchd agent, processing every new email in real time via IMAP IDLE.

Credentials are stored at `~/.job-tracker/email-config.json` (never committed).

---

### `calendar-eventkit`
Native Apple Calendar integration via a Swift CLI bridge compiled on first run.

**Tools:** `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `search_events`, `get_availability`

---

## Prerequisites

- macOS 13+
- Node.js 18+
- Xcode Command Line Tools (`xcode-select --install`) — for the calendar server Swift bridge

## Setup

```bash
git clone https://github.com/matthew-fitzgerald123/mcp-servers
cd mcp-servers

# Install dependencies for each server
cd job-tracker && npm install && cd ..
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

### Email sync daemon (iCloud)

1. Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com) under Sign-In & Security
2. In Claude Desktop, run: `configure email you@icloud.com with app password xxxx-xxxx-xxxx-xxxx`
3. Start the daemon:
```bash
cp email-job-sync/com.example.email-job-sync.plist ~/Library/LaunchAgents/
xattr -d com.apple.provenance ~/Library/LaunchAgents/com.example.email-job-sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.email-job-sync.plist
```

---

## Architecture

```
mcp-servers/
├── job-tracker/
│   └── src/index.js          # MCP server + SQLite schema
├── email-job-sync/
│   ├── src/index.js          # MCP server (sweep tools, configure)
│   ├── daemon/index.js       # IMAP IDLE background process
│   └── lib/
│       ├── classifier.js     # Email matching + sentiment classification
│       ├── linkedin.js       # LinkedIn email parsing + job detail fetching
│       ├── db.js             # Shared DB operations (job-tracker schema)
│       └── config.js         # Credential loading
└── calendar-eventkit/
    ├── src/index.js          # MCP server
    ├── scripts/build.js      # Auto-compiles Swift bridge on first run
    └── swift/EventKitBridge.swift
```

Data flow:

```
LinkedIn email arrives
  → IMAP IDLE wakes daemon
  → Parse confirmation → create application in tracker
  → Fetch job details from LinkedIn guest API → enrich application

Company follow-up email arrives
  → Score against all active applications (domain + subject + body + role)
  → Classify sentiment → log as interaction
  → Auto-update status on rejection or offer
```

---

## Roadmap

### Near-term

- [ ] **Auto-create applications from follow-up emails** — when an email scores high enough but no matching application exists, create one automatically rather than silently dropping it
- [ ] **Gmail / OAuth support** — currently iCloud-only via app-specific passwords
- [ ] **Calendar integration** — when an interview is scheduled (detected from email), auto-create a calendar event via `calendar-eventkit`
- [ ] **Status auto-progression suggestions** — when a follow-up changes context (e.g. scheduled a call), suggest the appropriate status update

### Medium-term

- [ ] **Interview prep assistant** — pull `job_description` + `prep_notes` and generate targeted prep questions
- [ ] **Daily digest tool** — overdue follow-ups, upcoming interviews, stale applications, pipeline summary in one view
- [ ] **Offer comparison** — side-by-side view of compensation, role, location across multiple offers
- [ ] **Browser extension** — one-click capture of a job posting directly into the tracker from LinkedIn, Greenhouse, Lever, etc.

### Longer-term

- [ ] **Company research enrichment** — pull funding, headcount, recent news into application notes automatically
- [ ] **Outreach drafting** — generate cold outreach or referral request messages using contact + company context
- [ ] **Recruiter CRM** — track recruiter relationships across applications and companies
