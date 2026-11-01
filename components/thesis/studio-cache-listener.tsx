"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import type { AuthNotice } from "@/lib/auth/http";
import {
  STUDIO_SNAPSHOT_KEY,
  dropExpiredStudioSnapshots,
  isMyThesesPath,
  noteThesesVisit,
  writeStudioSnapshot,
} from "@/lib/thesis/studio-cache";

const SIGNED_OUT: ReadonlySet<string> = new Set<AuthNotice>(["signed_out", "disconnected", "disconnect_partial"]);

/**
 * My Theses lives outside Thesis Studio. The root layout stays mounted when
 * Activity hides Studio, so a visit here still reaches a preserved Studio page.
 */
export function StudioCacheListener() {
  const pathname = usePathname();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current === pathname) return;
    seen.current = pathname;
    if (isMyThesesPath(pathname)) noteThesesVisit();
    dropExpiredStudioSnapshots(Date.now());
    if (SIGNED_OUT.has(new URLSearchParams(window.location.search).get("auth") ?? "")) {
      writeStudioSnapshot(STUDIO_SNAPSHOT_KEY.live, null);
    }
  }, [pathname]);
  return null;
}
