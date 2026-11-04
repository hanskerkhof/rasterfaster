import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { LibraryService, TrashItem } from '../core/library.service';
import { TrashDialog } from './trash-dialog';

const item = (id: string, over: Partial<TrashItem> = {}): TrashItem => ({ id, name: `${id}.stl`, originalPath: `a/${id}.stl`, kind: 'file', deletedAt: 1, size: 10, missing: false, ...over });

describe('trash dialog: Put Back All', () => {
  function setup(items: TrashItem[], taken: string[] = []) {
    const calls: string[] = [];
    const lib = {
      trashCount: signal(0),
      trashList: () => of(items),
      putBack: (id: string, onConflict?: 'rename') => {
        calls.push(onConflict ? `${id}:rename` : id);
        if (taken.includes(id) && !onConflict) return throwError(() => ({ status: 409 }));
        return of({ path: `a/${id}.stl` });
      },
    };
    TestBed.configureTestingModule({ providers: [{ provide: LibraryService, useValue: lib }] });
    const fixture = TestBed.createComponent(TrashDialog);
    fixture.detectChanges();
    return { fixture, calls, text: () => fixture.nativeElement.textContent as string };
  }

  it('is the button before Empty Trash, and puts everything back, the oldest first, renaming what is taken', async () => {
    const { fixture, calls, text } = setup([item('new'), item('mid'), item('old')], ['mid']);
    await fixture.whenStable();
    fixture.detectChanges();
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll('header button')].map(b => b.textContent!.trim());
    expect(buttons.indexOf('Put Back All')).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf('Put Back All')).toBeLessThan(buttons.indexOf('Empty Trash…'));
    const all = [...(fixture.nativeElement as HTMLElement).querySelectorAll('header button')].find(b => b.textContent!.trim() === 'Put Back All') as HTMLButtonElement;
    all.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(calls).toEqual(['old', 'mid', 'mid:rename', 'new']);
    expect(text()).toContain('Put back 3 items (1 as “(restored)”');
  });

  it('leaves items that are missing from the Trash alone', async () => {
    const { fixture, calls } = setup([item('a'), item('gone', { missing: true })]);
    await fixture.whenStable();
    fixture.detectChanges();
    ([...(fixture.nativeElement as HTMLElement).querySelectorAll('header button')].find(b => b.textContent!.trim() === 'Put Back All') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(calls).toEqual(['a']);
  });
});
