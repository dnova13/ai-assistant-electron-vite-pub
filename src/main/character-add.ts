// 설정 > 캐릭터: 캐릭터 추가(그림 파일·Live2D 폴더 복사 + config.json), 이름·성격 수정, 그림 바꾸기, 삭제.
// 파일 고르기(대화 상자)는 index.ts에서 하고, 여기는 파일 작업만 한다 (electron 없이 시험할 수 있게).
// 추가하다 실패하면 만들던 폴더를 "_실패-…"로 이름만 바꿔 둔다 (_로 시작하면 목록에 안 나옴).
// 삭제와 그림 바꾸기의 이전 그림은 사용자 요청에 따라 실제로 지운다. 기본 캐릭터(BUILTIN_CHARACTERS)는 지울 수 없다.
import fs from 'node:fs';
import path from 'node:path';
import type { Character, CharacterConfig } from '@shared/types';
import { BUILTIN_IDS, builtinOverridesDir } from './character-dirs';

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const LIVE2D_MAX_BYTES = 300 * 1024 * 1024;
export const LIVE2D_MAX_FILES = 3000;
export const NAME_MAX = 30;
export const PERSONA_MAX = 500;

export interface AddInput {
  name: unknown;
  persona: unknown;
}

const oneLine = (v: unknown) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 캐릭터 이름: 한 줄, 30자까지. 비면 오류 */
export function cleanName(v: unknown): string {
  const s = oneLine(v).slice(0, NAME_MAX);
  if (!s) throw new Error('캐릭터 이름을 적어 주세요.');
  return s;
}

/** 성격(말투): 500자까지. 비어도 된다 */
export function cleanPersona(v: unknown): string {
  return oneLine(v).slice(0, PERSONA_MAX);
}

/**
 * 폴더 이름: 이름에서 OS가 못 쓰는 글자를 빼고 공백은 -로. 앞의 . _ - 는 뺀다 (_로 시작하면 목록에 안 나옴).
 * 이미 있으면 -2, -3 …을 붙인다.
 */
export function folderId(name: string, dir: string, ...otherDirs: string[]): string {
  let base = name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[._\-]+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 40);
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'character';
  // 내 폴더뿐 아니라 기본 캐릭터 폴더에 있는 이름(sample 등)도 피한다
  const taken = (id: string) => BUILTIN_IDS.includes(id) || [dir, ...otherDirs].some((d) => fs.existsSync(path.join(d, id)));
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}

/** 만들던 폴더를 지우지 않고 "_실패-<이름>-<시각>"으로 옮긴다 */
function setAside(dir: string, id: string): void {
  const from = path.join(dir, id);
  if (!fs.existsSync(from)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(from, path.join(dir, `_실패-${id}-${stamp}`));
  } catch {
    /* 옮기지 못하면 그대로 둔다 */
  }
}

function writeConfig(dir: string, id: string, config: CharacterConfig): Character {
  fs.writeFileSync(path.join(dir, id, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return { id, config };
}

/** 그림 캐릭터: 파일을 character.<확장자>로 복사 */
export function addImageCharacter(dir: string, src: string, input: AddInput, builtinDir?: string): Character {
  const name = cleanName(input.name);
  const persona = cleanPersona(input.persona);
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) throw new Error(`그림 파일만 쓸 수 있습니다 (${IMAGE_EXTS.join(', ')}).`);
  const st = fs.statSync(src);
  if (!st.isFile()) throw new Error('파일을 고르세요.');
  if (st.size > IMAGE_MAX_BYTES) throw new Error('20MB보다 작은 그림을 고르세요.');
  fs.mkdirSync(dir, { recursive: true });
  const id = folderId(name, dir, ...(builtinDir ? [builtinDir] : []));
  const file = `character${ext}`;
  try {
    fs.mkdirSync(path.join(dir, id));
    fs.copyFileSync(src, path.join(dir, id, file));
    return writeConfig(dir, id, { name, type: 'image', persona, image: file, icon: file, voice: { voice: 'default' } });
  } catch (e) {
    setAside(dir, id);
    throw e;
  }
}

/** 폴더 안에서 .model3.json을 찾는다 (얕은 곳부터, 4단계까지). 폴더 기준 상대 경로 (/ 구분) */
export function findModel3(root: string): string | null {
  let level = [''];
  for (let depth = 0; depth <= 4 && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const hit = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'));
      if (hit) return rel ? `${rel}/${hit.name}` : hit.name;
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) next.push(rel ? `${rel}/${e.name}` : e.name);
    }
    level = next;
  }
  return null;
}

/** 폴더 크기·파일 수 (링크는 세지 않음, 복사도 안 함) */
function measure(root: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(f).size;
        if (files > LIVE2D_MAX_FILES || bytes > LIVE2D_MAX_BYTES) throw new Error('Live2D 폴더가 너무 큽니다 (300MB, 파일 3000개까지). 모델 폴더만 고르세요.');
      }
    }
  };
  walk(root);
  return { bytes, files };
}

/** .model3.json에서 입 파라미터와 기본 모션 이름을 읽어 채운다. 못 읽으면 기본값 */
export function live2dDefaults(modelFile: string): { mouthOpen: string; idle: string } {
  try {
    const m = JSON.parse(fs.readFileSync(modelFile, 'utf8')) as {
      Groups?: { Name?: string; Ids?: string[] }[];
      FileReferences?: { Motions?: Record<string, unknown> };
    };
    const lip = (m.Groups || []).find((g) => g && g.Name === 'LipSync');
    const motions = Object.keys((m.FileReferences && m.FileReferences.Motions) || {});
    return { mouthOpen: (lip && lip.Ids && lip.Ids[0]) || 'ParamMouthOpenY', idle: motions.find((k) => /idle/i.test(k)) || '' };
  } catch {
    return { mouthOpen: 'ParamMouthOpenY', idle: '' };
  }
}

/** Live2D 캐릭터: 고른 폴더를 <캐릭터>/model/로 복사. Cubism 4(.model3.json)가 있어야 한다 */
export function addLive2dCharacter(dir: string, srcDir: string, input: AddInput, builtinDir?: string): Character {
  const name = cleanName(input.name);
  const persona = cleanPersona(input.persona);
  if (!fs.statSync(srcDir).isDirectory()) throw new Error('폴더를 고르세요.');
  const src = path.resolve(srcDir);
  const base = path.resolve(dir);
  if (src === base || src.startsWith(base + path.sep)) throw new Error('캐릭터 폴더 안의 폴더는 고를 수 없습니다. 다른 곳에 있는 모델 폴더를 고르세요.');
  const model = findModel3(src);
  if (!model) throw new Error('이 폴더에 Live2D 모델 파일(.model3.json)이 없습니다. Cubism 4 모델만 됩니다 (.model.json인 Cubism 2 모델은 안 됨).');
  measure(src);
  fs.mkdirSync(dir, { recursive: true });
  const id = folderId(name, dir, ...(builtinDir ? [builtinDir] : []));
  try {
    fs.mkdirSync(path.join(dir, id));
    fs.cpSync(src, path.join(dir, id, 'model'), {
      recursive: true,
      filter: (f) => !fs.lstatSync(f).isSymbolicLink() && !path.basename(f).startsWith('.')
    });
    const rel = `model/${model}`;
    const d = live2dDefaults(path.join(dir, id, rel));
    return writeConfig(dir, id, {
      name,
      type: 'live2d',
      persona,
      voice: { voice: 'default' },
      live2d: {
        model: rel,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        params: { mouthOpen: d.mouthOpen },
        expressions: { neutral: '', happy: '', thinking: '' },
        motions: { idle: d.idle, thinking: '', talking: '' }
      }
    } as CharacterConfig);
  } catch (e) {
    setAside(dir, id);
    throw e;
  }
}

/* ---------------- 수정·삭제 ---------------- */

/**
 * 앱에 같이 들어 있는 기본 원본은 읽기 전용이다. 수정은 사용자 편집 사본에 저장하고 삭제는 막는다.
 * 이 파일의 수정·삭제 함수는 "내가 추가한 캐릭터 폴더"(my-characters)만 받는다. 수정 함수에는 원본을 읽을 기본 폴더도 넘길 수 있다. 원본에는 쓰지 않는다.
 */
export const BUILTIN_CHARACTERS = BUILTIN_IDS;
export const DEFAULT_CHARACTER = 'sample';
export const isBuiltinCharacter = (id: string): boolean => BUILTIN_CHARACTERS.includes(id);

/** 기본 캐릭터면 오류 (what = 하려던 일). 폴더를 찾기 전에 먼저 막아 안내 문구가 분명하게 나오게 한다 */
export function assertNotBuiltin(id: unknown, what: string): void {
  if (isBuiltinCharacter(String(id ?? ''))) throw new Error(`기본 캐릭터는 ${what} 수 없습니다.`);
}

/** 캐릭터 폴더 경로. id가 폴더 이름 하나가 아니거나(../ 등) 캐릭터가 없으면 오류 */
export function characterPath(dir: string, id: unknown): string {
  const s = String(id ?? '');
  if (!s || s !== path.basename(s) || /^[._]/.test(s) || /[\\/]/.test(s)) throw new Error('캐릭터 이름이 잘못되었습니다.');
  const base = path.resolve(dir);
  const p = path.resolve(base, s);
  if (path.dirname(p) !== base) throw new Error('캐릭터 이름이 잘못되었습니다.');
  if (!fs.existsSync(path.join(p, 'config.json'))) throw new Error('캐릭터를 찾지 못했습니다. 목록을 새로고침하세요.');
  return p;
}

function readConfig(p: string): CharacterConfig {
  const c = JSON.parse(fs.readFileSync(path.join(p, 'config.json'), 'utf8'));
  return c && typeof c === 'object' ? c : {};
}

/** 기본 원본은 건드리지 않고 사용자 편집 사본을 만든다. 이전 수정본도 보관한다. */
function editableDir(dir: string, id: unknown, builtinDir: string | undefined, what: string): string {
  if (!isBuiltinCharacter(String(id ?? ''))) return dir;
  if (!builtinDir) assertNotBuiltin(id, what);
  const original = characterPath(builtinDir!, id);
  const root = builtinOverridesDir(dir), target = path.join(root, String(id));
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(target)) {
    const keep = path.join(root, '_to_delete', `${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.cpSync(target, keep, { recursive: true });
  } else {
    fs.mkdirSync(target);
    fs.copyFileSync(path.join(original, 'config.json'), path.join(target, 'config.json'));
  }
  return root;
}

/** 기본 비서의 편집 사본을 보관함으로 옮겨 최초 원본으로 되돌린다. */
export function resetBuiltinCharacter(builtinDir: string, userDir: string, id: unknown): void {
  if (!isBuiltinCharacter(String(id ?? ''))) throw new Error('기본 비서만 초기화할 수 있습니다.');
  characterPath(builtinDir, id);
  const root = builtinOverridesDir(userDir), target = path.join(root, String(id));
  if (fs.existsSync(target)) {
    const keep = path.join(root, '_to_delete', `${id}-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.renameSync(target, keep);
  }
}

/** 이름·성격 바꾸기 (config.json의 다른 항목은 그대로) */
export function updateCharacter(dir: string, id: unknown, input: AddInput, builtinDir?: string): Character {
  dir = editableDir(dir, id, builtinDir, '이름·성격을 바꿀');
  const p = characterPath(dir, id);
  const config = { ...readConfig(p), name: cleanName(input.name), persona: cleanPersona(input.persona) };
  fs.writeFileSync(path.join(p, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return { id: path.basename(p), config };
}

/** 그림 캐릭터의 그림 바꾸기: 새 그림을 복사하고 이전 그림(image·icon)은 지운다. 새 이름을 써서 화면이 예전 그림을 다시 쓰지 않게 한다 */
export function replaceCharacterImage(dir: string, id: unknown, src: string, builtinDir?: string): Character {
  dir = editableDir(dir, id, builtinDir, '그림을 바꿀');
  const p = characterPath(dir, id);
  const config = readConfig(p);
  if (config.type === 'live2d') throw new Error('Live2D 캐릭터는 그림을 바꿀 수 없습니다. 모델은 캐릭터 폴더에서 바꾸세요.');
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) throw new Error(`그림 파일만 쓸 수 있습니다 (${IMAGE_EXTS.join(', ')}).`);
  const st = fs.statSync(src);
  if (!st.isFile()) throw new Error('파일을 고르세요.');
  if (st.size > IMAGE_MAX_BYTES) throw new Error('20MB보다 작은 그림을 고르세요.');
  const file = `character-${Date.now()}${ext}`;
  fs.copyFileSync(src, path.join(p, file));
  const old = [config.image, config.icon].filter((f): f is string => !!f && f !== file);
  const next = { ...config, image: file, icon: file };
  fs.writeFileSync(path.join(p, 'config.json'), JSON.stringify(next, null, 2) + '\n');
  for (const f of isBuiltinCharacter(String(id)) ? [] : new Set(old)) {
    const fp = path.resolve(p, f);
    // 캐릭터 폴더 바로 안의 그림 파일만 지운다 (config에 이상한 경로가 있어도 밖은 건드리지 않음)
    if (path.dirname(fp) === p && IMAGE_EXTS.includes(path.extname(fp).toLowerCase()) && fs.existsSync(fp)) fs.rmSync(fp);
  }
  return { id: path.basename(p), config: next };
}

/** 캐릭터 삭제 (폴더째 지움). 기본 캐릭터는 안 됨 */
export function deleteCharacter(dir: string, id: unknown): void {
  assertNotBuiltin(id, '삭제할');
  const p = characterPath(dir, id);
  if (isBuiltinCharacter(path.basename(p))) throw new Error('기본 캐릭터는 삭제할 수 없습니다.');
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 삭제 뒤 쓸 캐릭터: 지운 것이 지금 캐릭터면 직전 캐릭터(있으면), 아니면 기본 캐릭터.
 * 지운 것이 직전 캐릭터였으면 직전 기억을 비운다.
 */
export function afterDelete(current: string, prev: string, deleted: string, exists: (id: string) => boolean): { character: string; prevCharacter: string } {
  const prevOk = !!prev && prev !== deleted && exists(prev);
  if (current !== deleted) return { character: current, prevCharacter: prevOk ? prev : '' };
  return { character: prevOk ? prev : DEFAULT_CHARACTER, prevCharacter: '' };
}
