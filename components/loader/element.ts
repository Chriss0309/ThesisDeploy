import type { LoaderView } from "./engine";
import type { Palette, Rgb } from "./motifs";
import {
  DEFAULT_TIMING,
  appearDelay,
  parseLegs,
  parseMs,
  type ExecutionProgress,
  type LoaderVariant,
  type Pose,
} from "./timing";

// <td-motif> runs every three.js canvas in the app. It is a custom element rather than
// a React effect because a Suspense fallback streamed with the first HTML is never
// hydrated: React leaves it as static markup until the content arrives. A custom
// element upgrades as soon as this module runs, hydrated or not.
//
//   <td-motif variant="scan">                     a loader: waits --loader-delay, then loops
//   <td-motif variant="scan" pose="reveal" mode="mark" reveal="data">
//                                                 a mark: plays once when <td-reveal> lands
//
// The element holds a <canvas> child rendered by React; three.js arrives in a lazy chunk.

let engine: Promise<typeof import("./engine")> | null = null;
let engineRequested: (() => void) | null = null;
const requested = new Promise<void>((resolve) => (engineRequested = resolve));

export function loadEngine() {
  engineRequested?.();
  return (engine ??= import("./engine"));
}

// Marks are decoration: they wait for the page to load and go idle, or for a loader to
// have fetched three.js already, so they never compete with the content.
let idle: Promise<void> | null = null;
function markReady() {
  idle ??= Promise.race([
    requested,
    new Promise<void>((resolve) => {
      const go = () =>
        typeof window.requestIdleCallback === "function"
          ? window.requestIdleCallback(() => resolve(), { timeout: 1200 })
          : setTimeout(resolve, 200);
      if (document.readyState === "complete") go();
      else window.addEventListener("load", go, { once: true });
    }),
  ]);
  return idle;
}

function timing() {
  const style = getComputedStyle(document.documentElement);
  return {
    delayMs: parseMs(style.getPropertyValue("--loader-delay"), DEFAULT_TIMING.delayMs),
    minVisibleMs: parseMs(style.getPropertyValue("--loader-min-visible"), DEFAULT_TIMING.minVisibleMs),
    settleMs: parseMs(style.getPropertyValue("--loader-settle"), DEFAULT_TIMING.settleMs),
  };
}

let probe: CanvasRenderingContext2D | null = null;
function toRgba(color: string): [number, number, number, number] {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe || !color) return [0, 0, 0, 0];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}

/** Ink is the text color around the motif, paper the nearest opaque surface behind it. */
function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  let paper: Rgb | null = null;
  for (let node: Element | null = element; node && !paper; node = node.parentElement) {
    const [r, g, b, a] = toRgba(getComputedStyle(node).backgroundColor);
    if (a > 0.98) paper = [r, g, b];
  }
  const channels = (value: string): Rgb => toRgba(value).slice(0, 3) as Rgb;
  return {
    paper: paper ?? channels(getComputedStyle(document.body).backgroundColor),
    ink: channels(style.color),
    accent: channels(style.getPropertyValue("--brand")),
    negative: channels(style.getPropertyValue("--negative")),
  };
}

/** The properties React sets on a <td-motif> through its ref. */
export type MotifElementApi = HTMLElement & {
  progress: ExecutionProgress | undefined;
  settled: boolean;
  shownAt: number | null;
};

/** Registers <td-motif> and <td-reveal>. Browser only; safe to call more than once. */
export function defineMotionElements() {
  if (typeof window === "undefined" || customElements.get("td-motif")) return;

  // When a loader hands over to another of the same variant (loading.tsx to a Suspense
  // fallback), the newcomer skips the delay so the motif doesn't blink.
  const lastVisible = new Map<string, number>();
  let initialLoad = document.readyState !== "complete";
  if (initialLoad) window.addEventListener("load", () => (initialLoad = false), { once: true });

  class MotifElement extends HTMLElement {
    /** performance.now() when the loader became visible; null while it waits out the delay. */
    shownAt: number | null = null;
    #view: LoaderView | null = null;
    #progress: ExecutionProgress | undefined;
    #settled = false;
    #generation = 0;
    #cleanup: (() => void)[] = [];

    get progress() {
      return this.#progress;
    }
    set progress(value: ExecutionProgress | undefined) {
      this.#progress = value;
      this.#view?.update({ progress: value });
    }
    get settled() {
      return this.#settled;
    }
    set settled(value: boolean) {
      if (value === this.#settled) return;
      this.#settled = value;
      this.#view?.update({ settled: value });
    }

    get #variant() {
      return (this.getAttribute("variant") ?? "coin") as LoaderVariant;
    }
    get #isMark() {
      return this.getAttribute("mode") === "mark";
    }

    connectedCallback() {
      const generation = ++this.#generation;
      if (this.#isMark) {
        void markReady().then(() => this.#show(generation));
        return;
      }
      const t = timing();
      const now = performance.now();
      const seen = lastVisible.get(this.#variant);
      if (seen != null && now - seen < t.delayMs) {
        (this.closest<HTMLElement>("[role=status]") ?? this).style.setProperty("--loader-delay", "0ms");
      }
      const own = this.getAttribute("delay");
      const wait = appearDelay({
        delayMs: own != null ? parseMs(own, t.delayMs) : t.delayMs,
        now,
        lastVisibleAt: seen,
        sincePageStart: initialLoad ? now : undefined,
      });
      const timer = window.setTimeout(() => this.#show(generation), wait);
      this.#cleanup.push(() => window.clearTimeout(timer));
    }

    disconnectedCallback() {
      this.#generation++;
      if (this.shownAt != null && !this.#isMark) lastVisible.set(this.#variant, performance.now());
      for (const cleanup of this.#cleanup.splice(0)) cleanup();
      this.shownAt = null;
      this.removeAttribute("data-shown");
      this.removeAttribute("data-ready");
    }

    #show(generation: number) {
      if (generation !== this.#generation || !this.isConnected) return;
      this.shownAt = performance.now();
      this.toggleAttribute("data-shown", true);
      const canvas = this.querySelector("canvas");
      if (!canvas) return;
      const waitsForData = this.getAttribute("reveal") === "data";
      loadEngine()
        .then(({ attachView }) => {
          if (generation !== this.#generation || !this.isConnected) return;
          let view: LoaderView;
          try {
            view = attachView(canvas, {
              variant: this.#variant,
              pose: (this.getAttribute("pose") ?? "loading") as Pose,
              palette: readPalette(canvas),
              progress: this.#progress ?? parseLegs(this.getAttribute("legs")),
              settled: this.#settled,
              settleMs: timing().settleMs,
              started: !waitsForData,
            });
          } catch {
            return; // No WebGL: the text and layout carry the state on their own.
          }
          this.#view = view;
          const fit = () => {
            const box = canvas.getBoundingClientRect();
            view.resize(box.width, box.height);
          };
          const resize = new ResizeObserver(fit);
          const intersection = new IntersectionObserver(([entry]) => view.setVisible(entry.isIntersecting));
          fit();
          resize.observe(canvas);
          intersection.observe(canvas);
          this.toggleAttribute("data-ready", true);
          this.#cleanup.push(() => {
            resize.disconnect();
            intersection.disconnect();
            view.dispose();
            this.#view = null;
          });
          if (waitsForData) this.#awaitReveal(view);
        })
        .catch(() => undefined);
    }

    /** Marks with reveal="data" play when the page's content (a <td-reveal>) is in the document. */
    #awaitReveal(view: LoaderView) {
      const start = (signal: Element) => {
        const legs = parseLegs(signal.getAttribute("legs"));
        view.update({ start: true, ...(legs && !this.#progress ? { progress: legs } : {}) });
      };
      const present = document.querySelector("td-reveal");
      if (present) return start(present);
      const listener = (event: Event) => {
        document.removeEventListener("td:reveal", listener);
        start(event.target as Element);
      };
      document.addEventListener("td:reveal", listener);
      this.#cleanup.push(() => document.removeEventListener("td:reveal", listener));
    }
  }

  /** Rendered with a page's content; tells that page's marks the data has settled in. */
  class RevealElement extends HTMLElement {
    connectedCallback() {
      this.dispatchEvent(new Event("td:reveal", { bubbles: true }));
    }
  }

  customElements.define("td-motif", MotifElement);
  customElements.define("td-reveal", RevealElement);
}
