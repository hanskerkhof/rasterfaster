import * as THREE from 'three';

export type ViewMode = 'solid' | 'wireframe' | 'hidden-removed' | 'hidden-shown';

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
  /** Draw as a barely visible ghost that doesn't hide what is behind it. */
  ghost?: boolean;
}

export const previewStyle = { solid: 0xc9ced8, line: 0xe8ecf4, wire: 0x7fd1ff, dashed: 0x6f7a8c };

/** Builds the meshes/lines that draw one geometry in the given view mode. Geometry is shared, materials are new. */
export function buildParts(geometry: THREE.BufferGeometry, mode: ViewMode, style: PartStyle): THREE.Object3D[] {
  if (style.ghost) return buildGhostParts(geometry, mode, style);
  if (mode === 'solid') {
    return [new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: style.solid, roughness: 0.6, metalness: 0.1, flatShading: true }))];
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
  return parts;
}

const ghostOpacity = 0.09;

/** Muted look: no depth writes, so nothing behind a ghost is hidden by it. */
function buildGhostParts(geometry: THREE.BufferGeometry, mode: ViewMode, style: PartStyle): THREE.Object3D[] {
  if (mode === 'solid') {
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
    const material = (o as THREE.Mesh).material;
    if (material) (Array.isArray(material) ? material : [material]).forEach(m => m.dispose());
  });
  group.clear();
}
