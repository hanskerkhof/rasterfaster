/**
 * Scrolls a list while something is dragged near (or past) its top or bottom edge, so the first and the last rows can be reached: the speed grows the closer
 * the pointer is to the edge, and `scrolled` is called after every step (the drag then works out where the row would land again). Returns the function that stops it.
 */
export function autoScroll(list: HTMLElement, pointerY: () => number, scrolled: () => void, zone = 32, maxStep = 16): () => void {
  const tick = () => {
    const rect = list.getBoundingClientRect(), y = pointerY();
    const fromTop = y - rect.top, fromBottom = rect.bottom - y;
    const step = fromTop < zone ? -Math.min(maxStep, Math.ceil(((zone - fromTop) / zone) * maxStep)) : fromBottom < zone ? Math.min(maxStep, Math.ceil(((zone - fromBottom) / zone) * maxStep)) : 0;
    if (step) {
      const before = list.scrollTop;
      list.scrollTop += step;
      if (list.scrollTop !== before) scrolled();
    }
  };
  const timer = setInterval(tick, 16); // a timer, not animation frames: those stop when the window is in the background
  return () => clearInterval(timer);
}
