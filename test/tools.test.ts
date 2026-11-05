/* eslint-disable @typescript-eslint/no-explicit-any -- 시험에서는 결과 모양을 바로 꺼내 본다 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dateStr, resultHead } from '../src/shared/local-files';
import * as policy from '../src/main/tools/policy';
import { ToolBroker } from '../src/main/tools/broker';
import { tmpBase } from './tmp-base';

/* ---------- 문자열 규칙 (맥·윈도우를 리눅스에서 시험) ---------- */

test('윈도우 이름 규칙', () => {
  assert.match(policy.checkName('CON', 'win32') ?? '', /예약/);
  assert.match(policy.checkName('nul.txt', 'win32') ?? '', /예약/);
  assert.match(policy.checkName('a<b.txt', 'win32') ?? '', /쓸 수 없는 문자/);
  assert.match(policy.checkName('보고서. ', 'win32') ?? '', /끝날 수 없/);
  assert.equal(policy.checkName('보고서.pdf', 'win32'), null);
  assert.equal(policy.checkName('CON', 'darwin'), null); // 맥에서는 괜찮다
  assert.match(policy.checkName('a:b', 'darwin') ?? '', /:/);
  assert.match(policy.checkName('..', 'linux') ?? '', /쓸 수 없는/);
});

test('윈도우 경로 형식', () => {
  assert.match(policy.checkRawPath('\\\\server\\share\\a.txt', 'win32') ?? '', /UNC/);
  assert.match(policy.checkRawPath('\\\\?\\C:\\a.txt', 'win32') ?? '', /UNC/);
  assert.match(policy.checkRawPath('C:\\a.txt:secret', 'win32') ?? '', /:/);
  assert.match(policy.checkRawPath('docs\\a.txt', 'win32') ?? '', /전체 경로/);
  assert.equal(policy.checkRawPath('C:\\Users\\me\\Documents\\a.txt', 'win32'), null);
  assert.equal(policy.checkRawPath('/Users/me/Documents/a.txt', 'darwin'), null);
});

test('대소문자: 맥·윈도우는 구분 안 함, 리눅스는 구분', () => {
  assert.equal(policy.isInside('C:\\Users\\ME\\Documents', 'c:\\users\\me\\documents\\a.txt', 'win32'), true);
  assert.equal(policy.isInside('/Users/me/Documents', '/users/ME/documents/a', 'darwin'), true);
  assert.equal(policy.isInside('/home/me/Docs', '/home/me/docs/a', 'linux'), false);
  assert.equal(policy.isInside('/a/b', '/a/bc', 'linux'), false); // 이름이 비슷한 옆 폴더
  assert.equal(policy.isInside('/a/b', '/a/b/../c', 'linux'), false);
});

test('허용 폴더로 지정할 수 없는 곳', () => {
  const mac = { platform: 'darwin', home: '/Users/me', env: {} };
  assert.match(policy.forbiddenRootReason('/', mac) ?? '', /디스크 전체/);
  assert.match(policy.forbiddenRootReason('/Users/me', mac) ?? '', /홈 폴더/);
  assert.match(policy.forbiddenRootReason('/Users', mac) ?? '', /홈 폴더/);
  assert.match(policy.forbiddenRootReason('/Users/me/Library/Mail', mac) ?? '', /시스템 폴더/);
  assert.match(policy.forbiddenRootReason('/System/Library', mac) ?? '', /시스템 폴더/);
  assert.equal(policy.forbiddenRootReason('/Users/me/Documents', mac), null);
  const win = { platform: 'win32', home: 'C:\\Users\\me', env: { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } };
  assert.match(policy.forbiddenRootReason('D:\\', win) ?? '', /디스크 전체/);
  assert.match(policy.forbiddenRootReason('c:\\windows\\system32', win) ?? '', /시스템 폴더/);
  assert.match(policy.forbiddenRootReason('C:\\Users\\me', win) ?? '', /홈 폴더/);
  assert.equal(policy.forbiddenRootReason('C:\\Users\\me\\Documents', win), null);
});

/* ---------- 실제 파일로 시험 ---------- */

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'tools-')));
  const home = path.join(base, 'home');
  const docs = path.join(home, 'Documents');
  const down = path.join(home, 'Downloads');
  const outside = path.join(base, 'outside');
  for (const d of [docs, down, outside, path.join(docs, '2026'), path.join(down, '.git')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(down, '보고서.pdf'), 'report');
  fs.writeFileSync(path.join(docs, '2026', '보고서.pdf'), 'old report'); // 같은 이름 다른 폴더
  fs.writeFileSync(path.join(down, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(down, 'setup.exe'), 'MZ');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(down, '.git', 'config'), 'x');
  fs.symlinkSync(outside, path.join(down, 'escape')); // 밖을 가리키는 링크
  // 맥에서 만든 한글 파일명은 자모가 분리된(NFD) 경우가 많다
  fs.writeFileSync(path.join(down, '회의록.txt'.normalize('NFD')), 'nfd');
  const { roots, errors } = policy.validateRoots(
    [
      { id: 'documents', label: '문서', path: docs },
      { id: 'downloads', label: '다운로드', path: down },
      { id: 'bad', label: '홈', path: home }
    ],
    { home, env: {} }
  );
  const trash = path.join(base, 'trash');
  fs.mkdirSync(trash);
  const opened: string[] = [];
  const shell = {
    openPath: async (p: string) => {
      opened.push(p);
      return '';
    },
    showItemInFolder: (p: string) => opened.push(`reveal:${p}`),
    trashItem: async (p: string) => fs.renameSync(p, path.join(trash, `${Date.now()}-${path.basename(p)}`))
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs: Record<string, any>[] = [];
  let clock = 1000;
  const broker = new ToolBroker({ getRoots: () => roots, shell, audit: { file: '', log: (e) => logs.push(e) }, now: () => clock });
  return { base, home, docs, down, outside, trash, roots, errors, broker, opened, logs, tick: (ms: number) => (clock += ms) };
}

test('허용 폴더 검사: 홈 전체는 거부된다', () => {
  const s = sandbox();
  assert.equal(s.roots.length, 2);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].reason, /홈 폴더/);
});

test('경로 탈출을 막는다', () => {
  const s = sandbox();
  const chk = (p: string) => policy.checkExisting(p, s.roots);
  assert.equal(chk(path.join(s.outside, 'secret.txt')).ok, false);
  assert.equal(chk(path.join(s.down, '..', '..', 'outside', 'secret.txt')).ok, false);
  assert.equal(chk(path.join(s.down, 'escape', 'secret.txt')).ok, false); // 심볼릭 링크로 밖
  assert.match((chk(path.join(s.down, '.git', 'config')) as { reason: string }).reason, /보호된 폴더/);
  assert.equal(chk(path.join(s.down, '보고서.pdf')).ok, true);
});

test('이름 찾기: 여러 개면 고르게 하고, NFD 한글 이름도 찾는다', () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.open', args: { target: '보고서.pdf' } });
  assert.equal(r.status, 'choice');
  assert.equal(r.options.length, 2);
  const r2: any = s.broker.prepare({ action: 'file.open', args: { target: '보고서.pdf', root: '다운로드' } });
  assert.equal(r2.status, 'ready');
  const r3: any = s.broker.prepare({ action: 'file.search', args: { query: '회의록' } });
  assert.equal(r3.status, 'result');
  assert.equal(r3.items.length, 1);
  const r4: any = s.broker.prepare({ action: 'file.search', args: { query: 'secret' } });
  assert.equal(r4.items.length, 0); // 링크를 따라 밖을 찾지 않는다
});

test('실행 파일은 열지 않는다', () => {
  const s = sandbox();
  assert.equal((s.broker.prepare({ action: 'file.open', args: { target: 'setup.exe' } }) as any).code, 'executable');
  assert.equal((s.broker.prepare({ action: 'file.open', args: { target: 'run.sh' } }) as any).code, 'executable');
});

test('이동: 확인 필요, 한 번만, 기록 남김', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.move', args: { target: '보고서.pdf', root: 'downloads', dest: '문서 폴더로' }, source: { kind: 'server', id: 'a1' } });
  assert.equal(r.status, 'ready');
  assert.equal(r.needsConfirm, true);
  assert.equal(r.summary.from, '다운로드/보고서.pdf');
  assert.equal(r.summary.to, '문서/보고서.pdf');
  const out = await s.broker.execute(r.id);
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(s.docs, '보고서.pdf')));
  assert.ok(!fs.existsSync(path.join(s.down, '보고서.pdf')));
  const again = await s.broker.execute(r.id);
  assert.equal(again.status, 'expired');
  assert.equal(s.logs.at(-1)!.status, 'done');
  assert.equal(s.logs.at(-1)!.source.kind, 'server');
});

test('60초가 지나면 실행되지 않는다', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.copy', args: { target: '회의록.txt', dest: 'documents' } });
  s.tick(61000);
  const out = await s.broker.execute(r.id);
  assert.equal(out.status, 'expired');
  assert.ok(!fs.existsSync(path.join(s.docs, '회의록.txt'.normalize('NFD'))));
});

test('확인 창 사이에 파일이 바뀌면 실행하지 않는다', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.move', args: { target: '회의록.txt', dest: 'documents' } });
  const f = path.join(s.down, '회의록.txt'.normalize('NFD'));
  fs.writeFileSync(f, 'replaced with something else');
  const out = await s.broker.execute(r.id);
  assert.equal(out.ok, false);
  assert.match(out.message, /바뀌었습니다/);
  assert.ok(fs.existsSync(f));
});

test('같은 이름이 있으면 덮어쓰지 않고 날짜를 붙인 이름으로 복사한다', async () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.docs, '보고서.pdf'), 'existing');
  const r: any = s.broker.prepare({ action: 'file.copy', args: { target: '보고서.pdf', root: 'downloads', dest: 'documents' } });
  assert.equal(r.summary.conflict, true);
  const name = `보고서 ${dateStr()}.pdf`;
  assert.equal(r.summary.to, `문서/${name}`);
  assert.match(r.summary.warnings[0], /덮어쓰지 않습니다/);
  const out = await s.broker.execute(r.id, { overwrite: true }); // overwrite는 무시된다
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(s.docs, '보고서.pdf'), 'utf8'), 'existing'); // 기존 파일 그대로
  assert.equal(fs.readFileSync(path.join(s.docs, name), 'utf8'), 'report');
  // 또 복사하면 번호
  const r2: any = s.broker.prepare({ action: 'file.copy', args: { target: '보고서.pdf', root: 'downloads', dest: 'documents' } });
  assert.equal(r2.summary.to, `문서/보고서 ${dateStr()} (2).pdf`);
  assert.equal(fs.readdirSync(s.trash).length, 0); // 휴지통은 쓰지 않는다
});

test('허용 폴더 밖으로는 옮기지 못한다', () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.move', args: { target: '회의록.txt', dest: s.outside } });
  assert.equal(r.status, 'error');
  assert.match(r.message, /허용 폴더 밖/);
});

test('폴더를 자기 안으로 옮기지 못한다', () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.move', args: { target: path.join(s.docs, '2026'), dest: path.join(s.docs, '2026') } });
  assert.equal(r.status, 'error');
});

test('삭제: 두 번 묻고, _to_delete/<날짜>/로 옮기고, 원래 위치를 적는다', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.delete', args: { target: '회의록.txt' } });
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.summary.questions, ['삭제하겠습니까?', '정말로 삭제하겠습니까?']);
  const out = await s.broker.execute(r.id);
  assert.equal(out.ok, true);
  assert.equal(out.message, '삭제했습니다.');
  const dir = path.join(s.down, '_to_delete', dateStr());
  assert.ok(!fs.existsSync(path.join(s.down, '회의록.txt'.normalize('NFD'))));
  assert.equal(fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, '.restore.jsonl'), 'utf8').trim());
  assert.match(rec.from.normalize('NFC'), /회의록/);
  // 같은 이름을 또 삭제하면 시각을 붙인다
  fs.writeFileSync(path.join(s.down, '회의록.txt'), 'again');
  const r2: any = s.broker.prepare({ action: 'file.delete', args: { target: '회의록.txt' } });
  await s.broker.execute(r2.id);
  assert.equal(fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length, 2);
  // 삭제한 파일은 찾기에 나오지 않고, 다시 삭제하지 못한다
  const found: any = s.broker.prepare({ action: 'file.search', args: { query: '회의록' } });
  assert.equal(found.items.length, 0);
  const inTrash = fs.readdirSync(dir).find((n) => !n.startsWith('.'))!;
  const r3: any = s.broker.prepare({ action: 'file.delete', args: { target: path.join(dir, inTrash) } });
  assert.equal(r3.status, 'error');
  // 허용 폴더 자체는 지우지 못한다
  assert.equal((s.broker.prepare({ action: 'file.delete', args: { target: s.docs } }) as any).status, 'error');
});

test('이름 바꾸기: 확인 한 번, 같은 이름이 있으면 거부', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.rename', args: { target: '회의록.txt', name: '회의록-최종.txt' } });
  assert.deepEqual(r.summary.questions, ['이름을 바꾸겠습니까?']);
  assert.equal((await s.broker.execute(r.id)).ok, true);
  assert.ok(fs.existsSync(path.join(s.down, '회의록-최종.txt')));
  const bad: any = s.broker.prepare({ action: 'file.rename', args: { target: '회의록-최종.txt', name: 'setup.exe' } });
  assert.equal(bad.status, 'error');
  assert.equal(bad.code, 'conflict');
  const slash: any = s.broker.prepare({ action: 'file.rename', args: { target: '회의록-최종.txt', name: '../x.txt' } });
  assert.equal(slash.status, 'error');
});

test('폴더 만들기: 확인 없이, 같은 이름이면 거부', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.mkdir', args: { dest: '문서', name: '2027' } });
  assert.equal(r.needsConfirm, false);
  assert.equal((await s.broker.execute(r.id)).ok, true);
  assert.ok(fs.statSync(path.join(s.docs, '2027')).isDirectory());
  assert.equal((s.broker.prepare({ action: 'file.mkdir', args: { dest: '문서', name: '2027' } }) as any).code, 'conflict');
});

test('빈 파일 만들기: 확인 없이, 확장자 없음과 .txt만, 같은 이름이면 거부', async () => {
  const s = sandbox();
  for (const name of ['메모', '메모.txt']) {
    const r: any = s.broker.prepare({ action: 'file.create', args: { dest: '문서', name } });
    assert.equal(r.needsConfirm, false);
    assert.equal((await s.broker.execute(r.id)).ok, true);
    assert.equal(fs.readFileSync(path.join(s.docs, name), 'utf8'), '');
  }
  assert.equal((s.broker.prepare({ action: 'file.create', args: { dest: '문서', name: '메모' } }) as any).code, 'conflict');
  assert.equal((s.broker.prepare({ action: 'file.create', args: { dest: '문서', name: '메모.md' } }) as any).code, 'bad_args');
  assert.equal((s.broker.prepare({ action: 'file.create', args: { dest: '문서', name: '../밖.txt' } }) as any).status, 'error');
  assert.equal((s.broker.prepare({ action: 'file.create', args: { dest: '없는폴더', name: '메모' } }) as any).code, 'not_found');
  const sub: any = s.broker.prepare({ action: 'file.create', args: { dest: '문서/2026', name: '안쪽' } });
  assert.equal((await s.broker.execute(sub.id)).ok, true);
  assert.ok(fs.existsSync(path.join(s.docs, '2026', '안쪽')));
});

test('범위: 맨 앞 말이 허용 폴더 이름이면 그 폴더에서만 찾는다', () => {
  const s = sandbox();
  // 보고서.pdf는 두 폴더에 있어 그냥 찾으면 고르게 한다
  assert.equal((s.broker.prepare({ action: 'file.open', args: { target: '보고서.pdf' } }) as any).status, 'choice');
  const spaced: any = s.broker.prepare({ action: 'file.open', args: { target: '다운로드 보고서.pdf' } });
  assert.equal(spaced.status, 'ready');
  assert.equal(spaced.summary.fromPath, path.join(s.down, '보고서.pdf'));
  const slashed: any = s.broker.prepare({ action: 'file.open', args: { target: '문서/보고서.pdf' } });
  assert.equal(slashed.status, 'error');
  const exactPath: any = s.broker.prepare({ action: 'file.open', args: { target: '문서/2026/보고서.pdf' } });
  assert.equal(exactPath.summary.fromPath, path.join(s.docs, '2026', '보고서.pdf'));
  // 하위 경로는 그대로
  assert.equal((s.broker.prepare({ action: 'file.open', args: { target: '2026/보고서.pdf' } }) as any).summary.fromPath, path.join(s.docs, '2026', '보고서.pdf'));
  // 그 폴더에 없으면 다른 폴더로 넘어가지 않는다
  assert.equal((s.broker.prepare({ action: 'file.open', args: { target: '문서 회의록.txt' } }) as any).code, 'not_found');
  // 전체 이름의 파일이 먼저
  fs.writeFileSync(path.join(s.down, '문서 초안.txt'), 'x');
  assert.equal((s.broker.prepare({ action: 'file.open', args: { target: '문서 초안.txt' } }) as any).summary.fromPath, path.join(s.down, '문서 초안.txt'));
  // 찾기도 같다
  const found: any = s.broker.prepare({ action: 'file.search', args: { query: '다운로드 보고서' } });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].path, path.join(s.down, '보고서.pdf'));
});

test('목록: 폴더 먼저, 숨김·링크·_to_delete는 빼고 보여 준다', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.down, '_to_delete'));
  const r: any = s.broker.prepare({ action: 'file.list', args: { dest: '다운로드' } });
  assert.equal(r.status, 'result');
  assert.equal(r.list, true);
  const names = r.items.map((x: any) => path.basename(x.path));
  assert.ok(names.includes('보고서.pdf'));
  for (const hidden of ['.git', 'escape', '_to_delete']) assert.ok(!names.includes(hidden), hidden);
  fs.mkdirSync(path.join(s.docs, '빈폴더'));
  assert.equal((s.broker.prepare({ action: 'file.list', args: { dest: '문서/빈폴더' } }) as any).items.length, 0);
  assert.equal((s.broker.prepare({ action: 'file.list', args: { dest: '없는폴더' } }) as any).code, 'not_found');
});

test('위치 없는 목록은 허용 폴더 자체만 반환하고 AI 이름 비교를 부르지 않는다', async () => {
  const s = sandbox();
  const broker = new ToolBroker({ getRoots: () => s.roots, shell: { openPath: async () => '', showItemInFolder: () => {} }, getNameMatcher: () => { throw Error('허용 폴더 목록에 AI를 부르면 안 됩니다'); } });
  const result = await broker.prepareAsync({ action: 'file.list', args: {} });
  assert.equal(result.status, 'result');
  if (result.status !== 'result') throw Error('목록 결과 필요');
  assert.equal(result.rootList, true);
  assert.equal(resultHead(result), '허용 폴더 목록 2개');
  assert.deepEqual(result.items.map(item => item.path), s.roots.map(root => root.real));
  assert.ok(result.items.every(item => item.isDir && item.display.includes(item.path)));
  assert.ok(!result.items.some(item => item.display.includes('보고서.pdf')));
  const empty = new ToolBroker({ getRoots: () => [], shell: { openPath: async () => '', showItemInFolder: () => {} } });
  const none = empty.prepare({ action: 'file.list' });
  assert.equal(none.status, 'result');
  if (none.status === 'result') assert.equal(resultHead(none), '허용 폴더가 없습니다.');
});

test('백업: 같은 폴더의 backup 폴더에 날짜를 붙여 복사, 또 하면 번호', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.backup', args: { target: '보고서.pdf', root: 'downloads' } });
  assert.deepEqual(r.summary.questions, ['백업하겠습니까?']);
  assert.equal(r.summary.to, `다운로드/backup/보고서 ${dateStr()}.pdf`);
  assert.equal((await s.broker.execute(r.id)).ok, true);
  assert.equal(fs.readFileSync(path.join(s.down, 'backup', `보고서 ${dateStr()}.pdf`), 'utf8'), 'report');
  assert.ok(fs.existsSync(path.join(s.down, '보고서.pdf'))); // 원본 그대로
  const r2: any = s.broker.prepare({ action: 'file.backup', args: { target: '보고서.pdf', root: 'downloads' } });
  assert.equal(r2.summary.to, `다운로드/backup/보고서 ${dateStr()} (2).pdf`);
});

test('보내기는 메신저 요청에서만, 폴더는 안 된다', () => {
  const s = sandbox();
  assert.equal((s.broker.prepare({ action: 'file.send', args: { target: '회의록.txt' } }) as any).code, 'remote_only');
  const r: any = s.broker.prepare({ action: 'file.send', args: { target: '회의록.txt' }, source: { kind: 'remote', id: 'm1' } });
  assert.equal(r.status, 'ready');
  assert.equal(r.needsConfirm, false);
  const taken = s.broker.take(r.id);
  assert.ok(taken);
  assert.equal(s.broker.take(r.id), null); // 한 번만
  assert.equal((s.broker.prepare({ action: 'file.send', args: { target: s.docs }, source: { kind: 'remote' } }) as any).status, 'error');
});

test('취소하면 기록이 남고 실행되지 않는다', async () => {
  const s = sandbox();
  const r: any = s.broker.prepare({ action: 'file.move', args: { target: '회의록.txt', dest: 'documents' } });
  assert.equal(s.broker.cancel(r.id), true);
  assert.equal(s.logs.at(-1)!.status, 'rejected');
  assert.equal((await s.broker.execute(r.id)).status, 'expired');
});
