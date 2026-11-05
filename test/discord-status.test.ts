// 디스코드 연결 상태: 연결 중 → 연결됨 / 실패 (가짜 Client, 네트워크 없음)
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ client: null as unknown as { login: (t: string) => Promise<void>; emit: (n: string, v: unknown) => void }, login: { fail: false } }));

vi.mock('discord.js', async (orig) => {
  const real = await orig<typeof import('discord.js')>();
  const { EventEmitter } = await import('node:events');
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      h.client = this as never;
    }
    async login() {
      if (h.login.fail) throw new Error('An invalid token was provided.');
    }
    async destroy() {}
  }
  return { ...real, Client: FakeClient };
});

import { Events } from 'discord.js';
import { DiscordTransport } from '../src/main/remote/discord';
import { connectThenSave } from '../src/main/remote/discord-connect';

describe('디스코드 연결 상태', () => {
  it('처음 준비되면 인증 안내를 보내고 세션 복구로 안내를 중복하지 않는다', async () => {
    h.login.fail = false;
    const ready = vi.fn(async () => {});
    const d = new DiscordTransport(() => {});
    await d.start('t', '1', () => {}, ready);
    h.client.emit(Events.ClientReady, { user: { tag: '봇#1' } });
    h.client.emit(Events.ShardDisconnect, {});
    h.client.emit(Events.ShardResume, 0);
    expect(ready).toHaveBeenCalledTimes(1);
    await d.stop();
  });
  it('로그인이 끝나도 준비 완료 전까지는 연결 중이다', async () => {
    h.login.fail = false;
    const seen: boolean[] = [];
    const d = new DiscordTransport((s) => seen.push(s.connecting));
    await d.start('t', '1', () => {});
    expect(d.status).toMatchObject({ connected: false, connecting: true });
    h.client.emit(Events.ClientReady, { user: { tag: '봇#1' } });
    expect(d.status).toMatchObject({ connected: true, connecting: false, botName: '봇#1' });
    expect(seen).toContain(true);
  });

  it('실패하면 연결 중을 끝내고 이유를 남긴다', async () => {
    h.login.fail = true;
    const d = new DiscordTransport(() => {});
    await expect(d.start('t', '1', () => {})).rejects.toThrow();
    expect(d.status.connecting).toBe(false);
    expect(d.status.error).not.toBe('');
  });

  it('끊겼다가 다시 시도하면 연결 중, 이어지면 연결됨', async () => {
    h.login.fail = false;
    const d = new DiscordTransport(() => {});
    await d.start('t', '1', () => {});
    h.client.emit(Events.ClientReady, { user: { tag: '봇#1' } });
    h.client.emit(Events.ShardDisconnect, {});
    expect(d.status).toMatchObject({ connected: false, connecting: false });
    h.client.emit(Events.ShardReconnecting, 0);
    expect(d.status.connecting).toBe(true);
    h.client.emit(Events.ShardResume, 0);
    expect(d.status).toMatchObject({ connected: true, connecting: false });
  });
});

describe('준비 완료 기다리기', () => {
  it('준비되면 true, 멈추면 false, 시간이 지나면 false', async () => {
    h.login.fail = false;
    const d = new DiscordTransport(() => {});
    await d.start('t', '1', () => {});
    const ready = d.waitReady(1000);
    h.client.emit(Events.ClientReady, { user: { tag: '봇#1' } });
    await expect(ready).resolves.toBe(true);
    await expect(d.waitReady(1000)).resolves.toBe(true);
    await d.start('t', '1', () => {});
    const stopped = d.waitReady(1000);
    await d.stop();
    await expect(stopped).resolves.toBe(false);
    await d.start('t', '1', () => {});
    await expect(d.waitReady(5)).resolves.toBe(false);
  });
});

describe('연결한 뒤 저장', () => {
  const on = { enabled: true, apiKey: 'new', userId: '1' };
  function deps(t: { status: { error: string }; waitReady: () => Promise<boolean> } | Error) {
    const calls: string[] = [];
    return {
      calls,
      d: {
        start: async () => {
          calls.push('start');
          if (t instanceof Error) throw t;
          return t;
        },
        save: () => void calls.push('save'),
        restore: () => void calls.push('restore'),
        isCurrent: () => true
      }
    };
  }

  it('연결되면 그다음에 저장한다', async () => {
    const { calls, d } = deps({ status: { error: '' }, waitReady: async () => true });
    expect(await connectThenSave(on, d)).toEqual({ ok: true, error: '' });
    expect(calls).toEqual(['start', 'save']);
  });

  it('로그인이 실패하면 저장하지 않고 되돌린다', async () => {
    const { calls, d } = deps(new Error('토큰이 틀립니다'));
    expect(await connectThenSave(on, d)).toEqual({ ok: false, error: '토큰이 틀립니다' });
    expect(calls).toEqual(['start', 'restore']);
  });

  it('시간이 지나면 저장하지 않고 되돌린다', async () => {
    const { calls, d } = deps({ status: { error: '' }, waitReady: async () => false });
    expect((await connectThenSave(on, d)).error).toContain('시간');
    expect(calls).toEqual(['start', 'restore']);
  });

  it('기다리는 사이 연결이 바뀌면 저장도 되돌리기도 하지 않는다', async () => {
    const { calls, d } = deps({ status: { error: '' }, waitReady: async () => true });
    expect((await connectThenSave(on, { ...d, isCurrent: () => false })).ok).toBe(false);
    expect(calls).toEqual(['start']);
  });

  it('값이 비면 연결하지 않는다', async () => {
    const { calls, d } = deps({ status: { error: '' }, waitReady: async () => true });
    expect((await connectThenSave({ ...on, apiKey: '' }, d)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('꺼 두면 연결 없이 저장한다', async () => {
    const { calls, d } = deps({ status: { error: '' }, waitReady: async () => true });
    expect((await connectThenSave({ ...on, enabled: false }, d)).ok).toBe(true);
    expect(calls).toEqual(['save', 'restore']);
  });
});


describe('직접 연결 공통 확인 답변', () => {
  it('버튼 순서·색을 유지하고 어/yes/자유로운 답을 공통으로 처리한다', async () => {
    h.login.fail = false;
    const bodies: any[] = [];
    const model = vi.fn(async (_question: string, answer: string) => answer === '그래 진행해' ? 'yes' as const : 'unknown' as const);
    const d = new DiscordTransport(() => {}, model);
    const regular = vi.fn();
    await d.start('t', '42', regular);
    const dm = { type: 1, send: async (body: any) => { bodies.push(body); return { edit: async () => {}, awaitMessageComponent: () => new Promise(() => {}) }; } };
    const send = (text: string, id = '42') => h.client.emit(Events.MessageCreate, { id: 'qa', author: { id, bot: false }, channel: dm, content: text, attachments: new Map() });
    send('준비'); regular.mockClear();
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    for (const word of ['어','예',' YES ','응','그래 진행해']) {
      const pending = d.ask('복사할까요?', '대상: 메모', 3000);
      await tick();
      const buttons = bodies.at(-1).components[0].components.map((b: any) => b.toJSON());
      expect(buttons.map((b: any) => b.label)).toEqual(['예','아니오']);
      expect(buttons[0].style).toBe(1);
      send(word); await expect(pending).resolves.toBe('yes');
    }
    expect(model).toHaveBeenCalledTimes(1);
    const pending = d.ask('정말로 삭제할까요?', '', 3000, { destructive: true });
    await tick();
    expect(bodies.at(-1).components[0].components.map((b: any) => b.toJSON().label)).toEqual(['아니오','예']);
    send('아마도'); await tick();
    expect(bodies.at(-1)).toContain('다시 답해');
    send('no'); await expect(pending).resolves.toBe('no');
    expect(regular).not.toHaveBeenCalled();
    await d.stop();
  });
});
