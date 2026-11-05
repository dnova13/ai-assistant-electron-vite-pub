import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { matchLocalFileNames } from '../src/main/tools/local-name-matcher';
import { selectNameMatcher } from '../src/main/tools/name-method';
import { createStore, normalize } from '../src/main/settings';
import { ToolBroker } from '../src/main/tools/broker';
import { validateRoots } from '../src/main/tools/policy';
import { tmpBase } from './tmp-base';
import cases from './fixtures/file-name-cases.json';

// 마지막 네 항목은 약어·사전 밖 이름의 한계를 성능 평가에 남긴다.
test.each(cases.slice(0, 20))('사전과 실제 발음으로 후보 비교: $query / $names', async ({ query, names, want }) => {
  const candidates = names.map((name, i) => ({ id: `c${i + 1}`, name }));
  expect((await matchLocalFileNames(query, candidates)).sort()).toEqual([...want].sort());
});

test('맥의 자모 분리 이름과 인식문도 비교한다', async () => {
  expect(await matchLocalFileNames('마이 뮤직'.normalize('NFD'), [{ id: 'en', name: 'My Music' }, { id: 'ko', name: '마이 뮤직'.normalize('NFD') }])).toEqual(['en', 'ko']);
});

test('사전에 없는 영문을 임의로 추측하지 않는다', async () => {
  expect(await matchLocalFileNames('즈크브로', [{ id: 'x', name: 'zxqvbro' }])).toEqual([]);
});

test('이 컴퓨터 방식은 AI 연결 유무와 관계없이 서버를 부르지 않는다', async () => {
  const ai = vi.fn(async () => ['ai']);
  expect(await selectNameMatcher('local', ai)('샘플', [{ id: 'sample', name: 'sample' }])).toEqual(['sample']);
  expect(ai).not.toHaveBeenCalled();
  expect(await selectNameMatcher('local', null)('샘플', [{ id: 'sample', name: 'sample' }])).toEqual(['sample']);
});

test('AI 방식은 선택한 서버만 쓰며 연결이 없거나 실패하면 중단한다', async () => {
  const ai = vi.fn(async () => ['server']);
  expect(await selectNameMatcher('assistant', ai)('샘플', [])).toEqual(['server']);
  await expect(selectNameMatcher('assistant', null)('샘플', [])).rejects.toThrow('내 서버 프로필');
  await expect(selectNameMatcher('assistant', async () => { throw new Error('연결 실패'); })('샘플', [])).rejects.toThrow('연결 실패');
});

test('예전 설정·잘못된 설정은 로컬 기본값, 저장한 방식은 재시작해도 보존한다', () => {
  expect(normalize({ tools: { allowedRoots: [] } }).tools.nameMethod).toBe('local');
  expect(normalize({ tools: { nameMethod: 'unknown' } }).tools.nameMethod).toBe('local');
  const dir = fs.mkdtempSync(path.join(tmpBase(), 'name-settings-'));
  const store = createStore(path.join(dir, 'settings.json'), null);
  const s = normalize({});
  s.tools.nameMethod = 'assistant';
  store.save(s);
  expect(store.load().tools.nameMethod).toBe('assistant');
});

test('AI 없는 실제 폴더의 선택·새 이름 보존·생성·원격 범위를 함께 검증한다', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'local-name-flow-')));
  const docs = path.join(base, 'Documents');
  const down = path.join(base, 'Downloads');
  fs.mkdirSync(docs); fs.mkdirSync(down);
  for (const name of ['My Music', '마이 뮤직']) fs.mkdirSync(path.join(docs, name));
  fs.mkdirSync(path.join(down, 'My Music'));
  const roots = validateRoots([{ id: 'documents', label: '문서', path: docs, remote: true }, { id: 'downloads', label: '다운로드', path: down }]).roots;
  const broker = new ToolBroker({ getRoots: () => roots, getRemoteRoots: () => roots.filter((r) => r.remote), getNameMatcher: () => selectNameMatcher('local', null), shell: { openPath: async () => '', showItemInFolder: () => {} } });
  const req = { action: 'file.create', args: { dest: '마이 뮤직', name: '새 메모.txt' }, source: { kind: 'remote' as const } };
  const choice = await broker.prepareAsync(req);
  expect(choice.status).toBe('choice');
  if (choice.status !== 'choice') throw new Error('후보 선택이 필요합니다.');
  expect(choice.options.map((o) => o.path).sort()).toEqual([path.join(docs, 'My Music'), path.join(docs, '마이 뮤직')].sort());
  expect(fs.existsSync(path.join(docs, 'My Music', '새 메모.txt'))).toBe(false);
  const ready = await broker.prepareAsync({ ...req, args: { ...req.args, dest: path.join(docs, 'My Music') } });
  expect(ready.status).toBe('ready');
  if (ready.status !== 'ready') throw new Error('실행 계획이 필요합니다.');
  expect((await broker.execute(ready.id)).ok).toBe(true);
  expect(fs.existsSync(path.join(docs, 'My Music', '새 메모.txt'))).toBe(true);
  expect(fs.readdirSync(down)).toEqual(['My Music']);
});
