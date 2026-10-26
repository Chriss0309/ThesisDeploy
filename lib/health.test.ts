import { describe, expect, it, vi } from "vitest";

import { getHealth, type DatabaseProbe } from "@/lib/health";

const DATABASE_URL = "postgresql://user:pass@localhost:6543/postgres";
const healthyDb: DatabaseProbe = async () => ({ status: "ok", latencyMs: 4 });

describe("getHealth", () => {
  it("is ok when the env is valid and the database check passes", async () => {
    const probe = vi.fn(healthyDb);
    const report = await getHealth({ NODE_ENV: "test", DATABASE_URL }, probe);
    expect(probe).toHaveBeenCalledWith(DATABASE_URL);
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
        database: { status: "ok", latencyMs: 4 },
      },
    });
  });

  it("is degraded without DATABASE_URL and never probes", async () => {
    const probe = vi.fn(healthyDb);
    const report = await getHealth({ NODE_ENV: "test" }, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(report.status).toBe("degraded");
    expect(report.checks.database).toEqual({ status: "error", reason: "not_configured" });
  });

  it("is degraded when the database check fails", async () => {
    const report = await getHealth({ NODE_ENV: "test", DATABASE_URL }, async () => ({
      status: "error",
      missingTables: ["sessions"],
    }));
    expect(report.status).toBe("degraded");
    expect(report.checks.database).toEqual({ status: "error", missingTables: ["sessions"] });
  });

  it("is degraded when a variable is malformed", async () => {
    const report = await getHealth(
      { NODE_ENV: "test", APP_BASE_URL: "not a url", DATABASE_URL },
      healthyDb,
    );
    expect(report.status).toBe("degraded");
    expect(report.checks.env).toEqual({ status: "error", invalid: ["APP_BASE_URL"] });
    expect(report.checks.database).toEqual({ status: "error", reason: "env_invalid" });
  });

  it("reports the Vercel environment and short commit", async () => {
    const report = await getHealth(
      {
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef",
        DATABASE_URL,
      },
      healthyDb,
    );
    expect(report.environment).toBe("preview");
    expect(report.commit).toBe("0123456");
  });
});
