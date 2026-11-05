// 로컬 컨트롤: 인증 앱 코드(TOTP), 원격 상태(잠금·중지·복구), 보낸 파일 기록, _to_delete 비우기, 메신저 규칙(hub)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/main/totp';
import { createRemoteState } from '../src/main/remote/state';
import { createSentStore } from '../src/main/remote/sent';
import { allowedRootDir, emptyTrash, receivedDir } from '../src/main/files';
import { RemoteHub, type Transport } from '../src/main/remote/hub';
import { ToolBroker } from '../src/main/tools/broker';
import * as policy from '../src/main/tools/policy';
import { tmpBase } from './tmp-base';
import { normalize } from '../src/main/settings';
import { dateStr, formatMinutes, isReceivedExecutable, normalizeDays, normalizeRemote, normalizeUnlockMinutes, uniqueName } from '../src/shared/local-files';
import type { RemoteEvent } from '../src/shared/types';

const tmp = (p: string) => fs.mkdtempSync(path.join(tmpBase(), p));
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (x: string) => Buffer.from('enc:' + x), decryptString: (b: Buffer) => b.toString().slice(4) };

describe('인증 앱 코드 (TOTP)', () => {
  // RFC 6238 시험 값: 비밀 "12345678901234567890", 59초 → 94287082 (끝 6자리)
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('RFC 시험 값과 같다', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totp(secret, 59_000)).toBe('287082');
    expect(hotp(secret, 1)).toBe('287082');
    expect(totp(secret, 1111111109_000)).toBe('081804');
  });
  it('앞뒤 30초까지 받고, 한 번 쓴 칸은 다시 못 쓴다', () => {
    const now = 1_000_000_000_000;
    const c = totp(secret, now);
    const step = verifyTotp(secret, c, { now: now + 30_000 });
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, c, { now: now + 90_000 })).toBeNull();
    expect(verifyTotp(secret, c, { now, afterStep: step! })).toBeNull();
    expect(verifyTotp(secret, '12345', { now })).toBeNull();
  });
});

describe('원격 상태', () => {
  it('키를 만들고, 코드로 잠금을 풀고, 잠그고, 중지하고, 복구 코드는 한 번만', () => {
    let clock = 1_000_000_000_000;
    const file = path.join(tmp('rs-'), 'remote-state.json');
    const st = createRemoteState(file, fakeSafe, { now: () => clock });
    expect(st.hasKey()).toBe(false);
    const k = st.newKey('mac');
    expect(k.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(k.recovery.length).toBe(8);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(k.secret); // 암호화해서 저장
    expect(st.isUnlocked()).toBe(false);
    expect(st.unlockWithCode('000000', 30)).toBe(totp(k.secret, clock) === '000000');
    const code = totp(k.secret, clock);
    expect(st.check(code)).toBe(true);
    expect(st.unlockWithCode(code, 30)).toBe(true);
    expect(st.unlockWithCode(code, 30)).toBe(false); // 같은 코드 다시 안 됨
    expect(st.isUnlocked()).toBe(true);
    clock += 31 * 60_000;
    expect(st.isUnlocked()).toBe(false); // 30분 지남
    expect(st.unlockWithRecovery(k.recovery[0].toLowerCase(), 60)).toBe(true);
    expect(st.unlockWithRecovery(k.recovery[0], 60)).toBe(false);
    expect(st.recoveryLeft()).toBe(7);
    st.setStopped(true);
    expect(st.isUnlocked()).toBe(false);
    // 다시 읽어도 같다
    const again = createRemoteState(file, fakeSafe, { now: () => clock });
    expect(again.isStopped()).toBe(true);
    expect(again.hasKey()).toBe(true);
    // 키를 새로 만들면 예전 코드는 안 된다
    const k2 = again.newKey('mac');
    expect(k2.secret).not.toBe(k.secret);
    expect(again.check(totp(k.secret, clock)) && totp(k.secret, clock) !== totp(k2.secret, clock)).toBe(false);
  });
});

describe('설정 값', () => {
  it('기간과 원격 설정은 범위 안으로', () => {
    expect(normalizeDays(0)).toBe(1);
    expect(normalizeDays(999)).toBe(365);
    expect(normalizeDays('x')).toBe(30);
    expect(normalizeUnlockMinutes(1)).toBe(10);
    expect(normalizeUnlockMinutes(10 ** 9)).toBe(90 * 1440);
    expect(normalizeUnlockMinutes(undefined)).toBe(30 * 1440);
    expect(formatMinutes(30 * 1440)).toBe('30일');
    expect(formatMinutes(90)).toBe('1시간 30분');
    const r = normalizeRemote({ enabled: true, discord: { apiKey: ' t ', userId: 'id: 123' } });
    expect(r.discord).toEqual({ apiKey: 't', userId: '123' });
    const s = normalize(null);
    expect(s.files).toEqual({ trashMode: 'manual', trashDays: 30, receivedDir: '' });
    expect(s.remote.enabled).toBe(false);
  });
  it('같은 이름: 날짜, 그래도 겹치면 번호. 받은 파일의 실행 파일은 맨 끝 확장자로', () => {
    const have = new Set(['a.pdf', 'a 2026-10-21.pdf']);
    expect(uniqueName('b.pdf', (n) => have.has(n), { stamp: '2026-10-21' })).toBe('b.pdf');
    expect(uniqueName('a.pdf', (n) => have.has(n), { stamp: '2026-10-21' })).toBe('a 2026-10-21 (2).pdf');
    expect(uniqueName('dir', () => false, { stamp: '2026-10-21', always: true, isDir: true })).toBe('dir 2026-10-21');
    expect(isReceivedExecutable('사진.jpg.exe')).toBe(true);
    expect(isReceivedExecutable('run.SH')).toBe(true);
    expect(isReceivedExecutable('보고서.pdf')).toBe(false);
    expect(isReceivedExecutable('exe')).toBe(false);
  });
  it('받은 파일 폴더: 비었으면 다운로드/AI비서 받은 파일', () => {
    expect(receivedDir({ receivedDir: '' }, '/Users/me/Downloads')).toEqual({ path: path.join('/Users/me/Downloads', 'AI비서 받은 파일'), isDefault: true, defaultPath: path.join('/Users/me/Downloads', 'AI비서 받은 파일') });
    expect(receivedDir({ receivedDir: '/x/y' }, '/d').isDefault).toBe(false);
  });
});

describe('허용 폴더 열기', () => {
  it('저장된 실제 폴더만 돌려준다', () => {
    const root = tmp('open-');
    expect(allowedRootDir(root, [{ path: root }])).toBe(root);
  });
  it('목록에 없거나 글자가 아니면 거절한다', () => {
    const root = tmp('open-');
    expect(() => allowedRootDir(root, [])).toThrow('저장한 뒤에');
    expect(() => allowedRootDir(123, [{ path: root }])).toThrow('저장한 뒤에');
  });
  it('없는 폴더는 만들지 않고 거절한다', () => {
    const gone = path.join(tmp('open-'), '없는 폴더');
    expect(() => allowedRootDir(gone, [{ path: gone }])).toThrow('찾을 수 없습니다');
    expect(fs.existsSync(gone)).toBe(false);
  });
  it('파일 경로는 거절한다', () => {
    const file = path.join(tmp('open-'), 'a.txt');
    fs.writeFileSync(file, '');
    expect(() => allowedRootDir(file, [{ path: file }])).toThrow('찾을 수 없습니다');
  });
});

describe('삭제한 파일 비우기', () => {
  it('기간이 지난 날짜 폴더만 지운다 (다른 이름은 그대로)', () => {
    const root = tmp('tr-');
    const t = path.join(root, '_to_delete');
    const now = new Date(2026, 9, 21, 12).getTime();
    for (const d of ['2026-09-20', '2026-09-21', '2026-09-22', 'memo']) fs.mkdirSync(path.join(t, d), { recursive: true });
    const roots = policy.validateRoots([{ id: 'r', label: 'r', path: root }], { home: '/nonexistent-home', env: {} }).roots;
    expect(emptyTrash(roots, 30, now)).toBe(2); // 30일 전(9-21)과 그 전
    expect(fs.readdirSync(t).sort()).toEqual(['2026-09-22', 'memo']);
  });
});

describe('보낸 파일 기록', () => {
  it('글 기록(이름·크기·경로)과 지울 목록', () => {
    const dir = tmp('sent-');
    const s = createSentStore(dir);
    s.add({ messenger: 'discord', channelId: 'c', messageId: 'm1', sentAt: 1000, name: 'a.pdf' }, { size: 2048, from: '/x/a.pdf' });
    s.add({ messenger: 'discord', channelId: 'c', messageId: 'm2', sentAt: 1000 + 40 * 86_400_000, name: 'b.pdf' }, { size: 1, from: '/x/b.pdf' });
    const log = fs.readFileSync(s.logFile, 'utf8');
    expect(log).toContain('a.pdf');
    expect(log).toContain('/x/a.pdf');
    expect(log).toContain('2.0KB');
    expect(s.due(30, 1000 + 40 * 86_400_000).map((r) => r.messageId)).toEqual(['m1']);
    s.remove(['m1']);
    expect(createSentStore(dir).count()).toBe(1);
  });
});

/* ---------------- 메신저 규칙 ---------------- */

function hubSandbox(requireAuthentication = false) {
  const base = tmp('hub-');
  const docs = path.join(base, 'docs');
  const recv = path.join(base, 'recv');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, '보고서.pdf'), 'report');
  fs.writeFileSync(path.join(docs, '메모.txt'), 'memo');
  const roots = () => policy.validateRoots([{ id: 'docs', label: '문서', path: docs }, { id: 'received', label: '받은 파일', path: recv }], { home: '/nonexistent-home', env: {} }).roots;
  fs.mkdirSync(recv);
  let clock = 1_000_000_000_000;
  const broker = new ToolBroker({ getRoots: roots, shell: { openPath: async () => '', showItemInFolder: () => {} }, now: () => clock });
  const state = createRemoteState(path.join(base, 'rs.json'), fakeSafe, { now: () => clock });
  const sent = createSentStore(path.join(base, 'logs'));
  const settings = normalize({ remote: { enabled: true, discord: { apiKey: 't', userId: '42' }, unlockMinutes: 60 } });
  const events: RemoteEvent[] = [];
  const out: string[] = [];
  const answers: ('yes' | 'no' | 'timeout')[] = [];
  const asked: string[] = [];
  const files: string[] = [];
  const deleted: string[] = [];
  const t: Transport = {
    send: async (x) => void out.push(x),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() || 'timeout';
    },
    choose: async () => 0,
    sendFile: async (p) => {
      files.push(p);
      return { channelId: 'c', messageId: `m${files.length}` };
    },
    deleteMessage: async (_c, m) => void deleted.push(m)
  };
  const chat = vi.fn(async (x: string) => `답: ${x}`);
  const hub = new RemoteHub({
    requireAuthentication,
    broker,
    state,
    sent,
    getSettings: () => settings,
    getRoots: roots,
    getReceivedDir: () => recv,
    emit: (e) => events.push(e),
    chat,
    fetchFile: async () => Buffer.from('downloaded'),
    now: () => clock
  });
  hub.transport = t;
  const msg = (text: string, authorId = '42', fs_: any[] = []) => hub.onMessage({ id: String(Math.random()), authorId, text, files: fs_ });
  return { base, docs, recv, hub, state, sent, out, events, answers, asked, files, deleted, msg, tick: (ms: number) => (clock += ms), now: () => clock, settings, broker, chat, t };
}

describe('앱 직접 연결의 선행 인증', () => {
  it('인증 전 대화·찾기·목록·첨부·직접 실행을 모두 막고 방법부터 안내한다', async () => {
    const s = hubSandbox(true);
    const prepare = vi.spyOn(s.broker, 'prepareAsync');
    for (const text of ['안녕', '파일 찾기 메모', '파일 목록 문서', '파일 문서에 새 파일 만들어']) {
      await s.msg(text);
      expect(s.out.at(-1)).toMatch(/^먼저 인증해 주세요/);
      expect(s.out.at(-1)).toContain('Microsoft Authenticator');
    }
    await s.msg('', '42', [{ id: 'f', name: 'a.txt', size: 1, url: 'u' }]);
    expect(s.hub.hasFile('f')).toBe(false);
    expect(s.events.some(e => e.type === 'received')).toBe(false);
    expect((await s.hub.runAction('file.search', { query: '메모' }, { kind: 'server', id: 's' })).status).toBe('rejected');
    expect(s.chat).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect((await s.hub.download('f')).ok).toBe(false);
    await s.msg('안녕', 'stranger');
    expect(s.out).toHaveLength(6);
  });

  it('인증·도움말은 키 없이도 AI 호출 없이 처리하며 중지 상태에서도 안내한다', async () => {
    const s = hubSandbox(true);
    for (const text of ['인증', '인증 도움말', '!인증', '!파일 인증', '인증 이상한코드']) {
      await s.msg(text);
      expect(s.out.at(-1)).toMatch(/^인증 방법/);
    }
    await s.msg('원격 중지');
    await s.msg('인증 도움말');
    expect(s.out.at(-1)).toContain('인증 폐기 / 잠금');
    await s.msg('도움말');
    expect(s.out.at(-1)).toContain('앱 직접 연결은');
    expect(s.chat).not.toHaveBeenCalled();
  });

  it('인증 후 대화·찾기·목록·첨부가 되고 시간이 끝나면 다시 안내한다', async () => {
    const s = hubSandbox(true), k = s.state.newKey('pc');
    await s.msg(`인증 ${totp(k.secret, s.now())}`);
    await s.msg('안녕');
    expect(s.out.at(-1)).toBe('답: 안녕');
    await s.msg('파일 찾기 메모');
    expect(s.out.at(-1)).toContain('찾기 결과 1개');
    await s.msg('파일 목록 문서');
    expect(s.out.at(-1)).toContain('메모.txt');
    await s.msg('', '42', [{ id: 'f', name: 'a.txt', size: 1, url: 'u' }]);
    expect(s.hub.hasFile('f')).toBe(true);
    expect((await s.hub.download('f')).ok).toBe(true);
    s.tick(60 * 60_000 + 1);
    await s.msg('안녕');
    expect(s.out.at(-1)).toMatch(/^먼저 인증해 주세요/);
    expect((await s.hub.download('f')).ok).toBe(false);
  });

  it('폐기·잠금·연결 해제는 키/복구 코드를 보존하고 예전 요청을 재인증 뒤 실행하지 않는다', async () => {
    const s = hubSandbox(true), k = s.state.newKey('pc');
    for (const text of ['인증 폐기', '잠금', '!파일 인증 폐기']) {
      await s.msg(`인증 ${totp(k.secret, s.now())}`);
      await s.msg(text);
      expect(s.state.isUnlocked()).toBe(false);
      expect(s.state.hasKey()).toBe(true);
      expect(s.state.recoveryLeft()).toBe(8);
      s.tick(30_000);
    }
    await s.msg('파일 보내기 메모.txt');
    await s.msg(`인증 ${totp(k.secret, s.now())}`);
    expect(s.files).toEqual([]);
    s.hub.resetAuthentication();
    expect(s.state.isUnlocked()).toBe(false);
    s.tick(30_000);
    await s.msg(`인증 ${totp(k.secret, s.now())}`);
    expect(s.state.isUnlocked()).toBe(true);
    await s.msg('파일 보내기 메모.txt');
    expect(s.files).toHaveLength(1);
  });

  it('확인 대기 중 폐기는 즉시 잠그고 복사를 실행하지 않는다', async () => {
    const s = hubSandbox(true), k = s.state.newKey('pc');
    await s.msg(`인증 ${totp(k.secret, s.now())}`);
    let finish: (answer: 'yes' | 'no' | 'timeout') => void = () => {};
    s.t.ask = async () => new Promise(resolve => { finish = resolve; });
    s.t.cancelWaiting = () => finish('timeout');
    const ask = vi.spyOn(s.t, 'ask');
    const pending = s.msg('파일 백업 메모.txt');
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    await s.msg('인증 폐기');
    await pending;
    expect(s.state.isUnlocked()).toBe(false);
    expect(fs.existsSync(path.join(s.docs, 'backup'))).toBe(false);
  });

  it('다른 연결에서 잠근 뒤 재인증해도 예전 준비 요청은 실행하지 않는다', async () => {
    const s = hubSandbox(true), k = s.state.newKey('pc');
    await s.msg(`인증 ${totp(k.secret, s.now())}`);
    const original = s.broker.prepareAsync.bind(s.broker);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(s.broker, 'prepareAsync').mockImplementation(async req => { await gate; return original(req); });
    const execute = vi.spyOn(s.broker, 'execute');
    const pending = s.hub.runAction('file.create', { dest: '문서', name: '막힘.txt' }, { kind: 'server', id: 's' });
    s.state.lock();
    s.tick(30_000);
    s.state.unlockWithCode(totp(k.secret, s.now()), 60);
    release();
    expect((await pending).status).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(s.docs, '막힘.txt'))).toBe(false);
  });
});

describe('메신저 규칙 (hub)', () => {
  it('내 계정이 아니면 무시하고, 대화는 앱의 답을 돌려준다', async () => {
    const s = hubSandbox();
    await s.msg('안녕', 'stranger');
    expect(s.out).toEqual([]);
    await s.msg('안녕');
    expect(s.out).toEqual(['답: 안녕']);
  });

  it('인증 전: 이름 찾기는 되고, 나머지는 잠겨 있다. 인증하면 멈춘 요청을 이어서 한다', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    await s.msg('파일 찾기 보고서');
    expect(s.out.at(-1)).toMatch(/찾기 결과 1개/);
    await s.msg('파일 보내기 보고서.pdf');
    expect(s.out.at(-1)).toMatch(/잠겨 있습니다/);
    expect(s.files).toEqual([]);
    await s.msg(`인증 ${totp(k.secret, s.now())}`);
    expect(s.out.some((x) => /인증했습니다. 1시간/.test(x))).toBe(true);
    expect(s.files.length).toBe(1); // 보내기는 확인 없이 바로
    expect(s.sent.count()).toBe(1);
    expect(fs.readFileSync(s.sent.logFile, 'utf8')).toContain('보고서.pdf');
  });

  it('인증 뒤: 이동은 확인 한 번, 삭제는 두 번 (아니오면 취소)', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    await s.msg(totp(k.secret, s.now()));
    s.answers.push('yes', 'no');
    await s.msg('파일 삭제 메모.txt');
    expect(s.asked).toEqual(['삭제하겠습니까?', '정말로 삭제하겠습니까?']);
    expect(fs.existsSync(path.join(s.docs, '메모.txt'))).toBe(true);
    expect(s.out.at(-1)).toBe('취소했습니다.');
    s.asked.length = 0;
    s.answers.push('yes', 'yes');
    await s.msg('파일 삭제 메모.txt');
    expect(s.out.at(-1)).toBe('삭제했습니다.');
    expect(fs.existsSync(path.join(s.docs, '_to_delete', dateStr(), '메모.txt'))).toBe(true); // 날짜는 이 컴퓨터의 오늘
    s.asked.length = 0;
    s.answers.push('yes');
    await s.msg('파일 백업 보고서.pdf');
    expect(s.asked).toEqual(['백업하겠습니까?']);
    expect(fs.readdirSync(path.join(s.docs, 'backup')).length).toBe(1);
    // 대화창에도 같은 기록 (출처 디스코드)
    expect(s.events.some((e) => e.type === 'line' && e.text === '삭제했습니다.' && e.source === '디스코드')).toBe(true);
  });

  it('허용 폴더 밖은 인증해도 안 된다', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    await s.msg(totp(k.secret, s.now()));
    await s.msg(`파일 보내기 ${path.join(s.base, 'rs.json')}`);
    expect(s.out.at(-1)).toMatch(/허용 폴더 밖/);
    expect(s.files).toEqual([]);
  });

  it('잠금·원격 중지: 중지되면 코드 말고는 거부, 코드로 다시 켠다', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    await s.msg(totp(k.secret, s.now()));
    await s.msg('잠금');
    expect(s.state.isUnlocked()).toBe(false);
    await s.msg('원격 중지');
    await s.msg('안녕');
    expect(s.out.at(-1)).toMatch(/원격 중지 상태/);
    s.tick(60_000);
    await s.msg(totp(k.secret, s.now()));
    expect(s.state.isStopped()).toBe(false);
    expect(s.state.isUnlocked()).toBe(true);
  });

  it('요청이 너무 많으면 원격 중지', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    await s.msg(totp(k.secret, s.now()));
    for (let i = 0; i < 31; i++) await s.msg('파일 열기 보고서.pdf');
    expect(s.state.isStopped()).toBe(true);
    expect(s.out.some((x) => /너무 많아 원격 중지/.test(x))).toBe(true);
  });

  it('받은 파일: 바로 저장하지 않고, 다운로드를 누르면 받은 파일 폴더에 (같은 이름이면 날짜)', async () => {
    const s = hubSandbox();
    await s.msg('', '42', [{ id: 'f1', name: 'run.sh', size: 10, url: 'u' }, { id: 'f2', name: '사진.jpg', size: 20, url: 'u' }]);
    expect(fs.readdirSync(s.recv)).toEqual([]);
    const recv = s.events.filter((e) => e.type === 'received') as Extract<RemoteEvent, { type: 'received' }>[];
    expect(recv.map((e) => [e.name, e.executable])).toEqual([
      ['run.sh', true],
      ['사진.jpg', false]
    ]);
    const d1 = await s.hub.download('f2');
    expect(d1.ok).toBe(true);
    expect(d1.display).toBe('받은 파일/사진.jpg');
    const d2 = await s.hub.download('f2');
    expect(path.basename(d2.path)).toBe(`사진 ${dateStr()}.jpg`);
    const d3 = await s.hub.download('f1');
    expect(d3.executable).toBe(true);
    expect((await s.hub.download('nope')).ok).toBe(false);
  });

  it('보낸 파일 자동 삭제: 기간이 지난 것만, 모두 지우기는 날짜와 상관없이', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    await s.msg(totp(k.secret, s.now()));
    await s.msg('파일 보내기 보고서.pdf');
    s.tick(10 * 86_400_000);
    await s.msg(totp(k.secret, s.now())); // 1시간이 지나 잠겼으므로 다시 인증
    await s.msg('파일 보내기 메모.txt');
    s.tick(21 * 86_400_000); // 첫 파일은 31일, 둘째는 21일
    expect(await s.hub.deleteSent()).toEqual({ deleted: 1, failed: 0 });
    expect(s.deleted).toEqual(['m1']);
    expect(await s.hub.deleteSent({ all: true })).toEqual({ deleted: 1, failed: 0 });
    expect(s.sent.count()).toBe(0);
  });
});

describe('코드 맞히기 막기', () => {
  it('틀린 코드가 10분에 5번 넘으면 원격 중지되고, 메신저 코드로는 못 켠다 (앱에서만)', async () => {
    const s = hubSandbox();
    const k = s.state.newKey('pc');
    const good = totp(k.secret, s.now());
    const bad = good === '111111' ? '222222' : '111111';
    for (let i = 0; i < 6; i++) await s.msg(`인증 ${bad}`);
    expect(s.state.isStopped()).toBe(true);
    expect(s.out.some((x) => /여러 번 틀려 원격 중지/.test(x))).toBe(true);
    await s.msg(`인증 ${good}`);
    expect(s.state.isStopped()).toBe(true);
    expect(s.state.isUnlocked()).toBe(false);
  });
});
