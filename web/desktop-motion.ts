import { formatDecimal, parseDecimal } from '../src/domain/decimal';
import { amount } from './desktop-ui';

const duration = 640;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
type ContentState = { scope: string; markup: string; root: ChildNode | null; finish?: () => void };
const contents = new WeakMap<HTMLElement, ContentState>();
const running = new Set<() => void>();

function settle(): void { for (const finish of running) finish(); }
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) settle(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });

/** Interpolate decimal strings without losing source digits to floating point. */
function counter(from: string, to: string): ((fraction: number) => string) | null {
  const pattern = /^[\d,]+(?:\.\d+)?(%?)$/;
  const before = pattern.exec(from); const after = pattern.exec(to);
  if (!before || !after || before[1] !== after[1]) return null;
  try {
    const a = parseDecimal(from.replace(/[,%]/g, ''));
    const b = parseDecimal(to.replace(/[,%]/g, ''));
    const scale = Math.max(a.scale, b.scale);
    const left = a.coefficient * 10n ** BigInt(scale - a.scale);
    const right = b.coefficient * 10n ** BigInt(scale - b.scale);
    if (left === right) return null;
    return fraction => amount(formatDecimal({
      coefficient: left + (right - left) * BigInt(Math.round(fraction * 1_000_000)) / 1_000_000n,
      scale,
    })) + after[1];
  } catch { return null; }
}

/** Keep transitions within one account/category/unit and settle detached content. */
export function renderAnimatedContent(container: HTMLElement, markup: string, scope: string): void {
  const previous = contents.get(container);
  const intact = previous?.root === container.firstChild;
  if (intact && previous?.markup === markup && previous.scope === scope) return;
  const before = new Map<string, string>();
  const oldProgress = container.querySelector<HTMLProgressElement>('progress')?.value;
  container.querySelectorAll<HTMLElement>('[data-motion-key]').forEach(node => {
    before.set(node.dataset.motionKey!, node.textContent ?? '');
  });
  previous?.finish?.();
  container.innerHTML = markup;
  const state: ContentState = { scope, markup, root: container.firstChild };
  contents.set(container, state);
  if (!intact || previous?.scope !== scope || reducedMotion.matches || document.hidden || !container.getClientRects().length) return;

  const frames: ((fraction: number) => void)[] = [];
  const endings: (() => void)[] = [];
  container.querySelectorAll<HTMLElement>('[data-motion-key]').forEach(node => {
    const target = node.textContent ?? '';
    const source = before.get(node.dataset.motionKey!);
    if (source === undefined || source === target) return;
    const interpolate = counter(source, target);
    if (!interpolate) return;
    // Assistive technology and the tooltip always expose the exact new snapshot.
    node.setAttribute('aria-label', target);
    node.classList.add('is-value-updating');
    node.textContent = source;
    frames.push(fraction => { node.textContent = interpolate(fraction); });
    endings.push(() => { node.textContent = target; node.classList.remove('is-value-updating'); node.removeAttribute('aria-label'); });
  });
  const progress = container.querySelector<HTMLProgressElement>('progress');
  if (progress && oldProgress !== undefined && progress.value !== oldProgress) {
    const target = progress.value;
    progress.value = oldProgress;
    frames.push(fraction => { progress.value = oldProgress + (target - oldProgress) * fraction; });
    endings.push(() => { progress.value = target; });
  }
  if (!frames.length) return;
  let frame = 0;
  const started = performance.now();
  const finish = () => {
    cancelAnimationFrame(frame);
    endings.forEach(end => end());
    running.delete(finish);
    state.finish = undefined;
  };
  state.finish = finish;
  running.add(finish);
  const tick = (now: number) => {
    if (!container.isConnected || document.hidden || reducedMotion.matches) { finish(); return; }
    const fraction = Math.min(1, Math.max(0, (now - started) / duration));
    if (fraction === 1) { finish(); return; }
    frames.forEach(update => update(1 - (1 - fraction) ** 3));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
