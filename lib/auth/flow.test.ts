import { describe, expect, it } from "vitest";

import { completeLogin, safeReturnTo } from "@/lib/auth/flow";

describe("safeReturnTo", () => {
  it.each([
    ["/theses/123?tab=drift", "/theses/123?tab=drift"],
    [null, "/"],
    ["", "/"],
    ["https://evil.example", "/"],
    ["//evil.example/path", "/"],
    ["/\\evil.example", "/"],
    ["relative/path", "/"],
    [`/${"a".repeat(600)}`, "/"],
  ])("%s -> %s", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe("completeLogin state binding", () => {
  // These paths return before touching the database or the provider.
  const config = {} as Parameters<typeof completeLogin>[0];
  const params = { code: "code", state: "state-from-url", error: null, iss: null };

  it("rejects a callback without the browser's state cookie", async () => {
    await expect(completeLogin(config, params, undefined)).resolves.toEqual({
      ok: false,
      error: "state_mismatch",
    });
  });

  it("rejects a callback whose state differs from the cookie", async () => {
    await expect(completeLogin(config, params, "state-from-another-login")).resolves.toEqual({
      ok: false,
      error: "state_mismatch",
    });
  });

  it("rejects a callback without state", async () => {
    await expect(completeLogin(config, { ...params, state: null }, "x")).resolves.toEqual({
      ok: false,
      error: "state_mismatch",
    });
  });
});
