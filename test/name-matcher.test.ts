// 실제 임시 파일과 가짜 이름 비교 서버로 경로 선택·원문 보존·허용 범위를 확인한다.
import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ToolBroker } from '../src/main/tools/broker';
import * as policy from '../src/main/tools/policy';
import * as api from '../src/main/api/client';
import type { FileNameCandidate, FileNameMatcher } from '../src/shared/file-names';
import type { Root } from '../src/main/tools/policy';
import { tmpBase } from './tmp-base';

function setup(names = ['test', '테스트', 'sample']) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'name-match-')));
  const docs = path.join(base, 'Documents');
  const down = path.join(base, 'Downloads');
  fs.mkdirSync(docs); fs.mkdirSync(down);
  for (const name of names) fs.mkdirSync(path.join(docs, name));
  const roots = policy.validateRoots([
    { id: 'documents', label: '문서', path: docs, remote: true },
    { id: 'downloads', label: '다운로드', path: down }
  ]).roots;
  const calls: { query: string; candidates: FileNameCandidate[] }[] = [];
  let match: FileNameMatcher = async (query, candidates) => {
    const expected = query.includes('샘플') ? ['sample'] : query.includes('리포트') ? ['report.txt'] : ['test', '테스트'];
    return candidates.filter((c) => expected.includes(c.name)).map((c) => c.id);
  };
  const broker = new ToolBroker({
    getRoots: () => roots,
    getRemoteRoots: () => roots.filter((r) => r.remote),
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    getNameMatcher: () => async (query, candidates) => { calls.push({ query, candidates }); return match(query, candidates); }
  });
  return { base, docs, down, roots, broker, calls, setMatch: (fn: FileNameMatcher) => { match = fn; } };
}

test('실제 한글 이름과 영어 발음 후보를 모두 보여 준다', async () => {
  const s = setup();
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '테스트', name: '메모.txt' } });
  expect(out.status).toBe('choice');
  if (out.status !== 'choice') return;
  expect(out.field).toBe('dest');
  expect(out.options.map((o) => path.basename(o.path)).sort()).toEqual(['test', '테스트']);
  expect(s.calls[0].candidates.every((c) => !c.name.includes('/') && !c.name.includes('메모.txt'))).toBe(true);
});

test('서로 다른 영어 이름도 같은 비교 경로를 쓴다', async () => {
  const s = setup(['sample']);
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '샘플', name: '새메모.txt' } });
  expect(out.status).toBe('ready');
  if (out.status !== 'ready') return;
  expect(out.summary.toPath).toBe(path.join(s.docs, 'sample', '새메모.txt'));
  expect((await s.broker.execute(out.id)).ok).toBe(true);
  expect(fs.existsSync(path.join(s.docs, 'sample', '새메모.txt'))).toBe(true);
});

test('선택한 기존 위치만 바꾸고 새 이름은 한글 그대로 만든다', async () => {
  const s = setup(['test', '테스트']);
  s.setMatch(async (_q, candidates) => candidates.filter((c) => c.name === 'test').map((c) => c.id));
  const first = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '테스트', name: '메모.txt' } });
  expect(first.status).toBe('choice');
  const picked = path.join(s.docs, 'test');
  const ready = await s.broker.prepareAsync({ action: 'file.create', args: { dest: picked, name: '메모.txt' } });
  expect(ready.status).toBe('ready');
  if (ready.status !== 'ready') return;
  expect(ready.summary.toPath).toBe(path.join(picked, '메모.txt'));
  await s.broker.execute(ready.id);
  expect(fs.existsSync(path.join(picked, '메모.txt'))).toBe(true);
  expect(fs.existsSync(path.join(s.docs, '테스트', '메모.txt'))).toBe(false);
  expect(s.calls).toHaveLength(1);
});

test('영문 검색에도 실제 한글 이름을 함께 찾는다', async () => {
  const s = setup(['test', '테스트']);
  const out = await s.broker.prepareAsync({ action: 'file.search', args: { query: 'test' } });
  expect(out.status).toBe('result');
  if (out.status !== 'result') return;
  expect(out.items.map((o) => path.basename(o.path)).sort()).toEqual(['test', '테스트']);
});

test('AI가 정확한 한글 후보를 빼도 앱에서 보존한다', async () => {
  const s = setup(['test', '테스트']);
  s.setMatch(async () => []);
  const out = await s.broker.prepareAsync({ action: 'file.search', args: { query: '테스트' } });
  expect(out.status === 'result' && out.items.map((o) => path.basename(o.path))).toEqual(['테스트']);
});

test('확장자를 뺀 한글 파일명 검색과 이름변경은 기존 target만 해석한다', async () => {
  const s = setup([]);
  fs.writeFileSync(path.join(s.docs, 'report.txt'), '기존 내용');
  const out = await s.broker.prepareAsync({ action: 'file.rename', args: { target: '리포트.txt', name: '테스트.txt', root: 'documents' } });
  expect(out.status).toBe('ready');
  if (out.status !== 'ready') return;
  expect(out.summary.toPath).toBe(path.join(s.docs, '테스트.txt'));
  expect(out.needsConfirm).toBe(true);
  expect(s.calls[0].query).toBe('리포트.txt');
  expect(s.calls[0].candidates.some((c) => c.name === '테스트.txt')).toBe(false);
});

test('원격 허용 밖·숨김·보호 폴더·링크·삭제 보관함은 후보에서 제외한다', async () => {
  const s = setup(['sample']);
  fs.mkdirSync(path.join(s.docs, '.git')); fs.writeFileSync(path.join(s.docs, '.git', 'secret.txt'), 'x');
  fs.mkdirSync(path.join(s.docs, '_to_delete')); fs.writeFileSync(path.join(s.docs, '_to_delete', 'old.txt'), 'x');
  fs.writeFileSync(path.join(s.down, 'outside.txt'), 'x');
  fs.symlinkSync(s.down, path.join(s.docs, 'escape'));
  await s.broker.prepareAsync({ action: 'file.search', args: { query: '샘플' }, source: { kind: 'remote', via: '비서 봇' } });
  const sent = s.calls.flatMap((c) => c.candidates.map((o) => o.name));
  expect(sent).toContain('sample');
  for (const forbidden of ['secret.txt', 'old.txt', 'outside.txt', 'escape', 'Downloads']) expect(sent).not.toContain(forbidden);
});

test('AI가 경로나 없는 번호를 반환하면 실행 계획을 만들지 않는다', async () => {
  const s = setup(['test']);
  s.setMatch(async () => ['outside']);
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '테스트', name: '메모.txt' } });
  expect(out.status === 'error' && out.code).toBe('bad_name_match');
  expect(fs.existsSync(path.join(s.docs, 'test', '메모.txt'))).toBe(false);
});

test('비교 서버 오류를 못 찾음이나 성공으로 바꾸지 않는다', async () => {
  const s = setup(['test']);
  s.setMatch(async () => { throw new Error('시험용 연결 실패'); });
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '테스트', name: '메모.txt' } });
  expect(out.status === 'error' && out.message).toBe('시험용 연결 실패');
});

test('후보가 너무 많으면 일부만 골라 실행하지 않는다', async () => {
  const s = setup(Array.from({ length: 130 }, (_, i) => `folder${i}`));
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '자료', name: '메모.txt' } });
  expect(out.status === 'error' && out.code).toBe('too_many_candidates');
  expect(s.calls).toHaveLength(0);
});

test('허용 범위를 지정하면 그 범위 안에서만 후보를 모은다', async () => {
  const s = setup(['sample']);
  fs.mkdirSync(path.join(s.down, 'outside'));
  const out = await s.broker.prepareAsync({ action: 'file.search', args: { query: '문서 샘플' } });
  expect(out.status === 'result' && out.items[0].path).toBe(path.join(s.docs, 'sample'));
  expect(s.calls[0].query).toBe('샘플');
  expect(s.calls[0].candidates.some((c) => c.name === 'outside')).toBe(false);
});

test('찾지 못한 검색 범위를 전체 허용 폴더로 넓히지 않는다', async () => {
  const s = setup(['test']);
  s.setMatch(async () => []);
  const out = await s.broker.prepareAsync({ action: 'file.search', args: { query: 'test', root: '없는위치' } });
  expect(out.status === 'error' && out.code).toBe('not_found');
});

test('실제 경로를 선택한 뒤에는 AI를 다시 부르지 않고 기존 검사를 쓴다', async () => {
  const s = setup(['test']);
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: path.join(s.docs, 'test'), name: '테스트.txt' } });
  expect(out.status).toBe('ready');
  expect(s.calls).toHaveLength(0);
});

test('AI 서버를 설정하지 않은 경로는 기존 글자 검색을 유지한다', async () => {
  const s = setup(['test']);
  const broker = new ToolBroker({ getRoots: () => s.roots, shell: { openPath: async () => '', showItemInFolder: () => {} } });
  const out = await broker.prepareAsync({ action: 'file.search', args: { query: 'test' } });
  expect(out.status === 'result' && out.items.length).toBe(1);
});

test('허용 폴더가 AI 응답 대기 중 해제되면 결과도 거부한다', async () => {
  const s = setup(['test']);
  s.setMatch(async (_q, candidates) => { s.roots.splice(0); return candidates.map((c) => c.id); });
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: '테스트', name: '메모.txt' } });
  expect(out.status).toBe('error');
});

test('이름 비교 API는 후보 이름과 번호만 전송한다', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ids":["c1"]}'));
  try {
    const p = { type: 'assistant' as const, baseUrl: 'http://localhost/v1', apiKey: '시험용' };
    expect(await api.matchFileNames(p, '테스트', [{ id: 'c1', name: 'test' }])).toEqual(['c1']);
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost/v1/files/match');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ query: '테스트', candidates: [{ id: 'c1', name: 'test' }] });
  } finally { fetcher.mockRestore(); }
});

test('이름 비교 API의 잘못된 번호·중복·옛 서버를 거부한다', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    const p = { type: 'assistant' as const, baseUrl: 'http://localhost', apiKey: '' };
    for (const text of ['{"ids":["unknown"]}', '{"ids":["c1","c1"]}', '{"ids":[1]}', 'null']) {
      fetcher.mockResolvedValueOnce(new Response(text));
      await expect(api.matchFileNames(p, '테스트', [{ id: 'c1', name: 'test' }])).rejects.toMatchObject({ code: 'bad_response' });
    }
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(api.matchFileNames(p, '테스트', [{ id: 'c1', name: 'test' }])).rejects.toMatchObject({ code: 'unsupported' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 }));
    await expect(api.matchFileNames(p, '테스트', [{ id: 'c1', name: 'test' }])).rejects.toMatchObject({ code: 'unsupported' });
    await expect(api.matchFileNames({ ...p, type: 'auto' }, '테스트', [])).rejects.toMatchObject({ code: 'unsupported' });
  } finally { fetcher.mockRestore(); }
});


test('검색 범위의 한글·영문 후보도 선택한 뒤 그 범위로만 검색한다', async () => {
  const s = setup([]);
  s.roots[0].label = '테스트';
  s.roots[1].label = 'test';
  fs.writeFileSync(path.join(s.down, 'a.txt'), '선택한 범위');
  s.setMatch(async (_q, candidates) => candidates.filter((c) => c.name === 'test').map((c) => c.id));
  const first = await s.broker.prepareAsync({ action: 'file.search', args: { root: '테스트', query: 'a' } });
  expect(first.status === 'choice' && first.field).toBe('root');
  const next = await s.broker.prepareAsync({ action: 'file.search', args: { root: s.down, query: 'a' } });
  expect(next.status === 'result' && next.items.map((i) => i.path)).toEqual([path.join(s.down, 'a.txt')]);
});

test('기존 기본 폴더 별칭과 조사 처리를 유지한다', async () => {
  const s = setup(['sample']);
  for (const root of ['내 문서', '문서에서']) {
    const out = await s.broker.prepareAsync({ action: 'file.create', args: { root, dest: '샘플 폴더에서', name: '메모.txt' } });
    expect(out.status).toBe('ready');
  }
  expect(s.calls[0].query).toBe('샘플');
});

test('허용 범위 밖 전체 경로는 AI로 대체하지 않고 거부한다', async () => {
  const s = setup(['test']);
  const out = await s.broker.prepareAsync({ action: 'file.create', args: { dest: s.base, name: '메모.txt' } });
  expect(out.status).toBe('error');
  expect(s.calls).toHaveLength(0);
});


test('확장자를 말했으면 다른 확장자와 폴더는 AI 후보에서도 뺀다', async () => {
  const s = setup(['memo']);
  fs.writeFileSync(path.join(s.docs, 'memo.txt'), '텍스트');
  fs.writeFileSync(path.join(s.docs, 'memo.pdf'), '문서');
  s.setMatch(async (_q, candidates) => candidates.map((c) => c.id));
  const out = await s.broker.prepareAsync({ action: 'file.search', args: { query: '메모.txt' } });
  expect(out.status === 'result' && out.items.map((o) => path.basename(o.path))).toEqual(['memo.txt']);
  expect(s.calls[0].candidates.map((c) => c.name)).toEqual(['memo.txt']);
});


test('맥의 자모 분리 한글 이름도 영어 이름과 함께 찾는다', async () => {
  const s = setup(['test', '테스트'.normalize('NFD')]);
  const out = await s.broker.prepareAsync({ action: 'file.search', args: { query: 'test' } });
  expect(out.status === 'result' && out.items.map((o) => path.basename(o.path).normalize('NFC')).sort()).toEqual(['test', '테스트']);
  expect(s.calls[0].candidates.some((c) => c.name === '테스트')).toBe(true);
});

test('이름 안의 제어 문자는 비교 API에 보내지 않는다', async () => {
  const s = setup(['sample']);
  fs.writeFileSync(path.join(s.docs, 'unsafe\nname.txt'), '시험 자료');
  s.setMatch(async () => []);
  await s.broker.prepareAsync({ action: 'file.search', args: { query: '샘플' } });
  expect(s.calls[0].candidates.every((c) => !/[\x00-\x1f\x7f]/.test(c.name))).toBe(true);
});
