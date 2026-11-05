// 키보드 입력 → Electron 단축키 문자열 (설정 > 일반 > 말하기 단축키 "바꾸기")

const isMacPlatform = (platform: string) => platform === 'darwin';

/** 화면에 보여 줄 모양: CommandOrControl+Shift+Space → Cmd + Shift + Space */
export function prettyKey(acc: string | null | undefined, platform: string): string {
  return acc ? acc.replace('CommandOrControl', isMacPlatform(platform) ? 'Cmd' : 'Ctrl').replace(/\+/g, ' + ') : '없음';
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
};

/** KeyboardEvent 중 여기서 쓰는 부분 */
export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 자판 배열과 무관하게 e.code를 쓴다. 쓸 수 없는 조합이면 null */
export function toAccelerator(e: KeyLike, platform: string): string | null {
  const code = e.code;
  const mac = isMacPlatform(platform);
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else key = CODE_KEYS[code] || null;
  if (!key) return null;
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
  if (mac && e.ctrlKey) mods.push('Control');
  if (!mac && e.metaKey) mods.push('Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // 기능키가 아니면 조합키가 꼭 있어야 한다 (글자 하나를 가로채면 타자를 못 친다)
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}
