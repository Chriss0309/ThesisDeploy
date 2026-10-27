"use client";

import { useEffect } from "react";

/** Wakes the serverless host. The landing page does not show a health status. */
export function BackendStatus() {
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { cache: "no-store", signal: controller.signal }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return null;
}
