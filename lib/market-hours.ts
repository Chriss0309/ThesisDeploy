/**
 * Regular-session calendar for NYSE and TSX: 9:30–16:00 Eastern, 13:00 on
 * early-close days. Dates outside the listed years report "no_calendar", so
 * Live trading fails closed until the table is extended.
 */

export type Market = "NYSE" | "TSX";

type Calendar = {
  timeZone: string;
  years: readonly number[];
  holidays: Readonly<Record<string, string>>;
  earlyCloses: Readonly<Record<string, string>>;
};

const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 16 * 60;
const EARLY_CLOSE_MINUTE = 13 * 60;

// Source: nyse.com/markets/hours-calendars (2026 and 2027 published).
const NYSE: Calendar = {
  timeZone: "America/New_York",
  years: [2026, 2027],
  holidays: {
    "2026-01-01": "New Year's Day",
    "2026-01-19": "Martin Luther King, Jr. Day",
    "2026-02-16": "Washington's Birthday",
    "2026-04-03": "Good Friday",
    "2026-05-25": "Memorial Day",
    "2026-06-19": "Juneteenth",
    "2026-07-03": "Independence Day (observed)",
    "2026-09-07": "Labor Day",
    "2026-11-26": "Thanksgiving Day",
    "2026-12-25": "Christmas Day",
    "2027-01-01": "New Year's Day",
    "2027-01-18": "Martin Luther King, Jr. Day",
    "2027-02-15": "Washington's Birthday",
    "2027-03-26": "Good Friday",
    "2027-05-31": "Memorial Day",
    "2027-06-18": "Juneteenth (observed)",
    "2027-07-05": "Independence Day (observed)",
    "2027-09-06": "Labor Day",
    "2027-11-25": "Thanksgiving Day",
    "2027-12-24": "Christmas Day (observed)",
  },
  earlyCloses: {
    "2026-11-27": "Day after Thanksgiving",
    "2026-12-24": "Christmas Eve",
    "2027-11-26": "Day after Thanksgiving",
  },
};

// Source: tsx.com calendar for 2026. TMX had not published 2027 as of
// 2026-10-26; those dates follow TMX's weekend-observance rules (same layout
// as 2021) and must be checked against TMX once published.
const TSX: Calendar = {
  timeZone: "America/Toronto",
  years: [2026, 2027],
  holidays: {
    "2026-01-01": "New Year's Day",
    "2026-02-16": "Family Day",
    "2026-04-03": "Good Friday",
    "2026-05-18": "Victoria Day",
    "2026-07-01": "Canada Day",
    "2026-08-03": "Civic Holiday",
    "2026-09-07": "Labour Day",
    "2026-10-12": "Thanksgiving Day",
    "2026-12-25": "Christmas Day",
    "2026-12-28": "Boxing Day (observed)",
    "2027-01-01": "New Year's Day",
    "2027-02-15": "Family Day",
    "2027-03-26": "Good Friday",
    "2027-05-24": "Victoria Day",
    "2027-07-01": "Canada Day",
    "2027-08-02": "Civic Holiday",
    "2027-09-06": "Labour Day",
    "2027-10-11": "Thanksgiving Day",
    "2027-12-27": "Christmas Day (observed)",
    "2027-12-28": "Boxing Day (observed)",
  },
  earlyCloses: {
    "2026-12-24": "Christmas Eve",
    "2027-12-24": "Christmas Eve",
  },
};

const CALENDARS: Record<Market, Calendar> = { NYSE, TSX };

export type ClosedReason = "weekend" | "holiday" | "pre_open" | "after_close" | "no_calendar";

export type MarketStatus =
  | { market: Market; open: true; closesAt: Date; earlyClose: boolean }
  | {
      market: Market;
      open: false;
      reason: ClosedReason;
      holiday?: string;
      /** null when the next session is past the end of the calendar. */
      nextOpen: Date | null;
    };

/** Baskets are single-currency: CAD trades on TSX, USD on US exchanges. */
export function marketForCurrency(currency: string): Market | null {
  const code = currency.toUpperCase();
  return code === "USD" ? "NYSE" : code === "CAD" ? "TSX" : null;
}

export function marketStatus(market: Market, now: Date = new Date()): MarketStatus {
  const calendar = CALENDARS[market];
  const today = localDate(now, calendar.timeZone);
  const day = describeDay(calendar, today);

  if (day.kind === "session" && now >= day.opensAt && now < day.closesAt) {
    return { market, open: true, closesAt: day.closesAt, earlyClose: day.earlyClose };
  }
  const reason: ClosedReason =
    day.kind === "session" ? (now < day.opensAt ? "pre_open" : "after_close") : day.kind;
  return {
    market,
    open: false,
    reason,
    ...(day.kind === "holiday" ? { holiday: day.name } : {}),
    nextOpen: nextOpen(calendar, today, now),
  };
}

type LocalDate = { year: number; month: number; day: number };

type Day =
  | { kind: "session"; opensAt: Date; closesAt: Date; earlyClose: boolean }
  | { kind: "weekend" }
  | { kind: "holiday"; name: string }
  | { kind: "no_calendar" };

function describeDay(calendar: Calendar, date: LocalDate): Day {
  if (!calendar.years.includes(date.year)) return { kind: "no_calendar" };
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return { kind: "weekend" };
  const key = dateKey(date);
  const holiday = calendar.holidays[key];
  if (holiday) return { kind: "holiday", name: holiday };
  const earlyClose = key in calendar.earlyCloses;
  return {
    kind: "session",
    opensAt: zonedInstant(date, OPEN_MINUTE, calendar.timeZone),
    closesAt: zonedInstant(date, earlyClose ? EARLY_CLOSE_MINUTE : CLOSE_MINUTE, calendar.timeZone),
    earlyClose,
  };
}

const MAX_CLOSED_RUN_DAYS = 10;

function nextOpen(calendar: Calendar, today: LocalDate, now: Date): Date | null {
  for (let offset = 0; offset <= MAX_CLOSED_RUN_DAYS; offset++) {
    const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const day = describeDay(calendar, {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    });
    if (day.kind === "no_calendar") return null;
    if (day.kind === "session" && day.opensAt > now) return day.opensAt;
  }
  return null;
}

function dateKey({ year, month, day }: LocalDate) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

function localDate(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = wallClock(instant, timeZone);
  return { year, month, day };
}

function utcOffsetMs(instant: Date, timeZone: string) {
  const { year, month, day, hour, minute, second } = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return wallAsUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

function zonedInstant(date: LocalDate, minuteOfDay: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  const firstGuess = wallAsUtc - utcOffsetMs(new Date(wallAsUtc), timeZone);
  return new Date(wallAsUtc - utcOffsetMs(new Date(firstGuess), timeZone));
}
