// 디스코드 봇 연결 (discord.js). 이 컴퓨터의 앱이 자기 봇에 직접 연결한다 (컴퓨터마다 봇).
// 내 계정(사용자 ID)이 봇에게 보낸 DM만 받는다. 규칙은 hub.ts.
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { DMChannel, Message, TextBasedChannel } from 'discord.js';
import crypto from 'node:crypto';
import type { IncomingMessage, Transport } from './hub';
import { CONFIRM_AGAIN, NO, decideConfirmation, type ConfirmationInterpreter } from '@shared/confirmation';
import { remoteControlText } from '@shared/remote-auth';
const MAX_LEN = 1900; // 디스코드 한 메시지 2000자

/** 긴 글을 디스코드 한도에 맞게 나눈다 */
export function splitText(text: string, max = MAX_LEN): string[] {
  const out: string[] = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

export interface DiscordStatus {
  connected: boolean;
  /** 연결을 시도하는 중 (준비 완료나 실패 전까지) */
  connecting: boolean;
  botName: string;
  error: string;
}

type Waiter = { kind: 'yesno' | 'number'; max: number; resolve: (v: string) => void; accept?: (text: string) => void };

export class DiscordTransport implements Transport {
  private client: Client | null = null;
  private userId = '';
  private dm: DMChannel | null = null;
  /** 예/아니오·번호를 기다리는 중이면 그 답은 hub로 보내지 않고 여기서 받는다 */
  private waiter: Waiter | null = null;
  private readyWaiters: ((ok: boolean) => void)[] = [];
  status: DiscordStatus = { connected: false, connecting: false, botName: '', error: '' };

  constructor(private onStatus: (s: DiscordStatus) => void, private interpret?: ConfirmationInterpreter) {}

  private setStatus(p: Partial<DiscordStatus>): void {
    this.status = { ...this.status, ...p };
    this.onStatus(this.status);
    if (this.status.connected) this.finishReady(true);
  }

  private finishReady(ok: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w(ok);
  }

  /** 디스코드가 준비 완료를 알릴 때까지 기다린다. 시간이 지나거나 멈추면 false */
  waitReady(ms: number): Promise<boolean> {
    if (this.status.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok);
      };
      this.readyWaiters.push(done);
    });
  }

  async start(token: string, userId: string, onMessage: (m: IncomingMessage) => void, onReady?: () => Promise<void>): Promise<void> {
    await this.stop();
    this.userId = userId;
    // DM만 받는다. DM은 Message Content 권한 없이도 내용이 온다
    const client = new Client({ intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
    this.client = client;
    this.setStatus({ connected: false, connecting: true, error: '' });
    client.once(Events.ClientReady, (c) => {
      if (this.client !== client) return;
      this.setStatus({ connected: true, connecting: false, botName: c.user.tag, error: '' });
      void onReady?.().catch(() => console.warn('인증 안내 DM을 보내지 못했습니다. 봇 DM에 인증을 입력해 사용법을 확인하세요.'));
    });
    client.on(Events.ShardDisconnect, () => this.setStatus({ connected: false, connecting: false }));
    client.on(Events.ShardReconnecting, () => this.setStatus({ connected: false, connecting: true }));
    client.on(Events.ShardResume, () => this.setStatus({ connected: true, connecting: false, error: '' }));
    client.on(Events.Error, (e) => this.setStatus({ error: e.message }));
    client.on(Events.MessageCreate, (m: Message) => {
      if (this.client !== client || m.author.bot || m.author.id !== this.userId || m.channel.type !== ChannelType.DM) return;
      this.dm = m.channel as DMChannel;
      const text = (m.content || '').trim();
      const w = this.waiter;
      if (w && !m.attachments.size) {
        const control = remoteControlText(text);
        if (!/^(?:인증|복구|잠금|상태|원격 중지)(?:\s|$)/.test(control) && !/^!?파일(?:\s|$)/.test(text)) {
          if (w.kind === 'yesno' && w.accept) { w.accept(text); return; }
          if (w.kind === 'number' && !/^\d+$/.test(text) && !NO.test(text)) { void this.send('번호 버튼을 누르거나 번호로 답해 주세요. 취소하려면 취소를 보내세요.'); return; }
        }
        if (w.kind === 'number' && /^\d+$/.test(text) && +text >= 1 && +text <= w.max) return w.resolve(String(+text - 1));
        if (w.kind === 'number' && NO.test(text)) return w.resolve('cancel');
      }
      onMessage({
        id: m.id,
        authorId: m.author.id,
        text,
        files: [...m.attachments.values()].map((a) => ({ id: a.id, name: a.name || 'file', size: a.size, url: a.url }))
      });
    });
    try {
      await client.login(token);
    } catch (e) {
      this.setStatus({ connected: false, connecting: false, error: loginError(e as Error) });
      this.client = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.dm = null;
    this.cancelWaiting();
    if (c) await c.destroy().catch(() => {});
    this.setStatus({ connected: false, connecting: false, botName: '' });
    this.finishReady(false);
  }

  cancelWaiting(): void {
    this.waiter?.resolve('timeout');
  }

  private async channel(): Promise<TextBasedChannel & { send: DMChannel['send'] }> {
    if (this.dm) return this.dm;
    if (!this.client) throw new Error('디스코드에 연결되어 있지 않습니다.');
    const u = await this.client.users.fetch(this.userId);
    this.dm = await u.createDM();
    return this.dm;
  }

  async send(text: string): Promise<void> {
    const ch = await this.channel();
    for (const part of splitText(text)) await ch.send(part);
  }

  private wait(kind: Waiter['kind'], max: number, timeoutMs: number, extra?: (resolve: (v: string) => void) => void): Promise<string> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.waiter === w) this.waiter = null;
        resolve(v);
      };
      const w: Waiter = { kind, max, resolve: finish };
      if (this.waiter) this.waiter.resolve('timeout');
      this.waiter = w;
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      if (extra) extra(finish);
    });
  }

  async ask(question: string, detail: string, timeoutMs: number, { destructive = false }: { destructive?: boolean } = {}): Promise<'yes' | 'no' | 'timeout'> {
    const ch = await this.channel();
    const nonce = crypto.randomBytes(4).toString('hex');
    const yes = new ButtonBuilder().setCustomId(`${nonce}:yes`).setLabel('예').setStyle(destructive ? ButtonStyle.Danger : ButtonStyle.Primary);
    const no = new ButtonBuilder().setCustomId(`${nonce}:no`).setLabel('아니오').setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(destructive ? [no, yes] : [yes, no]);
    const sent = await ch.send({ content: `**${question}**\n${detail}\n(${Math.round(timeoutMs / 1000)}초 안에 답하지 않으면 취소)`, components: [row] });
    const abort = new AbortController();
    let checking = false;
    const v = await this.wait('yesno', 0, timeoutMs, (finish) => {
      const waiting = this.waiter!;
      waiting.accept = (text) => {
        if (checking) return;
        checking = true;
        void decideConfirmation(question, text, this.interpret, abort.signal).then(async (decision) => {
          if (this.waiter !== waiting) return;
          if (decision !== 'unknown') finish(decision);
          else await this.send(CONFIRM_AGAIN);
        }).catch(() => {}).finally(() => { checking = false; });
      };
      sent
        .awaitMessageComponent({ filter: (i) => i.user.id === this.userId && i.customId.startsWith(nonce), time: timeoutMs })
        .then(async (i) => {
          await i.update({ components: [] }).catch(() => {});
          finish(i.customId.endsWith(':yes') ? 'yes' : 'no');
        })
        .catch(() => finish('timeout'));
    });
    abort.abort();
    await sent.edit({ components: [] }).catch(() => {});
    return v === 'yes' ? 'yes' : v === 'no' ? 'no' : 'timeout';
  }

  async choose(message: string, options: string[], timeoutMs: number): Promise<number | null> {
    const ch = await this.channel();
    const list = options.slice(0, 20);
    const nonce = crypto.randomBytes(4).toString('hex');
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < list.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(list.slice(i, i + 5).map((_, j) => new ButtonBuilder().setCustomId(`${nonce}:${i + j}`).setLabel(String(i + j + 1)).setStyle(ButtonStyle.Primary))));
    }
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${nonce}:x`).setLabel('취소').setStyle(ButtonStyle.Secondary)));
    const body = `${message}\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n(번호를 누르거나 보내세요)`;
    const chunks = splitText(body);
    for (const part of chunks.slice(0, -1)) await ch.send(part);
    const sent = await ch.send({ content: chunks[chunks.length - 1], components: rows });
    const v = await this.wait('number', options.length, timeoutMs, (finish) => {
      sent
        .awaitMessageComponent({ filter: (i) => i.user.id === this.userId && i.customId.startsWith(nonce), time: timeoutMs })
        .then(async (i) => {
          await i.update({ components: [] }).catch(() => {});
          finish(i.customId.split(':')[1] === 'x' ? 'cancel' : i.customId.split(':')[1]);
        })
        .catch(() => finish('timeout'));
    });
    await sent.edit({ components: [] }).catch(() => {});
    return /^\d+$/.test(v) ? Number(v) : null;
  }

  async sendFile(filePath: string, name: string, text: string): Promise<{ channelId: string; messageId: string }> {
    const ch = await this.channel();
    const m = await ch.send({ content: text, files: [new AttachmentBuilder(filePath, { name })] });
    return { channelId: m.channelId, messageId: m.id };
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('디스코드에 연결되어 있지 않습니다.');
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) throw Object.assign(new Error('대화방을 찾을 수 없습니다.'), { status: 404 });
    await ch.messages.delete(messageId);
  }
}

function loginError(e: Error): string {
  const m = e.message || String(e);
  if (/TokenInvalid|invalid token|401/i.test(m)) return '봇 토큰이 틀렸습니다. 디스코드 개발자 포털에서 토큰을 다시 복사하세요.';
  if (/disallowed intents/i.test(m)) return '봇 권한(Intent) 설정이 맞지 않습니다. 디스코드 개발자 포털의 봇 설정을 확인하세요.';
  return `디스코드 연결 실패: ${m}`;
}
