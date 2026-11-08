import { beforeEach, describe, expect, it } from "vitest";
import { CalDavClient } from "../src/caldav/client.js";
import { Session } from "../src/caldav/discovery.js";
import { CalDavError } from "../src/errors.js";
import type { ResolvedConfig } from "../src/config.js";
import { getProp, getProps, parseICalendar } from "../src/ical/component.js";
import { parseEventDocument } from "../src/ical/event.js";
import { handleCreate, handleDelete, handleEvents, handleGet, handleList, handleUpdate, type Context } from "../src/tools/handlers.js";
import { FakeICloud } from "./helpers/fake-icloud.js";

const TZ = "America/Los_Angeles";

function makeCtx(fake: FakeICloud, overrides: Partial<ResolvedConfig> = {}): Context {
  const config: ResolvedConfig = {
    appleId: fake.username,
    appPassword: fake.password,
    organizerEmail: fake.username,
    timezone: TZ,
    serverUrl: "https://caldav.icloud.com",
    calendars: [],
    readOnly: false,
    ...overrides,
  };
  const client = new CalDavClient({ serverUrl: config.serverUrl, username: config.appleId, password: config.appPassword, fetch: fake.fetch });
  return { session: new Session(client), config };
}

const SEED = (uid: string, summary: string, start: string, end: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART:${start}`, `DTEND:${end}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

describe("handlers against fake iCloud", () => {
  let fake: FakeICloud;
  let ctx: Context;

  beforeEach(() => {
    fake = new FakeICloud([
      { path: "/1234/calendars/home/", name: "Home", color: "#FF2968FF" },
      { path: "/1234/calendars/work/", name: "Work" },
      { path: "/1234/calendars/birthdays/", name: "Birthdays", readOnly: true },
      { path: "/1234/calendars/reminders/", name: "Reminders", components: ["VTODO"] },
    ]);
    fake.seed("/1234/calendars/home/", "a.ics", SEED("UID-A", "Dinner", "20260818T020000Z", "20260818T040000Z")); // Aug 17 7pm PDT
    fake.seed("/1234/calendars/work/", "b.ics", SEED("UID-B", "Standup", "20260818T160000Z", "20260818T163000Z"));
    fake.seed("/1234/calendars/work/", "old.ics", SEED("UID-OLD", "Old", "20200101T160000Z", "20200101T163000Z"));
    ctx = makeCtx(fake);
  });

  it("discovers through the redirect and lists event calendars only", async () => {
    const res = await handleList(ctx);
    expect(res.calendars.map((c) => c.name)).toEqual(["Home", "Work", "Birthdays"]);
    expect(res.calendars[0]).toMatchObject({ id: "home", color: "#FF2968", readOnly: false });
    expect(res.calendars[2].readOnly).toBe(true);
    // Auth header survived the cross-host redirect
    const partitionCalls = fake.log.filter((l) => l.url.startsWith(fake.partition));
    expect(partitionCalls.length).toBeGreaterThan(0);
    expect(partitionCalls.every((l) => l.headers.authorization?.startsWith("Basic "))).toBe(true);
    // Discovery is cached
    const before = fake.log.length;
    await handleList(ctx);
    expect(fake.log.length).toBe(before);
  });

  it("applies the calendar allowlist", async () => {
    const res = await handleList(makeCtx(fake, { calendars: ["work"] }));
    expect(res.calendars.map((c) => c.name)).toEqual(["Work"]);
    await expect(handleEvents(makeCtx(fake, { calendars: ["work"] }), { calendar: "Home", from: "2026-08-17", to: "2026-08-19" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists events across calendars sorted, in the configured tz", async () => {
    const res = await handleEvents(ctx, { from: "2026-08-17", to: "2026-08-19" });
    expect(res.calendars).toEqual(["Home", "Work", "Birthdays"]);
    expect(res.events.map((e) => e.title)).toEqual(["Dinner", "Standup"]);
    expect(res.events[0].start).toBe("2026-08-17T19:00:00-07:00");
    expect(res.events[0].calendar).toBe("Home");
    expect(res.from).toBe("2026-08-17T00:00:00-07:00");
    expect(res.to).toBe("2026-08-20T00:00:00-07:00"); // a YYYY-MM-DD `to` includes that whole day
    const rep = fake.log.filter((l) => l.method === "REPORT");
    expect(rep.every((l) => l.headers.depth === "1")).toBe(true);
    expect(rep[0].body).toContain('time-range start="20260817T070000Z" end="20260820T070000Z"');
  });

  it("validates ranges", async () => {
    await expect(handleEvents(ctx, { from: "2026-08-19", to: "2026-08-17" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(handleEvents(ctx, { from: "soon" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("gets by uid across calendars and by calendar", async () => {
    const ev = await handleGet(ctx, { uid: "UID-B" });
    expect(ev.title).toBe("Standup");
    expect(ev.calendarId).toBe("work");
    const ev2 = await handleGet(ctx, { uid: "UID-A", calendar: "home" });
    expect(ev2.title).toBe("Dinner");
    await expect(handleGet(ctx, { uid: "NOPE" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("creates, verifies, updates with etag, and deletes", async () => {
    const created = await handleCreate(ctx, { title: "Lunch", start: "2026-08-20T12:00", duration: 60, calendar: "Home", location: "Cafe" });
    expect(created.event.uid).toMatch(/^[0-9A-F-]{36}$/);
    expect(created.event.start).toBe("2026-08-20T12:00:00-07:00");
    expect(created.event.end).toBe("2026-08-20T13:00:00-07:00");
    expect(created.verification.allFieldsMatch).toBe(true);
    const put = fake.log.find((l) => l.method === "PUT")!;
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers["content-type"]).toContain("text/calendar");
    expect(put.url).toBe(`${fake.partition}/1234/calendars/home/${created.event.uid}.ics`);

    const updated = await handleUpdate(ctx, { uid: created.event.uid, start: "2026-08-20T13:00", notes: "Bring laptop" });
    expect(updated.event.start).toBe("2026-08-20T13:00:00-07:00");
    expect(updated.event.end).toBe("2026-08-20T14:00:00-07:00"); // duration preserved
    expect(updated.event.notes).toBe("Bring laptop");
    expect(updated.event.location).toBe("Cafe");
    expect(updated.verification?.allFieldsMatch).toBe(true);
    const updatePut = fake.log.filter((l) => l.method === "PUT")[1];
    expect(updatePut.headers["if-match"]).toBe(created.event.etag);

    const cleared = await handleUpdate(ctx, { uid: created.event.uid, location: "" });
    expect(cleared.event.location).toBeUndefined();
    expect(cleared.verification).toBeUndefined();

    const del = await handleDelete(ctx, { uid: created.event.uid });
    expect(del).toMatchObject({ deleted: true, calendar: "Home", title: "Lunch" });
    await expect(handleGet(ctx, { uid: created.event.uid })).rejects.toMatchObject({ code: "not_found" });
  });

  it("creates all-day and recurring events", async () => {
    const res = await handleCreate(ctx, { title: "Offsite", start: "2026-09-01", end: "2026-09-03", calendar: "work", recurrence: { frequency: "YEARLY" } });
    expect(res.event.allDay).toBe(true);
    expect(res.event.start).toBe("2026-09-01");
    expect(res.event.end).toBe("2026-09-03");
    expect(res.event.recurrence).toEqual({ frequency: "YEARLY" });
    fake.seed("/1234/calendars/work/", "early.ics", SEED("UID-EARLY", "Early Aug 2027", "20270815T160000Z", "20270815T170000Z"));
    const listed = await handleEvents(ctx, { from: "2027-08-01", to: "2027-09-30", calendar: "work" });
    // Recurring master (series start 2026-09-01) sorts by its 2027 occurrence, after the Aug 15 event.
    expect(listed.events.map((e) => e.title)).toEqual(["Early Aug 2027", "Offsite"]);
    const off = listed.events.find((e) => e.title === "Offsite")!;
    expect(off.nextOccurrences).toEqual(["2027-09-01"]);
  });

  it("creates external attendees and reconciles attendee changes idempotently", async () => {
    const res = await handleCreate(ctx, {
      title: "School pickup",
      start: "2026-08-20T15:00",
      duration: 30,
      calendar: "Home",
      attendees: [{ email: "parent@work.example", name: "Parent" }],
    } as never);
    expect(res.event.attendees).toEqual([expect.objectContaining({ email: "parent@work.example", name: "Parent" })]);

    const storedUrl = `${fake.partition}/1234/calendars/home/${res.event.uid}.ics`;
    let stored = fake.objects.get(storedUrl)!.ics;
    expect(stored).toContain("ORGANIZER:mailto:user@icloud.com");
    const attendee = getProps(parseEventDocument(stored).master, "ATTENDEE")[0];
    expect(attendee).toMatchObject({ value: "mailto:parent@work.example", params: { CN: "Parent", PARTSTAT: "NEEDS-ACTION", RSVP: "TRUE" } });

    const first = await handleUpdate(ctx, {
      uid: res.event.uid,
      addAttendees: [{ email: "second@work.example" }],
    } as never);
    expect(first.event.attendees?.map((a) => a.email)).toEqual(["parent@work.example", "second@work.example"]);
    const putCount = fake.log.filter((l) => l.method === "PUT").length;

    await handleUpdate(ctx, { uid: res.event.uid, addAttendees: [{ email: "second@work.example" }] } as never);
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(putCount);

    const reassigned = await handleUpdate(ctx, {
      uid: res.event.uid,
      addAttendees: [{ email: "newparent@work.example" }],
      removeAttendees: ["parent@work.example"],
    } as never);
    expect(reassigned.event.attendees?.map((a) => a.email)).toEqual(["second@work.example", "newparent@work.example"]);
    stored = fake.objects.get(storedUrl)!.ics;
    expect(stored).not.toContain("mailto:parent@work.example");
    expect(stored).toContain("mailto:newparent@work.example");
  });

  it("rejects invalid invitees and refuses to edit another organizer's invitees", async () => {
    const puts = fake.log.filter((l) => l.method === "PUT").length;
    await expect(handleCreate(ctx, {
      title: "Bad invite",
      start: "2026-08-20T15:00",
      calendar: "Home",
      attendees: [{ email: "not an email" }],
    } as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(puts);

    const foreign = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT",
      "UID:UID-FOREIGN-INVITE", "SUMMARY:External event", "DTSTART:20260820T220000Z", "DTEND:20260820T230000Z",
      "ORGANIZER:mailto:someone-else@icloud.com", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:parent@work.example", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    fake.seed("/1234/calendars/home/", "foreign.ics", foreign);
    await expect(handleUpdate(ctx, { uid: "UID-FOREIGN-INVITE", removeAttendees: ["parent@work.example"] } as never)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("edits and cancels one recurring occurrence across a daylight-saving boundary", async () => {
    ctx = makeCtx(fake, { timezone: "Australia/Sydney" });
    const recurring = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Apple//EN",
      "BEGIN:VEVENT",
      "UID:UID-SCHOOL-RUN",
      "SUMMARY:School pickup",
      "DTSTART;TZID=Australia/Sydney:20261002T090000",
      "DTEND;TZID=Australia/Sydney:20261002T093000",
      "ORGANIZER:mailto:user@icloud.com",
      "RRULE:FREQ=WEEKLY;BYDAY=FR",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const url = fake.seed("/1234/calendars/home/", "school-run.ics", recurring);
    await handleUpdate(ctx, { uid: "UID-SCHOOL-RUN", addAttendees: [{ email: "parent@work.example" }] } as never);

    const putsBeforeNoOp = fake.log.filter((l) => l.method === "PUT").length;
    await handleUpdate(ctx, {
      uid: "UID-SCHOOL-RUN",
      occurrenceStart: "2026-10-09T09:00",
      addAttendees: [{ email: "PARENT@work.example" }],
    } as never);
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(putsBeforeNoOp);
    expect(parseEventDocument(fake.objects.get(url)!.ics).overrides).toHaveLength(0);

    const moved = await handleUpdate(ctx, {
      uid: "UID-SCHOOL-RUN",
      occurrenceStart: "2026-10-09T09:00",
      start: "2026-10-09T10:00",
      duration: 30,
    } as never);
    expect(moved.event.start).toBe("2026-10-02T09:00:00+10:00"); // master remains unchanged
    expect(moved.occurrence?.start).toBe("2026-10-09T10:00:00+11:00");
    let parsed = parseEventDocument(fake.objects.get(url)!.ics);
    expect(getProp(parsed.master, "DTSTART")?.value).toBe("20261002T090000");
    expect(getProp(parsed.master, "RRULE")?.value).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(parsed.overrides).toHaveLength(1);
    expect(getProp(parsed.overrides[0], "RECURRENCE-ID")?.value).toBe("20261009T090000");
    expect(getProp(parsed.overrides[0], "RECURRENCE-ID")?.params.TZID).toBe("Australia/Sydney");
    expect(getProp(parsed.overrides[0], "DTSTART")?.value).toBe("20261008T230000Z");
    const movedList = await handleEvents(ctx, { from: "2026-10-08", to: "2026-10-10", calendar: "Home" });
    expect(movedList.events[0].nextOccurrences).toEqual(["2026-10-09T10:00:00+11:00"]);
    expect(movedList.events[0].occurrenceOverrides?.[0]).toMatchObject({
      recurrenceStart: "2026-10-09T09:00:00+11:00",
      start: "2026-10-09T10:00:00+11:00",
      cancelled: false,
    });

    await handleDelete(ctx, { uid: "UID-SCHOOL-RUN", occurrenceStart: "2026-10-09T09:00" } as never);
    parsed = parseEventDocument(fake.objects.get(url)!.ics);
    expect(fake.objects.has(url)).toBe(true);
    expect(getProp(parsed.master, "RRULE")?.value).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(getProp(parsed.overrides[0], "STATUS")?.value).toBe("CANCELLED");
    expect(getProps(parsed.overrides[0], "ATTENDEE").map((a) => a.value)).toEqual(["mailto:parent@work.example"]);
    const cancelledList = await handleEvents(ctx, { from: "2026-10-08", to: "2026-10-10", calendar: "Home" });
    expect(cancelledList.events[0].nextOccurrences).toEqual([]);
    expect(cancelledList.events[0].occurrenceOverrides?.[0].cancelled).toBe(true);
    const puts = fake.log.filter((l) => l.method === "PUT").length;
    await handleDelete(ctx, { uid: "UID-SCHOOL-RUN", occurrenceStart: "2026-10-09T09:00" } as never);
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(puts);
  });

  it("rejects a date that is not an instance in the recurrence", async () => {
    const recurring = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT",
      "UID:UID-WEEKLY", "SUMMARY:School drop-off", "DTSTART;TZID=America/Los_Angeles:20260818T080000",
      "DTEND;TZID=America/Los_Angeles:20260818T083000", "RRULE:FREQ=WEEKLY;BYDAY=TU", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    fake.seed("/1234/calendars/home/", "weekly.ics", recurring);
    const puts = fake.log.filter((l) => l.method === "PUT").length;
    await expect(handleUpdate(ctx, { uid: "UID-WEEKLY", occurrenceStart: "2026-08-19T08:00", title: "Wrong day" } as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(puts);
  });

  it("materializes correct dates for a title-only exception and a new cancellation", async () => {
    const recurring = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT",
      "UID:UID-EXCEPTION", "SUMMARY:School pickup", "DTSTART;TZID=America/Los_Angeles:20260818T080000",
      "DTEND;TZID=America/Los_Angeles:20260818T083000", "RRULE:FREQ=WEEKLY;BYDAY=TU", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const url = fake.seed("/1234/calendars/home/", "exception.ics", recurring);
    await handleUpdate(ctx, { uid: "UID-EXCEPTION", occurrenceStart: "2026-08-25T08:00", title: "Alternate pickup" } as never);
    let parsed = parseEventDocument(fake.objects.get(url)!.ics);
    expect(getProp(parsed.overrides[0], "DTSTART")?.value).toBe("20260825T080000");
    expect(getProp(parsed.overrides[0], "DTEND")?.value).toBe("20260825T083000");
    expect(getProp(parsed.overrides[0], "DTSTART")?.params.TZID).toBe("America/Los_Angeles");

    await handleDelete(ctx, { uid: "UID-EXCEPTION", occurrenceStart: "2026-09-01T08:00" });
    parsed = parseEventDocument(fake.objects.get(url)!.ics);
    const cancelled = parsed.overrides.find((o) => getProp(o, "STATUS")?.value === "CANCELLED");
    expect(getProp(cancelled!, "DTSTART")?.value).toBe("20260901T080000");
    expect(getProp(cancelled!, "DTEND")?.value).toBe("20260901T083000");
    expect(getProp(cancelled!, "DTSTART")?.params.TZID).toBe("America/Los_Angeles");
  });

  it("does not accept biweekly occurrences in an intervening Monday-based week", async () => {
    ctx = makeCtx(fake, { timezone: "Australia/Sydney" });
    const recurring = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT",
      "UID:UID-BIWEEKLY", "SUMMARY:School drop-off", "DTSTART;TZID=Australia/Sydney:20261004T090000",
      "DTEND;TZID=Australia/Sydney:20261004T093000", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const url = fake.seed("/1234/calendars/home/", "biweekly.ics", recurring);
    const putsBefore = fake.log.filter((l) => l.method === "PUT").length;
    await expect(handleUpdate(ctx, { uid: "UID-BIWEEKLY", occurrenceStart: "2026-10-05T09:00", title: "Wrong week" } as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(putsBefore);

    await handleUpdate(ctx, { uid: "UID-BIWEEKLY", occurrenceStart: "2026-10-12T09:00", title: "Correct week" } as never);
    expect(parseEventDocument(fake.objects.get(url)!.ics).overrides).toHaveLength(1);
  });

  it("refuses invite changes when the existing event has no organizer identity", async () => {
    const noOrganizer = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT",
      "UID:UID-NO-ORGANIZER", "SUMMARY:Family event", "DTSTART:20260820T160000Z", "DTEND:20260820T170000Z",
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const url = fake.seed("/1234/calendars/home/", "no-organizer.ics", noOrganizer);
    const putsBefore = fake.log.filter((l) => l.method === "PUT").length;
    await expect(handleUpdate(ctx, { uid: "UID-NO-ORGANIZER", addAttendees: [{ email: "parent@work.example" }] } as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.log.filter((l) => l.method === "PUT")).toHaveLength(putsBefore);
    expect(getProp(parseEventDocument(fake.objects.get(url)!.ics).master, "ORGANIZER")).toBeUndefined();
  });

  it("tolerates null for unused optional params (model habit)", async () => {
    const created = await handleCreate(ctx, { title: "Nullish", start: "2026-08-21T09:00", calendar: "Home", end: null, duration: null, location: null, notes: null, url: null, alarms: null, recurrence: null, allDay: null });
    expect(created.event.end).toBe("2026-08-21T10:00:00-07:00");
    expect(created.event.recurrence).toBeUndefined();
    const listed = await handleEvents(ctx, { from: "2026-08-21", to: null, calendar: null, limit: null });
    expect(listed.events.map((e) => e.title)).toContain("Nullish");
    const upd = await handleUpdate(ctx, { uid: created.event.uid, calendar: null, title: null, location: "Room", notes: null, recurrence: { frequency: "DAILY", count: 2, interval: null, until: null, byDay: null, byMonthDay: null } });
    expect(upd.event.title).toBe("Nullish");
    expect(upd.event.location).toBe("Room");
    expect(upd.event.recurrence).toEqual({ frequency: "DAILY", count: 2 });
    await handleDelete(ctx, { uid: created.event.uid, calendar: null });
  });

  it("refuses writes to read-only calendars and in readOnly mode", async () => {
    await expect(handleCreate(ctx, { title: "x", start: "2026-08-20", calendar: "Birthdays" })).rejects.toMatchObject({ code: "read_only_calendar" });
    const ro = makeCtx(fake, { readOnly: true });
    await expect(handleCreate(ro, { title: "x", start: "2026-08-20", calendar: "Home" })).rejects.toMatchObject({ code: "read_only_calendar" });
    await expect(handleDelete(ro, { uid: "UID-A" })).rejects.toMatchObject({ code: "read_only_calendar" });
  });

  it("requires a known calendar on create and rejects nothing-to-update", async () => {
    await expect(handleCreate(ctx, { title: "x", start: "2026-08-20", calendar: "Nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(handleUpdate(ctx, { uid: "UID-A" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("recovers from a concurrent modification (412) by refetching once", async () => {
    // Change the object behind our back after locate() but before PUT by mutating the store between calls.
    const objUrl = `${fake.partition}/1234/calendars/home/a.ics`;
    const original = fake.objects.get(objUrl)!;
    let mutated = false;
    const realFetch = fake.fetch;
    const client = new CalDavClient({
      serverUrl: "https://caldav.icloud.com",
      username: fake.username,
      password: fake.password,
      fetch: async (url, init) => {
        if ((init.method ?? "GET") === "PUT" && !mutated) {
          mutated = true;
          fake.objects.set(objUrl, { ics: original.ics, etag: '"changed"' });
        }
        return realFetch(url, init);
      },
    });
    const c: Context = { session: new Session(client), config: ctx.config };
    const res = await handleUpdate(c, { uid: "UID-A", title: "Dinner v2" });
    expect(res.event.title).toBe("Dinner v2");
    const puts = fake.log.filter((l) => l.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].headers["if-match"]).toBe('"changed"');
  });

  it("maps auth failures without leaking credentials", async () => {
    const bad = makeCtx(fake, { appPassword: "wrong" });
    const err = await handleList(bad).catch((e) => e);
    expect(err).toBeInstanceOf(CalDavError);
    expect(err.code).toBe("auth_failed");
    expect(err.message).toMatch(/app-specific password/);
    expect(err.message).not.toContain("wrong");
  });

  it("retries once on 5xx", async () => {
    fake.failNext = { method: "PROPFIND", status: 503 };
    const res = await handleList(ctx);
    expect(res.calendars.length).toBe(3);
  });

  it("refreshes stale discovery on 404", async () => {
    await handleList(ctx);
    // Simulate partition move: rename calendar path on the server; cached href now 404s.
    fake.calendars[0].path = "/1234/calendars/home-moved/";
    for (const [k, v] of [...fake.objects]) {
      if (k.includes("/home/")) {
        fake.objects.delete(k);
        fake.objects.set(k.replace("/home/", "/home-moved/"), v);
      }
    }
    const res = await handleEvents(ctx, { from: "2026-08-17", to: "2026-08-19" });
    expect(res.events.map((e) => e.title)).toEqual(["Dinner", "Standup"]);
  });
});
