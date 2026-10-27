import {
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
  LineSegments,
  Mesh,
  Path,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Shape,
  Vector2,
  Vector3,
} from "three";

import type { Motif } from "@/components/loader/motifs";
import { CYCLE_SECONDS, LEGS, SETTLED_SECONDS, basketOpacity, legStart } from "./coin-timeline";

export type Rgb = [number, number, number];
export type CoinPalette = { paper: Rgb; ink: Rgb; accent: Rgb };

// Engraving: parallel world-space lines (horizontal slices of the object, like a
// contour plot) that thicken where the surface turns away from the light. The
// coin's edge switches to vertical reeding lines.
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
  uniform vec2 uDir;
  uniform float uDensity;
  uniform float uOpacity;
  uniform float uReed;
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
    vec3 n = normalize(vNormalW);
    float lambert = clamp(dot(n, normalize(uLight)) * 0.5 + 0.5, 0.0, 1.0);
    float halfWidth = mix(0.27, 0.06, lambert);

    float slices = lines(dot(vPosW.xy, uDir) * uDensity, halfWidth);
    float theta = atan(vPosO.y, vPosO.x);
    float reeds = lines(theta * 19.0985, mix(0.32, 0.12, lambert));
    float edge = uReed * smoothstep(0.975, 0.995, length(vPosO.xy)) * (1.0 - smoothstep(0.08, 0.095, abs(vPosO.z)));

    float ink = mix(slices, reeds, edge);
    gl_FragColor = vec4(mix(uPaper, uInk, ink), uOpacity);
  }
`;

type Disposable = { dispose: () => void };

function threeColor([r, g, b]: Rgb) {
  return new Color().setRGB(r, g, b, LinearSRGBColorSpace);
}

function engraving(palette: CoinPalette, ink: Rgb, dir: Vector2, { reed = false, fades = false } = {}) {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: fades,
    // Push faces back so the outline edges drawn on top never z-fight.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      uPaper: { value: new Vector3(...palette.paper) },
      uInk: { value: new Vector3(...ink) },
      uDir: { value: dir.clone().normalize() },
      uDensity: { value: 24 },
      uOpacity: { value: 1 },
      uReed: { value: reed ? 1 : 0 },
      uLight: { value: new Vector3(-0.6, 0.8, 0.9) },
    },
  });
}

// Coin profile (radius, height) revolved around its axis: a recessed field, a raised
// rim, and a rounded edge. Revolved around Y, then turned to face the camera.
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

// Right half of an original bull-head emblem (horns, ear, cheek, snout) as
// quadratic segments from the forehead to the chin; the left half is mirrored.
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
    const [cx, cy] = BULL_RIGHT[i];
    const [sx, sy] = starts[i];
    shape.quadraticCurveTo(-cx, cy, -sx, sy);
  }
  shape.lineTo(0, 0.22);
  for (const side of [-1, 1]) {
    const nostril = new Path();
    nostril.absellipse(side * 0.075, -0.355, 0.032, 0.026, 0, Math.PI * 2, false, 0);
    shape.holes.push(nostril);
  }
  return shape;
}

function easeOutBack(x: number) {
  const c = 1.4;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

/**
 * The hero scene as a motif for the shared loader renderer, so the landing page never
 * needs a second WebGL context. `onTime` reports the timeline position each frame.
 * Without `loop`, it plays one pass and stops on its settled frame, which is where
 * the pass is at that moment, so there's no jump.
 */
export function createCoinScene(palette: CoinPalette, onTime: (elapsed: number) => void, { loop = true } = {}) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0.9, 7.2);

  const owned: Disposable[] = [];
  const own = <T extends Disposable>(item: T) => (owned.push(item), item);
  const inkLine = own(new LineBasicMaterial({ color: threeColor(palette.ink) }));
  const accentLine = own(new LineBasicMaterial({ color: threeColor(palette.accent) }));
  const shareLine = own(new LineBasicMaterial({ color: threeColor(palette.ink), transparent: true }));
  const coinMaterial = own(engraving(palette, palette.ink, new Vector2(0, 1), { reed: true }));
  const emblemMaterial = own(engraving(palette, palette.accent, new Vector2(1, 1.4)));
  const stackMaterial = own(engraving(palette, palette.ink, new Vector2(0, 1), { fades: true }));
  const engravings = [coinMaterial, emblemMaterial, stackMaterial];

  // Hero coin with the emblem on both faces.
  const coin = new Group();
  const coinGeometry = own(new LatheGeometry(PROFILE, 144));
  coinGeometry.rotateX(Math.PI / 2);
  coin.add(new Mesh(coinGeometry, coinMaterial));
  coin.add(new LineSegments(own(new EdgesGeometry(coinGeometry, 20)), inkLine));

  const emblemGeometry = own(
    new ExtrudeGeometry(bullShape(), {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.014,
      bevelSize: 0.012,
      bevelSegments: 2,
      curveSegments: 20,
    }),
  );
  emblemGeometry.scale(0.74, 0.74, 1);
  emblemGeometry.translate(0, -0.03, 0.07);
  const emblemEdges = own(new EdgesGeometry(emblemGeometry, 28));
  for (const side of [0, Math.PI]) {
    const face = new Group();
    face.rotation.y = side;
    face.add(new Mesh(emblemGeometry, emblemMaterial));
    face.add(new LineSegments(emblemEdges, accentLine));
    coin.add(face);
  }
  coin.position.set(0, 0.5, 0);
  scene.add(coin);

  // Basket: one stack of whole-share coins per order leg, on a ruled baseline.
  const SHARE_HEIGHT = 0.045;
  const BASE_Y = -1.6;
  // In front of the hero coin so falling shares never pass through it.
  const STACK_Z = 0.5;
  const legX = LEGS.map((_, index) => (index - (LEGS.length - 1) / 2) * 0.78);
  const shareGeometry = own(new CylinderGeometry(0.22, 0.22, SHARE_HEIGHT * 0.86, 48));
  const shareEdges = own(new EdgesGeometry(shareGeometry, 30));
  const shares = LEGS.flatMap((leg, legIndex) =>
    Array.from({ length: leg.shares }, (_, slot) => {
      const share = new Group();
      share.add(new Mesh(shareGeometry, stackMaterial));
      share.add(new LineSegments(shareEdges, shareLine));
      share.position.set(legX[legIndex], 0, STACK_Z);
      share.visible = false;
      scene.add(share);
      return { share, legIndex, slot, restY: BASE_Y + SHARE_HEIGHT * (slot + 0.5) };
    }),
  );

  const ruler: number[] = [-1.7, BASE_Y, STACK_Z, 1.7, BASE_Y, STACK_Z];
  for (let x = -1.6; x <= 1.61; x += 0.2) ruler.push(x, BASE_Y, STACK_Z, x, BASE_Y - 0.05, STACK_Z);
  for (const x of legX) ruler.push(x, BASE_Y, STACK_Z, x, BASE_Y - 0.12, STACK_Z);
  const rulerGeometry = own(new BufferGeometry());
  rulerGeometry.setAttribute("position", new Float32BufferAttribute(ruler, 3));
  scene.add(new LineSegments(rulerGeometry, inkLine));

  const pointer = new Vector2();
  const tilt = new Vector2();

  function pose(elapsed: number) {
    tilt.lerp(pointer, 0.06);
    // Front three-quarter view at SETTLED_SECONDS, the reduced-motion still frame.
    coin.rotation.y = (elapsed - SETTLED_SECONDS) * 0.5 - 0.45 + tilt.x * 0.35;
    coin.rotation.x = 0.16 + Math.sin(elapsed * 0.7) * 0.05 + tilt.y * 0.18;
    coin.position.y = 0.5 + Math.sin(elapsed * 1.1) * 0.03;

    const cycleOpacity = basketOpacity(elapsed);
    stackMaterial.uniforms.uOpacity.value = cycleOpacity;
    shareLine.opacity = cycleOpacity;
    const t = elapsed % CYCLE_SECONDS;
    for (const { share, legIndex, slot, restY } of shares) {
      const start = legStart(legIndex) + slot * 0.05;
      const progress = Math.min(Math.max((t - start) / 0.42, 0), 1);
      share.visible = t >= start && cycleOpacity > 0;
      share.position.y = restY + (1 - easeOutBack(progress)) * 1.1;
      share.rotation.y = (1 - progress) * 1.2;
    }
  }

  function resize(width: number, height: number) {
    camera.aspect = width / height;
    // Keep the coin and the stacks in frame on wide, short stages.
    const wide = width / height > 1.15;
    camera.position.z = wide ? 7.5 : 7.2;
    camera.lookAt(0, wide ? -0.32 : -0.15, 0);
    camera.updateProjectionMatrix();
    // About one engraved line every 7 CSS pixels at any stage size.
    const visibleHeight = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
    for (const material of engravings) material.uniforms.uDensity.value = height / visibleHeight / 7;
  }

  // Advances only while drawn (the engine pauses offscreen and hidden tabs).
  let elapsed = 0;
  let last: number | null = null;
  const motif: Motif & { setPointer(x: number, y: number): void } = {
    scene,
    camera,
    still: SETTLED_SECONDS,
    duration: () => (loop ? Infinity : SETTLED_SECONDS),
    update(time, state) {
      if (state.still) {
        last = null;
        pose(SETTLED_SECONDS);
        onTime(SETTLED_SECONDS);
        return;
      }
      if (last != null) elapsed += Math.min(Math.max(time - last, 0), 0.1);
      last = time;
      pose(elapsed);
      onTime(elapsed);
    },
    resize,
    setPalette: () => undefined,
    setPointer(x, y) {
      pointer.set(x, y);
    },
    dispose() {
      for (const item of owned) item.dispose();
    },
  };
  return motif;
}

export type CoinScene = ReturnType<typeof createCoinScene>;
