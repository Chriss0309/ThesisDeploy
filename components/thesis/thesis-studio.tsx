"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { formatMoney } from "@/components/portfolio/format";
import { BasketComposer, type EditAction } from "@/components/thesis/basket-composer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-muted p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            value === option.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Pending({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Card aria-busy>
      <CardContent className="flex flex-col gap-3 py-2">
        <p className="flex items-center gap-2 text-sm font-medium" role="status">
          <LoaderCircle className="size-4 animate-spin" /> Building your basket… {Math.floor((now - startedAt) / 1000)}s
        </p>
        <ol className="list-decimal pl-5 text-xs text-muted-foreground">
          <li>Claude reads your holdings and proposes 6–8 candidates (usually 10–40 seconds).</li>
          <li>SnapTrade checks every ticker and quotes it in one call.</li>
          <li>Names you already hold are trimmed, then whole shares are sized.</li>
        </ol>
      </CardContent>
    </Card>
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
        return;
      }
      setPayload(body);
      setRun((count) => count + 1);
    } catch {
      setError("Couldn't reach ThesisDeploy. Check your connection and try again.");
    } finally {
      setPendingSince(null);
    }
  }

  const thesisId = payload?.thesis.id ?? null;
  const recordEdit = useCallback(
    (action: EditAction, symbol: string) => {
      if (mode !== "live" || !thesisId) return;
      const post = () =>
        void fetch(`/api/theses/${thesisId}/edits`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, symbol }),
          keepalive: true,
        }).catch(() => undefined);
      if (action !== "reweight" && action !== "step") return post();
      // Slider drags and repeated clicks count as one edit.
      const key = `${action}:${symbol}`;
      window.clearTimeout(editTimers.current.get(key));
      editTimers.current.set(key, window.setTimeout(post, 1000));
    },
    [mode, thesisId],
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Thesis</CardTitle>
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
                    variant={isPreset && presetKey === preset.key ? "secondary" : "outline"}
                    size="sm"
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
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
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
              hint={
                simulated
                  ? `Simulated ${formatMoney(PAPER_BUDGET, currency)} budget: this account has little or no ${currency} cash, so baskets run in paper mode.`
                  : budget > cash
                    ? `More than this account's ${currency} cash, so only paper mode will be available.`
                    : `Defaults to 20% of this account's ${currency} cash.`
              }
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  aria-label="Capital to deploy"
                  min={MIN_BUDGET}
                  max={maxBudget}
                  step={50}
                  value={Math.min(budget, maxBudget)}
                  onChange={(event) => setBudget(Number(event.target.value))}
                  className="flex-1 accent-sky-700"
                />
                <input
                  id="thesis-budget"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={1_000_000}
                  step="any"
                  value={budget}
                  onChange={(event) => setBudget(Number(event.target.value))}
                  className="h-8 w-28 rounded-lg border border-input bg-transparent px-2 text-right text-sm tabular-nums"
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
                {pendingSince != null ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                Generate basket
              </Button>
              <p className="text-xs text-muted-foreground">{generation.note}</p>
              {!isPreset && generation.presets && !generation.custom && prompt.trim().length > 0 && (
                <p className="text-xs text-amber-800">Pick one of the presets above to continue.</p>
              )}
              {error && (
                <p role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        {pendingSince != null && <Pending startedAt={pendingSince} />}
        {payload ? (
          <BasketComposer key={run} payload={payload} onEdit={recordEdit} />
        ) : (
          pendingSince == null && (
            <Card>
              <CardContent className="flex flex-col gap-2 py-2 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Your basket appears here.</p>
                <p>
                  Pick a preset or write your own conviction, then generate. Every ticker is checked against SnapTrade
                  and priced before it shows up, and anything you already own is flagged and trimmed.
                </p>
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  );
}
