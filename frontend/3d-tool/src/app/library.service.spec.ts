import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { LibraryService, TrashItem } from './library.service';

const item = (name: string, originalPath: string, kind: 'file' | 'directory'): TrashItem => ({ id: name, name, originalPath, kind } as TrashItem);

describe('LibraryService.trashedFrom (where did a missing file go?)', () => {
  let lib: LibraryService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    lib = TestBed.inject(LibraryService);
    lib.trashItems.set([
      item('___GOOD LUCK WITH THE SHOW', '___GOOD LUCK WITH THE SHOW', 'directory'),
      item('single.stl', 'MOUNTS/single.stl', 'file'),
    ]);
  });

  it('finds the folder that was trashed above a file, and a trashed file itself', () => {
    expect(lib.trashedFrom('___GOOD LUCK WITH THE SHOW/4.1 v154_TOETER.stl')?.name).toBe('___GOOD LUCK WITH THE SHOW');
    expect(lib.trashedFrom('___GOOD LUCK WITH THE SHOW/deeper/x.stl')?.kind).toBe('directory');
    expect(lib.trashedFrom('MOUNTS/single.stl')?.kind).toBe('file');
  });

  it('does not mix up folders whose names only start the same, or things that are not in the Trash', () => {
    expect(lib.trashedFrom('___GOOD LUCK WITH THE SHOW 2/x.stl')).toBeNull();
    expect(lib.trashedFrom('MOUNTS/single.stl.bak')).toBeNull();
    expect(lib.trashedFrom('MOUNTS/other.stl')).toBeNull();
  });
});
