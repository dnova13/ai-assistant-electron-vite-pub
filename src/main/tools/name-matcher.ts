// 기존 대상·위치의 한글/영문 발음 비교. 새로 만드는 name은 절대로 바꾸지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import type { ActionArgs, ChoiceOption, PrepareResult, SearchItem } from '@shared/types';
import { FILE_NAME_CHARS, FILE_NAME_LIMIT } from '@shared/file-names';
import type { FileNameCandidate, FileNameMatcher } from '@shared/file-names';
import { matchRoot, resolve, ROOT_ALIASES, search, SKIP_DIRS, stripKo, ToolError } from './executor';
import * as policy from './policy';
import type { Platform, Root } from './policy';

type Kind = 'any' | 'dir';
type Entry = SearchItem & { names: string[] };
type NameStep = { args: ActionArgs } | Extract<PrepareResult, { status: 'choice' | 'result' }>;
const norm = (s: string) => policy.nfc(s).trim().toLowerCase();
const absolute = (s: string) => path.isAbsolute(s) || path.win32.isAbsolute(s);
const stem = (s: string) => s.replace(/\.[a-z0-9]{1,8}$/i, '');
const han = (s: string) => /[가-힣]/.test(norm(stem(s)));
const latin = (s: string) => /[a-z]/i.test(stem(s));
const cross = (q: string, n: string) => (han(q) && latin(n)) || (latin(q) && han(n));
const tooMany = () => new ToolError('비교할 이름이 많습니다. 허용 폴더나 검색 위치를 더 좁혀 주세요.', 'too_many_candidates');

/** 숨김·보호 폴더·링크·삭제 보관함은 후보로도 보내지 않는다. */
function collect(roots: Root[], query: string, kind: Kind, rootsOnly: boolean, platform: Platform, maxDepth = 5): Entry[] {
  const out: Entry[] = [];
  let visited = 0;
  const add = (real: string, names: string[]) => {
    const checked = policy.checkExisting(real, roots, platform);
    if (!checked.ok || (kind === 'dir' && !checked.isDir)) return;
    const ext = kind === 'any' && /\.[a-z][a-z0-9]{1,7}$/i.test(query) ? path.extname(query).toLowerCase() : '';
    if (ext && (checked.isDir || path.extname(checked.real).toLowerCase() !== ext)) return;
    const clean = [...new Set(names.map(policy.nfc).filter((n) => n && n.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(n)))];
    if (clean.some((n) => cross(query, n))) {
      out.push({ path: checked.real, display: checked.display + (checked.isDir ? '/' : ''), isDir: checked.isDir, names: clean });
      if (out.reduce((n, e) => n + e.names.length, 0) > FILE_NAME_LIMIT) throw tooMany();
    }
  };
  for (const root of roots) {
    if (maxDepth !== 0) add(root.real, [root.label, path.basename(root.real)]);
    if (rootsOnly) continue;
    const queue: [string, number][] = [[root.real, 0]];
    while (queue.length) {
      const [dir, depth] = queue.shift()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++visited > 20000) throw tooMany();
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        const full = path.join(dir, entry.name);
        if (policy.hasSensitiveSegment(path.relative(root.real, full), platform)) continue;
        if (entry.isDirectory() && depth < maxDepth) queue.push([full, depth + 1]);
        if (kind !== 'dir' || entry.isDirectory()) add(full, [entry.name]);
      }
    }
  }
  return out;
}

function checkedItem(real: string, roots: Root[], platform: Platform): SearchItem | null {
  const checked = policy.checkExisting(real, roots, platform);
  return checked.ok ? { path: checked.real, display: checked.display + (checked.isDir ? '/' : ''), isDir: checked.isDir } : null;
}

/** 원래 글자로 찾은 후보는 남긴다. AI가 정확히 일치한 후보를 지우지 못한다. */
async function matched(query: string, roots: Root[], kind: Kind, literal: SearchItem[], matcher: FileNameMatcher, platform: Platform, rootsOnly = false, maxDepth = 5): Promise<SearchItem[]> {
  if (!/[가-힣a-z]/i.test(query) || query.length > 120) return literal;
  const entries = collect(roots, query, kind, rootsOnly, platform, maxDepth);
  if (!entries.length) return literal;
  const candidates: FileNameCandidate[] = [];
  const paths = new Map<string, string>();
  for (const entry of entries) {
    for (const name of entry.names) {
      const id = `c${candidates.length + 1}`;
      candidates.push({ id, name });
      paths.set(id, entry.path);
    }
  }
  // 실제 한글 이름도 AI가 함께 볼 수 있게 한다. 선택 결과와 상관없이 앱에서는 그대로 보존한다.
  for (const entry of literal) {
    if (entries.some((e) => e.path === entry.path)) continue;
    const id = `c${candidates.length + 1}`;
    candidates.push({ id, name: path.basename(entry.path) });
    paths.set(id, entry.path);
  }
  if (candidates.length > FILE_NAME_LIMIT || query.length + candidates.reduce((n, c) => n + c.id.length + c.name.length, 0) > FILE_NAME_CHARS) throw tooMany();
  const ids = await matcher(query, candidates);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !paths.has(id)) || new Set(ids).size !== ids.length) {
    throw new ToolError('AI 서버의 파일 이름 비교 결과가 올바르지 않습니다. 실행하지 않았습니다.', 'bad_name_match');
  }
  const merged = new Map(literal.map((e) => [e.path, e]));
  for (const id of ids) {
    const entry = checkedItem(paths.get(id)!, roots, platform);
    if (entry && (kind !== 'dir' || entry.isDir)) merged.set(entry.path, entry);
  }
  return [...merged.values()];
}

function scoped(spec: string, roots: Root[], hint?: string): { query: string; roots: Root[] } {
  const root = hint ? matchRoot(hint, roots) : null;
  if (hint && !root) throw new ToolError('지정한 검색 범위를 찾지 못했습니다.', 'not_found');
  const m = !hint && /^([^\s\\/]+)[\s\\/]+(.+)$/.exec(spec);
  const first = m ? matchRoot(m[1], roots) : null;
  return { query: first && m ? m[2] : spec, roots: root ? [root] : first ? [first] : roots };
}

function choice(field: 'target' | 'dest' | 'root', options: SearchItem[]): Extract<PrepareResult, { status: 'choice' }> {
  return { status: 'choice', field, options: options.map(({ path: p, display }) => ({ path: p, display })), message: '이름이나 발음이 맞는 대상이 여러 개입니다. 경로를 보고 골라 주세요.' };
}

export async function prepareNameArgs(action: string, args: ActionArgs, roots: Root[], matcher: FileNameMatcher, platform: Platform, maxDepth = 5): Promise<NameStep> {
  const next = { ...args };
  if (next.root) {
    const alias = Object.values(ROOT_ALIASES).some((names) => names.some((name) => norm(name) === norm(stripKo(next.root!))));
    const exact = roots.find((r) => r.id === next.root || r.real === next.root) || (alias ? matchRoot(next.root, roots) : null);
    if (exact) next.root = exact.id;
    else {
      const literal = roots.filter((r) => norm(r.label) === norm(stripKo(next.root!))).map((r) => checkedItem(r.real, roots, platform)).filter((r): r is SearchItem => !!r);
      const found = await matched(stripKo(next.root), roots, 'dir', literal, matcher, platform, true);
      if (!found.length) throw new ToolError('지정한 검색 범위를 찾지 못했습니다.', 'not_found');
      if (found.length > 1) return choice('root', found);
      next.root = roots.find((r) => r.real === found[0].path)!.id;
    }
  }
  if (action === 'file.search') {
    const query = String(next.query || next.target || '').trim();
    if (!query || absolute(query)) return { args: next };
    const scope = scoped(query, roots, next.root);
    if (/[\\/]/.test(scope.query)) return { args: next };
    const literal = search(scope.query, scope.roots, { platform, limit: 20 }).map((e) => checkedItem(e.real, scope.roots, platform)).filter((e): e is SearchItem => !!e);
    const items = await matched(scope.query, scope.roots, 'any', literal, matcher, platform);
    return { status: 'result', query, items: items.slice(0, 20) };
  }
  const fields: ('target' | 'dest')[] = action === 'file.create' || action === 'file.mkdir' || action === 'file.list'
    ? ['dest'] : action === 'file.move' || action === 'file.copy' ? ['target', 'dest'] : ['target'];
  for (const field of fields) {
    const spec = String(next[field] || '').trim();
    if (!spec || absolute(spec)) continue;
    const canonical = roots.find((r) => r.id === spec && ROOT_ALIASES[r.id]);
    if (canonical || Object.values(ROOT_ALIASES).some((names) => names.some((name) => norm(name) === norm(spec)) && !!matchRoot(spec, roots))) continue;
    const hint = field === 'target' || action === 'file.create' || action === 'file.mkdir' || action === 'file.list' ? next.root : undefined;
    const scope = scoped(spec, roots, hint);
    if (/[\\/]/.test(scope.query)) continue;
    const kind = field === 'dest' ? 'dir' : 'any';
    const original = resolve(spec, roots, { kind, rootHint: hint, platform, maxDepth });
    const options: ChoiceOption[] = 'match' in original ? [{ path: original.match.real, display: original.match.display }] : 'choices' in original ? original.choices : [];
    const literal = options.map((e) => checkedItem(e.path, scope.roots, platform)).filter((e): e is SearchItem => !!e);
    const found = await matched(kind === 'dir' ? stripKo(scope.query) : scope.query, scope.roots, kind, literal, matcher, platform, false, maxDepth);
    if (found.length > 1) return choice(field, found);
    if (found.length === 1) next[field] = found[0].path;
    else if ('error' in original) throw new ToolError(original.error, 'not_found');
  }
  return { args: next };
}
