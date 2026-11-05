import * as THREE from 'three';
import { buildSilhouetteGeometry } from './silhouette';

const edgeCount = (geometry: THREE.BufferGeometry) => geometry.getAttribute('position').count / 2;

describe('silhouette edges', () => {
  it('a cylinder gets one smooth edge per side segment (the rims are sharp: EdgesGeometry draws those)', () => {
    const cylinder = new THREE.CylinderGeometry(5, 5, 20, 32).toNonIndexed(); // STL files are not indexed either
    expect(edgeCount(buildSilhouetteGeometry(cylinder))).toBe(32);
  });

  it('a box has none: its edges are sharp or flat', () => {
    expect(edgeCount(buildSilhouetteGeometry(new THREE.BoxGeometry(10, 10, 10).toNonIndexed()))).toBe(0);
  });

  it('keeps both triangle normals and the edge middle for the shader', () => {
    const geometry = buildSilhouetteGeometry(new THREE.CylinderGeometry(5, 5, 20, 24).toNonIndexed());
    for (const name of ['mid', 'n1', 'n2']) expect(geometry.getAttribute(name).count).toBe(geometry.getAttribute('position').count);
    const n1 = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('n1') as THREE.BufferAttribute, 0);
    const n2 = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('n2') as THREE.BufferAttribute, 0);
    expect(n1.length()).toBeCloseTo(1);
    expect(THREE.MathUtils.radToDeg(n1.angleTo(n2))).toBeCloseTo(15, 0); // 24 segments: 15 degrees between neighbours
  });

  it('crease angle decides: a coarse cylinder (8 segments, 45 degrees) has no smooth edges below 25', () => {
    expect(edgeCount(buildSilhouetteGeometry(new THREE.CylinderGeometry(5, 5, 20, 8).toNonIndexed()))).toBe(0);
  });
});
