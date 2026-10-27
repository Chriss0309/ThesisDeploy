"use client";

import { defineMotionElements } from "./element";

// Evaluated with the root layout's client code, before hydration, so motifs inside
// streamed Suspense fallbacks (never hydrated) start on their own.
defineMotionElements();

export function MotionRuntime() {
  return null;
}
