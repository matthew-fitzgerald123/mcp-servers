import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { buildBridge } from '../scripts/build.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH  = join(__dirname, '..', 'bin', 'eventkit-bridge');

function bridge(...args) {
  const r = spawnSync(BIN_PATH, args, { encoding: 'utf8', timeout: 10_000 });
  if (r.error) throw new Error(`Bridge spawn error: ${r.error.message}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch {
    throw new Error(`Bridge bad output: ${r.stdout?.slice(0, 200)}`);
  }
  if (!parsed.ok) throw new Error(parsed.error ?? 'Unknown bridge error');
  return parsed.data;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

try {
  buildBridge();
} catch (e) {
  process.stderr.write(`[calendar-eventkit] Build error: ${e.message}\n`);
  process.exit(1);
}

const server = new McpServer({ name: 'calendar-eventkit', version: '1.0.0' });

// ── list_calendars ──────────────────────────────────────────────────────────

server.tool(
  'list_calendars',
  'List all available Apple Calendar calendars with their IDs, titles, and colors.',
  {},
  async () => {
    try { return ok(bridge('list_calendars')); }
    catch (e) { return err(e.message); }
  }
);

// ── list_events ─────────────────────────────────────────────────────────────

server.tool(
  'list_events',
  'List calendar events in a date range. Defaults to the next 7 days.',
  {
    start:      z.string().optional().describe('Start datetime ISO 8601 (default: now)'),
    end:        z.string().optional().describe('End datetime ISO 8601 (default: 7 days from now)'),
    calendarId: z.string().optional().describe('Filter by calendar ID or name')
  },
  async ({ start, end, calendarId }) => {
    try {
      const s = start ?? new Date().toISOString();
      const e = end   ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
      const args = ['list_events', s, e, ...(calendarId ? [calendarId] : [])];
      return ok(bridge(...args));
    } catch (e) { return err(e.message); }
  }
);

// ── get_event ───────────────────────────────────────────────────────────────

server.tool(
  'get_event',
  'Get full details of a calendar event by ID.',
  { id: z.string().describe('Event identifier') },
  async ({ id }) => {
    try { return ok(bridge('get_event', id)); }
    catch (e) { return err(e.message); }
  }
);

// ── create_event ────────────────────────────────────────────────────────────

server.tool(
  'create_event',
  'Create a new calendar event.',
  {
    title:        z.string().describe('Event title'),
    start:        z.string().describe('Start datetime ISO 8601'),
    end:          z.string().describe('End datetime ISO 8601'),
    allDay:       z.boolean().optional().describe('All-day event'),
    location:     z.string().optional().describe('Event location'),
    notes:        z.string().optional().describe('Event notes / description'),
    url:          z.string().optional().describe('Event URL'),
    calendar:     z.string().optional().describe('Calendar name or ID (defaults to default calendar)'),
    alertMinutes: z.number().int().optional().describe('Reminder N minutes before start')
  },
  async (params) => {
    try { return ok(bridge('create_event', JSON.stringify(params))); }
    catch (e) { return err(e.message); }
  }
);

// ── update_event ────────────────────────────────────────────────────────────

server.tool(
  'update_event',
  'Update an existing calendar event. All fields are optional (partial update).',
  {
    id:           z.string().describe('Event identifier'),
    title:        z.string().optional(),
    start:        z.string().optional().describe('ISO 8601'),
    end:          z.string().optional().describe('ISO 8601'),
    allDay:       z.boolean().optional(),
    location:     z.string().optional(),
    notes:        z.string().optional(),
    url:          z.string().optional(),
    calendar:     z.string().optional().describe('Calendar name or ID'),
    alertMinutes: z.number().int().optional(),
    allFuture:    z.boolean().optional().describe('Apply to all future occurrences of a recurring event')
  },
  async ({ id, ...updates }) => {
    try { return ok(bridge('update_event', id, JSON.stringify(updates))); }
    catch (e) { return err(e.message); }
  }
);

// ── delete_event ────────────────────────────────────────────────────────────

server.tool(
  'delete_event',
  'Delete a calendar event.',
  {
    id:  z.string().describe('Event identifier'),
    all: z.boolean().optional().describe('Delete all occurrences of a recurring event')
  },
  async ({ id, all }) => {
    try {
      return ok(bridge('delete_event', id, ...(all ? ['all'] : [])));
    } catch (e) { return err(e.message); }
  }
);

// ── search_events ───────────────────────────────────────────────────────────

server.tool(
  'search_events',
  'Search events by text in title, notes, or location. Searches 90 days back and 365 days forward.',
  { query: z.string().describe('Search query') },
  async ({ query }) => {
    try { return ok(bridge('search_events', query)); }
    catch (e) { return err(e.message); }
  }
);

// ── get_availability ────────────────────────────────────────────────────────

server.tool(
  'get_availability',
  'Check whether a time slot has conflicts. Returns available=true if no events exist in the range.',
  {
    start: z.string().describe('Start datetime ISO 8601'),
    end:   z.string().describe('End datetime ISO 8601')
  },
  async ({ start, end }) => {
    try {
      const events = bridge('list_events', start, end);
      return ok({ available: events.length === 0, conflicts: events });
    } catch (e) { return err(e.message); }
  }
);

// ── connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
