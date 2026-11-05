// 실제 파일을 열지는 않고, 선택 범위·대상 경로와 shell 호출을 확인한다.
import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLocalCommand } from '../src/shared/commands';
import type { ActionArgs, ToolSource } from '../src/shared/types';
import { ToolBroker } from '../src/main/tools/broker';
import { matchLocalFileNames } from '../src/main/tools/local-name-matcher';
import * as policy from '../src/main/tools/policy';
import type { FileNameMatcher } from '../src/shared/file-names';
import { tmpBase } from './tmp-base';

function setup(matcher: FileNameMatcher | null = null) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'open-command-')));
  const docs = path.join(base, 'docs'); const down = path.join(base, 'down');
  const music = path.join(docs, 'test', 'my music'); const outside = path.join(docs, 'other');
  for (const dir of [music, outside, down]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [music, outside, down]) fs.writeFileSync(path.join(dir, '메모.txt'), dir);
  fs.writeFileSync(path.join(music, '유일.txt'), 'one');
  fs.writeFileSync(path.join(music, '회의 자료.txt'), 'two');
  const roots = policy.validateRoots([{ id: 'documents', label: '문서', path: docs, remote: true }, { id: 'downloads', label: '다운로드', path: down }]).roots;
  const openPath = vi.fn(async (_path: string) => '');
  const showItemInFolder = vi.fn((_path: string) => {});
  let allowed = roots;
  const broker = new ToolBroker({ getRoots: () => allowed, getRemoteRoots: () => allowed.filter((r) => r.remote), getNameMatcher: () => matcher, shell: { openPath, showItemInFolder } });
  const command = (text: string) => { const c = parseLocalCommand(text); if (!c || 'help' in c) throw new Error('시험 명령'); return c; };
  const prepare = (text: string, source: ToolSource = { kind: 'local' }) => broker.prepareAsync({ ...command(text), source });
  return { docs, down, music, outside, roots, broker, openPath, showItemInFolder, command, prepare, clearRoots: () => { allowed = []; } };
}

test.each(['파일', '!파일'])('%s 열기: 공백 있는 위치를 먼저 찾고 그 안에서 확장자 없이 찾는다', async (prefix) => {
  const s = setup(); const out = await s.prepare(`${prefix} 열기 my music 메모`);
  expect(out.status).toBe('ready');
  if (out.status !== 'ready') return;
  expect(out.summary.fromPath).toBe(path.join(s.music, '메모.txt'));
  expect((await s.broker.execute(out.id)).ok).toBe(true);
  expect(s.openPath).toHaveBeenCalledExactlyOnceWith(path.join(s.music, '메모.txt'));
});

test.each(['my music', 'test/my music', '문서/test/my music'])('자연어 위치 root=%s도 같은 범위에서 찾는다', async (root) => {
  const s = setup(matchLocalFileNames);
  const out = await s.broker.prepareAsync({ action: 'file.open', args: { root, target: '메모' } });
  expect(out.status).toBe('ready');
  if (out.status === 'ready') expect(out.summary.fromPath).toBe(path.join(s.music, '메모.txt'));
});

test('위치를 생략하면 전체 허용 폴더의 경로를 보여 주고 선택받는다', async () => {
  const s = setup(); const out = await s.prepare('파일 열기 메모');
  expect(out.status).toBe('choice');
  if (out.status !== 'choice') return;
  expect(out.field).toBe('target'); expect(out.options).toHaveLength(3);
  expect(s.openPath).not.toHaveBeenCalled();
  const ready = await s.broker.prepareAsync({ action: 'file.open', args: { target: path.join(s.down, '메모.txt') } });
  expect(ready.status).toBe('ready');
});

test('위치를 생략해도 대상이 하나면 선택 없이 준비한다', async () => {
  const s = setup(); const out = await s.prepare('파일 열기 유일');
  expect(out.status).toBe('ready');
  if (out.status === 'ready') expect(out.summary.fromPath).toBe(path.join(s.music, '유일.txt'));
});

test.each(['파일 열기 "my music" 메모', '파일 열기 my music "회의 자료"', '파일 열기 "회의 자료"'])('따옴표가 지정한 경계를 유지한다: %s', async (text) => {
  const s = setup(); const out = await s.prepare(text);
  expect(out.status).toBe('ready');
  if (out.status === 'ready') expect(out.summary.fromPath).toBe(path.join(s.music, text.endsWith('메모') ? '메모.txt' : '회의 자료.txt'));
});

test('자연어 한글 위치는 영어 실제 폴더와 비교한다', async () => {
  const s = setup(matchLocalFileNames);
  const out = await s.broker.prepareAsync({ action: 'file.open', args: { root: '마이 뮤직', target: '메모' } });
  expect(out.status).toBe('ready');
  if (out.status === 'ready') expect(out.summary.fromPath).toBe(path.join(s.music, '메모.txt'));
});

test('지정 폴더 안에 없으면 다른 허용 폴더의 파일을 대신 열지 않는다', async () => {
  const s = setup(); fs.renameSync(path.join(s.music, '메모.txt'), path.join(s.music, '바뀐이름.txt'));
  for (const out of [await s.prepare('파일 열기 my music 메모'), await s.broker.prepareAsync({ action: 'file.open', args: { target: '메모', root: 'my music' } }), await s.prepare('파일 열기 "없는 폴더" 메모')]) expect(out.status).toBe('error');
  expect(s.openPath).not.toHaveBeenCalled();
});

test('존재하지 않는 자연어 위치는 전체 검색으로 확대하지 않는다', async () => {
  const s = setup(matchLocalFileNames);
  expect(await s.broker.prepareAsync({ action: 'file.open', args: { target: '메모', root: '없는폴더' } })).toMatchObject({ status: 'error' });
});

test('같은 위치 이름이 여럿이면 실제 폴더 경로를 먼저 선택한다', async () => {
  const s = setup(); fs.mkdirSync(path.join(s.down, 'my music'));
  const out = await s.broker.prepareAsync({ action: 'file.open', args: { root: 'my music', target: '메모' } });
  expect(out.status).toBe('choice');
  if (out.status !== 'choice') return;
  expect(out.field).toBe('root'); expect(out.options).toHaveLength(2);
  const ready = await s.broker.prepareAsync({ action: 'file.open', args: { root: s.music, target: '메모' } });
  expect(ready.status).toBe('ready');
});

test('경계가 여러 개면 위치를 고르되 하위 파일은 열기 후보에서 제외한다', async () => {
  const s = setup(); const other = path.join(s.docs, 'test', 'my music 회의'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, '자료.txt'), 'x');
  fs.mkdirSync(path.join(s.music, 'sub')); fs.writeFileSync(path.join(s.music, 'sub', '회의 자료.txt'), 'y');
  const cmd = s.command('파일 열기 my music 회의 자료');
  const first = await s.broker.prepareAsync(cmd);
  expect(first.status).toBe('choice');
  if (first.status !== 'choice') return;
  expect(first.field).toBe('openChoice');
  const picked = first.options.find((o) => o.display.endsWith('대상: 회의 자료'))!;
  const args = { ...cmd.args, openChoice: picked.path };
  const files = await s.broker.prepareAsync({ ...cmd, args });
  expect(files.status).toBe('ready');
  if (files.status === 'ready') expect(files.summary.fromPath).toBe(path.join(s.music, '회의 자료.txt'));
  expect(await s.broker.prepareAsync({ ...cmd, args: { ...args, target: path.join(s.music, 'sub', '회의 자료.txt') } })).toMatchObject({ status: 'error' });
});

test('전체 파일 이름과 폴더+이름 해석이 모두 맞으면 임의로 고르지 않는다', async () => {
  const s = setup(); const whole = path.join(s.outside, 'my music 메모.txt'); fs.writeFileSync(whole, 'whole');
  const cmd = s.command('파일 열기 my music 메모'); const out = await s.broker.prepareAsync(cmd);
  expect(out.status).toBe('choice');
  if (out.status !== 'choice') return;
  expect(out.field).toBe('openChoice');
  const global = out.options.find((o) => o.display.startsWith('범위:'))!;
  const ready = await s.broker.prepareAsync({ ...cmd, args: { ...cmd.args, openChoice: global.path } });
  expect(ready.status).toBe('ready');
  if (ready.status === 'ready') expect(ready.summary.fromPath).toBe(whole);
});

test('원격 허용 범위·절대 경로 이탈·상대 경로 이탈을 검사한다', async () => {
  const s = setup();
  for (const target of [path.join(s.outside, '메모.txt'), '../../other/메모.txt']) expect(await s.broker.prepareAsync({ action: 'file.open', args: { root: 'my music', target } })).toMatchObject({ status: 'error' });
  const remote = await s.prepare('파일 열기 메모', { kind: 'remote', via: '비서 봇' });
  expect(remote.status).toBe('choice');
  if (remote.status === 'choice') expect(remote.options.every((o) => !o.path.startsWith(s.down))).toBe(true);
  expect(await s.broker.prepareAsync({ action: 'file.open', args: { root: s.down, target: '메모' }, source: { kind: 'remote' } })).toMatchObject({ status: 'error' });
});

test('허위 선택·동기 준비·실행 파일은 거절한다', async () => {
  const s = setup(); const cmd = s.command('파일 열기 my music 메모');
  expect(s.broker.prepare(cmd).status).toBe('error');
  expect(await s.broker.prepareAsync({ ...cmd, args: { ...cmd.args, openChoice: JSON.stringify([s.down, '메모']) } })).toMatchObject({ status: 'error' });
  fs.writeFileSync(path.join(s.music, 'run.sh'), 'echo test');
  expect(await s.prepare('파일 열기 my music run.sh')).toMatchObject({ status: 'error', code: 'executable' });
});

test('AI 비교 오류와 비교 도중 권한 변경은 실행하지 않는다', async () => {
  const fail = setup(async () => { throw new Error('비교 오류'); });
  expect(await fail.broker.prepareAsync({ action: 'file.open', args: { root: '마이 뮤직', target: '메모' } })).toMatchObject({ status: 'error', message: '비교 오류' });
  let s: ReturnType<typeof setup>;
  s = setup(async (_q, candidates) => { s.clearRoots(); return candidates.map((c) => c.id); });
  expect(await s.broker.prepareAsync({ action: 'file.open', args: { root: '마이 뮤직', target: '메모' } })).toMatchObject({ status: 'error' });
});


test('공백 있는 이름의 일부 검색도 위치 해석과 모호하면 선택한다', async () => {
  const s = setup();fs.writeFileSync(path.join(s.outside, 'my music 메모 보관.txt'), 'partial');
  const out = await s.prepare('파일 열기 my music 메모');
  expect(out.status).toBe('choice');
  if (out.status === 'choice') expect(out.field).toBe('openChoice');
});


test.each(['파일', '!파일'])('%s 위치 보기와 이름 변경도 같은 폴더 안에서만 찾는다', async (prefix) => {
  const s = setup();
  const reveal = await s.prepare(`${prefix} 위치 my music 메모`);
  expect(reveal.status).toBe('ready');
  if (reveal.status !== 'ready') return;
  await s.broker.execute(reveal.id);
  expect(s.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path.join(s.music, '메모.txt'));
  const rename = await s.prepare(`${prefix} 이름 my music 메모 새메모.txt`);
  expect(rename.status).toBe('ready');
  if (rename.status !== 'ready') return;
  expect(rename.needsConfirm).toBe(true);
  expect(rename.summary.toPath).toBe(path.join(s.music, '새메모.txt'));
  expect(fs.existsSync(path.join(s.music, '메모.txt'))).toBe(true);
  expect((await s.broker.execute(rename.id)).ok).toBe(true);
  expect(fs.existsSync(path.join(s.music, '새메모.txt'))).toBe(true);
  expect(fs.existsSync(path.join(s.outside, '메모.txt'))).toBe(true);
});

test.each(['file.reveal', 'file.rename'])('%s 자연어 위치·위치 생략·잘못된 위치를 동일하게 처리한다', async (action) => {
  const s = setup(matchLocalFileNames);
  const args = { target: '메모', ...(action === 'file.rename' ? { name: '새 이름.txt' } : {}) };
  const scoped = await s.broker.prepareAsync({ action, args: { ...args, root: 'test/my music' } });
  expect(scoped.status).toBe('ready');
  if (scoped.status === 'ready') expect(scoped.summary.fromPath).toBe(path.join(s.music, '메모.txt'));
  const global = await s.broker.prepareAsync({ action, args });
  expect(global.status).toBe('choice');
  if (global.status === 'choice') expect(global.options).toHaveLength(3);
  expect(await s.broker.prepareAsync({ action, args: { ...args, root: '없는폴더' } })).toMatchObject({ status: 'error' });
  fs.renameSync(path.join(s.music, '메모.txt'), path.join(s.music, '다른이름.txt'));
  expect(await s.broker.prepareAsync({ action, args: { ...args, root: 'my music' } })).toMatchObject({ status: 'error' });
});

test('이름 변경은 공백 새 이름의 따옴표·취소·충돌 검사를 유지한다', async () => {
  const s = setup();
  const out = await s.prepare('파일 이름 "my music" "회의 자료" "새 회의 자료.txt"');
  expect(out.status).toBe('ready');
  if (out.status !== 'ready') return;
  expect(out.summary.toPath).toBe(path.join(s.music, '새 회의 자료.txt'));
  expect(out.needsConfirm).toBe(true);
  s.broker.cancel(out.id);
  expect((await s.broker.execute(out.id)).ok).toBe(false);
  expect(fs.existsSync(path.join(s.music, '회의 자료.txt'))).toBe(true);
  fs.writeFileSync(path.join(s.music, '새 회의 자료.txt'), 'existing');
  expect(await s.prepare('파일 이름 my music "회의 자료" "새 회의 자료.txt"')).toMatchObject({ status: 'error', code: 'conflict' });
});

test.each(['file.reveal', 'file.rename'])('%s도 원격 미허용과 지정 범위 이탈을 거절한다', async (action) => {
  const s = setup();
  const args = { target: path.join(s.outside, '메모.txt'), root: 'my music', name: '바꾸기.txt' };
  expect(await s.broker.prepareAsync({ action, args })).toMatchObject({ status: 'error' });
  expect(await s.broker.prepareAsync({ action, args: { target: '메모', root: s.down, name: '바꾸기.txt' }, source: { kind: 'remote' } })).toMatchObject({ status: 'error' });
});
