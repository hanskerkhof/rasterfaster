import { highlightParts, parseTerms } from './filter-terms';

describe('parseTerms', () => {
  it('splits on spaces and lowercases', () => {
    expect(parseTerms('PANEL S2')).toEqual({ include: ['panel', 's2'], exclude: [] });
    expect(parseTerms('  panel   s2 ')).toEqual({ include: ['panel', 's2'], exclude: [] });
    expect(parseTerms('   ')).toEqual({ include: [], exclude: [] });
  });

  it('takes a quoted phrase as one term and a minus as an exclusion', () => {
    expect(parseTerms('"PANEL MOUNT" s2')).toEqual({ include: ['panel mount', 's2'], exclude: [] });
    expect(parseTerms('panel -copy -"old part"')).toEqual({ include: ['panel'], exclude: ['copy', 'old part'] });
    expect(parseTerms('"unfinished')).toEqual({ include: ['unfinished'], exclude: [] });
    expect(parseTerms('panel - ""')).toEqual({ include: ['panel'], exclude: [] });
    expect(parseTerms('a-b')).toEqual({ include: ['a-b'], exclude: [] });
  });
});

describe('highlightParts', () => {
  const marked = (text: string, query: string) => highlightParts(text, query).map(p => (p.hit ? `[${p.text}]` : p.text)).join('');

  it('marks every term wherever it occurs, whatever the case', () => {
    expect(marked('USB-C PANEL MOUNT_RF2 v636_WS2812B', 'panel S2')).toBe('USB-C [PANEL] MOUNT_RF2 v636_W[S2]812B');
    expect(marked('BOLT FEET S2', 'feet s2')).toBe('BOLT [FEET] [S2]');
    expect(marked('panel panel', 'panel')).toBe('[panel] [panel]');
  });

  it('joins terms that overlap or touch and ignores exclusions and empty queries', () => {
    expect(marked('PANEL MOUNT', 'pan panel')).toBe('[PANEL] MOUNT');
    expect(marked('PANELS2', 'panel s2')).toBe('[PANELS2]');
    expect(marked('PANEL copy', 'panel -copy')).toBe('[PANEL] copy');
    expect(marked('anything', '')).toBe('anything');
    expect(marked('no hit here', 'zzz')).toBe('no hit here');
  });
});
