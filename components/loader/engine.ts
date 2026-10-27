import { LinearSRGBColorSpace, WebGLRenderer } from "three";

import { buildMotif, type Motif, type MotifState, type Palette } from "./motifs";
import { animatedViews, backingSize, gpuBudget, type ExecutionProgress, type LoaderVariant, type Pose } from "./timing";

// One WebGL context for every motif on the page (loaders, marks, and the landing hero):
// each frame, every visible view's scene is drawn into a corner of a single detached
// canvas and copied into that view's own 2D canvas. Phones stay within one context
// however many views mount.

type View = {
  ctx: CanvasRenderingContext2D;
  motif: Motif;
  state: MotifState;
  backing: { width: number; height: number };
  visible: boolean;
  dirty: boolean;
  /** Was drawn animating last frame, so it owes one final still frame when it stops. */
  moving: boolean;
};

export type LoaderView = {
  resize(cssWidth: number, cssHeight: number): void;
  update(next: { progress?: ExecutionProgress; settled?: boolean; palette?: Palette; start?: boolean }): void;
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

/** Loops animate while visible; one-shot poses animate until their duration, then hold. */
function animating(view: View, time: number) {
  if (reducedMotion.matches) return false;
  const duration = view.motif.duration(view.state.pose);
  if (duration === Infinity) return true;
  return view.state.poseAt != null && time - view.state.poseAt <= duration;
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
  const { state } = view;
  const duration = view.motif.duration(state.pose);
  state.poseTime =
    state.poseAt == null ? 0 : state.still && duration !== Infinity ? duration : Math.min(time - state.poseAt, duration);
  view.motif.update(time, state);
  gl.render(view.motif.scene, view.motif.camera);
  view.ctx.clearRect(0, 0, width, height);
  view.ctx.drawImage(target, 0, target.height - height, width, height, 0, 0, width, height);
}

/** The reduced-motion frame, or the frame a one-shot pose ends on (or starts from, before it plays). */
function drawStill(view: View) {
  const { state, motif } = view;
  const duration = motif.duration(state.pose);
  view.state.still = true;
  draw(view, duration === Infinity ? motif.still : (state.poseAt ?? 0) + (state.poseAt == null ? 0 : duration));
  view.state.still = false;
  view.dirty = false;
  view.moving = false;
}

function tick(now: number) {
  frame = 0;
  if (document.hidden) return;
  if (now - lastFrame >= 1000 / budget.fps - 2) {
    lastFrame = now;
    const time = seconds();
    const visible = [...views].filter((view) => view.visible);
    const live = visible.filter((view) => animating(view, time));
    const chosen = animatedViews(
      live.map(({ backing }) => backing.width * backing.height),
      budget.framePixels,
    );
    live.forEach((view, index) => {
      if (!chosen.has(index)) return;
      draw(view, time);
      view.dirty = false;
      view.moving = true;
    });
    for (const view of visible) {
      const drawn = live.includes(view) && chosen.has(live.indexOf(view));
      if (!drawn && (view.dirty || view.moving)) drawStill(view);
    }
  }
  schedule();
}

function schedule() {
  if (frame || document.hidden) return;
  const time = seconds();
  for (const view of views) {
    if (view.visible && (view.dirty || view.moving || animating(view, time))) {
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

function attach(canvas: HTMLCanvasElement, motif: Motif, state: MotifState): LoaderView {
  getRenderer();
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  const view: View = { ctx, motif, state, backing: { width: 1, height: 1 }, visible: true, dirty: true, moving: false };
  views.add(view);

  return {
    resize(cssWidth, cssHeight) {
      if (cssWidth < 1 || cssHeight < 1) return;
      view.backing = backingSize(cssWidth, cssHeight, window.devicePixelRatio || 1, budget);
      canvas.width = view.backing.width;
      canvas.height = view.backing.height;
      view.motif.resize(cssWidth, cssHeight);
      // Paint right away so a remounted view never shows an empty frame.
      const time = seconds();
      if (animating(view, time)) draw(view, time);
      else drawStill(view);
      schedule();
    },
    update({ progress, settled, palette, start }) {
      const now = seconds();
      if (progress !== undefined) view.state.progress = progress;
      if (settled && view.state.settledAt == null) view.state.settledAt = now;
      if (start && view.state.poseAt == null) view.state.poseAt = now;
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

/** Throws when WebGL is unavailable; callers keep their text and layout without the canvas. */
export function attachView(
  canvas: HTMLCanvasElement,
  options: {
    variant: LoaderVariant;
    pose: Pose;
    palette: Palette;
    progress?: ExecutionProgress;
    settled?: boolean;
    settleMs: number;
    /** False holds the pose's first frame until `update({ start: true })`. */
    started: boolean;
  },
): LoaderView {
  const now = seconds();
  return attach(canvas, buildMotif(options.variant, options.palette, options.pose), {
    progress: options.progress,
    settledAt: options.settled ? now : null,
    startedAt: now,
    settleSeconds: options.settleMs / 1000,
    still: false,
    pose: options.pose,
    poseAt: options.started ? now : null,
    poseTime: 0,
  });
}

/** A custom looping scene (the landing hero) drawn by the same renderer. */
export function attachScene(canvas: HTMLCanvasElement, motif: Motif): LoaderView {
  const now = seconds();
  return attach(canvas, motif, {
    settledAt: null,
    startedAt: now,
    settleSeconds: 0,
    still: false,
    pose: "loading",
    poseAt: now,
    poseTime: 0,
  });
}
