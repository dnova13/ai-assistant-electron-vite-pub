// 열기·위치·이름 변경의 공통 대상 찾기: 명시한 위치는 검색 경계로 쓰고, 위치를 생략했을 때만 전체 허용 범위에서 찾는다.
import path from 'node:path';
import type { ActionArgs, ChoiceOption, PrepareResult } from '@shared/types';
import type { FileNameMatcher } from '@shared/file-names';
import { prepareCreateArgs } from './create-command';
import { prepareNameArgs } from './name-matcher';
import { resolve, search, ToolError } from './executor';
import * as policy from './policy';
import type { Platform, Root } from './policy';

type Choice = Extract<PrepareResult, { status: 'choice' }>;
type OpenStep = { args: ActionArgs } | Choice;
type Location = { directory: string | null; query: string; display: string };
const absolute = (s: string) => path.isAbsolute(s) || path.win32.isAbsolute(s);

/** 같은 기존 폴더 찾기를 쓴다. 새 이름 처리나 파일 생성은 수행하지 않는다. */
export async function directories(spec: string, roots: Root[], matcher: FileNameMatcher | null, platform: Platform): Promise<ChoiceOption[]> {
  const args = matcher ? await prepareNameArgs('file.list', { dest: spec }, roots, matcher, platform) : { args: { dest: spec } };
  if ('status' in args) {
    if (args.status === 'choice') return args.options;
    throw new ToolError('어느 폴더에서 찾을지 확인해 주세요.', 'not_found');
  }
  const out = resolve(args.args.dest, roots, { kind: 'dir', platform });
  if ('error' in out) throw new ToolError(out.error, 'not_found');
  return 'match' in out ? [{ path: out.match.real, display: out.match.display }] : out.choices;
}

/** 이미 검증된 하위 폴더를 임시 검색 시작점으로 쓴다. 허용 폴더 설정은 바꾸지 않는다. */
function inDirectory(dir: string | null, roots: Root[], platform: Platform): Root[] {
  if (!dir) return roots;
  const c = policy.checkExisting(dir, roots, platform);
  if (!c.ok || !c.isDir) throw new ToolError(c.ok ? '검색 위치가 폴더가 아닙니다.' : c.reason, 'denied');
  return [{ ...c.root, id: `scope:${c.real}`, label: c.display, path: c.real, real: c.real }];
}

async function targets(query: string, roots: Root[], matcher: FileNameMatcher | null, platform: Platform, maxDepth = 5): Promise<ChoiceOption[]> {
  const prepared = matcher ? await prepareNameArgs('file.open', { target: query }, roots, matcher, platform, maxDepth) : { args: { target: query } };
  if ('status' in prepared) {
    if (prepared.status === 'choice') return prepared.options;
    throw new ToolError('대상을 찾지 못했습니다.', 'not_found');
  }
  const out = resolve(prepared.args.target, roots, { kind: 'any', platform, maxDepth });
  if ('error' in out) throw new ToolError(out.error, 'not_found');
  return 'match' in out ? [{ path: out.match.real, display: out.match.display }] : out.choices;
}

async function locate(args: ActionArgs, roots: Root[], matcher: FileNameMatcher | null, platform: Platform): Promise<{ directory: string | null; query: string } | Choice> {
  let query = String(args.target || '').trim();
  let directory: string | null = null;
  if (args.root) {
    const found = await directories(args.root, roots, matcher, platform);
    if (found.length > 1) return { status: 'choice', field: 'root', options: found, message: '찾을 위치가 여러 개입니다. 전체 경로를 보고 폴더를 골라 주세요.' };
    if (!found.length) throw new ToolError('지정한 검색 위치를 찾지 못했습니다.', 'not_found');
    directory = found[0].path;
  } else if (args.openParts) {
    const parts = args.openParts;
    const locations = new Map<string, Location>();
    // 생성 명령의 기존 폴더/나머지 글자 경계 해석을 재사용한다. 나머지는 새 이름 대신 찾을 이름이다.
    try {
      const out = await prepareCreateArgs({ createParts: parts }, roots, matcher, platform);
      if ('args' in out) {
        const dir = out.args.dest!; const target = out.args.name!;
        const c = policy.checkExisting(dir, roots, platform);
        if (!c.ok) throw new ToolError(c.reason, 'denied');
        locations.set(JSON.stringify([dir, target]), { directory: dir, query: target, display: `위치: ${c.display} / 대상: ${target}` });
      } else {
        for (const o of out.options) {
          const [dir, target] = JSON.parse(o.path) as [string, string];
          locations.set(o.path, { directory: dir, query: target, display: o.display.replace(' / 새 이름:', ' / 대상:') });
        }
      }
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      if (e.code === 'not_found') {
        if (Array.isArray(parts) && parts.some((p) => p.quoted)) throw new ToolError('지정한 검색 위치를 찾지 못했습니다.', 'not_found');
      } else if (e.code === 'bad_args') throw new ToolError('명령의 위치와 대상 이름을 확인해 주세요. 긴 이름은 따옴표로 묶어 주세요.', e.code);
      else throw e;
    }
    const original = parts.map((p) => p.text).join(' ');
    const quoted = parts.some((p) => p.quoted);
    // 전체가 실제 파일 이름일 수도 있다. 폴더로 나눈 해석과 둘 다 맞으면 사용자가 고른다.
    const whole = !quoted && search(original, roots, { platform, limit: 20 }).some((p) => policy.checkExisting(p.real, roots, platform).ok);
    if (!locations.size || whole) locations.set(JSON.stringify([null, original]), { directory: null, query: original, display: `범위: 허용 폴더 전체 / 대상: ${original}` });
    const picked = args.openChoice ? locations.get(args.openChoice) : locations.size === 1 ? [...locations.values()][0] : null;
    if (args.openChoice && !picked) throw new ToolError('선택한 위치와 대상을 다시 확인해 주세요. 폴더가 바뀌었을 수 있습니다.', 'changed');
    if (!picked) return { status: 'choice', field: 'openChoice', options: [...locations].map(([key, v]) => ({ path: key, display: v.display, title: v.display })), message: '검색 위치와 파일 이름을 나누는 방법이 여러 개입니다. 사용할 조합을 골라 주세요.' };
    directory = picked.directory; query = picked.query;
  }
  return { directory, query };
}

export async function prepareOpenArgs(args: ActionArgs, roots: Root[], matcher: FileNameMatcher | null, platform: Platform, recursive = false): Promise<OpenStep> {
  const location = await locate(args, roots, matcher, platform);
  if ('status' in location) return location;
  const { directory, query } = location;
  const scope = inDirectory(directory, roots, platform);
  const options = await targets(query, scope, matcher, platform, directory && !recursive ? 0 : 5);
  if (directory && !recursive && options.some((o) => path.dirname(o.path) !== directory)) throw new ToolError('지정 폴더 바로 안의 대상만 처리할 수 있습니다.', 'denied');
  // 모든 결과를 원래 허용 범위와 지정한 검색 범위 양쪽에서 검사한다.
  for (const o of options) {
    if (!policy.checkExisting(o.path, roots, platform).ok || !policy.checkExisting(o.path, scope, platform).ok) throw new ToolError('지정한 검색 범위 밖의 대상입니다.', 'denied');
  }
  const original = args.openParts?.map((p) => p.text).join(' ');
  const selected = original && args.target !== original && args.target && absolute(args.target) ? args.target : null;
  const picked = selected ? options.find((o) => o.path === selected) : options.length === 1 ? options[0] : null;
  if (selected && !picked) throw new ToolError('선택한 파일을 다시 확인해 주세요. 대상이 바뀌었을 수 있습니다.', 'changed');
  if (!picked) return { status: 'choice', field: 'target', options, message: '같은 이름이나 발음의 대상이 여러 개입니다. 전체 경로를 보고 골라 주세요.' };
  const { openParts: _parts, openChoice: _choice, root: _root, ...rest } = args;
  return { args: { ...rest, target: picked.path } };
}

/** 찾기는 지정한 실제 폴더 아래의 결과를 모두 보여 준다. */
export async function prepareSearchArgs(args: ActionArgs, roots: Root[], matcher: FileNameMatcher | null, platform: Platform): Promise<Extract<PrepareResult, { status: 'result' }> | Choice> {
  const location = await locate({ ...args, target: args.query || args.target }, roots, matcher, platform);
  if ('status' in location) return location;
  const scope = inDirectory(location.directory, roots, platform);
  const query = location.query;
  const out = matcher ? await prepareNameArgs('file.search', { query }, scope, matcher, platform) : null;
  if (out && 'status' in out && out.status === 'result') return out;
  const items = search(query, scope, { platform, limit: 20 }).map((p) => ({ path: p.real, display: p.display + (p.isDir ? '/' : ''), isDir: p.isDir }));
  return { status: 'result', query, items };
}
