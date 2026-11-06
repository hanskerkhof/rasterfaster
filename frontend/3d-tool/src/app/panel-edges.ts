import { Component, input, output } from '@angular/core';
import { EdgeMode } from './floating-panel';

/**
 * The handles for changing the size of a floating panel: the left and right edge, the bottom edge and the two bottom corners (the right one shows the usual
 * corner mark). Put it in the panel's template; the panel starts the resize (`startResize`) from the event. A folded panel has only its side edges.
 */
@Component({
  selector: 'app-panel-edges',
  template: `
    <div class="edge w" (pointerdown)="start.emit({ event: $event, mode: 'w' })"></div>
    <div class="edge e" (pointerdown)="start.emit({ event: $event, mode: 'e' })"></div>
    @if (!collapsed()) {
      <div class="edge s" (pointerdown)="start.emit({ event: $event, mode: 's' })"></div>
      <div class="edge sw" (pointerdown)="start.emit({ event: $event, mode: 'sw' })"></div>
      <div class="edge se" (pointerdown)="start.emit({ event: $event, mode: 'se' })"></div>
    }
  `,
  styles: `
    :host { display: contents; }
    .edge { position: absolute; touch-action: none; z-index: 1; }
    .edge.w { left: -3px; top: 24px; bottom: 12px; width: 7px; cursor: ew-resize; }
    .edge.e { right: -3px; top: 24px; bottom: 12px; width: 7px; cursor: ew-resize; }
    .edge.s { left: 12px; right: 12px; bottom: -3px; height: 7px; cursor: ns-resize; }
    .edge.sw { left: -3px; bottom: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
    .edge.se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .edge.se::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 9px; height: 9px; opacity: .5;
      background: linear-gradient(135deg, transparent 50%, #8a93a2 50%, #8a93a2 60%, transparent 60%, transparent 75%, #8a93a2 75%, #8a93a2 85%, transparent 85%); }
    .edge.se:hover::after { opacity: 1; }
  `,
})
export class PanelEdges {
  readonly collapsed = input(false);
  readonly start = output<{ event: PointerEvent; mode: EdgeMode }>();
}
