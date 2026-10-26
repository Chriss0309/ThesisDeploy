import { connection } from "next/server";

import { getHealth } from "@/lib/health";

export const maxDuration = 10;

export async function GET() {
  await connection();
  const report = getHealth();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
