import { animateChange } from '/motion.js';

const tabs = [...document.querySelectorAll('.resumer-checkpoint-tabs [role="tab"]')];
const tablist = document.querySelector('.resumer-checkpoint-tabs');
const guidance = document.getElementById('resumer-sample-guidance');

function selectTab(selected, focus = false) {
  const changed = selected.getAttribute('aria-selected') !== 'true';
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
  tablist.dataset.view = selected.id === 'return-tab' ? 'return' : 'checkpoint';
  guidance.textContent = selected.id === 'return-tab'
    ? 'Review it against the changed files before continuing.'
    : 'Blocker to recheck: shared test account access is unverified. A file change will not resolve it.';
  if (changed) {
    const panel = document.getElementById(selected.getAttribute('aria-controls'));
    const direction = selected.id === 'return-tab' ? 1 : -1;
    animateChange(panel, [
      { transform: `translateX(${direction * 12}px)`, clipPath: 'inset(0 1.5% 0 1.5%)', opacity: .84 },
      { transform: 'translateX(0)', clipPath: 'inset(0)', opacity: 1 },
    ], { duration: 320 });
    const changedLine = panel.querySelector('.resumer-diff-text p:last-child');
    if (changedLine) animateChange(changedLine, [
      { backgroundColor: '#d1e4d8' }, { backgroundColor: '#ebf2ed' },
    ], { duration: 420 });
  }
  if (focus) selected.focus();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let target;
    if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') target = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') target = tabs[0];
    if (event.key === 'End') target = tabs.at(-1);
    if (target) { event.preventDefault(); selectTab(target, true); }
  });
}

// The journal remains readable if this module cannot load; only live tabs activate.
for (const tab of tabs) tab.disabled = false;
document.getElementById('resumer-example-unavailable').hidden = true;

const capture = document.querySelector('.resumer-evidence-image');
const captureFallback = document.querySelector('.resumer-capture-fallback');
function showCaptureFallback() { capture.closest('picture').hidden = true; captureFallback.hidden = false; }
capture.addEventListener('error', showCaptureFallback);
if (capture.complete && capture.naturalWidth === 0) showCaptureFallback();
