// 호출어 듣기: 대기 중 마이크를 켜 두고, 말소리 구간(최대 약 3초)을 잘라 앱 안 위스퍼로 받아 적어 호출어로 시작하는지 본다.
// - 말소리 판단은 자동 전송과 같은 VadLogic(주변 소음 + 두 선)을 쓴다. 조용할 때는 소리 크기만 재고 위스퍼는 돌지 않는다.
// - 소리는 메모리에만 잠깐 두고(최근 5초), 판단이 끝나면 버린다. 저장하거나 밖으로 보내지 않는다.
// 판단(WakeSegmenter)은 숫자만 다루는 순수 코드라 단위 시험을 한다. 마이크 부분은 WakeListener.
import { MicMeter, VadLogic, openMic } from './vad';

export interface SegmenterOptions {
  noiseDb: number | null;
  marginDb: number;
  /** 말이 이만큼 멈추면 구간 끝 (호출어는 짧으니 자동 전송보다 짧게) */
  silenceMs?: number;
  /** 구간이 이보다 길면 여기서 자른다 (호출어는 말 앞부분에 있다) */
  maxMs?: number;
  /** 구간 앞에 붙일 여유 (말 시작을 알아채기 전의 소리) */
  preRollMs?: number;
}

export interface Segment {
  start: number;
  end: number;
}

/** 소리 크기를 받아 말소리 구간 [start, end](ms)를 알려 준다. 끝없이 이어서 쓴다 */
export class WakeSegmenter {
  private o: Required<SegmenterOptions>;
  private vad: VadLogic;
  private speechAt = -1;
  /** 너무 길어서 자른 뒤, 이 말이 끝날 때까지는 무시 */
  private skipping = false;

  constructor(opts: SegmenterOptions) {
    this.o = { silenceMs: 500, maxMs: 3000, preRollMs: 350, ...opts };
    this.vad = this.fresh(opts.noiseDb);
  }

  private fresh(noise: number | null): VadLogic {
    return new VadLogic({ noiseDb: noise, marginDb: this.o.marginDb, silenceMs: this.o.silenceMs, noSpeechMs: Infinity });
  }

  get noise(): number | null {
    return this.vad.keepNoise;
  }

  feed(db: number, t: number): Segment | null {
    const ev = this.vad.feed(db, t);
    if (ev === 'speech') {
      this.speechAt = t - 120; // 말소리로 인정되기까지 걸린 시간만큼 앞으로
      return null;
    }
    if (ev === 'silence') {
      const seg = this.skipping || this.speechAt < 0 ? null : { start: this.speechAt - this.o.preRollMs, end: t - this.o.silenceMs + 150 };
      this.skipping = false;
      this.speechAt = -1;
      this.vad = this.fresh(this.vad.keepNoise);
      return seg;
    }
    if (this.speechAt >= 0 && !this.skipping && t - this.speechAt >= this.o.maxMs) {
      this.skipping = true;
      return { start: this.speechAt - this.o.preRollMs, end: t };
    }
    return null;
  }
}

/** Float32 PCM(16kHz 모노) → 16비트 wav */
export function pcmToWav(pcm: Float32Array, rate = 16000): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

export interface WakeListenerOptions {
  noiseDb: number | null;
  marginDb: number;
  /** 잘라 낸 말소리 구간 (16kHz wav). 앞의 것을 처리하는 중이면 새 구간은 맡아 뒀다가 끝나면 넘긴다 (가장 최근 것 하나만) */
  onSegment: (wav: Uint8Array) => Promise<void>;
  onError?: (e: Error) => void;
}

const RATE = 16000;
const KEEP_MS = 5000;

/** 마이크를 켜 두고 말소리 구간을 잘라 넘긴다. stop()에서 마이크·오디오 처리기를 모두 닫는다 */
export class WakeListener {
  private stream: MediaStream | null = null;
  private meter: MicMeter | null = null;
  private ctx: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private chunks: { t: number; data: Float32Array }[] = [];
  private seg: WakeSegmenter;
  private busy = false;
  /** 앞 구간을 받아 적는 동안 들어온 구간 (가장 최근 것 하나만 둔다: 쌓이면 반응이 밀린다) */
  private pending: Uint8Array | null = null;
  private stopped = false;

  constructor(private o: WakeListenerOptions) {
    this.seg = new WakeSegmenter({ noiseDb: o.noiseDb, marginDb: o.marginDb });
  }

  get noise(): number | null {
    return this.seg.noise;
  }

  async start(): Promise<void> {
    this.stream = await openMic();
    if (this.stopped) return this.release();
    // 소리 조각 모으기: 기기 기본 속도로 받아 최근 5초만 메모리에 두고, 자를 때 16kHz로 바꾼다
    // (오디오 처리기를 16kHz로 따로 만들면 같은 마이크를 쓰는 소리 크기 재기가 흔들리는 경우가 있었다)
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // 스피커로는 내보내지 않는다 (처리기가 돌려면 끝까지 연결돼 있어야 함)
    src.connect(this.proc).connect(mute).connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => {
      const now = performance.now();
      this.chunks.push({ t: now, data: new Float32Array(e.inputBuffer.getChannelData(0)) });
      while (this.chunks.length && now - this.chunks[0].t > KEEP_MS) this.chunks.shift();
    };
    // 말소리 판단 (말소리 대역 소리 크기)
    this.meter = new MicMeter(this.stream, (db, t) => {
      const s = this.seg.feed(db, t);
      if (s) this.cut(s);
    });
  }

  private cut(s: { start: number; end: number }): void {
    if (this.stopped) return;
    // 조각의 시각은 조각이 끝난 때다 → 조각 길이만큼 겹치는 것을 고른다
    const rate = this.ctx ? this.ctx.sampleRate : RATE;
    const chunkMs = (2048 / rate) * 1000;
    const parts = this.chunks.filter((c) => c.t >= s.start && c.t - chunkMs <= s.end + 200);
    const n = parts.reduce((a, c) => a + c.data.length, 0);
    if (n < rate * 0.3) return; // 너무 짧음
    const raw = new Float32Array(n);
    let off = 0;
    for (const p of parts) {
      raw.set(p.data, off);
      off += p.data.length;
    }
    const wav = pcmToWav(resample(raw, rate, RATE), RATE);
    // 앞 구간을 받아 적는 중이면 버리지 않고 맡아 둔다 (예: 문소리를 받아 적는 사이에 부른 이름)
    if (this.busy) {
      this.pending = wav;
      return;
    }
    this.run(wav);
  }

  private run(wav: Uint8Array): void {
    this.busy = true;
    this.o
      .onSegment(wav)
      .catch((e) => this.o.onError && this.o.onError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        this.busy = false;
        const next = this.pending;
        this.pending = null;
        if (next && !this.stopped) this.run(next);
      });
  }

  private release(): void {
    if (this.meter) this.meter.stop();
    this.meter = null;
    if (this.proc) {
      this.proc.onaudioprocess = null;
      try {
        this.proc.disconnect();
      } catch {
        /* 이미 끊김 */
      }
    }
    this.proc = null;
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.chunks = [];
    this.pending = null;
  }

  stop(): void {
    this.stopped = true;
    this.release();
  }
}

/** 간단한 속도 바꾸기 (선형 보간). 호출어 판단용이라 이 정도면 충분하다 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.max(1, Math.floor((input.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const f = x - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}
