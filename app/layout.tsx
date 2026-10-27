import type { Metadata } from "next";
import { Suspense } from "react";

import { MotionRuntime } from "@/components/loader/runtime";
import { StudioCacheListener } from "@/components/thesis/studio-cache-listener";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "ThesisDeploy",
  description:
    "Turn an investment thesis into a portfolio-aware, whole-share stock basket and execute it through SnapTrade, live or in paper mode.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fontVariables} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {children}
        <MotionRuntime />
        <Suspense fallback={null}>
          <StudioCacheListener />
        </Suspense>
      </body>
    </html>
  );
}
