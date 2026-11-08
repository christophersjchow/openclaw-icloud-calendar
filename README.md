# openclaw-icloud-calendar

OpenClaw plugin fork that reads and writes **Apple iCloud Calendar** directly over CalDAV, using an
Apple ID and an app-specific password. It adds email invitations and safe single-occurrence edits
to recurring events while preserving the upstream plugin's constrained tool interface.

Zero runtime dependencies for the CalDAV path: `fetch` plus a small XML/iCalendar layer written
for exactly the responses iCloud sends.

## Tools

| Tool | What it does |
|------|--------------|
| `icloud_calendar_list` | Calendars available to the account (id, name, color, readOnly) |
| `icloud_calendar_events` | Events in a range (default next 7 days), one calendar or all, sorted |
| `icloud_calendar_get` | One event by UID |
| `icloud_calendar_create` | New event, optionally inviting email attendees |
| `icloud_calendar_update` | Change event fields or add/remove attendees; optionally target one recurring occurrence |
| `icloud_calendar_delete` | Delete an event/series or cancel one recurring occurrence |

Set `readOnly: true` and the three write tools are not registered at all.

## Install

This fork is built into the family OpenClaw image from a pinned Git commit. It is not published to
ClawHub or npm, so the upstream ClawHub package will not include the invitation or occurrence
changes. For a separate test Gateway, install a reviewed immutable fork revision with OpenClaw's
Git source:

```bash
openclaw plugins install git:github.com/christophersjchow/openclaw-icloud-calendar@<commit-sha> --force
```

## Setup

1. Turn on two-factor authentication for your Apple Account if it is not already on.
2. Create an app-specific password at <https://account.apple.com> → Sign-In and Security →
   App-Specific Passwords. Name it "OpenClaw". Copy the `xxxx-xxxx-xxxx-xxxx` value.
3. Make it available to the gateway as an environment variable named `ICLOUD_APP_PASSWORD` (or store
   it in `~/.openclaw/secrets.json` and reference it with a SecretRef, see below).

4. Configure the plugin in `openclaw.json`:

   ```jsonc
   {
     "plugins": {
       "entries": {
         "openclaw-icloud-calendar": {
           "enabled": true,
           "config": {
             "appleId": "you@icloud.com",
             "organizerEmail": "you@icloud.com",
             "appPassword": "${ICLOUD_APP_PASSWORD}",
             "timezone": "Australia/Sydney",
             "calendars": ["Family"],
             "readOnly": true
           }
         }
       }
     }
   }
   ```

   `appPassword` also accepts a SecretRef (`{"source":"env","provider":"env","id":"ICLOUD_APP_PASSWORD"}`
   or `{"source":"file","provider":"secrets","id":"/icloud/appPassword"}` pointing into
   `~/.openclaw/secrets.json`). Plain strings work but are discouraged.

   Without any config, the plugin falls back to `ICLOUD_APPLE_ID` and `ICLOUD_APP_PASSWORD`
   environment variables. `ICLOUD_ORGANIZER_EMAIL` can override the organizer address; otherwise
   it defaults to the Apple ID.

## Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `appleId` | string | | Apple Account email. Required. |
| `appPassword` | string / `${ENV}` / SecretRef | | App-specific password. Required. Never your Apple Account password. |
| `organizerEmail` | string | `appleId` | Calendar owner address used as the invitation organizer. |
| `timezone` | IANA string | host time zone | Used to interpret naive times the agent sends and to format results. |
| `serverUrl` | string | `https://caldav.icloud.com` | Must be `https`. Any CalDAV server that speaks the same dialect should work, but iCloud is what is tested. |
| `calendars` | string[] | all | Allowlist of calendar ids or names the agent may see and modify. |
| `readOnly` | boolean | `true` | Do not register create/update/delete. Set false only on a disposable test gateway. The family deployment remains read-only until its approval path exists. |

## Behavior worth knowing

- **Times.** Results are ISO 8601 with an offset in `timezone`; all-day events use `YYYY-MM-DD`
  with an inclusive `end`. Inputs may be naive local (`2026-08-20T09:00`), `Z`, or offset times.
  Timed events are written to iCloud in UTC; all-day events as `VALUE=DATE`.
- **Invitations.** Create accepts `attendees: [{email, name?}]`. Update accepts `addAttendees` and
  `removeAttendees` so unrelated invitees are preserved. The configured Apple account is written as
  `ORGANIZER`; invitees are written as `ATTENDEE` properties with `RSVP=TRUE` and
  `PARTSTAT=NEEDS-ACTION`. A changed event is PUT to CalDAV and the iCloud scheduling service is
  expected to send or update standard calendar email invitations. Apple/iCloud delivery is not
  proven by the mock tests; complete the manual test below with a separate iCloud test calendar
  before enabling writes in a live family calendar. The payload follows [iCalendar RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html)
  and the server-side delivery expectation follows [CalDAV Scheduling RFC 6638](https://www.rfc-editor.org/rfc/rfc6638.html);
  neither standard confirms Apple's production behavior. Work calendar APIs are not used, and
  recipients must accept invitations according to their email/calendar client.
- **Recurring events.** Queries return the series master with `recurrence`, `nextOccurrences`, and
  details for existing `occurrenceOverrides`; moved and cancelled instances are reflected in
  upcoming occurrences. Update/delete accept `occurrenceStart` to target an original instance start.
  The plugin validates that it belongs to a supported RRULE, then writes a `RECURRENCE-ID` override;
  deleting one writes a `STATUS:CANCELLED` override. Omit `occurrenceStart` only when intending to
  modify the whole series. Unknown recurrence rules and RDATE-only instances are rejected for
  per-instance edits rather than guessed.
- **Idempotency.** Re-adding an existing attendee or cancelling an already-cancelled instance does
  not write the calendar object again. No-op event updates are also skipped so the server does not
  send redundant invitation updates.
- **Concurrency.** Updates and deletes send `If-Match` with the etag from the last read. On a 412 the
  plugin re-reads once and retries; a second conflict returns `conflict`.
- **Verification.** `create` and time-changing `update` return a `verification` block comparing what
  was requested with what iCloud stored, so date parsing drift is visible to the agent.
- **Discovery.** Principal and calendar-home discovery follow iCloud's redirects to the per-account
  `pNN-caldav.icloud.com` host and are cached; a 404 on a cached URL triggers rediscovery.
- **Credential hygiene.** Credentials are sent only to hosts within the configured server's domain
  (`*.icloud.com` by default); redirects to any other host are refused.
- **UID lookup.** iCloud answers `calendar-query` UID prop-filters with a bare 412, so lookups try
  `GET <calendar>/<uid>.ics` first (how Apple clients and this plugin name objects) and fall back to
  scanning the calendar. Pass `calendar` to update/get/delete when you know it; it avoids the scan.
- **Untrusted content.** Titles, notes, locations, URLs and attendee names are wrapped in per-session
  `[UNTRUSTED_CALENDAR_DATA_…]` markers and instruction-like text is flagged, so the agent does not
  treat invitation text as commands.
- **Errors.** Tool results carry `error.code`: `auth_failed`, `not_found`, `conflict`,
  `read_only_calendar`, `invalid_input`, `not_configured`, `server_error`.

## Troubleshooting

- `auth_failed` with credentials you are sure about: you are using the Apple Account password. Only
  app-specific passwords work over CalDAV. Also note Apple revokes every app-specific password when
  you change your Apple Account password.
- Nothing listed / calendar missing: shared calendars you only have read access to and the Birthdays
  calendar show as `readOnly`; reminder lists (VTODO) are hidden on purpose.
- Times off by hours: set `timezone` explicitly. The default is the gateway host's zone.

## Development

```bash
npm install
npm test                # unit + fake-server tests, no network
npm run typecheck
npm run build
npm run plugin:check    # @openclaw/plugin-inspector
```

Live test against a real account (creates and deletes one `[openclaw-test]` event):

```bash
ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com ICLOUD_TEST_APP_PASSWORD=<app-specific password> \
ICLOUD_TEST_CALENDAR="OpenClaw Test" npm run test:integration
```

Set `ICLOUD_TEST_ATTENDEE_EMAIL` to exercise invite and recurring-instance
changes. Optionally set `ICLOUD_TEST_REPLACEMENT_ATTENDEE_EMAIL` to exercise
reassignment. Both must be mailboxes you control. The integration suite refuses
to run without an explicitly named calendar whose name includes `test`,
`sandbox` or `staging`; it rejects the Family calendar name. Never point it at
the Family calendar. It verifies iCloud's stored data, not mailbox delivery.

Design notes live in `docs/superpowers/specs/`.

## Manual invitation test (required before production writes)

Use a separate iCloud test calendar and a mailbox you control, not a work calendar integration:

1. Configure a dedicated Apple app-specific password, organizer email and
   test-calendar allowlist on a disposable Gateway. Both the default and
   production Gateway are read-only. Set `readOnly: false` only in the
   disposable test Gateway with the test-calendar allowlist configured.
2. Create a one-off event with a test mailbox as attendee. Confirm an invitation arrives and the
   event appears in that mailbox's calendar after acceptance.
3. Move the event and confirm the invitee receives one update. Repeat the exact same attendee add
   and confirm there is no second update.
4. Add a second test attendee and remove the first. Confirm the new invitation and cancellation
   reach the correct mailboxes, and the first attendee no longer receives updates.
5. Create a weekly test series spanning a daylight-saving transition. Move one occurrence, verify
   the master and other dates are unchanged, then cancel that one occurrence and verify its
   cancellation reaches the invitee.
6. Restart the test Gateway and confirm the event/override results are still read from iCloud.

The fake CalDAV tests validate the iCalendar payload and conditional writes; they cannot prove that
iCloud sends mail or that an external provider accepts it. Keep the family gateway read-only even
after the test succeeds until an enforced two-parent approval path is implemented.

## Current limitations

Reminders (VTODO), Contacts (CardDAV), free-busy, multiple accounts, a two-parent approval workflow,
weekly planning automation, and a transactional retry queue for invitation delivery. iCloud
invitation delivery, attendee acceptance, and responses depend on Apple's service and invitee email
provider; the plugin only verifies the calendar object returned by CalDAV.

## License

MIT
