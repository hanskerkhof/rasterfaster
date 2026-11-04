import { Component, OnDestroy, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { closeOnEscape } from './escape-close';
import { ImagesService } from './images.service';
import { Aspect, RenderService, focusCentre, fxIds, fxNames, ambientNames, reflectionNames, aspectRatio, aspects, beamNames, hdQualities, hdWidths, videoWidths, strengthNames, turnDirections, turntableLengths, turntableMotions, turntableQualities } from './render.service';
import { DocumentStore } from './document.store';
import { ColorPalette } from './color-palette';

/**
 * A Cycles render of the scene (what the Blender file would render), made by the API through Blender in the background. Either a quick one
 * (800 px, a few seconds, shown here at once) or a finished full-size render (1920 px, 96 samples, about two minutes) that was made in the
 * background and is shown when its notice is clicked. "Render HD" starts a full-size one in the background and closes this dialog.
 */
@Component({
  selector: 'app-render-dialog',
  imports: [ColorPalette],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="shell">
    @if (url() && views().length) {
      <aside class="views" aria-label="Views">
        <div class="views-title">Views</div>
        <div class="views-list">
          @for (view of views(); track view.id; let i = $index) {
            <button type="button" class="view" [class.on]="view.id === store.activeViewId()" [class.from]="view.id === store.fromViewId()" [disabled]="busy()" (click)="pickView(view)" [title]="'Go to ' + view.name + ' and render it as a quick render'">
              <span class="num">{{ i < 9 ? i + 1 : '' }}</span><span class="label">{{ view.name }}</span>
            </button>
          }
        </div>
      </aside>
    }
    <section class="dialog" role="dialog" aria-label="Render">
      <header>
        <h2>Render <small>{{ detail() }}</small></h2>
        <label class="check" title="Crop: the picture is only as wide as the objects (the height stays: 450 px for the quick render, 1080 px for HD), so a tall stack gives a narrow picture and a row of parts a wide one">
          <input type="checkbox" [checked]="render.crop()" (change)="toggleCrop($any($event.target).checked)" /> Crop
        </label>
        <label class="check" title="Blurs what is in front of and behind the part nearest to the camera, like a real lens (needs the perspective camera: an orthographic view has no depth of field)">
          <input type="checkbox" [checked]="render.depthOfField()" (change)="toggleDepthOfField($any($event.target).checked)" /> Depth of field
        </label>
        @if (render.depthOfField() && orthographic()) { <span class="dofnote" title="An orthographic view has no depth of field: switch the 3D view to the perspective camera">⚠ needs a perspective view</span> }
          <select class="focus" [disabled]="!render.depthOfField() && render.fx() !== 'thermal'" [value]="focusValue()" title="The part that is sharp (with the Thermal style: the hottest part; with none chosen the lamp decides). Automatic: the part nearest to the camera that is in the picture. Or the middle of the box round all the objects." (change)="chooseFocus($any($event.target).value)">
            <option value="" [selected]="!focusValue()">Focus: nearest in the picture</option>
            <option [value]="focusCentre" [selected]="focusValue() === focusCentre">Focus: centre of the objects</option>
            @for (part of parts(); track part.id) { <option [value]="part.id" [selected]="part.id === focusValue()">Focus: {{ part.label }}</option> }
          </select>
          <button type="button" [disabled]="!render.depthOfField() || !selected()" [title]="selected() ? 'Focus on the part that is selected in the document' : 'Select a part in the document before you open the Render dialog: it is then focused on that part with one click'" (click)="chooseFocus(selected()!)">Selected</button>
          <select class="focus strength" [disabled]="!render.depthOfField()" [value]="render.dofStrength()" title="How blurred what is far from the focus is. Medium: unsharp but still recognizable." (change)="chooseStrength(+$any($event.target).value)">
            @for (level of strengths; track level.value) { <option [value]="level.value" [selected]="level.value === render.dofStrength()">Blur: {{ level.label }}</option> }
          </select>
        <button type="button" class="x" aria-label="Close" (click)="close.emit()">✕</button>
      </header>
      <div class="lighting" aria-label="Lighting">
        <span class="bar-title">Lighting</span>
        <select class="focus strength" [value]="render.ambient()" title="Ambient light: a big soft light above the scene that lightens the shadows." (change)="chooseAmbient(+$any($event.target).value)">
          @for (level of ambients; track level.value) { <option [value]="level.value" [selected]="level.value === render.ambient()">Ambient: {{ level.label }}</option> }
        </select>
        <select class="focus strength" [value]="render.reflections()" title="What metal, mirror and glass reflect (and what shows through glass): the dark studio, a softbox with bright panels, a daylight sky or a neutral grey room. The background and the lighting of the matte parts stay as they are" (change)="chooseReflections(+$any($event.target).value)">
          @for (preset of reflectionPresets; track preset.value) { <option [value]="preset.value" [selected]="preset.value === render.reflections()">Reflects: {{ preset.label }}</option> }
        </select>
        <select class="focus strength" [value]="render.fx()" title="FX: a style for the picture (cartoon, outline, sketch, clay, blueprint). The same setting as in the toolbar" (change)="chooseFx($any($event.target).value)">
          @for (f of fxChoices; track f.id) { <option [value]="f.id" [selected]="f.id === render.fx()">FX: {{ f.label }}</option> }
        </select>
        @if (render.fx() === 'cutaway') {
          <select class="focus strength" [value]="render.cutParts().axis" title="The plane that cuts through the parts is across this axis" (change)="chooseCut({ axis: $any($event.target).value })">
            @for (a of cutAxes; track a) { <option [value]="a" [selected]="a === render.cutParts().axis">Cut across {{ a.toUpperCase() }}</option> }
          </select>
          <label class="cutslider" title="Where the cut is, from one end of the parts (0 %) to the other (100 %)">Cut at <input type="range" min="0" max="100" step="1" [value]="render.cutParts().position" (input)="render.setCut({ position: +$any($event.target).value })" (change)="chooseCut({ position: +$any($event.target).value })" /> {{ render.cutParts().position }} %</label>
          <label class="cutslider" title="Cut away the other side"><input type="checkbox" [checked]="render.cutParts().flip" (change)="chooseCut({ flip: $any($event.target).checked })" /> Other side</label>
        }
        <select class="focus strength" [value]="render.beam()" title="The type of the lamp: from a spotlight (razor-sharp shadows) to a flood (very soft shadows)" (change)="chooseBeam(+$any($event.target).value)">
          @for (type of beams; track type.value) { <option [value]="type.value" [selected]="type.value === render.beam()">Lamp: {{ type.label }}</option> }
        </select>
        <label class="lamp" title="The strength of the lamp pointed at the parts: left is darker, right is brighter. Two thirds of the way is the normal strength (double-click to go back to it).">Lamp
          <input type="range" min="0" max="60" step="1" [value]="render.lamp()" (input)="render.setLamp(+$any($event.target).value)" (change)="lampChanged()" (dblclick)="resetLamp()" />
          <output class="lamp-value">{{ lampText() }}</output>
        </label>
        @for (target of colourTargets; track target.key) {
          <span class="colour">
            <button type="button" class="swatch-button" [title]="target.title" (click)="colourOpen.set(colourOpen() === target.key ? null : target.key)">
              <i class="chip" [style.background]="hex(colourOf(target.key))"></i>{{ target.label }}
            </button>
            @if (colourOpen() === target.key) {
              <div class="colour-backdrop" (click)="colourOpen.set(null)"></div>
              <div class="flyout" role="menu" [attr.aria-label]="target.label + ' colour'">
                <app-color-palette [isOn]="isColour(target.key)" (picked)="chooseColour(target.key, $event)" />
                <button type="button" class="studio" (click)="chooseColour(target.key, null)">Studio default</button>
              </div>
            }
          </span>
        }
        <label class="check" title="Transparent background: no background in the picture (a PNG with alpha). The ground stays invisible but its soft shadows show, like a product photo">
          <input type="checkbox" [checked]="render.transparent()" (change)="toggleTransparent($any($event.target).checked)" /> Transparent
        </label>
      </div>
      <div class="actions">
        @if (url()) {
          <button type="button" [disabled]="busy()" title="800 px, 24 samples: a few seconds" (click)="quick(true)">
            @if (busy()) { <span class="spinner small"></span> } @else if (quickReady()) { <svg class="tick" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="The quick render is ready"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg> }Quick render
          </button>
        }
        @if (url()) {
          <button type="button" [disabled]="busy()" title="320 px, 4 samples: the same picture, rough and in a second or two (the gallery's thumbnail of a queued render is made like this)" (click)="quick(true, true)">Quick draft render</button>
          <button type="button" [disabled]="busy()" [title]="'A small turntable video to see the motion: ' + quickVideoText() + '. It is not queued; use Render turntable for the real one'" (click)="quickVideo()">Quick video</button>
          <button type="button" [disabled]="busy()" [title]="'An even rougher turntable video, to test the motion fast: ' + quickVideoText(true)" (click)="quickVideo(true)">Quick draft video</button>
          <select class="focus shape" [value]="render.aspect()" title="The shape of the picture: the size menu gives its width, the height follows the shape" (change)="chooseAspect($any($event.target).value)">
            @for (a of shapes; track a.id) { <option [value]="a.id" [selected]="a.id === render.aspect()">{{ a.label }}</option> }
          </select>
          <select class="focus size" [value]="render.hdWidth()" title="The size of the full-size render: larger pictures take much longer" (change)="render.setHdWidth(+$any($event.target).value)">
            @for (size of hdSizes; track size.width) { <option [value]="size.width" [selected]="size.width === render.hdWidth()">{{ size.label }}</option> }
          </select>
          <select class="focus size" [value]="render.hdSamples()" title="The quality of the full-size render: more samples are cleaner (mirrors, metal and glass especially) and take longer" (change)="render.setHdSamples(+$any($event.target).value)">
            @for (q of hdQualities; track q.samples) { <option [value]="q.samples" [selected]="q.samples === render.hdSamples()">{{ q.label }}</option> }
          </select>
          <button type="button" [disabled]="render.queueFull()" [title]="render.queueFull() ? 'The render queue is full: wait for a render to finish' : (render.running() ? 'It joins the queue and starts when the running render is done. ' : '') + render.hdWidth() + ' px, ' + render.hdSamples() + ' samples: in the background, about two minutes at 1920 px and longer for larger pictures (you get a message when it is ready)'" (click)="startFullSize()">
            @if (render.running()) { <span class="spinner small"></span> }Render HD@if (render.waiting() > 0) { <small> (+{{ render.waiting() }})</small> }
          </button>
        }
        @if (url()) { <!-- always there, so the row does not change when the picture arrives -->
          <button type="button" [disabled]="savedToLibrary() || busy() || !picture() || (!isVideo() && !render.lastQuick)" title="Keep this quick render in the document's gallery (it carries the document version)" (click)="saveToLibrary()">{{ savedToLibrary() ? (isVideo() ? '✓ Quick video saved to gallery' : '✓ Quick render saved to gallery') : (isVideo() ? 'Save quick video to gallery' : 'Save quick render to gallery') }}</button>
        }
        @if (picture() || url()) {
          <a class="button download" [class.off]="!picture()" [attr.href]="picture() || null" [download]="fileName()" [title]="url() ? 'Save the quick render (800 px) as a PNG file' : 'Save the full-size render as a PNG file'">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>
            {{ isVideo() ? (url() ? 'Download quick video' : 'Download turntable video') : url() ? 'Download quick render PNG' : 'Download HD render PNG' }}
          </a>
        }
      </div>
      @if (url()) {
        <div class="actions turntable">
          <span class="bar-title">Turntable video</span>
          <select class="focus size" [value]="render.turntable().motion" title="How it moves" (change)="render.setTurntable({ motion: $any($event.target).value })">
            @for (m of motions; track m.id) { <option [value]="m.id" [selected]="m.id === render.turntable().motion" [title]="m.title">{{ m.label }}</option> }
          </select>
          <select class="focus size" [value]="render.turntable().direction" title="The way round, seen from above: counter-clockwise or clockwise" (change)="render.setTurntable({ direction: $any($event.target).value })">
            @for (d of directions; track d.id) { <option [value]="d.id" [selected]="d.id === render.turntable().direction" [title]="d.title">{{ d.label }}</option> }
          </select>
          <select class="focus size" [value]="render.tracked()?.id ?? ''" title="The part the camera can look at (and go round with Camera circles)" (change)="render.setTrack($any($event.target).value || null)">
            <option value="" [selected]="!render.tracked()">Track: the view's centre</option>
            @for (part of parts(); track part.id) { <option [value]="part.id" [selected]="part.id === render.tracked()?.id">Track: {{ part.label }}</option> }
          </select>
          <select class="focus size" [disabled]="render.turntable().motion !== 'orbit'" [value]="render.trackPivot()" [title]="render.turntable().motion === 'orbit' ? 'What the camera goes round: the middle of all the objects, the middle of the view, or the tracked part' : 'Only for Camera circles: with Objects turn the camera stays where the view is'" (change)="render.setTrackPivot($any($event.target).value)">
            <option value="all" [selected]="render.trackPivot() === 'all'">Goes round: all objects</option>
            <option value="view" [selected]="render.trackPivot() === 'view'">Goes round: the view</option>
            <option value="part" [disabled]="!render.tracked()" [selected]="render.trackPivot() === 'part'">Goes round: the tracked part</option>
          </select>
          <select class="focus size" [value]="render.lookAt()" title="What the camera keeps looking at (also with Objects turn, where the camera stays where the view is): the tracked part, the middle of all the objects, or nothing in particular (it keeps the angle it has, as the view looks now)" (change)="render.setLookAt($any($event.target).value)">
            <option value="view" [selected]="render.lookAt() === 'view'">Looks at: as the view does</option>
            <option value="all" [selected]="render.lookAt() === 'all'">Looks at: all objects</option>
            <option value="part" [disabled]="!render.tracked()" [selected]="render.lookAt() === 'part'">Looks at: the tracked part</option>
          </select>
          <button type="button" title="Click a part in the 3D view to track it (the dialog closes and comes back)" (click)="pickTrack()">Pick…</button>
          <select class="focus size" [value]="render.turntable().seconds" title="How long one turn takes (30 frames per second)" (change)="render.setTurntable({ seconds: +$any($event.target).value })">
            @for (n of lengths; track n) { <option [value]="n" [selected]="n === render.turntable().seconds">{{ n }} seconds · {{ n * render.turntableSpec().fps }} frames</option> }
          </select>
          <select class="focus size" [value]="render.turntable().samples" title="Samples per frame: more is cleaner and takes longer (every frame is rendered)" (change)="render.setTurntable({ samples: +$any($event.target).value })">
            @for (q of turntableQualities; track q.samples) { <option [value]="q.samples" [selected]="q.samples === render.turntable().samples">{{ q.label }}</option> }
          </select>
          <select class="focus size" [value]="render.videoWidth()" title="The size of the video (apart from the size of a picture): a video has hundreds of frames, so it stays small" (change)="render.setVideoWidth(+$any($event.target).value)">
            @for (size of videoSizes; track size.width) { <option [value]="size.width" [selected]="size.width === render.videoWidth()">Video: {{ size.label }}</option> }
          </select>
          <button type="button" [disabled]="render.queueFull()" [title]="render.queueFull() ? 'The render queue is full: wait for a render to finish' : 'Render an MP4 of one turn in the background, as wide as the video size next to it and in the chosen shape. It joins the queue and is kept in the gallery'" (click)="startTurntable()">Render turntable</button>
          <span class="estimate" [title]="'A rough guess from what the last renders took. A draft is small (960 px, 12 samples, 24 frames per second) and quick: use it to see the motion first'">{{ turntableText() }}</span>
        </div>
      }
      @if (error()) { <p class="error">{{ error() }}</p> }
      <div class="frame">
        @if (picture() && isVideo()) { <video [src]="picture()" controls autoplay loop muted playsinline [style.width]="frameWidth()"></video> }
        @else if (picture()) { <img [src]="picture()" alt="Render of the document" [class.dim]="busy()" [class.checker]="render.transparent()" [style.width]="frameWidth()" /> } @else { <div class="placeholder" [style.aspect-ratio]="frameRatio()" [style.width]="frameWidth()"></div> }
        @if (busy()) { <div class="over"><span class="spinner big"></span><span>{{ busyText() }}</span>@if (cancellable()) { <button type="button" class="cancel" (click)="cancelQuick()" title="Stop this render (change a setting, then render again)">Cancel</button> }</div> }
      </div>
    </section>
    </div>
  `,
  styles: `
    .cutslider { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 10; }
    .shell { position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex; align-items: stretch; width: min(1380px, 98vw); max-height: 92vh; }
    .views { flex: none; width: 168px; display: flex; flex-direction: column; gap: 6px; padding: 14px 8px; background: #1f2229; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-right: 0; border-radius: 8px 0 0 8px; font-size: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    .views-title { font-weight: 600; opacity: .75; padding: 0 4px; }
    .views-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
    .views .view { display: flex; align-items: center; gap: 6px; text-align: left; padding: 4px 6px; background: transparent; color: inherit; border: 0; border-radius: 4px; font: inherit; cursor: pointer; } .views .view:hover:not(:disabled) { background: rgba(255,255,255,.1); } .views .view:disabled { opacity: .5; cursor: default; }
    .views .view.on { background: rgba(47,111,237,.4); box-shadow: inset 3px 0 0 #2f6fed; }
    .views .view.from { background: rgba(224,160,48,.14); box-shadow: inset 3px 0 0 #e0a030; } .views .view.from .num { color: #e0a030; }
    .views .num { flex: none; width: 12px; text-align: center; color: #8a93a2; font-size: 11px; } .views .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dialog { position: relative; flex: 1 1 auto; min-width: 0; max-height: 92vh; overflow: auto;
              padding: 14px; background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; padding-right: 34px; }
    .estimate { opacity: .7; font-size: 12px; }
    .actions .download.off { opacity: .4; pointer-events: none; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; } .actions button, .actions select, .actions .button { white-space: nowrap; } .actions .download { margin-left: auto; } /* room for the close button, which stays in the corner */
    h2 { margin: 0 auto 0 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
    .lighting { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; } .bar-title { font-weight: 600; opacity: .7; }
    .lamp-value { min-width: 48px; text-align: right; font-variant-numeric: tabular-nums; opacity: .85; }
    .colour { position: relative; display: inline-block; }
    .swatch-button .chip { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(255,255,255,.35); }
    .colour-backdrop { position: fixed; inset: 0; z-index: 12; background: transparent; }
    .flyout { position: absolute; z-index: 13; top: calc(100% + 4px); left: 0; padding: 8px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .flyout .studio { display: block; margin-top: 8px; width: 100%; justify-content: center; }
    .lamp { display: inline-flex; align-items: center; gap: 6px; } .lamp input { width: 130px; margin: 0; accent-color: #2f6fed; }
    .focus.strength { max-width: 150px; } .focus.size { max-width: 200px; }
    .focus:disabled { opacity: .45; cursor: default; }
    .focus { max-width: 230px; padding: 3px 6px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; }
    .check { display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; cursor: pointer; user-select: none; } .check input { margin: 0; }
    .dofnote { font-size: 12px; color: #f0b429; white-space: nowrap; }
    button, .button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; text-decoration: none; }
    button:hover:not(:disabled), .button:hover { background: #2f6fed; color: #fff; } button:disabled { opacity: .5; cursor: default; } .x { position: absolute; top: 10px; right: 10px; padding: 2px 8px; background: transparent; border: 0; }
    video { display: block; margin: 0 auto; width: 100%; height: auto; border-radius: 4px; background: #000; }
    img { display: block; margin: 0 auto; width: 100%; height: auto; border-radius: 4px; background: #000; }
    img.checker { background: repeating-conic-gradient(#2a2d34 0 25%, #1e2026 0 50%) 0 / 20px 20px; } /* a transparent picture shows its transparency */
    .frame { position: relative; } .placeholder { margin: 0 auto; width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; background: #0b0c0f; border: 1px dashed rgba(255,255,255,.12); box-sizing: border-box; } img.dim { filter: brightness(.45) blur(1px); transition: filter .2s; }
    .over .cancel { margin-top: 4px; padding: 5px 16px; }
    .over { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #fff; text-shadow: 0 1px 4px #000; }
    .spinner.big { width: 44px; height: 44px; border-width: 4px; }
    .busy { display: flex; align-items: center; gap: 10px; padding: 24px 4px; opacity: .85; }
    .tick { color: #5bd68a; flex: none; }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.25); border-top-color: #2f6fed; border-radius: 50%; animation: spin .8s linear infinite; } .spinner.small { width: 11px; height: 11px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { margin: 0 0 10px; padding: 6px 8px; background: #3a2323; border: 1px solid #7a3030; border-radius: 6px; }
  `,
})
export class RenderDialog implements OnInit, OnDestroy {
  protected readonly render = inject(RenderService);
  /** The API address of the quick picture (`…/render.png?…`), with the camera and the light of the 3D view; empty when a finished render is shown. */
  readonly url = input('');
  /** The quick render's view is orthographic (the URL carries `view=…;ortho`): no depth of field then. */
  protected readonly orthographic = computed(() => /view=[^&]*%3Bortho/.test(this.url()));
  /** A finished full-size render to show. */
  readonly jobId = input('');
  readonly name = input('document');
  readonly close = output<void>();
  protected readonly picture = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly detail = signal('');
  /** The token of the quick render on its way (the API can stop it by it), and the request to drop. */
  private quickToken = '';
  private quickAbort: AbortController | null = null;
  protected readonly cancellable = signal(false);
  protected readonly busyText = signal('Rendering a preview with Blender (800 px, a few seconds)…');
  protected readonly store = inject(DocumentStore);
  /** The parts of the document to choose the focus from (equal names are numbered). */
  protected parts() {
    const seen = new Map<string, number>();
    return this.store.doc().items.map(item => {
      const n = (seen.get(item.name) ?? 0) + 1;
      seen.set(item.name, n);
      return { id: item.id, label: n > 1 ? `${item.name} (${n})` : item.name };
    });
  }
  protected readonly strengths = strengthNames.map((label, i) => ({ value: i + 1, label }));
  protected readonly ambients = ambientNames.map((label, value) => ({ value, label }));
  /** The lamp as a share of its normal strength: every 10 steps of the slider double or halve it. */
  protected readonly beams = beamNames.map((label, value) => ({ value, label }));
  protected chooseBeam(type: number) {
    this.render.setBeam(type);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected readonly hdSizes = hdWidths;
  protected readonly videoSizes = videoWidths;
  protected readonly motions = turntableMotions;
  protected readonly directions = turnDirections;
  protected readonly lengths = turntableLengths;
  protected readonly turntableQualities = turntableQualities;
  /** "about 4 min" for the video as it is set up now; nothing while the API has no guess. */
  protected turntableText() {
    const seconds = this.render.turntableEstimate();
    if (seconds === null) return '';
    const spec = this.render.turntableSpec();
    return `${spec.width} px, ${spec.frames} frames · about ${seconds >= 5400 ? `${(seconds / 3600).toFixed(1)} h` : seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} s`}`;
  }
  /** Closes the dialog so the 3D view can be clicked: the part under the pointer is outlined, a click chooses it, and the dialog comes back. */
  protected pickTrack() {
    this.store.trackPickFromDialog = true;
    this.store.trackPick.set(true);
    this.close.emit();
  }
  protected startTurntable() {
    void this.render.startTurntable(this.url());
  }
  protected readonly shapes = aspects;
  protected chooseAspect(id: Aspect) {
    this.render.setAspect(id);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected toggleTransparent(on: boolean) {
    this.render.setTransparent(on);
    if (this.url() && !this.busy()) void this.quick();
  }
  /** The frame of the picture keeps the chosen shape, so the dialog is as large before the picture is there as after. */
  protected frameRatio() {
    return aspectRatio(this.render.aspect());
  }
  /** As wide as the dialog allows, but never so tall that the picture does not fit the window (a portrait picture is narrower). */
  protected frameWidth() {
    return `min(100%, calc((92vh - 230px) * ${this.frameRatio()}))`;
  }
  protected readonly hdQualities = hdQualities;
  protected readonly colourTargets = [
    { key: 'background' as const, label: 'Background', title: 'The colour of the background behind the parts (the studio default is dark)' },
    { key: 'ground' as const, label: 'Ground', title: 'The colour of the round ground the parts stand on (the studio default is dark)' },
  ];
  protected readonly colourOpen = signal<'background' | 'ground' | null>(null);
  protected colourOf(key: 'background' | 'ground') {
    return key === 'background' ? this.render.background() : this.render.ground();
  }
  protected hex(colour: number | null) {
    return colour === null ? '#1b1d23' : '#' + colour.toString(16).padStart(6, '0'); // the studio's own colours are about this dark
  }
  protected isColour(key: 'background' | 'ground') {
    return (colour: number) => this.colourOf(key) === colour;
  }
  protected chooseColour(key: 'background' | 'ground', colour: number | null) {
    key === 'background' ? this.render.setBackground(colour) : this.render.setGround(colour);
    this.colourOpen.set(null);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected lampText() {
    const share = 2 ** ((this.render.lamp() - 40) / 10) * 100;
    return `${share >= 100 ? Math.round(share) : Math.round(share * 10) / 10} %`;
  }
  protected lampChanged() {
    if (this.url() && !this.busy()) void this.quick();
  }
  protected resetLamp() {
    this.render.setLamp(40);
    this.lampChanged();
  }
  protected readonly fxChoices = fxIds.map((id, i) => ({ id, label: fxNames[i] }));
  protected readonly cutAxes = ['x', 'y', 'z'];
  protected chooseCut(change: Partial<{ axis: string; position: number; flip: boolean }>) {
    this.render.setCut(change);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected chooseFx(id: string) {
    this.render.setFx(id);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected readonly reflectionPresets = reflectionNames.map((label, value) => ({ value, label }));
  protected chooseReflections(preset: number) {
    this.render.setReflections(preset);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected chooseAmbient(level: number) {
    this.render.setAmbient(level);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected chooseStrength(level: number) {
    this.render.setDofStrength(level);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected selected() { return this.store.selectedId(); }
  protected readonly focusCentre = focusCentre;
  protected focusValue() { const id = this.render.focusId(); return id === focusCentre ? id : id && this.store.doc().items.some(i => i.id === id) ? id : ''; }
  protected chooseFocus(id: string) {
    this.render.setFocus(id || null);
    if (this.url() && !this.busy()) void this.quick();
  }
  /** The quick render is on show (it turns the button's spinner into a tick). */
  protected readonly quickReady = signal(false);
  private readonly images = inject(ImagesService);
  /** The quick render on show is in the gallery. */
  protected readonly savedToLibrary = signal(false);

  protected async saveToLibrary() {
    if (this.isVideo() && this.videoQuick) {
      let settings = this.videoQuick.settings;
      try { settings = JSON.stringify({ ...JSON.parse(settings || '{}'), ...(this.render.quickView ? { savedView: this.render.quickView } : {}) }); } catch { /* keep what the API said */ }
      this.savedToLibrary.set(await this.images.addFile(new File([this.videoQuick.blob], `${this.name()} quick.mp4`, { type: 'video/mp4' }), { kind: 'quick', settings }));
      return;
    }
    const last = this.render.lastQuick;
    if (!last) return;
    let settings = last.settings;
    try { settings = JSON.stringify({ ...JSON.parse(last.settings || '{}'), ...(this.render.quickView ? { savedView: this.render.quickView } : {}) }); } catch { /* keep what the API said */ }
    this.savedToLibrary.set(!!(await this.images.saveQuick(last.blob, this.name(), 24, settings)));
  }
  protected fileName = () => `${this.name().replace(/[^\w.-]+/g, '_')}-${this.isVideo() ? 'turntable.mp4' : `render-${this.url() ? 'quick' : 'hd'}.png`}`;
  /** The finished render on show is a turntable video. */
  protected readonly isVideo = signal(false);

  constructor() {
    effect(() => { this.render.turntable(); this.render.hdWidth(); this.render.aspect(); untracked(() => this.render.refreshTurntableEstimate()); }); // the estimate follows what is chosen
    closeOnEscape(() => this.close.emit());
    effect(() => { const url = this.url(); untracked(() => { if (url && this.lastUrl && url !== this.lastUrl) { this.lastUrl = url; void this.quick(true); } }); }); // another view was chosen: its quick render
  }

  /** The saved views of the document (the column at the left of the dialog) and the one that was clicked last. */
  protected readonly views = computed(() => this.store.doc().views ?? []);

  /** Another view was chosen: the 3D view goes there (it glides for 0.6 s), then the quick render is made from that camera. */
  protected async pickView(view: { id: string }) {
    this.store.goToSavedView(view.id);
    await new Promise(resolve => setTimeout(resolve, 750)); // until the camera is there
    const url = this.render.quickUrlProvider?.();
    if (url) this.render.openQuick(url); // the new address: the dialog renders it
  }

  private lastUrl = '';

  ngOnInit() {
    this.lastUrl = this.url();
    void (this.jobId() ? this.finished() : this.quick());
  }

  ngOnDestroy() {
    this.forget();
  }

  private forget() {
    if (this.picture()) URL.revokeObjectURL(this.picture());
  }

  private show(blob: Blob, detail: string) {
    this.forget();
    this.picture.set(URL.createObjectURL(blob));
    this.detail.set(detail);
  }

  /** The full-size render that was made in the background. */
  private async finished() {
    this.busyText.set('Loading the render…');
    this.busy.set(true);
    try {
      const id = this.jobId();
      const status = await (await fetch(`/api/render-jobs/${id}`, { cache: 'no-store' })).json();
      this.isVideo.set(status.kind === 'turntable');
      const response = await fetch(`/api/render-jobs/${id}/${status.kind === 'turntable' ? 'video.mp4' : 'image.png'}`, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      this.show(await response.blob(), `${status.width} px · ${status.samples} samples · ${Math.floor(status.elapsed / 60)}:${String(Math.round(status.elapsed % 60)).padStart(2, '0')}`);
      void this.render.collect(id); // looked at: the API can forget it (the picture stays here until the dialog closes)
    } catch (error) {
      this.error.set(`The render is not available any more: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.busy.set(false);
    }
  }

  /** The quick video on show, with what the API said it was made with. */
  private videoQuick: { blob: Blob; settings: string } | null = null;

  /** What the quick video is: a few seconds of the chosen motion, small and with few samples. */
  protected quickVideoText(draft = false) {
    const seconds = Math.min(this.render.turntable().seconds, 5);
    return `${seconds} s at ${draft ? 12 : 24} frames per second, ${draft ? 320 : 640} px wide, ${this.render.turntable().motion === 'spin' ? 'objects turn' : 'camera circles'}`;
  }

  /** A small turntable video of this view, made at once (not queued) and shown here like the quick render. */
  protected async quickVideo(draft = false) {
    this.quickReady.set(false);
    this.savedToLibrary.set(false);
    this.busyText.set(draft ? 'Rendering a draft turntable video (tiny and rough)…' : 'Rendering a quick turntable video (small, up to a minute)…');
    this.busy.set(true);
    this.error.set('');
    try {
      const quickUrl = new URL(this.url().replace('/render.png', '/render.mp4'), location.origin);
      this.render.dofParams(quickUrl);
      const choice = this.render.turntable();
      if (draft) { quickUrl.searchParams.set('width', '320'); quickUrl.searchParams.set('samples', '2'); quickUrl.searchParams.set('fps', '12'); }
      quickUrl.searchParams.set('motion', choice.motion);
      quickUrl.searchParams.set('direction', choice.direction);
      quickUrl.searchParams.set('seconds', String(Math.min(choice.seconds, 5)));
      if (this.render.tracked()) quickUrl.searchParams.set('track', this.render.tracked()!.id);
      quickUrl.searchParams.set('trackPivot', this.render.trackPivot());
      quickUrl.searchParams.set('lookAt', this.render.lookAt());
      const response = await fetch(quickUrl, { cache: 'no-store', signal: this.beginQuick(quickUrl) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const blob = await response.blob();
      this.videoQuick = { blob, settings: response.headers.get('X-Render-Settings') ?? '' };
      this.isVideo.set(true);
      this.show(blob, `${draft ? 320 : 640} px · ${draft ? 'draft' : 'quick'} video · ${this.quickVideoText(draft)}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.error.set(`Render failed: ${error instanceof Error ? error.message : error}`); // a cancel is no failure
    } finally {
      this.cancellable.set(false);
      this.busy.set(false);
    }
  }

  /** Starts the bookkeeping of a quick render: the address gets a token the API stops it by. */
  private beginQuick(url: URL): AbortSignal {
    this.quickToken = crypto.randomUUID().replace(/-/g, '');
    this.quickAbort = new AbortController();
    url.searchParams.set('token', this.quickToken);
    this.cancellable.set(true);
    return this.quickAbort.signal;
  }

  protected cancelQuick() {
    const token = this.quickToken;
    this.quickAbort?.abort();
    if (token) void fetch(`/api/quick-render/cancel?token=${token}`, { method: 'POST' }).catch(() => undefined); // Blender stops, too
    this.error.set('');
  }

  protected async quick(force = false, draft = false) {
    this.isVideo.set(false);
    const quickUrl = new URL(this.url(), location.origin);
    this.render.dofParams(quickUrl);
    if (draft) { quickUrl.searchParams.set('width', '320'); quickUrl.searchParams.set('samples', '4'); }
    const key = quickUrl.href + '\n' + JSON.stringify(this.store.doc().items); // clean (nothing changed since the last picture) or dirty (render again)
    const last = this.render.lastQuick;
    if (!force && last?.key === key) {
      this.error.set('');
      this.show(last.blob, last.detail);
      this.quickReady.set(true);
      return;
    }
    this.quickReady.set(false);
    this.savedToLibrary.set(false);
    this.busyText.set(draft ? 'Rendering a draft with Blender (320 px, a second or two)…' : 'Rendering a preview with Blender (800 px, a few seconds)…');
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch(quickUrl, { cache: 'no-store', signal: this.beginQuick(quickUrl) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const blob = await response.blob();
      const detail = `${draft ? '320 px · 4 samples · draft' : '800 px · 24 samples'}${this.render.crop() ? ' · cropped' : ''}${this.render.depthOfField() ? ' · depth of field' : ''}`;
      this.render.lastQuick = { key, blob, detail, settings: response.headers.get('X-Render-Settings') ?? '' };
      this.show(blob, detail);
      this.quickReady.set(true);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.error.set(`Render failed: ${error instanceof Error ? error.message : error}`); // a cancel is no failure
    } finally {
      this.cancellable.set(false);
      this.busy.set(false);
    }
  }

  protected toggleCrop(on: boolean) {
    this.render.setCrop(on);
    if (this.url() && !this.busy()) void this.quick();
  }

  /** The checkbox: remembered, and the quick picture on show is made again with it. */
  protected toggleDepthOfField(on: boolean) {
    this.render.setDepthOfField(on);
    if (this.url() && !this.busy()) void this.quick();
  }

  protected async startFullSize() {
    await this.render.startFullSize(this.url());
    this.close.emit(); // it runs in the background now
  }
}
