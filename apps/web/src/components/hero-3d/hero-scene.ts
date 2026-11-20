// Dashboard hero 3D scene (ADR-0031, ADR-0032). Loaded lazily; plain three.js, named imports only.
// "Voice becomes understanding": a point-cloud sphere displaced by a static multi-band wave
// (a voice signature, not live data), three thin orbital rings and a faint inner core.
// Render on demand: no continuous loop, no auto-rotation. A rAF loop runs only while the
// pointer-driven tilt is easing towards its target and stops as soon as it settles.
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  NormalBlending,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  Sprite,
  SpriteMaterial,
  WebGLRenderer,
} from 'three';

export interface HeroPalette {
  indigo: string;
  violet: string;
  blue: string;
  cyan: string;
  foreground: string;
  background: string;
} // raw CSS colour strings (may be oklch(...))

export interface HeroSceneHandle {
  setPalette(p: HeroPalette): void;
  resize(width: number, height: number, dpr: number): void;
  setPointer(x: number, y: number): void;
  setActive(active: boolean): void;
  dispose(): void;
}

const MAX_TILT = (8 * Math.PI) / 180;
const BASE_TILT_X = 0.28;
const BASE_TILT_Y = -0.45;
const SETTLE_EPSILON = 0.001;
const SPHERE_POINTS = 2600;
const BASE_Z = 4.05; // sphere fills ~65% of the visual height, rings frame it
const WHITE = new Color(1, 1, 1);
const RING_SEGMENTS = 160;

const RINGS = [
  { radius: 1.22, tiltX: 1.35, tiltZ: 0.3, color: 'blue' },
  { radius: 1.34, tiltX: 0.5, tiltZ: -0.9, color: 'cyan' },
  { radius: 1.46, tiltX: -0.35, tiltZ: 0.55, color: 'blue' },
] as const;

/** Converts any CSS colour (including oklch) to a three Color via a 1x1 canvas. */
function makeColorReader(): (value: string) => Color {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  return (value) => {
    const out = new Color();
    if (!ctx) return out.setRGB(0.5, 0.5, 0.5, SRGBColorSpace);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#808080';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return out.setRGB(
      (d[0] ?? 128) / 255,
      (d[1] ?? 128) / 255,
      (d[2] ?? 128) / 255,
      SRGBColorSpace,
    );
  };
}

/** Soft round sprite for points, generated locally (no network textures). */
function makeDotTexture(): CanvasTexture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  // CPU-backed canvas: uploading a GPU-backed 2D canvas to WebGL forces a pixel readback stall.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Fibonacci-sphere points displaced by a deterministic multi-band wave. Also returns 0..1 latitude. */
function buildSignatureSphere(): { positions: Float32Array; latitude: Float32Array } {
  const positions = new Float32Array(SPHERE_POINTS * 3);
  const latitude = new Float32Array(SPHERE_POINTS);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SPHERE_POINTS; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / SPHERE_POINTS;
    const ring = Math.sqrt(1 - y * y);
    const lon = i * golden;
    const x = Math.cos(lon) * ring;
    const z = Math.sin(lon) * ring;
    const lat = Math.asin(y);
    const envelope = 0.35 + 0.65 * Math.cos(lat) ** 2;
    const wave =
      0.55 * Math.sin(4 * lon + 1.3 + lat) +
      0.3 * Math.sin(9 * lon - 2 * lat) +
      0.15 * Math.sin(17 * lon + 3 * lat);
    const r = 1 + 0.1 * envelope * wave;
    positions[i * 3] = x * r;
    positions[i * 3 + 1] = y * r;
    positions[i * 3 + 2] = z * r;
    latitude[i] = (y + 1) / 2;
  }
  return { positions, latitude };
}

/** Soft radial glow sprite for the core. */
function makeGlowTexture(): CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function ringGeometry(radius: number): BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < RING_SEGMENTS; i += 1) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  return g;
}

const yieldToMain = (): Promise<void> => {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return typeof sched?.yield === 'function'
    ? sched.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Returns the handle synchronously; the heavy setup (geometry, shader compile, first render) runs in
 * short slices that yield to the main thread. Handle calls made before setup finishes are recorded
 * (palette, size, pointer, active) and applied when the first frame renders; dispose() aborts cleanly.
 */
export function mountHeroScene(
  canvas: HTMLCanvasElement,
  opts: { palette: HeroPalette; onContextLost: () => void; onFirstFrame?: () => void },
): HeroSceneHandle {
  const disposables: Array<{ dispose(): void }> = [];
  let renderer: WebGLRenderer | undefined;
  let ready = false;
  let disposed = false;
  let palette = opts.palette;
  let size: { width: number; height: number; dpr: number } | undefined;
  let active = true;
  let firstFrameSent = false;
  let raf = 0;
  let lastTick = 0;
  let curX = 0;
  let curY = 0;
  let tgtX = 0;
  let tgtY = 0;
  let baseZ = BASE_Z;

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 50);
  const group = new Group();
  scene.add(group);
  camera.position.set(0, 0, baseZ);

  let pointsMat: PointsMaterial | undefined;
  let sphereGeo: BufferGeometry | undefined;
  let latitude: Float32Array = new Float32Array(0);
  let glowMat: SpriteMaterial | undefined;
  const ringMats: LineBasicMaterial[] = [];

  const applyTilt = () => {
    group.rotation.y = BASE_TILT_Y + curX * MAX_TILT;
    group.rotation.x = BASE_TILT_X + curY * MAX_TILT;
  };

  const render = () => {
    if (disposed || !ready || !renderer) return;
    applyTilt();
    renderer.render(scene, camera);
    if (!firstFrameSent) {
      firstFrameSent = true;
      opts.onFirstFrame?.();
    }
  };

  const applySize = () => {
    if (!renderer || !size) return;
    renderer.setPixelRatio(size.dpr);
    renderer.setSize(size.width, size.height, false);
    camera.aspect = size.width / size.height;
    // Keep the whole composition inside narrow containers.
    baseZ = camera.aspect < 1 ? BASE_Z / camera.aspect : BASE_Z;
    camera.position.set(0, 0, baseZ);
    camera.updateProjectionMatrix();
  };

  const settled = () =>
    Math.abs(tgtX - curX) < SETTLE_EPSILON && Math.abs(tgtY - curY) < SETTLE_EPSILON;

  const stopLoop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const tick = (now: number) => {
    raf = 0;
    if (disposed || !active) return;
    const dt = Math.min(now - lastTick, 50) / 1000;
    lastTick = now;
    const k = 1 - Math.exp(-dt * 7);
    curX += (tgtX - curX) * k;
    curY += (tgtY - curY) * k;
    if (settled()) {
      curX = tgtX;
      curY = tgtY;
      render();
      return; // settled: loop stops, GPU idle
    }
    render();
    raf = requestAnimationFrame(tick);
  };

  const startLoop = () => {
    if (raf || disposed || !active || !ready || settled()) return;
    lastTick = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const applyPalette = (p: HeroPalette) => {
    if (!sphereGeo || !pointsMat || !glowMat) return;
    const readColor = makeColorReader();
    const indigo = readColor(p.indigo);
    const violet = readColor(p.violet);
    const blue = readColor(p.blue);
    const cyan = readColor(p.cyan);
    const bg = readColor(p.background);
    // Perceptual-ish luminance of the background decides the blend tuning.
    const light = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 0.3;

    // Float32BufferAttribute copies its input, so write into the attribute's own array.
    const attr = sphereGeo.getAttribute('color');
    const colors = attr.array as Float32Array;
    const c = new Color();
    for (let i = 0; i < latitude.length; i += 1) {
      const t = latitude[i] ?? 0;
      if (t < 0.5) c.copy(indigo).lerp(violet, t / 0.5);
      else c.copy(violet).lerp(blue, (t - 0.5) / 0.5);
      if (!light) c.lerp(WHITE, 0.25); // luminous on dark; saturated brand colour on light
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    attr.needsUpdate = true;

    pointsMat.blending = light ? NormalBlending : AdditiveBlending;
    pointsMat.opacity = light ? 0.95 : 0.9;
    pointsMat.size = light ? 0.058 : 0.052;
    pointsMat.needsUpdate = true;

    glowMat.color.copy(violet);
    glowMat.blending = light ? NormalBlending : AdditiveBlending;
    glowMat.opacity = light ? 0.3 : 0.6;
    glowMat.needsUpdate = true;

    RINGS.forEach((spec, i) => {
      const mat = ringMats[i];
      if (!mat) return;
      mat.color.copy(spec.color === 'cyan' ? cyan : blue);
      mat.opacity = light ? 0.55 : 0.4;
    });
  };

  const onLost = (e: Event) => {
    e.preventDefault();
    stopLoop();
    if (disposed) return;
    opts.onContextLost();
  };

  const setup = async () => {
    // Slice 1: renderer, camera, empty scene.
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    renderer.setClearColor(0x000000, 0);
    canvas.addEventListener('webglcontextlost', onLost);
    await yieldToMain();
    if (disposed) return;

    // Slice 2: point geometry and material.
    const dot = makeDotTexture();
    disposables.push(dot);
    const sphere = buildSignatureSphere();
    latitude = sphere.latitude;
    sphereGeo = new BufferGeometry();
    sphereGeo.setAttribute('position', new Float32BufferAttribute(sphere.positions, 3));
    sphereGeo.setAttribute(
      'color',
      new Float32BufferAttribute(new Float32Array(latitude.length * 3), 3),
    );
    pointsMat = new PointsMaterial({
      size: 0.05,
      map: dot,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    disposables.push(sphereGeo, pointsMat);
    group.add(new Points(sphereGeo, pointsMat));
    await yieldToMain();
    if (disposed) return;

    // Slice 3: core glow and rings.
    const glowTex = makeGlowTexture();
    glowMat = new SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false });
    disposables.push(glowTex, glowMat);
    const glow = new Sprite(glowMat);
    glow.scale.setScalar(2.3);
    glow.renderOrder = -1;
    group.add(glow);
    for (const spec of RINGS) {
      const geo = ringGeometry(spec.radius);
      const mat = new LineBasicMaterial({ transparent: true, depthWrite: false });
      const ring = new LineLoop(geo, mat);
      ring.rotation.x = spec.tiltX;
      ring.rotation.z = spec.tiltZ;
      group.add(ring);
      ringMats.push(mat);
      disposables.push(geo, mat);
    }
    applyPalette(palette);
    applySize();
    await yieldToMain();
    if (disposed) return;

    // Slice 4: shader compile (parallel where the browser supports it).
    await renderer.compileAsync(scene, camera);
    await yieldToMain();
    if (disposed) return;

    // Slice 5: first frame.
    ready = true;
    applySize();
    render();
    startLoop();
  };

  setup().catch(() => {
    if (!disposed) opts.onContextLost();
  });

  return {
    setPalette(p) {
      palette = p;
      if (disposed || !ready) return;
      applyPalette(p);
      render();
    },
    resize(width, height, dpr) {
      if (disposed || width <= 0 || height <= 0) return;
      size = { width, height, dpr };
      if (!ready) return;
      applySize();
      render();
    },
    setPointer(x, y) {
      if (disposed || !active) return;
      tgtX = Math.max(-1, Math.min(1, x));
      tgtY = Math.max(-1, Math.min(1, y));
      startLoop();
    },
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (!active) {
        stopLoop();
        return;
      }
      render();
      startLoop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLoop();
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const d of disposables) d.dispose();
      renderer?.dispose();
    },
  };
}
