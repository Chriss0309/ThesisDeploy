import { Bricolage_Grotesque, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

// The only place fonts are loaded. app/tokens.css maps these variables to
// --font-display, --font-sans, and --font-mono.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-bricolage",
});

const sans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});

export const fontVariables = [display.variable, sans.variable, mono.variable].join(" ");
