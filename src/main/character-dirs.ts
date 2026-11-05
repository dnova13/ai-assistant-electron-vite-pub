// 캐릭터 폴더 두 곳: 기본 캐릭터(앱에 같이 들어 있음, 읽기 전용)와 내가 추가한 캐릭터(my-characters).
// electron을 안 불러서 시험할 수 있다. 목록 읽기, 그림 주소 → 폴더 찾기, 예전 설정 옮기기.
import fs from 'node:fs';
import path from 'node:path';
import type { Character } from '@shared/types';

/** 앱에 같이 들어 있는 기본 캐릭터 (이름 목록은 폴더 위치와 함께 쓰는 이중 안전장치) */
export const BUILTIN_IDS = ['sample'];
export const builtinOverridesDir = (userDir: string): string => path.join(userDir, '_builtin-overrides');

/** 폴더 하나의 캐릭터를 읽는다 (_·. 로 시작하는 폴더는 견본·보관이라 뺀다) */
function readDir(dir: string, builtin: boolean, skip: Set<string>): Character[] {
  const list: Character[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || /^[._]/.test(entry.name) || skip.has(entry.name)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'config.json'), 'utf8'));
      if (config && typeof config === 'object') list.push({ id: entry.name, config, ...(builtin ? { builtin: true } : {}) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('캐릭터 config 읽기 실패:', entry.name, (e as Error).message);
    }
  }
  return list;
}

/** 기본 캐릭터 + 내가 추가한 캐릭터. 같은 이름이면 기본 캐릭터가 이긴다 (내 쪽은 무시) */
export function scanCharacterDirs(builtinDir: string, userDir: string): Character[] {
  const overrides = readDir(builtinOverridesDir(userDir), true, new Set());
  const base = readDir(builtinDir, true, new Set()).map((c) => overrides.find((v) => v.id === c.id) || c);
  const taken = new Set([...base.map((c) => c.id), ...BUILTIN_IDS]);
  return [...base, ...readDir(userDir, false, taken)];
}

/** 캐릭터 id가 들어 있는 폴더 (기본 폴더 우선). 어디에도 없으면 null. id는 폴더 이름 하나여야 한다 */
export function dirOfCharacter(builtinDir: string, userDir: string, id: string): string | null {
  if (!id || id !== path.basename(id) || /[\\/]/.test(id) || /^[._]/.test(id)) return null; // '..' · '.' · 숨김·견본 폴더는 캐릭터가 아님
  for (const d of [builtinDir, userDir]) if (fs.existsSync(path.join(d, id))) return d;
  return null;
}

/**
 * 그림 주소(`/characters/<id>/…`의 id 뒤쪽 경로)가 읽을 폴더. 기본 폴더에 그 id가 있으면 기본 폴더, 아니면 내 폴더.
 * 읽기만 하는 길이다. 여기서 고른 폴더에 쓰거나 지우는 일은 없다.
 */
export function dirForCharacterUrl(builtinDir: string, userDir: string, rel: string): string {
  const id = rel.split('/').filter(Boolean)[0] || '';
  if (BUILTIN_IDS.includes(id)) {
    const root = builtinOverridesDir(userDir);
    const file = path.resolve(root, rel);
    if (path.dirname(file) === path.join(root, id) && fs.existsSync(file)) return root;
  }
  return dirOfCharacter(builtinDir, userDir, id) || userDir;
}

export function isBuiltinId(id: string, list?: Character[]): boolean {
  return BUILTIN_IDS.includes(id) || !!(list && list.some((c) => c.id === id && c.builtin));
}

/**
 * 설치본 예전 방식(userData/characters 에 기본+추가가 섞여 있음)에서 내가 추가한 캐릭터만 my-characters로 **복사**한다.
 * 원래 폴더는 그대로 둔다 (지우지 않음). my-characters가 이미 있으면 아무것도 하지 않는다. 복사한 개수를 돌려준다.
 */
export function migrateOldCharacters(oldDir: string, userDir: string): number {
  if (fs.existsSync(userDir) || !fs.existsSync(oldDir)) {
    fs.mkdirSync(userDir, { recursive: true });
    return 0;
  }
  fs.mkdirSync(userDir, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || /^[._]/.test(entry.name) || BUILTIN_IDS.includes(entry.name)) continue;
    if (!fs.existsSync(path.join(oldDir, entry.name, 'config.json'))) continue;
    try {
      fs.cpSync(path.join(oldDir, entry.name), path.join(userDir, entry.name), { recursive: true });
      n++;
    } catch (e) {
      console.error('캐릭터 옮기기 실패:', entry.name, (e as Error).message);
    }
  }
  return n;
}
