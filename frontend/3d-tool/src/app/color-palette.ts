import { Component, input, output } from '@angular/core';
import { itemColors } from './document.store';
import { plaColors } from './pla-colors';

/**
 * The colours to choose from: the app's own eight, and under them a PLA section with the colours of Bambu Lab PLA Basic. Used by the Color
 * flyout of the object menu and by the Solid ground of the view cube menu. It lays out as a grid six swatches wide; the place it sits in
 * (a flyout) gives it its frame.
 */
@Component({
  selector: 'app-color-palette',
  template: `
    @for (c of colors; track c) {
      <button type="button" class="swatch" role="menuitem" [class.on]="isOn()(c)" [style.background]="hex(c)" [title]="hex(c)" (click)="picked.emit(c)"></button>
    }
    <div class="section">PLA <small>Bambu Lab Basic</small></div>
    @for (c of pla; track c.color) {
      <button type="button" class="swatch" role="menuitem" [class.on]="isOn()(c.color)" [style.background]="hex(c.color)" [title]="c.name + ' ' + hex(c.color)" [attr.aria-label]="c.name" (click)="picked.emit(c.color)"></button>
    }
  `,
  styles: `
    :host { display: grid; grid-template-columns: repeat(6, 28px); gap: 4px; }
    .section { grid-column: 1 / -1; margin-top: 4px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.14); font-size: 11px; font-weight: 600; opacity: .8; color: #dde1e8; } .section small { font-weight: 400; opacity: .7; margin-left: 4px; }
    .swatch { display: block; width: 28px; height: 28px; padding: 0; border: 2px solid transparent; border-radius: 5px; cursor: pointer; }
    .swatch:hover:not(:disabled) { background-color: inherit; border-color: #fff; }
    .swatch.on { border-color: #fff; box-shadow: inset 0 0 0 2px #2b2f38; }
  `,
})
export class ColorPalette {
  /** Tells whether a colour is the chosen one (the Color menu: all selected parts have it). */
  readonly isOn = input<(color: number) => boolean>(() => false);
  readonly picked = output<number>();
  protected readonly colors = itemColors;
  protected readonly pla = plaColors;

  protected hex(c: number) {
    return '#' + c.toString(16).padStart(6, '0');
  }
}
