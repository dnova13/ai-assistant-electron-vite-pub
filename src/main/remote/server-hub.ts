// 비서 봇에서 온 말을 RemoteHub로 처리한다. 서버와는 말 한 번, 답 한 번으로 주고받는다.
// 앱이 묻는 동안(예/아니오, 번호)은 답을 "기다리는 중"으로 보내고, 사용자의 다음 말을 answer로 받는다.
import type { IncomingFile, IncomingMessage, Transport } from './hub';
import { randomUUID } from 'node:crypto';
import { CONFIRM_AGAIN, decideConfirmation, type ConfirmationInterpreter, type RemotePrompt } from '@shared/confirmation';
import { remoteControlText } from '@shared/remote-auth';

const FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** 받기: 디스코드 첨부 주소만 내려받는다 */
export function isDiscordFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && FILE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function fetchDiscordFile(url: string): Promise<Buffer> {
  if (!isDiscordFileUrl(url)) throw new Error('디스코드 주소가 아니라 내려받지 않았습니다.');
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface ServerMessage {
  channel?: unknown;
  promptId?: unknown;
  type?: unknown;
  id?: unknown;
  text?: unknown;
  files?: unknown;
}

type Send = (message: Record<string, unknown>) => void;
/** 파일을 서버로 올린다 (진행 중인 요청 번호에 붙는다) */
export type Upload = (turn: string, filePath: string, name: string, note: string) => Promise<void>;
type Waiter = (text: string | null) => void;

export class ServerTransport implements Transport {
  private turn: string | null = null;
  private lines: string[] = [];
  private waiter: Waiter | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private prompt: RemotePrompt | null = null;
  private activeAbort: AbortController | null = null;

  constructor(private sendToServer: Send, private upload?: Upload, private interpret?: ConfirmationInterpreter) {}

  /** 말 하나를 처리한다. 앞의 말이 끝난 뒤에 시작한다 */
  run(id: string, handle: () => Promise<void>): Promise<void> {
    const step = async () => {
      this.turn = id;
      this.lines = [];
      try {
        await handle();
      } catch (e) {
        this.lines.push(`처리하지 못했습니다: ${(e as Error).message}`);
      }
      this.flush(false);
    };
    const p = this.chain.then(step, step);
    this.chain = p;
    return p;
  }

  /** 기다리던 질문의 답. 기다리는 질문이 없으면 그렇게 답한다 */
  answer(id: string, text: string, promptId?: unknown): void {
    if (promptId !== undefined && (!this.prompt || promptId !== this.prompt.id || Date.now() >= this.prompt.expiresAt)) {
      this.sendToServer({ type: 'reply', id, text: '이미 끝난 질문입니다. 현재 질문에 답해 주세요.', waiting: !!this.waiter, ...(this.waiter && this.prompt ? { prompt: this.prompt } : {}) });
      return;
    }
    const w = this.waiter;
    if (!w) {
      this.sendToServer({ type: 'reply', id, text: '기다리는 질문이 없습니다.', waiting: false });
      return;
    }
    this.waiter = null;
    this.turn = id;
    this.lines = [];
    w(text);
  }

  /** 연결이 끊기면 기다리던 질문을 끝낸다 */
  cancelWaiting(): void {
    this.activeAbort?.abort();
    this.prompt = null;
    const w = this.waiter;
    this.waiter = null;
    // 대기 질문만 끝낸다. 현재 잠금 명령의 답을 보낼 요청 번호는 유지한다.
    if (w) {
      this.turn = null;
      w(null);
    }
  }

  private flush(waiting: boolean): void {
    const id = this.turn;
    this.turn = null;
    if (id) this.sendToServer({ type: 'reply', id, text: this.lines.join('\n'), waiting, ...(waiting && this.prompt ? { prompt: this.prompt } : {}) });
    this.lines = [];
  }

  private wait(ms: number): Promise<string | null> {
    this.flush(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, ms);
      this.waiter = (text) => {
        clearTimeout(t);
        resolve(text);
      };
    });
  }

  async send(text: string): Promise<void> {
    if (text) this.lines.push(text);
  }

  async ask(question: string, detail: string, timeoutMs: number, { destructive = false }: { destructive?: boolean } = {}): Promise<'yes' | 'no' | 'timeout'> {
    const abort = new AbortController();
    this.activeAbort = abort;
    const expiresAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    this.prompt = { id: randomUUID(), kind: 'confirm', expiresAt, destructive };
    try {
      this.lines.push([detail, `${question} 예/아니오로 답해 주세요 (${Math.round(timeoutMs / 1000)}초 안에).`].filter(Boolean).join('\n'));
      while (!abort.signal.aborted && Date.now() < expiresAt) {
        const a = await this.wait(Math.max(1, expiresAt - Date.now()));
        if (a === null || abort.signal.aborted) return 'timeout';
        const decision = await decideConfirmation(question, a, this.interpret, abort.signal);
        if (abort.signal.aborted || Date.now() >= expiresAt) return 'timeout';
        if (decision !== 'unknown') return decision;
        this.lines.push(CONFIRM_AGAIN);
      }
      return 'timeout';
    } finally {
      clearTimeout(timer); abort.abort();
      if (this.activeAbort === abort) { this.activeAbort = null; this.prompt = null; }
    }
  }

  async choose(message: string, options: string[], timeoutMs: number): Promise<number | null> {
    this.prompt = { id: randomUUID(), kind: 'choice', expiresAt: Date.now() + timeoutMs, options: options.slice(0, 20).map(o => o.slice(0, 500)) };
    try {
      this.lines.push([message, ...options.map((o, i) => `${i + 1}. ${o}`), `번호를 누르거나 보내세요 (${Math.round(timeoutMs / 1000)}초 안에).`].join('\n'));
      const a = await this.wait(timeoutMs);
      const n = a !== null && /^\d+$/.test(a.trim()) ? Number(a.trim()) : NaN;
      return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : null;
    } finally { this.prompt = null; }
  }

  /** 서버에 올리면 비서 봇이 명령한 사람의 DM으로 보낸다. 메시지 번호와 자동 삭제는 서버가 맡는다 */
  async sendFile(filePath: string, name: string, text: string): Promise<{ channelId: string; messageId: string }> {
    if (!this.turn || !this.upload) throw new Error('진행 중인 요청이 없습니다.');
    await this.upload(this.turn, filePath, name, text);
    this.lines.push(`${name}을(를) DM으로 보냅니다.`);
    return { channelId: '', messageId: '' };
  }

  async deleteMessage(): Promise<void> {
    /* 비서 봇이 올린 메시지는 서버가 지운다 */
  }
}

/** 서버 메시지를 hub로 넘긴다 */
export function handleServerMessage(t: ServerTransport, m: ServerMessage, onMessage: (msg: IncomingMessage) => Promise<void>): void {
  const id = typeof m.id === 'string' ? m.id : '';
  const text = typeof m.text === 'string' ? m.text : '';
  if (!id) return;
  if (m.type === 'answer') t.answer(id, text, m.promptId);
  else if (m.type === 'command') {
    if (['잠금', '인증 폐기', '원격 중지'].includes(remoteControlText(text))) t.cancelWaiting();
    void t.run(id, () => onMessage({ id, authorId: '', text, channel: m.channel === true, files: incomingFiles(m.files) }));
  }
}

function incomingFiles(raw: unknown): IncomingFile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f.url === 'string' && isDiscordFileUrl(f.url))
    .map((f) => ({ id: String(f.id || f.url), name: String(f.name || 'file'), size: Number(f.size) || 0, url: f.url }));
}
