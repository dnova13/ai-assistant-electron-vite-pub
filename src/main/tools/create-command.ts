// 정형 생성 명령에서 실제 기존 위치와 새 이름의 경계를 찾는다.
import type { ActionArgs, PrepareResult } from '@shared/types';
import type { FileNameMatcher } from '@shared/file-names';
import path from 'node:path';
import { matchRoot, resolve, ROOT_ALIASES, ToolError } from './executor';
import { prepareNameArgs } from './name-matcher';
import { checkExisting } from './policy';
import type { Platform, Root } from './policy';

type CreateStep = { args: ActionArgs } | Extract<PrepareResult, { status: 'choice' }>;

/** 같은 실제 폴더의 전체 이름이 맞으면 그 폴더의 부분 이름 해석은 제외한다. */
function exactLocation(spec: string, real: string, roots: Root[]): boolean {
  const norm = (s: string) => s.normalize('NFC').replace(/\\/g, '/').toLowerCase();
  const names = [real, path.basename(real)];
  for (const r of roots) {
    if (r.real === real) names.push(r.id, r.label, ...(ROOT_ALIASES[r.id] || []));
    const rel = path.relative(r.real, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    names.push(rel);
    for (const alias of [r.id, r.label, ...(ROOT_ALIASES[r.id] || [])]) names.push(`${alias}/${rel}`, `${alias} ${rel}`);
  }
  return names.some((n) => norm(n) === norm(spec));
}

export async function prepareCreateArgs(args: ActionArgs, roots: Root[], matcher: FileNameMatcher | null, platform: Platform): Promise<CreateStep> {
  const parts = args.createParts;
  if (!parts) return { args };
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > 32 || parts.some((p) => !p || typeof p.text !== 'string' || typeof p.quoted !== 'boolean' || !p.text || /[\x00-\x1f\x7f]/.test(p.text)) || parts.reduce((n, p) => n + p.text.length, 0) > 4096) {
    throw new ToolError('생성 명령의 위치와 이름을 확인해 주세요. 긴 이름은 따옴표로 묶어 주세요.', 'bad_args');
  }
  let root = args.root;
  if (root) {
    if (matcher) {
      const scoped = await prepareNameArgs('file.create', { root }, roots, matcher, platform);
      if ('status' in scoped) {
        if (scoped.status === 'choice') return scoped;
        throw new ToolError('지정한 검색 범위를 찾지 못했습니다.', 'not_found');
      }
      root = scoped.args.root;
    } else {
      const found = matchRoot(root, roots);
      if (!found) throw new ToolError('지정한 검색 범위를 찾지 못했습니다.', 'not_found');
      root = found.id;
    }
  }
  // 맨 앞 따옴표는 위치를, 그 뒤 첫 따옴표는 새 이름의 시작을 지정한다.
  const quoteAt = parts.findIndex((p) => p.quoted);
  const fixed = quoteAt === 0 ? 1 : quoteAt > 0 ? quoteAt : null;
  const splits = fixed === null ? Array.from({ length: parts.length - 1 }, (_, i) => i + 1) : [fixed];
  const candidates = new Map<string, { dest: string; name: string; display: string; exact: boolean }>();
  for (const cut of splits) {
    const dest = parts.slice(0, cut).map((p) => p.text).join(' ');
    const name = parts.slice(cut).map((p) => p.text).join(' ');
    let options: { path: string; display: string }[] = [];
    if (matcher) {
      try {
        const out = await prepareNameArgs('file.create', { dest, root }, roots, matcher, platform);
        if ('args' in out) {
          const resolved = resolve(out.args.dest, roots, { kind: 'dir', rootHint: root, platform });
          if ('match' in resolved) options = [{ path: resolved.match.real, display: resolved.match.display }];
          else if ('choices' in resolved) options = resolved.choices;
        } else if (out.status === 'choice') options = out.options;
      } catch (e) {
        if (!(e instanceof ToolError) || e.code !== 'not_found') throw e;
      }
    } else {
      const out = resolve(dest, roots, { kind: 'dir', rootHint: root, platform });
      if ('match' in out) options = [{ path: out.match.real, display: out.match.display }];
      else if ('choices' in out) options = out.choices;
    }
    for (const option of options) {
      const checked = checkExisting(option.path, roots, platform);
      if (!checked.ok || !checked.isDir) continue;
      const key = JSON.stringify([checked.real, name]);
      candidates.set(key, { dest: checked.real, name, display: `위치: ${option.display} / 새 이름: ${name}`, exact: exactLocation(dest, checked.real, roots) });
      if (candidates.size > 128) throw new ToolError('가능한 위치가 많습니다. 위치나 새 이름을 따옴표로 묶어 주세요.', 'too_many_candidates');
    }
  }
  const exactDirs = new Set([...candidates.values()].filter((c) => c.exact).map((c) => c.dest));
  for (const [key, c] of candidates) if (!c.exact && exactDirs.has(c.dest)) candidates.delete(key);
  if (!candidates.size) throw new ToolError('생성 위치를 허용 폴더에서 찾지 못했습니다. 위치와 새 이름을 확인해 주세요.', 'not_found');
  const picked = args.createChoice ? candidates.get(args.createChoice) : candidates.size === 1 ? [...candidates.values()][0] : null;
  if (args.createChoice && !picked) throw new ToolError('선택한 위치와 이름을 다시 확인해 주세요. 폴더가 바뀌었을 수 있습니다.', 'changed');
  if (!picked) return {
    status: 'choice', field: 'createChoice',
    options: [...candidates].map(([key, v]) => ({ path: key, display: v.display, title: v.display })),
    message: '위치와 새 이름을 나누는 방법이 여러 개입니다. 사용할 조합을 골라 주세요.'
  };
  const { createParts: _parts, createChoice: _choice, ...rest } = args;
  return { args: { ...rest, root, dest: picked.dest, name: picked.name } };
}
