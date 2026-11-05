// 목소리 관련: 립싱크(소리 크기 → 입 모양), 문장 단위 TTS 재생(서버 / 이 컴퓨터 내장), 마이크 녹음(말이 멈추면 자동으로 끝내기).
// React와 상관없는 코드다. 입 모양은 초당 60번 바뀌므로 React 상태로 다루지 않는다.
import type { TtsResult, TtsSource } from '@shared/types';
import { MicMeter, VadLogic, openMic, type VadEvent, type VadOptions } from './vad';

/* ---------------- 립싱크 ---------------- */

export class LipSync {
  private onLevel: (v: number) => void;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Float32Array<ArrayBuffer> | null = null;
  private src: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private level = 0;

  constructor(onLevel: (v: number) => void) {
    this.onLevel = onLevel;
  }

  private ensure(): { ctx: AudioContext; analyser: AnalyserNode; data: Float32Array<ArrayBuffer> } {
    if (!this.ctx || !this.analyser || !this.data) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      // 입 모양은 음량과 상관없이 원래 소리 크기로 재고, 음량은 그 뒤에서 줄인다
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.analyser.connect(this.gain).connect(this.ctx.destination);
      this.data = new Float32Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return { ctx: this.ctx, analyser: this.analyser, data: this.data };
  }

  /** 음량 0~1 */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  attach(audio: HTMLAudioElement): void {
    const { ctx, analyser, data } = this.ensure();
    this.detach();
    this.src = ctx.createMediaElementSource(audio);
    this.src.connect(analyser);
    // requestAnimationFrame은 창이 숨겨지면 멈춘다 (대화 창을 숨기고 마스코트만 볼 때) → 타이머 사용
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const target = Math.min(1, Math.max(0, (rms - 0.01) * 7));
      // 입은 빨리 열고 천천히 닫는다
      this.level += (target - this.level) * (target > this.level ? 0.6 : 0.25);
      this.onLevel(this.level);
    }, 1000 / 60);
  }

  detach(): void {
    if (this.src) {
      try {
        this.src.disconnect();
      } catch {
        /* 이미 끊김 */
      }
      this.src = null;
    }
    clearInterval(this.timer);
    this.level = 0;
    this.onLevel(0);
  }
}

/* ---------------- 문장 단위 TTS ---------------- */

// 문장 끝: 마침표·물음표·느낌표 뒤 공백, 또는 줄바꿈
const SENTENCE = /^[\s\S]*?(?:[.!?。！？…]+["'”’)\]]*\s+|\n+)/;

/** 읽지 않을 것(코드, 링크 주소, 마크다운 기호)을 뺀다 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // 코드 블록은 읽지 않는다
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitLong(text: string, max = 300): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(',', max), rest.lastIndexOf(' ', max));
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

interface QueueItem {
  text: string;
  gen: number;
  p: Promise<TtsResult | { error: Error }> | null;
}

/** 소리를 직접 내는 쪽 (이 컴퓨터 내장 목소리). 시험에서는 가짜를 넣는다 */
export interface Speaker {
  speak(text: string): Promise<void>;
  cancel(): void;
  available(): boolean;
}

export interface TtsQueueOptions {
  /** TTS 서버(또는 대화 서버)에서 소리를 받아 온다 */
  synth: (text: string) => Promise<TtsResult>;
  /** 이 컴퓨터 내장 목소리 */
  builtin: Speaker;
  lip: LipSync;
  onSpeaking?: (on: boolean) => void;
  /** 서버 목소리가 실패했고 내장으로 넘어가지 못할 때 */
  onError?: (e: Error) => void;
  /** 서버 목소리가 실패해서 내장 목소리로 읽기 시작할 때 (답 하나에 한 번) */
  onFallback?: (e: Error) => void;
}

/**
 * 문장 단위로 읽는다. 답이 흘러나오는 동안에도 문장이 끝날 때마다 읽기 시작한다.
 * mode: builtin = 이 컴퓨터 목소리, server = 서버에서 소리를 받아 재생 (다음 문장은 미리 요청)
 * 서버가 실패하면 fallback이 켜져 있을 때 그 답의 남은 문장을 내장 목소리로 읽는다.
 */
export class TtsQueue {
  enabled = false;
  mode: TtsSource = 'builtin';
  fallback = true;
  playing = false;
  /** 음량 0~1 (서버 소리). 이 컴퓨터 목소리는 BuiltinSpeaker.volume */
  volume = 1;
  /** 배속 0.5~2 (서버 소리, 음 높이는 그대로). 이 컴퓨터 목소리는 BuiltinSpeaker.rate */
  rate = 1;
  private synth: TtsQueueOptions['synth'];
  private builtin: Speaker;
  private lip: LipSync;
  private onSpeaking: (on: boolean) => void;
  private onError: (e: Error) => void;
  private onFallback: (e: Error) => void;
  private buf = '';
  private queue: QueueItem[] = [];
  private gen = 0;
  private failedGen = -1; // 이 답에서 서버가 실패함 → 남은 문장은 내장으로
  private current: HTMLAudioElement | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor({ synth, builtin, lip, onSpeaking, onError, onFallback }: TtsQueueOptions) {
    this.synth = synth;
    this.builtin = builtin;
    this.lip = lip;
    this.onSpeaking = onSpeaking || (() => {});
    this.onError = onError || (() => {});
    this.onFallback = onFallback || (() => {});
  }

  /** 스트림으로 온 글자를 받아 문장이 끝날 때마다 읽는다 */
  feed(text: string): void {
    if (!this.enabled) return;
    this.buf += text;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE.exec(this.buf))) {
      this.push(m[0]);
      this.buf = this.buf.slice(m[0].length);
    }
  }

  /** 답이 끝났을 때 남은 글자를 읽는다 */
  flush(): void {
    if (this.enabled && this.buf.trim()) this.push(this.buf);
    this.buf = '';
  }

  /** 지금 읽을 것이 없으면 바로, 있으면 다 읽은 뒤에 끝나는 약속 */
  whenIdle(): Promise<void> {
    if (!this.playing && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private push(sentence: string): void {
    const t = speakable(sentence);
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
    for (const part of splitLong(t)) this.queue.push({ text: part, gen: this.gen, p: null });
    void this.pump();
  }

  private load(item: QueueItem) {
    item.p = this.synth(item.text).catch((e: Error) => ({ error: e }));
    return item.p;
  }

  private useBuiltin(item: QueueItem): boolean {
    return this.mode === 'builtin' || item.gen === this.failedGen;
  }

  private async speakBuiltin(item: QueueItem): Promise<void> {
    try {
      await this.builtin.speak(item.text);
    } catch (e) {
      if (item.gen === this.gen) this.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    this.onSpeaking(true);
    while (this.queue.length) {
      const item = this.queue.shift()!;
      if (item.gen !== this.gen) continue;
      if (this.useBuiltin(item)) {
        await this.speakBuiltin(item);
        continue;
      }
      const cur = item.p || this.load(item);
      if (this.queue[0] && !this.queue[0].p && !this.useBuiltin(this.queue[0])) void this.load(this.queue[0]); // 다음 문장 미리 요청
      const r = await cur;
      if (item.gen !== this.gen) continue;
      if ('error' in r) {
        if (this.fallback && this.builtin.available()) {
          if (this.failedGen !== item.gen) {
            this.failedGen = item.gen;
            this.onFallback(r.error);
          }
          await this.speakBuiltin(item);
        } else this.onError(r.error);
        continue;
      }
      await this.play(r);
    }
    this.playing = false;
    this.onSpeaking(false);
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private play({ audio, mime }: TtsResult): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime || 'audio/wav' }));
      const a = new Audio(url);
      a.playbackRate = this.rate;
      this.current = a;
      let finished = false;
      const end = () => {
        if (finished) return;
        finished = true;
        URL.revokeObjectURL(url); // 받은 소리는 메모리에만 두고 다 읽으면 바로 푼다
        this.lip.detach();
        this.current = null;
        resolve();
      };
      a.onended = end;
      a.onerror = end;
      a.onpause = () => {
        if (a.currentTime < a.duration) end();
      };
      try {
        this.lip.setVolume(this.volume);
        this.lip.attach(a);
      } catch {
        a.volume = this.volume; // 립싱크 실패해도 소리는 낸다 (음량은 소리 요소에서)
      }
      a.play().catch(end);
    });
  }

  stop(): void {
    this.gen++;
    this.queue = [];
    this.buf = '';
    if (this.current) this.current.pause();
    this.builtin.cancel();
  }
}

/* ---------------- 이 컴퓨터 내장 목소리 ---------------- */

/**
 * 맥·윈도우에 들어 있는 목소리로 읽는다 (Chromium speechSynthesis). 설치·인터넷 필요 없음.
 * 소리 데이터를 주지 않아서 입 모양은 읽는 동안 단순하게 움직인다.
 */
export class BuiltinSpeaker implements Speaker {
  voice = '';
  rate = 1;
  /** 음량 0~1 */
  volume = 1;
  private synth: SpeechSynthesis | null;
  private onMouth: (v: number) => void;
  private mouthTimer: ReturnType<typeof setInterval> | undefined;
  private finish: (() => void) | null = null;

  constructor(onMouth: (v: number) => void = () => {}, synth: SpeechSynthesis | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null) {
    this.synth = synth;
    this.onMouth = onMouth;
  }

  voices(): SpeechSynthesisVoice[] {
    try {
      return this.synth ? this.synth.getVoices() : [];
    } catch {
      return [];
    }
  }

  /** 목소리 목록이 늦게 채워지면 알려 준다 */
  onVoicesChanged(cb: () => void): () => void {
    const s = this.synth;
    if (!s || typeof s.addEventListener !== 'function') return () => {};
    s.addEventListener('voiceschanged', cb);
    return () => s.removeEventListener('voiceschanged', cb);
  }

  available(): boolean {
    return this.voices().length > 0;
  }

  /** 고른 목소리 → 없으면 한국어 목소리 → 없으면 기본 */
  pick(): SpeechSynthesisVoice | null {
    const list = this.voices();
    return (this.voice && list.find((v) => v.name === this.voice)) || list.find((v) => /^ko/i.test(v.lang)) || null;
  }

  private mouth(on: boolean): void {
    clearInterval(this.mouthTimer);
    if (!on) {
      this.onMouth(0);
      return;
    }
    let phase = 0;
    this.mouthTimer = setInterval(() => {
      phase += 0.55 + Math.random() * 0.35;
      this.onMouth(0.15 + 0.55 * Math.abs(Math.sin(phase)));
    }, 1000 / 30);
  }

  speak(text: string): Promise<void> {
    const s = this.synth;
    if (!s) return Promise.reject(new Error('이 컴퓨터에서 목소리 읽기를 쓸 수 없습니다.'));
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pick();
      if (v) u.voice = v;
      u.lang = v ? v.lang : 'ko-KR';
      u.rate = this.rate;
      u.volume = this.volume;
      let started = false;
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        this.mouth(false);
        this.finish = null;
        if (err) reject(err);
        else resolve();
      };
      this.finish = () => done();
      u.onstart = () => {
        started = true;
        this.mouth(true);
      };
      u.onend = () => done();
      u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? done() : done(new Error(`이 컴퓨터 목소리 오류: ${e.error}`)));
      // 목소리가 시작되지 않거나(목소리가 없음) 끝 신호가 오지 않을 때를 대비
      timers.push(
        setTimeout(() => {
          if (!started) {
            s.cancel();
            done(new Error('이 컴퓨터 목소리가 시작되지 않습니다 (설치된 목소리를 확인하세요).'));
          }
        }, 5000)
      );
      timers.push(setTimeout(() => done(), 8000 + (text.length * 400) / Math.max(0.5, this.rate)));
      s.speak(u);
    });
  }

  cancel(): void {
    if (this.synth) this.synth.cancel();
    if (this.finish) this.finish();
  }
}

/* ---------------- 녹음 (누르고 말하기 + 말이 멈추면 자동으로 끝내기) ---------------- */

/** 듣는 중 소리 크기 표시용: 지금 소리, 주변 소음, 말소리선, 멈춤선 (dBFS, 말소리 대역) */
export interface MicLevel {
  db: number;
  noise: number | null;
  speechLine: number | null;
  silenceLine: number | null;
}

export interface RecordOptions {
  /** 주면 말소리 감지를 켠다 */
  vad?: VadOptions | null;
  onVad?: (e: VadEvent) => void;
  onLevel?: (l: MicLevel) => void;
}

export class Recorder {
  private maxMs: number;
  private onAutoStop: () => void;
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private meter: MicMeter | null = null;
  private logic: VadLogic | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor({ maxMs = 60000, onAutoStop }: { maxMs?: number; onAutoStop?: () => void } = {}) {
    this.maxMs = maxMs;
    this.onAutoStop = onAutoStop || (() => {});
  }

  get active(): boolean {
    return !!this.rec && this.rec.state === 'recording';
  }

  /** 듣는 동안 고쳐 나간 주변 소음 (다음 듣기의 시작값으로 쓴다). 말소리 감지를 안 켰으면 null */
  get noise(): number | null {
    return this.logic ? this.logic.keepNoise : null;
  }

  /** 말소리를 한 번이라도 들었는지 (말소리 감지를 켰을 때) */
  get heard(): boolean {
    return !!this.logic && this.logic.heard;
  }

  /** 이번 듣기에 말소리 감지를 켰는지 (끄면 heard를 알 수 없다) */
  get vadOn(): boolean {
    return !!this.logic;
  }

  /** 보낼지 판단 근거: 말소리 시간(ms), 가장 컸던 소리, 주변 소음, 말소리선. 말소리 감지를 안 켰으면 null */
  get spoken(): { ms: number; peak: number; noise: number | null; line: number | null } | null {
    const l = this.logic;
    return l ? { ms: l.spokenMs, peak: l.peakDb, noise: l.noise, line: l.speechLine } : null;
  }

  async start(opts: RecordOptions = {}): Promise<void> {
    this.stream = await openMic();
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();
    this.timer = setTimeout(() => this.onAutoStop(), this.maxMs);
    this.logic = opts.vad ? new VadLogic(opts.vad) : null;
    if (opts.vad || opts.onLevel) {
      const logic = this.logic;
      this.meter = new MicMeter(this.stream, (db, t) => {
        const ev = logic ? logic.feed(db, t) : null;
        if (opts.onLevel) opts.onLevel({ db, noise: logic ? logic.noise : null, speechLine: logic ? logic.speechLine : null, silenceLine: logic ? logic.silenceLine : null });
        if (ev && opts.onVad) opts.onVad(ev);
      });
    }
  }

  private release(): void {
    if (this.meter) this.meter.stop();
    this.meter = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** 녹음을 멈추고 Blob을 돌려준다 (cancel이면 버림) */
  stop(cancel = false): Promise<Blob | null> {
    return new Promise((resolve) => {
      clearTimeout(this.timer);
      if (this.meter) this.meter.stop();
      this.meter = null;
      const rec = this.rec;
      if (!rec || rec.state === 'inactive') {
        this.release();
        return resolve(null);
      }
      rec.onstop = () => {
        this.release();
        const blob = cancel ? null : new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        this.chunks = [];
        this.rec = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
}

/**
 * 녹음(webm)을 16kHz 모노 wav로 바꾼다. Gemini는 webm을 받지 않아서 필요하다.
 * 60초 녹음이 약 1.9MB가 된다.
 */
export async function toWav(blob: Blob): Promise<Blob> {
  const AC = window.AudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    dv.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // 모노
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    str(36, 'data');
    dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([buf], { type: 'audio/wav' });
  } finally {
    void ctx.close();
  }
}
