/**
 * The filament colours of Bambu Lab PLA Basic (the swatches taken from the maker's colour chart), for the Color menu. The colours the app
 * picks by itself for new parts (`itemColors` in document.store.ts) are a separate, shorter list.
 */
export interface PlaColor {
  name: string;
  color: number;
}

const pla = (name: string, hex: string): PlaColor => ({ name, color: parseInt(hex.slice(1), 16) });

export const plaColors: readonly PlaColor[] = [
  pla('White', '#ffffff'), pla('Beige', '#f4e7df'), pla('Light grey', '#d1d3d5'), pla('Yellow', '#f3ee58'), pla('Sunflower yellow', '#f5c844'),
  pla('Gold', '#debe74'), pla('Light orange', '#f0943b'), pla('Orange', '#ed7333'), pla('Lime', '#c1ce42'),
  pla('Bright green', '#5bc056'), pla('Green', '#548c4c'), pla('Soft pink', '#e36576'), pla('Pink', '#e3607e'), pla('Magenta', '#d82e8a'),
  pla('Red', '#b23b2a'), pla('Dark red', '#902d38'), pla('Purple', '#5a44b1'), pla('Dark purple', '#442b5d'),
  pla('Teal', '#4fafb6'), pla('Blue', '#3a84d0'), pla('Dark blue', '#2254b2'), pla('Navy', '#132884'), pla('Copper brown', '#924833'),
  pla('Brown', '#6a5138'), pla('Olive', '#837d4f'), pla('Grey-green', '#8e908a'), pla('Grey', '#a7a9aa'),
  pla('Blue grey', '#5d6577'), pla('Dark grey', '#545454'), pla('Black', '#000000'),
];
