import { z } from 'zod'
import * as g from '../../lib/google.js'
import { getSecret } from '../../lib/vault.js'

const has = (sec, scope) => String(sec?.scope || '').includes(scope)

export const google = {
  name: 'google',
  title: 'Google (Gmail·캘린더·Drive)',
  connected: async (userId) => {
    const sec = await getSecret(userId, 'oauth', 'google')
    return !!sec?.refresh_token || !!sec?.access_token
  },
  // tools whose scope the user has not granted are hidden instead of failing at call time
  scopes: {
    calendar_create_event: 'calendar.events', calendar_update_event: 'calendar.events',
    gmail_draft: 'gmail.compose', drive_search: 'drive', drive_read: 'drive',
  },
  allowed: async (userId, tool) => {
    const need = google.scopes[tool]
    if (!need) return true
    return has(await getSecret(userId, 'oauth', 'google'), need)
  },
  tools: [
    {
      name: 'calendar_find_events',
      description: 'Find events in the user\'s Google Calendar between timeMin and timeMax (ISO dates or datetimes), optionally matching text q. Use before creating events to avoid duplicates.',
      input: { timeMin: z.string(), timeMax: z.string(), q: z.string().optional() },
      run: (u, a) => g.calendarList(u, a),
    },
    {
      name: 'calendar_create_event',
      description: 'Create a Google Calendar event. start is YYYY-MM-DD for all-day, or an ISO datetime with offset (e.g. 2026-11-10T22:30:00+09:00).',
      input: { summary: z.string(), start: z.string(), durationMin: z.number().int().optional(), description: z.string().optional(), location: z.string().optional() },
      run: (u, a) => g.calendarCreate(u, a),
    },
    {
      name: 'calendar_update_event',
      description: 'Update fields of an existing calendar event by id.',
      input: { eventId: z.string(), summary: z.string().optional(), start: z.string().optional(), durationMin: z.number().int().optional(), description: z.string().optional(), location: z.string().optional() },
      run: (u, a) => g.calendarUpdate(u, a),
    },
    {
      name: 'gmail_search',
      description: 'Search the user\'s Gmail with Gmail query syntax (e.g. "from:x newer_than:7d"). Returns sender, subject, date, snippet.',
      input: { query: z.string(), max: z.number().int().max(30).optional() },
      run: (u, a) => g.gmailSearch(u, a),
    },
    {
      name: 'gmail_read',
      description: 'Read one Gmail message by id (plain text body).',
      input: { id: z.string() },
      run: (u, a) => g.gmailRead(u, a),
    },
    {
      name: 'gmail_draft',
      description: 'Create a Gmail draft (never sends). The user reviews and sends it.',
      input: { to: z.string(), subject: z.string(), body: z.string() },
      run: (u, a) => g.gmailDraft(u, a),
    },
    {
      name: 'drive_search',
      description: 'Full-text search in the user\'s Google Drive.',
      input: { query: z.string(), max: z.number().int().max(30).optional() },
      run: (u, a) => g.driveSearch(u, a),
    },
    {
      name: 'drive_read',
      description: 'Read a Drive file as text (Docs → text, Sheets → CSV).',
      input: { fileId: z.string() },
      run: (u, a) => g.driveRead(u, a),
    },
  ],
}
