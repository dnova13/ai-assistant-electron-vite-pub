// 메인 프로세스의 API 클라이언트가 규약대로 가짜 서버와 통신하는지 확인한다.
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { server } from '../tools/mock-server.js';
import * as api from '../src/main/api/client';
import type { ChatEvent } from '../src/shared/types';

let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const profile = () => ({ type: 'assistant' as const, baseUrl: base, apiKey: 'dev-token', timeoutSec: 10 });
const codeIs = (code: string) => (e: unknown) => (e as api.ApiError).code === code;

// 대화를 끝까지 받아 이벤트 목록과 마지막 답을 돌려준다
async function talk(req: api.ChatCall, p = profile()) {
  const events: ChatEvent[] = [];
  await api.chat(p, req, (e) => events.push(e));
  const last = events.at(-1);
  return { events, last, finalText: last && last.type === 'done' ? last.text : null };
}

test('health: 기능 목록을 읽는다', async () => {
  const h = await api.health(profile());
  assert.equal(h.provider, 'assistant');
  assert.equal(h.api, '1');
  assert.equal(h.features.stt, true);
  assert.ok(h.features.clientActions.includes('file.move'));
});

test('토큰이 틀리면 인증 실패 안내', async () => {
  await assert.rejects(api.health({ ...profile(), apiKey: 'wrong' }), codeIs('auth'));
});

test('주소가 틀리면 연결 실패 안내', async () => {
  await assert.rejects(api.health({ ...profile(), baseUrl: 'http://127.0.0.1:1' }), codeIs('unreachable'));
});

test('chat: delta가 이어지고 done으로 끝난다', async () => {
  const { events, last, finalText } = await talk({ text: '안녕', client: { os: 'darwin' } });
  const deltas = events
    .filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta')
    .map((e) => e.text)
    .join('');
  assert.ok(deltas.includes('안녕'));
  assert.equal(last?.type, 'done');
  assert.equal(finalText, deltas);
});

test('chat: 파일 이동 문장은 client_action', async () => {
  const { events } = await talk({ text: '보고서.pdf 문서로 옮겨줘' });
  const act = events.find((e): e is Extract<ChatEvent, { type: 'client_action' }> => e.type === 'client_action');
  assert.ok(act);
  assert.equal(act.action, 'file.move');
  assert.deepEqual(act.args, { target: '보고서.pdf', dest: 'documents' });
});

test('confirm: 승인하면 결과, 두 번째는 410', async () => {
  const { events } = await talk({ text: '서비스 nginx 재시작' });
  const c = events.find((e): e is Extract<ChatEvent, { type: 'confirm' }> => e.type === 'confirm');
  assert.ok(c && c.id && c.expiresIn === 60);
  const r = await api.confirm(profile(), c.id, true);
  assert.match(r.text, /실행/);
  await assert.rejects(api.confirm(profile(), c.id, true), /시간이 지났거나/);
});

test('reportAction, stt, tts', async () => {
  await api.reportAction(profile(), 'a_1', { status: 'done', detail: '문서/보고서.pdf' });
  const s = await api.stt(profile(), Buffer.from('fake-audio'), 'audio/webm;codecs=opus');
  assert.match(s.text, /날씨/);
  const t = await api.tts(profile(), '안녕하세요.', 'default');
  assert.equal(t.mime, 'audio/wav');
  assert.equal(t.audio.subarray(0, 4).toString(), 'RIFF');
});

test('session과 low_spec을 보내면 서버가 캐릭터별로 기억한다', async () => {
  const say = async (session: string, lowSpec: boolean) => (await talk({ text: '안녕', session, lowSpec })).finalText || '';
  assert.match(await say('hana', false), /기억 hana 1번째\)/);
  assert.match(await say('hana', true), /기억 hana 2번째 · 저사양/);
  assert.match(await say('rin', false), /기억 rin 1번째/);
  const h = await api.health(profile());
  assert.equal(h.features.sessions, true);
  assert.equal(h.features.lowSpec, true);
});

test('ollama 모드에서는 stt를 지원하지 않는다고 알려 준다', async () => {
  await assert.rejects(api.stt({ type: 'ollama', baseUrl: base, apiKey: '' }, Buffer.alloc(1), 'audio/webm'), codeIs('unsupported'));
});

test('이상한 이벤트는 걸러진다', () => {
  assert.equal(api.sanitizeEvent({ type: 'run_shell', cmd: 'rm -rf /' }), null);
  assert.equal(api.sanitizeEvent({ type: 'client_action', action: 'file.move' }), null); // id 없음
  const ev = api.sanitizeEvent({ type: 'client_action', id: 'a', action: 'file.move', args: { target: 'x', evil: 1 } });
  assert.ok(ev && ev.type === 'client_action');
  assert.deepEqual(ev.args, { target: 'x' });
});

test('스트림 중간에 조각 사이 시간이 넘으면 끊는다', async () => {
  const slow = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"type":"delta","text":"a"}\n'); // 그 뒤로 아무것도 안 보냄
  });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
  const p = { type: 'assistant' as const, baseUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, apiKey: '', timeoutSec: 1 };
  await assert.rejects(api.chat(p, { text: 'x' }, () => {}), codeIs('timeout'));
  slow.closeAllConnections();
  slow.close();
});
