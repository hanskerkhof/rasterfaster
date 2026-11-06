import { DestroyRef, ElementRef, afterNextRender, inject } from '@angular/core';

/** The place (px from the top left of its container) that keeps a panel of this size completely inside the container. */
export function insidePlace(left: number, top: number, width: number, height: number, parentWidth: number, parentHeight: number): { left: number; top: number } {
  return { left: Math.max(0, Math.min(left, parentWidth - width)), top: Math.max(0, Math.min(top, parentHeight - height)) };
}

/**
 * Calls `clamp` when the container or the panel changes size (the window, the file panel opening or closing, the panel's own content), so that a
 * floating panel that was left near an edge comes back inside instead of staying out of sight. Call it in a constructor.
 */
export function watchInside(clamp: (host: HTMLElement, parent: HTMLElement) => void): void {
  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const destroy = inject(DestroyRef);
  afterNextRender(() => {
    const parent = host.offsetParent as HTMLElement | null;
    if (!parent) return;
    const run = () => clamp(host, parent);
    const observer = new ResizeObserver(run);
    observer.observe(parent);
    observer.observe(host);
    run();
    destroy.onDestroy(() => observer.disconnect());
  });
}
