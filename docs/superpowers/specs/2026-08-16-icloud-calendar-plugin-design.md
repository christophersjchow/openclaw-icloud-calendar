# openclaw-icloud-calendar fork: design

Date: 2026-08-16

## Goal

An OpenClaw plugin fork that reads and writes Apple iCloud Calendar server-to-server over CalDAV, authenticated with an Apple Account email and an app-specific password. It adds external email invitations and per-occurrence recurring-event changes while retaining the upstream plugin's constrained interface.

Single account per install. The fork is built into the family OpenClaw image at a pinned Git commit; it is not published under the upstream ClawHub package.

## Non-goals

- Reminders (VTODO), Contacts (CardDAV), free/busy
- Two-parent approvals, automated family planning, delivery retries/monitoring
- Multi-account per agent
- CLI or MCP surface (OpenClaw plugin only)

## Approach

Hand-rolled zero-runtime-dependency CalDAV client (`fetch` + a small namespace-aware XML parser scoped to DAV multistatus responses). `@sinclair/typebox` is used only for tool parameter schemas (same as openclaw-parcel); `openclaw` is the SDK peer.

## Components

```
src/
  index.ts              OpenClaw entry: definePluginEntry, resolve config/secret, register tools
  config.ts             config parsing, SecretRef resolution (env | file+jsonPointer), tz default
  errors.ts             CalDavError with typed codes
  caldav/
    xml.ts              minimal XML parser + DAV request body builders
    client.ts           fetch wrapper: Basic auth, PROPFIND/REPORT/GET/PUT/DELETE, manual redirects, status mapping
    discovery.ts        current-user-principal -> calendar-home-set -> calendar list; cached Session
    query.ts            calendar-query (time-range), UID lookup, multiget
  ical/
    component.ts        iCalendar tree parse/serialize (unfold, escape, fold), preserves unknown props
    tz.ts               ISO <-> iCal date conversion with Intl (no tz lib)
    event.ts            Component -> Event JSON; Event input -> Component; patch
    rrule.ts            RRULE parse/build + best-effort occurrence expansion
  tools/
    schemas.ts          typebox schemas for the tools
    handlers.ts         tool args -> caldav/ical -> JSON result
  sanitize.ts           datamarking of untrusted free text (port of apple-pim lib/sanitize.js)
skills/icloud-calendar/SKILL.md
```

Data flow (read): tool call -> handler -> Session (discovery, cached) -> REPORT -> ICS -> event.ts -> JSON -> sanitize -> result.
Data flow (write): JSON -> event.ts -> ICS -> PUT (`If-None-Match: *` on create, `If-Match: etag` on update) -> re-GET -> event + `verification`.

## Tools

| Tool | Params | Notes |
|---|---|---|
| `icloud_calendar_list` | none | `[{id, name, color, readOnly, ctag}]`; `id` = last path segment of the calendar href |
| `icloud_calendar_events` | `from`, `to` (default now..+7d), `calendar?`, `limit?` (200) | Merged across calendars, sorted by start. Recurring masters include `recurrence` and `nextOccurrences` (best-effort, cap 50) |
| `icloud_calendar_get` | `uid`, `calendar?` | Searches all calendars if not given |
| `icloud_calendar_create` | `title`, `start`, `end?`/`duration?`, `calendar`, `attendees?`, event fields | New UID; attendee properties use configured organizer identity |
| `icloud_calendar_update` | `uid`, `calendar?`, event fields, `addAttendees?`, `removeAttendees?`, `occurrenceStart?` | Patch series or one validated recurrence instance; 412 -> one refetch+retry |
| `icloud_calendar_delete` | `uid`, `calendar?`, `occurrenceStart?` | Delete series, or write a cancelled `RECURRENCE-ID` override for one instance |

Event JSON includes `{ uid, calendarId, calendar, title, start, end, allDay, timezone, location?, notes?, url?, status?, attendees?, recurrence?, nextOccurrences?, occurrenceOverrides?, alarms?, etag, lastModified?, readOnly }`.

Times: ISO 8601 with offset in the configured `timezone`; all-day as `YYYY-MM-DD`. Naive inputs are interpreted in `timezone`. Written as UTC (`Z`) except all-day (`VALUE=DATE`).

## Config

| Key | Type | Notes |
|---|---|---|
| `appleId` | string, required | Apple Account email |
| `appPassword` | string / `${ENV}` / SecretRef, required | `uiHints.sensitive` |
| `organizerEmail` | string | Defaults to `appleId`; should identify the owner/organizer of events being invited |
| `timezone` | IANA string, default host tz | validated with Intl |
| `serverUrl` | string, default `https://caldav.icloud.com` | must be https unless localhost |
| `calendars` | string[] | allowlist by id or name; empty = all |
| `readOnly` | boolean, default false | write tools are not registered |

Env fallbacks: `ICLOUD_APPLE_ID`, `ICLOUD_APP_PASSWORD`, `ICLOUD_ORGANIZER_EMAIL`.

## Security

- Basic auth over TLS only.
- Secret resolved once in `register()`, held in closure; never in results, logs, or errors.
- Destructive tools require exact `uid`; no bulk ops.
- Single-occurrence changes require an exact original recurrence start and a supported RRULE match.
- Attendee edits are allowed only on events organized by the configured account. Work calendar APIs are not used.
- All server-sourced free text, including attendee names, is datamarked; suspicious instruction-like text is flagged.
- `contracts.tools` lists every tool.

## Errors

`auth_failed`, `not_found`, `conflict`, `read_only_calendar`, `invalid_input`, `server_error`. Discovery cache invalidated on 404/3xx from a cached href. One retry on 5xx/network error.

## Testing

- vitest unit tests: iCal round-trips (all-day, UTC, TZID, floating, RRULE, EXDATE, VALARM, folding, escaping), XML parser on captured multistatus fixtures, tz DST boundaries, client with injected fetch mock (headers, Depth, If-Match, 401/412/404/redirect).
- Integration (opt-in via `ICLOUD_INTEGRATION=1`, `ICLOUD_TEST_APPLE_ID`, `ICLOUD_TEST_APP_PASSWORD`, `ICLOUD_TEST_CALENDAR`): use a separate test calendar and controlled mailbox to verify invite, update, reassignment/cancellation, and recurring-exception delivery. Mock tests cannot establish that iCloud sent invitation email.
