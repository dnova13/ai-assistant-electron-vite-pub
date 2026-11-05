import type { CharacterBounds } from './character';

/** 말풍선의 꼬리를 캐릭터 위에 두고 남은 공간 안에서 긴 글을 스크롤한다. */
export function bindMascotBubble(bubble: HTMLElement, text: HTMLElement, host: HTMLElement, bounds: () => CharacterBounds | null, follow: () => boolean) {
  let frame = 0;
  let moving = false;
  const place = () => {
    if (bubble.classList.contains('hidden')) return;
    const character = bounds() || host.getBoundingClientRect();
    const padding = 6, gap = 8, tail = 7;
    const style = getComputedStyle(bubble);
    const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 18;
    const room = character.top - padding - gap - tail - verticalPadding;
    text.style.maxHeight = `${Math.max(lineHeight, Math.min(128, room))}px`;
    const rect = bubble.getBoundingClientRect();
    const top = Math.max(padding, Math.min(character.top - gap - tail - rect.height, window.innerHeight - padding - tail - rect.height));
    bubble.style.top = `${top}px`;
    const center = character.left + character.width / 2;
    bubble.style.setProperty('--bubble-tip-left', `${Math.max(14, Math.min(rect.width - 14, center - rect.left))}px`);
    if (follow()) text.scrollTop = text.scrollHeight;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); if (moving) schedule(); });
  };
  const transition = (event: TransitionEvent) => {
    if (event.propertyName !== 'transform') return;
    moving = event.type === 'transitionrun';
    schedule();
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(host);
  resize.observe(bubble);
  const mutation = new MutationObserver(schedule);
  mutation.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'src'] });
  host.addEventListener('load', schedule, true);
  host.addEventListener('error', schedule, true);
  host.addEventListener('transitionrun', transition, true);
  host.addEventListener('transitionend', transition, true);
  host.addEventListener('transitioncancel', transition, true);
  window.addEventListener('resize', schedule);
  place();
  return {
    place,
    schedule,
    dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect(); mutation.disconnect();
      host.removeEventListener('load', schedule, true);
      host.removeEventListener('error', schedule, true);
      host.removeEventListener('transitionrun', transition, true);
      host.removeEventListener('transitionend', transition, true);
      host.removeEventListener('transitioncancel', transition, true);
      window.removeEventListener('resize', schedule);
    }
  };
}
