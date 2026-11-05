// 전역 단축키 문자열 검사.
// Electron은 잘못된 단축키도 오류 없이 받아들이는 경우가 있어서 직접 검사한다.
// electron을 불러오지 않는 파일이라 시험에서 그대로 쓸 수 있다.

const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);
const KEYS = new Set(
  [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    ')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '+', '=', '<', ',', '_', '-', '>', '.', '?', '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'",
    'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'PrintScreen',
    'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause'
  ].map((k) => k.toLowerCase())
);

/** 문제가 없으면 null, 있으면 이유 */
export function checkAccelerator(acc: string): string | null {
  const parts = acc.split('+');
  // "Shift++" 처럼 + 키 자체를 쓰는 경우
  if (acc.endsWith('++')) parts.splice(-2, 2, '+');
  const key = parts.pop();
  if (!key || !KEYS.has(key.toLowerCase())) return `알 수 없는 키입니다: ${key || '(없음)'}`;
  const mods = parts.map((m) => m.toLowerCase());
  if (mods.some((m) => !MODIFIERS.has(m))) return `알 수 없는 조합키입니다: ${parts.join('+')}`;
  if (new Set(mods).size !== mods.length) return '같은 조합키가 두 번 있습니다.';
  if (!mods.length && !/^f\d+$/i.test(key)) return '기능키(F1~F24)가 아니면 Ctrl·Cmd·Alt·Shift 중 하나를 같이 눌러야 합니다.';
  return null;
}

/** 개발자 도구를 여는 키인지: F12, 맥 Cmd+Option+I, 윈도우·리눅스 Ctrl+Shift+I (개발 모드에서만 연결된다) */
export function isDevToolsKey(input: { key: string; control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }, platform: string): boolean {
  if (input.key === 'F12') return true;
  if (input.key.toLowerCase() !== 'i') return false;
  return platform === 'darwin' ? !!input.meta && !!input.alt && !input.control : !!input.control && !!input.shift && !input.alt;
}
