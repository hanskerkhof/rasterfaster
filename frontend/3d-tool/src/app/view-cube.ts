import * as THREE from 'three';

const cubeSize = 150; // CSS px
const cubeMargin = 12;
const edgeZone = 0.62; // |coordinate| beyond this on an axis counts as "that side" of the cube

const faceLabels: Record<string, string> = { '0,0,1': 'TOP', '0,0,-1': 'BOTTOM', '0,-1,0': 'FRONT', '0,1,0': 'BACK', '1,0,0': 'RIGHT', '-1,0,0': 'LEFT' };

function faceTexture(label: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d5d9e2';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#2a2e38';
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Fusion/Bambu-style navigation cube drawn in the top-right corner of the main canvas.
 * Hover highlights a face, edge or corner; click snaps the view there; drag orbits the model.
 */
export class ViewCube {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-2.4, 2.4, 2.4, -2.4, 0.1, 20);
  private readonly cube: THREE.Mesh;
  private readonly highlight: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private hovered: THREE.Vector3 | null = null;
  private dragStart: { x: number; y: number; lastX: number; lastY: number; moved: boolean } | null = null;
  private readonly listeners: [string, EventListener][] = [];

  /** `snap` gets the unit direction from the model towards the camera; `orbit` gets pointer deltas in px. */
  constructor(private readonly canvas: HTMLCanvasElement, private readonly snap: (direction: THREE.Vector3) => void, private readonly orbit: (dx: number, dy: number) => void, private readonly contextMenu: (clientX: number, clientY: number) => void = () => undefined, private readonly dragStarted: () => void = () => undefined) {
    const order = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; // BoxGeometry face order
    const materials = order.map(n => new THREE.MeshBasicMaterial({ map: faceTexture(faceLabels[n.join(',')]) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
    this.cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x5b6272 })));
    this.scene.add(this.cube);
    this.highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x2f6fed, transparent: true, opacity: 0.75, depthTest: false }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 1;
    this.scene.add(this.highlight);

    this.addAxisTriad();

    this.on('pointerdown', e => this.onDown(e));
    this.on('pointermove', e => this.onMove(e));
    this.on('pointerup', e => this.onUp(e));
    this.on('contextmenu', e => {
      if (!this.inside(e as PointerEvent)) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // not the document's object menu behind the cube
      this.contextMenu(e.clientX, e.clientY);
    });
    this.on('pointerleave', () => { if (!this.dragStart) this.setHover(null); });
  }

  /** Red X / green Y / blue Z arrows from the cube's (-1,-1,-1) corner, drawn over the cube. */
  private addAxisTriad() {
    const axes: [string, THREE.Vector3, number][] = [['x', new THREE.Vector3(1, 0, 0), 0xc9605e], ['y', new THREE.Vector3(0, 1, 0), 0x6fb56f], ['z', new THREE.Vector3(0, 0, 1), 0x7b7fd6]];
    const origin = new THREE.Vector3(-1, -1, -1);
    const length = 2.7;
    for (const [name, direction, color] of axes) {
      const material = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, length - 0.3, 8), material);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 12), material);
      const arrow = new THREE.Group();
      shaft.position.y = (length - 0.3) / 2;
      tip.position.y = length - 0.15;
      arrow.add(shaft, tip);
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      arrow.position.copy(origin);
      arrow.renderOrder = 2;
      arrow.traverse(o => (o.renderOrder = 2));
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#' + color.toString(16).padStart(6, '0');
      g.font = '600 44px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name, 32, 34);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      label.scale.setScalar(0.55);
      label.position.copy(origin).addScaledVector(direction, length + 0.25);
      label.renderOrder = 3;
      this.scene.add(arrow, label);
    }
  }

  /** Registers on the canvas; must be created before OrbitControls so it can swallow pointerdown. */
  private on(type: string, fn: (e: PointerEvent) => void) {
    const listener = fn as EventListener;
    this.canvas.addEventListener(type, listener);
    this.listeners.push([type, listener]);
  }

  /** Cube rectangle in canvas CSS px. */
  private rect() {
    const left = this.canvas.clientWidth - cubeSize - cubeMargin;
    return { left, top: cubeMargin, size: cubeSize };
  }

  private local(e: PointerEvent) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private inside(e: PointerEvent) {
    const { x, y } = this.local(e);
    const r = this.rect();
    return x >= r.left && x <= r.left + r.size && y >= r.top && y <= r.top + r.size;
  }

  /** Face/edge/corner under the pointer as a direction vector, or null. */
  private pick(e: PointerEvent): THREE.Vector3 | null {
    if (!this.inside(e)) return null;
    const { x, y } = this.local(e);
    const r = this.rect();
    const ndc = new THREE.Vector2(((x - r.left) / r.size) * 2 - 1, -(((y - r.top) / r.size) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const side = (v: number) => (Math.abs(v) > edgeZone ? Math.sign(v) : 0);
    return new THREE.Vector3(side(p.x), side(p.y), side(p.z));
  }

  private setHover(direction: THREE.Vector3 | null) {
    if (direction?.equals(this.hovered ?? new THREE.Vector3(NaN)) ) return;
    this.hovered = direction;
    this.canvas.style.cursor = direction ? 'pointer' : '';
    this.highlight.visible = !!direction;
    if (!direction) return;
    const axis = (d: number) => (d === 0 ? { size: edgeZone * 2, at: 0 } : { size: 0.4, at: d * 0.85 });
    const [x, y, z] = [axis(direction.x), axis(direction.y), axis(direction.z)];
    this.highlight.scale.set(x.size, y.size, z.size);
    this.highlight.position.set(x.at, y.at, z.at);
  }

  private onDown(e: PointerEvent) {
    if (!this.inside(e)) return;
    e.stopImmediatePropagation(); // keep OrbitControls out of it
    if (e.button !== 0) return; // right-click opens the cube's menu instead of snapping the view
    this.dragStarted(); // the view may want to pick its pivot before it turns
    const { x, y } = this.local(e);
    this.dragStart = { x, y, lastX: x, lastY: y, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.dragStart) { this.setHover(this.pick(e)); return; }
    const { x, y } = this.local(e);
    const d = this.dragStart;
    if (!d.moved && Math.hypot(x - d.x, y - d.y) > 4) d.moved = true;
    if (d.moved) { this.orbit(x - d.lastX, y - d.lastY); this.setHover(null); }
    d.lastX = x; d.lastY = y;
  }

  private onUp(e: PointerEvent) {
    const d = this.dragStart;
    if (!d) return;
    this.dragStart = null;
    this.canvas.releasePointerCapture(e.pointerId);
    if (!d.moved) { const direction = this.pick(e); if (direction) this.snap(direction.clone().normalize()); }
    this.setHover(this.pick(e));
  }

  /** Draws the cube in the top-right corner, oriented like the main camera. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera, target: THREE.Vector3) {
    const offset = mainCamera.position.clone().sub(target).normalize().multiplyScalar(8);
    this.camera.up.copy(mainCamera.up);
    this.camera.position.copy(offset);
    this.camera.lookAt(0, 0, 0);
    const r = this.rect();
    const h = this.canvas.clientHeight;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setViewport(r.left, h - r.top - r.size, r.size, r.size);
    renderer.setScissor(r.left, h - r.top - r.size, r.size, r.size);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.canvas.clientWidth, h);
  }

  dispose() {
    for (const [type, fn] of this.listeners) this.canvas.removeEventListener(type, fn);
    this.scene.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach(mat => { (mat as THREE.MeshBasicMaterial).map?.dispose(); mat.dispose(); });
    });
  }
}
