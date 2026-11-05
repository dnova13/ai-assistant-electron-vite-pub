// 복사·이동의 출발 위치/대상/도착 위치를 실제 항목으로 나눈다. 실행은 기존 확인 단계 뒤에 한다.
import path from 'node:path';
import type { ActionArgs, PrepareResult } from '@shared/types';
import type { FileNameMatcher } from '@shared/file-names';
import type { Root, Platform } from './policy';
import * as policy from './policy';
import { ToolError } from './executor';
import { directories, prepareOpenArgs } from './open-command';

type Choice = Extract<PrepareResult, { status: 'choice' }>;
type Transfer = { target: string; dest: string; name?: string };
export async function prepareTransferArgs(action: 'file.copy' | 'file.move', args: ActionArgs, roots: Root[], matcher: FileNameMatcher | null, platform: Platform): Promise<{ args: ActionArgs } | Choice> {
  // 경계별로 반복하는 같은 이름 비교는 이번 요청 안에서만 재사용한다.
  const memo = new Map<string, Promise<string[]>>();
  const compare: FileNameMatcher | null = matcher ? (query, candidates) => {
    const key = JSON.stringify([query, candidates]);
    if (!memo.has(key)) memo.set(key, matcher(query, candidates));
    return memo.get(key)!;
  } : null;
  const sourceMemo = new Map<string, Promise<string[]>>();
  const sources = async (input: ActionArgs, depth = 0): Promise<string[]> => {
    if (depth > 3) throw new ToolError('대상 선택이 많습니다. 위치와 이름을 따옴표로 지정해 주세요.', 'too_many_candidates');
    const out = await prepareOpenArgs(input, roots, compare, platform);
    if ('args' in out) return [out.args.target!];
    if (out.field === 'target') return out.options.map((o) => o.path);
    const all: string[] = [];
    for (const option of out.options) {
      try { all.push(...await sources({ ...input, [out.field]: option.path }, depth + 1)); }
      catch (e) { if (!(e instanceof ToolError) || e.code !== 'not_found') throw e; }
      if (all.length > 128) throw new ToolError('대상이 많습니다. 출발 위치를 더 좁혀 주세요.', 'too_many_candidates');
    }
    return [...new Set(all)];
  };
  const findSource = (input: ActionArgs): Promise<string[]> => {
    const key = JSON.stringify(input);
    if (!sourceMemo.has(key)) sourceMemo.set(key, sources(input));
    return sourceMemo.get(key)!;
  };
  const candidates = new Map<string, Transfer>();
  let refused: ToolError | null = null;
  const add = (target: string, dest: string, name: string | undefined) => {
    const src = policy.checkExisting(target, roots, platform), dir = policy.checkExisting(dest, roots, platform);
    if (!src.ok || !dir.ok || !dir.isDir) return;
    if (name !== undefined) {
      const fresh = policy.checkNew(dir.real, name, roots, platform);
      if (!fresh.ok) { refused = new ToolError(fresh.reason, 'bad_args'); return; }
      if (fresh.exists) { refused = new ToolError(`같은 이름(${name})이 이미 있습니다. 덮어쓰지 않습니다.`, 'conflict'); return; }
    }
    if (src.isDir && policy.isInside(src.real, dir.real, platform)) return;
    const value = { target: src.real, dest: dir.real, ...(name !== undefined ? { name } : {}) };
    candidates.set(JSON.stringify([value.target, value.dest, value.name ?? null]), value);
    if (candidates.size > 128) throw new ToolError('가능한 복사·이동 조합이 많습니다. 위치와 이름을 따옴표로 지정해 주세요.', 'too_many_candidates');
  };
  const parts = args.transferParts;
  if (parts) {
    if (!Array.isArray(parts) || !parts.length || parts.length > 32 || parts.some((p) => !p || typeof p.text !== 'string' || !p.text || typeof p.quoted !== 'boolean' || /[\x00-\x1f\x7f]/.test(p.text)) || parts.reduce((n, p) => n + p.text.length, 0) > 4096) throw new ToolError('복사·이동의 위치와 이름을 확인해 주세요.', 'bad_args');
    const inputFor = (count: number): ActionArgs => {
      const tokens = parts.slice(0, count);
      return { target: tokens.map((p) => p.text).join(' '), ...(tokens.length > 1 ? { openParts: tokens } : {}) };
    };
    for (let cut = 1; cut <= parts.length; cut++) {
      let files: string[];
      try { files = await findSource(inputFor(cut)); }
      catch (e) { if (e instanceof ToolError && e.code === 'not_found') continue; throw e; }
      const rest = parts.slice(cut).map((p) => p.text).join(' ');
      if (rest) {
        let dests: { path: string }[] = [];
        try { dests = await directories(rest, roots, compare, platform); }
        catch (e) { if (!(e instanceof ToolError) || e.code !== 'not_found') throw e; }
        for (const file of files) {
          for (const dest of dests) add(file, dest.path, undefined);
          if (action === 'file.copy') add(file, path.dirname(file), rest);
        }
      } else if (action === 'file.copy') for (const file of files) add(file, path.dirname(file), undefined);
    }
  } else {
    const files = await findSource({ target: args.target, root: args.root });
    if (args.sameFolder && args.dest) throw new ToolError('같은 폴더 복사와 다른 도착 위치 중 하나를 지정해 주세요.', 'bad_args');
    if (action === 'file.move' && (!args.dest || args.sameFolder)) throw new ToolError('이동할 도착 폴더를 알려 주세요.', 'bad_args');
    const dests = args.dest ? await directories(args.dest, roots, compare, platform) : [];
    for (const file of files) {
      if (action === 'file.copy' && !args.dest) add(file, path.dirname(file), args.name);
      else for (const dest of dests) add(file, dest.path, action === 'file.copy' ? args.name : undefined);
    }
  }
  if (!candidates.size && refused) throw refused;
  if (!candidates.size) throw new ToolError(action === 'file.move' ? '출발 대상과 이동할 도착 폴더를 확인해 주세요.' : '복사할 대상과 위치 또는 새 이름을 확인해 주세요.', 'not_found');
  const picked = args.transferChoice ? candidates.get(args.transferChoice) : candidates.size === 1 ? [...candidates.values()][0] : null;
  if (args.transferChoice && !picked) throw new ToolError('선택한 복사·이동 조합이 바뀌었습니다. 다시 요청해 주세요.', 'changed');
  if (!picked) return { status: 'choice', field: 'transferChoice', message: '출발 대상과 도착 위치 또는 새 이름을 선택해 주세요.', options: [...candidates].map(([key, v]) => {
    const src = policy.checkExisting(v.target, roots, platform), dst = policy.checkExisting(v.dest, roots, platform);
    const display = `대상: ${src.ok ? src.display : v.target} → 위치: ${dst.ok ? dst.display : v.dest}${v.name !== undefined ? ` / 새 이름: ${v.name}` : ''}`;
    return { path: key, display, title: display };
  }) };
  return { args: { target: picked.target, dest: picked.dest, ...(picked.name !== undefined ? { name: picked.name } : {}) } };
}
