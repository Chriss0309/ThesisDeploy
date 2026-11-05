"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchStreamLink, httpLink, splitLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState, type ReactNode } from "react";

import { STREAMED_PROCEDURES, TRPC_ENDPOINT } from "@/constants/trpc";
import type { AppRouter } from "@/server";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/**
 * `networkMode: "always"`: by default TanStack holds a call while the browser reports
 * offline and sends it on reconnect, so a confirm could place orders long after the
 * click, with no error shown. Here a call fails at once and the caller says so.
 */
export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, networkMode: "always" },
      mutations: { networkMode: "always" },
    },
  });

let browserQueryClient: QueryClient | undefined;

/** One client per browser, and a fresh one per server render so requests never share a cache. */
function getQueryClient() {
  if (typeof window === "undefined") return makeQueryClient();
  return (browserQueryClient ??= makeQueryClient());
}

const makeTrpcClient = () =>
  createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => STREAMED_PROCEDURES.has(op.path),
        true: httpBatchStreamLink({ url: TRPC_ENDPOINT, maxItems: 1 }),
        false: splitLink({
          // Survives the page unloading, for telemetry sent as the visitor leaves.
          condition: (op) => op.context.keepalive === true,
          true: httpLink({
            url: TRPC_ENDPOINT,
            fetch: (input, init) => fetch(input, { ...init, keepalive: true }),
          }),
          false: httpLink({ url: TRPC_ENDPOINT }),
        }),
      }),
    ],
  });

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(makeTrpcClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
