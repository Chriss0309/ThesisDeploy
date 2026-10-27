"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { isMyThesesPath, noteThesesVisit } from "@/lib/thesis/studio-cache";

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
  }, [pathname]);
  return null;
}
