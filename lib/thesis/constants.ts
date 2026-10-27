// Plain values shared with client components. Kept free of zod: a module that
// defines zod object schemas runs zod's `new Function` probe, which the CSP blocks.

export const RISK_PROFILES = ["conservative", "moderate", "aggressive", "speculative"] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export const MIN_CANDIDATES = 6;
export const MAX_CANDIDATES = 8;
export const MAX_PROMPT_LENGTH = 500;
export const BASKET_CURRENCIES = ["USD", "CAD"] as const;
export type BasketCurrency = (typeof BASKET_CURRENCIES)[number];
export type OverlapMode = "auto" | "ignore";
