import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Design values live only in these files (see docs/design-system.md).
export const TOKEN_FILE = "app/tokens.css";
export const FONT_LOADER = "app/fonts.ts";

const SCANNED_DIRS = ["app", "components", "lib"];
const SKIPPED_DIRS = ["lib/generated", "lib/design"];
const EXTENSIONS = [".ts", ".tsx", ".css"];

export type Violation = { file: string; line: number; rule: string; match: string };

type Rule = {
  id: string;
  message: string;
  pattern: RegExp;
  appliesTo: (file: string) => boolean;
  allowed?: (match: RegExpExecArray) => boolean;
};

const isCode = (file: string) => file.endsWith(".ts") || file.endsWith(".tsx");
const anyFile = () => true;

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_UTILITY =
  "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|outline|decoration|from|via|to|shadow|accent|caret|divide|placeholder";
const TOKEN_REFERENCE = /^(?:var\(--[\w-]+\)|--spacing\([\d.]+\))$/;

const RULES: Rule[] = [
  {
    id: "raw-hex-color",
    message: "hex color outside the token file",
    pattern: /(?<![\w&#/-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi,
    appliesTo: anyFile,
  },
  {
    id: "raw-color-function",
    message: "color function outside the token file",
    pattern: /(?<![\w.])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/g,
    appliesTo: anyFile,
  },
  {
    id: "numeric-color-literal",
    message: "0xRRGGBB color literal (read a token instead)",
    pattern: /\b0x[0-9a-f]{6}\b/gi,
    appliesTo: isCode,
  },
  {
    id: "tailwind-palette-class",
    message: "Tailwind default palette class (use a semantic token class)",
    pattern: new RegExp(`(?<![\\w-])(?:${COLOR_UTILITY})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?![\\w-])`, "g"),
    appliesTo: isCode,
  },
  {
    id: "font-family",
    message: "font family outside the token file",
    pattern: /font-family\s*:|fontFamily\b|@font-face/g,
    appliesTo: anyFile,
  },
  {
    id: "font-loader",
    message: "next/font import outside app/fonts.ts",
    pattern: /from\s+["']next\/font\/(?:google|local)["']/g,
    appliesTo: (file) => isCode(file) && file !== FONT_LOADER,
  },
  {
    id: "inline-font-size",
    message: "inline font size (use a text-* token)",
    pattern: /fontSize\b|font-size\s*:\s*(?!var\()/g,
    appliesTo: anyFile,
  },
  {
    id: "arbitrary-value",
    message: "arbitrary Tailwind value (add a token and use it)",
    // utility-[value], but not variants such as data-[size=sm]: or group-data-[x]/card:
    pattern: /(?<![\w-])[a-z][\w-]*-\[(?:[^[\]\s]|\[[^[\]\s]*\])+\](?!:|\/[\w-]+:)/g,
    appliesTo: anyFile,
  },
  {
    id: "arbitrary-property",
    message: "arbitrary property with a raw value (only var(--token) or --spacing(n) are allowed)",
    pattern: /(?<![\w-])\[(--[\w-]+):([^[\]\s]+)\](?!:)/g,
    appliesTo: anyFile,
    allowed: (match) => TOKEN_REFERENCE.test(match[2]),
  },
];

export function findViolations(file: string, source: string): Violation[] {
  if (file === TOKEN_FILE) return [];
  const violations: Violation[] = [];
  for (const rule of RULES) {
    if (!rule.appliesTo(file)) continue;
    for (const match of source.matchAll(rule.pattern)) {
      if (rule.allowed?.(match)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      violations.push({ file, line, rule: `${rule.id}: ${rule.message}`, match: match[0] });
    }
  }
  return violations;
}

export function scanProject(root: string): Violation[] {
  const files = SCANNED_DIRS.flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")),
  ).filter((file) => !SKIPPED_DIRS.some((dir) => file.startsWith(`${dir}/`)));
  return files.flatMap((file) => findViolations(file, readFileSync(join(root, file), "utf8")));
}
