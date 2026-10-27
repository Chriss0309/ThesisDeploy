import { LinearSRGBColorSpace, WebGLRenderer } from "three";

import { buildMotif, type Motif, type MotifState, type Palette } from "./motifs";
import { animatedViews, backingSize, gpuBudget, type ExecutionProgress, type LoaderVariant } from "./timing";

// One WebGL context for every loader on the page: each frame, every visible loader's
// scene is drawn into a corner of a single detached canvas and copied into that
// loader's own 2D canvas. Phones stay within one context however many loaders mount.

type View = {
  ctx: CanvasRenderingContext2D;
  motif: Motif;
  state: MotifState;
  backing: { width: number; height: number };
  visible: boolean;
  dirty: boolean;
};

export type LoaderView = {
  resize(cssWidth: number, cssHeight: number): void;
  update(next: { progress?: ExecutionProgress; settled?: boolean; palette?: Palette }): void;
  setVisible(visible: boolean): void;
  dispose(): void;
};

const views = new Set<View>();
const startedAt = performance.now();
const seconds = () => (performance.now() - startedAt) / 1000;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const budget = gpuBudget({
  coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  viewportWidth: window.innerWidth,
  cores: navigator.hardwareConcurrency,
  memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
});

let renderer: WebGLRenderer | null = null;
let frame = 0;
let lastFrame = 0;

function getRenderer() {
  if (renderer) return renderer;
  const canvas = document.createElement("canvas");
  canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
  canvas.addEventListener("webglcontextrestored", () => {
    for (const view of views) view.dirty = true;
    schedule();
  });
  renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  // Token colors pass through untouched so canvases match the CSS around them.
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setClearAlpha(0);
  renderer.setScissorTest(true);
  return renderer;
}

function draw(view: View, time: number) {
  const gl = getRenderer();
  const { width, height } = view.backing;
  const target = gl.domElement;
  if (target.width < width || target.height < height) {
    gl.setSize(Math.max(target.width, width), Math.max(target.height, height), false);
  }
  gl.setViewport(0, 0, width, height);
  gl.setScissor(0, 0, width, height);
  gl.clear();
  view.motif.update(time, view.state);
  gl.render(view.motif.scene, view.motif.camera);
  view.ctx.clearRect(0, 0, width, height);
  view.ctx.drawImage(target, 0, target.height - height, width, height, 0, 0, width, height);
}

function tick(now: number) {
  frame = 0;
  if (document.hidden) return;
  if (now - lastFrame >= 1000 / budget.fps - 2) {
    lastFrame = now;
    const time = seconds();
    const visible = [...views].filter((view) => view.visible);
    const animated = reducedMotion.matches
      ? new Set<number>()
      : animatedViews(
          visible.map(({ backing }) => backing.width * backing.height),
          budget.framePixels,
        );
    visible.forEach((view, index) => {
      if (animated.has(index)) {
        draw(view, time);
        view.dirty = false;
      } else if (view.dirty) {
        drawStill(view);
      }
    });
  }
  schedule();
}

function drawStill(view: View) {
  view.state.still = true;
  draw(view, view.motif.still);
  view.state.still = false;
  view.dirty = false;
}

function schedule() {
  if (frame || document.hidden) return;
  for (const view of views) {
    if (view.visible && (view.dirty || !reducedMotion.matches)) {
      frame = requestAnimationFrame(tick);
      return;
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  schedule();
});
reducedMotion.addEventListener("change", () => {
  for (const view of views) view.dirty = true;
  schedule();
});

/** Throws when WebGL is unavailable; callers keep their text-only status. */
export function attachLoader(
  canvas: HTMLCanvasElement,
  options: { variant: LoaderVariant; palette: Palette; progress?: ExecutionProgress; settled?: boolean; settleMs: number },
): LoaderView {
  getRenderer();
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  const now = seconds();
  const view: View = {
    ctx,
    motif: buildMotif(options.variant, options.palette),
    state: {
      progress: options.progress,
      settledAt: options.settled ? now : null,
      startedAt: now,
      settleSeconds: options.settleMs / 1000,
      still: false,
    },
    backing: { width: 1, height: 1 },
    visible: true,
    dirty: true,
  };
  views.add(view);

  return {
    resize(cssWidth, cssHeight) {
      if (cssWidth < 1 || cssHeight < 1) return;
      view.backing = backingSize(cssWidth, cssHeight, window.devicePixelRatio || 1, budget);
      canvas.width = view.backing.width;
      canvas.height = view.backing.height;
      view.motif.resize(cssWidth, cssHeight);
      // Paint right away so a remounted loader never shows an empty frame.
      if (reducedMotion.matches) drawStill(view);
      else draw(view, seconds());
      schedule();
    },
    update({ progress, settled, palette }) {
      if (progress !== undefined) view.state.progress = progress;
      if (settled && view.state.settledAt == null) view.state.settledAt = seconds();
      if (palette) view.motif.setPalette(palette);
      view.dirty = true;
      schedule();
    },
    setVisible(visible) {
      view.visible = visible;
      view.dirty = true;
      schedule();
    },
    dispose() {
      views.delete(view);
      view.motif.dispose();
    },
  };
}
