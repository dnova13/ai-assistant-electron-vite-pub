// 메신저(디스코드)에서 온 메시지를 처리한다. 메신저 종류와 상관없는 규칙은 모두 여기 있다 (디스코드 연결은 discord.ts).
// 규칙:
// - 내 계정(설정의 사용자 ID)이 보낸 것만 받는다.
// - 앱 직접 연결과 비서 서버 지정 채널은 일반 기능에 선행 인증. 비서 서버 DM은 기존 파일 동작별 인증을 유지한다.
// - 인증 뒤: 열기·위치 보기·폴더 만들기·보내기는 바로, 이동·복사·이름 바꾸기·백업은 확인 한 번, 삭제는 두 번 ("삭제하겠습니까?", "정말로 삭제하겠습니까?").
// - 허용 폴더 검사·실행은 앱의 broker가 한다 (앱에서 직접 할 때와 같은 검사).
// - 원격 중지면 일반 기능을 거부하고 인증·복구·도움말·잠금/중지 제어만 처리한다.
import { YES } from '@shared/confirmation';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionArgs, ActionReport, ReceivedDownload, RemoteEvent, Settings } from '@shared/types';
import { ACTION_NAMES, REMOTE_HELP, isSupportedAction, normalizeFileText, parseLocalCommand } from '@shared/commands';
import { AUTH_HELP, AUTH_REQUIRED, CHANNEL_AUTH_REQUIRED, remoteControlText } from '@shared/remote-auth';
import { formatBytes, formatMinutes, isReceivedExecutable, resultHead, uniqueName } from '@shared/local-files';
import type { ToolBroker } from '../tools/broker';
import type { RemoteState } from './state';
import type { SentStore } from './sent';
import * as policy from '../tools/policy';
import type { Root } from '../tools/policy';

export const SOURCE_LABEL = '디스코드';
/** 확인을 기다리는 시간 (앱의 확인 창과 같다) */
export const ASK_MS = 60_000;
/** 한 번에 보낼 수 있는 파일 크기 (디스코드 봇 업로드 한도에 맞춘 값) */
export const MAX_SEND_BYTES = 20 * 1024 * 1024;
/** 비정상적으로 많은 요청: 10분에 파일 명령 30번, 1시간에 보내기 30번이 넘으면 원격 중지 */
export const RATE = { windowMs: 10 * 60_000, maxActions: 30, sendWindowMs: 60 * 60_000, maxSends: 30, maxBadCodes: 5 };

export interface IncomingFile {
  id: string;
  name: string;
  size: number;
  url: string;
}

export interface IncomingMessage {
  /** 지정 채널의 파일 요청은 검색도 인증 후에만 처리한다. */
  channel?: boolean;
  id: string;
  authorId: string;
  text: string;
  files: IncomingFile[];
}

/** 메신저 연결이 해 주는 일 (시험에서는 가짜를 넣는다) */
export interface Transport {
  /** 인증 종료·연결 해제 시 진행 중인 확인을 취소한다. */
  cancelWaiting?(): void;
  send(text: string): Promise<void>;
  /** 예/아니오 묻기 */
  ask(question: string, detail: string, timeoutMs: number, options?: { destructive: boolean }): Promise<'yes' | 'no' | 'timeout'>;
  /** 후보 중 고르기 (번호 0부터, 취소·시간 초과면 null) */
  choose(message: string, options: string[], timeoutMs: number): Promise<number | null>;
  sendFile(filePath: string, name: string, text: string): Promise<{ channelId: string; messageId: string }>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
}

/** 요청·틀린 코드 횟수. 앱 봇과 비서 봇이 함께 센다 */
export interface HubCounters {
  actionTimes: number[];
  sendTimes: number[];
  badCodes: number[];
  stoppedByBadCodes: boolean;
}

export const newHubCounters = (): HubCounters => ({ actionTimes: [], sendTimes: [], badCodes: [], stoppedByBadCodes: false });

export interface HubOptions {
  prepareRequest?: () => Promise<string | void>;
  /** 앱 직접 연결: 대화·찾기·첨부도 인증 후에만 처리한다. */
  requireAuthentication?: boolean;
  broker: ToolBroker;
  state: RemoteState;
  sent: SentStore;
  getSettings: () => Settings;
  getRoots: () => Root[];
  /** 받은 파일 폴더 (만들어 둔다) */
  getReceivedDir: () => string;
  /** 화면(대화창)에 알린다 */
  emit: (ev: RemoteEvent) => void;
  /** 자연어 해석·대화. void면 파일 작업 결과를 이미 메신저로 보낸 상태다. */
  chat: (text: string, context?: { channel: boolean }) => Promise<string | void>;
  /** 받은 파일 내려받기 (시험에서는 가짜) */
  fetchFile?: (url: string) => Promise<Buffer>;
  now?: () => number;
  /** false면 계정을 검사하지 않는다 (비서 봇: 서버가 등록한 사람만 보낸다) */
  checkAuthor?: boolean;
  /** 실행 기록에 남길 출처 */
  via?: string;
  /** 다른 입구와 함께 셀 때 */
  counters?: HubCounters;
}

// 확인 답변 규칙은 화면·두 원격 연결이 함께 사용한다.


export class RemoteHub {
  private o: HubOptions;
  private now: () => number;
  transport: Transport | null = null;
  /** 잠겨 있어서 멈춰 둔 요청 (인증하면 이어서 한다, 60초) */
  private pending: { action: string; args: ActionArgs; at: number } | null = null;
  private received = new Map<string, IncomingFile & { at: number }>();
  /** 요청 횟수와 틀린 코드 (10분에 5번 넘게 틀리면 원격 중지: 코드 맞히기 막기. 그러면 메신저의 코드로는 다시 못 켠다) */
  private counters: HubCounters;
  stoppedByBadCodes = false;
  /** 한 번에 하나씩 (확인을 기다리는 동안 다음 메시지가 끼어들지 않게) */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: HubOptions) {
    this.counters = o.counters || newHubCounters();
    this.o = o;
    this.now = o.now || Date.now;
  }

  private get t(): Transport {
    if (!this.transport) throw new Error('메신저에 연결되어 있지 않습니다.');
    return this.transport;
  }

  private line(role: 'user' | 'sys' | 'err', text: string): void {
    this.o.emit({ type: 'line', role, text, source: SOURCE_LABEL });
  }

  /** 메신저와 대화창에 같은 말을 남긴다 */
  private async say(text: string, role: 'sys' | 'err' = 'sys'): Promise<void> {
    this.line(role, text);
    await this.t.send(text);
  }

  private unlockMinutes(): number {
    return this.o.getSettings().remote.unlockMinutes;
  }

  /** 메신저에서 메시지가 왔다 */
  onMessage(msg: IncomingMessage): Promise<void> {
    const run = () => this.handle(msg).catch((e) => console.error('원격 메시지 처리 실패:', e));
    // 확인 답변을 기다리는 중에도 잠금·중지는 즉시 적용한다. 사용자 검사는 handle에서 한다.
    if (['잠금', '인증 폐기', '원격 중지'].includes(remoteControlText(msg.text || ''))) return run();
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  /** 인증 키는 유지하고 현재 인증·대기 요청만 끝낸다. */
  resetAuthentication(): void {
    this.o.state.lock();
    this.pending = null;
    this.transport?.cancelWaiting?.();
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    const me = this.o.getSettings().remote.discord.userId;
    if (this.o.checkAuthor !== false && (!me || msg.authorId !== me)) return; // 내 계정이 아니면 무시 (답도 안 한다)
    const text = (msg.text || '').trim();
    const control = remoteControlText(text);
    const code = /^(?:인증\s*)?(\d{3}\s?\d{3})$/.exec(control);
    const recovery = /^복구\s+(\S+)$/.exec(control);
    const cmd = parseLocalCommand(text);
    if (/^인증(?:\s|$)/.test(control) && !code && control !== '인증 폐기') return this.t.send(AUTH_HELP);
    if (/^(도움말|help|\?)$/i.test(control)) return this.t.send(REMOTE_HELP);
    if (cmd && 'help' in cmd) return this.t.send(REMOTE_HELP);
    if (control === '상태') return this.t.send(this.statusText());
    if (control === '잠금' || control === '인증 폐기') {
      this.resetAuthentication();
      return this.say('현재 인증을 종료하고 잠갔습니다. 다시 사용하려면 인증 <6자리 코드>를 보내 주세요.');
    }
    if (control === '원격 중지') {
      this.resetAuthentication();
      this.o.state.setStopped(true);
      return this.say('원격 중지했습니다. 이제 모든 원격 요청을 거부합니다. 다시 켜려면 인증 코드를 보내거나 앱에서 켜세요.');
    }

    if (this.o.state.isStopped()) {
      if (code) return this.unlock(code[1]);
      if (recovery) return this.recover(recovery[1]);
      await this.t.send('원격 중지 상태입니다. 다시 켜려면 "인증 <6자리 코드>"를 보내거나 컴퓨터의 앱에서 켜세요.');
      return;
    }

    if (code) return this.unlock(code[1]);
    if (recovery) return this.recover(recovery[1]);
    if ((this.o.requireAuthentication || msg.channel) && !this.o.state.isUnlocked()) return this.t.send(msg.channel ? CHANNEL_AUTH_REQUIRED : AUTH_REQUIRED);
    const epoch = this.o.state.authorizationVersion();
    const guide = this.o.prepareRequest ? await this.o.prepareRequest() : undefined;
    if (epoch !== this.o.state.authorizationVersion()) return;
    if (guide) return this.t.send(guide);
    for (const f of msg.files) this.onFile(f);
    if (msg.files.length && !text) return;

    if (cmd) {
      if ('help' in cmd) return this.t.send(REMOTE_HELP);
      this.line('user', text);
      await this.runAction(cmd.action, cmd.args, { kind: 'command', id: msg.id, channel: !!msg.channel });
      return;
    }
    if (!text) return;

    // 그 밖의 말은 대화: 앱에서 고른 캐릭터가 답한다 (대화창에 한 줄로 이어진다)
    let answer: string | void = '';
    try {
      answer = await this.o.chat(normalizeFileText(text), { channel: !!msg.channel });
    } catch (e) {
      answer = `답하지 못했습니다: ${(e as Error).message}`;
      this.line('err', answer);
    }
    if (epoch === this.o.state.authorizationVersion() && typeof answer === 'string') await this.t.send(answer || '(답이 없습니다)');
  }

  private statusText(): string {
    const st = this.o.state;
    const until = st.unlockedUntil();
    return [
      `잠금: ${until ? `풀림 (${new Date(until).toLocaleString('ko-KR')}까지)` : '잠김'}`,
      `원격 중지: ${st.isStopped() ? '예' : '아니오'}`,
      `잠금 해제 시간 설정: ${formatMinutes(this.unlockMinutes())}`
    ].join('\n');
  }

  /** 틀린 코드를 세고, 너무 많으면 원격 중지. 중지했으면 true */
  private async badCode(): Promise<boolean> {
    const t = this.now();
    this.counters.badCodes = this.counters.badCodes.filter((x) => t - x < RATE.windowMs);
    this.counters.badCodes.push(t);
    if (this.counters.badCodes.length <= RATE.maxBadCodes) return false;
    this.counters.badCodes = [];
    this.o.state.setStopped(true);
    this.pending = null;
    await this.say('코드가 여러 번 틀려 원격 중지했습니다. 컴퓨터의 앱 설정 > 원격에서 다시 켜세요.', 'err');
    return true;
  }

  private async unlock(code: string): Promise<void> {
    if (!this.o.state.hasKey()) {
      await this.t.send('인증 앱 키가 아직 없습니다. 컴퓨터의 앱 설정 > 원격에서 키를 만드세요.');
      return;
    }
    const min = this.unlockMinutes();
    if (this.o.state.isStopped() && this.counters.stoppedByBadCodes) {
      await this.t.send('코드가 여러 번 틀려 원격 중지된 상태입니다. 컴퓨터의 앱에서 다시 켜야 합니다.');
      return;
    }
    if (!this.o.state.unlockWithCode(code, min)) {
      this.line('err', '원격 인증 실패 (코드가 틀렸거나 이미 쓴 코드)');
      if (await this.badCode()) {
        this.counters.stoppedByBadCodes = true;
        return;
      }
      await this.t.send('코드가 틀렸거나 이미 쓴 코드입니다. 인증 앱의 새 코드를 보내 주세요.');
      return;
    }
    this.counters.badCodes = [];
    await this.say(`인증했습니다. ${formatMinutes(min)} 동안 잠금이 풀립니다.`);
    await this.resumePending();
  }

  private async recover(code: string): Promise<void> {
    const min = this.unlockMinutes();
    if (this.o.state.isStopped() && this.counters.stoppedByBadCodes) {
      await this.t.send('코드가 여러 번 틀려 원격 중지된 상태입니다. 컴퓨터의 앱에서 다시 켜야 합니다.');
      return;
    }
    if (!this.o.state.unlockWithRecovery(code, min)) {
      this.line('err', '원격 복구 코드 실패');
      if (await this.badCode()) {
        this.counters.stoppedByBadCodes = true;
        return;
      }
      await this.t.send('복구 코드가 틀렸거나 이미 쓴 코드입니다.');
      return;
    }
    this.counters.badCodes = [];
    await this.say(`복구 코드로 인증했습니다 (그 코드는 다시 못 씁니다). ${formatMinutes(min)} 동안 잠금이 풀립니다. 폰을 바꿨다면 앱에서 키를 새로 만드세요.`);
    await this.resumePending();
  }

  private async resumePending(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (p && this.now() - p.at < ASK_MS) await this.runAction(p.action, p.args, { kind: 'command', id: 'resume' });
  }

  /** 요청이 너무 많으면 원격 중지 (계정 탈취 의심) */
  private overLimit(action: string): boolean {
    const t = this.now();
    this.counters.actionTimes = this.counters.actionTimes.filter((x) => t - x < RATE.windowMs);
    this.counters.actionTimes.push(t);
    if (action === 'file.send') {
      this.counters.sendTimes = this.counters.sendTimes.filter((x) => t - x < RATE.sendWindowMs);
      this.counters.sendTimes.push(t);
    }
    return this.counters.actionTimes.length > RATE.maxActions || this.counters.sendTimes.length > RATE.maxSends;
  }

  /**
   * 파일 명령 하나. kind=command: 메신저에서 직접 보낸 "파일 …", kind=server: 메신저 대화 중 AI 서버가 요청한 작업.
   * 확인·결과는 메신저로, 같은 내용을 대화창에도 남긴다.
   */
  async runAction(action: string, args: ActionArgs, origin: { kind: 'command' | 'server'; id: string; channel?: boolean }): Promise<ActionReport> {
    const t = this.t;
    const requireAuthentication = this.o.requireAuthentication || origin.channel;
    if (requireAuthentication && !this.o.state.isUnlocked()) {
      await t.send(origin.channel ? CHANNEL_AUTH_REQUIRED : AUTH_REQUIRED);
      return { status: 'rejected', detail: '인증 필요' };
    }
    const epoch = this.o.state.authorizationVersion();
    const guide = this.o.prepareRequest ? await this.o.prepareRequest() : undefined;
    if (epoch !== this.o.state.authorizationVersion()) return { status: 'rejected', detail: '인증이 종료되어 취소했습니다.' };
    if (guide) { await t.send(guide); return { status: 'rejected', detail: guide }; }
    const stillAllowed = () => epoch === this.o.state.authorizationVersion() && !this.o.state.isStopped()
      && (action === 'file.search' && !requireAuthentication || this.o.state.isUnlocked());
    if (!isSupportedAction(action)) {
      await this.say(`지원하지 않는 작업입니다: ${action}`, 'err');
      return { status: 'failed', detail: `지원하지 않는 작업: ${action}` };
    }
    if (this.o.state.isStopped()) {
      await t.send('원격 중지 상태라 거부했습니다.');
      return { status: 'rejected', detail: '원격 중지 상태' };
    }
    if (action !== 'file.search') {
      if (!this.o.state.hasKey()) {
        await this.say('인증 앱 키가 없어 파일 명령을 쓸 수 없습니다. 컴퓨터의 앱 설정 > 원격에서 키를 만드세요.', 'err');
        return { status: 'rejected', detail: '인증 키 없음' };
      }
      if (!this.o.state.isUnlocked()) {
        this.pending = { action, args, at: this.now() };
        await t.send('잠겨 있습니다. 인증 앱의 6자리 코드를 보내 주세요 (예: 인증 123456). 60초 안에 인증하면 이 요청을 이어서 합니다.');
        return { status: 'rejected', detail: '잠겨 있음 (인증 필요)' };
      }
      if (this.overLimit(action)) {
        this.o.state.setStopped(true);
        await this.say('짧은 시간에 요청이 너무 많아 원격 중지했습니다. 본인이 맞다면 인증 코드를 보내 다시 켜세요.', 'err');
        return { status: 'rejected', detail: '요청이 너무 많아 원격 중지' };
      }
    }

    if (!this.o.getRoots().length) {
      await this.say('원격 허용 폴더가 없습니다. 컴퓨터의 앱 설정 > 파일 제어 > 허용 경로에서 폴더의 "원격 허용"을 체크하세요.', 'err');
      return { status: 'rejected', detail: '원격 허용 폴더 없음' };
    }
    const broker = this.o.broker;
    let a: ActionArgs = { ...args };
    for (let step = 0; step < 4; step++) {
      const res = await broker.prepareAsync({ action, args: a, source: { kind: 'remote', id: origin.id, via: this.o.via } });
      if (!stillAllowed()) {
        if (res.status === 'ready') broker.cancel(res.id);
        return { status: 'rejected', detail: '인증이 종료되어 취소했습니다.' };
      }
      if (res.status === 'error') {
        await this.say(res.message, 'err');
        return { status: 'failed', detail: res.message };
      }
      if (res.status === 'result') {
        const head = resultHead(res);
        this.line('sys', head);
        const items = res.rootList ? res.items : res.items.slice(0, 20);
        await t.send(items.length ? `${head}\n${items.map((x) => `• ${x.display}`).join('\n')}` : head);
        return { status: 'done', detail: head };
      }
      if (res.status === 'choice') {
        const i = await t.choose(res.message, res.options.map((o) => o.display), ASK_MS);
        if (!stillAllowed()) return { status: 'rejected', detail: '인증이 종료되어 취소했습니다.' };
        if (i === null || !res.options[i]) {
          await this.say('취소했습니다.');
          return { status: 'rejected', detail: '사용자가 취소했습니다.' };
        }
        a = { ...a, [res.field]: res.options[i].path };
        continue;
      }
      // ready: 확인 질문 (앱과 같은 문구, 삭제는 두 번)
      const s = res.summary;
      const name = ACTION_NAMES[s.action] || s.action;
      const detail = [`${name}: ${s.from}`, s.to ? `→ ${s.to}` : '', ...s.warnings].filter(Boolean).join('\n');
      for (const q of s.questions) {
        const ans = await t.ask(q, detail, Math.max(1000, res.expiresInMs - 2000), { destructive: s.action === 'file.delete' });
        if (!stillAllowed()) {
          broker.cancel(res.id);
          return { status: 'rejected', detail: '인증이 종료되어 취소했습니다.' };
        }
        if (ans !== 'yes') {
          broker.cancel(res.id);
          const expired = ans === 'timeout';
          await this.say(expired ? '시간이 지나 취소했습니다.' : '취소했습니다.');
          return { status: expired ? 'expired' : 'rejected', detail: expired ? '확인 시간이 지났습니다.' : '사용자가 취소했습니다.' };
        }
      }
      if (s.action === 'file.send') return this.sendFile(res.id);
      const out = await broker.execute(res.id);
      await this.say(out.message, out.ok ? 'sys' : 'err');
      return { status: out.ok ? 'done' : out.status === 'expired' ? 'expired' : 'failed', detail: out.message };
    }
    return { status: 'failed', detail: '처리하지 못했습니다.' };
  }

  private async sendFile(id: string): Promise<ActionReport> {
    const taken = this.o.broker.take(id);
    if (!taken) {
      await this.say('시간이 지났습니다. 다시 요청해 주세요.', 'err');
      return { status: 'expired', detail: '시간 초과' };
    }
    const { plan } = taken;
    // 보내기 직전에 다시 검사 (허용 폴더 안인지, 그 사이 바뀌지 않았는지)
    const c = policy.checkExisting(plan.src, this.o.getRoots());
    if (!c.ok || c.isDir) {
      const why = c.ok ? '폴더는 보낼 수 없습니다.' : c.reason;
      this.o.broker.record(taken, 'failed', { reason: why });
      await this.say(why, 'err');
      return { status: 'failed', detail: why };
    }
    const size = fs.statSync(c.real).size;
    if (size > MAX_SEND_BYTES) {
      const why = `파일이 너무 큽니다 (${formatBytes(size)}). 메신저로는 ${formatBytes(MAX_SEND_BYTES)}까지 보냅니다.`;
      this.o.broker.record(taken, 'failed', { reason: why });
      await this.say(why, 'err');
      return { status: 'failed', detail: why };
    }
    const name = path.basename(c.real);
    try {
      const r = await this.t.sendFile(c.real, name, `${plan.display.src} (${formatBytes(size)})`);
      if (r.messageId) this.o.sent.add({ messenger: 'discord', channelId: r.channelId, messageId: r.messageId, sentAt: this.now(), name }, { size, from: c.real });
      this.o.broker.record(taken, 'done', { messageId: r.messageId });
      const msg = `${plan.display.src}을(를) 보냈습니다.`;
      this.line('sys', msg);
      return { status: 'done', detail: msg };
    } catch (e) {
      const why = `보내지 못했습니다: ${(e as Error).message}`;
      this.o.broker.record(taken, 'failed', { reason: why });
      await this.say(why, 'err');
      return { status: 'failed', detail: why };
    }
  }

  /* ---------------- 받은 파일 ---------------- */

  private onFile(f: IncomingFile): void {
    this.received.set(f.id, { ...f, at: this.now() });
    this.o.emit({ type: 'received', fileId: f.id, name: f.name, size: f.size, executable: isReceivedExecutable(f.name), source: SOURCE_LABEL });
    void this.t.send(`파일을 받았습니다: ${f.name} (${formatBytes(f.size)}). 컴퓨터의 앱에서 "다운로드"를 눌러야 저장됩니다.`).catch(() => {});
  }

  hasFile = (fileId: string): boolean => this.received.has(fileId);

  /** 앱의 다운로드 버튼: 받은 파일 폴더에 저장 (같은 이름이면 날짜·번호를 붙임) */
  async download(fileId: string): Promise<ReceivedDownload> {
    const f = this.received.get(fileId);
    const fail = (message: string): ReceivedDownload => ({ ok: false, path: '', display: '', executable: false, message });
    if (this.o.requireAuthentication && !this.o.state.isUnlocked()) return fail('먼저 디스코드 DM에서 인증해 주세요.');
    const epoch = this.o.state.authorizationVersion();
    if (!f) return fail('받은 파일 정보가 없습니다 (앱을 다시 켜면 사라집니다). 메신저에서 다시 보내 주세요.');
    const dir = this.o.getReceivedDir();
    const executable = isReceivedExecutable(f.name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const safe = path.basename(f.name).replace(/[<>:"\\|?*\u0000-\u001f]/g, '_') || 'file';
      const name = uniqueName(safe, (n) => fs.existsSync(path.join(dir, n)));
      const target = path.join(dir, name);
      const nameErr = policy.checkName(name);
      if (nameErr) return fail(nameErr);
      const buf = await (this.o.fetchFile || defaultFetch)(f.url);
      if (this.o.requireAuthentication && (epoch !== this.o.state.authorizationVersion() || !this.o.state.isUnlocked())) return fail('인증이 종료되어 저장하지 않았습니다.');
      fs.writeFileSync(target, buf, { flag: 'wx' });
      const c = policy.checkExisting(target, this.o.getRoots());
      const display = c.ok ? c.display : name;
      return { ok: true, path: target, display, executable, message: `${display}에 저장했습니다.` };
    } catch (e) {
      return fail(`내려받지 못했습니다: ${(e as Error).message}`);
    }
  }

  /* ---------------- 보낸 파일 자동 삭제 ---------------- */

  /** 올린 날짜 기준 days일이 지난 보낸 파일 메시지를 지운다. all=true면 날짜와 상관없이 모두 */
  async deleteSent(opts: { all?: boolean } = {}): Promise<{ deleted: number; failed: number }> {
    if (!this.transport) return { deleted: 0, failed: 0 };
    const recs = opts.all ? this.o.sent.all() : this.o.sent.due(this.o.getSettings().remote.sentDeleteDays, this.now());
    const done: string[] = [];
    let failed = 0;
    for (const r of recs) {
      try {
        await this.transport.deleteMessage(r.channelId, r.messageId);
        done.push(r.messageId);
      } catch (e) {
        const code = (e as { code?: number; status?: number }).code;
        const status = (e as { status?: number }).status;
        // 이미 없는 메시지(사용자가 지움)는 목록에서 뺀다
        if (code === 10008 || status === 404) done.push(r.messageId);
        else failed++;
      }
    }
    this.o.sent.remove(done);
    return { deleted: done.length, failed };
  }
}

async function defaultFetch(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export { YES };
