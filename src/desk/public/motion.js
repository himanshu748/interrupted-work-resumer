// Motion is a presentation layer: the DOM always holds the current result first.
const byElement = new WeakMap();
const active = new Set();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function cancelMotion(element) {
  byElement.get(element)?.cancel();
}

export function animateChange(element, keyframes, options = {}) {
  if (!element) return null;
  for (const animation of active) {
    if (!animation.effect?.target?.isConnected) animation.cancel();
  }
  cancelMotion(element);
  if (reducedMotion.matches || document.hidden || !element.isConnected || typeof element.animate !== 'function') return null;
  const animation = element.animate(keyframes, {
    duration: 300,
    easing: 'cubic-bezier(.16,1,.3,1)',
    ...options,
    iterations: 1,
    fill: 'none',
  });
  byElement.set(element, animation);
  active.add(animation);
  const release = () => {
    active.delete(animation);
    if (byElement.get(element) === animation) byElement.delete(element);
  };
  animation.addEventListener('finish', release, { once: true });
  animation.addEventListener('cancel', release, { once: true });
  animation.finished.catch(() => {});
  return animation;
}

function cancelAll() {
  for (const animation of active) animation.cancel();
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) cancelAll(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll(); });
window.addEventListener('pagehide', cancelAll);
