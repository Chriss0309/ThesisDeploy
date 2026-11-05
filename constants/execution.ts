/** SnapTrade recommends at most one trade request per second per account; 100 ms of margin. */
export const PACE_MS = 1100;

/** Quotes older than this must be refreshed before confirming. */
export const PREFLIGHT_TTL_MS = 5 * 60 * 1000;

/** Attempts per leg, including the first. */
export const MAX_LEG_ATTEMPTS = 3;

/** SnapTrade asks for order-status polling no more often than every 15 seconds per account. */
export const RECONCILE_INTERVAL_MS = 15_000;

/** Owns guest demo baskets. Random, httpOnly; only its keyed hash is stored. */
export const GUEST_COOKIE = "td_guest";
export const GUEST_COOKIE_MAX_AGE = 30 * 24 * 3600;

export const UNREACHABLE_MESSAGE = "Couldn't reach ThesisDeploy. Try again.";
