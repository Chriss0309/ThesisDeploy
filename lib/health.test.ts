import { describe, expect, it } from "vitest";

import { getHealth } from "@/lib/health";

describe("getHealth", () => {
  it("is ok with no secrets configured", () => {
    const report = getHealth({ NODE_ENV: "test" });
    expect(report).toMatchObject({
      status: "ok",
      service: "thesisdeploy",
      environment: "test",
      commit: null,
      checks: {
        env: {
          status: "ok",
          features: { snaptradeOAuth: false, anthropic: false, liveTrading: false },
        },
      },
    });
  });

  it("is degraded when a variable is malformed", () => {
    const report = getHealth({ NODE_ENV: "test", APP_BASE_URL: "not a url" });
    expect(report.status).toBe("degraded");
    expect(report.checks.env).toEqual({ status: "error", invalid: ["APP_BASE_URL"] });
  });

  it("reports the Vercel environment and short commit", () => {
    const report = getHealth({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
    });
    expect(report.environment).toBe("preview");
    expect(report.commit).toBe("0123456");
  });
});
