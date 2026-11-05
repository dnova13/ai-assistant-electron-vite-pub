// 비서 봇 말 처리: 답 대기, 원격 허용 폴더, 출처 기록 (실제 파일, 네트워크 없음)
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { serverFileChat } from '../src/main/remote/file-chat';
import type { ActionArgs, ActionReport, ChatEvent } from '../src/shared/types';
import { RemoteHub, newHubCounters } from '../src/main/remote/hub';
import { ServerTransport, fetchDiscordFile, handleServerMessage, isDiscordFileUrl } from '../src/main/remote/server-hub';
import { createRemoteState } from '../src/main/remote/state';
import { createSentStore } from '../src/main/remote/sent';
import { ToolBroker } from '../src/main/tools/broker';
import { totp } from '../src/main/totp';
import * as policy from '../src/main/tools/policy';
import { tmpBase } from './tmp-base';
import { rootsToSave } from '../src/shared/local-files';

function setup({ allowDocs = true, unlocked = true, natural = false, action = 'file.create', args = { dest: '문서', name: '메모.txt' } as ActionArgs, modelError = false, rootCount = 1, prepareRequest = undefined as (() => Promise<string | void>) | undefined } = {}) {
  const base = fs.mkdtempSync(path.join(tmpBase(), 'srvhub-'));
  const docs = path.join(base, 'docs');
  const other = path.join(base, 'other');
  fs.mkdirSync(docs);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(docs, 'a.txt'), 'a');
  fs.writeFileSync(path.join(other, 'secret.txt'), 's');
  const extraRoots = Array.from({ length: rootCount - 1 }, (_, i) => {
    const folder = path.join(base, `extra-${i + 1}`); fs.mkdirSync(folder);
    return { id: `e${i}`, label: `추가 ${i + 1}`, path: folder, remote: true };
  });
  const all = () => policy.validateRoots([
    { id: 'd', label: '문서', path: docs, remote: allowDocs },
    { id: 'o', label: '기타', path: other }, ...extraRoots
  ]).roots;
  const remote = () => all().filter((r) => r.remote);
  const logs: Record<string, unknown>[] = [];
  const shell = { openPath: async () => '', showItemInFolder: () => {}, trashItem: async () => {} };
  const broker = new ToolBroker({ getRoots: all, getRemoteRoots: remote, shell: shell as never, audit: { file: '', log: (e: Record<string, unknown>) => logs.push(e) } as never });
  const state = createRemoteState(path.join(base, 'state.json'), null);
  const key = state.newKey('t');
  if (unlocked) state.unlockWithCode(totp(key.secret), 60);
  const sent: Record<string, unknown>[] = [];
  const uploads: { turn: string; name: string; note: string; bytes: number }[] = [];
  const t = new ServerTransport(
    (m) => sent.push(m),
    async (turn, filePath, name, note) => void uploads.push({ turn, name, note, bytes: fs.statSync(filePath).size })
  );
  const events: { type: string; fileId?: string }[] = [];
  const chat = vi.fn(async (_profile, _req, onEvent: (ev: ChatEvent) => void) => {
    onEvent({ type: 'client_action', id: 'fake-action', action, args, say: '' });
    if (modelError) onEvent({ type: 'error', code: 'test', message: '해석 실패' });
    onEvent({ type: 'done', text: '파일을 만들게요.' });
  });
  const report = vi.fn(async (_profile: unknown, _id: string, _result: ActionReport) => {});
  const hub: RemoteHub = new RemoteHub({
    prepareRequest,
    broker,
    state,
    sent: createSentStore(path.join(base, 'logs')),
    getSettings: () => ({ remote: { discord: { userId: 'nobody' }, unlockMinutes: 60, sentDeleteDays: 7 } }) as never,
    getRoots: remote,
    getReceivedDir: () => path.join(base, 'recv'),
    emit: (e) => events.push(e as never),
    chat: async (text, context) => natural ? serverFileChat(text, {
      profile: { type: 'assistant', baseUrl: 'https://unit.invalid/v1', apiKey: '' },
      chat, runAction: (id, act, a) => hub.runAction(act, a, { kind: 'server', id, channel: context?.channel }), reportAction: report
    }) : '파일 명령만 받습니다.',
    checkAuthor: false,
    via: '비서 봇'
  });
  hub.transport = t;
  const say = async (type: string, id: string, text: string, channel = false) => {
    handleServerMessage(t, { type, id, text, channel }, (m) => hub.onMessage(m));
    for (let i = 0; i < 40 && !sent.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 5));
    return sent.find((m) => m.id === id) as { text: string; waiting: boolean };
  };
  return { base, docs, other, say, sent, logs, t, uploads, events, hub, chat, report, state, key };
}

describe('원격 허용 저장', () => {
  it('저장 값에 체크가 남고, 없으면 꺼짐', () => {
    expect(rootsToSave([{ id: 'a', label: 'A', path: '/a', remote: true }, { id: 'b', label: 'B', path: '/b' }])).toEqual([
      { id: 'a', label: 'A', path: '/a', remote: true },
      { id: 'b', label: 'B', path: '/b', remote: false }
    ]);
  });
});

describe('비서 봇 말 처리', () => {
  it('미인증 채널은 검색·목록·자연어를 실행하지 않고 DM 인증 방법을 안내한다', async () => {
    const s = setup({ unlocked: false, natural: true });
    const prepare = vi.spyOn(ToolBroker.prototype, 'prepareAsync');
    const before = prepare.mock.calls.length;
    for (const [i, text] of ['!파일 찾기 a', '파일 목록', '파일 문서에 메모 만들어줘'].entries()) {
      const reply = await s.say('command', 'locked-channel-' + i, text, true);
      expect(reply.text).toContain('먼저 인증해 주세요');
      expect(reply.text).toContain('봇 DM에서만');
      expect(reply.text).toContain('Microsoft Authenticator');
      expect(reply.waiting).toBe(false);
    }
    expect(prepare.mock.calls.length).toBe(before);
    expect(s.chat).not.toHaveBeenCalled();
    expect((await s.say('command', 'dm-auth', '인증 ' + totp(s.key.secret))).text).toContain('인증했습니다');
    expect((await s.say('command', 'unlocked-channel', '!파일 찾기 a', true)).text).toContain('a.txt');
    expect((await s.say('command', 'dm-lock', '인증 폐기')).text).toContain('현재 인증을 종료');
    expect((await s.say('command', 'relocked-channel', '!파일 찾기 a', true)).text).toContain('봇 DM에서만');
    expect((await s.say('command', 'dm-search', '!파일 찾기 a')).text).toContain('a.txt');
    prepare.mockRestore();
  });

  it('인증된 채널의 자연어도 실행 시 인증을 다시 검사한다', async () => {
    const s = setup({ natural: true, action: 'file.search', args: { query: 'a' } });
    s.chat.mockImplementationOnce(async (_profile, _req, onEvent) => {
      s.state.lock();
      onEvent({ type: 'client_action', id: 'expired', action: 'file.search', args: { query: 'a' }, say: '' });
      onEvent({ type: 'done', text: '찾을게요' });
    });
    expect((await s.say('command', 'expired-channel', '파일 a 찾아줘', true)).text).toContain('봇 DM에서만');
    expect(s.report.mock.calls[0][2]).toMatchObject({ status: 'rejected', detail: '인증 필요' });
  });

  it('계정 검사 없이 받고, 결과를 답으로 보낸다', async () => {
    const { say } = setup();
    const r = await say('command', 't1', '!파일 찾기 a');
    expect(r.waiting).toBe(false);
    expect(r.text).toContain('a.txt');
  });

  it('위치 없는 목록은 원격 허용 폴더만 반환한다', async () => {
    const { say, docs, other } = setup();
    for (const [i, prefix] of ['파일', '!파일'].entries()) {
      const result = await say('command', 'roots-' + i, prefix + ' 목록');
      expect(result.text).toContain('허용 폴더 목록 1개');
      expect(result.text).toContain(docs);
      expect(result.text).not.toContain(other);
      expect(result.text).not.toContain('a.txt');
    }
  });

  it('허용 폴더가 20개를 넘어도 목록을 전부 보낸다', async () => {
    const { say } = setup({ rootCount: 25 });
    const result = await say('command', 'many-roots', '파일 목록');
    expect(result.text).toContain('허용 폴더 목록 25개');
    expect(result.text).toContain('추가 24');
    expect(result.text.split('\n').filter(line => line.startsWith('• '))).toHaveLength(25);
  });

  it('확인 질문은 기다리는 중으로 보내고, 예를 받으면 실행한다', async () => {
    const { say, docs } = setup();
    fs.mkdirSync(path.join(docs, 'sub'));
    const r = await say('command', 't1', '!파일 이름 a.txt b.txt');
    expect(r.waiting).toBe(true);
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
    const done = await say('answer', 't2', '예');
    expect(done.waiting).toBe(false);
    expect(fs.existsSync(path.join(docs, 'b.txt'))).toBe(true);
  });

  it('예가 아니면 실행하지 않는다', async () => {
    const { say, docs } = setup();
    await say('command', 't1', '!파일 이름 a.txt b.txt');
    const r = await say('answer', 't2', '취소');
    expect(r.text).toContain('취소');
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
  });

  it('확인 중 인증 폐기를 보내면 질문을 끝내고 잠근다', async () => {
    const { say, docs } = setup();
    await say('command', 't1', '!파일 이름 a.txt b.txt');
    const locked = await say('command', 't2', '인증 폐기');
    expect(locked.text).toContain('현재 인증을 종료');
    expect(locked.waiting).toBe(false);
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(docs, 'b.txt'))).toBe(false);
  });

  it('기다리는 질문이 없으면 그렇게 답한다', async () => {
    const { say } = setup();
    expect((await say('answer', 't1', '예')).text).toContain('기다리는 질문이 없습니다');
  });

  it('체크하지 않은 폴더는 다루지 않는다', async () => {
    const { say, other } = setup();
    const r = await say('command', 't1', '!파일 찾기 secret');
    expect(r.text).not.toContain('secret.txt');
    const abs = await say('command', 't2', `!파일 이름 ${path.join(other, 'secret.txt')} x.txt`);
    expect(abs.waiting).toBe(false);
    expect(fs.existsSync(path.join(other, 'secret.txt'))).toBe(true);
  });

  it('체크한 폴더가 없으면 안내한다', async () => {
    const { say } = setup({ allowDocs: false });
    expect((await say('command', 't1', '!파일 찾기 a')).text).toContain('원격 허용');
  });

  it('잠겨 있으면 찾기 말고는 거부한다', async () => {
    const { say, docs } = setup({ unlocked: false });
    const r = await say('command', 't1', '!파일 이름 a.txt b.txt');
    expect(r.text).toContain('잠겨');
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
  });

  it('실행 기록에 출처를 남긴다', async () => {
    const { say, logs } = setup();
    await say('command', 't1', '!파일 생성 문서 새파일.txt');
    const done = logs.find((l) => l.status === 'done' && l.action === 'file.create') as { source: { via?: string; kind: string } };
    expect(done.source).toMatchObject({ kind: 'remote', via: '비서 봇' });
  });

  it('번호로 고른다', async () => {
    const { say, docs } = setup();
    fs.mkdirSync(path.join(docs, 'x'));
    fs.mkdirSync(path.join(docs, 'y'));
    fs.writeFileSync(path.join(docs, 'x', 'dup.txt'), '1');
    fs.writeFileSync(path.join(docs, 'y', 'dup.txt'), '2');
    const r = await say('command', 't1', '!파일 이름 dup.txt new.txt');
    expect(r.text).toContain('1. ');
    expect(r.waiting).toBe(true);
    const q = await say('answer', 't2', '2');
    expect(q.waiting).toBe(true);
    await say('answer', 't3', '예');
    expect(fs.existsSync(path.join(docs, 'y', 'new.txt'))).toBe(true);
  });

  it('보내기는 진행 중인 요청 번호로 올리고, 메시지 기록은 서버에 맡긴다', async () => {
    const { say, uploads, base } = setup();
    const r = await say('command', 't1', '!파일 보내기 a.txt');
    expect(uploads).toMatchObject([{ turn: 't1', name: 'a.txt', bytes: 1 }]);
    expect(r.text).toContain('DM으로 보냅니다');
    expect(fs.existsSync(path.join(base, 'logs', 'sent.jsonl'))).toBe(false);
  });

  it('체크하지 않은 폴더의 파일은 보내지 않는다', async () => {
    const { say, uploads, other } = setup();
    await say('command', 't1', `!파일 보내기 ${path.join(other, 'secret.txt')}`);
    expect(uploads).toEqual([]);
  });

  it('받기는 앱에 알리고, 디스코드 주소만 받는다', async () => {
    const { t, hub, sent, events } = setup();
    const files = [
      { id: 'f1', name: 'a.txt', size: 3, url: 'https://cdn.discordapp.com/attachments/a.txt' },
      { id: 'f2', name: 'b.txt', size: 3, url: 'https://evil.test/b.txt' }
    ];
    handleServerMessage(t, { type: 'command', id: 't1', text: '', files }, (m) => hub.onMessage(m));
    for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect((sent[0] as { text: string }).text).toContain('a.txt');
    expect(events.filter((e) => e.type === 'received').map((e) => e.fileId)).toEqual(['f1']);
    expect(hub.hasFile('f1')).toBe(true);
    expect(hub.hasFile('f2')).toBe(false);
  });

  it('디스코드 주소 검사', async () => {
    expect(isDiscordFileUrl('https://media.discordapp.net/a')).toBe(true);
    for (const u of ['http://cdn.discordapp.com/a', 'https://cdn.discordapp.com.evil.test/a', 'nope']) expect(isDiscordFileUrl(u)).toBe(false);
    await expect(fetchDiscordFile('https://evil.test/a')).rejects.toThrow('디스코드 주소');
  });

  it('틀린 코드와 요청 횟수를 다른 입구와 함께 센다', async () => {
    const { say } = setup();
    const c = newHubCounters();
    c.badCodes = Array.from({ length: 50 }, () => Date.now());
    const base = fs.mkdtempSync(path.join(tmpBase(), 'srvhub2-'));
    const state = createRemoteState(path.join(base, 's.json'), null);
    state.newKey('t');
    const hub = new RemoteHub({
      broker: new ToolBroker({ getRoots: () => [], shell: {} as never }),
      state,
      sent: createSentStore(path.join(base, 'logs')),
      getSettings: () => ({ remote: { discord: { userId: 'x' }, unlockMinutes: 60, sentDeleteDays: 7 } }) as never,
      getRoots: () => [],
      getReceivedDir: () => base,
      emit: () => {},
      chat: async () => '',
      checkAuthor: false,
      counters: c
    });
    const out: string[] = [];
    hub.transport = new ServerTransport((m) => out.push(String(m.text)));
    await hub.onMessage({ id: '1', authorId: '', text: '인증 000000', files: [] });
    expect(state.isStopped()).toBe(true);
    expect(c.stoppedByBadCodes).toBe(true);
    await say('command', 't0', '!파일 찾기 a');
  });

  it('로컬 실행도 출처를 남긴다', async () => {
    const { logs, docs } = setup();
    const broker = new ToolBroker({ getRoots: () => policy.validateRoots([{ id: 'd', label: '문서', path: docs }]).roots, shell: {} as never, audit: { file: '', log: (e: Record<string, unknown>) => logs.push(e) } as never });
    const r = broker.prepare({ action: 'file.create', args: { dest: '문서', name: '로컬.txt' } });
    expect(r.status).toBe('ready');
    if (r.status === 'ready') await broker.execute(r.id);
    const done = logs.find((l) => l.status === 'done') as { source: { via: string } };
    expect(done.source.via).toBe('로컬');
  });

  it('끊기면 기다리던 질문을 취소한다', async () => {
    const { say, t, docs } = setup();
    await say('command', 't1', '!파일 이름 a.txt b.txt');
    t.cancelWaiting();
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
  });
});


describe('비서 봇 자연어의 공통 파일 처리', () => {
  it.each(['파일', '!파일'])('%s 자연어는 접두어만 통일해 AI에 보내고 원격 출처로 실행한다', async (prefix) => {
    const { say, docs, logs, chat, report } = setup({ natural: true, args: { dest: '문서', name: '메모ㄴㄹㄴ.txt' } });
    const r = await say('command', 'n1', `${prefix} 테스트에 메모ㄴㄹㄴ 만들어줘`);
    expect(chat.mock.calls[0][1]).toMatchObject({ text: '파일 테스트에 메모ㄴㄹㄴ 만들어줘' });
    expect(fs.existsSync(path.join(docs, '메모ㄴㄹㄴ.txt'))).toBe(true);
    expect(r.text).not.toContain('답이 없습니다');
    expect(r.text).not.toContain('파일을 만들게요');
    expect(report.mock.calls[0][2]).toMatchObject({ status: 'done' });
    expect(logs.find((l) => l.status === 'done')).toMatchObject({ source: { kind: 'remote', via: '비서 봇' } });
  });

  it('자연어도 잠금·허용 경로 검사를 통과해야 한다', async () => {
    for (const options of [{ unlocked: false }, { allowDocs: false }]) {
      const { say, docs } = setup({ ...options, natural: true, args: { dest: '문서', name: '막힌파일.txt' } });
      const r = await say('command', 'n1', '!파일 문서에 막힌파일.txt 만들어줘');
      expect(r.text).toMatch(/잠겨|원격 허용/);
      expect(fs.existsSync(path.join(docs, '막힌파일.txt'))).toBe(false);
    }
  });

  it('자연어 이름 변경도 메신저의 예·아니오 확인을 받는다', async () => {
    const { say, docs } = setup({ natural: true, action: 'file.rename', args: { target: 'a.txt', name: 'b.txt' } });
    const r = await say('command', 'n1', '!파일 a.txt를 b.txt로 바꿔줘');
    expect(r.waiting).toBe(true);
    expect(fs.existsSync(path.join(docs, 'b.txt'))).toBe(false);
    await say('answer', 'n2', '아니오');
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(docs, 'b.txt'))).toBe(false);
  });

  it('AI가 작업을 보낸 뒤 오류를 보내면 실행하지 않는다', async () => {
    const { say, docs, report } = setup({ natural: true, modelError: true, args: { dest: '문서', name: '미실행.txt' } });
    expect((await say('command', 'n1', '!파일 문서에 미실행.txt 만들어줘')).text).toContain('해석 실패');
    expect(fs.existsSync(path.join(docs, '미실행.txt'))).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });
});


describe('비서 봇 AI 응답 오류와 안내', () => {
  const profile = { type: 'assistant' as const, baseUrl: 'https://unit.invalid/v1', apiKey: '' };
  const options = (events: ChatEvent[]) => ({
    profile,
    chat: vi.fn(async (_p: unknown, _r: unknown, emit: (ev: ChatEvent) => void) => events.forEach(emit)),
    runAction: vi.fn(async () => ({ status: 'done' as const, detail: '완료' })),
    reportAction: vi.fn(async () => {})
  });
  it('되묻기나 안내는 그대로 답하고 작업하지 않는다', async () => {
    const o = options([{ type: 'delta', text: '어느 폴더인가요?' }, { type: 'done', text: '어느 폴더인가요?' }]);
    expect(await serverFileChat('!파일 옮겨줘', o)).toBe('어느 폴더인가요?');
    expect(o.runAction).not.toHaveBeenCalled();
  });
  it('배정한 캐릭터의 세션과 성격을 비서 API에 전달한다', async () => {
    const o = options([{ type: 'done', text: '안내' }]);
    await serverFileChat('파일 찾아줘', { ...o, character: { id: 'server-char', persona: '짧게 답한다' } });
    expect(o.chat.mock.calls[0][1]).toMatchObject({ session: 'server-char', client: { character: 'server-char', persona: '짧게 답한다' } });
  });
  it('프로필 누락·다중 작업·서버 확인 요청은 실행하지 않는다', async () => {
    const ev = { type: 'client_action' as const, id: 'a', action: 'file.create', args: {}, say: '' };
    for (const o of [
      { ...options([ev]), profile: null },
      options([ev, { ...ev, id: 'b' }]),
      options([ev, { type: 'confirm', id: 's', message: '서버 작업', expiresIn: 60 }])
    ]) {
      await expect(serverFileChat('파일 만들어줘', o)).rejects.toThrow();
      expect(o.runAction).not.toHaveBeenCalled();
    }
  });
  it('연결이 끊긴 응답의 중간 작업은 실행하지 않는다', async () => {
    const o = options([{ type: 'client_action', id: 'a', action: 'file.create', args: {}, say: '' }]);
    o.chat.mockImplementationOnce(async () => { throw new Error('연결 실패'); });
    await expect(serverFileChat('파일 만들어줘', o)).rejects.toThrow('연결 실패');
    expect(o.runAction).not.toHaveBeenCalled();
  });
});


describe('비서 봇 정형 생성의 위치·이름 경계', () => {
  it.each(['파일', '!파일'])('%s도 따옴표 없는 공백 이름으로 생성한다', async (prefix) => {
    const { say, docs } = setup();
    const r = await say('command', 'c1', `${prefix} 추가 문서 dkkd 9ddd`);
    expect(r.waiting).toBe(false);
    expect(fs.existsSync(path.join(docs, 'dkkd 9ddd'))).toBe(true);
  });
  it('위치와 새 이름 조합을 번호로 선택한 뒤에만 만든다', async () => {
    const { say, docs } = setup();
    fs.mkdirSync(path.join(docs, 'test')); fs.mkdirSync(path.join(docs, 'test dkkd'));
    const r = await say('command', 'c1', '!파일 추가 test dkkd 9ddd');
    expect(r.waiting).toBe(true);
    expect(r.text).toContain('새 이름: dkkd 9ddd');
    expect(r.text).toContain('새 이름: 9ddd');
    expect(fs.readdirSync(path.join(docs, 'test'))).toEqual([]);
    const n = r.text.split('\n').find((l) => l.endsWith('새 이름: dkkd 9ddd'))!.match(/^(\d+)\./)![1];
    const done = await say('answer', 'c2', n);
    expect(done.waiting).toBe(false);
    expect(fs.existsSync(path.join(docs, 'test', 'dkkd 9ddd'))).toBe(true);
  });
  it('경계 선택을 취소하면 파일이 생기지 않는다', async () => {
    const { say, docs } = setup();
    fs.mkdirSync(path.join(docs, 'test')); fs.mkdirSync(path.join(docs, 'test dkkd'));
    await say('command', 'c1', '!파일 추가 test dkkd 9ddd');
    await say('answer', 'c2', '취소');
    expect(fs.readdirSync(path.join(docs, 'test'))).toEqual([]);
    expect(fs.readdirSync(path.join(docs, 'test dkkd'))).toEqual([]);
  });
});


describe('비서 봇의 폴더 지정 열기', () => {
  it.each(['파일', '!파일'])('%s 명령도 지정 폴더만 열고 원격 출처를 남긴다', async (prefix) => {
    const { say, docs, logs } = setup();
    const music = path.join(docs, 'my music');fs.mkdirSync(music);fs.writeFileSync(path.join(music, 'a.txt'), 'inside');
    const r = await say('command', 'o1', `${prefix} 열기 my music a`);
    expect(r.waiting).toBe(false);
    expect(logs.find((l) => l.status === 'done')).toMatchObject({ action: 'file.open', src: path.join(music, 'a.txt'), source: { kind: 'remote', via: '비서 봇' } });
  });
  it('AI가 전달한 하위 위치도 같은 원격 범위로 실행한다', async () => {
    const { say, docs, logs } = setup({ natural: true, action: 'file.open', args: { root: 'my music', target: 'a' } });
    const music = path.join(docs, 'my music');fs.mkdirSync(music);fs.writeFileSync(path.join(music, 'a.txt'), 'inside');
    await say('command', 'o1', '!파일 my music에서 a 파일 열어');
    expect(logs.find((l) => l.status === 'done')).toMatchObject({ src: path.join(music, 'a.txt') });
  });
});


describe('비서 봇의 폴더 지정 위치 보기·이름 변경', () => {
  it.each(['파일', '!파일'])('%s 위치 보기와 이름 변경은 같은 원격 범위를 쓴다', async (prefix) => {
    const { say, docs, logs } = setup();const music = path.join(docs, 'my music');fs.mkdirSync(music);fs.writeFileSync(path.join(music, 'a.txt'), 'inside');
    await say('command', 'r1', `${prefix} 위치 my music a`);
    expect(logs.find((l) => l.status === 'done')).toMatchObject({ action: 'file.reveal', src: path.join(music, 'a.txt') });
    const ask = await say('command', 'r2', `${prefix} 이름 my music a b.txt`);
    expect(ask.waiting).toBe(true);expect(fs.existsSync(path.join(music, 'b.txt'))).toBe(false);
    await say('answer', 'r3', '예');
    expect(fs.existsSync(path.join(music, 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(docs, 'a.txt'))).toBe(true);
  });
  it('자연어 이름 변경도 확인을 거절하면 실행하지 않는다', async () => {
    const { say, docs } = setup({ natural: true, action: 'file.rename', args: { root: 'my music', target: 'a', name: 'b.txt' } });
    const music = path.join(docs, 'my music');fs.mkdirSync(music);fs.writeFileSync(path.join(music, 'a.txt'), 'inside');
    expect((await say('command', 'r1', '!파일 my music에서 a 이름을 b.txt로 바꿔줘')).waiting).toBe(true);
    await say('answer', 'r2', '아니오');
    expect(fs.existsSync(path.join(music, 'a.txt'))).toBe(true);expect(fs.existsSync(path.join(music, 'b.txt'))).toBe(false);
  });
});


describe('비서 봇의 복사·이동 위치와 같은 폴더 사본', () => {
  it.each(['file.copy', 'file.move'])('%s 자연어도 출발·도착을 지키고 확인 후 실행한다', async (action) => {
    const { say, docs } = setup({ natural: true, action, args: { root: '출발', target: 'a.txt', dest: 'my music' } });
    const src = path.join(docs, '출발'), dst = path.join(docs, 'my music');fs.mkdirSync(src);fs.mkdirSync(dst);fs.writeFileSync(path.join(src, 'a.txt'), 'inside');
    const ask = await say('command', 't1', '!파일 출발 폴더에서 a.txt를 my music 폴더로 복사해줘');
    expect(ask.waiting).toBe(true);expect(fs.existsSync(path.join(dst, 'a.txt'))).toBe(false);
    await say('answer', 't2', '예');expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('inside');
    expect(fs.existsSync(path.join(src, 'a.txt'))).toBe(action === 'file.copy');expect(fs.readFileSync(path.join(docs, 'a.txt'), 'utf8')).toBe('a');
  });
  it('같은 폴더 복사도 인증·확인·거절을 유지한다', async () => {
    const locked = setup({ unlocked: false, natural: true, action: 'file.copy', args: { target: 'a.txt', sameFolder: true } });
    expect((await locked.say('command', 't1', '!파일 a.txt를 같은 폴더에 복사해줘')).text).toContain('잠겨');expect(fs.existsSync(path.join(locked.docs, 'a (1).txt'))).toBe(false);
    const s = setup({ natural: true, action: 'file.copy', args: { target: 'a.txt', sameFolder: true } });
    expect((await s.say('command', 't1', '!파일 a.txt를 같은 폴더에 복사해줘')).waiting).toBe(true);await s.say('answer', 't2', '아니오');expect(fs.existsSync(path.join(s.docs, 'a (1).txt'))).toBe(false);
    await s.say('command', 't3', '!파일 a.txt를 같은 폴더에 복사해줘');await s.say('answer', 't4', '예');expect(fs.existsSync(path.join(s.docs, 'a (1).txt'))).toBe(true);
  });
});


describe('비서 서버 캐릭터 배정 전 검사', () => {
  it('대상이 없으면 AI·파일 준비 전에 안내하고 인증 도움말은 계속 처리한다', async () => {
    const prepareRequest = vi.fn(async () => '캐릭터 설정 안내');
    const s = setup({ natural: true, prepareRequest });
    const prepare = vi.spyOn(s.hub, 'runAction');
    expect((await s.say('command', 'missing', '파일 만들기 문서 새파일')).text).toBe('캐릭터 설정 안내');
    expect((await s.say('command', 'natural', '파일 문서에서 새파일 생성해')).text).toBe('캐릭터 설정 안내');
    expect(s.chat).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    const n = prepareRequest.mock.calls.length;
    expect((await s.say('command', 'auth-help', '인증')).text).toContain('인증 방법');
    expect(prepareRequest).toHaveBeenCalledTimes(n);
  });
  it('지정 채널은 미인증일 때 캐릭터를 배정하지 않는다', async () => {
    const prepareRequest = vi.fn(async () => {});
    const s = setup({ unlocked: false, prepareRequest });
    expect((await s.say('command', 'locked', '파일 찾기 a', true)).text).toContain('인증');
    expect(prepareRequest).not.toHaveBeenCalled();
  });
  it('배정을 기다리는 중 인증이 폐기되면 이전 작업을 실행하지 않는다', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const s = setup({ prepareRequest: () => gate });
    const result = s.hub.runAction('file.create', { dest: '문서', name: '실행금지' }, { kind: 'server', id: 'old' });
    s.state.lock(); release();
    expect((await result).status).toBe('rejected');
    expect(fs.existsSync(path.join(s.docs, '실행금지'))).toBe(false);
  });
});
