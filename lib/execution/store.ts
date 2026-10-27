import { getDb } from "@/lib/db/client";
import type { SubmitResult } from "@/lib/execution/submitters";
import { deriveStatus, isRetryable } from "@/lib/execution/summary";
import type {
  BasketView,
  ExecutionMode,
  ExecutionStatus,
  ExecutionView,
  LegStatus,
  LegView,
  PreflightOrder,
} from "@/lib/execution/types";
import { Prisma, type ExecutionLeg } from "@/lib/generated/prisma/client";
import type { RiskProfile } from "@/lib/thesis/schema";

type Tx = Prisma.TransactionClient;

/** Who is asking: a signed-in user, a guest demo cookie, or both (a signed-in user on /demo). */
export type Actor = { userId: string | null; guestKey: string | null };

export class ExecutionError extends Error {
  name = "ExecutionError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: { retryAfterSeconds?: number | null; executionId?: string | null } = {},
  ) {
    super(message);
  }
}

/** Baskets are visible only to their owner; an actor without identity sees nothing. */
function ownedBy(actor: Actor): Prisma.BasketWhereInput {
  const owners: Prisma.BasketWhereInput[] = [];
  if (actor.userId) owners.push({ userId: actor.userId });
  if (actor.guestKey) owners.push({ userId: null, guestKey: actor.guestKey });
  return owners.length > 0 ? { OR: owners } : { id: { in: [] } };
}

export const basketPath = (basket: { id: string; userId: string | null }) =>
  basket.userId ? `/baskets/${basket.id}` : `/demo/baskets/${basket.id}`;

const num = (value: Prisma.Decimal | null) => (value == null ? null : value.toNumber());
const iso = (value: Date | null) => value?.toISOString() ?? null;

export function toLegView(leg: ExecutionLeg): LegView {
  return {
    id: leg.id,
    seq: leg.seq,
    attempt: leg.attempt,
    action: leg.action as LegView["action"],
    symbol: leg.symbol,
    units: leg.units,
    estPrice: leg.estPrice.toNumber(),
    status: leg.status as LegStatus,
    brokerageOrderId: leg.brokerageOrderId,
    filledUnits: leg.filledUnits,
    fillPrice: num(leg.fillPrice),
    errorCode: leg.errorCode,
    errorMessage: leg.errorMessage,
    claimedAt: iso(leg.claimedAt),
    submittedAt: iso(leg.submittedAt),
  };
}

const executionInclude = {
  legs: { orderBy: [{ seq: "asc" }, { attempt: "asc" }] },
  basket: { select: { id: true, userId: true, currency: true, accountName: true } },
} satisfies Prisma.ExecutionInclude;

type ExecutionRow = Prisma.ExecutionGetPayload<{ include: typeof executionInclude }>;

function toExecutionView(row: ExecutionRow): ExecutionView {
  return {
    id: row.id,
    basketId: row.basketId,
    basketPath: basketPath(row.basket),
    kind: "deploy",
    mode: row.mode as ExecutionMode,
    status: row.status as ExecutionStatus,
    currency: row.basket.currency,
    accountName: row.basket.accountName,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    simulateRejectSeq: row.simulateRejectSeq,
    legs: row.legs.map(toLegView),
  };
}

export async function loadExecutionView(executionId: string): Promise<ExecutionView> {
  return toExecutionView(
    await getDb().execution.findUniqueOrThrow({ where: { id: executionId }, include: executionInclude }),
  );
}

export type OwnedExecution = {
  view: ExecutionView;
  accountKey: string;
  brokerageSlug: string | null;
  userId: string | null;
  guestKey: string | null;
};

export async function findExecutionForActor(executionId: string, actor: Actor): Promise<OwnedExecution | null> {
  const row = await getDb().execution.findFirst({
    where: { id: executionId, basket: ownedBy(actor) },
    include: {
      ...executionInclude,
      basket: { select: { ...executionInclude.basket.select, brokerageSlug: true, guestKey: true } },
    },
  });
  if (!row) return null;
  return {
    view: toExecutionView(row),
    accountKey: row.accountKey,
    brokerageSlug: row.basket.brokerageSlug,
    userId: row.basket.userId,
    guestKey: row.basket.guestKey,
  };
}

export async function findBasketView(basketId: string, actor: Actor): Promise<BasketView | null> {
  const basket = await getDb().basket.findFirst({
    where: { id: basketId, ...ownedBy(actor) },
    include: {
      constituents: true,
      executions: { orderBy: { createdAt: "desc" }, take: 1, include: executionInclude },
    },
  });
  if (!basket) return null;
  const preflight = basket.preflight as { orders?: PreflightOrder[]; priceSource?: "snaptrade" | "demo" };
  const order = new Map((preflight.orders ?? []).map((entry) => [entry.symbol, entry.seq]));
  return {
    id: basket.id,
    title: basket.title,
    summary: basket.summary,
    riskProfile: basket.riskProfile as RiskProfile,
    mode: basket.mode as ExecutionMode | null,
    status: basket.status as BasketView["status"],
    currency: basket.currency,
    budget: basket.budget.toNumber(),
    account: { name: basket.accountName, institution: basket.institution },
    priceSource: preflight.priceSource ?? "snaptrade",
    createdAt: basket.createdAt.toISOString(),
    deployedAt: iso(basket.deployedAt),
    constituents: basket.constituents
      .map((row) => ({
        symbol: row.symbol,
        companyName: row.companyName,
        targetWeight: row.targetWeight,
        plannedUnits: row.plannedUnits,
        ledgerUnits: row.ledgerUnits,
        costTotal: row.costTotal.toNumber(),
      }))
      .sort((a, b) => (order.get(a.symbol) ?? 99) - (order.get(b.symbol) ?? 99)),
    execution: basket.executions[0] ? toExecutionView(basket.executions[0]) : null,
  };
}

export type DraftInput = {
  basketId?: string | null;
  owner: { userId: string | null; guestKey: string | null; guestClient: string | null };
  thesisId: string | null;
  account: { id: string; name: string; institution: string; brokerageSlug: string | null };
  accountKey: string;
  currency: string;
  budget: number;
  thesis: { title: string; summary: string; riskProfile: RiskProfile };
  preflight: Prisma.InputJsonObject;
  preparedAt: Date;
  orders: readonly PreflightOrder[];
};

/** Saves the pre-flight as a draft basket; refreshing reuses the caller's own untouched draft. */
export async function saveDraftBasket(input: DraftInput): Promise<string> {
  const constituents = input.orders.map((order) => ({
    symbol: order.symbol,
    companyName: order.companyName,
    universalSymbolId: order.universalSymbolId,
    targetWeight: order.targetWeight,
    plannedUnits: order.units,
  }));
  const data = {
    thesisId: input.thesisId,
    accountId: input.account.id,
    accountName: input.account.name,
    institution: input.account.institution,
    brokerageSlug: input.account.brokerageSlug,
    accountKey: input.accountKey,
    currency: input.currency,
    budget: input.budget,
    title: input.thesis.title,
    summary: input.thesis.summary,
    riskProfile: input.thesis.riskProfile,
    preflight: input.preflight,
    preflightAt: input.preparedAt,
  };
  const db = getDb();
  if (input.basketId) {
    const reused = await db.$transaction(async (tx) => {
      const draft = await tx.basket.findFirst({
        where: {
          id: input.basketId!,
          status: "draft",
          executions: { none: {} },
          ...ownedBy({ userId: input.owner.userId, guestKey: input.owner.guestKey }),
        },
        select: { id: true },
      });
      if (!draft) return null;
      await tx.basketConstituent.deleteMany({ where: { basketId: draft.id } });
      await tx.basket.update({ where: { id: draft.id }, data: { ...data, constituents: { create: constituents } } });
      return draft.id;
    });
    if (reused) return reused;
  }
  const basket = await db.basket.create({
    data: { ...data, ...input.owner, constituents: { create: constituents } },
    select: { id: true },
  });
  return basket.id;
}

const DAY_MS = 24 * 3600 * 1000;

export async function guestUsage(guestClient: string) {
  const since = new Date(Date.now() - DAY_MS);
  const db = getDb();
  const [preflights, runs, allRuns] = await Promise.all([
    db.basket.count({ where: { guestClient, createdAt: { gt: since } } }),
    db.execution.count({ where: { basket: { guestClient }, createdAt: { gt: since } } }),
    db.execution.count({ where: { basket: { userId: null }, createdAt: { gt: since } } }),
  ]);
  return { preflights, runs, allRuns };
}

export async function findOwnedBasket(basketId: string, actor: Actor) {
  return getDb().basket.findFirst({ where: { id: basketId, ...ownedBy(actor) } });
}

async function activeExecutionId(accountKey: string): Promise<string | null> {
  const row = await getDb().execution.findUnique({ where: { activeAccountKey: accountKey }, select: { id: true } });
  return row?.id ?? null;
}

function activeConflict(executionId: string | null): ExecutionError {
  return new ExecutionError(
    "execution_active",
    409,
    "Another execution is still running on this account. Finish or cancel it first.",
    { executionId },
  );
}

export type NewExecution = {
  basketId: string;
  accountKey: string;
  mode: ExecutionMode;
  idempotencyKey: string;
  confirmation: Prisma.InputJsonObject;
  simulateRejectSeq: number | null;
  orders: readonly PreflightOrder[];
};

/**
 * Creates the execution and its legs. A repeated key returns the existing
 * execution; a basket gets one deploy execution; an account gets one active
 * execution at a time (the unique `active_account_key`).
 */
export async function insertExecution(input: NewExecution): Promise<{ executionId: string; created: boolean }> {
  const db = getDb();
  const existing = async () => {
    const row = await db.execution.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, basketId: true },
    });
    if (row && row.basketId !== input.basketId) {
      throw new ExecutionError("idempotency_conflict", 409, "This confirmation was already used for another basket.");
    }
    return row?.id ?? null;
  };

  const repeated = await existing();
  if (repeated) return { executionId: repeated, created: false };

  try {
    const executionId = await db.$transaction(async (tx) => {
      await tx.$queryRaw`select id from baskets where id = ${input.basketId}::uuid for update`;
      const prior = await tx.execution.findFirst({ where: { basketId: input.basketId }, select: { id: true } });
      if (prior) {
        throw new ExecutionError("already_executed", 409, "This basket was already executed.", { executionId: prior.id });
      }
      const execution = await tx.execution.create({
        data: {
          basketId: input.basketId,
          accountKey: input.accountKey,
          activeAccountKey: input.accountKey,
          kind: "deploy",
          mode: input.mode,
          status: "queued",
          idempotencyKey: input.idempotencyKey,
          confirmation: input.confirmation,
          simulateRejectSeq: input.simulateRejectSeq,
          legs: {
            create: input.orders.map((order) => ({
              seq: order.seq,
              action: order.action,
              symbol: order.symbol,
              universalSymbolId: order.universalSymbolId,
              units: order.units,
              estPrice: order.price,
            })),
          },
        },
        select: { id: true },
      });
      await tx.basket.update({ where: { id: input.basketId }, data: { status: "deploying", mode: input.mode } });
      return execution.id;
    });
    return { executionId, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    // A concurrent request won one of the unique indexes; report which.
    const raced = await existing();
    if (raced) return { executionId: raced, created: false };
    throw activeConflict(await activeExecutionId(input.accountKey));
  }
}

/**
 * Legs claimed by an invocation that died before recording a result. Longer
 * than the drain route's maxDuration, so the claiming invocation is gone.
 * Paper legs never reached a broker and go back to pending; a live leg may
 * have, so it becomes unknown and is never resubmitted automatically.
 */
export const STALE_CLAIM_MS = 2 * 60 * 1000;

export async function recoverStaleClaims(executionId: string): Promise<number> {
  return getDb().$executeRaw`
    update execution_legs l
    set status = case when e.mode = 'paper' then 'pending' else 'unknown' end,
        claimed_at = case when e.mode = 'paper' then null else l.claimed_at end,
        error_code = case when e.mode = 'paper' then null else 'interrupted' end
    from executions e
    where e.id = l.execution_id
      and l.execution_id = ${executionId}::uuid
      and l.status = 'claimed'
      and l.claimed_at < clock_timestamp() - make_interval(secs => ${STALE_CLAIM_MS / 1000}::float8)`;
}

export async function markRunning(executionId: string): Promise<void> {
  await getDb().$executeRaw`
    update executions set status = 'running', started_at = coalesce(started_at, clock_timestamp())
    where id = ${executionId}::uuid and status in ('queued', 'running')`;
}

/** Milliseconds until the next pending leg may be claimed, or null when none is pending. */
export async function nextPendingWaitMs(executionId: string): Promise<number | null> {
  const [row] = await getDb().$queryRaw<{ wait_ms: number | null }[]>`
    select min(greatest(0, extract(epoch from (coalesce(not_before, clock_timestamp()) - clock_timestamp())) * 1000))::float8
      as wait_ms
    from execution_legs
    where execution_id = ${executionId}::uuid and status = 'pending'`;
  return row?.wait_ms ?? null;
}

/**
 * Reserves the account's next submission slot, shared across invocations and
 * executions: succeeds only if the last submission was at least `paceMs` ago.
 * Returns 0 when reserved, otherwise how long to wait before trying again.
 */
export async function reservePacingSlot(accountKey: string, paceMs: number): Promise<number> {
  const db = getDb();
  const seconds = paceMs / 1000;
  const reserved = await db.$queryRaw<{ ok: number }[]>`
    insert into account_pacing (account_key, last_submit_at) values (${accountKey}, clock_timestamp())
    on conflict (account_key) do update set last_submit_at = excluded.last_submit_at
    where account_pacing.last_submit_at <= clock_timestamp() - make_interval(secs => ${seconds}::float8)
    returning 1 as ok`;
  if (reserved.length > 0) return 0;
  const [row] = await db.$queryRaw<{ wait_ms: number }[]>`
    select greatest(0, extract(epoch from (last_submit_at + make_interval(secs => ${seconds}::float8) - clock_timestamp())) * 1000)::float8
      as wait_ms
    from account_pacing where account_key = ${accountKey}`;
  return Math.max(1, Math.ceil(row?.wait_ms ?? paceMs));
}

/** Claims the next pending leg in order; concurrent drains skip legs another one holds. */
export async function claimNextLeg(executionId: string): Promise<ExecutionLeg | null> {
  const db = getDb();
  const [claimed] = await db.$queryRaw<{ id: string }[]>`
    update execution_legs set status = 'claimed', claimed_at = clock_timestamp()
    where id = (
      select id from execution_legs
      where execution_id = ${executionId}::uuid and status = 'pending'
        and (not_before is null or not_before <= clock_timestamp())
      order by seq, attempt
      limit 1
      for update skip locked
    )
    returning id`;
  return claimed ? db.executionLeg.findUnique({ where: { id: claimed.id } }) : null;
}

function resultData(result: SubmitResult): Prisma.ExecutionLegUpdateManyMutationInput {
  const now = new Date();
  switch (result.kind) {
    case "filled":
      return {
        status: "executed",
        brokerageOrderId: result.brokerageOrderId,
        snaptradeStatus: result.snaptradeStatus,
        filledUnits: result.filledUnits,
        fillPrice: result.fillPrice,
        latencyMs: result.latencyMs,
        submittedAt: now,
      };
    case "rejected":
      return {
        status: "rejected",
        errorCode: result.code,
        errorMessage: result.message,
        requestId: result.requestId,
        latencyMs: result.latencyMs,
        submittedAt: now,
      };
    case "failed":
      return { status: "failed", errorCode: result.code, errorMessage: result.message };
    case "retry_later":
      return {
        status: "pending",
        claimedAt: null,
        notBefore: new Date(now.getTime() + Math.max(1, result.retryAfterSeconds) * 1000),
      };
  }
}

/**
 * Records a claimed leg's outcome and, for a fill, the basket ledger in the
 * same transaction. Only a leg still in `claimed` is written, so an outcome
 * is applied to the ledger at most once.
 */
export async function recordLegResult(leg: ExecutionLeg, basketId: string, result: SubmitResult): Promise<ExecutionLeg> {
  return getDb().$transaction(async (tx) => {
    const { count } = await tx.executionLeg.updateMany({
      where: { id: leg.id, status: "claimed" },
      data: resultData(result),
    });
    if (count === 1 && result.kind === "filled" && result.filledUnits > 0) {
      await tx.basketConstituent.update({
        where: { basketId_symbol: { basketId, symbol: leg.symbol } },
        data: {
          ledgerUnits: { increment: result.filledUnits },
          costTotal: { increment: new Prisma.Decimal(result.fillPrice).times(result.filledUnits) },
        },
      });
    }
    return tx.executionLeg.findUniqueOrThrow({ where: { id: leg.id } });
  });
}

async function lockExecution(tx: Tx, executionId: string) {
  const [row] = await tx.$queryRaw<{ status: string; basket_id: string; account_key: string }[]>`
    select status, basket_id, account_key from executions where id = ${executionId}::uuid for update`;
  return row ?? null;
}

/** A basket with fills is active; without any it falls back to a draft. Returns true on first activation. */
async function settleBasket(tx: Tx, basketId: string): Promise<boolean> {
  const filled = await tx.basketConstituent.count({ where: { basketId, ledgerUnits: { gt: 0 } } });
  if (filled > 0) {
    const { count } = await tx.basket.updateMany({
      where: { id: basketId, status: { not: "active" } },
      data: { status: "active", deployedAt: new Date() },
    });
    return count === 1;
  }
  await tx.basket.updateMany({ where: { id: basketId, status: "deploying" }, data: { status: "draft" } });
  return false;
}

export type Finalized = { status: ExecutionStatus; finished: boolean; activated: boolean; basketId: string };

/** Closes the execution once no leg is pending or claimed; always re-settles the basket. */
export async function finalizeExecution(executionId: string): Promise<Finalized | null> {
  return getDb().$transaction(async (tx) => {
    const locked = await lockExecution(tx, executionId);
    if (!locked) return null;
    let status = locked.status as ExecutionStatus;
    let finished = false;
    if (status === "queued" || status === "running") {
      const legs = await tx.executionLeg.findMany({
        where: { executionId },
        select: { seq: true, attempt: true, status: true },
      });
      const next = deriveStatus(legs);
      if (next !== "running") {
        await tx.execution.update({
          where: { id: executionId },
          data: { status: next, finishedAt: new Date(), activeAccountKey: null },
        });
        status = next;
        finished = true;
      }
    }
    const activated = await settleBasket(tx, locked.basket_id);
    return { status, finished, activated, basketId: locked.basket_id };
  });
}

/** Queues a new attempt (new client_order_id) for the latest rejected or failed attempt of a leg. */
export async function queueRetry(executionId: string, legId: string): Promise<LegView> {
  const db = getDb();
  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockExecution(tx, executionId);
      if (!locked) throw new ExecutionError("not_found", 404, "Execution not found.");
      if (locked.status === "canceled") {
        throw new ExecutionError("canceled", 409, "This execution was canceled; start a new pre-flight instead.");
      }
      const legs = await tx.executionLeg.findMany({ where: { executionId } });
      const leg = legs.find((candidate) => candidate.id === legId);
      if (!leg) throw new ExecutionError("not_found", 404, "Leg not found.");
      if (!isRetryable(leg, legs)) {
        throw new ExecutionError("not_retryable", 409, "Only the latest rejected or failed attempt can be retried.");
      }
      const other = await tx.execution.findFirst({
        where: { activeAccountKey: locked.account_key, id: { not: executionId } },
        select: { id: true },
      });
      if (other) throw activeConflict(other.id);
      const created = await tx.executionLeg.create({
        data: {
          executionId,
          seq: leg.seq,
          attempt: leg.attempt + 1,
          action: leg.action,
          symbol: leg.symbol,
          universalSymbolId: leg.universalSymbolId,
          units: leg.units,
          estPrice: leg.estPrice,
        },
      });
      await tx.execution.update({
        where: { id: executionId },
        data: { status: "running", finishedAt: null, activeAccountKey: locked.account_key },
      });
      await tx.basket.updateMany({
        where: { id: locked.basket_id, status: "draft" },
        data: { status: "deploying" },
      });
      return toLegView(created);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const execution = await db.execution.findUnique({ where: { id: executionId }, select: { accountKey: true } });
      throw activeConflict(execution ? await activeExecutionId(execution.accountKey) : null);
    }
    throw error;
  }
}

/** Skips every pending leg. A leg already claimed finishes and is recorded. */
export async function cancelPending(executionId: string): Promise<number> {
  return getDb().$transaction(async (tx) => {
    const locked = await lockExecution(tx, executionId);
    if (!locked || !["queued", "running"].includes(locked.status)) return 0;
    const { count } = await tx.executionLeg.updateMany({
      where: { executionId, status: "pending" },
      data: { status: "skipped", errorCode: "canceled", errorMessage: "Canceled before submission." },
    });
    await tx.execution.update({
      where: { id: executionId },
      data: { status: "canceled", finishedAt: new Date(), activeAccountKey: null },
    });
    await settleBasket(tx, locked.basket_id);
    return count;
  });
}
