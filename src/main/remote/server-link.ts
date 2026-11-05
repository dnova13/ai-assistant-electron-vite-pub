// 비서 서버와의 연결. 앱이 먼저 연결을 열어 두고, 첫 메시지로 키와 컴퓨터 번호를 보낸다 (주소에 키를 넣지 않는다).
// 끊기면 간격을 늘려 다시 연결한다. 서버가 거절한 연결(키 틀림, 등록 없음, 다른 곳에서 연결)은 다시 연결하지 않는다.
// 이 단계에서는 연결만 유지한다. 파일 지시는 받지 않는다.
export const PING_MS = 30_000;
export const PONG_WAIT_MS = 20_000;
export const HELLO_WAIT_MS = 15_000;
export const RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

export type LinkState = 'off' | 'connecting' | 'connected' | 'waiting';
export type RejectReason = 'bad_key' | 'unknown_computer' | 'replaced';

export interface LinkStatus {
  state: LinkState;
  error: string;
}

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(text: string): void;
  close(): void;
}

export interface ServerLinkOptions {
  url: string;
  key: string;
  computerId: string;
  onChange: (status: LinkStatus) => void;
  /** 서버가 거절했다. 등록 없음이면 부르는 쪽이 스위치를 끈다 */
  onRejected?: (reason: RejectReason) => void;
  /** 서버에서 이름을 바꿨다 */
  onRenamed?: (name: string) => void;
  /** 그 밖의 메시지 (command, answer) */
  onMessage?: (message: Record<string, unknown>) => void;
  /** 연결이 끊겼다 */
  onDown?: () => void;
  createSocket?: (url: string) => SocketLike;
}

const REJECT_TEXT: Record<RejectReason, string> = {
  bad_key: 'API 키가 맞지 않습니다. 설정 > AI에서 이 프로필의 키를 확인하세요.',
  unknown_computer: '서버에 등록되어 있지 않습니다. 다시 등록하세요.',
  replaced: '같은 컴퓨터 번호로 다른 곳에서 연결해 여기서는 끊었습니다.'
};

export class ServerLink {
  status: LinkStatus = { state: 'off', error: '' };
  private socket: SocketLike | null = null;
  private retries = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: ServerLinkOptions) {}

  start(): void {
    this.stopped = false;
    this.retries = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.drop();
    this.set({ state: 'off', error: '' });
  }

  /** 서버로 보낸다. 연결돼 있지 않으면 버린다 */
  send(message: Record<string, unknown>): void {
    if (this.status.state !== 'connected' || !this.socket) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      this.lost('서버와 연결이 끊겼습니다.');
    }
  }

  private set(status: LinkStatus): void {
    this.status = status;
    this.o.onChange(status);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.retryTimer = this.pingTimer = this.waitTimer = null;
  }

  /** 지금 연결을 버린다. 늦게 오는 이벤트는 무시한다 */
  private drop(): void {
    this.clearTimers();
    if (this.socket && this.o.onDown) this.o.onDown();
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      /* 이미 닫힘 */
    }
  }

  private lost(error: string): void {
    this.drop();
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries += 1;
    this.set({ state: 'waiting', error });
    this.retryTimer = setTimeout(() => this.open(), wait);
  }

  private expectWithin(ms: number, error: string): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => this.lost(error), ms);
  }

  private open(): void {
    this.drop();
    this.set({ state: 'connecting', error: this.status.error });
    let s: SocketLike;
    try {
      s = this.o.createSocket ? this.o.createSocket(this.o.url) : (new WebSocket(this.o.url) as unknown as SocketLike);
    } catch {
      this.lost('서버 주소가 올바르지 않습니다.');
      return;
    }
    this.socket = s;
    this.expectWithin(HELLO_WAIT_MS, '서버가 응답하지 않습니다.');
    s.onopen = () => s.send(JSON.stringify({ type: 'hello', key: this.o.key, computer_id: this.o.computerId }));
    s.onmessage = (ev) => this.onMessage(ev.data);
    s.onclose = () => this.lost('서버와 연결이 끊겼습니다.');
    s.onerror = () => this.lost('서버에 연결하지 못했습니다.');
  }

  private onMessage(data: unknown): void {
    let m: { type?: unknown; reason?: unknown; name?: unknown; [k: string]: unknown };
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m.type === 'welcome') {
      this.retries = 0;
      if (this.waitTimer) clearTimeout(this.waitTimer);
      this.waitTimer = null;
      this.set({ state: 'connected', error: '' });
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    } else if (m.type === 'pong') {
      if (this.waitTimer) clearTimeout(this.waitTimer);
      this.waitTimer = null;
    } else if (m.type === 'renamed') {
      if (typeof m.name === 'string' && this.o.onRenamed) this.o.onRenamed(m.name);
    } else if (m.type === 'rejected') {
      const reason = String(m.reason) as RejectReason;
      this.stopped = true;
      this.drop();
      this.set({ state: 'off', error: REJECT_TEXT[reason] || '서버가 연결을 거절했습니다.' });
      if (this.o.onRejected) this.o.onRejected(reason);
    } else if (this.o.onMessage) {
      this.o.onMessage(m);
    }
  }

  private ping(): void {
    try {
      this.socket?.send(JSON.stringify({ type: 'ping' }));
    } catch {
      this.lost('서버와 연결이 끊겼습니다.');
      return;
    }
    this.expectWithin(PONG_WAIT_MS, '서버가 응답하지 않습니다.');
  }
}
