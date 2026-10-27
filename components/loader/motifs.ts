import {
  BackSide,
  BufferGeometry,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  LinearSRGBColorSpace,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  Path,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Shape,
  TorusGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from "three";

import { stackHeights, type ExecutionLeg, type ExecutionProgress, type LoaderVariant } from "./timing";

export type Rgb = [number, number, number];
export type Palette = { paper: Rgb; ink: Rgb; accent: Rgb; negative: Rgb };
type Role = "ink" | "accent" | "negative";

export type MotifState = {
  progress?: ExecutionProgress;
  /** Global seconds when the work finished (orbit plays its settle from here). */
  settledAt: number | null;
  startedAt: number;
  settleSeconds: number;
  still: boolean;
};

export type Motif = {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Global time of the reduced-motion still frame. */
  still: number;
  update(time: number, state: MotifState): void;
  resize(width: number, height: number): void;
  setPalette(palette: Palette): void;
  dispose(): void;
};

// Same engraving language as the landing coin: world-space slices that thicken on the
// shaded side, reeding on coin edges, plus a scan band and an accent mix for loaders.
const VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosO;
  void main() {
    vPosO = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uPaper;
  uniform vec3 uInk;
  uniform vec3 uAccent;
  uniform vec3 uDir;
  uniform float uDensity;
  uniform float uOpacity;
  uniform float uReed;
  uniform float uAccentMix;
  uniform vec3 uScan;
  uniform vec3 uLight;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosO;

  float lines(float coord, float halfWidth) {
    float d = abs(fract(coord + 0.5) - 0.5);
    float aa = fwidth(coord);
    return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, d);
  }

  void main() {
    float lambert = clamp(dot(normalize(vNormalW), normalize(uLight)) * 0.5 + 0.5, 0.0, 1.0);
    float slices = lines(dot(vPosW, uDir) * uDensity, mix(0.3, 0.07, lambert));
    float reeds = lines(atan(vPosO.y, vPosO.x) * 19.0985, mix(0.32, 0.12, lambert));
    float edge = uReed * smoothstep(0.975, 0.995, length(vPosO.xy)) * (1.0 - smoothstep(0.08, 0.095, abs(vPosO.z)));
    float ink = mix(slices, reeds, edge);
    float band = uScan.z * (1.0 - smoothstep(uScan.y * 0.5, uScan.y, abs(vPosW.y - uScan.x)));
    vec3 line = mix(uInk, uAccent, max(band, uAccentMix));
    gl_FragColor = vec4(mix(uPaper, line, ink), uOpacity);
  }
`;

// Silhouettes for smooth shapes (tori) via an inverted hull pushed out along the normals.
const OUTLINE_VERTEX = /* glsl */ `
  uniform float uThickness;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uThickness, 1.0);
  }
`;
const OUTLINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() { gl_FragColor = vec4(uColor, uOpacity); }
`;

const vec3 = ([r, g, b]: Rgb) => new Vector3(r, g, b);
const lineColor = ([r, g, b]: Rgb) => new Color().setRGB(r, g, b, LinearSRGBColorSpace);
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;

/** Materials for one view, so a palette or scale change updates them all. */
class Kit {
  private engravings: { material: ShaderMaterial; role: Role }[] = [];
  private lines: { material: LineBasicMaterial; role: Role }[] = [];
  private outlines: { material: ShaderMaterial; role: Role }[] = [];

  constructor(private palette: Palette) {}

  engraving(role: Role, dir: [number, number, number] = [0, 1, 0], { reed = false, fades = false } = {}) {
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: fades,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      uniforms: {
        uPaper: { value: vec3(this.palette.paper) },
        uInk: { value: vec3(this.palette[role]) },
        uAccent: { value: vec3(this.palette.accent) },
        uDir: { value: new Vector3(...dir).normalize() },
        uDensity: { value: 20 },
        uOpacity: { value: 1 },
        uReed: { value: reed ? 1 : 0 },
        uAccentMix: { value: 0 },
        uScan: { value: new Vector3(0, 0.1, 0) },
        uLight: { value: new Vector3(-0.6, 0.8, 0.9) },
      },
    });
    this.engravings.push({ material, role });
    return material;
  }

  line(role: Role, opacity = 1) {
    const material = new LineBasicMaterial({ color: lineColor(this.palette[role]), transparent: opacity < 1, opacity });
    this.lines.push({ material, role });
    return material;
  }

  outline(role: Role) {
    const material = new ShaderMaterial({
      vertexShader: OUTLINE_VERTEX,
      fragmentShader: OUTLINE_FRAGMENT,
      side: BackSide,
      uniforms: { uColor: { value: vec3(this.palette[role]) }, uThickness: { value: 0.01 }, uOpacity: { value: 1 } },
    });
    this.outlines.push({ material, role });
    return material;
  }

  private roles = new Map<ShaderMaterial, Role>();

  /** Recolors one piece (for example a failed order leg) without touching the rest. */
  setRoleIfChanged(material: ShaderMaterial, line: LineBasicMaterial, role: Role) {
    if ((this.roles.get(material) ?? "ink") === role) return;
    this.roles.set(material, role);
    for (const entry of [...this.engravings, ...this.lines]) {
      if (entry.material === material || entry.material === line) entry.role = role;
    }
    this.applyPalette();
  }

  setPalette(palette: Palette) {
    this.palette = palette;
    this.applyPalette();
  }

  private applyPalette() {
    for (const { material, role } of this.engravings) {
      material.uniforms.uPaper.value = vec3(this.palette.paper);
      material.uniforms.uInk.value = vec3(this.palette[role]);
      material.uniforms.uAccent.value = vec3(this.palette.accent);
    }
    for (const { material, role } of this.lines) material.color = lineColor(this.palette[role]);
    for (const { material, role } of this.outlines) material.uniforms.uColor.value = vec3(this.palette[role]);
  }

  /** Engraved lines every few CSS pixels and 1 px outlines, whatever the stage size. */
  setScale(pxPerUnit: number, cssHeight: number) {
    const spacing = Math.min(Math.max(cssHeight / 42, 2.4), 6.5);
    for (const { material } of this.engravings) material.uniforms.uDensity.value = pxPerUnit / spacing;
    for (const { material } of this.outlines) material.uniforms.uThickness.value = 1.1 / pxPerUnit;
  }

  dispose() {
    for (const { material } of [...this.engravings, ...this.lines, ...this.outlines]) material.dispose();
  }
}

// Geometry is immutable and shared by every view of a motif.
const cache = new Map<string, BufferGeometry>();
function shared(key: string, build: () => BufferGeometry) {
  let geometry = cache.get(key);
  if (!geometry) cache.set(key, (geometry = build()));
  return geometry;
}

const PROFILE = [
  [0, 0.07],
  [0.8, 0.07],
  [0.85, 0.11],
  [0.96, 0.118],
  [1, 0.09],
  [1, -0.09],
  [0.96, -0.118],
  [0.85, -0.11],
  [0.8, -0.07],
  [0, -0.07],
].map(([x, y]) => new Vector2(x, y));

const BULL_RIGHT: Array<[number, number, number, number]> = [
  [0.36, 0.31, 0.52, 0.54],
  [0.47, 0.24, 0.29, 0.17],
  [0.41, 0.17, 0.47, 0.07],
  [0.37, 0, 0.25, 0.03],
  [0.25, -0.1, 0.19, -0.22],
  [0.22, -0.32, 0.16, -0.4],
  [0.1, -0.47, 0, -0.46],
];

function bullShape() {
  const shape = new Shape();
  shape.moveTo(0, 0.22);
  shape.lineTo(0.15, 0.25);
  const starts: Array<[number, number]> = [[0.15, 0.25]];
  for (const [cx, cy, x, y] of BULL_RIGHT) {
    shape.quadraticCurveTo(cx, cy, x, y);
    starts.push([x, y]);
  }
  for (let i = BULL_RIGHT.length - 1; i >= 0; i--) {
    shape.quadraticCurveTo(-BULL_RIGHT[i][0], BULL_RIGHT[i][1], -starts[i][0], starts[i][1]);
  }
  for (const side of [-1, 1]) {
    const nostril = new Path();
    nostril.absellipse(side * 0.075, -0.355, 0.032, 0.026, 0, Math.PI * 2, false, 0);
    shape.holes.push(nostril);
  }
  return shape;
}

const coinGeometry = () =>
  shared("coin", () => new LatheGeometry(PROFILE, 96).rotateX(Math.PI / 2));
const coinEdges = () => shared("coin-edges", () => new EdgesGeometry(coinGeometry(), 20));
const emblemGeometry = () =>
  shared("emblem", () =>
    new ExtrudeGeometry(bullShape(), {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.014,
      bevelSize: 0.012,
      bevelSegments: 2,
      curveSegments: 12,
    })
      .scale(0.74, 0.74, 1)
      .translate(0, -0.03, 0.07),
  );
const emblemEdges = () => shared("emblem-edges", () => new EdgesGeometry(emblemGeometry(), 28));
const shareGeometry = () => shared("share", () => new CylinderGeometry(0.2, 0.2, 0.04, 40));
const shareEdges = () => shared("share-edges", () => new EdgesGeometry(shareGeometry(), 30));
const LOT_HEIGHT = 0.07;
const lotGeometry = () => shared("lot", () => new CylinderGeometry(0.26, 0.26, LOT_HEIGHT * 0.86, 40));
const lotEdges = () => shared("lot-edges", () => new EdgesGeometry(lotGeometry(), 30));
const discGeometry = (radius: number) => shared(`disc-${radius}`, () => new CylinderGeometry(radius, radius, 0.12, 64));
const discEdges = (radius: number) => shared(`disc-edges-${radius}`, () => new EdgesGeometry(discGeometry(radius), 30));
const torusGeometry = () => shared("torus", () => new TorusGeometry(0.62, 0.15, 24, 80));

function circle(radius: number, segments = 72, dashed = false) {
  return shared(`circle-${radius}-${segments}-${dashed}`, () => {
    const points: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + (dashed ? 0.5 : 1)) / segments) * Math.PI * 2;
      points.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      if (dashed) points.push(Math.cos(b) * radius, 0, Math.sin(b) * radius);
    }
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
  });
}

function ruler(from: number, to: number, ticks: number[]) {
  const points = [from, 0, 0, to, 0, 0];
  for (let x = from + 0.1; x < to; x += 0.2) points.push(x, 0, 0, x, -0.05, 0);
  for (const x of ticks) points.push(x, 0, 0, x, -0.12, 0);
  return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
}

function coin(kit: Kit) {
  const group = new Group();
  group.add(new Mesh(coinGeometry(), kit.engraving("ink", [0, 1, 0], { reed: true })));
  group.add(new LineSegments(coinEdges(), kit.line("ink")));
  const emblem = kit.engraving("accent", [1, 1.4, 0]);
  const emblemLine = kit.line("accent");
  for (const side of [0, Math.PI]) {
    const face = new Group();
    face.rotation.y = side;
    face.add(new Mesh(emblemGeometry(), emblem), new LineSegments(emblemEdges(), emblemLine));
    group.add(face);
  }
  return group;
}

function share(kit: Kit, lot = false) {
  const material = kit.engraving("ink", [0.45, 1, 0.3], { fades: true });
  const line = kit.line("ink");
  line.transparent = true;
  const group = new Group();
  group.add(
    new Mesh(lot ? lotGeometry() : shareGeometry(), material),
    new LineSegments(lot ? lotEdges() : shareEdges(), line),
  );
  return { group, material, line };
}

/** Frames a box of world units around `target`, looking down by `pitch` (rise per unit of distance). */
function framer(camera: PerspectiveCamera, box: { w: number; h: number }, target: Vector3, pitch: number) {
  return (width: number, height: number) => {
    camera.aspect = width / height;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max(box.h / 2 / tan, box.w / 2 / (tan * camera.aspect)) * 1.06;
    camera.position.set(target.x, target.y + pitch * distance, target.z + distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    return height / (2 * distance * Math.hypot(1, pitch) * tan);
  };
}

type Parts = { root: Object3D; update: (time: number, state: MotifState) => void; still: number; box: { w: number; h: number }; target?: Vector3; pitch?: number };

/** coin: the brand mark spinning. Generic and inline waits. */
function coinMotif(kit: Kit): Parts {
  const root = coin(kit);
  return {
    root,
    still: 3.82,
    box: { w: 2.3, h: 2.3 },
    pitch: 0.1,
    update(time) {
      root.rotation.y = time * 1.5;
      root.rotation.x = 0.18;
      root.position.y = Math.sin(time * 2.2) * 0.04;
    },
  };
}

/** link: two interlocked rings turning. Connecting to SnapTrade and session checks. */
function linkMotif(kit: Kit): Parts {
  const root = new Group();
  const ring = (role: Role, x: number, flat: boolean, dir: [number, number, number]) => {
    const mesh = new Mesh(torusGeometry(), kit.engraving(role, dir));
    mesh.add(new Mesh(torusGeometry(), kit.outline(role)));
    mesh.position.x = x;
    if (flat) mesh.rotation.x = Math.PI / 2;
    root.add(mesh);
  };
  ring("ink", -0.34, false, [0, 1, 0]);
  ring("accent", 0.34, true, [1, 1.3, 0.4]);
  return {
    root,
    still: 0.9,
    box: { w: 2.5, h: 1.9 },
    pitch: 0.08,
    update(time) {
      root.rotation.y = time * 0.9;
      root.rotation.x = 0.3 + Math.sin(time * 1.2) * 0.15;
      root.rotation.z = Math.sin(time * 0.7) * 0.1;
    },
  };
}

/** scan: a layered tower of holdings read by a moving cobalt plane. Portfolio X-Ray. */
function scanMotif(kit: Kit): Parts {
  const root = new Group();
  const tower = new Group();
  const radii = [0.95, 0.7, 0.86, 0.56, 0.78, 0.6];
  const materials = radii.map((radius, i) => {
    const material = kit.engraving("ink", [0.5, 1, 0.25]);
    const disc = new Mesh(discGeometry(radius), material);
    disc.add(new LineSegments(discEdges(radius), kit.line("ink")));
    disc.position.y = -0.95 + i * 0.38;
    tower.add(disc);
    return material;
  });
  const plane = new LineLoop(circle(1.2), kit.line("accent"));
  const ticks = new LineSegments(circle(1.32, 48, true), kit.line("accent", 0.6));
  root.add(tower, plane, ticks);
  return {
    root,
    still: 0.14,
    box: { w: 2.7, h: 2.6 },
    pitch: 0.34,
    update(time) {
      tower.rotation.y = time * 0.45;
      const y = Math.sin(time * 1.7) * 1.05;
      plane.position.y = ticks.position.y = y;
      ticks.rotation.y = -time * 0.3;
      for (const material of materials) material.uniforms.uScan.value.set(y, 0.11, 1);
    },
  };
}

/** orbit: Studio showpiece. Candidates join an orbit around the thesis coin, a cobalt
 * marker checks each one, and on completion they drop into a row of whole-share lots. */
function orbitMotif(kit: Kit): Parts {
  const COUNT = 8;
  const RADIUS = 1.8;
  const root = new Group();
  const hero = coin(kit);
  hero.scale.setScalar(0.82);
  root.add(hero);
  const orbit = new Group();
  orbit.position.y = -0.2;
  orbit.add(new LineSegments(circle(RADIUS, 96, true), kit.line("ink", 0.45)));
  const marker = new LineLoop(circle(0.3, 40), kit.line("accent"));
  orbit.add(marker);
  root.add(orbit);
  const base = new LineSegments(
    ruler(-1.9, 1.9, Array.from({ length: COUNT }, (_, i) => (i - (COUNT - 1) / 2) * 0.46)),
    kit.line("ink", 0.8),
  );
  base.position.set(0, -1.55, 0.6);
  root.add(base);
  const candidates = Array.from({ length: COUNT }, () => {
    const piece = share(kit);
    root.add(piece.group);
    return piece;
  });
  const local = new Vector3();
  const target = new Vector3();
  return {
    root,
    still: 14,
    box: { w: 4.3, h: 2.85 },
    target: new Vector3(0, -0.35, 0),
    pitch: 0.3,
    update(time, state) {
      const t = state.still ? 14 : time - state.startedAt;
      const settle = state.settledAt == null ? 0 : easeOutCubic(clamp01((time - state.settledAt) / state.settleSeconds));
      hero.rotation.y = time * 0.6;
      hero.position.y = 0.15 + settle * 0.2 + Math.sin(time * 1.4) * 0.03;
      const sweep = t * 1.3;
      marker.position.set(Math.cos(sweep) * RADIUS, 0, Math.sin(sweep) * RADIUS);
      marker.scale.setScalar(1 + Math.sin(t * 6) * 0.08);
      (marker.material as LineBasicMaterial).opacity = 1 - settle;
      base.visible = settle > 0;
      candidates.forEach(({ group, material, line }, i) => {
        const appear = settle > 0 ? 1 : easeOutBack(clamp01((t - 0.4 - i * 1.1) / 0.35));
        const angle = (i / COUNT) * Math.PI * 2 + t * 0.35;
        local.set(Math.cos(angle) * RADIUS, -0.2, Math.sin(angle) * RADIUS);
        target.set((i - (COUNT - 1) / 2) * 0.46, -1.53, 0.6);
        group.position.lerpVectors(local, target, settle);
        group.scale.setScalar(Math.max(appear, 0.001));
        group.visible = appear > 0.01;
        const gap = Math.abs(((angle - sweep) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const near = Math.min(gap, Math.PI * 2 - gap);
        material.uniforms.uAccentMix.value = settle > 0 ? 0 : 1 - clamp01(near / 0.5);
        line.opacity = 1;
      });
    },
  };
}

/** stacks: paced order legs, one stack of whole-share lots per leg. Execution queue. */
function stacksMotif(kit: Kit): Parts {
  const root = new Group();
  type Leg = { group: Group; coins: ReturnType<typeof share>[]; fill: number; slot: LineLoop; pulse: LineLoop };
  let legs: Leg[] = [];
  let baseline: LineSegments | null = null;
  let signature = "";
  let last = 0;
  const BASE_Y = -0.55;
  const DROP = 0.75;
  const DEFAULT: ExecutionLeg[] = [4, 6, 12, 5].map((shares, i) => ({ symbol: `L${i}`, shares, status: "queued" }));
  const slotLine = kit.line("ink", 0.35);
  const failedLine = kit.line("negative");
  const pulseLine = kit.line("accent");

  function build(source: ExecutionLeg[]) {
    for (const leg of legs) root.remove(leg.group);
    if (baseline) root.remove(baseline);
    const heights = stackHeights(source);
    const xs = source.map((_, i) => (i - (source.length - 1) / 2) * 0.82);
    baseline = new LineSegments(ruler(xs[0] - 0.55, xs[xs.length - 1] + 0.55, xs), kit.line("ink"));
    baseline.position.y = BASE_Y;
    root.add(baseline);
    legs = source.map((_, i) => {
      const group = new Group();
      group.position.set(xs[i], BASE_Y, 0);
      const coins = Array.from({ length: heights[i] }, () => {
        const piece = share(kit, true);
        group.add(piece.group);
        return piece;
      });
      const slot = new LineLoop(circle(0.3, 40), slotLine);
      const pulse = new LineLoop(circle(0.34, 40), pulseLine);
      group.add(slot, pulse);
      root.add(group);
      return { group, coins, fill: 0, slot, pulse };
    });
  }

  return {
    root,
    still: 20,
    box: { w: 3.5, h: 1.45 },
    target: new Vector3(0, -0.12, 0),
    pitch: 0.42,
    update(time, state) {
      let source = state.progress?.legs.length ? state.progress.legs : DEFAULT;
      if (!state.progress?.legs.length) {
        const cycle = state.still ? 99 : (time - state.startedAt) % 6.5;
        source = DEFAULT.map((leg, i) => ({
          ...leg,
          status: cycle >= i + 1.4 ? "submitted" : cycle >= i + 0.6 ? "submitting" : cycle >= i ? "pacing" : "queued",
        }));
      }
      const key = source.map((leg) => leg.shares).join(",");
      if (key !== signature) {
        signature = key;
        build(source);
      }
      const dt = Math.min(Math.max(time - last, 0), 0.1);
      last = time;
      legs.forEach((leg, i) => {
        const status = source[i]?.status ?? "queued";
        const goal = status === "submitted" ? 1 : 0;
        leg.fill = state.still ? goal : leg.fill + Math.sign(goal - leg.fill) * Math.min(Math.abs(goal - leg.fill), dt / 0.45);
        const shown = leg.fill * leg.coins.length;
        leg.coins.forEach((piece, slot) => {
          // A rejected order places no shares: one toppled lot in the negative color.
          const rejected = status === "failed" && slot === 0;
          kit.setRoleIfChanged(piece.material, piece.line, rejected ? "negative" : "ink");
          const landed = rejected ? 1 : clamp01(shown - slot);
          piece.group.visible = landed > 0;
          piece.group.rotation.set(0, 0, rejected ? 1.15 : 0);
          piece.group.position.set(
            rejected ? 0.18 : 0,
            rejected ? 0.24 : LOT_HEIGHT * (slot + 0.5) + (1 - easeOutCubic(landed)) * DROP,
            0,
          );
        });
        // A lot on its way while the order is in flight.
        const next = leg.coins[Math.min(Math.ceil(shown), leg.coins.length - 1)];
        if (status === "submitting" && next && !state.still) {
          const phase = ((time * 1.6) % 1) ** 2;
          next.group.visible = true;
          next.group.position.y = LOT_HEIGHT * (Math.ceil(shown) + 0.5) + (1 - phase) * DROP;
        }
        leg.pulse.visible = status === "pacing" || status === "submitting";
        leg.pulse.scale.setScalar(1 + (state.still ? 0.1 : (Math.sin(time * 6) + 1) * 0.1));
        leg.slot.visible = status === "queued" || status === "failed";
        leg.slot.material = status === "failed" ? failedLine : slotLine;
      });
    },
  };
}

const BUILDERS: Record<LoaderVariant, (kit: Kit) => Parts> = {
  coin: coinMotif,
  link: linkMotif,
  scan: scanMotif,
  orbit: orbitMotif,
  stacks: stacksMotif,
};

export function buildMotif(variant: LoaderVariant, palette: Palette): Motif {
  const kit = new Kit(palette);
  const parts = BUILDERS[variant](kit);
  const scene = new Scene();
  scene.add(parts.root);
  const camera = new PerspectiveCamera(28, 1, 0.1, 60);
  const frame = framer(camera, parts.box, parts.target ?? new Vector3(), parts.pitch ?? 0.1);
  return {
    scene,
    camera,
    still: parts.still,
    update: parts.update,
    resize(width, height) {
      kit.setScale(frame(width, height), height);
    },
    setPalette: (next) => kit.setPalette(next),
    dispose: () => kit.dispose(),
  };
}
