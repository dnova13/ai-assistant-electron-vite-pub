// 정형 생성 명령의 경계를 실제 폴더로 정하고 새 이름·선택·권한을 보존한다.
import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLocalCommand } from '../src/shared/commands';
import { ToolBroker } from '../src/main/tools/broker';
import { matchLocalFileNames } from '../src/main/tools/local-name-matcher';
import * as policy from '../src/main/tools/policy';
import type { ToolSource } from '../src/shared/types';
import type { FileNameMatcher } from '../src/shared/file-names';
import { tmpBase } from './tmp-base';

function setup(names = ['test'], matcher: FileNameMatcher | null = null) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'create-command-')));
  const docs = path.join(base, 'docs'); const other = path.join(base, 'other');
  fs.mkdirSync(docs); fs.mkdirSync(other);
  for (const n of names) fs.mkdirSync(path.join(docs, n), { recursive: true });
  const roots = policy.validateRoots([{ id: 'documents', label: '문서', path: docs, remote: true }, { id: 'other', label: '기타', path: other }]).roots;
  let allowed = roots;
  const broker = new ToolBroker({ getRoots: () => allowed, getRemoteRoots: () => allowed.filter((r) => r.remote), getNameMatcher: () => matcher, shell: { openPath: async () => '', showItemInFolder: () => {} } });
  const command = (text: string) => {
    const c = parseLocalCommand(text);
    if (!c || 'help' in c) throw new Error('시험 명령 오류');
    return c;
  };
  const prepare = (text: string, source: ToolSource = { kind: 'local' }) => broker.prepareAsync({ ...command(text), source });
  return { docs, other, broker, prepare, command, clearRoots: () => { allowed = []; } };
}

test.each(['파일', '!파일'])('%s 생성: 따옴표 없이 공백을 포함한 새 이름을 보존한다', async (prefix) => {
  const s = setup();
  const out = await s.prepare(`${prefix} 추가 test dkkd 9ddd`);
  expect(out.status).toBe('ready');
  if (out.status !== 'ready') return;
  expect(out.summary.toPath).toBe(path.join(s.docs, 'test', 'dkkd 9ddd'));
  const done = await s.broker.execute(out.id);
  expect(done.ok).toBe(true);
  expect(done.message).toBe('‘문서/test’ 폴더에 ‘dkkd 9ddd’ 파일을 만들었습니다.');
  expect(fs.readFileSync(out.summary.toPath!, 'utf8')).toBe('');
});

test('공백 있는 실제 위치와 폴더 생성도 같은 경계 규칙을 쓴다', async () => {
  const s = setup(['my music']);
  const out = await s.prepare('파일 폴더 추가 my music 새 자료 모음');
  expect(out.status).toBe('ready');
  if (out.status !== 'ready') return;
  expect(out.summary.toPath).toBe(path.join(s.docs, 'my music', '새 자료 모음'));
  const done = await s.broker.execute(out.id);
  expect(done.message).toBe('‘문서/my music’ 폴더에 ‘새 자료 모음’ 폴더를 만들었습니다.');
  expect(fs.statSync(out.summary.toPath!).isDirectory()).toBe(true);
});

test('경계가 여러 개면 위치·새 이름 조합을 선택하기 전에는 만들지 않는다', async () => {
  const s = setup(['test', 'test dkkd']);
  const cmd = s.command('파일 추가 test dkkd 9ddd');
  const out = await s.broker.prepareAsync(cmd);
  expect(out.status).toBe('choice');
  if (out.status !== 'choice') return;
  expect(out.field).toBe('createChoice');
  expect(out.options.map((o) => o.display)).toEqual(expect.arrayContaining([
    '위치: 문서/test / 새 이름: dkkd 9ddd', '위치: 문서/test dkkd / 새 이름: 9ddd'
  ]));
  expect(fs.readdirSync(path.join(s.docs, 'test'))).toEqual([]);
  const picked = out.options.find((o) => o.display.endsWith('새 이름: dkkd 9ddd'))!;
  const ready = await s.broker.prepareAsync({ ...cmd, args: { ...cmd.args, createChoice: picked.path } });
  expect(ready.status).toBe('ready');
  if (ready.status !== 'ready') return;
  await s.broker.execute(ready.id);
  expect(fs.existsSync(path.join(s.docs, 'test', 'dkkd 9ddd'))).toBe(true);
  expect(fs.existsSync(path.join(s.docs, 'test dkkd', '9ddd'))).toBe(false);
});

test.each([
  ['파일 추가 "test" dkkd 9ddd', 'test', 'dkkd 9ddd'],
  ['파일 추가 test "dkkd 9ddd"', 'test', 'dkkd 9ddd'],
  ['파일 추가 test dkkd "9ddd 새파일"', 'test dkkd', '9ddd 새파일'],
  ["파일 추가 'test' dkkd 9ddd", 'test', 'dkkd 9ddd'],
  ['파일 추가 “test” dkkd 9ddd', 'test', 'dkkd 9ddd'],
  ['파일 추가 "test dkkd" "새  파일.txt"', 'test dkkd', '새  파일.txt']
])('명시한 따옴표 경계를 우선한다: %s', async (text, dir, name) => {
  const s = setup(['test', 'test dkkd']);
  const out = await s.prepare(text);
  expect(out.status).toBe('ready');
  if (out.status === 'ready') expect(out.summary.toPath).toBe(path.join(s.docs, dir, name));
});

test('한글 위치를 로컬 비교로 영어 폴더와 맞추고 새 이름은 그대로 둔다', async () => {
  const s = setup(['test'], matchLocalFileNames);
  const out = await s.prepare('파일 추가 테스트 dkkd 9ddd');
  expect(out.status).toBe('ready');
  if (out.status === 'ready') expect(out.summary.toPath).toBe(path.join(s.docs, 'test', 'dkkd 9ddd'));
});

test('한글과 영문 폴더가 둘 다 있으면 새 이름까지 포함해 선택받는다', async () => {
  const s = setup(['test', '테스트'], matchLocalFileNames);
  const out = await s.prepare('파일 추가 테스트 새 메모.txt');
  expect(out.status).toBe('choice');
  if (out.status !== 'choice') return;
  expect(out.options).toHaveLength(2);
  expect(out.options.every((o) => o.display.endsWith('새 이름: 새 메모.txt'))).toBe(true);
});

test('선택한 조합이 없어지거나 임의 선택값이면 중단한다', async () => {
  const s = setup(['test', 'test dkkd']);
  const cmd = s.command('파일 추가 test dkkd 9ddd');
  const out = await s.broker.prepareAsync(cmd);
  if (out.status !== 'choice') throw new Error('시험 준비 오류');
  const picked = out.options.find((o) => o.display.endsWith('새 이름: 9ddd'))!;
  fs.renameSync(path.join(s.docs, 'test dkkd'), path.join(s.other, 'moved'));
  for (const createChoice of [picked.path, JSON.stringify([s.other, '이름'])]) {
    expect(await s.broker.prepareAsync({ ...cmd, args: { ...cmd.args, createChoice } })).toMatchObject({ status: 'error', code: 'changed' });
  }
});

test('원격 허용 밖·확장자·경로 이탈·중복 생성 검사는 그대로 적용한다', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.other, 'private'));
  expect(await s.prepare('파일 추가 private 새 이름', { kind: 'remote' })).toMatchObject({ status: 'error' });
  for (const name of ['거절 파일.md', '../이탈.txt']) {
    expect(await s.prepare(`파일 추가 "test" ${name}`)).toMatchObject({ status: 'error' });
  }
  fs.writeFileSync(path.join(s.docs, 'test', '새 이름'), '원본');
  expect(await s.prepare('파일 추가 test 새 이름')).toMatchObject({ status: 'error', code: 'conflict' });
  expect(fs.readFileSync(path.join(s.docs, 'test', '새 이름'), 'utf8')).toBe('원본');
});

test('AI 비교 실패·비교 도중 허용 범위 변경은 자동 추측 없이 중단한다', async () => {
  const fail = setup(['test'], vi.fn(async () => { throw new Error('비교 실패'); }));
  expect(await fail.prepare('파일 추가 테스트 새 이름')).toMatchObject({ status: 'error', message: '비교 실패' });
  let s: ReturnType<typeof setup>;
  s = setup(['test'], async (_q, candidates) => { s.clearRoots(); return candidates.map((c) => c.id); });
  expect(await s.prepare('파일 추가 테스트 새 이름')).toMatchObject({ status: 'error' });
});

test('동기 준비는 미해석 경계로 실행 계획을 만들지 않는다', () => {
  const s = setup();
  expect(s.broker.prepare(s.command('파일 추가 test 새 이름'))).toMatchObject({ status: 'error' });
});
