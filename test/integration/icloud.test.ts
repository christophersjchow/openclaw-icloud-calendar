/**
 * Live integration test against a real iCloud account. Opt-in:
 *
 *   ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com \
 *   ICLOUD_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx ICLOUD_TEST_CALENDAR="OpenClaw Test" \
 *   npm run test:integration
 *
 * Creates, reads, updates and deletes test events in the explicitly named
 * calendar. Set ICLOUD_TEST_ATTENDEE_EMAIL to exercise invitation and
 * recurring-instance writes. Nothing else is touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import { CalDavClient } from "../../src/caldav/client.js";
import { Session } from "../../src/caldav/discovery.js";
import { handleCreate, handleDelete, handleEvents, handleGet, handleList, handleUpdate, type Context } from "../../src/tools/handlers.js";

const requested = process.env.ICLOUD_INTEGRATION === "1";
const testCalendar = process.env.ICLOUD_TEST_CALENDAR?.trim();
if (requested && !testCalendar) {
  throw new Error("ICLOUD_TEST_CALENDAR must name a separate, disposable iCloud test calendar");
}
if (requested && (/\bfamily\b/i.test(testCalendar!) || !/\b(test|sandbox|staging)\b/i.test(testCalendar!))) {
  throw new Error("ICLOUD_TEST_CALENDAR must name a separate test/sandbox/staging calendar, never the Family calendar");
}
const enabled = requested && !!process.env.ICLOUD_TEST_APPLE_ID && !!process.env.ICLOUD_TEST_APP_PASSWORD && !!testCalendar;
const invitationEnabled = enabled && !!process.env.ICLOUD_TEST_ATTENDEE_EMAIL?.trim();

describe.skipIf(!enabled)("live iCloud", () => {
  const appleId = process.env.ICLOUD_TEST_APPLE_ID!;
  const tz = process.env.ICLOUD_TEST_TZ || "Australia/Sydney";
  const client = new CalDavClient({ serverUrl: "https://caldav.icloud.com", username: appleId, password: process.env.ICLOUD_TEST_APP_PASSWORD! });
  const ctx: Context = { session: new Session(client), config: { appleId, appPassword: process.env.ICLOUD_TEST_APP_PASSWORD!, organizerEmail: process.env.ICLOUD_TEST_ORGANIZER_EMAIL || appleId, timezone: tz, serverUrl: "https://caldav.icloud.com", calendars: [testCalendar!], readOnly: false } };
  const calendar = testCalendar!;
  let uid: string | undefined;
  let inviteUid: string | undefined;

  afterAll(async () => {
    if (uid) await handleDelete(ctx, { uid }).catch(() => undefined);
    if (inviteUid) await handleDelete(ctx, { uid: inviteUid, calendar }).catch(() => undefined);
  });

  it("discovers calendars", async () => {
    const res = await handleList(ctx);
    expect(res.calendars.length).toBeGreaterThan(0);
    expect(res.calendars.map((c) => c.name)).toContain(calendar);
  });

  it("lists upcoming events without error", async () => {
    const res = await handleEvents(ctx, {});
    expect(Array.isArray(res.events)).toBe(true);
  });

  it("creates, gets, updates and deletes an event", async () => {
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) + "T15:00";
    const created = await handleCreate(ctx, { title: "[openclaw-test] integration", start, duration: 30, calendar, notes: "safe to delete", alarms: [10] });
    uid = created.event.uid;
    expect(created.verification.allFieldsMatch).toBe(true);
    const got = await handleGet(ctx, { uid, calendar });
    expect(got.title).toBe("[openclaw-test] integration");
    expect(got.alarms).toEqual([10]);
    const upd = await handleUpdate(ctx, { uid, calendar, title: "[openclaw-test] updated", location: "Nowhere" });
    expect(upd.event.title).toBe("[openclaw-test] updated");
    expect(upd.event.location).toBe("Nowhere");
    const del = await handleDelete(ctx, { uid, calendar });
    expect(del.deleted).toBe(true);
    uid = undefined;
  });

  it("creates and deletes an all-day recurring event", async () => {
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const created = await handleCreate(ctx, { title: "[openclaw-test] all-day weekly", start: day, calendar, recurrence: { frequency: "WEEKLY", count: 3 } });
    uid = created.event.uid;
    expect(created.event.allDay).toBe(true);
    expect(created.event.start).toBe(day);
    expect(created.event.recurrence).toEqual({ frequency: "WEEKLY", count: 3 });
    const listed = await handleEvents(ctx, { from: day, to: day, calendar });
    const mine = listed.events.find((e) => e.uid === uid);
    expect(mine?.nextOccurrences).toEqual([day]);
    const upd = await handleUpdate(ctx, { uid, calendar, clearRecurrence: true, alarms: [60] });
    expect(upd.event.recurrence).toBeUndefined();
    expect(upd.event.alarms).toEqual([60]);
    await handleDelete(ctx, { uid, calendar });
    uid = undefined;
  });

  it.skipIf(!invitationEnabled)("sends invite changes and edits a single recurring occurrence", async () => {
    const firstDay = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const secondDay = new Date(new Date(`${firstDay}T00:00:00Z`).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    const originalInvitee = process.env.ICLOUD_TEST_ATTENDEE_EMAIL!;
    const replacementInvitee = process.env.ICLOUD_TEST_REPLACEMENT_ATTENDEE_EMAIL?.trim();
    const created = await handleCreate(ctx, {
      title: "[openclaw-test] invited weekly run",
      start: `${firstDay}T09:00`,
      duration: 30,
      calendar,
      recurrence: { frequency: "WEEKLY", count: 3 },
      attendees: [{ email: originalInvitee }],
    });
    inviteUid = created.event.uid;
    expect(created.event.attendees?.map((attendee) => attendee.email)).toContain(originalInvitee.toLowerCase());

    await handleUpdate(ctx, { uid: inviteUid, calendar, addAttendees: [{ email: originalInvitee }] });
    if (replacementInvitee) {
      const reassigned = await handleUpdate(ctx, {
        uid: inviteUid,
        calendar,
        addAttendees: [{ email: replacementInvitee }],
        removeAttendees: [originalInvitee],
      });
      expect(reassigned.event.attendees?.map((attendee) => attendee.email)).toContain(replacementInvitee.toLowerCase());
      expect(reassigned.event.attendees?.map((attendee) => attendee.email)).not.toContain(originalInvitee.toLowerCase());
    }

    const moved = await handleUpdate(ctx, {
      uid: inviteUid,
      calendar,
      occurrenceStart: `${secondDay}T09:00`,
      start: `${secondDay}T10:00`,
      duration: 30,
    });
    expect(moved.occurrence?.start?.slice(0, 16)).toBe(`${secondDay}T10:00`);
    const cancelled = await handleDelete(ctx, { uid: inviteUid, calendar, occurrenceStart: `${secondDay}T09:00` });
    expect(cancelled.deleted).toBe(true);
    const updated = await handleGet(ctx, { uid: inviteUid, calendar });
    expect(updated.occurrenceOverrides?.some((override) => override.cancelled && override.recurrenceStart.startsWith(secondDay))).toBe(true);
    await handleDelete(ctx, { uid: inviteUid, calendar });
    inviteUid = undefined;
  });
});
