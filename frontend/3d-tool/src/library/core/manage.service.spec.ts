import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { provideRfLibrary } from './library.config';
import { ManageService } from './manage.service';

describe('ManageService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('is on until it is switched off, and remembers it', () => {
    const manage = TestBed.inject(ManageService);
    expect(manage.enabled()).toBe(true);
    manage.toggle();
    expect(manage.enabled()).toBe(false);
    expect(localStorage.getItem('rasterfaster.manage')).toBe('false');
    TestBed.resetTestingModule();
    expect(TestBed.inject(ManageService).enabled()).toBe(false); // a new page starts as it was left
    TestBed.inject(ManageService).set(true);
    expect(TestBed.inject(ManageService).enabled()).toBe(true);
  });

  it('stays off, and locked, when the host made the library read-only', () => {
    TestBed.configureTestingModule({ providers: [provideRfLibrary({ readOnly: true })] });
    const manage = TestBed.inject(ManageService);
    expect(manage.locked()).toBe(true);
    expect(manage.enabled()).toBe(false);
    manage.set(true);
    expect(manage.enabled()).toBe(false);
  });
});
