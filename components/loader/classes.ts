// Loader classes never conflict, so a plain join keeps the Tailwind merge engine
// (about 14 KB gzipped) out of pages whose only client code is a loader.
export function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
