import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// RLS is enabled with no policies on every table: only the server's direct
// Postgres connection (table owner) can read or write; Supabase's anon and
// authenticated API roles get nothing.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();

export const appUsers = pgTable("app_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // OIDC `sub` from the SnapTrade id_token.
  snaptradeUserId: text("snaptrade_user_id").notNull().unique(),
  email: text("email"),
  emailVerified: boolean("email_verified"),
  name: text("name"),
  createdAt: createdAt(),
  lastLoginAt: timestamptz("last_login_at").notNull().defaultNow(),
}).enableRLS();

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 (hex) of the opaque cookie token; the raw token is never stored.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
).enableRLS();

// Single-use PKCE/OIDC state, consumed with DELETE ... RETURNING.
export const oauthLoginAttempts = pgTable("oauth_login_attempts", {
  state: text("state").primaryKey(),
  codeVerifierEnc: text("code_verifier_enc").notNull(),
  nonce: text("nonce").notNull(),
  returnTo: text("return_to"),
  createdAt: createdAt(),
  expiresAt: timestamptz("expires_at").notNull(),
}).enableRLS();

// Refresh tokens rotate: update this row under SELECT ... FOR UPDATE.
export const oauthGrants = pgTable("oauth_grants", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => appUsers.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessExpiresAt: timestamptz("access_expires_at").notNull(),
  scope: text("scope").notNull(),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  revokedAt: timestamptz("revoked_at"),
}).enableRLS();

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("events_name_created_at_idx").on(table.name, table.createdAt),
    index("events_user_id_idx").on(table.userId),
  ],
).enableRLS();

export const apiCalls = pgTable(
  "api_calls",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    operation: text("operation").notNull(),
    brokerageSlug: text("brokerage_slug"),
    // Hashed account ID; raw account IDs and numbers never reach telemetry.
    accountHash: text("account_hash"),
    // Null when no response arrived (timeout or network error).
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms").notNull(),
    requestId: text("request_id"),
    accountRemaining: integer("account_remaining"),
    createdAt: createdAt(),
  },
  (table) => [
    index("api_calls_operation_created_at_idx").on(table.operation, table.createdAt),
    index("api_calls_user_id_idx").on(table.userId),
  ],
).enableRLS();

export const appTables = [
  appUsers,
  sessions,
  oauthLoginAttempts,
  oauthGrants,
  events,
  apiCalls,
];
