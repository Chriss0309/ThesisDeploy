import "server-only";

import { cache } from "react";

import { appRouter } from "@/server";
import { createServerContext } from "@/server/context";
import { createCallerFactory } from "@/server/trpc";

const createCaller = createCallerFactory(appRouter);

/** One per render, so a page and the components under it share one session lookup. */
export const createTrpcServerCaller = cache(async () => createCaller(await createServerContext()));
