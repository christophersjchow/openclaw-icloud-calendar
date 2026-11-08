/**
 * Event JSON <-> iCalendar VEVENT.
 */

import { invalidInput } from "../errors.js";
import {
  escapeText,
  getProp,
  getProps,
  parseICalendar,
  removeProp,
  serializeICalendar,
  setProp,
  unescapeText,
  type Component,
  type Property,
} from "./component.js";
import { expandRrule, recurrenceToRrule, rruleToRecurrence, type Recurrence } from "./rrule.js";
import {
  addDays,
  formatDateOnly,
  formatIsoInZone,
  normalizeTzid,
  parseICalDate,
  parseInput,
  partsInZone,
  toICalDate,
  toICalUtc,
  zonedToUtc,
  type ICalDateValue,
} from "./tz.js";

export const PRODID = "-//omarshahine//openclaw-icloud-calendar//EN";

export interface Event {
  uid: string;
  calendarId: string;
  calendar: string;
  title: string;
  /** ISO 8601 with offset (timed) or YYYY-MM-DD (all-day, inclusive) */
  start: string;
  /** ISO 8601 with offset (timed) or YYYY-MM-DD (all-day, inclusive last day) */
  end: string;
  allDay: boolean;
  timezone: string;
  location?: string;
  notes?: string;
  url?: string;
  status?: string;
  attendees?: EventAttendee[];
  occurrenceOverrides?: EventOccurrenceOverride[];
  recurrence?: Recurrence;
  /** Best-effort expansion of upcoming occurrences within the queried range */
  nextOccurrences?: string[];
  nextOccurrencesTruncated?: boolean;
  /** Number of per-instance overrides present on the server. */
  overrideCount?: number;
  /** Minutes before start */
  alarms?: number[];
  etag?: string;
  lastModified?: string;
  readOnly: boolean;
}

export interface EventOccurrenceOverride {
  recurrenceStart: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  cancelled: boolean;
  location?: string;
  notes?: string;
  attendees?: EventAttendee[];
}

export interface EventAttendee {
  email: string;
  name?: string;
  participationStatus?: string;
  rsvp?: boolean;
  scheduleStatus?: string;
}

export interface AttendeeInput {
  email: string;
  name?: string;
}

export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  /** Minutes; alternative to end */
  duration?: number;
  allDay?: boolean;
  location?: string | null;
  notes?: string | null;
  url?: string | null;
  alarms?: number[] | null;
  recurrence?: Recurrence | null;
  /** Set attendees on a new event. Updates use add/remove to preserve other invitees. */
  attendees?: AttendeeInput[];
  addAttendees?: AttendeeInput[];
  removeAttendees?: string[];
}

export interface ParsedEvent {
  vcal: Component;
  master: Component;
  overrides: Component[];
}

export function parseEventDocument(ics: string): ParsedEvent {
  const vcal = parseICalendar(ics);
  const vevents = vcal.children.filter((c) => c.name === "VEVENT");
  if (vevents.length === 0) throw new Error("iCalendar document has no VEVENT");
  const master = vevents.find((v) => !getProp(v, "RECURRENCE-ID")) ?? vevents[0];
  return { vcal, master, overrides: vevents.filter((v) => v !== master) };
}

function textValue(c: Component, name: string): string | undefined {
  const p = getProp(c, name);
  if (!p) return undefined;
  const v = unescapeText(p.value);
  return v.length ? v : undefined;
}

/** Parse a VALARM TRIGGER duration like -PT15M / -P1D / PT0S into minutes-before. */
export function triggerToMinutes(trigger: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(trigger.trim());
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  const mins = (+(m[2] ?? 0)) * 7 * 1440 + (+(m[3] ?? 0)) * 1440 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0)) + Math.round((+(m[6] ?? 0)) / 60);
  if (mins === 0) return 0;
  return sign < 0 ? mins : -mins; // "before" is positive in our JSON
}

export function minutesToTrigger(minutesBefore: number): string {
  const total = Math.abs(minutesBefore);
  const sign = minutesBefore >= 0 ? "-" : "";
  if (total === 0) return "PT0S";
  if (total % 1440 === 0) return `${sign}P${total / 1440}D`;
  if (total % 60 === 0) return `${sign}PT${total / 60}H`;
  return `${sign}PT${total}M`;
}

export interface ToEventOptions {
  tz: string;
  calendarId: string;
  calendarName: string;
  readOnly: boolean;
  etag?: string;
  /** If provided, recurring masters get nextOccurrences within this range */
  range?: { start: Date; end: Date };
  occurrenceCap?: number;
}

export function componentToEvent(parsed: ParsedEvent, opts: ToEventOptions): Event {
  const v = parsed.master;
  const dtstartProp = getProp(v, "DTSTART");
  if (!dtstartProp) throw new Error("VEVENT missing DTSTART");
  const start = parseICalDate(dtstartProp.value, dtstartProp.params, opts.tz);
  let end: ICalDateValue | undefined;
  const dtendProp = getProp(v, "DTEND");
  const durProp = getProp(v, "DURATION");
  if (dtendProp) end = parseICalDate(dtendProp.value, dtendProp.params, opts.tz);
  else if (durProp) end = applyDuration(start, durProp.value);
  if (!end) end = start.kind === "date" ? { kind: "date", ...addDays(start.year, start.month, start.day, 1) } : { kind: "datetime", date: start.date, floating: start.floating };

  const allDay = start.kind === "date";
  const ev: Event = {
    uid: textValue(v, "UID") ?? "",
    calendarId: opts.calendarId,
    calendar: opts.calendarName,
    title: textValue(v, "SUMMARY") ?? "",
    start: allDay && start.kind === "date" ? formatDateOnly(start.year, start.month, start.day) : formatIsoInZone((start as { date: Date }).date, opts.tz),
    end: formatEnd(end, allDay, opts.tz),
    allDay,
    timezone: opts.tz,
    readOnly: opts.readOnly,
  };
  const loc = textValue(v, "LOCATION");
  if (loc) ev.location = loc;
  const notes = textValue(v, "DESCRIPTION");
  if (notes) ev.notes = notes;
  const url = getProp(v, "URL")?.value;
  if (url) ev.url = url;
  const status = getProp(v, "STATUS")?.value;
  if (status) ev.status = status.toUpperCase();
  const attendees = getProps(v, "ATTENDEE").map(parseAttendee).filter((a): a is EventAttendee => a !== undefined);
  if (attendees.length) ev.attendees = attendees;
  const rrule = getProp(v, "RRULE")?.value;
  if (rrule) {
    ev.recurrence = rruleToRecurrence(rrule, opts.tz);
    if (opts.range) {
      const exdates = new Set<string>();
      for (const ex of getProps(v, "EXDATE")) {
        for (const val of ex.value.split(",")) {
          try {
            const d = parseICalDate(val, ex.params, opts.tz);
            exdates.add(d.kind === "date" ? formatDateOnly(d.year, d.month, d.day) : d.date.toISOString());
          } catch {
            /* ignore malformed EXDATE */
          }
        }
      }
      const movedStarts: string[] = [];
      for (const override of parsed.overrides) {
        const rid = getProp(override, "RECURRENCE-ID");
        if (!rid) continue;
        try {
          const original = parseICalDate(rid.value, rid.params, opts.tz);
          const originalKey = original.kind === "date" ? formatDateOnly(original.year, original.month, original.day) : original.date.toISOString();
          const effective = effectiveOverride(v, override);
          const cancelled = getProp(effective, "STATUS")?.value.toUpperCase() === "CANCELLED";
          const actualStart = getProp(effective, "DTSTART");
          const actual = actualStart ? parseICalDate(actualStart.value, actualStart.params, opts.tz) : original;
          const actualKey = actual.kind === "date" ? formatDateOnly(actual.year, actual.month, actual.day) : actual.date.toISOString();
          if (cancelled || actualKey !== originalKey) exdates.add(originalKey);
          if (!cancelled && actualKey !== originalKey) {
            const inRange = actual.kind === "date"
              ? Date.UTC(actual.year, actual.month - 1, actual.day) >= opts.range.start.getTime() && Date.UTC(actual.year, actual.month - 1, actual.day) < opts.range.end.getTime()
              : actual.date.getTime() >= opts.range.start.getTime() && actual.date.getTime() < opts.range.end.getTime();
            if (inRange) movedStarts.push(actual.kind === "date" ? formatDateOnly(actual.year, actual.month, actual.day) : formatIsoInZone(actual.date, opts.tz));
          }
        } catch {
          /* Ignore malformed overrides in the best-effort occurrence preview. */
        }
      }
      const zone = start.kind === "datetime" && start.tzid ? (normalizeTzid(start.tzid) ?? opts.tz) : opts.tz;
      const startParts = start.kind === "date" ? { year: start.year, month: start.month, day: start.day, hour: 0, minute: 0, second: 0 } : partsInZone(start.date, zone);
      const exp = expandRrule(rrule, { start: startParts, allDay, tz: zone, rangeStart: opts.range.start, rangeEnd: opts.range.end, exdates, cap: opts.occurrenceCap ?? 50 });
      if (exp.supported) {
        ev.nextOccurrences = [...new Set([
          ...exp.occurrences.map((o) => (o instanceof Date ? formatIsoInZone(o, opts.tz) : formatDateOnly(o.year, o.month, o.day))),
          ...movedStarts,
        ])].sort((a, b) => {
          const pa = parseInput(a, opts.tz);
          const pb = parseInput(b, opts.tz);
          const ta = pa.kind === "date" ? Date.UTC(pa.year, pa.month - 1, pa.day) : pa.date.getTime();
          const tb = pb.kind === "date" ? Date.UTC(pb.year, pb.month - 1, pb.day) : pb.date.getTime();
          return ta - tb;
        });
        if (exp.truncated) ev.nextOccurrencesTruncated = true;
      }
    }
  }
  if (parsed.overrides.length) {
    ev.overrideCount = parsed.overrides.length;
    ev.occurrenceOverrides = parsed.overrides.flatMap((override) => {
      const rid = getProp(override, "RECURRENCE-ID");
      if (!rid) return [];
      try {
        const id = parseICalDate(rid.value, rid.params, opts.tz);
        const effective = eventFromComponent(effectiveOverride(v, override), { ...opts, range: undefined });
        return [{
          recurrenceStart: id.kind === "date" ? formatDateOnly(id.year, id.month, id.day) : formatIsoInZone(id.date, opts.tz),
          title: effective.title,
          start: effective.start,
          end: effective.end,
          allDay: effective.allDay,
          cancelled: effective.status === "CANCELLED",
          ...(effective.location ? { location: effective.location } : {}),
          ...(effective.notes ? { notes: effective.notes } : {}),
          ...(effective.attendees ? { attendees: effective.attendees } : {}),
        }];
      } catch {
        return [];
      }
    });
  }
  const alarms = v.children
    .filter((c) => c.name === "VALARM")
    .map((a) => getProp(a, "TRIGGER"))
    .filter((t): t is NonNullable<typeof t> => !!t && !t.params.VALUE)
    .map((t) => triggerToMinutes(t.value))
    .filter((n): n is number => n !== undefined);
  if (alarms.length) ev.alarms = alarms;
  if (opts.etag) ev.etag = opts.etag;
  const lm = getProp(v, "LAST-MODIFIED")?.value;
  if (lm) {
    try {
      const d = parseICalDate(lm, {}, "UTC");
      if (d.kind === "datetime") ev.lastModified = d.date.toISOString();
    } catch {
      /* ignore */
    }
  }
  return ev;
}

function formatEnd(end: ICalDateValue, allDay: boolean, tz: string): string {
  if (end.kind === "date") {
    // iCalendar DTEND for all-day is exclusive; present inclusive last day.
    const inc = addDays(end.year, end.month, end.day, -1);
    return formatDateOnly(inc.year, inc.month, inc.day);
  }
  if (allDay) {
    const p = partsInZone(end.date, tz);
    return formatDateOnly(p.year, p.month, p.day);
  }
  return formatIsoInZone(end.date, tz);
}

function applyDuration(start: ICalDateValue, dur: string): ICalDateValue {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur.trim());
  if (!m) return start;
  const sign = m[1] === "-" ? -1 : 1;
  const days = (+(m[2] ?? 0)) * 7 + (+(m[3] ?? 0));
  const secs = (+(m[4] ?? 0)) * 3600 + (+(m[5] ?? 0)) * 60 + (+(m[6] ?? 0));
  if (start.kind === "date") return { kind: "date", ...addDays(start.year, start.month, start.day, sign * days) };
  return { kind: "datetime", date: new Date(start.date.getTime() + sign * (days * 86400 + secs) * 1000), tzid: start.tzid, floating: start.floating };
}

// ---------------------------------------------------------------------------
// Build / patch
// ---------------------------------------------------------------------------

interface ResolvedTimes {
  allDay: boolean;
  startDate?: { year: number; month: number; day: number };
  endDate?: { year: number; month: number; day: number }; // exclusive
  start?: Date;
  end?: Date;
}

/**
 * Resolve start/end/duration/allDay from agent input. `existing` supplies
 * defaults for update. For all-day events `end` is the inclusive last day.
 */
export function resolveTimes(input: EventInput, tz: string, existing?: Event): ResolvedTimes {
  const startRaw = input.start ?? existing?.start;
  if (!startRaw) throw invalidInput("start is required");
  const startParsed = parseInput(startRaw, tz, "start");
  const wantAllDay = input.allDay ?? (input.start !== undefined ? startParsed.kind === "date" : existing?.allDay ?? startParsed.kind === "date");

  if (wantAllDay) {
    const s = startParsed.kind === "date" ? startParsed : partsInZone(startParsed.date, tz);
    let endInclusive: { year: number; month: number; day: number };
    if (input.end !== undefined) {
      const e = parseInput(input.end, tz, "end");
      endInclusive = e.kind === "date" ? e : partsInZone(e.date, tz);
    } else if (input.duration !== undefined) {
      if (!Number.isInteger(input.duration) || input.duration <= 0) throw invalidInput("duration must be a positive integer number of minutes");
      endInclusive = addDays(s.year, s.month, s.day, Math.max(1, Math.ceil(input.duration / 1440)) - 1);
    } else if (existing?.allDay && input.start === undefined && existing.end) {
      const e = parseInput(existing.end, tz, "end");
      endInclusive = e.kind === "date" ? e : partsInZone(e.date, tz);
    } else {
      endInclusive = { year: s.year, month: s.month, day: s.day };
    }
    const startDate = { year: s.year, month: s.month, day: s.day };
    if (cmp(endInclusive, startDate) < 0) throw invalidInput("end must not be before start");
    return { allDay: true, startDate, endDate: addDays(endInclusive.year, endInclusive.month, endInclusive.day, 1) };
  }

  const start = startParsed.kind === "date" ? dateAtMidnight(startParsed, tz) : startParsed.date;
  let end: Date;
  if (input.end !== undefined) {
    const e = parseInput(input.end, tz, "end");
    end = e.kind === "date" ? dateAtMidnight(e, tz) : e.date;
  } else if (input.duration !== undefined) {
    if (!Number.isInteger(input.duration) || input.duration <= 0) throw invalidInput("duration must be a positive integer number of minutes");
    end = new Date(start.getTime() + input.duration * 60000);
  } else if (existing && !existing.allDay && input.start !== undefined) {
    // Keep the existing duration when only start moves.
    const es = parseInput(existing.start, tz).kind === "datetime" ? (parseInput(existing.start, tz) as { date: Date }).date : start;
    const ee = parseInput(existing.end, tz).kind === "datetime" ? (parseInput(existing.end, tz) as { date: Date }).date : es;
    end = new Date(start.getTime() + Math.max(0, ee.getTime() - es.getTime()));
  } else if (existing && !existing.allDay) {
    end = (parseInput(existing.end, tz) as { date: Date }).date;
  } else {
    end = new Date(start.getTime() + 60 * 60000);
  }
  if (end.getTime() < start.getTime()) throw invalidInput("end must not be before start");
  return { allDay: false, start, end };
}

function dateAtMidnight(d: { year: number; month: number; day: number }, tz: string): Date {
  return zonedToUtc({ year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 }, tz);
}

function cmp(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function applyTimes(v: Component, t: ResolvedTimes): void {
  removeProp(v, "DURATION");
  if (t.allDay && t.startDate && t.endDate) {
    setProp(v, "DTSTART", toICalDate(t.startDate.year, t.startDate.month, t.startDate.day), { VALUE: "DATE" });
    setProp(v, "DTEND", toICalDate(t.endDate.year, t.endDate.month, t.endDate.day), { VALUE: "DATE" });
  } else if (t.start && t.end) {
    setProp(v, "DTSTART", toICalUtc(t.start));
    setProp(v, "DTEND", toICalUtc(t.end));
  }
}

function applyOptionalText(v: Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") removeProp(v, name);
  else setProp(v, name, escapeText(value));
}

function applyAlarms(v: Component, alarms: number[] | null | undefined): void {
  if (alarms === undefined) return;
  v.children = v.children.filter((c) => c.name !== "VALARM");
  if (!alarms) return;
  for (const mins of alarms) {
    if (!Number.isInteger(mins) || mins < 0 || mins > 4 * 7 * 1440) throw invalidInput("alarms entries must be whole minutes before start (0..40320)");
    v.children.push({
      name: "VALARM",
      props: [
        { name: "ACTION", params: {}, value: "DISPLAY" },
        { name: "DESCRIPTION", params: {}, value: "Reminder" },
        { name: "TRIGGER", params: {}, value: minutesToTrigger(mins) },
      ],
      children: [],
    });
  }
}

function applyRecurrence(v: Component, rec: Recurrence | null | undefined, tz: string, allDay: boolean): void {
  if (rec === undefined) return;
  if (rec === null) {
    removeProp(v, "RRULE");
    removeProp(v, "EXDATE");
    removeProp(v, "RDATE");
    return;
  }
  setProp(v, "RRULE", recurrenceToRrule(rec, tz, allDay));
}

function attendeeEmail(raw: string): string {
  const email = raw.trim().replace(/^mailto:/i, "").toLowerCase();
  if (!email || /[\s<>;,:'"\\\x00-\x1f\x7f]/.test(email) || !/^[^@]+@[^@]+$/.test(email)) {
    throw invalidInput(`Invalid attendee email: "${raw}"`);
  }
  return email;
}

function attendeeName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (!name) return undefined;
  if (/[\r\n"\\\x00-\x1f\x7f]/.test(name)) throw invalidInput("attendee name contains unsupported characters");
  return name;
}

function parseAttendee(p: ReturnType<typeof getProp>): EventAttendee | undefined {
  if (!p) return undefined;
  const match = /^mailto:(.+)$/i.exec(p.value.trim());
  if (!match) return undefined;
  try {
    return {
      email: attendeeEmail(match[1]),
      ...(p.params.CN ? { name: p.params.CN } : {}),
      ...(p.params.PARTSTAT ? { participationStatus: p.params.PARTSTAT.toUpperCase() } : {}),
      ...(p.params.RSVP ? { rsvp: p.params.RSVP.toUpperCase() === "TRUE" } : {}),
      ...(p.params["SCHEDULE-STATUS"] ? { scheduleStatus: p.params["SCHEDULE-STATUS"] } : {}),
    };
  } catch {
    return undefined;
  }
}

function organizerValue(email: string): string {
  return `mailto:${attendeeEmail(email)}`;
}

function newAttendeeProperty(attendee: AttendeeInput): Component["props"][number] {
  const email = attendeeEmail(attendee.email);
  const name = attendeeName(attendee.name);
  return {
    name: "ATTENDEE",
    params: {
      ...(name ? { CN: name } : {}),
      PARTSTAT: "NEEDS-ACTION",
      RSVP: "TRUE",
    },
    value: `mailto:${email}`,
  };
}

/** Apply attendee additions/removals without replacing unrelated invitees. */
function applyAttendeeChanges(v: Component, organizerEmail: string | undefined, input: EventInput, allowOrganizerAssignment = false): boolean {
  const additions = input.attendees ?? input.addAttendees ?? [];
  const removals = input.removeAttendees ?? [];
  if (!additions.length && !removals.length) return false;

  const organizer = organizerEmail ? organizerValue(organizerEmail) : undefined;
  const currentOrganizer = getProp(v, "ORGANIZER")?.value.toLowerCase();
  const remove = new Set(removals.map(attendeeEmail));
  const existing = getProps(v, "ATTENDEE");
  const existingEmails = new Set(existing.map((p) => /^mailto:(.+)$/i.exec(p.value.trim())?.[1]?.toLowerCase()).filter((e): e is string => !!e));
  const additionsByEmail = new Map<string, AttendeeInput>();
  for (const a of additions) {
    const email = attendeeEmail(a.email);
    if (additionsByEmail.has(email)) throw invalidInput(`Duplicate attendee: "${email}"`);
    attendeeName(a.name);
    additionsByEmail.set(email, { ...a, email });
  }
  if ([...additionsByEmail.keys()].some((email) => remove.has(email))) {
    throw invalidInput("The same email cannot be added and removed in one attendee update");
  }

  const wouldRemove = [...remove].some((email) => existingEmails.has(email));
  const wouldAdd = [...additionsByEmail.keys()].some((email) => !existingEmails.has(email));
  if (!wouldRemove && !wouldAdd) return false;
  if (!organizer) throw invalidInput("Set ICLOUD_ORGANIZER_EMAIL (or use an email Apple ID) before changing invitees");
  if (!currentOrganizer && !allowOrganizerAssignment) throw invalidInput("Cannot change invitees because this event has no organizer identity");
  if (currentOrganizer && currentOrganizer !== organizer.toLowerCase()) {
    throw invalidInput("Cannot change invitees on an event organized by a different calendar user");
  }

  const before = JSON.stringify(v.props.filter((p) => p.name === "ORGANIZER" || p.name === "ATTENDEE"));
  v.props = v.props.filter((p) => {
    if (p.name !== "ATTENDEE") return true;
    const email = /^mailto:(.+)$/i.exec(p.value.trim())?.[1]?.toLowerCase();
    return !email || !remove.has(email);
  });
  if (allowOrganizerAssignment && additions.length && !currentOrganizer && organizer) {
    setProp(v, "ORGANIZER", organizer);
  }
  for (const [email, attendee] of additionsByEmail) {
    if (!existingEmails.has(email) || remove.has(email)) v.props.push(newAttendeeProperty(attendee));
  }
  const after = JSON.stringify(v.props.filter((p) => p.name === "ORGANIZER" || p.name === "ATTENDEE"));
  return before !== after;
}

export function buildNewEvent(input: EventInput, tz: string, uid: string, organizerEmail?: string): { ics: string; uid: string } {
  if (!input.title || !input.title.trim()) throw invalidInput("title is required");
  const times = resolveTimes(input, tz);
  const now = toICalUtc(new Date());
  const v: Component = {
    name: "VEVENT",
    props: [
      { name: "UID", params: {}, value: uid },
      { name: "DTSTAMP", params: {}, value: now },
      { name: "CREATED", params: {}, value: now },
      { name: "LAST-MODIFIED", params: {}, value: now },
      { name: "SUMMARY", params: {}, value: escapeText(input.title.trim()) },
    ],
    children: [],
  };
  applyTimes(v, times);
  applyOptionalText(v, "LOCATION", input.location);
  applyOptionalText(v, "DESCRIPTION", input.notes);
  if (input.url) setProp(v, "URL", input.url);
  applyRecurrence(v, input.recurrence, tz, times.allDay);
  applyAlarms(v, input.alarms);
  applyAttendeeChanges(v, organizerEmail, { attendees: input.attendees }, true);
  const vcal: Component = {
    name: "VCALENDAR",
    props: [
      { name: "VERSION", params: {}, value: "2.0" },
      { name: "PRODID", params: {}, value: PRODID },
      { name: "CALSCALE", params: {}, value: "GREGORIAN" },
    ],
    children: [v],
  };
  return { ics: serializeICalendar(vcal), uid };
}

/** Apply a partial update to an existing document's master VEVENT and re-serialize. */
export function patchEvent(parsed: ParsedEvent, current: Event, input: EventInput, tz: string, organizerEmail?: string): string {
  const v = parsed.master;
  if (input.title !== undefined) {
    if (!input.title.trim()) throw invalidInput("title cannot be empty");
    setProp(v, "SUMMARY", escapeText(input.title.trim()));
  }
  if (input.start !== undefined || input.end !== undefined || input.duration !== undefined || input.allDay !== undefined) {
    const times = resolveTimes(input, tz, current);
    applyTimes(v, times);
    if (times.allDay !== current.allDay) {
      // Switching all-day <-> timed invalidates per-instance overrides and RRULE date types.
      parsed.vcal.children = parsed.vcal.children.filter((c) => c === v || c.name !== "VEVENT");
      parsed.overrides = [];
      if (input.recurrence === undefined && current.recurrence) {
        setProp(v, "RRULE", recurrenceToRrule(current.recurrence, tz, times.allDay));
      }
    }
  }
  applyOptionalText(v, "LOCATION", input.location);
  applyOptionalText(v, "DESCRIPTION", input.notes);
  if (input.url !== undefined) {
    if (input.url === null || input.url === "") removeProp(v, "URL");
    else setProp(v, "URL", input.url);
  }
  const allDayNow = getProp(v, "DTSTART")?.params.VALUE === "DATE";
  applyRecurrence(v, input.recurrence, tz, allDayNow);
  applyAlarms(v, input.alarms);
  applyAttendeeChanges(v, organizerEmail, input);
  const now = toICalUtc(new Date());
  setProp(v, "DTSTAMP", now);
  setProp(v, "LAST-MODIFIED", now);
  setProp(v, "SEQUENCE", String((parseInt(getProp(v, "SEQUENCE")?.value ?? "0", 10) || 0) + 1));
  return serializeICalendar(parsed.vcal);
}

interface OccurrenceTarget {
  key: string;
  recurrenceId: Property;
}

function localDateTimeValue(date: Date, tz: string): string {
  const p = partsInZone(date, tz);
  return `${toICalDate(p.year, p.month, p.day)}T${String(p.hour).padStart(2, "0")}${String(p.minute).padStart(2, "0")}${String(p.second).padStart(2, "0")}`;
}

function recurrenceKey(prop: Property, tz: string): string {
  const d = parseICalDate(prop.value, prop.params, tz);
  return d.kind === "date" ? `D:${formatDateOnly(d.year, d.month, d.day)}` : `T:${d.date.toISOString()}`;
}

function findOccurrenceOverride(parsed: ParsedEvent, target: OccurrenceTarget, tz: string): Component | undefined {
  return parsed.overrides.find((override) => {
    const id = getProp(override, "RECURRENCE-ID");
    if (!id) return false;
    try { return recurrenceKey(id, tz) === target.key; } catch { return false; }
  });
}

function occurrenceTarget(parsed: ParsedEvent, occurrenceStart: string, tz: string): OccurrenceTarget {
  if (!occurrenceStart?.trim()) throw invalidInput("occurrenceStart is required for a single recurring occurrence");
  const master = parsed.master;
  const dtstart = getProp(master, "DTSTART");
  const rrule = getProp(master, "RRULE")?.value;
  if (!dtstart || !rrule) throw invalidInput("occurrenceStart can only target an event with a supported RRULE recurrence");
  const start = parseICalDate(dtstart.value, dtstart.params, tz);
  const target = parseInput(occurrenceStart, tz, "occurrenceStart");
  const allDay = start.kind === "date";
  if (allDay !== (target.kind === "date")) throw invalidInput("occurrenceStart must use the same date or date-time type as the recurring event");

  const exdates = new Set<string>();
  for (const p of getProps(master, "EXDATE")) {
    for (const raw of p.value.split(",")) {
      try {
        const ex = parseICalDate(raw, p.params, tz);
        exdates.add(ex.kind === "date" ? formatDateOnly(ex.year, ex.month, ex.day) : ex.date.toISOString());
      } catch {
        /* Ignore malformed exclusion dates; the recurrence engine still validates the requested instance. */
      }
    }
  }

  let targetOccurrence: Date | { year: number; month: number; day: number } | undefined;
  if (allDay && start.kind === "date" && target.kind === "date") {
    const result = expandRrule(rrule, {
      start: { year: start.year, month: start.month, day: start.day, hour: 0, minute: 0, second: 0 },
      allDay: true,
      tz,
      rangeStart: new Date(Date.UTC(target.year, target.month - 1, target.day)),
      rangeEnd: new Date(Date.UTC(target.year, target.month - 1, target.day + 1)),
      exdates,
      cap: 2,
    });
    if (!result.supported) throw invalidInput("This recurrence rule is not supported for single-occurrence edits");
    targetOccurrence = result.occurrences.find((o) => !(o instanceof Date) && o.year === target.year && o.month === target.month && o.day === target.day);
  } else if (start.kind === "datetime" && target.kind === "datetime") {
    if (target.date.getUTCMilliseconds() !== 0) throw invalidInput("occurrenceStart must be exact to the second");
    const recurrenceTz = dtstart.params.TZID ? (normalizeTzid(dtstart.params.TZID) ?? tz) : dtstart.value.endsWith("Z") ? "UTC" : tz;
    const startParts = partsInZone(start.date, recurrenceTz);
    const result = expandRrule(rrule, {
      start: startParts,
      allDay: false,
      tz: recurrenceTz,
      rangeStart: new Date(target.date.getTime() - 1),
      rangeEnd: new Date(target.date.getTime() + 1),
      exdates,
      cap: 2,
    });
    if (!result.supported) throw invalidInput("This recurrence rule is not supported for single-occurrence edits");
    targetOccurrence = result.occurrences.find((o): o is Date => o instanceof Date && o.getTime() === target.date.getTime());
  }
  if (!targetOccurrence) throw invalidInput(`No recurrence instance starts at "${occurrenceStart}"`);

  let value: string;
  let key: string;
  let params: Record<string, string> = {};
  if (targetOccurrence instanceof Date) {
    key = `T:${targetOccurrence.toISOString()}`;
    if (dtstart.value.endsWith("Z")) {
      value = toICalUtc(targetOccurrence);
    } else if (dtstart.params.TZID) {
      const recurrenceTz = normalizeTzid(dtstart.params.TZID) ?? tz;
      value = localDateTimeValue(targetOccurrence, recurrenceTz);
      params = { TZID: dtstart.params.TZID };
    } else {
      value = localDateTimeValue(targetOccurrence, tz);
    }
  } else {
    key = `D:${formatDateOnly(targetOccurrence.year, targetOccurrence.month, targetOccurrence.day)}`;
    value = toICalDate(targetOccurrence.year, targetOccurrence.month, targetOccurrence.day);
    params = { VALUE: "DATE" };
  }
  return { key, recurrenceId: { name: "RECURRENCE-ID", params, value } };
}

function cloneComponent<T extends Component | Property>(value: T): T {
  return structuredClone(value);
}

/** Materialize an exception as a complete VEVENT, inheriting unspecified properties from the master. */
function effectiveOverride(master: Component, override?: Component): Component {
  const event = cloneComponent(master);
  removeProp(event, "RRULE");
  removeProp(event, "RDATE");
  removeProp(event, "EXDATE");
  if (!override) return event;

  const names = new Set(override.props.map((p) => p.name).filter((n) => n !== "RECURRENCE-ID"));
  event.props = event.props.filter((p) => !names.has(p.name));
  if (names.has("DTEND")) removeProp(event, "DURATION");
  if (names.has("DURATION")) removeProp(event, "DTEND");
  for (const p of override.props) event.props.push(cloneComponent(p));
  for (const childName of new Set(override.children.map((c) => c.name))) {
    event.children = event.children.filter((c) => c.name !== childName);
    event.children.push(...override.children.filter((c) => c.name === childName).map(cloneComponent));
  }
  const rid = getProp(override, "RECURRENCE-ID");
  if (rid) setProp(event, "RECURRENCE-ID", rid.value, { ...rid.params });
  return event;
}

/** Materialize a recurrence instance with its own DTSTART/DTEND before applying an override. */
function effectiveOccurrence(master: Component, override: Component | undefined, recurrenceId: Property, tz: string): Component {
  const event = effectiveOverride(master, override);
  const masterStartProp = getProp(master, "DTSTART");
  const masterEndProp = getProp(master, "DTEND");
  const originalStart = masterStartProp ? parseICalDate(masterStartProp.value, masterStartProp.params, tz) : undefined;
  const occurrenceStart = parseICalDate(recurrenceId.value, recurrenceId.params, tz);
  const hasOverrideStart = override ? getProp(override, "DTSTART") !== undefined : false;
  if (!hasOverrideStart) setProp(event, "DTSTART", recurrenceId.value, { ...recurrenceId.params });

  const currentStartProp = getProp(event, "DTSTART");
  const overrideHasEnd = Boolean(override && (getProp(override, "DTEND") || getProp(override, "DURATION")));
  if (!overrideHasEnd && originalStart && masterEndProp && currentStartProp) {
    const originalEnd = parseICalDate(masterEndProp.value, masterEndProp.params, tz);
    const currentStart = parseICalDate(currentStartProp.value, currentStartProp.params, tz);
    if (originalStart.kind === "date" && originalEnd.kind === "date" && occurrenceStart.kind === "date" && currentStart.kind === "date") {
      const durationDays = Math.round((Date.UTC(originalEnd.year, originalEnd.month - 1, originalEnd.day) - Date.UTC(originalStart.year, originalStart.month - 1, originalStart.day)) / 86_400_000);
      const shiftedEnd = addDays(currentStart.year, currentStart.month, currentStart.day, durationDays);
      setProp(event, "DTEND", toICalDate(shiftedEnd.year, shiftedEnd.month, shiftedEnd.day), { ...masterEndProp.params });
    } else if (originalStart.kind === "datetime" && originalEnd.kind === "datetime" && occurrenceStart.kind === "datetime" && currentStart.kind === "datetime") {
      const durationMs = originalEnd.date.getTime() - originalStart.date.getTime();
      const shiftedEnd = new Date(currentStart.date.getTime() + durationMs);
      if (masterEndProp.value.endsWith("Z")) {
        setProp(event, "DTEND", toICalUtc(shiftedEnd), { ...masterEndProp.params });
      } else {
        const endTzid = masterEndProp.params.TZID ?? masterStartProp?.params.TZID;
        const endTz = endTzid ? (normalizeTzid(endTzid) ?? tz) : tz;
        setProp(event, "DTEND", localDateTimeValue(shiftedEnd, endTz), { ...masterEndProp.params });
      }
    }
  }
  return event;
}

function comparableComponent(v: Component): string {
  const c = cloneComponent(v);
  c.props = c.props.filter((p) => !["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"].includes(p.name));
  return JSON.stringify(c);
}

/** Compare calendar data while ignoring server-irrelevant change stamps. */
export function calendarDataChanged(before: string, after: string): boolean {
  const normalize = (ics: string) => {
    const vcal = parseICalendar(ics);
    for (const child of vcal.children) {
      if (child.name === "VEVENT") child.props = child.props.filter((p) => !["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"].includes(p.name));
    }
    return JSON.stringify(vcal);
  };
  return normalize(before) !== normalize(after);
}

function finalizeChangedComponent(v: Component, previous: Component): void {
  const oldSequence = Number.parseInt(getProp(previous, "SEQUENCE")?.value ?? "0", 10);
  const nextSequence = Number.isFinite(oldSequence) ? oldSequence + 1 : 1;
  const now = toICalUtc(new Date());
  setProp(v, "DTSTAMP", now);
  setProp(v, "LAST-MODIFIED", now);
  setProp(v, "SEQUENCE", String(nextSequence));
}

function eventFromComponent(v: Component, opts: ToEventOptions): Event {
  return componentToEvent({ vcal: { name: "VCALENDAR", props: [], children: [v] }, master: v, overrides: [] }, opts);
}

function storeOverride(parsed: ParsedEvent, originalOverride: Component | undefined, replacement: Component): string {
  if (originalOverride) {
    const index = parsed.vcal.children.indexOf(originalOverride);
    parsed.vcal.children[index] = replacement;
  } else {
    parsed.vcal.children.push(replacement);
  }
  return serializeICalendar(parsed.vcal);
}

export function patchOccurrence(
  parsed: ParsedEvent,
  input: EventInput,
  occurrenceStart: string,
  opts: ToEventOptions,
  organizerEmail?: string,
): { ics: string; changed: boolean; occurrence: Event } {
  if (input.recurrence !== undefined) throw invalidInput("Cannot change the recurrence rule while editing one occurrence");
  const target = occurrenceTarget(parsed, occurrenceStart, opts.tz);
  const existingOverride = findOccurrenceOverride(parsed, target, opts.tz);
  const rid = existingOverride ? getProp(existingOverride, "RECURRENCE-ID")! : target.recurrenceId;
  const originalEffective = effectiveOccurrence(parsed.master, existingOverride, rid, opts.tz);
  const working = cloneComponent(originalEffective);
  const wasCancelled = getProp(working, "STATUS")?.value.toUpperCase() === "CANCELLED";
  const hasScheduleChange = [input.title, input.start, input.end, input.duration, input.allDay, input.location, input.notes, input.url, input.alarms]
    .some((v) => v !== undefined);
  if (wasCancelled && hasScheduleChange) removeProp(working, "STATUS");
  setProp(working, "RECURRENCE-ID", rid.value, { ...rid.params });
  const before = eventFromComponent(working, opts);
  const masterStart = getProp(parsed.master, "DTSTART");
  const masterAllDay = masterStart ? parseICalDate(masterStart.value, masterStart.params, opts.tz).kind === "date" : false;
  if (input.start !== undefined || input.end !== undefined || input.duration !== undefined || input.allDay !== undefined) {
    const resolved = resolveTimes(input, opts.tz, before);
    if (resolved.allDay !== masterAllDay) throw invalidInput("A single recurring occurrence must keep the series date/time type");
  }
  const syntheticVcal: Component = { name: "VCALENDAR", props: parsed.vcal.props.map(cloneComponent), children: [working] };
  const synthetic: ParsedEvent = { vcal: syntheticVcal, master: working, overrides: [] };
  patchEvent(synthetic, before, input, opts.tz, organizerEmail);
  const candidate = synthetic.master;
  setProp(candidate, "RECURRENCE-ID", rid.value, { ...rid.params });
  const comparisonBaseline = cloneComponent(originalEffective);
  setProp(comparisonBaseline, "RECURRENCE-ID", rid.value, { ...rid.params });
  const changed = comparableComponent(comparisonBaseline) !== comparableComponent(candidate);
  if (!changed) return { ics: serializeICalendar(parsed.vcal), changed: false, occurrence: eventFromComponent(originalEffective, opts) };
  finalizeChangedComponent(candidate, originalEffective);
  return { ics: storeOverride(parsed, existingOverride, candidate), changed: true, occurrence: eventFromComponent(candidate, opts) };
}

export function cancelOccurrence(parsed: ParsedEvent, occurrenceStart: string, opts: ToEventOptions): { ics: string; changed: boolean; occurrence: Event } {
  const target = occurrenceTarget(parsed, occurrenceStart, opts.tz);
  const existingOverride = findOccurrenceOverride(parsed, target, opts.tz);
  const rid = existingOverride ? getProp(existingOverride, "RECURRENCE-ID")! : target.recurrenceId;
  const previous = effectiveOccurrence(parsed.master, existingOverride, rid, opts.tz);
  if (getProp(previous, "STATUS")?.value.toUpperCase() === "CANCELLED") {
    return { ics: serializeICalendar(parsed.vcal), changed: false, occurrence: eventFromComponent(previous, opts) };
  }
  const cancelled = cloneComponent(previous);
  setProp(cancelled, "RECURRENCE-ID", rid.value, { ...rid.params });
  setProp(cancelled, "STATUS", "CANCELLED");
  finalizeChangedComponent(cancelled, previous);
  return { ics: storeOverride(parsed, existingOverride, cancelled), changed: true, occurrence: eventFromComponent(cancelled, opts) };
}
