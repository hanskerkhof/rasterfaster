import * as THREE from 'three';
import { buildParts, clearParts } from './model-render';

const style = () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1).toNonIndexed(); // like an STL: no index
  return { geometry, style: { background: new THREE.Color(0), solid: 0xcccccc, line: 0xffffff, wire: 0xffffff, dashed: 0x888888, radius: 10, edges: () => new THREE.EdgesGeometry(geometry) } };
};

describe('shaded view', () => {
  it('smooths a copy and leaves the geometry itself alone', () => {
    const { geometry, style: s } = style();
    const before = Array.from(geometry.getAttribute('normal').array);
    const parts = buildParts(geometry, 'shaded', s);
    const mesh = parts[0] as THREE.Mesh;
    expect(mesh.geometry).not.toBe(geometry);
    expect(Array.from(geometry.getAttribute('normal').array)).toEqual(before);
    expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
  });

  it('disposing the geometry (reload!) does not recurse', () => {
    const { geometry, style: s } = style();
    const group = new THREE.Group();
    group.add(...buildParts(geometry, 'shaded', s));
    expect(() => geometry.dispose()).not.toThrow();
    clearParts(group);
  });
});
