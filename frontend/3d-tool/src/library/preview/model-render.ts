import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { silhouetteEdges, silhouetteParts } from './silhouette';

export type ViewMode = 'solid' | 'solid-outline' | 'shaded' | 'wireframe' | 'hidden-removed' | 'hidden-shown';

export interface PartStyle {
  background: THREE.Color;
  solid: number;
  line: number;
  wire: number;
  dashed: number;
  /** Rough object radius (mm); scales the dashes of hidden lines. */
  radius: number;
  /** Lazily provides the (expensive) feature-edge geometry for the hidden-line modes. */
  edges: () => THREE.EdgesGeometry;
  /** Lazily provides the silhouette edges (see silhouette.ts); without it (or with the setting off) no silhouette lines are drawn. */
  silhouette?: () => THREE.BufferGeometry;
  /** Draw as a barely visible ghost that doesn't hide what is behind it. */
  ghost?: boolean;
  /** Render mode's finish of the part (only the solid and shaded views show it; none or satin is the plain PLA look). */
  finish?: 'satin' | 'metal' | 'glass' | 'mirror' | 'pei' | null;
  /** The reflections metal, glass and mirror need. */
  environment?: THREE.Texture | null;
}

/** The look of a finish: the material of the solid and shaded views. Satin (none) is the plain PLA look the views always had. */
function finishMaterial(style: PartStyle, fallback: () => THREE.Material): THREE.Material {
  const base = { color: style.solid, envMap: style.environment ?? null };
  switch (style.finish) {
    case 'metal': return new THREE.MeshPhysicalMaterial({ ...base, metalness: 1, roughness: 0.3 });
    case 'mirror': return new THREE.MeshPhysicalMaterial({ ...base, color: new THREE.Color(style.solid).lerp(new THREE.Color(0xffffff), 0.75), metalness: 1, roughness: 0.02, envMapIntensity: 1.3 });
    case 'pei': return new THREE.MeshStandardMaterial({ color: style.solid, roughness: 0.82, metalness: 0, flatShading: true }); // a dull powder-coated plate (the grain itself is in the Blender render)
    case 'glass': return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false, envMapIntensity: 1, side: THREE.DoubleSide });
    default: return fallback();
  }
}

/** The outline of the solid-with-outline mode: dark, to stand out on the light grey parts. */
const outlineColor = 0x15181f;

export const previewStyle = { solid: 0xc9ced8, line: 0xe8ecf4, wire: 0x7fd1ff, dashed: 0x6f7a8c };

/** Smooth-shaded copies of geometries (curved walls look round, sharp edges stay sharp: normals are shared below 35°), one per original. */
const creased = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
function creasedCopy(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  let copy = creased.get(geometry);
  if (!copy) {
    // a clone: toCreasedNormals hands back the very geometry it is given when that has no index (an STL), and changes it
    copy = toCreasedNormals(geometry.clone(), THREE.MathUtils.degToRad(35));
    creased.set(geometry, copy);
    geometry.addEventListener('dispose', () => { creased.delete(geometry); if (copy && copy !== geometry) copy.dispose(); });
  }
  return copy;
}

/** Builds the meshes/lines that draw one geometry in the given view mode. Geometry is shared, materials are new. */
export function buildParts(geometry: THREE.BufferGeometry, mode: ViewMode, style: PartStyle): THREE.Object3D[] {
  if (style.ghost) return buildGhostParts(geometry, mode, style);
  if (mode === 'solid') {
    return [new THREE.Mesh(geometry, finishMaterial(style, () => new THREE.MeshStandardMaterial({ color: style.solid, roughness: 0.6, metalness: 0.1, flatShading: true })))];
  }
  if (mode === 'shaded') { // a glossy material, smooth normals, and it casts and receives the shadows of the light source (see the viewer)
    const mesh = new THREE.Mesh(creasedCopy(geometry), finishMaterial(style, () => new THREE.MeshPhysicalMaterial({ color: style.solid, roughness: 0.38, metalness: 0.12, clearcoat: 0.3, clearcoatRoughness: 0.35 })));
    mesh.castShadow = style.finish !== 'glass'; // a transparent part lets the light of the lamp through (no shadow of its own)
    mesh.receiveShadow = true;
    return [mesh];
  }
  if (mode === 'solid-outline') { // the shaded part with its visible edges drawn over it (the fill hides the edges behind it)
    const parts: THREE.Object3D[] = [
      new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: style.solid, roughness: 0.6, metalness: 0.1, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })),
      new THREE.LineSegments(style.edges(), new THREE.LineBasicMaterial({ color: outlineColor })),
    ];
    if (style.silhouette && silhouetteEdges()) parts.push(...silhouetteParts(style.silhouette(), 'hidden-removed', { line: outlineColor, dashed: style.dashed }));
    return parts;
  }
  if (mode === 'wireframe') {
    return [new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: style.wire, wireframe: true }))];
  }
  const edges = style.edges();
  // The fill writes depth only in the background colour so hidden edges can be told apart from visible ones.
  const parts: THREE.Object3D[] = [
    new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: style.background, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })),
    new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: style.line })),
  ];
  if (mode === 'hidden-shown') {
    const dashed = new THREE.LineSegments(edges, new THREE.LineDashedMaterial({
      color: style.dashed, dashSize: style.radius / 60, gapSize: style.radius / 80, depthFunc: THREE.GreaterDepth,
    }));
    dashed.computeLineDistances();
    parts.push(dashed);
  }
  if (style.silhouette && silhouetteEdges()) parts.push(...silhouetteParts(style.silhouette(), mode, { line: style.line, dashed: style.dashed })); // the contour of smooth walls
  return parts;
}

const ghostOpacity = 0.09;

/** Muted look: no depth writes, so nothing behind a ghost is hidden by it. */
function buildGhostParts(geometry: THREE.BufferGeometry, mode: ViewMode, style: PartStyle): THREE.Object3D[] {
  if (mode === 'solid' || mode === 'solid-outline' || mode === 'shaded') {
    return [new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: style.solid, roughness: 0.6, metalness: 0.1, flatShading: true, transparent: true, opacity: ghostOpacity, depthWrite: false }))];
  }
  if (mode === 'wireframe') {
    return [new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: style.wire, wireframe: true, transparent: true, opacity: ghostOpacity * 1.5, depthWrite: false }))];
  }
  // Hidden-line modes: the ghost's own back edges are hidden by a depth-only fill (no colour). The ghost is drawn after everything else
  // (transparent pass, renderOrder), so that fill only hides edges drawn later, i.e. this ghost's own back edges: what is behind the ghost
  // is already in the picture and stays visible. Each ghost gets its own pair of orders so ghosts don't hide each other's edges.
  const order = nextGhostOrder();
  const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  fill.renderOrder = order;
  const edges = style.edges();
  const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: style.line, transparent: true, opacity: ghostOpacity * 2, depthWrite: false }));
  lines.renderOrder = order + 0.001;
  const parts: THREE.Object3D[] = [fill, lines];
  if (mode === 'hidden-shown') {
    const dashed = new THREE.LineSegments(edges, new THREE.LineDashedMaterial({
      color: style.dashed, dashSize: style.radius / 60, gapSize: style.radius / 80, depthFunc: THREE.GreaterDepth, transparent: true, opacity: ghostOpacity * 2, depthWrite: false,
    }));
    dashed.computeLineDistances();
    dashed.renderOrder = order + 0.001;
    parts.push(dashed);
  }
  if (style.silhouette && silhouetteEdges()) parts.push(...silhouetteParts(style.silhouette(), mode, { line: style.line, dashed: style.dashed, ghost: { opacity: ghostOpacity * 2, order } }));
  return parts;
}

let ghostCounter = 0;

/** Draw order for one ghost's fill (the edges come right after): between 1 and 3, above plain ghosts and below the selection gizmos. */
function nextGhostOrder() {
  ghostCounter = (ghostCounter + 1) % 1000;
  return 1 + ghostCounter * 0.002;
}

/** Disposes the materials of everything in `group` and empties it; geometries are shared and stay alive. */
export function clearParts(group: THREE.Object3D) {
  group.traverse(o => {
    if ((o as { isReflector?: boolean }).isReflector) (o as unknown as { dispose(): void }).dispose(); // a mirror's reflection has its own render target
    const material = (o as THREE.Mesh).material;
    if (material) (Array.isArray(material) ? material : [material]).forEach(m => m.dispose());
  });
  group.clear();
}
