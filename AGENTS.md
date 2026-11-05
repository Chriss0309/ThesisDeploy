<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

- Use tRPC for all server-side logic. Never use server actions or API routes for business logic. `app/api/auth/login`, `app/api/auth/callback`, and `app/api/health` stay plain routes: they are browser redirects and an uptime probe, not business logic.
- Always try to create components using highly reusable subcomponents, and always look for and follow DRY principles.
- Keep changes minimal and readable. Prefer simple, explicit code over clever abstractions.
- When creating types or constants, define them in appropriate files in the top-level `types/` or `constants/` folder. Mapping functions also go in `constants/`.
- Don't make redundant markdown files documenting things.
- Use absolute imports, no relative imports. No dynamic imports, except the `import()` calls that lazy-load three.js, which keep it out of every page's first load.
- Never use alerts, use modals instead.
- Always implement loading states when appropriate, using the `components/loader` motifs described in `docs/design-system.md`. Never use spinners.
- Never assume I am right. Challenge anything I say if you think there's a chance I'm wrong.

## tRPC usage guidelines

### Client-side usage

- Always import the tRPC hook: `import { useTRPC } from "@/lib/trpc/client"`, then `const trpc = useTRPC()`
- Use hooks for queries: `useQuery(trpc.routerName.procedureName.queryOptions({ input }))`
- Use hooks for mutations: `useMutation(trpc.routerName.procedureName.mutationOptions())`
- Access the query client for invalidation: `const queryClient = useQueryClient()`
- Use `mutateAsync()` for mutations when you need to await the result
- Handle errors with try/catch when using `mutateAsync()`, and read them with `readClientError` from `@/lib/trpc/errors`
- Use `useTRPCClient()` only for streamed procedures, imperative re-reads, and calls that need a per-call `signal` or `context`

### Server-side usage

- Use server caller helper: `import { createTrpcServerCaller } from "@/lib/trpc/server"`
- Create caller: `const caller = await createTrpcServerCaller()`
- Call procedures: `await caller.routerName.procedureName({ input })`
- Always await the caller creation and procedure calls
- Create the caller inside a Suspense-wrapped async component, because it reads cookies
- Use `procedureFailure(error)` from `@/lib/errors` to tell failures apart: it unwraps what the procedure threw

### Router organization

- Create routers in `server/routers/` directory
- Each router should be in its own file (e.g., `user.ts`, `admin.ts`)
- Export router: `export const routerName = router({ ... })`
- Import and combine in `server/index.ts`: `router({ routerName: routerNameRouter })`

### Procedures

- Use `publicProcedure` for unauthenticated endpoints
- Use `protectedProcedure` for authenticated endpoints (automatically has `ctx.user`)
- Use `adminProcedure` for admin-only endpoints (extends `protectedProcedure`). It is not built yet because there are no admin endpoints
- Use `databaseProcedure`, `protectedDatabaseProcedure`, or `actorProcedure` (a signed-in user or a guest, as `ctx.actor`) when a procedure needs the database
- Always use Zod for input validation: `.input(z.object({ ... }))`
- Use `.query()` for read operations, `.mutation()` for write operations

### Error handling

- tRPC errors are automatically formatted
- Client-side: Handle errors in mutation callbacks or try/catch blocks
- Server-side: Errors are logged in the API route handler
- Use TRPCError for custom errors: `throw new TRPCError({ code: "UNAUTHORIZED", message: "..." })`
- Domain code throws `AppError` from `@/lib/errors`, which carries a code the client can branch on
- Only `PublicError` details reach a client. Any other internal failure sends a generic message, because raw messages can echo secrets
- Put a procedure's user-facing failure wording in `.meta({ invalidInput, signedOut, failure })`

### Loading states

- Queries: Use `isLoading` or `isPending` from `useQuery` hook
- Mutations: Use `isPending` from `useMutation` hook
- Always show loading states in UI (`components/loader` motifs, never spinners)

### Query invalidation

- Use `queryClient.invalidateQueries(trpc.routerName.procedureName.queryFilter())` to refetch data
- Call invalidation in mutation `onSuccess` callbacks when data changes
- Use `queryClient.invalidateQueries({ queryKey: trpc.pathKey() })` to invalidate all queries if needed
