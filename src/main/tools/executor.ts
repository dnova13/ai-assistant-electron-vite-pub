// 파일 작업: 이름으로 찾기, 계획 세우기(prepare), 실행하기(execute).
// 실행 직전에 경로를 다시 검사한다 (확인 창을 띄운 사이에 파일이 바뀌는 경우 대비).
import fs from 'node:fs';
import path from 'node:path';
import * as policy from './policy';
import type { Checked, FileStat, Platform, Root } from './policy';
import type { ActionArgs, ActionName, ChoiceOption } from '@shared/types';
import { BACKUP_DIR, CONFIRM_QUESTIONS, DELETED_TEXT, TRASH_DIR, dateStr, timeStr, uniqueName } from '@shared/local-files';

// 찾기에서 건너뛰는 폴더. _to_delete(삭제한 파일)는 찾기 결과에 나오지 않게 한다
export const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.venv', 'venv', '$recycle.bin', 'system volume information', TRASH_DIR]);

// 빈 파일로 만들 수 있는 확장자, 목록에 보여 줄 수
const CREATE_EXT = new Set(['', '.txt']);
const LIST_LIMIT = 50;

// 허용 폴더를 가리키는 말 (서버가 보내는 영어 id, 사람이 하는 한국어)
export const ROOT_ALIASES: Record<string, string[]> = {
  documents: ['documents', 'document', 'docs', '문서', '내 문서', '도큐먼트'],
  downloads: ['downloads', 'download', '다운로드', '다운'],
  desktop: ['desktop', '바탕화면', '바탕 화면', '데스크톱', '데스크탑']
};

export class ToolError extends Error {
  code: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code || 'tool_error';
  }
}

/** 작업 이름과 확인 질문 (앱과 메신저가 같은 질문을 쓴다. 삭제는 두 번). remoteOnly = 메신저 요청에서만 */
export const ACTIONS: Record<ActionName, { confirm: boolean; questions: string[]; remoteOnly?: boolean }> = Object.fromEntries(
  (Object.keys(CONFIRM_QUESTIONS) as ActionName[]).map((a) => [a, { confirm: CONFIRM_QUESTIONS[a].length > 0, questions: CONFIRM_QUESTIONS[a], remoteOnly: a === 'file.send' }])
) as Record<ActionName, { confirm: boolean; questions: string[]; remoteOnly?: boolean }>;

export const isAction = (a: unknown): a is ActionName => typeof a === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, a);

const norm = (s: string) => policy.nfc(s).trim().toLowerCase();
// "문서 폴더로", "다운로드에서" → "문서", "다운로드"
export const stripKo = (s: string) =>
  String(s).trim().replace(/\s*폴더$/, '').replace(/(으로|로|에서|에|의)$/, '').replace(/\s*폴더$/, '').trim();

export function matchRoot(word: string | undefined, roots: Root[]): Root | null {
  if (!word) return null;
  const cands = [norm(word), norm(stripKo(word))];
  for (const r of roots) {
    const names = new Set([norm(r.id), norm(r.label), ...(ROOT_ALIASES[r.id] || []).map(norm)]);
    if (cands.some((c) => names.has(c))) return r;
  }
  return null;
}

interface Found {
  real: string;
  isDir: boolean;
  display: string;
}

type Kind = 'any' | 'file' | 'dir';

// 허용 폴더 안에서 이름으로 찾기. 숨김 폴더·심볼릭 링크는 따라가지 않는다.
export function search(
  query: string,
  roots: Root[],
  { kind = 'any', maxDepth = 5, limit = 30, maxVisit = 20000, platform = process.platform }: { kind?: Kind; maxDepth?: number; limit?: number; maxVisit?: number; platform?: Platform } = {}
): Found[] {
  const q = norm(query);
  if (!q) return [];
  const exact: Found[] = [];
  const stem: Found[] = [];
  const partial: Found[] = [];
  let visited = 0;
  for (const root of roots) {
    const queue: [string, number][] = [[root.real, 0]];
    while (queue.length && visited < maxVisit) {
      const [dir, depth] = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++visited > maxVisit) break;
        if (e.isSymbolicLink()) continue;
        const name = e.name;
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const isDir = e.isDirectory();
        if (isDir && depth < maxDepth && !SKIP_DIRS.has(name.toLowerCase())) {
          const rel = path.relative(root.real, full);
          if (!policy.hasSensitiveSegment(rel, platform)) queue.push([full, depth + 1]);
        }
        if (kind === 'file' && isDir) continue;
        if (kind === 'dir' && !isDir) continue;
        const n = norm(name);
        const item = { real: full, isDir, display: policy.displayOf(root, full) };
        if (n === q) exact.push(item);
        else if (!isDir && n.slice(0, n.length - path.extname(n).length) === q) stem.push(item);
        else if (n.includes(q)) partial.push(item);
      }
    }
  }
  return [...exact, ...stem, ...partial].slice(0, limit);
}

const isAbsoluteAny = (s: string) => path.isAbsolute(s) || path.win32.isAbsolute(s);

type Ok = Extract<Checked, { ok: true }>;
type Resolved = { error: string } | { match: Ok } | { choices: ChoiceOption[] };

/** "바탕화면 test", "바탕화면/test": 맨 앞 말이 허용 폴더 이름이면 그 폴더와 나머지. 아니면 null */
function splitScope(s: string, roots: Root[]): { root: Root; rest: string; slash: boolean } | null {
  const m = /^([^\s\\/]+)([\s\\/]+)(.+)$/.exec(s);
  const root = m && matchRoot(m[1], roots);
  return m && root ? { root, rest: m[3], slash: /[\\/]/.test(m[2]) } : null;
}

/**
 * target / dest 문자열을 실제 경로 하나로 바꾼다. 여러 개면 고르게 한다.
 * 경로: "바탕화면/test"는 정확한 하위 경로다. 없으면 다른 하위 이름으로 대신 찾지 않는다.
 * "바탕화면 test"는 전체 이름을 먼저 찾고, 없으면 그 폴더에서만 찾는다.
 */
export function resolve(spec: string | undefined, roots: Root[], opts: { kind?: Kind; rootHint?: string; platform?: Platform; scoped?: boolean; maxDepth?: number } = {}): Resolved {
  const s = String(spec || '').trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '');
  const scope = !opts.rootHint && !isAbsoluteAny(s) ? splitScope(s, roots) : null;
  const inScope = (sc: { root: Root; rest: string }) => resolve(sc.rest, roots, { ...opts, rootHint: sc.root.id, scoped: true });
  if (scope && scope.slash) {
    return resolveWhole(path.join(scope.root.real, ...scope.rest.split(/[\\/]+/)), [scope.root], opts);
  }
  const whole = resolveWhole(s, roots, opts);
  return 'error' in whole && scope && !scope.slash ? inScope(scope) : whole;
}

function resolveWhole(spec: string | undefined, roots: Root[], { kind = 'any', rootHint, platform = process.platform, scoped = false, maxDepth }: { kind?: Kind; rootHint?: string; platform?: Platform; scoped?: boolean; maxDepth?: number } = {}): Resolved {
  const s = String(spec || '').trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '');
  if (!s) return { error: kind === 'dir' ? '어느 폴더인지 알려 주세요.' : '어떤 파일인지 알려 주세요.' };
  const toResolved = (c: Checked): Resolved => (c.ok ? { match: c } : { error: c.reason });

  if (isAbsoluteAny(s)) {
    const c = policy.checkExisting(s, roots, platform);
    if (!c.ok) return { error: c.reason };
    if (kind === 'dir' && !c.isDir) return { error: '폴더가 아닙니다.' };
    return { match: c };
  }

  if (kind !== 'file' && !scoped) {
    const r = matchRoot(s, roots);
    if (r) return toResolved(policy.checkExisting(r.real, roots, platform));
  }

  const hinted = rootHint ? matchRoot(rootHint, roots) : null;
  const searchRoots = hinted ? [hinted] : roots;

  // 상대 경로 (2026/보고서.pdf)
  if (/[\\/]/.test(s)) {
    const found: Ok[] = [];
    for (const r of searchRoots) {
      const c = policy.checkExisting(path.join(r.real, ...s.split(/[\\/]+/)), roots, platform);
      if (c.ok && (kind !== 'dir' || c.isDir)) found.push(c);
    }
    if (found.length === 1) return { match: found[0] };
    if (found.length > 1) return { choices: found.map((c) => ({ path: c.real, display: c.display })) };
    return { error: `'${s}'을(를) 허용 폴더에서 찾지 못했습니다.` };
  }

  const name = kind === 'dir' ? stripKo(s) : s;
  const results = search(name, searchRoots, { kind, platform, limit: 10, maxDepth });
  const strong = results.filter((x) => norm(path.basename(x.real)) === norm(name) || (!x.isDir && norm(path.parse(x.real).name) === norm(name)));
  const list = strong.length ? strong : results;
  if (!list.length) return { error: `'${name}'을(를) 허용 폴더에서 찾지 못했습니다.` };
  if (list.length === 1) return toResolved(policy.checkExisting(list[0].real, roots, platform));
  return { choices: list.map((x) => ({ path: x.real, display: x.display + (x.isDir ? '/' : '') })) };
}

/* ---------------- 계획과 실행 ---------------- */

export interface Plan {
  action: ActionName;
  /** 대상 (폴더 만들기는 새 폴더를 만들 위치 폴더) */
  src: string;
  srcStat: FileStat;
  srcIsDir?: boolean;
  /** 결과가 들어갈 폴더 (백업·삭제는 아직 없을 수 있다: 실행할 때 만든다) */
  destDir?: string;
  /** 결과 경로 */
  dst?: string;
  /** 같은 이름이 있어 이름을 바꿔 저장 */
  conflict?: boolean;
  display: { src: string; dst?: string };
  warnings?: string[];
}

export type Prepared =
  | { result: { query: string; items: { path: string; display: string; isDir: boolean }[]; list?: boolean; rootList?: boolean } }
  | { choice: { field: 'target' | 'dest'; options: ChoiceOption[]; message: string } }
  | { plan: Plan };

const existsIn = (dir: string) => (n: string) => {
  try {
    fs.lstatSync(path.join(dir, n));
    return true;
  } catch {
    return false;
  }
};

/** 허용 폴더의 _to_delete/<날짜>/ 안에 들어갈 경로 (같은 이름이면 시각, 그래도 겹치면 번호) */
export function trashTarget(root: Root, real: string, isDir: boolean, now = Date.now()): { dir: string; dst: string } {
  const dir = path.join(root.real, TRASH_DIR, dateStr(now));
  const name = uniqueName(path.basename(real), existsIn(dir), { isDir, stamp: timeStr(now) });
  return { dir, dst: path.join(dir, name) };
}

/** 이 경로가 허용 폴더의 _to_delete 안(또는 그 폴더 자체)인가 */
export function inTrash(real: string, root: Root, platform: Platform = process.platform): boolean {
  return policy.isInside(path.join(root.real, TRASH_DIR), real, platform);
}

export function prepare(action: string, args: ActionArgs | undefined, roots: Root[], { platform = process.platform }: { platform?: Platform } = {}): Prepared {
  if (!isAction(action)) throw new ToolError(`지원하지 않는 작업입니다: ${action}`, 'unsupported');
  if (action === 'file.list' && !args?.dest && !args?.target && !args?.root) {
    return { result: { query: '허용 폴더', list: true, rootList: true, items: roots.map((root) => ({ path: root.real, display: `${root.label} — ${root.real}`, isDir: true })) } };
  }
  if (!roots.length) throw new ToolError('허용 폴더가 없습니다. 설정 > 파일 제어 > 허용 경로에서 폴더를 추가하세요.', 'no_roots');
  args = args || {};

  if (action === 'file.search') {
    const q = String(args.query || args.target || '').trim();
    if (!q) throw new ToolError('찾을 이름을 알려 주세요.', 'bad_args');
    const hint = args.root ? matchRoot(args.root, roots) : null;
    let items = search(q, hint ? [hint] : roots, { platform, limit: 20 });
    const scope = !items.length && !hint ? splitScope(q, roots) : null;
    if (scope) items = search(scope.rest, [scope.root], { platform, limit: 20 });
    return { result: { query: q, items: items.map((x) => ({ path: x.real, display: x.display + (x.isDir ? '/' : ''), isDir: x.isDir })) } };
  }

  // 폴더 안의 내용: 숨김·링크·찾기에서 건너뛰는 폴더는 보여 주지 않는다
  if (action === 'file.list') {
    const d = resolve(args.dest || args.target, roots, { kind: 'dir', rootHint: args.root, platform });
    if ('error' in d) throw new ToolError(d.error, 'not_found');
    if ('choices' in d) return { choice: { field: 'dest', options: d.choices, message: `'${args.dest}' 폴더가 여러 개 있습니다. 어느 것인가요?` } };
    const items = fs
      .readdirSync(d.match.real, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name.toLowerCase()))
      .filter((e) => !policy.hasSensitiveSegment(path.relative(d.match.root.real, path.join(d.match.real, e.name)), platform))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, LIST_LIMIT)
      .map((e) => {
        const full = path.join(d.match.real, e.name);
        return { path: full, display: policy.displayOf(d.match.root, full) + (e.isDirectory() ? '/' : ''), isDir: e.isDirectory() };
      });
    return { result: { query: d.match.display, items, list: true } };
  }

  // 폴더·빈 파일 만들기: dest = 만들 위치, name = 새 이름
  if (action === 'file.mkdir' || action === 'file.create') {
    const d = resolve(args.dest, roots, { kind: 'dir', rootHint: args.root, platform });
    if ('error' in d) throw new ToolError(d.error, 'not_found');
    if ('choices' in d) return { choice: { field: 'dest', options: d.choices, message: `'${args.dest}' 폴더가 여러 개 있습니다. 어느 것인가요?` } };
    const name = String(args.name || '').trim();
    if (!name) throw new ToolError(action === 'file.create' ? '새 파일 이름을 알려 주세요.' : '새 폴더 이름을 알려 주세요.', 'bad_args');
    if (action === 'file.create' && !CREATE_EXT.has(path.extname(name).toLowerCase())) throw new ToolError('지금은 확장자가 없거나 .txt인 파일만 만들 수 있습니다.', 'bad_args');
    const n = policy.checkNew(d.match.real, name, roots, platform);
    if (!n.ok) throw new ToolError(n.reason, 'denied');
    if (n.exists) throw new ToolError(`같은 이름(${name})이 이미 있습니다.`, 'conflict');
    return { plan: { action, src: d.match.real, srcStat: d.match.stat, srcIsDir: true, destDir: d.match.real, dst: n.real, display: { src: d.match.display, dst: n.display } } };
  }

  const t = resolve(args.target, roots, { kind: 'any', rootHint: args.root, platform, maxDepth: args.root && action !== 'file.reveal' ? 0 : undefined });
  if ('error' in t) throw new ToolError(t.error, 'not_found');
  if ('choices' in t) return { choice: { field: 'target', options: t.choices, message: `'${args.target}'이(가) 여러 개 있습니다. 어느 것인가요?` } };
  const src = t.match;
  const base: Pick<Plan, 'src' | 'srcStat' | 'srcIsDir'> = { src: src.real, srcStat: src.stat, srcIsDir: src.isDir };

  if (action === 'file.open') {
    if (!src.isDir && policy.isExecutableLike(src.real, platform)) {
      throw new ToolError('실행 파일·스크립트·설치 파일은 열지 않습니다 (안전을 위해 직접 실행하세요).', 'executable');
    }
    return { plan: { action, ...base, display: { src: src.display } } };
  }
  if (action === 'file.reveal') {
    return { plan: { action, ...base, display: { src: src.display } } };
  }
  if (action === 'file.send') {
    if (src.isDir) throw new ToolError('폴더는 보낼 수 없습니다. 파일을 골라 주세요.', 'bad_args');
    return { plan: { action, ...base, display: { src: src.display } } };
  }

  const isRoot = src.rel === '';
  if (action === 'file.delete') {
    if (isRoot) throw new ToolError('허용 폴더 자체는 삭제할 수 없습니다.', 'denied');
    if (inTrash(src.real, src.root, platform)) throw new ToolError('이미 삭제한 파일(_to_delete 안)입니다. 비우기는 설정 > 파일 제어 > 관리에서 합니다.', 'denied');
    const tt = trashTarget(src.root, src.real, src.isDir);
    return { plan: { action, ...base, destDir: tt.dir, dst: tt.dst, display: { src: src.display } } };
  }

  if (action === 'file.rename') {
    if (isRoot) throw new ToolError('허용 폴더 자체의 이름은 바꿀 수 없습니다.', 'denied');
    const name = String(args.name || '').trim();
    if (!name) throw new ToolError('새 이름을 알려 주세요.', 'bad_args');
    const dir = path.dirname(src.real);
    const n = policy.checkNew(dir, name, roots, platform);
    if (!n.ok) throw new ToolError(n.reason, 'denied');
    if (n.exists) {
      // 대소문자만 바꾸는 경우(맥·윈도우)는 같은 파일이다
      if (!policy.isInside(n.real, src.real, platform)) throw new ToolError(`같은 이름(${name})이 이미 있습니다. 덮어쓰지 않습니다.`, 'conflict');
    }
    const dst = path.join(dir, name);
    return { plan: { action, ...base, destDir: dir, dst, display: { src: src.display, dst: policy.displayOf(src.root, dst) } } };
  }

  if (action === 'file.backup') {
    if (isRoot) throw new ToolError('허용 폴더 전체는 백업하지 않습니다. 파일이나 그 안의 폴더를 골라 주세요.', 'denied');
    if (inTrash(src.real, src.root, platform)) throw new ToolError('삭제한 파일(_to_delete 안)은 백업하지 않습니다.', 'denied');
    const dir = path.join(path.dirname(src.real), BACKUP_DIR);
    if (policy.isInside(src.real, dir, platform)) throw new ToolError('backup 폴더 자체는 백업하지 않습니다.', 'denied');
    const nameErr = policy.checkName(BACKUP_DIR, platform);
    if (nameErr) throw new ToolError(nameErr, 'denied');
    const name = uniqueName(path.basename(src.real), existsIn(dir), { isDir: src.isDir, always: true });
    const dst = path.join(dir, name);
    return { plan: { action, ...base, destDir: dir, dst, display: { src: src.display, dst: policy.displayOf(src.root, dst) } } };
  }

  // move / copy
  const implicitSame = action === 'file.copy' && (!args.dest || args.sameFolder === true);
  if (action === 'file.copy' && args.sameFolder && args.dest) throw new ToolError('같은 폴더와 다른 도착 위치를 함께 지정할 수 없습니다.', 'bad_args');
  const d = resolve(implicitSame ? path.dirname(src.real) : args.dest, roots, { kind: 'dir', platform });
  if ('error' in d) throw new ToolError(d.error, 'not_found');
  if ('choices' in d) return { choice: { field: 'dest', options: d.choices, message: `'${args.dest}' 폴더가 여러 개 있습니다. 어느 것인가요?` } };
  const destDir = d.match;

  if (src.isDir && policy.isInside(src.real, destDir.real, platform)) {
    throw new ToolError('폴더를 자기 자신이나 그 안으로 옮기거나 복사할 수 없습니다.', 'bad_args');
  }
  if (action === 'file.move' && isRoot) throw new ToolError('허용 폴더 자체는 옮길 수 없습니다.', 'denied');
  const customName = action === 'file.copy' && args.name !== undefined;
  const name = customName ? String(args.name).trim() : path.basename(src.real);
  const first = policy.checkNew(destDir.real, name, roots, platform);
  if (!first.ok) throw new ToolError(first.reason, 'denied');
  if (customName && first.exists) throw new ToolError(`같은 이름(${name})이 이미 있습니다. 덮어쓰지 않습니다.`, 'conflict');
  if (action === 'file.move' && first.exists && policy.isInside(first.real, src.real, platform) && policy.isInside(src.real, first.real, platform)) {
    throw new ToolError('이미 그 폴더에 있습니다.', 'same_place');
  }
  // 같은 이름이 있으면 덮어쓰지 않고 날짜(그래도 겹치면 번호)를 붙인 이름으로
  const sameParent = policy.isInside(path.dirname(src.real), destDir.real, platform) && policy.isInside(destDir.real, path.dirname(src.real), platform);
  let finalName = first.exists ? uniqueName(name, existsIn(destDir.real), { isDir: src.isDir }) : name;
  if (action === 'file.copy' && sameParent && !customName) {
    const ext = src.isDir ? '' : path.extname(name), stem = ext ? name.slice(0, -ext.length) : name;
    let n = 1;
    while (n <= 10000 && fs.existsSync(path.join(destDir.real, `${stem} (${n})${ext}`))) n++;
    if (n > 10000) throw new ToolError('같은 이름의 사본이 너무 많습니다. 새 이름을 지정해 주세요.', 'conflict');
    finalName = `${stem} (${n})${ext}`;
  }
  const dst = first.exists ? policy.checkNew(destDir.real, finalName, roots, platform) : first;
  if (!dst.ok) throw new ToolError(dst.reason, 'denied');
  const warnings = first.exists ? [`같은 이름이 있어 '${finalName}'(으)로 저장합니다. 덮어쓰지 않습니다.`] : [];
  return {
    plan: {
      action,
      ...base,
      destDir: destDir.real,
      dst: dst.real,
      conflict: first.exists,
      display: { src: src.display, dst: dst.display },
      warnings
    }
  };
}

const sameFile = (a: FileStat, b: FileStat) => !!a && !!b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1 && a.ino === b.ino;

/** Electron shell 중 여기서 쓰는 부분 (시험에서는 가짜를 넣는다). 휴지통은 쓰지 않는다 (지우는 것은 _to_delete로 옮김) */
export interface ShellLike {
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
}

/** _to_delete/<날짜>/ 로 옮기고 원래 위치를 .restore.jsonl에 적는다 (되돌릴 때 보라고) */
export function moveToTrash(real: string, isDir: boolean, roots: Root[], platform: Platform = process.platform, now = Date.now()): string {
  const root = policy.findRoot(real, roots, platform);
  if (!root) throw new ToolError('허용 폴더 밖이라 다룰 수 없습니다.', 'denied');
  const tt = trashTarget(root, real, isDir, now);
  fs.mkdirSync(tt.dir, { recursive: true });
  // _to_delete가 링크로 밖을 가리키면 옮기지 않는다
  if (!policy.isInside(root.real, fs.realpathSync.native(tt.dir), platform)) throw new ToolError('_to_delete 폴더가 허용 폴더 밖을 가리켜 삭제하지 않았습니다.', 'denied');
  fs.renameSync(real, tt.dst);
  try {
    fs.appendFileSync(path.join(tt.dir, '.restore.jsonl'), JSON.stringify({ time: new Date(now).toISOString(), from: real, to: tt.dst }) + '\n', 'utf8');
  } catch {
    /* 기록 실패는 삭제를 막지 않는다 */
  }
  return tt.dst;
}

export async function execute(plan: Plan, _opts: { overwrite?: boolean } | undefined, roots: Root[], shell: ShellLike, { platform = process.platform }: { platform?: Platform } = {}): Promise<{ message: string; path?: string }> {
  // 1) 원본을 다시 검사: 아직 허용 폴더 안인지, 확인 창 이후 바뀌지 않았는지
  const src = policy.checkExisting(plan.src, roots, platform);
  if (!src.ok) throw new ToolError(src.reason, 'denied');
  if (plan.action !== 'file.mkdir' && plan.action !== 'file.create' && !sameFile(src.stat, plan.srcStat)) throw new ToolError('확인하는 사이에 파일이 바뀌었습니다. 다시 요청해 주세요.', 'changed');

  if (plan.action === 'file.open') {
    if (!src.isDir && policy.isExecutableLike(src.real, platform)) throw new ToolError('실행 파일은 열지 않습니다.', 'executable');
    const err = await shell.openPath(src.real);
    if (err) throw new ToolError(`열지 못했습니다: ${err}`, 'open_failed');
    return { message: `${plan.display.src}을(를) 열었습니다.` };
  }
  if (plan.action === 'file.reveal') {
    shell.showItemInFolder(src.real);
    return { message: `${plan.display.src} 위치를 열었습니다.` };
  }
  if (plan.action === 'file.send') throw new ToolError('파일 보내기는 메신저에서만 됩니다.', 'remote_only');
  if (!plan.destDir || !plan.dst) throw new ToolError('대상이 없습니다.', 'bad_plan');

  if (plan.action === 'file.delete') {
    if (inTrash(src.real, src.root, platform)) throw new ToolError('이미 삭제한 파일입니다.', 'denied');
    const to = moveToTrash(src.real, src.isDir, roots, platform);
    return { message: DELETED_TEXT, path: to };
  }

  // 2) 결과 경로 다시 검사 (만들 폴더의 부모는 허용 폴더 안이어야 한다)
  const parent = path.dirname(plan.dst);
  if (plan.action === 'file.backup') {
    const p = policy.checkExisting(path.dirname(parent), roots, platform);
    if (!p.ok) throw new ToolError(p.reason, 'denied');
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
  }
  const dst = policy.checkNew(parent, path.basename(plan.dst), roots, platform);
  if (!dst.ok) throw new ToolError(dst.reason, 'denied');
  if (dst.exists) {
    const caseOnly = plan.action === 'file.rename' && policy.isInside(dst.real, src.real, platform);
    if (!caseOnly) throw new ToolError('그 사이에 같은 이름이 생겼습니다. 덮어쓰지 않습니다. 다시 요청해 주세요.', 'conflict');
  }

  if (plan.action === 'file.create') {
    fs.writeFileSync(dst.real, '', { flag: 'wx' }); // 있으면 실패 (덮어쓰지 않는다)
    return { message: `‘${plan.display.src}’ 폴더에 ‘${policy.nfc(path.basename(dst.real))}’ 파일을 만들었습니다.`, path: dst.real };
  }
  if (plan.action === 'file.mkdir') {
    fs.mkdirSync(dst.real);
    return { message: `‘${plan.display.src}’ 폴더에 ‘${policy.nfc(path.basename(dst.real))}’ 폴더를 만들었습니다.`, path: dst.real };
  }
  if (plan.action === 'file.rename') {
    fs.renameSync(src.real, plan.dst);
    return { message: `${plan.display.src} → ${path.basename(plan.dst)} 이름을 바꿨습니다.`, path: plan.dst };
  }

  const cpOpts = { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true };
  if (plan.action === 'file.copy' || plan.action === 'file.backup') {
    fs.cpSync(src.real, dst.real, cpOpts);
    return { message: `${plan.display.src} → ${plan.display.dst} ${plan.action === 'file.backup' ? '백업' : '복사'}했습니다.`, path: dst.real };
  }
  // move
  try {
    fs.renameSync(src.real, dst.real);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw new ToolError(`옮기지 못했습니다: ${(e as Error).message}`, 'move_failed');
    // 다른 디스크로 옮길 때: 복사한 뒤 원본은 _to_delete로 (지우지 않는다)
    fs.cpSync(src.real, dst.real, cpOpts);
    moveToTrash(src.real, src.isDir, roots, platform);
  }
  return { message: `${plan.display.src} → ${plan.display.dst} 옮겼습니다.`, path: dst.real };
}
