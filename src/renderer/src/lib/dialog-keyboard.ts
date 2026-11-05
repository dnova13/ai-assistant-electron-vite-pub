// 선택·확인 창이 열린 동안 버튼 초점과 키 입력을 그 창 안에 유지한다.
export function bindDialogKeyboard(root: HTMLElement, onCancel: () => void): () => void {
  const doc = root.ownerDocument;
  const previous = doc.activeElement as HTMLElement | null;
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const initial = () => buttons().find((b) => b.dataset.dialogInitial === 'true') || buttons().find((b) => b.dataset.dialogCancel === 'true') || buttons()[0];
  let last: HTMLButtonElement | undefined;
  const focus = (button = initial()) => {
    last = button;
    (button || root).focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest' });
  };
  const onFocus = (event: FocusEvent) => {
    const target = event.target as Node | null;
    if (!target || !root.contains(target)) {
      focus(last?.isConnected ? last : initial());
    } else if (buttons().includes(target as HTMLButtonElement)) last = target as HTMLButtonElement;
  };
  const onWindowFocus = () => {
    if (!root.contains(doc.activeElement)) focus(last?.isConnected ? last : initial());
  };
  const onKey = (event: KeyboardEvent) => {
    const typing = event.target instanceof HTMLElement && !!event.target.closest('input, textarea');
    if (typing && !['Escape', 'Tab'].includes(event.key)) return;
    if (event.key === 'Tab') {
      event.stopImmediatePropagation(); event.preventDefault();
      if (event.type === 'keydown') {
        const all = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
        const i = all.indexOf(doc.activeElement as HTMLElement);
        all[(i + (event.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      }
      return;
    }
    // 다른 대화창 단축키·입력줄로 키가 넘어가지 않게 한다. 복사 등 브라우저 기본 동작은 유지한다.
    event.stopImmediatePropagation();
    const key = event.key;
    if (!['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Tab', 'Enter', ' ', 'Escape'].includes(key)) return;
    event.preventDefault();
    if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229) return;
    if (key === 'Escape') {
      if (!event.repeat) onCancel();
      return;
    }
    const all = buttons();
    const active = all.find((b) => b === doc.activeElement) || last || initial();
    if (key === 'Enter' || key === ' ') {
      // 후보 선택 직후 뜬 승인창에 길게 누른 키가 전달되어 연속 실행되는 것을 막는다.
      if (!event.repeat && active && all.includes(active)) active.click();
      return;
    }
    if (!all.length) return;
    const index = Math.max(0, all.indexOf(active!));
    const backwards = key === 'ArrowUp' || key === 'ArrowLeft' || (key === 'Tab' && event.shiftKey);
    focus(all[(index + (backwards ? -1 : 1) + all.length) % all.length]);
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('keyup', onKey, true);
  doc.addEventListener('focusin', onFocus, true);
  doc.defaultView?.addEventListener('focus', onWindowFocus);
  focus();
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('keyup', onKey, true);
    doc.removeEventListener('focusin', onFocus, true);
    doc.defaultView?.removeEventListener('focus', onWindowFocus);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}
