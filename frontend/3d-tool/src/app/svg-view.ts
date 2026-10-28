import * as THREE from 'three';

/** One part of the drawing: its (oriented) geometry, where it sits, and the line geometry that is drawn for it. */
export interface ViewPart {
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  /** The sharp edges (EdgesGeometry). */
  edges: THREE.BufferGeometry;
  /** The smooth edges with the attributes `n1` and `n2` (see silhouette.ts): drawn only where they are the contour seen from the camera. */
  silhouette?: THREE.BufferGeometry;
  /** Every triangle edge once (see `buildWireGeometry`), for the wireframe drawing. */
  wire?: THREE.BufferGeometry;
}

export type SvgMode = 'solid' | 'wireframe' | 'hidden-removed' | 'hidden-shown';

export interface ViewSvgOptions {
  /** The display mode to follow: hidden lines removed (default), dashed hidden lines, wireframe (all triangle edges). Solid is a picture: see `buildImageSvg`. */
  mode?: Exclude<SvgMode, 'solid'>;
  /** The ground grid (line segments in world coordinates), drawn light grey behind the model; parts hide what is behind them (not in wireframe). */
  grid?: THREE.BufferGeometry | null;
  /** Pixels of the longer side of the depth picture the lines are tested against (and so of the drawing's coordinates). */
  resolution?: number;
  title?: string;
}

const margin = 16;

/**
 * A vector drawing of what the camera sees, with hidden lines removed: the visible parts of the sharp edges and of the contour lines are
 * written as SVG paths. Which part of an edge is visible is decided against a depth picture of the solids rendered with the same camera
 * (one sample per pixel along every edge), so the drawing matches the hidden-lines view of the program. Black lines on white; the
 * drawing is cropped to what is drawn.
 */
export function buildViewSvg(renderer: THREE.WebGLRenderer, camera: THREE.Camera, aspect: number, parts: ViewPart[], options: ViewSvgOptions = {}): string {
  const long = options.resolution ?? 2400;
  const width = aspect >= 1 ? long : Math.round(long * aspect);
  const height = aspect >= 1 ? Math.round(long / aspect) : long;
  const mode = options.mode ?? 'hidden-removed';
  const depth = mode === 'wireframe' ? new Float32Array(0) : renderDepth(renderer, camera, parts, width, height);

  camera.updateMatrixWorld();
  const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
  const near = (camera as THREE.PerspectiveCamera).near, far = (camera as THREE.PerspectiveCamera).far;
  /** Distance along the view axis for a depth in [0, 1] (the depth buffer's value). */
  const linear = (d: number) => {
    const ndc = d * 2 - 1;
    return ortho ? near + ((ndc + 1) / 2) * (far - near) : (2 * near * far) / (far + near - ndc * (far - near));
  };
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const forward = camera.getWorldDirection(new THREE.Vector3());

  const paths: string[] = [], hiddenPaths: string[] = [], gridPaths: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const a = new THREE.Vector4(), b = new THREE.Vector4();
  const world = new THREE.Vector3(), toEye = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3();

  const emit = (into: string[], x0: number, y0: number, x1: number, y1: number) => {
    into.push(`M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`);
    minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1); minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
  };

  /** Wireframe: every edge, nothing hidden; clipped to the picture. */
  const drawFlat = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, ox: number, oy: number, oz: number, into = paths) => {
    a.set(ax + ox, ay + oy, az + oz, 1).applyMatrix4(viewProjection);
    b.set(bx + ox, by + oy, bz + oz, 1).applyMatrix4(viewProjection);
    if (a.w <= 1e-6 || b.w <= 1e-6) return;
    let x0 = a.x / a.w, y0 = a.y / a.w, x1 = b.x / b.w, y1 = b.y / b.w;
    if ((x0 < -1 && x1 < -1) || (x0 > 1 && x1 > 1) || (y0 < -1 && y1 < -1) || (y0 > 1 && y1 > 1)) return;
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    for (const [pp, q] of [[-dx, x0 + 1], [dx, 1 - x0], [-dy, y0 + 1], [dy, 1 - y0]] as const) {
      if (pp === 0) { if (q < 0) return; continue; }
      const t = q / pp;
      if (pp < 0) { if (t > t1) return; if (t > t0) t0 = t; } else { if (t < t0) return; if (t < t1) t1 = t; }
    }
    [x0, y0, x1, y1] = [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1];
    emit(into, (x0 * 0.5 + 0.5) * width, (1 - (y0 * 0.5 + 0.5)) * height, (x1 * 0.5 + 0.5) * width, (1 - (y1 * 0.5 + 0.5)) * height);
  };

  /** Hidden lines: every pixel along the edge is tested against the depth picture; visible runs go to `paths`, hidden runs (dashed mode) to `hiddenPaths`. */
  const drawSegment = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, ox: number, oy: number, oz: number,
                       into = paths, hiddenInto: string[] | null = mode === 'hidden-shown' ? hiddenPaths : null) => {
    a.set(ax + ox, ay + oy, az + oz, 1).applyMatrix4(viewProjection);
    b.set(bx + ox, by + oy, bz + oz, 1).applyMatrix4(viewProjection);
    if (a.w <= 1e-6 || b.w <= 1e-6) return; // behind the camera: not drawn
    const ax0 = a.x / a.w, ay0 = a.y / a.w, bx0 = b.x / b.w, by0 = b.y / b.w;
    // a segment wholly outside the picture has nothing to draw
    if ((ax0 < -1 && bx0 < -1) || (ax0 > 1 && bx0 > 1) || (ay0 < -1 && by0 < -1) || (ay0 > 1 && by0 > 1)) return;
    const length = Math.hypot((bx0 - ax0) * width / 2, (by0 - ay0) * height / 2);
    const steps = Math.min(4000, Math.max(1, Math.ceil(length)));
    let state: 'visible' | 'hidden' | null = null, runStart: [number, number] = [0, 0], last: [number, number] = [0, 0];
    const flush = () => {
      if (state === 'visible') emit(into, runStart[0], runStart[1], last[0], last[1]);
      else if (state === 'hidden' && hiddenInto) emit(hiddenInto, runStart[0], runStart[1], last[0], last[1]);
      state = null;
    };
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const w = a.w + (b.w - a.w) * t; // clip coordinates are linear in the world, so this is the right point on the edge
      const nx = (a.x + (b.x - a.x) * t) / w, ny = (a.y + (b.y - a.y) * t) / w, nz = (a.z + (b.z - a.z) * t) / w;
      const px = (nx * 0.5 + 0.5) * width, py = (1 - (ny * 0.5 + 0.5)) * height;
      let now: 'visible' | 'hidden' | null = null;
      if (nz >= -1 && nz <= 1 && px >= 0 && px < width && py >= 0 && py < height) {
        const column = Math.min(width - 1, Math.floor(px)), row = Math.min(height - 1, Math.floor(height - py)); // the picture's rows start at the bottom
        const stored = 1 - depth[(row * width + column) * 4]; // MeshDepthMaterial writes 1 - depth; nothing drawn there = far
        const seen = linear(nz * 0.5 + 0.5), blocker = linear(Math.min(1, Math.max(0, stored)));
        now = seen <= blocker + 0.25 + 0.0012 * blocker ? 'visible' : 'hidden'; // the edges lie on the faces that made the picture: a little room
      }
      if (now !== state) { flush(); state = now; runStart = [px, py]; }
      if (now) last = [px, py];
    }
    flush();
  };

  if (options.grid) {
    const g = options.grid.getAttribute('position');
    for (let i = 0; i + 1 < g.count; i += 2) {
      if (mode === 'wireframe') drawFlat(g.getX(i), g.getY(i), g.getZ(i), g.getX(i + 1), g.getY(i + 1), g.getZ(i + 1), 0, 0, 0, gridPaths);
      else drawSegment(g.getX(i), g.getY(i), g.getZ(i), g.getX(i + 1), g.getY(i + 1), g.getZ(i + 1), 0, 0, 0, gridPaths, null);
    }
  }

  for (const part of parts) {
    const { x: ox, y: oy, z: oz } = part.position;
    if (mode === 'wireframe') {
      const w = (part.wire ?? part.edges).getAttribute('position');
      for (let i = 0; i + 1 < w.count; i += 2) drawFlat(w.getX(i), w.getY(i), w.getZ(i), w.getX(i + 1), w.getY(i + 1), w.getZ(i + 1), ox, oy, oz);
      continue;
    }
    const e = part.edges.getAttribute('position');
    for (let i = 0; i + 1 < e.count; i += 2) drawSegment(e.getX(i), e.getY(i), e.getZ(i), e.getX(i + 1), e.getY(i + 1), e.getZ(i + 1), ox, oy, oz);
    const s = part.silhouette;
    if (!s) continue;
    const sp = s.getAttribute('position'), mid = s.getAttribute('mid'), na = s.getAttribute('n1'), nb = s.getAttribute('n2');
    for (let i = 0; i + 1 < sp.count; i += 2) {
      if (ortho) toEye.copy(forward).negate();
      else toEye.copy(eye).sub(world.set(mid.getX(i) + ox, mid.getY(i) + oy, mid.getZ(i) + oz));
      n1.set(na.getX(i), na.getY(i), na.getZ(i));
      n2.set(nb.getX(i), nb.getY(i), nb.getZ(i));
      if (n1.dot(toEye) * n2.dot(toEye) >= 0) continue; // both faces look the same way: not the contour from here
      drawSegment(sp.getX(i), sp.getY(i), sp.getZ(i), sp.getX(i + 1), sp.getY(i + 1), sp.getZ(i + 1), ox, oy, oz);
    }
  }

  if (!paths.length && !gridPaths.length) minX = minY = 0, maxX = width, maxY = height;
  const x0 = Math.floor(minX - margin), y0 = Math.floor(minY - margin);
  const w = Math.ceil(maxX - minX + 2 * margin), h = Math.ceil(maxY - minY + 2 * margin);
  const title = (options.title ?? 'View').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  const gridPath = gridPaths.length ? `<path d="${gridPaths.join('')}" fill="none" stroke="#c3c7cf" stroke-width="0.7"/>\n` : '';
  const hidden = hiddenPaths.length ? `<path d="${hiddenPaths.join('')}" fill="none" stroke="#8a8f99" stroke-width="1" stroke-dasharray="9 6" stroke-linecap="butt"/>\n` : '';
  const stroke = mode === 'wireframe' ? 0.7 : 1.4;
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}">\n`
    + `<title>${title}</title>\n<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fff"/>\n`
    + gridPath + hidden
    + `<path d="${paths.join('')}" fill="none" stroke="#000" stroke-width="${stroke}" stroke-linecap="round"/>\n</svg>\n`;
}

/** Every triangle edge once (STL files repeat every vertex per triangle, so vertices are welded by position first). */
export function buildWireGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = source.getAttribute('position') as THREE.BufferAttribute;
  const index = source.getIndex();
  const count = (index ? index.count : position.count) / 3;
  const ids = new Map<string, number>();
  const points: number[] = [];
  const idOf = (i: number) => {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); points.push(x, y, z); }
    return id;
  };
  const seen = new Set<number>();
  const lines: number[] = [];
  for (let t = 0; t < count; t++) {
    const corner = [0, 1, 2].map(k => idOf(index ? index.getX(t * 3 + k) : t * 3 + k));
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const lo = Math.min(corner[i], corner[j]), hi = Math.max(corner[i], corner[j]);
      if (lo === hi || seen.has(lo * 4294967296 + hi)) continue;
      seen.add(lo * 4294967296 + hi);
      lines.push(points[lo * 3], points[lo * 3 + 1], points[lo * 3 + 2], points[hi * 3], points[hi * 3 + 1], points[hi * 3 + 2]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  return geometry;
}

/**
 * The shaded (solid) view as a picture inside an SVG: rendering the surfaces as vectors would need millions of polygons. `scene` is
 * rendered with the camera on a white background; the caller hides what is not part of the model (grid, gizmos).
 */
export function buildImageSvg(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, aspect: number, options: { resolution?: number; title?: string } = {}): string {
  const long = options.resolution ?? 2400;
  const width = aspect >= 1 ? long : Math.round(long * aspect);
  const height = aspect >= 1 ? Math.round(long / aspect) : long;
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, samples: 4, colorSpace: THREE.SRGBColorSpace });
  const previousTarget = renderer.getRenderTarget(), previousBackground = scene.background;
  const previousColor = renderer.getClearColor(new THREE.Color()), previousAlpha = renderer.getClearAlpha();
  const pixels = new Uint8Array(width * height * 4);
  try {
    scene.background = new THREE.Color(0xffffff);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    scene.background = previousBackground;
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const image = new ImageData(width, height);
  for (let row = 0; row < height; row++) image.data.set(pixels.subarray((height - 1 - row) * width * 4, (height - row) * width * 4), row * width * 4); // rows start at the bottom
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const title = (options.title ?? 'View').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
    + `<title>${title}</title>\n<image width="${width}" height="${height}" xlink:href="${canvas.toDataURL('image/png')}"/>\n</svg>\n`;
}

/** The solids as seen by the camera: the red channel holds 1 - depth (nothing drawn: 0). Rows start at the bottom. */
function renderDepth(renderer: THREE.WebGLRenderer, camera: THREE.Camera, parts: ViewPart[], width: number, height: number): Float32Array {
  const scene = new THREE.Scene();
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
  for (const part of parts) {
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.position.copy(part.position);
    scene.add(mesh);
  }
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color()), previousAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return pixels;
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
    material.dispose();
  }
}
