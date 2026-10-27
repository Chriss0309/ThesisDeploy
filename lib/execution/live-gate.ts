import { formatMoney } from "@/components/portfolio/format";
import { closedWhy, opensText } from "@/lib/execution/market-text";
import type { ExecutionKind, ExecutionMode, ImpactCheck, ModeGate } from "@/lib/execution/types";
import type { MarketStatus } from "@/lib/market-hours";
import type { Capability } from "@/lib/portfolio/types";
import { EPSILON } from "@/lib/solver";

// Every reason Live is unavailable for one pre-flight, in the order a user
// would fix them. Pure, so the gate is the same in the dialog and on confirm.

export type LiveGateInput = {
  kind: ExecutionKind;
  guest: boolean;
  /** LIVE_TRADING_ENABLED, and whether this is a Vercel preview (always off there). */
  killSwitch: { on: boolean; preview: boolean };
  institution: string;
  /** From the connection and the grant's scopes; null when the account wasn't re-read. */
  account: { capability: Capability; capabilityReason: string } | null;
  /** Rebalance and close: the basket's mode. A Paper basket's shares don't exist at the broker. */
  basketMode: ExecutionMode | null;
  market: MarketStatus;
  currency: string;
  buyCost: number;
  sellProceeds: number;
  /** Fresh buying power (cash for non-margin accounts) in the basket currency; null when unknown. */
  buyingPower: number | null;
  /** Sells the ledger plans that the broker shows fewer shares for. */
  shortfalls: readonly { symbol: string; selling: number; held: number }[];
  impact?: ImpactCheck | null;
};

export type LiveGate = ModeGate & { notes: string[] };

export function liveGate(input: LiveGateInput): LiveGate {
  const reasons: string[] = [];
  const notes: string[] = [];
  const money = (amount: number) => formatMoney(amount, input.currency);

  if (input.guest) reasons.push("Demo accounts are fictional. Sign in with SnapTrade to trade your own account.");
  if (!input.killSwitch.on) {
    reasons.push(
      input.killSwitch.preview
        ? "Live trading is always off on preview deployments."
        : "Live trading is switched off on this deployment.",
    );
  }
  if (input.kind !== "deploy" && input.basketMode !== "live") {
    reasons.push(`This is a Paper basket: its shares don't exist at ${input.institution}. Rebalance and close it with Paper.`);
  }
  const tradesThisAccount = !input.guest && (input.kind === "deploy" || input.basketMode === "live");
  if (tradesThisAccount) {
    if (!input.account) reasons.push(`The ${input.institution} account couldn't be re-read from SnapTrade.`);
    else if (input.account.capability !== "trade") reasons.push(input.account.capabilityReason);
  }
  if (!input.market.open) {
    reasons.push(
      `${input.market.market} is closed (${closedWhy(input.market)}), and Live market orders are blocked outside the regular session.${opensText(input.market)}`,
    );
  }

  const live = reasons.length === 0;
  if (live && input.buyCost > EPSILON) {
    const funds = input.buyingPower;
    if (funds == null) {
      reasons.push(`This account's ${input.currency} buying power couldn't be confirmed.`);
    } else if (input.kind === "rebalance" && input.buyCost > funds + EPSILON) {
      if (input.buyCost > funds + input.sellProceeds + EPSILON) {
        reasons.push(
          `The buys need about ${money(input.buyCost)}; sells raise about ${money(input.sellProceeds)} and the account has ${money(funds)} of buying power.`,
        );
      } else {
        notes.push(
          `The buys rely on about ${money(input.buyCost - funds)} from today's sells. If ${input.institution} doesn't let unsettled proceeds buy, those legs are rejected and can be retried after settlement.`,
        );
      }
    } else if (input.kind !== "rebalance" && input.buyCost > funds + EPSILON) {
      reasons.push(`The orders need about ${money(input.buyCost)}; the account has ${money(funds)} of buying power.`);
    }
  }

  for (const short of input.shortfalls) {
    const line = `${input.institution} shows ${short.held} ${short.symbol}, fewer than the ${short.selling} this basket's ledger would sell.`;
    if (input.kind === "close") notes.push(`${line} The close sells the ${short.held} actually held.`);
    else reasons.push(`${line} Close the basket, or bring the holding back in line outside ThesisDeploy, first.`);
  }

  for (const leg of input.impact?.legs ?? []) {
    if (leg.status === "rejected") {
      reasons.push(`${input.institution} rejected the preview of leg ${leg.seq}: ${leg.message ?? "no reason given"}.`);
    }
  }

  return { available: reasons.length === 0, reasons, notes };
}

/** A Live basket is rebalanced and closed only Live, so the ledger keeps matching the account. */
export function paperGate(kind: ExecutionKind, basketMode: ExecutionMode | null, institution: string): ModeGate {
  if (kind !== "deploy" && basketMode === "live") {
    return {
      available: false,
      reasons: [`This basket holds real shares at ${institution}; rebalance and close it Live so its ledger matches the account.`],
    };
  }
  return { available: true, reasons: [] };
}

/** SnapTrade's recommended estimate disclaimer, plus how ThesisDeploy sends the orders. */
export function liveDisclosures(institution: string): string[] {
  return [
    `Estimated results. The amounts shown are estimates only and are not guaranteed. ${institution} determines the final execution price, transaction amount, commissions, fees, and cash impact. Market orders can fill at a different price than the latest quote, and orders may partially fill or fill over multiple days.`,
    "Exchange, ECN, regulatory, ADR, foreign-exchange, and other fees may apply, including when estimated commissions are $0.00.",
    `Each leg is a whole-share market order, good for the day, sent to ${institution} through SnapTrade one second apart. ThesisDeploy can't cancel an order once it's sent. Not investment advice.`,
  ];
}
