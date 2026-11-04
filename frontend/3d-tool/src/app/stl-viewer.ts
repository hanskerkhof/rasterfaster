import { Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild, afterNextRender } from '@angular/core';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { firstValueFrom } from 'rxjs';
import { DocumentScene, axisAngles } from './document-scene';
import { ColorPalette } from './color-palette';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RenderService, aspectRatio, beamNames, turnDirections, turntableLengths } from './render.service';
import { AppMode, DocLight, DocSavedView, DocView, DocumentStore, Vec3, workArea } from './document.store';
import { buildImageSvg, buildParts, buildViewSvg, clearParts, LibraryService, previewStyle, setSilhouetteEdges, silhouetteEdges, ViewMode } from '@rasterfaster/library';
import { ReleaseFocus, ViewFocus } from './release-focus';
import { ViewCube } from './view-cube';
import { ZGridMode, defaultZGridMode, nextZLevel, zGridModes } from './z-levels';

const gridCellMm = 20; // RASTERFASTER base grid pitch
const gridColor = 0x4a4e58; // dark gray, visible on the #1b1d22 background
const grid3dStorageKey = 'rasterfaster.grid3d';
/** The studio of the Blender scene: its dark background and dark matte floor. */
const studioColour = { background: 0x1b1d22, ground: 0x1b1d23 };
const groundGridStorageKey = 'rasterfaster.groundGrid';
const groundModeStorageKey = 'rasterfaster.groundMode';
const groundColorStorageKey = 'rasterfaster.groundColor';
type GroundMode = 'none' | 'grid' | 'solid';
const pivotStorageKey = 'rasterfaster.pivotOnSelection';
/** The light of the Shaded view when the document does not say otherwise: from high above and a little behind. */
const defaultLightDirection = new THREE.Vector3(-0.5, 0.9, 2.6).normalize();
const rotationStepStorageKey = 'rasterfaster.rotationStep';
const rotationStepChoices = [90, 45, 15, 5, 1];
const moveStepStorageKey = 'rasterfaster.moveStepMm';
const moveStepChoices = [100, 20, 10, 5, 1, 0.1];
const scaleStepStorageKey = 'rasterfaster.scaleStepPercent';
const scaleStepChoices = [50, 25, 10, 5, 1];
const zGridModeStorageKey = 'rasterfaster.zGridMode';
const cameraModeStorageKey = 'rasterfaster.cameraMode';
const perspectiveFovDegrees = 35;
/** Home / fit leaves this much room around what it frames (1 = touching the edge of the view). */
const viewStoragePrefix = 'rasterfaster.docView.';
const fitMargin = 1.35;
/** The "Fit all" button fills the view much more closely than Home does: this little room is left round the objects. */
const fitAllMargin = 1.05;

/** Fusion-style camera choice. Ortho faces = perspective, but orthographic while looking straight at a face of the cube. */
export type CameraMode = 'orthographic' | 'perspective' | 'perspective-ortho-faces';
const cameraModes: { id: CameraMode; title: string; detail: string }[] = [
  { id: 'orthographic', title: 'Orthographic', detail: 'parallel lines, no foreshortening (default)' },
  { id: 'perspective', title: 'Perspective', detail: 'things further away look smaller' },
  { id: 'perspective-ortho-faces', title: 'Perspective with ortho faces', detail: 'orthographic when looking straight at a face' },
];

function readCameraMode(): CameraMode {
  try {
    const stored = localStorage.getItem(cameraModeStorageKey);
    if (cameraModes.some(m => m.id === stored)) return stored as CameraMode;
  } catch { /* storage unavailable */ }
  return 'orthographic';
}

function foldDegrees(d: number) {
  const folded = ((d % 360) + 540) % 360 - 180; // -180..180
  return folded === -180 ? 180 : folded;
}

export type { ViewMode } from '@rasterfaster/library';

function readZGridMode(): ZGridMode {
  try {
    const stored = localStorage.getItem(zGridModeStorageKey);
    if (zGridModes.some(m => m.id === stored)) return stored as ZGridMode;
  } catch { /* storage unavailable */ }
  return defaultZGridMode;
}

/** The Step of the rotate panel as the user left it (45° the first time). */
function readRotationStep() {
  try {
    const stored = Number(localStorage.getItem(rotationStepStorageKey));
    if (rotationStepChoices.includes(stored)) return stored;
  } catch { /* storage unavailable */ }
  return 45;
}

/** The Step of the Scale panel (percent of the original size) as the user left it (10%, the first time). */
function readScaleStep(): number {
  try {
    const stored = Number(localStorage.getItem(scaleStepStorageKey));
    if (scaleStepChoices.includes(stored)) return stored;
  } catch { /* storage unavailable */ }
  return 10;
}

/** The Step of the Move panel as the user left it (20 mm, one grid cell, the first time). */
function readMoveStep() {
  try {
    const stored = Number(localStorage.getItem(moveStepStorageKey));
    if (moveStepChoices.includes(stored)) return stored;
  } catch { /* storage unavailable */ }
  return 20;
}

function readPivotOnSelection() {
  try { return localStorage.getItem(pivotStorageKey) !== 'false'; } catch { return true; } // default on
}

/** What the ground shows: nothing, the grid (the default) or a solid colour; the old on/off setting of the grid is taken over. */
function readGroundMode(): GroundMode {
  try {
    const stored = localStorage.getItem(groundModeStorageKey);
    if (stored === 'none' || stored === 'grid' || stored === 'solid') return stored;
    return localStorage.getItem(groundGridStorageKey) === 'false' ? 'none' : 'grid';
  } catch { return 'grid'; }
}

function readGroundColor(): number {
  try {
    const stored = Number(localStorage.getItem(groundColorStorageKey));
    if (Number.isInteger(stored) && stored >= 0 && stored <= 0xffffff && localStorage.getItem(groundColorStorageKey) !== null) return stored;
  } catch { /* storage unavailable */ }
  return 0x3b404c;
}

function readGrid3d() {
  try { return localStorage.getItem(grid3dStorageKey) === 'true'; } catch { return false; }
}

/** One full loop of the fly-around path. */
const flightLoopSeconds = 280;
const showPathStorageKey = 'rasterfaster.showCameraPath';
function readShowPath() {
  try { return localStorage.getItem(showPathStorageKey) === 'true'; } catch { return false; }
}

@Component({
  selector: 'app-stl-viewer',
  imports: [ReleaseFocus, ColorPalette],
  template: `
    <div #host class="host" tabindex="0"></div>
    <div class="cube-arrows" aria-label="Turn the view">
      <button type="button" class="ca up" releaseFocus title="Tilt the view to the next face above (towards TOP)" aria-label="Tilt up" (click)="stepView('up')"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 5 21 19H3z" fill="currentColor"/></svg></button>
      <button type="button" class="ca down" releaseFocus title="Tilt the view to the next face below (towards BOTTOM)" aria-label="Tilt down" (click)="stepView('down')"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 19 3 5h18z" fill="currentColor"/></svg></button>
      <button type="button" class="ca left" releaseFocus title="Turn the view to the face on the left" aria-label="Turn left" (click)="stepView('left')"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12 19 3v18z" fill="currentColor"/></svg></button>
      <button type="button" class="ca right" releaseFocus title="Turn the view to the face on the right" aria-label="Turn right" (click)="stepView('right')"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M19 12 5 3v18z" fill="currentColor"/></svg></button>
      <button type="button" class="ca spin-l" releaseFocus title="Turn the view 45° counter-clockwise, seen from above (Z stays up)" aria-label="Turn counter-clockwise" (click)="stepView('ccw')"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v5h-5"/></svg></button>
      <button type="button" class="ca spin-r" releaseFocus title="Turn the view 45° clockwise, seen from above (Z stays up)" aria-label="Turn clockwise" (click)="stepView('cw')"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform: scaleX(-1)"><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v5h-5"/></svg></button>
    </div>
    <div #cross class="centre-cross" hidden><button type="button" class="hit" releaseFocus title="Make the middle of the objects the centre of the view" aria-label="Centre the view on the objects" (click)="centreOnObjects()"></button></div>
    @if (pictureFrame(); as frame) {
      <div class="picture-frame" [style.left.px]="frame.x" [style.top.px]="frame.y" [style.width.px]="frame.w" [style.height.px]="frame.h" title="What the render will show ({{ renderSettings.aspect() }})"></div>
    }
    <div class="panels" [class.grouped]="documentMode()" [class.closed]="transformClosed()">
    @if (documentMode()) {
      <div class="tf-head">
        <button type="button" class="tf-fold" releaseFocus [attr.aria-expanded]="!transformClosed()" [title]="transformClosed() ? 'Show Rotate, Move and Scale' : 'Hide Rotate, Move and Scale'" (click)="toggleTransform()">{{ transformClosed() ? '▸' : '▾' }} Transform</button>
      </div>
    }
    <div class="rotate" aria-label="Rotate object">
      <div class="axis head">
        <span class="title">{{ documentMode() ? 'Rotate' : 'Rotate object' }}</span>
        <button type="button" class="undo" [style.visibility]="turned().x || turned().y || turned().z ? 'visible' : 'hidden'" title="Back to the rotation of the STL file about all axes" releaseFocus (click)="resetAllRotation()">↺</button>
        <span class="pad one"></span>
        @if (documentMode()) { <button type="button" class="origin" [class.active]="hasOrigin()" [disabled]="!store.selectedId()" [title]="originTitle()" releaseFocus (click)="setOrigin()">⌖</button> }
        @if (!documentMode()) { <span class="pad one"></span> }
      </div>
      @for (axis of axes; track axis) {
        <div class="axis">
          <span [class]="'name ' + axis">{{ axis.toUpperCase() }}<small>{{ angles()[axis] ? ' ' + (angles()[axis] > 0 ? '+' : '') + angles()[axis] + '°' : '' }}</small></span>
          <button type="button" class="undo" [style.visibility]="turned()[axis] ? 'visible' : 'hidden'" [title]="'Back to the rotation of the STL file about ' + axis.toUpperCase()" releaseFocus (click)="resetAxisRotation(axis)">↺</button>
          <button type="button" [title]="'Rotate −' + rotationStep() + '° around ' + axis.toUpperCase() + ' (Option: −' + store.fineStepMm() + '°)'" [disabled]="documentMode() && !store.selectedId()" [class.active]="rotated()[axis] < 0" releaseFocus (click)="rotateObject(axis, $event.altKey ? -store.fineStepMm() : -rotationStep())">−</button>
          <button type="button" [title]="'Rotate +' + rotationStep() + '° around ' + axis.toUpperCase() + ' (Option: +' + store.fineStepMm() + '°)'" [disabled]="documentMode() && !store.selectedId()" [class.active]="rotated()[axis] > 0" releaseFocus (click)="rotateObject(axis, $event.altKey ? store.fineStepMm() : rotationStep())">+</button>
        </div>
      }
      <div class="axis">
        <span class="name">Step</span>
        <select releaseFocus [value]="rotationStep()" (change)="setRotationStep(+$any($event.target).value)">
          @for (s of rotationSteps; track s) { <option [value]="s" [selected]="s === rotationStep()">{{ s }}°</option> }
        </select>
      </div>
      @if (!documentMode()) { <button type="button" class="reset" releaseFocus (click)="resetObjectRotation()">Reset</button> }
    </div>
    @if (documentMode()) {
      <div class="rotate move" aria-label="Move object">
        <div class="axis head">
          <span class="title">Move</span>
          <button type="button" class="undo" [style.visibility]="moved().x || moved().y || moved().z ? 'visible' : 'hidden'" title="Back to the origin point along all axes" releaseFocus (click)="resetOffset('all')">↺</button>
          <span class="pad one"></span>
          <button type="button" class="origin" [class.active]="hasOrigin()" [disabled]="!store.selectedId()" [title]="originTitle()" releaseFocus (click)="setOrigin()">⌖</button>
        </div>
        @for (axis of axes; track axis) {
          <div class="axis">
            <span [class]="'name ' + axis">{{ axis.toUpperCase() }}<small>{{ offsetText(offsets()[axis]) }}</small></span>
            <button type="button" class="undo" [style.visibility]="moved()[axis] ? 'visible' : 'hidden'" [title]="'Back to where the STL file puts it along ' + axis.toUpperCase()" releaseFocus (click)="resetOffset(axis)">↺</button>
            <button type="button" [title]="'Move −' + moveStep() + ' mm along ' + axis.toUpperCase()" [disabled]="!store.selectedId()" releaseFocus (click)="moveBy(axis, -moveStep())">−</button>
            <button type="button" [title]="'Move +' + moveStep() + ' mm along ' + axis.toUpperCase()" [disabled]="!store.selectedId()" releaseFocus (click)="moveBy(axis, moveStep())">+</button>
          </div>
        }
        <div class="axis">
          <span class="name">Step</span>
          <select releaseFocus [value]="moveStep()" (change)="setMoveStep(+$any($event.target).value)">
            @for (s of moveSteps; track s) { <option [value]="s" [selected]="s === moveStep()">{{ s }} mm</option> }
          </select>
        </div>
      </div>

      <div class="rotate move scale" aria-label="Scale object">
        <div class="axis head">
          <span class="title">Scale</span>
          <button type="button" class="undo" [style.visibility]="scaled().x || scaled().y || scaled().z ? 'visible' : 'hidden'" title="Back to the size of the STL file along all axes" releaseFocus (click)="resetScale('all')">↺</button>
          <span class="pad one"></span>
          <span class="pad one"></span>
        </div>
        <div class="axis">
          <span class="name">XYZ<small>{{ scaleText(scales().x === scales().y && scales().y === scales().z ? scales().x : 1) }}</small></span>
          <span class="pad one"></span>
          <button type="button" [title]="'Scale all axes −' + scaleStep() + '%'" [disabled]="!store.selectedId()" releaseFocus (click)="scaleBy('all', -scaleStep())">−</button>
          <button type="button" [title]="'Scale all axes +' + scaleStep() + '%'" [disabled]="!store.selectedId()" releaseFocus (click)="scaleBy('all', scaleStep())">+</button>
        </div>
        @for (axis of axes; track axis) {
          <div class="axis">
            <span [class]="'name ' + axis">{{ axis.toUpperCase() }}<small>{{ scaleText(scales()[axis]) }}</small></span>
            <button type="button" class="undo" [style.visibility]="scaled()[axis] ? 'visible' : 'hidden'" [title]="'Back to the size of the STL file along ' + axis.toUpperCase()" releaseFocus (click)="resetScale(axis)">↺</button>
            <button type="button" [title]="'Scale −' + scaleStep() + '% along ' + axis.toUpperCase()" [disabled]="!store.selectedId()" releaseFocus (click)="scaleBy(axis, -scaleStep())">−</button>
            <button type="button" [title]="'Scale +' + scaleStep() + '% along ' + axis.toUpperCase()" [disabled]="!store.selectedId()" releaseFocus (click)="scaleBy(axis, scaleStep())">+</button>
          </div>
        }
        <div class="axis">
          <span class="name">Step</span>
          <select releaseFocus [value]="scaleStep()" (change)="setScaleStep(+$any($event.target).value)">
            @for (s of scaleSteps; track s) { <option [value]="s" [selected]="s === scaleStep()">{{ s }} %</option> }
          </select>
        </div>
      </div>
    }
    </div>
    @if (lightMenu(); as menu) {
      <div class="menu-backdrop" (mousedown)="lightMenu.set(null)" (contextmenu)="$event.preventDefault(); lightMenu.set(null)"></div>
      <div class="cube-menu" role="menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
        <button type="button" role="menuitem" (click)="startPointAtObject()"><span class="tick"></span>Point at object<span class="hint target" [title]="lightTargetText()">{{ lightTargetText() }}</span></button>
        <button type="button" role="menuitem" (click)="pointAtCentre()"><span class="tick">{{ lightAtCentre() ? '✓' : '' }}</span>Point at the objects' centre<span class="hint">keeps the direction</span></button>
        <div class="submenu-host" (mouseenter)="beamMenuOpen.set(true)" (mouseleave)="beamMenuOpen.set(false)">
          <button type="button" role="menuitem" aria-haspopup="menu" [attr.aria-expanded]="beamMenuOpen()" (click)="beamMenuOpen.set(!beamMenuOpen())">
            <span class="tick"></span>Type of light<span class="hint">{{ beamName() }} ◂</span>
          </button>
          @if (beamMenuOpen()) {
            <div class="flyout" role="menu">
              @for (b of beamTypes; track b.id) {
                <button type="button" role="menuitemradio" [attr.aria-checked]="renderSettings.beam() === b.id" (click)="chooseBeam(b.id)">
                  <span class="tick">{{ renderSettings.beam() === b.id ? '✓' : '' }}</span>{{ b.label }}<span class="hint">{{ b.hint }}</span>
                </button>
              }
            </div>
          }
        </div>
        <button type="button" role="menuitem" (click)="resetLight(); lightMenu.set(null)"><span class="tick"></span>Reset the light</button>
      </div>
    }
    @if (cubeMenu(); as menu) {
      <div class="menu-backdrop" (mousedown)="cubeMenu.set(null)" (contextmenu)="$event.preventDefault(); cubeMenu.set(null)"></div>
      <div class="cube-menu" role="menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
        <div class="submenu-host" (mouseenter)="groundMenuOpen.set(true); cameraMenuOpen.set(false); gridModeOpen.set(false)" (mouseleave)="groundMenuOpen.set(false); groundSolidOpen.set(false)">
          <button type="button" role="menuitem" aria-haspopup="menu" [attr.aria-expanded]="groundMenuOpen()" (click)="groundMenuOpen.set(!groundMenuOpen())">
            <span class="tick"></span>Ground<span class="hint">{{ groundModeTitle() }} ◂</span>
          </button>
          @if (groundMenuOpen()) {
            <div class="flyout narrow" role="menu">
              <button type="button" role="menuitemradio" [attr.aria-checked]="groundMode() === 'none'" (click)="setGroundMode('none')"><span class="tick">{{ groundMode() === 'none' ? '✓' : '' }}</span>None<span class="hint">no ground</span></button>
              <button type="button" role="menuitemradio" [attr.aria-checked]="groundMode() === 'grid'" (click)="setGroundMode('grid')"><span class="tick">{{ groundMode() === 'grid' ? '✓' : '' }}</span>Grid<span class="hint">lines on the ground</span></button>
              <div class="submenu-host" (mouseenter)="groundSolidOpen.set(true)" (mouseleave)="groundSolidOpen.set(false)">
                <button type="button" role="menuitemradio" aria-haspopup="menu" [attr.aria-checked]="groundMode() === 'solid'" (click)="setGroundMode('solid')">
                  <span class="tick">{{ groundMode() === 'solid' ? '✓' : '' }}</span>Solid<span class="dot" [style.background]="hex(groundColor())"></span><span class="hint">colour ◂</span>
                </button>
                @if (groundSolidOpen()) {
                  <div class="flyout palette" role="menu" aria-label="Ground colour"><app-color-palette [isOn]="isGroundColor" (picked)="setGroundColor($event)" /></div>
                }
              </div>
            </div>
          }
        </div>
        @if (mode() === 'shaded') {
          <button type="button" role="menuitem" (click)="cubeMenu.set(null); startPointAtObject()"><span class="tick"></span>Light: point at object<span class="hint">{{ lightTargetText() }}</span></button>
          <button type="button" role="menuitem" (click)="cubeMenu.set(null); pointAtCentre()"><span class="tick">{{ lightAtCentre() ? '✓' : '' }}</span>Light: point at the objects' centre<span class="hint">keeps the direction</span></button>
          <button type="button" role="menuitem" (click)="cubeMenu.set(null); lightFromView()"><span class="tick"></span>Light: shine from where I look<span class="hint">the lamp comes to the camera</span></button>
          <button type="button" role="menuitem" (click)="resetLight(); cubeMenu.set(null)"><span class="tick"></span>Reset the light<span class="hint">default direction</span></button>
        }
        <button type="button" role="menuitem" (click)="toggleGrid3d()">
          <span class="tick">{{ grid3d() ? '✓' : '' }}</span>3D grid<span class="hint">{{ grid3d() ? 'on' : 'off' }}</span>
        </button>
        <div class="submenu-host" (mouseenter)="cameraMenuOpen.set(true); gridModeOpen.set(false)" (mouseleave)="cameraMenuOpen.set(false)">
          <button type="button" role="menuitem" aria-haspopup="menu" [attr.aria-expanded]="cameraMenuOpen()" (click)="cameraMenuOpen.set(!cameraMenuOpen())">
            <span class="tick"></span>Camera<span class="hint">{{ currentCameraTitle() }} ◂</span>
          </button>
          @if (cameraMenuOpen()) {
            <div class="flyout" role="menu">
              @for (m of cameraModes; track m.id) {
                <button type="button" role="menuitemradio" [attr.aria-checked]="cameraMode() === m.id" (click)="setCameraMode(m.id)">
                  <span class="tick">{{ cameraMode() === m.id ? '✓' : '' }}</span>
                  <span class="two-line"><span>{{ m.title }}</span><small>{{ m.detail }}</small></span>
                </button>
              }
            </div>
          }
        </div>
        <div class="submenu-host" (mouseenter)="gridModeOpen.set(true); cameraMenuOpen.set(false)" (mouseleave)="gridModeOpen.set(false)">
          <button type="button" role="menuitem" aria-haspopup="menu" [attr.aria-expanded]="gridModeOpen()" (click)="gridModeOpen.set(!gridModeOpen())">
            <span class="tick"></span>Grid mode<span class="hint">{{ currentGridModeTitle() }} ◂</span>
          </button>
          @if (gridModeOpen()) {
            <div class="flyout" role="menu">
              @for (m of zGridModes; track m.id) {
                <button type="button" role="menuitemradio" [attr.aria-checked]="zGridMode() === m.id" (click)="setZGridMode(m.id)">
                  <span class="tick">{{ zGridMode() === m.id ? '✓' : '' }}</span>
                  <span class="two-line"><span>{{ m.title }}</span><small>{{ m.detail }}</small></span>
                </button>
              }
            </div>
          }
        </div>
        @if (documentMode()) {
          <button type="button" role="menuitem" (click)="toggleFlight(); cubeMenu.set(null)">
            <span class="tick">{{ flying() ? '✓' : '' }}</span>Fly-around<span class="hint">{{ flying() ? 'on' : 'off' }}</span><span class="hint">Space</span>
          </button>
        }
        @if (documentMode()) {
          <button type="button" role="menuitem" (click)="toggleShowPath()">
            <span class="tick">{{ showPath() ? '✓' : '' }}</span>Show camera path<span class="hint">{{ showPath() ? 'on' : 'off' }}</span>
          </button>
        }
        <button type="button" role="menuitem" title="Draw the contour of curved walls (cylinders, cones) in the hidden-line views" (click)="toggleSilhouette()">
          <span class="tick">{{ silhouette() ? '✓' : '' }}</span>Silhouette edges<span class="hint">{{ silhouette() ? 'on' : 'off' }}</span>
        </button>
        <button type="button" role="menuitem" (click)="togglePivotOnSelection()">
          <span class="tick">{{ pivotOnSelection() ? '✓' : '' }}</span>Rotate around selection<span class="hint">{{ pivotOnSelection() ? 'on' : 'off' }}</span>
        </button>
      </div>
    }
    @if (documentMode()) {
      <div class="fly-host" (mouseenter)="flyMenuOpen.set(true)" (mouseleave)="flyMenuOpen.set(false)">
        <button class="home fly" type="button" [class.on]="flying() || turntablePreview()" [title]="turntablePreview() ? (turntablePaused() ? 'Go on with the turntable (Space; Esc ends it)' : 'Pause the turntable (Space; Esc ends it)') : flying() ? 'Stop the fly-around (Space)' : 'Fly-around: slowly circle the assembly (Space). Hover for the turntable preview'" aria-label="Fly-around (Space)" aria-keyshortcuts="Space" [attr.aria-pressed]="flying() || !!turntablePreview()" aria-haspopup="menu" releaseFocus (click)="toggleFlight()">
          @if ((flying() || turntablePreview()) && !turntablePaused()) {
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          } @else {
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>
          }
        </button>
        @if (flyMenuOpen()) {
          <div class="fly-menu" role="menu">
            <button type="button" role="menuitem" (click)="toggleFlight(); flyMenuOpen.set(false)"><span class="tick">{{ flying() ? '✓' : '' }}</span>Fly-around<span class="hint">slowly wandering · Space</span></button>
            <div class="sep"></div>
            <div class="head">Turntable preview (the video, live; steer meanwhile; Space pauses)</div>
            <button type="button" role="menuitem" (click)="startTurntablePreview('orbit'); flyMenuOpen.set(false)"><span class="tick">{{ turntablePreview()?.motion === 'orbit' ? '✓' : '' }}</span>Camera circles<span class="hint">once around, looping</span></button>
            <button type="button" role="menuitem" (click)="startTurntablePreview('spin'); flyMenuOpen.set(false)"><span class="tick">{{ turntablePreview()?.motion === 'spin' ? '✓' : '' }}</span>Objects turn<span class="hint">in front of the camera</span></button>
            <button type="button" role="menuitem" (click)="startTrackPick(); flyMenuOpen.set(false)"><span class="tick">{{ renderSettings.tracked() ? '✓' : '' }}</span>Track an object…<span class="hint">{{ renderSettings.tracked()?.name ?? 'none chosen' }}</span></button>
            <div class="head">Camera circles goes round</div>
            @for (choice of pivotChoices; track choice.id) {
              <button type="button" role="menuitemradio" [attr.aria-checked]="renderSettings.trackPivot() === choice.id" [disabled]="choice.id === 'part' && !renderSettings.tracked()" (click)="renderSettings.setTrackPivot(choice.id)"><span class="tick">{{ renderSettings.trackPivot() === choice.id ? '✓' : '' }}</span>{{ choice.label }}<span class="hint">{{ choice.hint }}</span></button>
            }
            <div class="head">Looks at (Camera circles and Objects turn)</div>
            @for (choice of lookChoices; track choice.id) {
              <button type="button" role="menuitemradio" [attr.aria-checked]="renderSettings.lookAt() === choice.id" [disabled]="choice.id === 'part' && !renderSettings.tracked()" (click)="renderSettings.setLookAt(choice.id)"><span class="tick">{{ renderSettings.lookAt() === choice.id ? '✓' : '' }}</span>{{ choice.label }}<span class="hint">{{ choice.hint }}</span></button>
            }
            @if (renderSettings.tracked()) { <button type="button" role="menuitem" (click)="renderSettings.setTrack(null); flyMenuOpen.set(false)"><span class="tick"></span>Stop tracking<span class="hint">stop looking at the part</span></button> }
            @if (turntablePreview()) {
              <button type="button" role="menuitem" (click)="pauseTurntablePreview(); flyMenuOpen.set(false)"><span class="tick"></span>{{ turntablePaused() ? 'Go on' : 'Pause' }}<span class="hint">Space</span></button>
              <button type="button" role="menuitem" (click)="stopTurntablePreview(); flyMenuOpen.set(false)"><span class="tick"></span>End the preview<span class="hint">Esc</span></button>
            }
            <div class="row">
              <span class="label">Direction</span>
              @for (d of turnDirections; track d.id) { <button type="button" role="menuitemradio" [title]="d.title" [attr.aria-checked]="renderSettings.turntable().direction === d.id" [class.on]="renderSettings.turntable().direction === d.id" (click)="renderSettings.setTurntable({ direction: d.id })">{{ d.label }}</button> }
            </div>
            <div class="row">
              <span class="label">One turn takes</span>
              @for (n of turnLengths; track n) { <button type="button" role="menuitemradio" [attr.aria-checked]="renderSettings.turntable().seconds === n" [class.on]="renderSettings.turntable().seconds === n" (click)="renderSettings.setTurntable({ seconds: n })">{{ n }} s</button> }
            </div>
            <div class="sep"></div>
            <button type="button" role="menuitem" (click)="renderSettings.requestOpen(); flyMenuOpen.set(false)"><span class="tick"></span>Render this as a video…<span class="hint">opens the Render dialog (F12)</span></button>
          </div>
        }
      </div>
    }
    @if (documentMode() && flying()) {
      <button class="home fly zoom-reset" type="button" title="Reset the zoom of the fly-around" aria-label="Reset fly-around zoom" releaseFocus (click)="resetFlightZoom()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M8.5 11h5"/></svg>
      </button>
    }
    @if (documentMode()) {
      <button class="home fit" type="button" title="Fit all: zoom and move the view so every object of the document is in it (the viewing angle stays)" aria-label="Fit all objects in view" [disabled]="!store.doc().items.length" releaseFocus (click)="fitAll()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V6a2 2 0 0 1 2-2h3M20 9V6a2 2 0 0 0-2-2h-3M4 15v3a2 2 0 0 0 2 2h3M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M12 7.6l4 2.3v4.2l-4 2.3-4-2.3V9.9z"/><path d="M8 9.9l4 2.3 4-2.3M12 12.2v4.2"/></svg>
      </button>
    }
    <button class="home" type="button" title="Home: isometric view, fit to the model" aria-label="Home view" releaseFocus (click)="goHome()">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10"/></svg>
    </button>`,
  styles: `
    .cube-menu .hint.target { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cube-arrows { position: absolute; right: 12px; top: 42px; width: 150px; height: 150px; pointer-events: none; z-index: 2; }
    .ca { position: absolute; pointer-events: auto; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; background: transparent; color: #8a93a2; border: 0; border-radius: 4px; cursor: pointer; }
    .ca:hover { color: #fff; background: #2f6fed; }
    .ca.up { left: 65px; top: 0; } .ca.down { left: 65px; bottom: 0; } .ca.left { left: 0; top: 65px; } .ca.right { right: 0; top: 65px; }
    .ca.spin-l { left: 0; top: 0; width: 24px; height: 24px; } .ca.spin-r { right: 0; top: 0; width: 24px; height: 24px; }
    .centre-cross { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 1; }
    .centre-cross .hit { position: absolute; left: -11px; top: -11px; width: 23px; height: 23px; padding: 0; border: 0; background: transparent; cursor: pointer; pointer-events: auto; }
    .centre-cross .hit:hover { border-radius: 50%; background: rgba(255, 214, 10, 0.22); box-shadow: 0 0 0 1.5px #ffd60a; }
    .centre-cross:has(.hit:hover)::before, .centre-cross:has(.hit:hover)::after { background: #ffd60a; mix-blend-mode: normal; }
    .centre-cross:has(.hit:hover)::before { left: -14px; width: 29px; height: 2px; top: -0.5px; }
    .centre-cross:has(.hit:hover)::after { top: -14px; height: 29px; width: 2px; left: -0.5px; }
    .centre-cross::before, .centre-cross::after { content: ''; position: absolute; background: rgba(255, 255, 255, 0.85); mix-blend-mode: difference; }
    .centre-cross::before { left: -10px; top: 0; width: 21px; height: 1px; }
    .centre-cross::after { left: 0; top: -10px; width: 1px; height: 21px; }
    .picture-frame { position: absolute; pointer-events: none; box-sizing: border-box; border: 1.5px dashed rgba(255, 255, 255, 0.85); box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.38); z-index: 1; }
    :host, .host { display: block; width: 100%; height: 100%; } .host { position: relative; overflow: hidden; }
    :host { position: relative; }
    /* Fusion-style: a small house icon in the top-left corner of the view cube's area (the cube is 150 px wide, 12 px from the edges) */
    .home { position: absolute; top: 12px; right: 144px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; padding: 0;
            background: transparent; color: #d5d9e2; border: 1px solid transparent; border-radius: 6px; cursor: pointer; opacity: .8; }
    .fly-menu { position: absolute; top: 28px; right: 0; width: max-content; min-width: 260px; padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; display: flex; flex-direction: column; }
    .fly-menu button { display: flex; align-items: center; gap: 8px; text-align: left; padding: 5px 8px; background: transparent; border: 0; border-radius: 4px; color: inherit; font: inherit; cursor: pointer; } .fly-menu button:hover { background: #2f6fed; color: #fff; }
    .fly-menu .tick { width: 14px; text-align: center; } .fly-menu .hint { margin-left: auto; padding-left: 14px; opacity: .55; font-size: 11px; }
    .fly-menu .sep { height: 1px; margin: 4px 2px; background: rgba(255,255,255,.12); } .fly-menu .head { padding: 3px 8px; opacity: .6; font-size: 11px; }
    .fly-menu .row { display: flex; align-items: center; gap: 4px; padding: 2px 8px 4px; } .fly-menu .row .label { margin-right: auto; opacity: .75; } .fly-menu .row button { padding: 2px 8px; background: #3a3f4b; } .fly-menu .row button.on { background: #2f6fed; color: #fff; }
    .home.fit { right: 178px; } .home.fit:disabled { opacity: .3; pointer-events: none; }
    .fly-host { position: absolute; top: 12px; right: 110px; width: 30px; height: 30px; z-index: 6; }
    .fly-host .home.fly { position: static; right: auto; top: auto; }
    .home.fly { right: 110px; } .home.fly.zoom-reset { right: 76px; } .home.fly.on { background: #2f6fed; color: #fff; opacity: 1; }
    .home:hover { background: #2f6fed; color: #fff; opacity: 1; }
    .panels { position: absolute; top: 12px; left: 12px; display: flex; flex-direction: column; gap: 8px; }
    .panels.grouped { width: 180px; padding: 4px 8px 8px; box-sizing: border-box; gap: 0; background: rgba(35,38,45,.85); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; font-size: 12px; color: #dde1e8; }
    .panels.grouped .rotate { width: auto; padding: 8px 0 6px; background: none; border: 0; border-top: 1px solid rgba(255,255,255,.1); border-radius: 0; }
    .panels.grouped.closed .rotate { display: none; }
    .tf-head { display: flex; align-items: center; padding-bottom: 4px; }
    .tf-fold { background: transparent; border: 0; color: inherit; font: inherit; font-weight: 600; padding: 2px 0; cursor: pointer; opacity: .85; } .tf-fold:hover { opacity: 1; color: #fff; background: transparent; }
    .rotate { width: 164px; padding: 8px; display: flex; flex-direction: column; gap: 6px;
              background: rgba(35,38,45,.85); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; font-size: 12px; color: #dde1e8; }
    .title { font-weight: 600; opacity: .8; }
    .axis { display: flex; align-items: center; gap: 4px; }
    .name { flex: 1; font-weight: 700; white-space: nowrap; min-width: 0; } .name small { font-weight: 400; font-size: 10px; opacity: .8; } .name.x { color: #c9605e; } .name.y { color: #6fb56f; } .name.z { color: #7b7fd6; }
    .rotate button, .rotate select { padding: 3px 9px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; }
    .rotate button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    .rotate button:disabled { opacity: .35; cursor: default; }
    .rotate .axis button { width: 28px; padding: 3px 0; text-align: center; } .rotate .axis .pad { width: 60px; flex: none; } .rotate .axis .pad.one { width: 28px; } .rotate .axis.head .title { flex: 1; }
    .host:focus { outline: none; }
    .menu-backdrop { position: absolute; inset: 0; z-index: 8; }
    .cube-menu { position: absolute; z-index: 9; min-width: 220px; padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18);
                 border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; }
    .cube-menu button { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; background: transparent; color: inherit; border: 0; border-radius: 5px; text-align: left; cursor: pointer; font: inherit; }
    .cube-menu button:hover { background: #2f6fed; color: #fff; }
    .submenu-host { position: relative; }
    .flyout { position: absolute; right: calc(100% - 2px); top: -4px; min-width: 250px; padding: 4px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18);
              border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .flyout.narrow { min-width: 230px; } .flyout.palette { min-width: 0; padding: 6px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(255,255,255,.4); align-self: center; }
    .two-line { display: flex; flex-direction: column; gap: 1px; }
    .two-line small { opacity: .55; font-size: 11px; }
    .cube-menu .tick { width: 1em; text-align: center; }
    .cube-menu .hint { margin-left: auto; opacity: .55; font-size: 11px; }
    .rotate button.active { background: #d9822b; color: #fff; }
    small { font-weight: 400; opacity: .85; color: #dde1e8; }
    .reset { width: 100%; }`,
})
export class StlViewer implements OnDestroy {
  readonly data = input<ArrayBuffer | null>(null);
  readonly mode = input<ViewMode>('solid');
  /** Recalling a saved view asks the app to switch the display mode. */
  readonly modeRequest = output<ViewMode>();
  /** false: preview one STL; true: show and edit the document's items. */
  readonly documentMode = input(false);
  protected readonly store = inject(DocumentStore);
  private readonly renderSettings = inject(RenderService);
  private readonly viewFocus = inject(ViewFocus);
  private readonly library = inject(LibraryService);
  readonly info = signal('');
  /** About the selected part(s), shown at the bottom right: size, volume and the name (or how many are selected); empty without a selection. */
  readonly selectionInfo = signal('');
  protected readonly axes = ['x', 'y', 'z'] as const;

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private renderer!: THREE.WebGLRenderer;
  /** The light source of the "Shaded" view: warm, from high above and a little behind, casting soft shadows on the build plate. */
  private readonly keyLight = new THREE.DirectionalLight(0xfff0dc, 2.4);
  /** The light source drawn like Blender's sun: a ring with rays, and a line with an arrow head to where it shines (wire, on top of everything). */
  /** Where the light shines from (unit vector from what it points at to the light) and what it points at (null: the middle of the scene). */
  private lightDir = defaultLightDirection.clone();
  private lightAt: THREE.Vector3 | null = null;
  /** A part the light follows (wins over `lightAt`). */
  private lightTargetId: string | null = null;
  /** What the gizmo is placed round now (set by updateShadowRig), and how far out it sits. */
  private readonly lightAtNow = new THREE.Vector3();
  private lightReach = 1;
  private lightDrag: { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null = null;
  protected readonly lightMenu = signal<{ x: number; y: number } | null>(null);
  /** "Point at object": the light follows the part under the pointer, a click keeps it, Esc puts it back. */
  private pointMode: { dir: THREE.Vector3; at: THREE.Vector3 | null; id: string | null } | null = null;
  private readonly lightGizmo = new THREE.Group();
  private readonly lightDisk = new THREE.Group();
  private readonly lightBeam = new THREE.Group();
  private readonly shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.38 }));
  private scene = new THREE.Scene();
  private readonly orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(perspectiveFovDegrees, 1, 1, 100000);
  /** The camera in use; everything (controls, picking, the view cube, pan and zoom) goes through it. */
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = this.orthoCamera;
  private projection: 'ortho' | 'persp' = 'ortho';
  protected readonly cameraMode = signal<CameraMode>(readCameraMode());
  protected readonly cameraModes = cameraModes;
  protected readonly cameraMenuOpen = signal(false);
  private controls!: OrbitControls;
  private model = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private edges: THREE.EdgesGeometry | null = null;
  private frame = 0;
  private ro?: ResizeObserver;
  private radius = 1;
  private ready = signal(false);
  private hasView = false;
  private baseGeometry: THREE.BufferGeometry | null = null;
  private readonly objectRotation = new THREE.Quaternion();
  private grid: THREE.LineSegments | null = null;
  protected readonly rotationStep = signal(readRotationStep());
  /** Net degrees applied per world axis (button presses summed, folded into -180..180) so the panel can show what was rotated. */
  protected readonly rotated = signal({ x: 0, y: 0, z: 0 });
  /** Document view: the turns of the selected part (the last one chosen) away from its STL file; otherwise the turns of the preview. */
  protected readonly angles = computed(() => {
    if (!this.documentMode()) return this.rotated();
    const item = this.store.selectedItems().at(-1);
    return item ? axisAngles(item.rotation) : { x: 0, y: 0, z: 0 };
  });
  /** Per axis: is any selected part (or the preview) turned away from its STL file? Then the undo button of the axis shows. */
  protected readonly turned = computed(() => {
    if (!this.documentMode()) { const r = this.rotated(); return { x: r.x !== 0, y: r.y !== 0, z: r.z !== 0 }; }
    const all = this.store.selectedItems().map(item => axisAngles(item.rotation));
    return { x: all.some(a => a.x !== 0), y: all.some(a => a.y !== 0), z: all.some(a => a.z !== 0) };
  });
  protected readonly rotationSteps = rotationStepChoices;
  protected readonly moveSteps = moveStepChoices;
  protected readonly moveStep = signal(readMoveStep());
  protected readonly scaleSteps = scaleStepChoices;
  protected readonly scaleStep = signal(readScaleStep());

  protected setScaleStep(percent: number) {
    this.scaleStep.set(percent);
    try { localStorage.setItem(scaleStepStorageKey, String(percent)); } catch { /* storage unavailable */ }
  }

  /** A scale for the Scale panel: nothing at 100%, else the percentage. */
  protected scaleText(factor: number) {
    return factor === 1 ? '' : ` ${Math.round(factor * 1000) / 10}%`;
  }

  /** Scale panel: the scale of the part chosen last along the world X, Y and Z (1 = the size of the STL file). */
  protected readonly scales = computed(() => {
    this.store.partStats();
    const item = this.store.selectedItems().at(-1);
    const scale = item ? this.documentScene?.scaleOf(item) : null;
    return scale ? { x: scale[0], y: scale[1], z: scale[2] } : { x: 1, y: 1, z: 1 };
  });
  protected readonly scaled = computed(() => {
    this.store.partStats();
    const all = this.store.selectedItems().map(item => this.documentScene?.scaleOf(item)).filter((o): o is Vec3 => !!o);
    return { x: all.some(o => o[0] !== 1), y: all.some(o => o[1] !== 1), z: all.some(o => o[2] !== 1) };
  });

  /** An offset for the Move panel: short, with a sign (whole millimetres once it is large). */
  protected offsetText(mm: number) {
    if (!mm) return '';
    const shown = Math.abs(mm) >= 100 ? Math.round(mm) : Math.round(mm * 10) / 10;
    return ` ${shown > 0 ? '+' : ''}${shown}`;
  }

  protected setMoveStep(mm: number) {
    this.moveStep.set(mm);
    try { localStorage.setItem(moveStepStorageKey, String(mm)); } catch { /* storage unavailable */ }
  }

  /** Move panel: where the STL's origin sits for the selected part (the last one chosen): 0 is where the file puts it. */
  protected readonly offsets = computed(() => {
    this.store.partStats(); // the geometry has loaded
    const item = this.store.selectedItems().at(-1);
    const offset = item ? this.documentScene?.originOffset(item) : null;
    return offset ? { x: offset[0], y: offset[1], z: offset[2] } : { x: 0, y: 0, z: 0 };
  });
  protected readonly moved = computed(() => {
    this.store.partStats();
    const all = this.store.selectedItems().map(item => this.documentScene?.originOffset(item)).filter((o): o is Vec3 => !!o);
    return { x: all.some(o => o[0] !== 0), y: all.some(o => o[1] !== 0), z: all.some(o => o[2] !== 0) };
  });

  protected setRotationStep(degrees: number) {
    this.rotationStep.set(degrees);
    try { localStorage.setItem(rotationStepStorageKey, String(degrees)); } catch { /* storage unavailable */ }
  }
  private viewCube!: ViewCube;
  private documentScene!: DocumentScene;
  private needsDocumentFit = true;
  /** A document was just opened: its saved view (see saveView) is used instead of fitting it, once. */
  private restoreSavedView = true;
  private saveViewTimer?: ReturnType<typeof setTimeout>;
  /** When the user last moved the camera on purpose (drag, wheel, a view button): the automatic fit when a document opens is not saved as its view. */
  private viewTouchedAt = 0;
  private touchView() { this.viewTouchedAt = Date.now(); }
  private gridKey = '';
  /** Full 3D lattice (X, Y and the z levels) instead of only the ground grid; toggled from the view cube's right-click menu. */
  protected readonly grid3d = signal(readGrid3d());
  /** Show the grid on the ground (and the 3D lattice with it); the view cube menu switches it. */
  protected readonly groundMode = signal<GroundMode>(readGroundMode());
  protected readonly groundColor = signal(readGroundColor());
  /** In Render mode the view shows the ground of the render: the Render dialog's ground colour when one is set, else the studio's dark floor. */
  private readonly renderMode = computed(() => this.store.appMode() === 'render');
  private readonly shownGroundMode = computed<GroundMode>(() => (this.renderMode() ? 'solid' : this.groundMode()));
  private readonly shownGroundColor = computed(() => (this.renderMode() ? (this.renderSettings.ground() ?? studioColour.ground) : this.groundColor()));
  private readonly shownBackground = computed(() => (this.renderMode() ? (this.renderSettings.background() ?? studioColour.background) : studioColour.background));
  protected readonly groundGrid = computed(() => this.shownGroundMode() === 'grid');
  protected readonly groundMenuOpen = signal(false);
  protected readonly groundSolidOpen = signal(false);
  private groundPlane: THREE.Mesh | null = null;
  protected readonly silhouette = silhouetteEdges;
  protected readonly cubeMenu = signal<{ x: number; y: number } | null>(null);
  /** Height grid: fine (2 mm), baseplate (2 mm then 4 mm) or coarse (4 mm). Chosen in the view cube menu's "Grid mode" fly-out. */
  protected readonly zGridMode = signal(readZGridMode());
  protected readonly zGridModes = zGridModes;
  protected readonly gridModeOpen = signal(false);
  /** The light's own menu: the type of light (how soft its shadows are), the same setting as the Lamp menu of the Render dialog. */
  protected readonly beamMenuOpen = signal(false);
  protected readonly beamTypes = beamNames.map((label, id) => ({ id, label, hint: ['razor-sharp shadows', 'sharp shadows (the studio\'s own)', 'soft shadows', 'very soft shadows', 'hardly any shadow'][id] }));
  protected beamName() { return beamNames[this.renderSettings.beam()] ?? ''; }
  protected chooseBeam(id: number) {
    this.renderSettings.setBeam(id);
    this.beamMenuOpen.set(false);
    this.lightMenu.set(null);
    this.store.announce(`Type of light: ${beamNames[id]}`, 2500);
  }
  /** Rotating the view (drag, or dragging the view cube) pivots around the selected parts instead of the current view centre. */
  protected readonly pivotOnSelection = signal(readPivotOnSelection());
  private pivotGoal: THREE.Vector3 | null = null;
  /** Fly-around: the camera slowly circles the assembly on a wandering path (azimuth sweep, rising and falling elevation, breathing zoom, drifting centre). */
  protected readonly flying = signal(false);
  protected readonly showPath = signal(readShowPath());
  private pathLine: THREE.Line | null = null;
  /** Zoom the user added on top of the flight's own zoom (wheel / pinch keep working while flying); the reset button sets it back to 1. */
  private userZoom = 1;
  private flightZoomSet = 0;
  private cameraBody: THREE.LineSegments | null = null;
  private flightTime = 0;
  private flightLast = 0;
  private flightAzimuth0 = 0;
  private stageEl: HTMLElement | null = null;
  /** Space toggles the fly-around (document mode), unless it belongs to a button, a text field or a menu. */
  /** ⌘0 … ⌘6 as in Bambu Studio: home (isometric), top, bottom, front, rear, left, right. */
  private readonly viewKeys = [null, [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]] as const;
  private readonly onViewKey = (e: KeyboardEvent) => {
    const digit = /^Digit([0-6])$/.exec(e.code);
    if (!digit || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    const dir = this.viewKeys[+digit[1]];
    if (dir) this.snapTo(new THREE.Vector3(...dir)); else this.goHome();
  };
  private readonly onFlightKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.turntablePreview() && !e.metaKey && !e.ctrlKey && !e.altKey) { this.stopTurntablePreview(); return; } // Esc ends the turntable preview (the parts stand as before)
    if (e.key !== ' ' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || !this.documentMode()) return;
    if ((e.target as HTMLElement | null)?.closest('button, input, textarea, select, [contenteditable], [role=menu]')) return;
    e.preventDefault();
    this.toggleFlight();
  };
  private readonly stopFlight = () => this.flying.set(false); // (the turntable preview goes on while you steer: it stops with the play button or Space)
  protected readonly flyMenuOpen = signal(false);
  protected readonly turnLengths = turntableLengths;
  protected readonly pivotChoices: { id: 'all' | 'view' | 'part'; label: string; hint: string }[] = [
    { id: 'all', label: 'All objects', hint: 'the middle of the parts' },
    { id: 'view', label: 'The view', hint: 'the point you look at' },
    { id: 'part', label: 'The tracked part', hint: 'needs a tracked part' },
  ];
  protected readonly lookChoices: { id: 'all' | 'view' | 'part'; label: string; hint: string }[] = [
    { id: 'view', label: 'As the view does', hint: 'keeps its angle' },
    { id: 'all', label: 'All objects', hint: 'the middle of the parts' },
    { id: 'part', label: 'The tracked part', hint: 'needs a tracked part' },
  ];
  /** The live turntable preview: how it moves; null when it is not running. */
  protected readonly turntablePreview = signal<{ motion: 'orbit' | 'spin' } | null>(null);
  /** The preview is paused (Space): the camera or the parts stay where they are, Space goes on from there. */
  protected readonly turntablePaused = signal(false);
  private previewState: { last: number; angle: number; pivot: THREE.Vector3; aim: THREE.Vector3 | null } | null = null;
  private lastGrid: { min: THREE.Vector3; max: THREE.Vector3; zTop: number } | null = null;
  private panAnimation: { offset: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; start: number } | null = null;
  private readonly pickRaycaster = new THREE.Raycaster();
  private lastItemCount = 0;
  private snapAnimation: { from: THREE.Vector3; rotation: THREE.Quaternion; start: number; distance: number } | null = null;
  /** The Home view: from the front right and only a little above (about 12° up; it was 30°, then 20°: looking down on the parts too steeply). */
  private readonly homeDirection = new THREE.Vector3(1, -1, 0.3).normalize();

  constructor() {
    let animationWas = false;
    effect(() => { // the animations (fly-around, turntable preview) do not touch the document's view; when one ends the camera is where it is, and that is kept then
      const on = this.animationRunning(); // (a paused preview does not move anything: the camera is where it is and is kept)
      this.store.animating.set(on);
      if (on) this.store.viewDirty.set(true); // the view it started from stays marked as changed until the user chooses, saves or replaces a view
      if (animationWas && !on && this.ready()) untracked(() => { this.touchView(); this.scheduleSaveView(); });
      animationWas = on;
    });
    effect(() => { this.renderSettings.trackPivot(); this.renderSettings.lookAt(); this.renderSettings.trackId(); untracked(() => this.refreshPreviewPivot()); }); // the choice of what Camera circles goes round counts at once, also while it plays
    effect(() => { // picking the part a turntable tracks: a cross-hair, and a hint until a part is clicked
      const picking = this.store.trackPick();
      untracked(() => {
        if (this.renderer) this.renderer.domElement.style.cursor = picking ? 'crosshair' : '';
        if (picking) this.store.announce('Click the part the turntable should track (Esc cancels)', 600000);
        else if (this.store.notice().startsWith('Click the part the turntable')) this.store.notice.set('');
      });
    });
    afterNextRender(() => { this.init(); this.ready.set(true); });
    effect(() => {
      const d = this.data();
      // untracked: setModel/applyMode read the mode signal, which must not re-run (and reset) the camera
      if (this.ready() && d) untracked(() => this.setModel(d));
    });
    effect(() => {
      this.mode();
      if (this.ready()) this.applyMode();
    });
    effect(() => { const appMode = this.store.appMode(), kept = this.store.doc().cameraModes, ready = this.ready(); this.store.docId(); if (ready) untracked(() => this.followAppMode(appMode, kept)); });
    effect(() => {
      const documentMode = this.documentMode();
      if (this.ready()) untracked(() => this.enterMode(documentMode));
    });
    effect(() => {
      this.grid3d();
      this.zGridMode(); // the 3D grid's levels follow the mode
      this.groundGrid(); // switching the grid on or off only needs the visibility (rebuildGrid sets it)
      this.shownGroundMode(); this.shownGroundColor(); // and the solid ground is built with the grid
      if (this.ready()) untracked(() => { this.rebuildGrid(); this.updateShadowRig(); });
    });
    effect(() => { const colour = this.shownBackground(); (this.scene.background as THREE.Color | null)?.set(colour); });
    // A file came back (or went away): parts that could not be loaded are tried again.
    effect(() => { this.store.missingPaths(); untracked(() => { if (this.ready()) this.documentScene.retryFailed(); }); });
    // Another document was opened: fit the camera to it once its geometry has loaded.
    effect(() => { this.store.docId(); untracked(() => { this.needsDocumentFit = true; this.restoreSavedView = true; this.lastItemCount = 0; clearTimeout(this.saveViewTimer); }); });
    // The light of the Shaded view is part of the document: whatever the document says, the light does (not while it is being dragged).
    effect(() => {
      const light = this.store.doc().light ?? null;
      this.store.docId();
      if (this.ready()) untracked(() => this.applyStoredLight(light));
    });
    // The selection or the numbers of a part changed: the line about the selection at the bottom right follows.
    effect(() => {
      this.store.selectedIds(); this.store.doc(); this.store.partStats();
      if (this.ready()) untracked(() => this.updateSelectionInfo());
    });
    // Tracks the store and the view mode (read inside reconcile) and redraws the document items.
    effect(() => {
      if (this.ready()) this.documentScene.reconcile(this.mode());
    });
  }

  private init() {
    const el = this.host().nativeElement;
    this.viewFocus.target = el;
    this.store.showInAssembly = ids => this.showInAssembly(ids);
    this.store.viewSvg = () => this.viewSvg();
    this.store.captureView = () => this.captureView();
    this.store.recallView = view => this.recallView(view);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.shadowMap.enabled = true; // only the key light of the "Shaded" view casts (see updateShadowRig)
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    Object.assign(this.renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(this.shownBackground());
    this.scene.add(this.model);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1, -2, 3);
    this.scene.add(dir);
    this.keyLight.castShadow = false;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.6;
    this.keyLight.shadow.radius = 4;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.shadowFloor.visible = false;
    this.buildLightGizmo();
    this.shadowFloor.renderOrder = -1;
    this.scene.add(this.shadowFloor);
    // STL / 3D-printing convention: Z is up. Classic isometric: look along (-1,-1,-1).
    this.orthoCamera.up.set(0, 0, 1);
    this.perspectiveCamera.up.set(0, 0, 1);
    // Created first so its pointerdown handler can swallow clicks that land on the cube.
    this.viewCube = new ViewCube(this.renderer.domElement, d => this.snapTo(d), (dx, dy) => this.orbitBy(dx, dy), (clientX, clientY) => {
      const host = this.host().nativeElement.getBoundingClientRect();
      const menuWidth = 300; // keep the menu inside the view when the cube is at the right edge
      this.cubeMenu.set({ x: Math.min(clientX - host.left, host.width - menuWidth), y: clientY - host.top });
    }); // a press on the cube does not recentre the view on the selection: it only turns the view about where it is
    this.renderer.domElement.addEventListener('contextmenu', this.onLightContext, true); // the light's own menu: capture phase, so the parts' menu does not open
    this.renderer.domElement.addEventListener('pointerdown', this.onPointAtDown, true);
    this.renderer.domElement.addEventListener('pointermove', this.onPointAtMove);
    this.renderer.domElement.addEventListener('pointermove', this.onLightHover);
    this.renderer.domElement.addEventListener('pointerdown', () => this.touchView(), true); // any press on the view may move the camera
    this.renderer.domElement.addEventListener('pointerdown', this.onLightDown); // before the parts and the orbit controls: the light source can be grabbed
    // Also before OrbitControls: a drag that starts on a document object must move it, not orbit.
    const viewer = this; // the scene reads the *current* camera (it changes with the camera mode)
    this.documentScene = new DocumentScene({
      scene: this.scene, get camera() { return viewer.camera; }, canvas: this.renderer.domElement, host: (el.closest('.stage') as HTMLElement | null) ?? el, store: this.store,
      background: this.scene.background as THREE.Color,
      loadGeometry: path => this.loadGeometry(path),
      renderer: this.renderer,
      environment: () => this.reflections(),
      zGridMode: () => this.zGridMode(),
      viewCenter: () => ({ x: this.controls.target.x, y: this.controls.target.y }),
      rotationStep: () => this.rotationStep(),
      setOrbitEnabled: enabled => { this.controls.enabled = enabled; },
      changed: () => this.onDocumentChanged(),
    });
    // ⌘-click centres the view on the clicked point. Registered before OrbitControls so it can swallow the click.
    this.renderer.domElement.addEventListener('pointerdown', this.onCentreClick);
    this.stageEl = (el.closest('.stage') as HTMLElement | null) ?? el;
    this.stageEl.addEventListener('keydown', this.onFlightKey);
    this.stageEl.addEventListener('keydown', this.onViewKey);
    this.renderer.domElement.addEventListener('pointerdown', this.stopFlight); // grabbing the view takes over from the fly-around
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.scheduleSaveView());
    this.applyCameraMode(); // start in the saved mode (controls exist now)
    // Trackpad like Fusion 360: two-finger scroll pans, pinch zooms (towards the cursor). OrbitControls keeps rotate (drag).
    this.controls.enableZoom = false;
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.resize())); // rAF avoids the "ResizeObserver loop" warning
    this.ro.observe(el);
    this.resize();
    this.renderer.autoClear = false;
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.stepSnapAnimation();
      this.stepPanAnimation();
      this.stepViewAnimation();
      this.stepPivot();
      this.stepFlight();
      this.stepTurntablePreview();
      this.updatePathLine();
      this.updateCentreCross();
      this.updateAutoProjection();
      this.keepPerspectiveNatural();
      this.documentScene.tick();
      this.controls.update();
      this.publishPose();
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.viewCube.render(this.renderer, this.camera, this.controls.target);
    };
    loop();
  }

  /**
   * The camera of this view for the Blender export: `dx,dy,dz;tx,ty,tz;height;projection[;fov]` (viewing direction from the centre to the camera,
   * view centre in mm, visible height at the centre in mm, `persp` or `ortho`). Null outside the document view.
   */
  readonly viewParam = (): string | null => {
    if (!this.documentMode()) return null;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const target = this.controls.target;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    // A zoomed-in perspective view has a narrower field of view than the camera's own, and so has a picture that is only the framed part of the view:
    // send the effective one (the camera stays where it is, only the angle narrows), so the picture looks the same.
    const share = this.pictureHeight() / this.viewHeight();
    const fov = this.camera instanceof THREE.PerspectiveCamera ? `;${round((2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.camera.zoom) * share)) * (180 / Math.PI))}` : '';
    return `${[direction.x, direction.y, direction.z].map(round)};${[target.x, target.y, target.z].map(round)};${round(this.pictureHeight())};${this.projection}${fov}`;
  };

  /** The light of the "Shaded with light" view for the Blender export: `dx,dy,dz;tx,ty,tz` (direction towards the light, the point it shines at, mm); null in the other views. */
  readonly lightParam = (): string | null => {
    if (!this.documentMode() || this.mode() !== 'shaded') return null;
    this.updateShadowRig(); // lightAtNow follows the scene
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const at = this.lightAtNow;
    return `${[this.lightDir.x, this.lightDir.y, this.lightDir.z].map(round)};${[at.x, at.y, at.z].map(round)}`;
  };

  protected toggleFlight() {
    if (this.turntablePreview()) { this.pauseTurntablePreview(); return; } // Space: pause, and again: go on
    if (this.flying()) { this.flying.set(false); return; }
    if (!this.documentMode() || !this.documentScene.bounds()) return;
    this.snapAnimation = null; this.panAnimation = null; this.pivotGoal = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.flightAzimuth0 = Math.atan2(offset.y, offset.x);
    this.flightTime = 0;
    this.userZoom = 1;
    this.flightZoomSet = this.camera.zoom;
    this.flightLast = performance.now();
    this.flying.set(true);
  }

  /**
   * The turntable of the video, live in the 3D view: the camera circles the point it looks at (about the upright line through it, at its own height), or the
   * parts turn about the middle of their footprint in front of the camera. One turn takes the length of the video; it loops until something is clicked.
   */
  protected readonly turnDirections = turnDirections;

  protected startTurntablePreview(motion: 'orbit' | 'spin') {
    if (!this.documentMode() || !this.documentScene.bounds()) return;
    this.stopTurntablePreview();
    this.flying.set(false);
    this.snapAnimation = null; this.panAnimation = null; this.pivotGoal = null;
    this.controls.update();
    const { pivot, aim } = this.previewPivot(motion);
    this.targetOnPart = !!aim;
    if (aim) this.controls.target.copy(aim); // a tracked part is looked at whatever the camera goes round
    this.previewState = { last: performance.now(), angle: 0, pivot, aim };
    this.turntablePaused.set(false);
    this.turntablePreview.set({ motion });
  }

  /** What the preview turns about, and what the camera keeps looking at (the tracked part, or none): from the Camera circles setting and the tracked part. */
  private previewPivot(motion: 'orbit' | 'spin'): { pivot: THREE.Vector3; aim: THREE.Vector3 | null } {
    const bounds = this.documentScene.bounds()!;
    const middle = bounds.getCenter(new THREE.Vector3());
    const tracked = this.renderSettings.tracked();
    const centre = tracked ? this.documentScene.itemCenter(tracked.id) : null;
    const looksAt = this.renderSettings.lookAt();
    const aim = looksAt === 'part' ? centre : looksAt === 'all' ? middle : null;
    if (motion === 'spin') return { pivot: new THREE.Vector3(middle.x, middle.y, bounds.min.z), aim }; // the parts turn, the camera stays where the view is (and may look at a part)
    if (!this.targetOnPart) this.viewTarget = this.controls.target.clone(); // the middle of the view as you set it (a tracked part takes the camera's target, not this)
    const viewTarget = this.viewTarget ?? this.controls.target;
    const forward = viewTarget.clone().sub(this.camera.position).normalize();
    const lookedAt = this.camera.position.clone().addScaledVector(forward, Math.max(middle.clone().sub(this.camera.position).dot(forward), 1)); // the point the view looks at (as in the render): parts elsewhere in the picture fly by
    const goesRound = this.renderSettings.trackPivot();
    return { pivot: goesRound === 'part' && centre ? centre : goesRound === 'view' ? lookedAt : middle, aim };
  }

  /** The setting (or the tracked part) was changed while the camera circles: it goes on round the new centre from where it is. */
  private viewTarget: THREE.Vector3 | null = null;
  private targetOnPart = false;

  private refreshPreviewPivot() {
    const state = this.previewState, preview = this.turntablePreview();
    if (!state || !preview || !this.documentScene.bounds()) return;
    const { pivot, aim } = this.previewPivot(preview.motion);
    state.pivot = pivot;
    state.aim = aim;
    if (aim) { this.targetOnPart = true; this.controls.target.copy(aim); }
    else if (this.targetOnPart && this.viewTarget) { this.targetOnPart = false; this.controls.target.copy(this.viewTarget); } // back to looking where the view looked
  }

  /** Click a part to make the camera of Camera circles go round it and keep it in the middle (the part under the pointer is outlined; Esc cancels). */
  protected startTrackPick() {
    this.store.trackPickFromDialog = false;
    this.store.trackPick.set(true);
  }

  protected pauseTurntablePreview() {
    if (!this.previewState) return;
    const paused = !this.turntablePaused();
    this.turntablePaused.set(paused);
    if (!paused) this.previewState.last = performance.now(); // going on from where it stood: no jump for the time it was paused
  }

  protected stopTurntablePreview() {
    if (!this.previewState) return;
    this.previewState = null;
    this.turntablePaused.set(false);
    this.turntablePreview.set(null);
    this.documentScene.group.rotation.set(0, 0, 0); // the parts that turned stand as they did; a camera that circled stays where you left it
    this.documentScene.group.position.set(0, 0, 0);
  }

  /** Every frame the camera (or the parts) turns a little further; what you change meanwhile (the view cube, dragging, zooming) stays, and the turning goes on from there. */
  private stepTurntablePreview() {
    const state = this.previewState, preview = this.turntablePreview();
    if (!state || !preview) return;
    if (!this.documentMode()) { this.stopTurntablePreview(); return; }
    if (this.turntablePaused()) return;
    const now = performance.now();
    const step = Math.min((now - state.last) / 1000, 0.1) / this.renderSettings.turntable().seconds * Math.PI * 2 * (this.renderSettings.turntable().direction === 'cw' ? -1 : 1);
    state.last = now;
    state.angle += step;
    if (preview.motion === 'orbit') {
      const cos = Math.cos(step), sin = Math.sin(step), pivot = state.pivot;
      const points = state.aim ? [this.camera.position] : [this.camera.position, this.controls.target];
      if (state.aim && this.viewTarget) points.push(this.viewTarget); // the middle of the view turns along, so "the view" stays what it was
      for (const point of points) {
        const x = point.x - pivot.x, y = point.y - pivot.y;
        point.x = pivot.x + cos * x - sin * y;
        point.y = pivot.y + sin * x + cos * y;
      }
      if (state.aim) this.controls.target.copy(state.aim); // the tracked part stays what the camera looks at
    } else {
      const angle = -state.angle; // the parts turn clockwise: the scene then appears to go round the same way as when the camera circles counter-clockwise
      const cos = Math.cos(angle), sin = Math.sin(angle);
      this.documentScene.group.rotation.z = angle;
      this.documentScene.group.position.set(state.pivot.x - (cos * state.pivot.x - sin * state.pivot.y), state.pivot.y - (sin * state.pivot.x + cos * state.pivot.y), 0);
      if (state.aim) { // the camera stays and looks at the part (or the middle of the parts) as it turns with them
        const x = state.aim.x - state.pivot.x, y = state.aim.y - state.pivot.y;
        this.controls.target.set(state.pivot.x + cos * x - sin * y, state.pivot.y + sin * x + cos * y, state.aim.z);
      }
    }
  }

  /** The fly-around path: where the camera wants to be `t` seconds into the flight (viewing direction, view centre, zoom relative to the fit). */
  private flightPose(t: number, azimuth0: number, bounds: THREE.Box3) {
    const size = bounds.getSize(new THREE.Vector3());
    // Every frequency is a whole multiple of w (one loop = flightLoopSeconds), so the path closes perfectly: 4 turns, then it repeats.
    const w = (2 * Math.PI) / flightLoopSeconds;
    const azimuth = azimuth0 + t * 4 * w; // one turn per 70 s
    const elevation = THREE.MathUtils.degToRad(38 + 26 * Math.sin(t * 6 * w + 0.8) + 8 * Math.sin(t * 14 * w));
    const direction = new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation));
    const centre = bounds.getCenter(new THREE.Vector3()).add(new THREE.Vector3(
      size.x * 0.16 * Math.sin(t * 8 * w), size.y * 0.16 * Math.cos(t * 5 * w), size.z * 0.2 * Math.sin(t * 10 * w)));
    return { direction, centre, zoomFactor: 1 + 0.45 * (0.5 + 0.5 * Math.sin(t * 9 * w - 1)) };
  }

  protected resetFlightZoom() {
    this.userZoom = 1;
  }

  protected toggleShowPath() {
    const on = !this.showPath();
    this.showPath.set(on);
    try { localStorage.setItem(showPathStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.cubeMenu.set(null);
  }

  /** Draws the camera path as a line (the orbit's shape, not the camera's real distance): the whole closed loop (280 s) starting from the current moment while flying, otherwise a preview from the current view direction. */
  private updatePathLine() {
    const bounds = this.documentMode() ? this.documentScene.bounds() : null;
    if (!this.showPath() || !bounds) {
      if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine = null; }
      if (this.cameraBody) { this.scene.remove(this.cameraBody); this.cameraBody.geometry.dispose(); this.cameraBody = null; }
      return;
    }
    this.radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 60);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const azimuth0 = this.flying() ? this.flightAzimuth0 : Math.atan2(offset.y, offset.x);
    const from = this.flying() ? this.flightTime : 0;
    const distance = this.radius * 1.25; // drawn as an orbit around the assembly (the real camera sits much further out, which would be off screen)
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= flightLoopSeconds * 2; i++) { // every 0.5 s; the last point equals the first, so the line is closed
      const pose = this.flightPose(from + i * 0.5, azimuth0, bounds);
      points.push(pose.centre.addScaledVector(pose.direction, distance));
    }
    if (!this.pathLine) {
      this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.9 }));
      this.pathLine.renderOrder = 10;
      this.pathLine.frustumCulled = false;
      this.scene.add(this.pathLine);
    }
    this.pathLine.geometry.setFromPoints(points);
    this.updateCameraBody(this.flightPose(from, azimuth0, bounds), distance);
  }

  /** A Blender-style camera outline (pyramid, frame and "up" triangle) at the current point of the path, looking at the view centre. */
  private updateCameraBody(pose: { direction: THREE.Vector3; centre: THREE.Vector3 }, distance: number) {
    if (!this.cameraBody) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(22 * 3), 3));
      this.cameraBody = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false }));
      this.cameraBody.renderOrder = 11;
      this.cameraBody.frustumCulled = false;
      this.scene.add(this.cameraBody);
    }
    const apex = pose.centre.clone().addScaledVector(pose.direction, distance);
    const forward = pose.direction.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 0, 1)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const el = this.host().nativeElement;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const depth = this.radius * 0.16, hh = depth * 0.45, hw = hh * aspect;
    const corner = (sx: number, sy: number) => apex.clone().addScaledVector(forward, depth).addScaledVector(right, sx * hw).addScaledVector(up, sy * hh);
    const bl = corner(-1, -1), br = corner(1, -1), tr = corner(1, 1), tl = corner(-1, 1);
    const peak = apex.clone().addScaledVector(forward, depth).addScaledVector(up, hh * 1.6);
    const v = [apex, bl, apex, br, apex, tr, apex, tl, bl, br, br, tr, tr, tl, tl, bl, tl, peak, peak, tr];
    const attr = this.cameraBody.geometry.getAttribute('position') as THREE.BufferAttribute;
    v.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
    attr.needsUpdate = true;
    this.cameraBody.geometry.setDrawRange(0, v.length);
  }

  /**
   * One frame of the fly-around. The wanted view is a sum of slow sines with unrelated periods, so the path keeps changing and
   * covers the assembly from the sides, the top and a low angle; the real camera eases towards it (which also blends in and out smoothly).
   * The zoom is relative to the fit for the current direction, so the whole assembly stays in view.
   */
  private stepFlight() {
    if (!this.flying()) return;
    const bounds = this.documentScene.bounds();
    if (!this.documentMode() || !bounds) { this.flying.set(false); return; }
    const now = performance.now();
    const dt = Math.min((now - this.flightLast) / 1000, 0.1);
    this.flightLast = now;
    this.flightTime += dt;
    const t = this.flightTime;
    const size = bounds.getSize(new THREE.Vector3());
    this.radius = Math.max(size.length() / 2, 60);

    const { direction, centre, zoomFactor } = this.flightPose(t, this.flightAzimuth0, bounds);
    const zoom = this.fitZoom(size, direction) * zoomFactor;

    const k = 1 - Math.exp(-dt * 1.5);
    const current = this.camera.position.clone().sub(this.controls.target);
    const heading = current.lengthSq() > 1e-6 ? current.normalize() : direction.clone();
    heading.lerp(direction, k).normalize();
    this.controls.target.lerp(centre, k);
    if (this.flightZoomSet > 0 && Math.abs(this.camera.zoom / this.flightZoomSet - 1) > 1e-6) this.userZoom *= this.camera.zoom / this.flightZoomSet; // changed by the wheel
    this.camera.zoom += (zoom * this.userZoom - this.camera.zoom) * k;
    this.flightZoomSet = this.camera.zoom;
    this.camera.position.copy(this.controls.target).addScaledVector(heading, this.fitDistance());
    this.camera.updateProjectionMatrix();
  }

  /** Animate the camera to look at the model from `direction` (unit vector model -> camera). */
  private snapTo(direction: THREE.Vector3) {
    this.touchView();
    const dir = direction.clone();
    // Straight down/up the Z axis would make lookAt degenerate with Z-up; tilt a hair so +Y stays "up" on screen.
    if (Math.abs(dir.z) > 0.999) dir.y = -0.001 * Math.sign(dir.z);
    dir.normalize();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from = offset.clone().normalize();
    this.snapAnimation = { from, rotation: new THREE.Quaternion().setFromUnitVectors(from, dir), start: performance.now(), distance: offset.length() };
  }

  /** The arrows round the view cube: a step to the next face (tilt up or down, turn left or right) or a 45° turn about the vertical axis; the view keeps Z up. */
  protected stepView(step: 'up' | 'down' | 'left' | 'right' | 'ccw' | 'cw') {
    this.touchView();
    this.panAnimation = null; this.pivotGoal = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = offset.length();
    if (distance < 1e-6) return;
    const quarter = Math.PI / 2, eighth = Math.PI / 4, epsilon = 1e-4;
    let azimuth = Math.atan2(offset.y, offset.x);
    let elevation = Math.asin(THREE.MathUtils.clamp(offset.z / distance, -1, 1));
    const next = (value: number, direction: 1 | -1, size: number) => (direction > 0 ? Math.floor((value + epsilon) / size + 1) : Math.ceil((value - epsilon) / size - 1)) * size; // the next multiple of `size` in that direction
    if (step === 'up' || step === 'down') elevation = THREE.MathUtils.clamp(next(elevation, step === 'up' ? 1 : -1, quarter), -quarter, quarter);
    else if (step === 'left' || step === 'right') azimuth = next(azimuth, step === 'right' ? 1 : -1, quarter);
    else azimuth = next(azimuth, step === 'ccw' ? 1 : -1, eighth);
    const hair = 0.001; // straight over the object Z-up has no screen direction: keep a hair off the pole, on the side that sets it
    const flat = Math.min(Math.abs(elevation), quarter - hair) * Math.sign(elevation || 1);
    const target = new THREE.Vector3(Math.cos(flat) * Math.cos(azimuth), Math.cos(flat) * Math.sin(azimuth), Math.sin(flat));
    const from = offset.clone().normalize();
    this.snapAnimation = { from, rotation: new THREE.Quaternion().setFromUnitVectors(from, target), start: performance.now(), distance };
  }

  goHome() {
    this.touchView();
    if (this.documentMode()) this.fitDocument();
    this.snapTo(this.homeDirection);
  }

  private async loadGeometry(path: string) {
    const buffer = await firstValueFrom(this.library.loadStl(path));
    return new STLLoader().parse(buffer);
  }

  /** Reads the STL files of the document's parts again from the library. */
  reloadDocumentParts() {
    if (this.ready()) this.documentScene.reloadGeometries();
  }

  /** Adds a library STL to the document (see DocumentScene.addObject). */
  addObject(path: string) {
    return this.documentScene.addObject(path);
  }

  /** Adds several library STLs next to each other as one undo step. */
  addObjects(paths: string[]) {
    return this.documentScene.addObjects(paths);
  }

  private enterMode(documentMode: boolean) {
    this.model.visible = !documentMode;
    this.documentScene.setActive(documentMode);
    this.gridKey = '';
    if (documentMode) {
      this.needsDocumentFit = true;
      this.onDocumentChanged();
    } else if (this.geometry) {
      const size = new THREE.Box3().setFromBufferAttribute(this.geometry.getAttribute('position') as THREE.BufferAttribute).getSize(new THREE.Vector3());
      this.buildGrid(new THREE.Vector3(0, 0, 0), size, size.z);
      // Back to the previewed model: re-centre on it, keeping the viewing direction.
      this.radius = this.geometry.boundingSphere?.radius ?? this.radius;
      const direction = this.camera.position.clone().sub(this.controls.target).normalize();
      const zoom = this.fitZoom(size, direction);
      this.controls.target.copy(size).multiplyScalar(0.5);
      this.camera.position.copy(this.controls.target).add(direction.multiplyScalar(this.fitDistance()));
      this.camera.zoom = zoom;
      this.resize();
    }
  }

  /** Size of the selection's box, the volume of the parts and a name, e.g. `15.3 × 15.3 × 44.0 mm · 8.1 cm³ · BOLT_S8` (the name last: it is the long part). */
  private updateSelectionInfo() {
    const items = this.store.selectedItems();
    const box = this.documentMode() && items.length ? this.documentScene?.selectionBounds() : null;
    if (!box) { this.selectionInfo.set(''); return; }
    const size = box.getSize(new THREE.Vector3());
    const stats = this.store.partStats();
    const volume = items.reduce((sum, item) => sum + (stats[item.path]?.volumeCm3 ?? 0), 0);
    const label = items.length === 1 ? items[0].name : `${items.length} selected`;
    this.selectionInfo.set(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm${volume ? ` · ${volume.toFixed(1)} cm³` : ''} · ${label}`);
  }

  /** Document grid follows the items; the camera fits once the first geometry has arrived. */
  private onDocumentChanged() {
    if (!this.documentMode() || !this.ready()) return;
    const bounds = this.documentScene.bounds();
    const count = this.store.doc().items.length;
    this.updateShadowRig();
    if (count > this.lastItemCount) this.needsDocumentFit = true; // a new object: make sure it is in view
    this.lastItemCount = count;
    this.updateSelectionInfo();
    this.info.set(count ? `${count} object${count === 1 ? '' : 's'}${bounds ? ` · ${(bounds.max.x - bounds.min.x).toFixed(0)} × ${(bounds.max.y - bounds.min.y).toFixed(0)} × ${(bounds.max.z - bounds.min.z).toFixed(0)} mm` : ''}` : 'Empty document');
    const key = bounds ? `${bounds.min.toArray()}|${bounds.max.toArray()}` : 'empty';
    if (key !== this.gridKey) {
      this.gridKey = key;
      const fallback = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12 * gridCellMm, 8 * gridCellMm, 0));
      const area = bounds ? bounds.clone().union(fallback) : fallback;
      this.buildGrid(area.min, area.max, bounds ? bounds.max.z : 0);
    }
    if (this.needsDocumentFit && this.documentScene.readyCount() === count && count > 0) {
      this.needsDocumentFit = false;
      const restore = this.restoreSavedView;
      this.restoreSavedView = false;
      if (!(restore && this.restoreView())) this.fitDocument();
    }
  }

  /** The view of the open document (where the camera is, its zoom) is kept in the document file and in local storage, so a reload shows the document as it was left. */
  private lastPose = '';

  /** The camera as it is, for the Views panel (it marks the saved view the camera is on, or has left): every frame, but only said when it changed. */
  private publishPose() {
    if (!this.documentMode() || !this.ready()) return;
    const p = this.camera.position, t = this.controls.target;
    const key = `${this.projection},${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)},${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)},${this.camera.zoom.toFixed(4)}`;
    if (key === this.lastPose) return;
    this.lastPose = key;
    this.store.livePose.set({ projection: this.projection, position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], zoom: this.camera.zoom, radius: this.radius });
  }

  /** The fly-around moves, or the turntable preview plays (not while it is paused). */
  private animationRunning() { return this.flying() || (!!this.turntablePreview() && !this.turntablePaused()); }

  private scheduleSaveView() {
    const id = this.store.docId();
    if (!id || !this.documentMode() || !this.ready() || this.restoreSavedView || this.needsDocumentFit) return; // not before the document has been put in view
    if (this.animationRunning()) return; // an animation moves the camera (or the parts): the document keeps the view it had; the Views panel shows it as changed
    if (Date.now() - this.viewTouchedAt > 4000) return; // the camera moved by itself (the fit on opening, a flight): nothing to keep
    clearTimeout(this.saveViewTimer);
    this.saveViewTimer = setTimeout(() => this.saveView(id), 400);
  }

  private saveView(id: string) {
    if (id !== this.store.docId() || !this.documentMode()) return;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const view: DocView = {
      projection: this.projection,
      position: this.camera.position.toArray().map(round) as Vec3, target: this.controls.target.toArray().map(round) as Vec3, zoom: round(this.camera.zoom),
      radius: round(this.radius),
    };
    this.store.setView(view); // in the document file, for every browser
    try { localStorage.setItem(viewStoragePrefix + id, JSON.stringify(view)); } catch { /* storage unavailable */ } // and here, in case the document cannot be saved
  }

  /** Puts the camera where the user left it with this document; false when there is no saved view (or it was made with the other camera). */
  private restoreView(): boolean {
    const id = this.store.docId();
    if (!id) return false;
    try {
      const saved = this.store.doc().view ?? JSON.parse(localStorage.getItem(viewStoragePrefix + id) ?? 'null'); // the document's own view first
      const vector = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n));
      if (!saved || saved.projection !== this.projection || !vector(saved.position) || !vector(saved.target) || !Number.isFinite(saved.zoom) || !(saved.zoom > 0) || !(saved.radius > 0)) return false;
      this.radius = saved.radius;
      this.controls.target.set(...(saved.target as [number, number, number]));
      this.camera.position.set(...(saved.position as [number, number, number]));
      this.camera.zoom = saved.zoom;
      this.controls.update();
      this.resize();
      return true;
    } catch {
      return false;
    }
  }

  /** The Fit all button: every object of the document in view, as large as fits, from the angle the user has set. */
  fitAll() {
    this.touchView();
    this.panAnimation = null;
    this.snapAnimation = null;
    this.pivotGoal = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const direction = offset.lengthSq() > 1e-6 ? offset.normalize() : this.homeDirection.clone();
    const forward = direction.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 0, 1));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const extent = this.documentScene.projectedExtent(right, up);
    if (!extent) { this.fitDocument(); return; }
    // a first guess from the outline on a flat screen ...
    const size = extent.box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.length() / 2, 60);
    const centre = extent.box.getCenter(new THREE.Vector3());
    centre.addScaledVector(right, (extent.minU + extent.maxU) / 2 - centre.dot(right)).addScaledVector(up, (extent.minV + extent.maxV) / 2 - centre.dot(up));
    const el = this.host().nativeElement;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const needed = Math.max((extent.maxV - extent.minV) / 2, (extent.maxU - extent.minU) / 2 / aspect, 1) * fitAllMargin;
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, this.fitDistance());
    this.camera.zoom = Math.min(Math.max((this.radius * 1.3) / needed, 0.05), 60);
    this.resize();
    // ... then corrected with what the camera really shows (a perspective camera shows what is nearer larger): the parts are projected, the view is
    // moved so their outline is in the middle of the screen, and zoomed so it nearly reaches the edges. A few rounds settle it.
    const points = this.documentScene.worldPoints();
    const point = new THREE.Vector3();
    for (let round = 0; round < 6; round++) {
      this.controls.update();
      this.camera.updateMatrixWorld(true);
      this.camera.updateProjectionMatrix();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < points.length; i += 3) {
        point.set(points[i], points[i + 1], points[i + 2]).project(this.camera);
        if (!Number.isFinite(point.x) || point.z > 1) continue; // behind the camera
        if (point.x < minX) minX = point.x; if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y; if (point.y > maxY) maxY = point.y;
      }
      if (!Number.isFinite(minX)) break;
      const middleX = (minX + maxX) / 2, middleY = (minY + maxY) / 2;
      const halfX = (maxX - minX) / 2, halfY = (maxY - minY) / 2;
      if (Math.abs(middleX) < 0.004 && Math.abs(middleY) < 0.004 && Math.abs(Math.max(halfX, halfY) - 1 / fitAllMargin) < 0.006) break;
      // the visible half-size at the view centre, in mm, to turn the offset on the screen into a move of the view
      const visibleHalfHeight = this.viewHeight() / 2;
      const shift = right.clone().multiplyScalar(middleX * visibleHalfHeight * aspect).addScaledVector(up, middleY * visibleHalfHeight);
      this.controls.target.add(shift);
      this.camera.position.add(shift);
      this.camera.zoom = Math.min(Math.max(this.camera.zoom * Math.min((1 / fitAllMargin) / Math.max(halfX, 1e-4), (1 / fitAllMargin) / Math.max(halfY, 1e-4)), 0.05), 60);
    }
    this.controls.update();
    this.resize();
  }

  /** Re-centres the camera on the document without changing the viewing direction. */
  private fitDocument() {
    this.fitBounds(this.documentScene.bounds() ?? new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12 * gridCellMm, 8 * gridCellMm, 40)));
  }

  /** Centres the view on the box and zooms so it fills the view; the viewing direction stays. */
  private fitBounds(bounds: THREE.Box3, keepRadius = false, margin = fitMargin) {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    if (!keepRadius) this.radius = Math.max(size.length() / 2, 60); // zooming to a part keeps the document's, so the rest still lies inside the clipping range
    const offset = this.camera.position.clone().sub(this.controls.target);
    const direction = offset.lengthSq() > 1e-6 ? offset.normalize() : this.homeDirection.clone(); // no view yet: start isometric
    const zoom = this.fitZoom(size, direction, margin);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(direction.multiplyScalar(this.fitDistance()));
    this.camera.zoom = zoom;
    this.resize();
  }

  /**
   * Wheel events from a MacBook trackpad: two-finger scroll arrives as plain wheel events (pan), pinch as wheel with ctrlKey (zoom).
   * Alt/Option + wheel zooms too, for a mouse wheel.
   */
  private readonly onWheel = (e: WheelEvent) => {
    this.touchView();
    e.preventDefault();
    this.snapAnimation = null;
    this.panAnimation = null;
    const lineHeight = e.deltaMode === 1 ? 16 : 1; // Firefox reports mouse wheels in lines
    const dx = e.deltaX * lineHeight, dy = e.deltaY * lineHeight;
    if (e.ctrlKey || e.altKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
    else this.panByPixels(dx, dy);
  };

  /**
   * Moves the view so the scene follows the fingers. With natural scrolling a swipe up gives dy > 0 and a swipe right gives dx < 0,
   * so the camera (and its target) move by right * dx - up * dy.
   */
  private panByPixels(dx: number, dy: number) {
    const canvas = this.renderer.domElement;
    const worldPerPixel = this.viewHeight() / canvas.clientHeight;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const shift = right.multiplyScalar(dx * worldPerPixel).addScaledVector(up, -dy * worldPerPixel);
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.camera.updateMatrixWorld();
  }

  /** Zooms by `factor` keeping the point under the cursor fixed. */
  private zoomAt(clientX: number, clientY: number, factor: number) {
    this.camera.updateMatrixWorld(); // several wheel events can arrive between two renders
    const before = this.pointUnderCursor(clientX, clientY);
    this.camera.zoom = Math.min(Math.max(this.camera.zoom * factor, 0.05), 60);
    this.camera.updateProjectionMatrix();
    const shift = before.sub(this.pointUnderCursor(clientX, clientY));
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.camera.updateMatrixWorld();
  }

  /** World point under the cursor on the plane through the view centre, facing the camera. */
  private pointUnderCursor(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    this.pickRaycaster.setFromCamera(ndc, this.camera);
    const facing = this.camera.position.clone().sub(this.controls.target).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, this.controls.target);
    return this.pickRaycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.controls.target.clone();
  }

  /** ⌘-click: look at the clicked surface point (or, over empty space, the point on the plane through the current target). */
  private readonly onCentreClick = (e: PointerEvent) => {
    if (this.documentMode() && this.documentScene.gizmoGrabbed()) return; // a ring or arrow of the rotate / move tool was grabbed: the view stays where it is
    if (!e.metaKey) { // a plain left press that reached here starts a view rotation (nothing else claimed it)
      if (e.button === 0) this.pivotOnDrag(e); // only a drag turns the view; a plain click must not move it
      return;
    }
    if (e.button !== 0) return;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const inCube = e.clientX > rect.right - 150 - 12 && e.clientY < rect.top + 150 + 12; // ViewCube corner has its own clicks
    if (inCube) return;
    e.stopImmediatePropagation();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.pickRaycaster.setFromCamera(ndc, this.camera);
    const meshes: THREE.Object3D[] = this.model.visible ? [] : this.documentScene.pickableMeshes(); // muted parts don't catch clicks
    if (this.model.visible) this.model.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    const hit = this.pickRaycaster.intersectObjects(meshes, false)[0];
    let point: THREE.Vector3 | undefined = hit?.point;
    if (!point) {
      const facing = this.camera.position.clone().sub(this.controls.target).normalize();
      point = this.pickRaycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(facing, this.controls.target), new THREE.Vector3()) ?? undefined;
    }
    if (point) this.panTo(point);
  };

  /** Starts the pivot glide once the pointer has moved a few pixels with the button down (a click leaves the view alone). */
  private pivotOnDrag(down: PointerEvent) {
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
      cleanup();
      this.startPivot();
    };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', cleanup); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
  }

  /** A view rotation is starting: with a selection, make its centre the pivot (the view glides so it is centred). */
  private startPivot() {
    if (!this.pivotOnSelection() || !this.documentMode()) return;
    const centre = this.documentScene.selectionCenter();
    if (!centre) return;
    this.panAnimation = null;
    this.pivotGoal = centre;
  }

  /** Moves view centre and camera together towards the pivot, a bit each frame, without touching the camera's direction. */
  private stepPivot() {
    const goal = this.pivotGoal;
    if (!goal) return;
    const delta = goal.clone().sub(this.controls.target);
    if (delta.length() < 0.05) { this.camera.position.add(delta); this.controls.target.add(delta); this.pivotGoal = null; return; }
    delta.multiplyScalar(0.3);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
  }

  protected togglePivotOnSelection() {
    const on = !this.pivotOnSelection();
    this.pivotOnSelection.set(on);
    try { localStorage.setItem(pivotStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.cubeMenu.set(null);
  }

  /** Glide the view so `point` becomes the centre; direction and distance stay. */
  private panTo(point: THREE.Vector3) {
    this.snapAnimation = null;
    this.panAnimation = {
      offset: this.camera.position.clone().sub(this.controls.target),
      from: this.controls.target.clone(), to: point.clone(), start: performance.now(),
    };
  }

  /**
   * An SVG of what the camera shows, in the display mode that is selected: hidden lines removed or dashed and wireframe are vector drawings;
   * solid is the shaded picture inside an SVG. Answers the drawing with the mode it follows; null while there is nothing to draw.
   */
  viewSvg(): { svg: string; mode: ViewMode } | null {
    const mode = this.mode();
    if (!this.documentScene.readyCount()) return null;
    const shaded = mode === 'solid' || mode === 'solid-outline' || mode === 'shaded';
    const parts = shaded ? [] : this.documentScene.viewParts(mode === 'wireframe'); // the solid picture needs no line geometry
    this.controls.update(); // the camera as the user sees it now (the orbit controls apply their last move in their update)
    this.camera.updateProjectionMatrix();
    const canvas = this.renderer.domElement;
    const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
    const title = this.store.doc().name;
    if (!shaded) return { svg: buildViewSvg(this.renderer, this.camera, aspect, parts, { title, mode, grid: this.groundGrid() ? this.grid?.geometry : null }), mode };
    const showHelpers = this.documentScene.hideHelpers();
    const grid = this.grid, gridWas = grid?.visible; // the solid picture shows the ground grid when it is on (view cube menu)
    if (grid) grid.visible = this.groundGrid();
    try {
      const lightWas = this.lightGizmo.visible;
      this.lightGizmo.visible = false; // the light source is an editing aid, not part of the picture
      try { return { svg: buildImageSvg(this.renderer, this.scene, this.camera, aspect, { title }), mode }; } finally { this.lightGizmo.visible = lightWas; }
    } finally {
      showHelpers();
      if (grid && gridWas !== undefined) grid.visible = gridWas;
    }
  }

  /** "Show in assembly": centres the view on these parts and zooms to them. */
  showInAssembly(ids: readonly string[]) {
    const bounds = this.documentScene.boundsOf(ids);
    if (!bounds) return;
    this.flying.set(false);
    this.snapAnimation = null; this.panAnimation = null; this.pivotGoal = null;
    this.fitBounds(bounds, true);
  }

  /** The camera and display of this moment, for a saved view (null outside the document view or before anything is shown). */
  private captureView(): Omit<DocSavedView, 'id' | 'name'> | null {
    if (!this.documentMode() || !this.ready()) return null;
    this.controls.update();
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return {
      projection: this.projection,
      position: this.camera.position.toArray().map(round) as Vec3, target: this.controls.target.toArray().map(round) as Vec3, zoom: round(this.camera.zoom), radius: round(this.radius),
      mode: this.mode(), appMode: this.store.appMode(), light: this.store.doc().light ?? null,
      ground: this.groundMode(), groundColor: this.groundColor(), grid3d: this.grid3d(), zGrid: this.zGridMode(),
    };
  }

  /** Goes to a saved view: the display comes back at once, the camera glides there. */
  private recallView(view: DocSavedView) {
    if (!this.documentMode()) return;
    this.flying.set(false);
    this.snapAnimation = null; this.panAnimation = null; this.pivotGoal = null;
    this.touchView();
    if (view.appMode === 'design' || view.appMode === 'render') this.store.setAppMode(view.appMode); // first: Render mode takes no other display mode
    if (view.mode && view.mode !== this.mode()) this.modeRequest.emit(view.mode as ViewMode);
    if (view.light !== undefined && JSON.stringify(view.light ?? null) !== JSON.stringify(this.store.doc().light ?? null)) this.store.setLight(view.light ?? null);
    if (view.ground) this.groundMode.set(view.ground);
    if (typeof view.groundColor === 'number') this.groundColor.set(view.groundColor);
    if (typeof view.grid3d === 'boolean') this.grid3d.set(view.grid3d);
    if (view.zGrid && zGridModes.some(m => m.id === view.zGrid)) this.zGridMode.set(view.zGrid as ZGridMode);
    if (view.projection !== this.projection) {
      this.setProjection(view.projection);
      this.cameraMode.set(view.projection === 'persp' ? 'perspective' : 'orthographic');
      this.rememberCameraMode();
    }
    this.viewAnimation = {
      fromPosition: this.camera.position.clone(), toPosition: new THREE.Vector3(...view.position),
      fromTarget: this.controls.target.clone(), toTarget: new THREE.Vector3(...view.target),
      fromZoom: this.camera.zoom, toZoom: view.zoom, radius: view.radius, start: performance.now(),
    };
  }

  private viewAnimation: { fromPosition: THREE.Vector3; toPosition: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromZoom: number; toZoom: number; radius: number; start: number } | null = null;

  private stepViewAnimation() {
    const a = this.viewAnimation;
    if (!a) return;
    const t = Math.min((performance.now() - a.start) / 600, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.controls.target.lerpVectors(a.fromTarget, a.toTarget, eased);
    this.camera.position.lerpVectors(a.fromPosition, a.toPosition, eased);
    this.camera.zoom = a.fromZoom * Math.pow(a.toZoom / a.fromZoom, eased); // zoom is felt in ratios
    if (t >= 1) { this.radius = a.radius; this.viewAnimation = null; this.resize(); } else this.camera.updateProjectionMatrix();
    this.touchView();
  }

  /** Centres the view on a document item (double-click in the document list). */
  /** The cross on the middle of the objects was clicked: that point becomes the centre of the view (the direction and the zoom stay). */
  protected centreOnObjects() {
    const box = this.documentScene.bounds();
    if (box) this.panTo(box.getCenter(new THREE.Vector3()));
  }

  centerOnItem(id: string) {
    const center = this.documentScene.itemCenter(id);
    if (center) this.panTo(center);
  }

  private stepPanAnimation() {
    const a = this.panAnimation;
    if (!a) return;
    const t = Math.min((performance.now() - a.start) / 250, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.controls.target.lerpVectors(a.from, a.to, eased);
    this.camera.position.copy(this.controls.target).add(a.offset); // same direction and distance, new centre
    if (t >= 1) this.panAnimation = null;
  }

  private stepSnapAnimation() {
    const a = this.snapAnimation;
    if (!a) return;
    const t = Math.min((performance.now() - a.start) / 350, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const q = new THREE.Quaternion().slerp(a.rotation, eased);
    this.camera.position.copy(this.controls.target).add(a.from.clone().applyQuaternion(q).multiplyScalar(a.distance));
    if (t >= 1) this.snapAnimation = null;
  }

  /** Drag on the cube: azimuth around world Z, elevation clamped short of the poles. */
  private orbitBy(dx: number, dy: number) {
    this.snapAnimation = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const r = offset.length();
    const azimuth = Math.atan2(offset.y, offset.x) - dx * 0.01;
    const limit = Math.PI / 2 - 0.02;
    const elevation = Math.max(-limit, Math.min(limit, Math.asin(offset.z / r) + dy * 0.01));
    offset.set(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)).multiplyScalar(r);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  private readonly cross = viewChild<ElementRef<HTMLElement>>('cross');
  private readonly crossPoint = new THREE.Vector3();

  /** A thin cross on the middle of the box round all the objects (what Camera circles goes round by default): in Design mode always, in Render mode with the picture frame. */
  private objectsBox: THREE.Box3Helper | null = null;

  private updateCentreCross() {
    const element = this.cross()?.nativeElement;
    if (!element) return;
    const bounds = this.documentMode() ? this.documentScene.bounds() : null;
    const render = this.store.appMode() === 'render';
    const box = render ? bounds : null; // the outline is for Render mode
    const outline = box && this.renderSettings.showBox();
    const mark = bounds && (!render || this.renderSettings.showFrame()) ? bounds : null; // the cross is in Design mode too; in Render mode it goes with the frame
    if (outline && !this.objectsBox) { // the outline round the sum of all the objects
      this.objectsBox = new THREE.Box3Helper(new THREE.Box3(), 0xffffff);
      const material = this.objectsBox.material as THREE.LineBasicMaterial;
      Object.assign(material, { transparent: true, opacity: 0.55, depthTest: false });
      this.objectsBox.renderOrder = 10;
      this.scene.add(this.objectsBox);
    }
    if (this.objectsBox) {
      this.objectsBox.visible = !!outline;
      if (outline) this.objectsBox.box.copy(box!);
    }
    element.hidden = !mark;
    if (!mark) return;
    this.crossPoint.copy(mark.getCenter(this.crossPoint)).project(this.camera);
    const { w, h } = this.viewSize();
    element.style.transform = `translate(${((this.crossPoint.x + 1) / 2) * w}px, ${((1 - this.crossPoint.y) / 2) * h}px)`;
    element.hidden = this.crossPoint.z > 1; // behind the camera
  }

  protected readonly transformClosed = signal((() => { try { return localStorage.getItem('rasterfaster.transformPanel') === 'closed'; } catch { return false; } })());

  protected toggleTransform() {
    const closed = !this.transformClosed();
    this.transformClosed.set(closed);
    try { localStorage.setItem('rasterfaster.transformPanel', closed ? 'closed' : 'open'); } catch { /* storage unavailable */ }
  }

  private readonly viewSize = signal({ w: 0, h: 0 });

  /** The picture the render makes, as a rectangle in the view: the largest one of the chosen shape that fits with a little room around it. */
  private frameRect(): { x: number; y: number; w: number; h: number } | null {
    const { w, h } = this.viewSize();
    if (!w || !h) return null;
    const ratio = aspectRatio(this.renderSettings.aspect());
    const fit = Math.min((w * 0.94) / ratio, h * 0.94);
    return { x: (w - fit * ratio) / 2, y: (h - fit) / 2, w: fit * ratio, h: fit };
  }

  /** Drawn over the view in Render mode: what part of the view is in the picture. */
  protected readonly pictureFrame = computed(() => this.documentMode() && this.store.appMode() === 'render' && this.renderSettings.showFrame() ? this.frameRect() : null);

  private resize() {
    const el = this.host().nativeElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.viewSize.set({ w, h });
    this.renderer.setSize(w, h, false);
    const aspect = w / h, s = this.radius * 1.3;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = aspect;
      this.camera.near = Math.max(1, this.radius * 0.05);
      this.camera.far = Math.max(10000, this.radius * 200);
    } else {
      Object.assign(this.camera, { left: -s * aspect, right: s * aspect, top: s, bottom: -s });
    }
    this.camera.updateProjectionMatrix();
  }

  /**
   * The zoom at which a box (`size` mm across, centred on the view centre) fills the view along `direction` with `fitMargin` to spare.
   * It uses the box's real extent as seen from that direction (not its bounding sphere) and the window's aspect ratio.
   */
  private fitZoom(size: THREE.Vector3, direction: THREE.Vector3, margin = fitMargin) {
    const forward = direction.clone().negate(); // from the camera towards the centre
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 0, 1));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // looking straight down or up
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    let halfWidth = 0, halfHeight = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const corner = new THREE.Vector3((sx * size.x) / 2, (sy * size.y) / 2, (sz * size.z) / 2);
      halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
      halfHeight = Math.max(halfHeight, Math.abs(corner.dot(up)));
    }
    const el = this.host().nativeElement;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const needed = Math.max(halfHeight, halfWidth / aspect, 1) * margin;
    return Math.min(Math.max((this.radius * 1.3) / needed, 0.05), 60); // the frustum at zoom 1 is radius * 1.3 high
  }

  /** How high the picture of the render is in the world, in mm: the height of the frame drawn over the view. */
  private pictureHeight() {
    const frame = this.frameRect(), { h } = this.viewSize();
    return frame && h ? this.viewHeight() * (frame.h / h) : this.viewHeight();
  }

  /** Height of the world that is visible at the view centre, in mm (the same measure for both cameras). */
  private viewHeight() {
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const distance = this.camera.position.distanceTo(this.controls.target);
      return (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.camera.zoom;
    }
    return (this.camera.top - this.camera.bottom) / this.camera.zoom;
  }

  /** How far the camera sits from the view centre so that the model fills the view the same way in both projections. */
  private fitDistance() {
    return this.projection === 'persp'
      ? (this.radius * 1.3) / Math.tan(THREE.MathUtils.degToRad(perspectiveFovDegrees / 2))
      : this.radius * 4;
  }

  /**
   * Switches between the orthographic and the perspective camera. The apparent size at the view centre and the viewing direction
   * stay the same, so the model does not jump when the projection changes.
   */
  private setProjection(kind: 'ortho' | 'persp') {
    this.touchView();
    if (kind === this.projection) return;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const direction = offset.lengthSq() > 1e-6 ? offset.clone().normalize() : this.homeDirection.clone();
    this.resize(); // the frustum follows the model's size (the radius): after a document or view was loaded it can be stale, which would distort the switch
    const halfHeight = this.viewHeight() / 2;
    const next = kind === 'persp' ? this.perspectiveCamera : this.orthoCamera;
    next.up.copy(this.camera.up);
    if (kind === 'persp') {
      const natural = halfHeight / Math.tan(THREE.MathUtils.degToRad(perspectiveFovDegrees / 2)); // the distance that gives the same visible size at the centre
      const distance = Math.max(natural, this.fitDistance()); // a zoomed-in view must not put the camera right next to the parts: narrow the lens instead
      next.zoom = distance / natural;
      next.position.copy(target).add(direction.multiplyScalar(distance));
    } else {
      next.zoom = (this.radius * 1.3) / halfHeight; // visible half height = frustum half height / zoom
      next.position.copy(target).add(direction.multiplyScalar(Math.max(offset.length(), 1)));
    }
    this.camera = next;
    this.projection = kind;
    this.controls.object = next;
    next.lookAt(target);
    next.updateMatrixWorld();
    this.resize();
  }

  /** Applies the chosen camera mode (explicit projection, or the automatic one for "perspective with ortho faces"). */
  private applyCameraMode() {
    const mode = this.cameraMode();
    if (mode === 'orthographic') this.setProjection('ortho');
    else if (mode === 'perspective') this.setProjection('persp');
    else this.updateAutoProjection();
  }

  /** "Perspective with ortho faces": orthographic while the view looks straight along an axis (a cube face), perspective otherwise. */
  /**
   * A perspective camera zoomed out below 1 would only widen its lens (a fish-eye with an extreme perspective, the parts near the camera huge).
   * Zooming out moves the camera back instead, with the same picture: the visible size at the centre stays, the lens stays at its natural angle.
   */
  private keepPerspectiveNatural() {
    if (this.projection !== 'persp' || this.camera.zoom >= 1 - 1e-6) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.lengthSq() < 1e-9) return;
    const far = offset.length() / this.camera.zoom; // d / zoom: the same visible height at the centre
    const limit = this.fitDistance() * 20; // as far out as the old zoom limit (a twentieth) allowed; beyond it zooming out stops
    this.camera.position.copy(this.controls.target).add(offset.setLength(Math.max(Math.min(far, limit), offset.length())));
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
  }

  private updateAutoProjection() {
    if (this.cameraMode() !== 'perspective-ortho-faces') return;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const alongAxis = Math.max(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)) > 0.99995;
    this.setProjection(alongAxis ? 'ortho' : 'persp');
  }

  /** The camera mode is kept in the document for the mode (Design or Render) that is on, and as the browser's last choice (for documents that have none). */
  private rememberCameraMode() {
    const mode = this.cameraMode();
    try { localStorage.setItem(cameraModeStorageKey, mode); } catch { /* storage unavailable */ }
    if (!this.documentMode()) return;
    this.store.setCameraModes({ ...this.store.doc().cameraModes, [this.store.appMode()]: mode });
  }

  private lastAppMode = this.store.appMode();

  /** Design and Render mode each have their own camera mode: when the mode changes (or another document opens) the one kept for it comes back. */
  private followAppMode(appMode: AppMode, kept: { design?: string | null; render?: string | null } | null | undefined) {
    if (!this.ready() || !this.documentMode()) return;
    if (appMode !== this.lastAppMode) {
      if (!kept?.[this.lastAppMode]) this.store.setCameraModes({ ...kept, [this.lastAppMode]: this.cameraMode() }); // the mode we leave keeps what it had
      this.lastAppMode = appMode;
    }
    const wanted = kept?.[appMode];
    if (wanted && wanted !== this.cameraMode() && cameraModes.some(m => m.id === wanted)) {
      this.cameraMode.set(wanted as CameraMode);
      this.applyCameraMode();
    }
  }

  protected setCameraMode(mode: CameraMode) {
    this.cameraMode.set(mode);
    this.rememberCameraMode();
    this.applyCameraMode();
    this.cameraMenuOpen.set(false);
    this.cubeMenu.set(null);
  }

  protected currentCameraTitle() {
    return cameraModes.find(m => m.id === this.cameraMode())?.title ?? '';
  }

  private setModel(buf: ArrayBuffer) {
    this.baseGeometry?.dispose();
    this.baseGeometry = new STLLoader().parse(buf);
    this.objectRotation.identity();
    this.rotated.set({ x: 0, y: 0, z: 0 });
    this.rebuildGeometry(true);
  }

  /** Rotate the object (not the camera) around a world axis; it is re-seated on the ground afterwards. */
  rotateObject(axis: 'x' | 'y' | 'z', degrees: number) {
    if (this.documentMode()) {
      if (this.store.selectedIds().length) this.documentScene.showRotateTool(); // before the turn, so Esc can take it back
      this.documentScene.rotateSelected(axis, degrees);
      return;
    }
    if (!this.baseGeometry) return;
    const worldAxis = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const step = new THREE.Quaternion().setFromAxisAngle(worldAxis, THREE.MathUtils.degToRad(degrees));
    this.objectRotation.premultiply(step).normalize();
    this.rotated.update(r => ({ ...r, [axis]: foldDegrees(r[axis] + degrees) }));
    this.rebuildGeometry(false);
  }

  /** The Cancel button of the "Snap to grid" / "Move to" banners: like Esc. */
  cancelPicks() {
    this.documentScene.cancelPicks();
  }

  /** The − / + of the Move panel and its ↺ (see DocumentScene). */
  moveBy(axis: 'x' | 'y' | 'z', mm: number) {
    this.documentScene.moveSelected(axis, mm);
  }

  /** The − / + of the Scale panel and its ↺ (see DocumentScene). */
  scaleBy(axis: 'x' | 'y' | 'z' | 'all', percent: number) {
    this.documentScene.scaleSelected(axis, percent);
  }

  resetScale(axis: 'x' | 'y' | 'z' | 'all') {
    this.documentScene.resetScale(axis);
  }

  resetOffset(axis: 'x' | 'y' | 'z' | 'all') {
    this.documentScene.resetOffset(axis);
  }

  /** The ⌖ buttons of both panels: pick a corner or the middle of the selected part(s) as their new origin point. */
  setOrigin() {
    this.documentScene.beginSetOrigin();
  }

  clearOrigin() {
    this.documentScene.clearOrigin();
  }

  protected readonly hasOrigin = computed(() => this.store.selectedItems().some(item => !!item.origin));
  protected originTitle() {
    return this.hasOrigin() ? 'Set a new origin point for the selected part(s): pick a corner or the middle. The part has an origin of its own now (saved in the document).' : 'Set an origin point for the selected part(s) other than the one in the STL file: pick a corner or the middle (saved in the document)';
  }

  /** The ↺ above the axes of the Rotate panel: all three axes back to the STL file. */
  resetAllRotation() {
    if (this.documentMode()) this.documentScene.resetRotation('all');
    else this.resetObjectRotation();
  }

  /** The ↺ button of one axis: back to the rotation of the STL file about that axis. */
  resetAxisRotation(axis: 'x' | 'y' | 'z') {
    if (this.documentMode()) { this.documentScene.resetRotation(axis); return; }
    if (this.rotated()[axis]) this.rotateObject(axis, -this.rotated()[axis]);
  }

  resetObjectRotation() {
    if (this.documentMode() || !this.baseGeometry) return;
    this.objectRotation.identity();
    this.rotated.set({ x: 0, y: 0, z: 0 });
    this.rebuildGeometry(false);
  }

  /**
   * Applies the object rotation to the loaded STL and places its bounding-box min corner on the grid origin,
   * so the 20 mm grid lines line up with the model's cell edges.
   */
  private rebuildGeometry(isNewModel: boolean) {
    const g = this.baseGeometry!.clone();
    g.applyQuaternion(this.objectRotation);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    g.translate(-box.min.x, -box.min.y, -box.min.z);
    g.computeBoundingSphere();
    this.geometry?.dispose();
    this.edges?.dispose();
    this.geometry = g;
    this.edges = null;
    const size = box.getSize(new THREE.Vector3());
    this.info.set(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm · ${(g.attributes['position'].count / 3).toLocaleString()} triangles`);
    this.radius = g.boundingSphere!.radius;
    if (!this.documentMode()) this.buildGrid(new THREE.Vector3(0, 0, 0), size, size.z);

    // Keep the user's viewing direction; first model starts isometric. Rotating keeps the camera offset as is.
    const target = size.clone().multiplyScalar(0.5);
    const offset = this.hasView
      ? this.camera.position.clone().sub(this.controls.target)
      : this.homeDirection.clone().multiplyScalar(this.fitDistance());
    if (isNewModel && this.hasView) offset.setLength(this.fitDistance());
    this.hasView = true;
    if (isNewModel) this.camera.zoom = this.fitZoom(size, offset.clone().normalize());
    this.camera.position.copy(target).add(offset);
    this.controls.target.copy(target);
    this.resize();
    this.applyMode();
  }

  /** Switches the 3D grid on or off (view cube menu) and remembers the choice. */
  protected currentGridModeTitle() {
    return zGridModes.find(m => m.id === this.zGridMode())?.title.split(':')[0] ?? '';
  }

  protected setZGridMode(mode: ZGridMode) {
    this.zGridMode.set(mode);
    try { localStorage.setItem(zGridModeStorageKey, mode); } catch { /* storage unavailable */ }
    this.gridModeOpen.set(false);
    this.cubeMenu.set(null);
  }

  protected toggleSilhouette() {
    setSilhouetteEdges(!silhouetteEdges());
    this.cubeMenu.set(null);
  }

  protected groundModeTitle() {
    return { none: 'None', grid: 'Grid', solid: 'Solid' }[this.groundMode()];
  }

  protected hex(c: number) {
    return '#' + c.toString(16).padStart(6, '0');
  }

  protected readonly isGroundColor = (c: number) => this.groundMode() === 'solid' && this.groundColor() === c;

  protected setGroundMode(mode: GroundMode) {
    this.groundMode.set(mode);
    try { localStorage.setItem(groundModeStorageKey, mode); } catch { /* storage unavailable */ }
    this.groundMenuOpen.set(false);
    this.cubeMenu.set(null);
  }

  /** A colour of the Solid ground's palette: the ground becomes solid in that colour. */
  protected setGroundColor(color: number) {
    this.groundColor.set(color);
    try { localStorage.setItem(groundColorStorageKey, String(color)); } catch { /* storage unavailable */ }
    this.setGroundMode('solid');
  }

  protected toggleGrid3d() {
    const on = !this.grid3d();
    this.grid3d.set(on);
    try { localStorage.setItem(grid3dStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.cubeMenu.set(null);
  }

  private rebuildGrid() {
    if (this.lastGrid) this.buildGrid(this.lastGrid.min, this.lastGrid.max, this.lastGrid.zTop);
  }

  /**
   * Grid with 20 mm cells (the RASTERFASTER base grid) covering min..max plus a two-cell margin: the ground grid, or with the 3D grid
   * on a lattice that also has horizontal grids at every z level up to `zTop` and vertical lines through every node.
   */
  private buildGrid(min: THREE.Vector3, max: THREE.Vector3, zTop: number) {
    this.lastGrid = { min: min.clone(), max: max.clone(), zTop };
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const cell = gridCellMm;
    const margin = 2 * cell;
    // The grid is the work area: at most 100 x 100 cells, never beyond the limits parts are clamped to.
    const limit = workArea.max[0];
    const minX = Math.max(Math.floor(min.x / cell) * cell - margin, -limit), minY = Math.max(Math.floor(min.y / cell) * cell - margin, -limit);
    const maxX = Math.min(Math.ceil(max.x / cell) * cell + margin, limit), maxY = Math.min(Math.ceil(max.y / cell) * cell + margin, limit);
    const ground = -0.05; // a hair below the model's underside so the two never z-fight
    const levels = [ground];
    if (this.grid3d()) {
      const top = Math.min(Math.max(zTop + 12, 40), workArea.max[2]);
      const mode = this.zGridMode();
      for (let z = nextZLevel(0, 1, mode); levels.length < 400; z = nextZLevel(z, 1, mode)) { // z levels above the ground (0)
        levels.push(z);
        if (z >= top) break;
      }
    }
    const highest = levels[levels.length - 1];
    const points: number[] = [];
    for (const z of levels) {
      for (let x = minX; x <= maxX; x += cell) points.push(x, minY, z, x, maxY, z);
      for (let y = minY; y <= maxY; y += cell) points.push(minX, y, z, maxX, y, z);
    }
    if (levels.length > 1) {
      for (let x = minX; x <= maxX; x += cell) for (let y = minY; y <= maxY; y += cell) points.push(x, y, ground, x, y, highest);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.grid = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: gridColor, transparent: levels.length > 1, opacity: levels.length > 1 ? 0.7 : 1 }));
    this.grid.visible = this.groundGrid();
    this.scene.add(this.grid);
    this.buildGroundPlane(minX, minY, maxX, maxY, cell);
  }

  /** The Solid ground: a plane under the parts (a hair below the grid) in the chosen colour, reaching a good way beyond the grid; it also catches the shadows in the Shaded view. */
  private buildGroundPlane(minX: number, minY: number, maxX: number, maxY: number, cell: number) {
    if (this.groundPlane) {
      this.scene.remove(this.groundPlane);
      this.groundPlane.geometry.dispose();
      (this.groundPlane.material as THREE.Material).dispose();
      this.groundPlane = null;
    }
    if (this.shownGroundMode() !== 'solid') return;
    const reach = 10 * cell;
    const width = maxX - minX + 2 * reach, height = maxY - minY + 2 * reach;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ color: this.shownGroundColor(), roughness: 0.95, metalness: 0 }));
    plane.position.set((minX + maxX) / 2, (minY + maxY) / 2, -0.1);
    plane.receiveShadow = true;
    this.groundPlane = plane;
    this.scene.add(plane);
  }

  private readonly environmentTextures = new Map<number, THREE.Texture>();

  /** A small room for the preset: 0 the dark studio, 1 a softbox with bright panels, 2 daylight, 3 neutral grey. */
  private environmentRoom(preset: number): THREE.Scene {
    if (preset === 0) return new RoomEnvironment();
    const room = new THREE.Scene();
    if (preset === 4) return room; // None: nothing to reflect
    const shell = (colour: number) => new THREE.MeshBasicMaterial({ color: colour, side: THREE.BackSide });
    const panel = (w: number, h: number, intensity: number, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide }));
      mesh.position.set(x, y, z);
      mesh.lookAt(0, 0, 0);
      room.add(mesh);
    };
    if (preset === 1) {
      room.add(new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), shell(0x101012)));
      panel(24, 16, 6, 0, 0, 18); panel(8, 22, 3.5, -17, 0, 6); panel(8, 22, 3.5, 17, 0, 6);
    } else if (preset === 2) {
      const sky = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 p; void main(){ float t = clamp(p.z / 30.0 * 0.5 + 0.5, 0.0, 1.0); gl_FragColor = vec4(mix(vec3(0.22, 0.20, 0.18), vec3(0.45, 0.62, 0.95), smoothstep(0.35, 1.0, t)), 1.0); }',
      }));
      sky.rotation.x = -Math.PI / 2; // the sphere's pole is z (up in the document)
      room.add(sky);
      panel(10, 10, 5, 12, 10, 22);
    } else {
      room.add(new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), shell(0x808080)));
    }
    return room;
  }

  /** The reflections metal, glass and mirror parts show (made once per preset, only when a part has such a finish). */
  private reflections(): THREE.Texture | null {
    const preset = this.renderSettings.reflections();
    let texture = this.environmentTextures.get(preset) ?? null;
    if (!texture && this.renderer) {
      const generator = new THREE.PMREMGenerator(this.renderer);
      texture = generator.fromScene(this.environmentRoom(preset), 0.04).texture;
      generator.dispose();
      this.environmentTextures.set(preset, texture);
    }
    return texture;
  }

  private clearModel() {
    clearParts(this.model);
    this.geometry?.dispose();
    this.edges?.dispose();
    this.baseGeometry?.dispose();
    if (this.grid) { this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    if (this.groundPlane) { this.scene.remove(this.groundPlane); this.groundPlane.geometry.dispose(); (this.groundPlane.material as THREE.Material).dispose(); this.groundPlane = null; }
  }

  private readonly lightMaterial = new THREE.LineBasicMaterial({ color: 0xffd98a, depthTest: false, transparent: true });
  private lightHover = false;

  /** The pointer is over the light source (not while dragging it or choosing a part): it lights up white and a little bigger, and shows the grab cursor. */
  private readonly onLightHover = (e: PointerEvent) => {
    if (this.lightDrag || this.pointMode || e.buttons) return;
    const over = this.overLight(e);
    if (over === this.lightHover) return;
    this.lightHover = over;
    this.lightMaterial.color.set(over ? 0xffffff : 0xffd98a);
    this.lightDisk.scale.multiplyScalar(over ? 1.25 : 1 / 1.25);
    this.renderer.domElement.style.cursor = over ? 'grab' : '';
  };

  private buildLightGizmo() {
    const material = this.lightMaterial;
    const segments = (points: number[]) => {
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)), material);
      line.renderOrder = 30;
      return line;
    };
    const ring: number[] = [], rays: number[] = [];
    const steps = 40;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2, b = ((i + 1) / steps) * Math.PI * 2;
      ring.push(Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0);
    }
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; rays.push(Math.cos(a) * 1.35, Math.sin(a) * 1.35, 0, Math.cos(a) * 2.1, Math.sin(a) * 2.1, 0); }
    this.lightDisk.add(segments(ring), segments(rays));
    // the beam runs along +Z of the gizmo (the gizmo looks at the middle of the scene); the arrow head sits at its end
    const head = 0.05;
    this.lightBeam.add(segments([0, 0, 0, 0, 0, 1,
      0, 0, 1, head, 0, 0.92, 0, 0, 1, -head, 0, 0.92, 0, 0, 1, 0, head, 0.92, 0, 0, 1, 0, -head, 0.92]));
    this.lightGizmo.add(this.lightDisk, this.lightBeam);
    this.lightGizmo.visible = false;
    this.scene.add(this.lightGizmo);
  }

  /** Switches the light source on in the "Shaded" view and fits its shadow volume (and the floor that catches it) round what is on screen. */
  private updateShadowRig() {
    const on = this.mode() === 'shaded';
    this.keyLight.castShadow = on;
    this.shadowFloor.visible = on && this.shownGroundMode() !== 'solid'; // the Solid ground catches the shadows itself
    this.lightGizmo.visible = on;
    if (!on) return;
    let box: THREE.Box3 | null = null;
    if (this.documentMode()) box = this.documentScene?.bounds() ?? null;
    else if (this.geometry) { this.geometry.computeBoundingBox(); box = this.geometry.boundingBox; }
    if (!box || box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
    const followed = this.lightTargetId && this.documentMode() ? this.documentScene.boundsOf([this.lightTargetId]) : null;
    const at = followed ? followed.getCenter(new THREE.Vector3()) : this.lightAt ?? centre;
    const reach = radius * 1.25 + at.distanceTo(centre); // the shadow volume has to cover the whole scene seen from the light, wherever it points
    this.keyLight.target.position.copy(at);
    this.keyLight.position.copy(at).addScaledVector(this.lightDir, radius * 3 + reach);
    const camera = this.keyLight.shadow.camera;
    camera.left = camera.bottom = -reach;
    camera.right = camera.top = reach;
    camera.near = radius * 0.2;
    camera.far = radius * 7 + reach * 2;
    camera.updateProjectionMatrix();
    this.keyLight.target.updateMatrixWorld();
    // the light source as a wire model: the ring a little way out along the light's direction, the beam running to the middle
    this.lightReach = radius * 1.3;
    this.lightAtNow.copy(at);
    const out = at.clone().addScaledVector(this.lightDir, this.lightReach);
    this.lightGizmo.position.copy(out);
    this.lightGizmo.lookAt(at);
    this.lightDisk.scale.setScalar(radius * 0.09 * (this.lightHover ? 1.25 : 1));
    this.lightBeam.scale.setScalar(out.distanceTo(at) * 0.62);
    // the build plate: z = 0 under the parts, as wide as the shadows can reach
    this.shadowFloor.position.set(centre.x, centre.y, Math.min(0, box.min.z));
    this.shadowFloor.scale.set(radius * 6, radius * 6, 1);
  }

  /** The light's ring is under the pointer (a generous disc round it on the screen). */
  private overLight(e: { clientX: number; clientY: number }): boolean {
    if (this.mode() !== 'shaded' || !this.lightGizmo.visible) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (p: THREE.Vector3) => { const v = p.clone().project(this.camera); return new THREE.Vector2((v.x + 1) / 2 * rect.width, (1 - v.y) / 2 * rect.height); };
    const centre = project(this.lightGizmo.position);
    const rim = project(this.lightGizmo.position.clone().add(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(this.lightDisk.scale.x * 2.1)));
    const reach = Math.max(14, centre.distanceTo(rim) * 1.15);
    return centre.distanceTo(new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top)) <= reach;
  }

  /**
   * Dragging the light's ring swings the light round what it points at; letting go over a part makes the light point at that part.
   * Registered before everything else on the canvas so that it is the light that is grabbed, not a part behind it.
   */
  private readonly onLightDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.metaKey || e.shiftKey || !this.overLight(e)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const canvas = this.renderer.domElement;
    canvas.setPointerCapture(e.pointerId);
    const was = { dir: this.lightDir.clone(), at: this.lightAt?.clone() ?? null, id: this.lightTargetId };
    const move = (ev: PointerEvent) => this.swingLight(ev);
    const up = (ev: PointerEvent) => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      this.lightDrag = null;
      this.pointLightAt(ev);
      this.commitLight();
    };
    const cancel = () => { // the browser took the pointer away: back to where the light was
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      this.lightDrag = null;
      this.lightDir.copy(was.dir);
      this.lightAt = was.at;
      this.lightTargetId = was.id;
      this.updateShadowRig();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    this.lightDrag = { move, up };
  };

  /** Right-click on the light source: its menu. */
  private readonly onLightContext = (e: MouseEvent) => {
    if (this.pointMode) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!this.overLight(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const host = this.host().nativeElement.getBoundingClientRect();
    this.lightMenu.set({ x: Math.min(e.clientX - host.left, host.width - 240), y: e.clientY - host.top });
  };

  /** "Point at object" from the light's menu: until a click or Esc, the light points at the part under the pointer. */
  protected startPointAtObject() {
    this.lightMenu.set(null);
    if (!this.documentMode()) return;
    this.pointMode = { dir: this.lightDir.clone(), at: this.lightAt?.clone() ?? null, id: this.lightTargetId };
    this.renderer.domElement.style.cursor = 'crosshair';
    window.addEventListener('keydown', this.onPointAtKey, true);
    this.store.announce('Point at object: click a part for the light to point at (Esc cancels)', 6000);
  }

  private endPointAtObject(keep: boolean) {
    const mode = this.pointMode;
    if (!mode) return;
    this.pointMode = null;
    this.showPointBox(null);
    this.renderer.domElement.style.cursor = '';
    window.removeEventListener('keydown', this.onPointAtKey, true);
    if (!keep) { this.lightDir.copy(mode.dir); this.lightAt = mode.at; this.lightTargetId = mode.id; this.updateShadowRig(); }
  }

  /** The part under the pointer and the middle of its box, or null. */
  private partUnder(e: { clientX: number; clientY: number }): { id: string; centre: THREE.Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pickRaycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)), this.camera);
    const hit = this.pickRaycaster.intersectObjects(this.documentScene.pickableMeshes(), false)[0];
    const id = hit?.object.userData['itemId'] as string | undefined;
    const box = id ? this.documentScene.boundsOf([id]) : null;
    return id && box ? { id, centre: box.getCenter(new THREE.Vector3()) } : null;
  }

  private pointBox: THREE.Box3Helper | null = null;

  /** The outline of the part the pointer is over while choosing what the light points at (null: none). */
  private showPointBox(id: string | null) {
    const box = id ? this.documentScene.boundsOf([id]) : null;
    if (box && !this.pointBox) {
      this.pointBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd98a);
      Object.assign(this.pointBox.material as THREE.LineBasicMaterial, { depthTest: false });
      this.pointBox.renderOrder = 31;
      this.scene.add(this.pointBox);
    }
    if (this.pointBox) { this.pointBox.visible = !!box; if (box) this.pointBox.box.copy(box); }
  }

  private readonly onPointAtMove = (e: PointerEvent) => {
    if (!this.pointMode) return;
    const part = this.partUnder(e);
    this.showPointBox(part?.id ?? null);
    if (!part) return;
    this.lightTargetId = part.id; // a preview: the light turns to whatever the pointer is over
    this.updateShadowRig();
  };

  private readonly onPointAtDown = (e: PointerEvent) => {
    if (!this.pointMode) return;
    e.stopImmediatePropagation(); // the click belongs to this mode, not to selecting or dragging a part
    e.preventDefault();
    if (e.button !== 0) return;
    const part = this.partUnder(e);
    if (!part) return; // a click beside the parts changes nothing (Esc cancels)
    this.lightTargetId = part.id;
    this.lightAt = null;
    this.updateShadowRig();
    this.endPointAtObject(true);
    this.commitLight();
    this.store.announce(`The light points at ${this.store.doc().items.find(i => i.id === part.id)?.name ?? 'the part'}`);
  };

  private readonly onPointAtKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    this.endPointAtObject(false);
    this.store.announce('Point at object cancelled');
  };

  /** The light follows the pointer on a sphere round what it points at. */
  private swingLight(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pickRaycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)), this.camera);
    const ray = this.pickRaycaster.ray, at = this.lightAtNow;
    const sphere = new THREE.Sphere(at, this.lightReach);
    const hit = ray.intersectSphere(sphere, new THREE.Vector3()) ?? ray.closestPointToPoint(at, new THREE.Vector3()); // missing the sphere: the closest point of the ray
    const dir = hit.sub(at);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    this.lightDir.copy(dir.normalize());
    this.updateShadowRig();
  }

  /** Released over a part: the light now points at it (the middle of its box). */
  private pointLightAt(e: PointerEvent) {
    if (!this.documentMode()) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pickRaycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)), this.camera);
    const hit = this.pickRaycaster.intersectObjects(this.documentScene.pickableMeshes(), false)[0];
    const id = hit?.object.userData['itemId'] as string | undefined;
    const box = id ? this.documentScene.boundsOf([id]) : null;
    if (!id || !box) return;
    this.lightTargetId = id;
    this.lightAt = null;
    this.updateShadowRig();
    this.store.announce(`The light points at ${this.store.doc().items.find(i => i.id === id)?.name ?? 'the part'}`);
  }

  /** What the light points at, for its menu: the part's name, a point, or the middle of all the objects. */
  protected lightTargetText(): string {
    if (this.lightTargetId) return this.store.doc().items.find(i => i.id === this.lightTargetId)?.name ?? 'a part';
    return this.lightAt ? 'a point' : "objects' centre";
  }

  protected lightAtCentre(): boolean {
    return !this.lightTargetId && !this.lightAt;
  }

  /** The light comes from the camera's side (a way to reach a lamp that is out of the picture): it shines the way the view looks; the target stays. */
  protected lightFromView() {
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-9) return;
    this.lightDir.copy(direction.normalize());
    this.updateShadowRig();
    this.commitLight();
    this.store.announce('The light now shines from where you look');
  }

  /** The light keeps its direction and points at the middle of all the objects. */
  protected pointAtCentre() {
    this.lightMenu.set(null);
    this.lightAt = null;
    this.lightTargetId = null;
    this.updateShadowRig();
    this.commitLight();
    this.store.announce("The light points at the objects' centre");
  }

  /** Back to the light's own direction, pointing at the middle of the scene. */
  resetLight() {
    this.lightDir.copy(defaultLightDirection);
    this.lightAt = null;
    this.lightTargetId = null;
    this.updateShadowRig();
    this.store.setLight(null);
  }

  /** Puts the light as it is now into the document (saved with it, one undo step). */
  private commitLight() {
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const point = (v: THREE.Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];
    this.store.setLight({
      direction: point(this.lightDir),
      ...(this.lightTargetId ? { targetId: this.lightTargetId } : this.lightAt ? { target: point(this.lightAt) } : {}),
    });
  }

  /** The light the document asks for (none: the default one). */
  private applyStoredLight(light: DocLight | null) {
    if (this.lightDrag || this.pointMode) return;
    if (light) {
      this.lightDir.set(...light.direction);
      if (this.lightDir.lengthSq() < 1e-9) this.lightDir.copy(defaultLightDirection);
      this.lightDir.normalize();
      this.lightAt = light.target ? new THREE.Vector3(...light.target) : null;
      this.lightTargetId = light.targetId ?? null;
    } else {
      this.lightDir.copy(defaultLightDirection);
      this.lightAt = null;
      this.lightTargetId = null;
    }
    this.updateShadowRig();
  }

  private applyMode() {
    this.updateShadowRig();
    if (!this.geometry) return;
    const geometry = this.geometry;
    clearParts(this.model);
    const parts = buildParts(geometry, this.mode(), {
      ...previewStyle, background: this.scene.background as THREE.Color, radius: this.radius,
      edges: () => (this.edges ??= new THREE.EdgesGeometry(geometry, 25)),
    });
    this.model.add(...parts);
  }

  ngOnDestroy() {
    if (this.viewFocus.target === this.host().nativeElement) this.viewFocus.target = null;
    this.store.showInAssembly = null;
    this.store.viewSvg = null;
    this.store.captureView = null;
    this.environmentTextures.forEach(t => t.dispose());
    this.store.recallView = null;
    cancelAnimationFrame(this.frame);
    this.renderer?.domElement.removeEventListener('pointerdown', this.onCentreClick);
    this.renderer?.domElement.removeEventListener('pointerdown', this.stopFlight);
    this.stageEl?.removeEventListener('keydown', this.onFlightKey);
    this.stageEl?.removeEventListener('keydown', this.onViewKey);
    this.renderer?.domElement.removeEventListener('wheel', this.onWheel);
    this.ro?.disconnect();
    this.clearModel();
    this.documentScene?.dispose();
    this.viewCube?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }
}
