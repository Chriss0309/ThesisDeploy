"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Loader, LoaderGlyph } from "@/components/loader/loader";
import { Mark, Reveal } from "@/components/loader/mark";
import { formatMoney } from "@/components/portfolio/format";
import { BasketComposer, type EditAction } from "@/components/thesis/basket-composer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { THESIS_PRESETS } from "@/lib/presets";
import { BASKET_CURRENCIES, MAX_PROMPT_LENGTH, type BasketCurrency, type OverlapMode } from "@/lib/thesis/schema";
import type { ComposerPayload, StudioAccount, ThesisErrorBody } from "@/lib/thesis/types";
import { cn } from "@/lib/utils";

export const PAPER_BUDGET = 2500;
const MIN_BUDGET = 100;

function currenciesFor(account: StudioAccount): BasketCurrency[] {
  const held = (account.cash ?? [])
    .map((entry) => entry.currency.toUpperCase())
    .filter((code): code is BasketCurrency => (BASKET_CURRENCIES as readonly string[]).includes(code));
  return held.length > 0 ? [...new Set(held)] : [...BASKET_CURRENCIES];
}

const cashIn = (account: StudioAccount, currency: string) =>
  account.cash?.find((entry) => entry.currency.toUpperCase() === currency)?.amount ?? 0;

function defaultCurrency(account: StudioAccount): BasketCurrency {
  const options = currenciesFor(account);
  return [...options].sort((a, b) => cashIn(account, b) - cashIn(account, a))[0];
}

/** 20% of the currency's cash, or a simulated budget when that's too small to build a basket. */
function defaultBudget(cash: number): { budget: number; simulated: boolean } {
  const fifth = Math.floor((cash * 0.2) / 10) * 10;
  return fifth >= MIN_BUDGET ? { budget: fifth, simulated: false } : { budget: PAPER_BUDGET, simulated: true };
}

const INPUT =
  "rounded-md border border-input bg-card px-3 py-2.5 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 md:text-sm";

function Field({
  label,
  htmlFor,
  aside,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  aside?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

const SLOW_SECONDS = 45;

/** The Studio's showpiece: candidates orbit while Claude and SnapTrade work, then drop into lots. */
function GenerationLoader({
  startedAt,
  settled,
  onSettled,
}: {
  startedAt: number;
  settled: boolean;
  onSettled: () => void;
}) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - startedAt) / 1000);
  return (
    <Loader
      variant="orbit"
      size="showpiece"
      eyebrow={settled ? "Basket ready" : "Building"}
      label={settled ? "Basket ready" : "Building your basket…"}
      detail={
        seconds >= SLOW_SECONDS
          ? "Taking longer than usual: Claude is still working. The request stops after about a minute."
          : "Usually 10–40 seconds. Cached presets come back almost at once."
      }
      settled={settled}
      onSettled={onSettled}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-1">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground">
          <li>Claude reads your holdings and proposes 6–8 candidates.</li>
          <li>SnapTrade checks every ticker and quotes it in one call.</li>
          <li>Names you already hold are trimmed, then whole shares are sized.</li>
        </ol>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {String(seconds).padStart(2, "0")}s elapsed
        </span>
      </div>
    </Loader>
  );
}

export function ThesisStudio({
  mode,
  endpoint,
  accounts,
  initialAccountId,
  initialPresetKey,
  generation,
}: {
  mode: "live" | "demo";
  endpoint: string;
  accounts: StudioAccount[];
  initialAccountId: string;
  initialPresetKey?: string | null;
  /** Which prompts can be submitted, and a note explaining generation limits. */
  generation: { presets: boolean; custom: boolean; note: string };
}) {
  const initialPreset = THESIS_PRESETS.find((preset) => preset.key === initialPresetKey) ?? null;
  const [accountId, setAccountId] = useState(initialAccountId);
  const account = accounts.find((candidate) => candidate.id === accountId) ?? accounts[0];
  const [currency, setCurrency] = useState<BasketCurrency>(() => defaultCurrency(account));
  const [budget, setBudget] = useState(() => defaultBudget(cashIn(account, defaultCurrency(account))).budget);
  const [overlapMode, setOverlapMode] = useState<OverlapMode>("auto");
  const [prompt, setPrompt] = useState(initialPreset?.prompt ?? "");
  const [presetKey, setPresetKey] = useState<string | null>(initialPreset?.key ?? null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [arrived, setArrived] = useState<ComposerPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<ComposerPayload | null>(null);
  const [run, setRun] = useState(0);
  const editTimers = useRef(new Map<string, number>());

  const cash = cashIn(account, currency);
  const { simulated } = defaultBudget(cash);
  const maxBudget = Math.max(10_000, Math.ceil(cash / 1000) * 1000);
  const isPreset = presetKey != null && THESIS_PRESETS.some((preset) => preset.key === presetKey && preset.prompt === prompt);
  const allowed = isPreset ? generation.presets : generation.custom;
  const canSubmit = prompt.trim().length >= 3 && budget >= 1 && allowed && pendingSince == null;

  const selectAccount = (id: string) => {
    const next = accounts.find((candidate) => candidate.id === id);
    if (!next) return;
    const nextCurrency = defaultCurrency(next);
    setAccountId(id);
    setCurrency(nextCurrency);
    setBudget(defaultBudget(cashIn(next, nextCurrency)).budget);
    window.history.replaceState(null, "", `?account=${encodeURIComponent(id)}`);
  };

  const selectCurrency = (next: BasketCurrency) => {
    setCurrency(next);
    setBudget(defaultBudget(cashIn(account, next)).budget);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setPendingSince(Date.now());
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, presetKey: isPreset ? presetKey : null, accountId, currency, budget, overlapMode }),
      });
      const body = (await response.json().catch(() => null)) as ComposerPayload | ThesisErrorBody | null;
      if (!response.ok || !body || "error" in body) {
        setError(body && "error" in body ? body.error.message : `Request failed (HTTP ${response.status}). Try again.`);
        setPendingSince(null);
        return;
      }
      // The loader plays its settle (skipped if it never appeared), then reveal() shows the basket.
      setArrived(body);
    } catch {
      setError("Couldn't reach ThesisDeploy. Check your connection and try again.");
      setPendingSince(null);
    }
  }

  const reveal = () => {
    if (arrived) {
      setPayload(arrived);
      setRun((count) => count + 1);
    }
    setArrived(null);
    setPendingSince(null);
  };

  const thesisId = payload?.thesis.id ?? null;
  const ref = payload?.thesis.ref ?? null;
  const recordEdit = useCallback(
    (action: EditAction, symbol: string) => {
      const target =
        mode === "live"
          ? thesisId && { url: `/api/theses/${thesisId}/edits`, body: { action, symbol } }
          : ref && { url: "/api/demo/edits", body: { ref, action, symbol } };
      if (!target) return;
      const post = () =>
        void fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target.body),
          keepalive: true,
        }).catch(() => undefined);
      if (action !== "reweight" && action !== "step") return post();
      // Slider drags and repeated clicks count as one edit.
      const key = `${action}:${symbol}`;
      window.clearTimeout(editTimers.current.get(key));
      editTimers.current.set(key, window.setTimeout(post, 1000));
    },
    [mode, thesisId, ref],
  );

  return (
    <div className="flex flex-col items-start gap-6 lg:flex-row">
      <Reveal />
      <Card className="w-full lg:w-96 lg:shrink-0">
        <CardHeader>
          <p className="eyebrow text-muted-foreground">► Conviction</p>
          <CardTitle className="font-display text-xl font-semibold">Thesis</CardTitle>
          <CardDescription>
            Claude proposes stocks for your conviction, SnapTrade checks every ticker and price, and the solver sizes
            whole shares around what you already own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-5" onSubmit={submit}>
            <Field label="Conviction" htmlFor="thesis-prompt">
              <Textarea
                id="thesis-prompt"
                placeholder="e.g. Utilities and grid suppliers that win as AI data centers strain North American power"
                value={prompt}
                maxLength={MAX_PROMPT_LENGTH}
                rows={3}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (presetKey && THESIS_PRESETS.find((preset) => preset.key === presetKey)?.prompt !== event.target.value) {
                    setPresetKey(null);
                  }
                }}
              />
              <div className="flex flex-wrap gap-2">
                {THESIS_PRESETS.map((preset) => (
                  <Button
                    key={preset.key}
                    type="button"
                    variant={isPreset && presetKey === preset.key ? "default" : "outline"}
                    aria-pressed={isPreset && presetKey === preset.key}
                    size="sm"
                    className="rounded-full"
                    onClick={() => {
                      setPrompt(preset.prompt);
                      setPresetKey(preset.key);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </Field>

            <Field label="Account" htmlFor="thesis-account">
              <select
                id="thesis-account"
                value={accountId}
                onChange={(event) => selectAccount(event.target.value)}
                className={INPUT}
              >
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.institution} {candidate.maskedNumber}
                    {candidate.isPaper ? " (paper)" : ""}
                    {candidate.capability !== "trade" ? ` (${candidate.capability === "disabled" ? "disabled" : "read-only"})` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Basket currency"
              hint={
                account.cash == null
                  ? "Balances for this account couldn't be loaded."
                  : `Cash: ${formatMoney(cash, currency)}. Baskets buy listings in one currency only.`
              }
            >
              <Segmented
                name="Basket currency"
                value={currency}
                options={currenciesFor(account).map((code) => ({ value: code, label: code }))}
                onChange={selectCurrency}
              />
            </Field>

            <Field
              label="Capital to deploy"
              htmlFor="thesis-budget"
              aside={
                <span className="font-display text-xl font-semibold tabular-nums">{formatMoney(budget, currency)}</span>
              }
              hint={
                simulated
                  ? `Simulated ${formatMoney(PAPER_BUDGET, currency)} budget: this account has little or no ${currency} cash, so baskets run in paper mode.`
                  : budget > cash
                    ? `More than this account's ${currency} cash, so only paper mode will be available.`
                    : `Defaults to 20% of this account's ${currency} cash.`
              }
            >
              <div className="flex flex-col gap-1">
                <Slider
                  aria-label="Capital to deploy"
                  min={MIN_BUDGET}
                  max={maxBudget}
                  step={50}
                  largeStep={500}
                  value={Math.min(budget, maxBudget)}
                  onValueChange={setBudget}
                />
                <div className="eyebrow flex justify-between text-muted-foreground tabular-nums">
                  <span>{formatMoney(MIN_BUDGET, currency)}</span>
                  <span>{formatMoney(maxBudget, currency)}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">Exact amount</span>
                <input
                  id="thesis-budget"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={1_000_000}
                  step="any"
                  value={budget}
                  onChange={(event) => setBudget(Number(event.target.value))}
                  className={cn(INPUT, "w-32 text-right tabular-nums")}
                />
              </div>
            </Field>

            <Field
              label="Existing holdings"
              hint={
                overlapMode === "auto"
                  ? "Buys only the gap between each name's target and what you already hold across all accounts."
                  : "Sizes the basket as if you held nothing; overlap is still shown."
              }
            >
              <Segmented
                name="Existing holdings"
                value={overlapMode}
                options={[
                  { value: "auto", label: "Auto-reduce" },
                  { value: "ignore", label: "Ignore" },
                ]}
                onChange={setOverlapMode}
              />
            </Field>

            <div className="flex flex-col gap-2">
              <Button type="submit" size="lg" disabled={!canSubmit}>
                {pendingSince != null ? <LoaderGlyph fallback={<Sparkles />} /> : <Sparkles />}
                Generate basket
              </Button>
              <p className="text-xs text-muted-foreground">{generation.note}</p>
              {!isPreset && generation.presets && !generation.custom && prompt.trim().length > 0 && (
                <p className="text-xs text-muted-foreground">Pick one of the presets above to continue.</p>
              )}
              {error && (
                <p
                  role="alert"
                  className="flex items-center gap-2.5 rounded-md border border-negative-border bg-negative-subtle px-3 py-2 text-xs text-negative-subtle-foreground"
                >
                  <Mark kind="error" size="inline" />
                  <span>{error}</span>
                </p>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="flex w-full min-w-0 flex-1 flex-col gap-4">
        {pendingSince != null && (
          <GenerationLoader startedAt={pendingSince} settled={arrived != null} onSettled={reveal} />
        )}
        {payload ? (
          // Hidden, not unmounted, while regenerating: the loader takes its place and a
          // failed request brings the previous basket back untouched.
          <div hidden={pendingSince != null} className="contents">
            <BasketComposer
              key={run}
              payload={payload}
              onEdit={recordEdit}
              preflightEndpoint={mode === "live" ? "/api/preflight" : "/api/demo/preflight"}
            />
          </div>
        ) : (
          pendingSince == null && (
            <Card>
              <CardContent className="flex flex-col items-start gap-5 text-sm text-muted-foreground sm:flex-row">
                <Mark kind="empty" />
                <div className="flex flex-col gap-2">
                  <p className="eyebrow">► Basket</p>
                  <p className="font-display text-xl font-semibold text-foreground">Your basket appears here.</p>
                  <p>
                    Pick a preset or write your own conviction, then generate. Every ticker is checked against
                    SnapTrade and priced before it shows up, and anything you already own is flagged and trimmed.
                  </p>
                </div>
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  );
}
