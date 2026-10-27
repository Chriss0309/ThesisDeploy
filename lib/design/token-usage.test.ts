import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FONT_LOADER, TOKEN_FILE, findViolations, scanProject } from "./token-usage";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const rules = (file: string, source: string) => findViolations(file, source).map((v) => v.rule.split(":")[0]);

describe("design token usage", () => {
  it("keeps every color, font, and size in app/tokens.css", () => {
    const report = scanProject(ROOT)
      .map((v) => `${v.file}:${v.line} ${v.rule} (${v.match})`)
      .join("\n");
    expect(report).toBe("");
  });

  it("flags raw colors in components and stylesheets", () => {
    expect(rules("components/x.tsx", `<div className="text-[#1a1a1a]" />`)).toContain("raw-hex-color");
    expect(rules("components/x.tsx", `style={{ color: "#fff" }}`)).toEqual(["raw-hex-color"]);
    expect(rules("app/globals.css", "a { color: oklch(0.2 0 0); }")).toEqual(["raw-color-function"]);
    expect(rules("components/x.ts", "renderer.setClearColor(0xffffff)")).toEqual(["numeric-color-literal"]);
    expect(rules("components/x.tsx", `className="bg-sky-50 text-white hover:border-red-200/50"`)).toEqual([
      "tailwind-palette-class",
      "tailwind-palette-class",
      "tailwind-palette-class",
    ]);
  });

  it("flags fonts and ad-hoc type sizes", () => {
    expect(rules("app/globals.css", "body { font-family: Inter, sans-serif; }")).toEqual(["font-family"]);
    expect(rules("components/x.tsx", `style={{ fontFamily: "Inter", fontSize: 13 }}`)).toEqual([
      "font-family",
      "inline-font-size",
    ]);
    expect(rules("app/layout.tsx", `import { Inter } from "next/font/google";`)).toEqual(["font-loader"]);
    expect(rules(FONT_LOADER, `import { Inter } from "next/font/google";`)).toEqual([]);
    expect(rules("components/x.tsx", `className="text-[11px] min-w-[640px]"`)).toEqual([
      "arbitrary-value",
      "arbitrary-value",
    ]);
  });

  it("allows token references, variants, and the token file itself", () => {
    const allowed = [
      `className="bg-brand text-brand-foreground tabular-nums hover:bg-brand-hover"`,
      `className="grid-cols-(--grid-xray) max-w-(--coin-stage) aspect-4/3"`,
      `className="data-[size=sm]:gap-2 group-data-[size=sm]/card:text-sm aria-[current=page]:underline"`,
      `className="[&_svg:not([class*='size-'])]:size-4 *:[img:first-child]:rounded-t-lg"`,
      `className="[--card-spacing:--spacing(4)] [--chamfer:var(--chamfer-sm)]"`,
      `<a href="#how-it-works">`,
    ];
    for (const source of allowed) expect(rules("components/x.tsx", source)).toEqual([]);
    expect(rules("components/x.tsx", `className="[--gap:12px]"`)).toEqual(["arbitrary-property"]);
    expect(rules(TOKEN_FILE, ":root { --td-ink-900: #141a16; font-size: 16px; }")).toEqual([]);
  });
});
