import { signal } from '@angular/core';
import * as THREE from 'three';
import type { ViewMode } from './model-render';

/**
 * Silhouette edges for the hidden-line views. EdgesGeometry only draws edges where two triangles meet at a sharp angle, so the smooth wall of
 * a cylinder, cone or any rounded part got no side lines. This file adds those: every edge between two triangles that bend only a little is
 * stored with both triangle normals, and a vertex shader draws it only while one of the two triangles faces the camera and the other faces
 * away (the contour of the shape as seen from here), so it follows the camera for free.
 *
 * It is self-contained: the setting below switches it on and off (view cube menu), and model-render.ts only asks for `silhouetteParts`.
 */

const storageKey = 'rasterfaster.silhouetteEdges';

function readSetting() {
  try { return localStorage.getItem(storageKey) !== 'false'; } catch { return true; } // default on
}

/** Draw silhouette edges in the hidden-line views (the fix for cylinders without side lines). */
export const silhouetteEdges = signal(readSetting());

export function setSilhouetteEdges(on: boolean) {
  silhouetteEdges.set(on);
  try { localStorage.setItem(storageKey, String(on)); } catch { /* storage unavailable */ }
}

/** Edges that bend less than this are "smooth" (EdgesGeometry draws the sharper ones, see the call sites). */
export const creaseDegrees = 25;
/** Edges that bend less than this are flat triangulation lines: they can never be a silhouette, so they are left out. */
const flatDegrees = 0.5;

/**
 * The smooth edges of `source` (bending between `flatDegrees` and `creaseDegrees`) as line segments with the attributes the shader needs:
 * `mid` (the edge's middle, so both ends decide the same way), `n1` and `n2` (the normals of the two triangles).
 */
export function buildSilhouetteGeometry(source: THREE.BufferGeometry, crease = creaseDegrees): THREE.BufferGeometry {
  const position = source.getAttribute('position') as THREE.BufferAttribute;
  const index = source.getIndex();
  const triangleCount = (index ? index.count : position.count) / 3;
  const corner = (triangle: number, k: number) => (index ? index.getX(triangle * 3 + k) : triangle * 3 + k);

  // weld vertices by position (STL files repeat every vertex per triangle)
  const welded = new Map<string, number>();
  const points: THREE.Vector3[] = [];
  const idOf = (source: number) => {
    const x = position.getX(source), y = position.getY(source), z = position.getZ(source);
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let id = welded.get(key);
    if (id === undefined) { id = points.length; welded.set(key, id); points.push(new THREE.Vector3(x, y, z)); }
    return id;
  };

  const normals: (THREE.Vector3 | null)[] = [];
  const edgeFaces = new Map<number, number[]>(); // a * count + b (a < b) -> triangles sharing it
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t++) {
    const ids = [idOf(corner(t, 0)), idOf(corner(t, 1)), idOf(corner(t, 2))];
    a.copy(points[ids[0]]); b.copy(points[ids[1]]); c.copy(points[ids[2]]);
    const normal = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a));
    normals.push(normal.lengthSq() > 1e-18 ? normal.normalize() : null); // degenerate triangles have no direction
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const lo = Math.min(ids[i], ids[j]), hi = Math.max(ids[i], ids[j]);
      if (lo === hi) continue;
      const key = lo * 4294967296 + hi;
      const faces = edgeFaces.get(key);
      if (faces) faces.push(t); else edgeFaces.set(key, [t]);
    }
  }

  const cosCrease = Math.cos(THREE.MathUtils.degToRad(crease));
  const cosFlat = Math.cos(THREE.MathUtils.degToRad(flatDegrees));
  const positions: number[] = [], mids: number[] = [], n1s: number[] = [], n2s: number[] = [];
  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 2) continue; // open or non-manifold edges are not silhouettes
    const n1 = normals[faces[0]], n2 = normals[faces[1]];
    if (!n1 || !n2) continue;
    const dot = n1.dot(n2);
    if (dot > cosFlat || dot <= cosCrease) continue; // flat (never a silhouette) or sharp (EdgesGeometry draws it)
    const p = points[Math.floor(key / 4294967296)], q = points[key % 4294967296];
    positions.push(p.x, p.y, p.z, q.x, q.y, q.z);
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, mz = (p.z + q.z) / 2;
    mids.push(mx, my, mz, mx, my, mz);
    n1s.push(n1.x, n1.y, n1.z, n1.x, n1.y, n1.z);
    n2s.push(n2.x, n2.y, n2.z, n2.x, n2.y, n2.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('mid', new THREE.Float32BufferAttribute(mids, 3));
  geometry.setAttribute('n1', new THREE.Float32BufferAttribute(n1s, 3));
  geometry.setAttribute('n2', new THREE.Float32BufferAttribute(n2s, 3));
  return geometry;
}

const vertexShader = /* glsl */ `
  attribute vec3 mid;
  attribute vec3 n1;
  attribute vec3 n2;
  void main() {
    vec3 midWorld = (modelMatrix * vec4(mid, 1.0)).xyz;
    // direction towards the camera: constant for the orthographic camera, per edge for the perspective one
    vec3 toCamera = projectionMatrix[3][3] == 1.0
      ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
      : normalize(cameraPosition - midWorld);
    mat3 rotation = mat3(modelMatrix);
    if (dot(rotation * n1, toCamera) * dot(rotation * n2, toCamera) < 0.0) {
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    } else {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not a contour from here: outside the view, so nothing is drawn
    }
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(color, opacity);
    #include <colorspace_fragment>
  }
`;

function material(color: number, options: { opacity?: number; hidden?: boolean }) {
  const ghost = options.opacity !== undefined;
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: options.opacity ?? 1 } },
    vertexShader,
    fragmentShader,
    transparent: ghost,
    depthWrite: !ghost && !options.hidden ? true : false,
    depthFunc: options.hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
  });
}

export interface SilhouetteStyle {
  line: number;
  dashed: number;
  /** Set for a dimmed (ghost) part: the faint opacity of its lines and the draw order of its fill. */
  ghost?: { opacity: number; order: number };
}

/**
 * The silhouette lines for one part in the given hidden-line mode: the visible contour in the line colour and, in "hidden dashed", the
 * contour that is hidden behind the part in the dashed colour (drawn solid: the shader cannot dash).
 */
export function silhouetteParts(geometry: THREE.BufferGeometry, mode: ViewMode, style: SilhouetteStyle): THREE.Object3D[] {
  if (mode !== 'hidden-removed' && mode !== 'hidden-shown') return [];
  const opacity = style.ghost?.opacity;
  const parts = [new THREE.LineSegments(geometry, material(style.line, { opacity }))];
  if (mode === 'hidden-shown') parts.push(new THREE.LineSegments(geometry, material(style.dashed, { opacity, hidden: true })));
  if (style.ghost) for (const part of parts) part.renderOrder = style.ghost.order + 0.001;
  return parts;
}
