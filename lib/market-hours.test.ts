import { describe, expect, it } from "vitest";

import { marketForCurrency, marketStatus } from "@/lib/market-hours";

const at = (iso: string) => new Date(iso);

describe("marketStatus", () => {
  it("is open from 9:30 to 16:00 Eastern on a regular weekday", () => {
    // 2026-10-26 is a Monday on daylight time (UTC−4).
    expect(marketStatus("NYSE", at("2026-10-26T13:29:59Z"))).toEqual({
      market: "NYSE",
      open: false,
      reason: "pre_open",
      nextOpen: at("2026-10-26T13:30:00Z"),
    });
    expect(marketStatus("NYSE", at("2026-10-26T13:30:00Z"))).toEqual({
      market: "NYSE",
      open: true,
      closesAt: at("2026-10-26T20:00:00Z"),
      earlyClose: false,
    });
    expect(marketStatus("NYSE", at("2026-10-26T20:00:00Z"))).toMatchObject({
      open: false,
      reason: "after_close",
      nextOpen: at("2026-10-27T13:30:00Z"),
    });
  });

  it("follows daylight-saving changes", () => {
    // DST ends 2026-11-01: Monday's open moves to 14:30 UTC.
    expect(marketStatus("NYSE", at("2026-10-31T15:00:00Z"))).toMatchObject({
      reason: "weekend",
      nextOpen: at("2026-11-02T14:30:00Z"),
    });
    // DST starts 2026-03-08: Friday opens 14:30 UTC, Monday 13:30 UTC.
    expect(marketStatus("TSX", at("2026-03-06T14:30:00Z")).open).toBe(true);
    expect(marketStatus("TSX", at("2026-03-06T21:30:00Z"))).toMatchObject({
      reason: "after_close",
      nextOpen: at("2026-03-09T13:30:00Z"),
    });
  });

  it("closes on holidays and skips them for the next open", () => {
    expect(marketStatus("NYSE", at("2026-04-03T15:00:00Z"))).toEqual({
      market: "NYSE",
      open: false,
      reason: "holiday",
      holiday: "Good Friday",
      nextOpen: at("2026-04-06T13:30:00Z"),
    });
  });

  it("keeps separate US and Canadian holidays", () => {
    const usThanksgiving = at("2026-11-26T16:00:00Z");
    expect(marketStatus("NYSE", usThanksgiving)).toMatchObject({ reason: "holiday", holiday: "Thanksgiving Day" });
    expect(marketStatus("TSX", usThanksgiving).open).toBe(true);

    const canadianThanksgiving = at("2026-10-12T15:00:00Z");
    expect(marketStatus("TSX", canadianThanksgiving)).toMatchObject({ reason: "holiday", holiday: "Thanksgiving Day" });
    expect(marketStatus("NYSE", canadianThanksgiving).open).toBe(true);
  });

  it("closes at 13:00 Eastern on early-close days", () => {
    expect(marketStatus("NYSE", at("2026-11-27T17:30:00Z"))).toEqual({
      market: "NYSE",
      open: true,
      closesAt: at("2026-11-27T18:00:00Z"),
      earlyClose: true,
    });
    expect(marketStatus("NYSE", at("2026-11-27T18:30:00Z"))).toMatchObject({
      reason: "after_close",
      nextOpen: at("2026-11-30T14:30:00Z"),
    });
  });

  it("skips the TSX Christmas and Boxing Day closures", () => {
    const afterChristmasEve = at("2026-12-24T19:00:00Z");
    expect(marketStatus("TSX", afterChristmasEve)).toMatchObject({
      reason: "after_close",
      nextOpen: at("2026-12-29T14:30:00Z"),
    });
    expect(marketStatus("NYSE", afterChristmasEve)).toMatchObject({
      nextOpen: at("2026-12-28T14:30:00Z"),
    });
  });

  it("uses the 2027 observed dates", () => {
    expect(marketStatus("NYSE", at("2027-06-18T15:00:00Z")).open).toBe(false);
    expect(marketStatus("NYSE", at("2027-07-05T15:00:00Z")).open).toBe(false);
    expect(marketStatus("NYSE", at("2027-12-24T15:00:00Z")).open).toBe(false);
    // NYSE stays open on Friday 2027-12-31 even though New Year's Day 2028 is a Saturday.
    expect(marketStatus("NYSE", at("2027-12-31T15:00:00Z")).open).toBe(true);
    expect(marketStatus("TSX", at("2027-12-28T15:00:00Z"))).toMatchObject({ holiday: "Boxing Day (observed)" });
  });

  it("fails closed past the end of the calendar", () => {
    expect(marketStatus("NYSE", at("2028-01-03T15:00:00Z"))).toEqual({
      market: "NYSE",
      open: false,
      reason: "no_calendar",
      nextOpen: null,
    });
    expect(marketStatus("NYSE", at("2027-12-31T22:00:00Z"))).toMatchObject({
      reason: "after_close",
      nextOpen: null,
    });
  });
});

describe("marketForCurrency", () => {
  it("maps basket currencies to their market", () => {
    expect(marketForCurrency("USD")).toBe("NYSE");
    expect(marketForCurrency("cad")).toBe("TSX");
    expect(marketForCurrency("EUR")).toBeNull();
  });
});
