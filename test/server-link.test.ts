// 비서 서버 연결: 인증, 신호, 다시 연결, 거절 (가짜 소켓, 네트워크 없음)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELLO_WAIT_MS, PING_MS, PONG_WAIT_MS, RETRY_MS, ServerLink, type LinkStatus, type SocketLike } from '../src/main/remote/server-link';
import { createRemoteState } from '../src/main/remote/state';
import { computerLinkUrl } from '../src/main/api/client';

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const seen: LinkStatus[] = [];
  const rejected: string[] = [];
  const link = new ServerLink({
    url: 'ws://test/v1/computers/connect',
    key: 'k',
    computerId: 'pc_1',
    onChange: (s) => seen.push(s),
    onRejected: (r) => rejected.push(r),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    }
  });
  const connect = () => {
    link.start();
    sockets[sockets.length - 1].onopen?.({});
    sockets[sockets.length - 1].say({ type: 'welcome', name: '소니' });
  };
  return { link, sockets, seen, rejected, connect };
}

describe('ServerLink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('연결하면 첫 메시지로 키와 번호를 보내고, 환영을 받으면 연결됨', () => {
    const { link, sockets } = setup();
    link.start();
    expect(link.status.state).toBe('connecting');
    sockets[0].onopen?.({});
    expect(sockets[0].sent[0]).toEqual({ type: 'hello', key: 'k', computer_id: 'pc_1' });
    sockets[0].say({ type: 'welcome', name: '소니' });
    expect(link.status).toEqual({ state: 'connected', error: '' });
  });

  it('30초마다 신호를 보내고, 답이 오면 그대로 유지', () => {
    const { link, sockets, connect } = setup();
    connect();
    vi.advanceTimersByTime(PING_MS);
    expect(sockets[0].sent[1]).toEqual({ type: 'ping' });
    sockets[0].say({ type: 'pong' });
    vi.advanceTimersByTime(PONG_WAIT_MS);
    expect(link.status.state).toBe('connected');
    expect(sockets.length).toBe(1);
  });

  it('신호에 답이 없으면 끊고 다시 연결', () => {
    const { link, sockets, connect } = setup();
    connect();
    vi.advanceTimersByTime(PING_MS + PONG_WAIT_MS);
    expect(link.status.state).toBe('waiting');
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(RETRY_MS[0]);
    expect(sockets.length).toBe(2);
  });

  it('연결이 끊기면 간격을 늘려 다시 연결하고, 성공하면 간격이 처음으로', () => {
    const { sockets, connect } = setup();
    connect();
    sockets[0].onclose?.({});
    vi.advanceTimersByTime(RETRY_MS[0]);
    expect(sockets.length).toBe(2);
    sockets[1].onclose?.({});
    vi.advanceTimersByTime(RETRY_MS[0]);
    expect(sockets.length).toBe(2);
    vi.advanceTimersByTime(RETRY_MS[1] - RETRY_MS[0]);
    expect(sockets.length).toBe(3);
    sockets[2].onopen?.({});
    sockets[2].say({ type: 'welcome', name: '소니' });
    sockets[2].onclose?.({});
    vi.advanceTimersByTime(RETRY_MS[0]);
    expect(sockets.length).toBe(4);
  });

  it('환영이 오지 않으면 다시 연결', () => {
    const { link, sockets } = setup();
    link.start();
    sockets[0].onopen?.({});
    vi.advanceTimersByTime(HELLO_WAIT_MS);
    expect(link.status.state).toBe('waiting');
  });

  it.each(['bad_key', 'unknown_computer', 'replaced'])('거절(%s)이면 다시 연결하지 않는다', (reason) => {
    const { link, sockets, rejected, connect } = setup();
    connect();
    sockets[0].say({ type: 'rejected', reason });
    expect(rejected).toEqual([reason]);
    expect(link.status.state).toBe('off');
    expect(link.status.error).not.toBe('');
    vi.advanceTimersByTime(RETRY_MS[RETRY_MS.length - 1] * 2);
    expect(sockets.length).toBe(1);
  });

  it('서버에서 이름을 바꾸면 알린다', () => {
    const names: string[] = [];
    const sockets: FakeSocket[] = [];
    const link = new ServerLink({
      url: 'ws://t',
      key: 'k',
      computerId: 'pc_1',
      onChange: () => {},
      onRenamed: (n) => names.push(n),
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      }
    });
    link.start();
    sockets[0].say({ type: 'renamed', name: '작업실' });
    expect(names).toEqual(['작업실']);
  });

  it('끄면 끊고 다시 연결하지 않는다', () => {
    const { link, sockets, connect } = setup();
    connect();
    link.stop();
    expect(sockets[0].closed).toBe(true);
    expect(link.status).toEqual({ state: 'off', error: '' });
    vi.advanceTimersByTime(RETRY_MS[RETRY_MS.length - 1] * 2);
    expect(sockets.length).toBe(1);
  });
});

describe('computerLinkUrl', () => {
  it('내 서버 입구 뒤에 붙이고 ws로 바꾼다', () => {
    expect(computerLinkUrl('http://a:8050')).toBe('ws://a:8050/v1/computers/connect');
    expect(computerLinkUrl('https://a.test/')).toBe('wss://a.test/v1/computers/connect');
    expect(computerLinkUrl('https://a.test/ai-agent')).toBe('wss://a.test/ai-agent/computers/connect');
  });
});

describe('서버 연결 저장', () => {
  it('인터넷 없이 해제한 뒤 재실행해도 ID를 기억하고 자동 연결은 하지 않는다', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'link-')), 'state.json');
    const state = createRemoteState(file, null);
    state.setServer({ profile: 'qa', computerId: 'pc_qa', computerName: '소니', on: true });
    state.detachServer();
    const restored = createRemoteState(file, null).server();
    expect(restored).toEqual({ attached: false, on: false, profile: 'qa', computerId: 'pc_qa', computerName: '소니' });
    state.setServer({ attached: true, on: false, computerName: '작업용' });
    expect(createRemoteState(file, null).server()).toMatchObject({ attached: true, computerId: 'pc_qa', computerName: '작업용' });
  });
  it('기존 저장 파일은 ID가 있으면 등록 상태로 복원한다', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'link-')), 'state.json');
    fs.writeFileSync(file, JSON.stringify({ server: { on: true, profile: 'qa', computerId: 'pc_old', computerName: '소니' } }));
    expect(createRemoteState(file, null).server()).toEqual({ attached: true, on: true, profile: 'qa', computerId: 'pc_old', computerName: '소니' });
  });

  it('등록 정보와 스위치가 파일에 남고, 기본은 꺼짐', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'link-')), 'state.json');
    const st = createRemoteState(file, null);
    expect(st.server()).toEqual({ attached: false, on: false, profile: '', computerId: '', computerName: '' });
    st.setServer({ profile: 'p1', computerId: 'pc_1', computerName: '소니', on: true });
    expect(createRemoteState(file, null).server().computerName).toBe('소니');
    st.clearServer();
    expect(createRemoteState(file, null).server()).toEqual({ attached: false, on: false, profile: '', computerId: '', computerName: '' });
  });
});
