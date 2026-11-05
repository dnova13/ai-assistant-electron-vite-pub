// 말소리 감지 (VAD): 마이크 소리 크기(dBFS)를 재서 "말 시작", "말이 멈춤", "말 없음"을 알아낸다.
// 판단(VadLogic)은 숫자만 다루는 순수 코드라 단위 시험을 한다. 마이크에서 소리 크기를 재는 부분은 MicMeter.
// dBFS: 디지털 소리의 크기. 가장 큰 소리가 0이고 항상 0 이하 (숫자가 0에 가까울수록 큰 소리).
//
// 방식 (v0.5):
//  - 주변 소음(noise)을 기준으로 두 선을 긋는다.
//      말소리선 = 주변 소음 + marginDb (설정, 기본 12)  → 이보다 크면 "말하는 중"
//      멈춤선   = 주변 소음 + SILENCE_DB (3)            → 이 아래로 내려와 silenceMs 동안 있으면 "말이 멈춤"
//    두 선 사이(애매한 구간)에서는 상태를 바꾸지 않는다.
//  - 주변 소음은 설정에서 잰 값(또는 지난번 값)으로 시작하고, 듣는 동안 말소리선 아래의 소리로 계속 고쳐 나간다.
//    말소리가 섞인 소리로는 올리지 않고(말소리선 아래의 작은 말도 소음이 아니다), 올릴 때는 천천히, 내릴 때는 빨리 움직인다.
//  - 소리 크기는 사람 말소리 대역(약 300~3400Hz)만 잰다 (팬·에어컨 같은 낮은 소음에 덜 흔들림).

import { VAD_LIMITS } from '@shared/voice';
import { isRepetitive } from '@shared/transcript';

export type VadEvent = 'speech' | 'silence' | 'nospeech';

export interface VadOptions {
  /** 주변 소음 시작값. null이면 처음 calibrateMs 동안 재서 정한다 */
  noiseDb: number | null;
  /** 말소리 = 주변 소음 + 이만큼 (6~25) */
  marginDb: number;
  /** 말소리가 나온 뒤 이만큼 조용하면 'silence' */
  silenceMs: number;
  /** 말소리가 나오기 전에 이만큼 지나면 'nospeech' */
  noSpeechMs: number;
  /** 시작값이 없을 때 주변 소음을 재는 시간 */
  calibrateMs?: number;
  /** 최근 0.3초 안에 말소리선 위의 소리가 이만큼 모여야 말소리로 본다 (문 닫는 소리 같은 짧은 소리 거르기).
   *  꼭 이어질 필요는 없다: 말은 음절 사이에 잠깐씩 작아진다 */
  minSpeechMs?: number;
  /** 주변 소음을 고쳐 나갈지 (시험용으로 끌 수 있음) */
  adapt?: boolean;
}

/** 멈춤선 = 주변 소음 + 이만큼 */
export const SILENCE_DB = 3;
/** 주변 소음 값의 범위 */
export const NOISE_MIN_DB = VAD_LIMITS.noiseMin;
export const NOISE_MAX_DB = VAD_LIMITS.noiseMax;
/** 주변 소음을 고칠 때 보는 최근 소리 (ms) */
const WINDOW_MS = 2500;
/** 주변 소음 = 말소리선 아래 소리 중 이 백분위 (요동치는 소음을 넉넉히 덮도록 중간보다 위쪽) */
const NOISE_PCT = 0.75;
/** 소음 값이 오를 때 한 번(50ms)에 움직이는 비율. 큰 말소리에 끌려 올라가지 않게 천천히 */
const NOISE_RISE = 0.03;
/** 소음 값이 내릴 때 한 번에 움직이는 비율 */
const NOISE_FALL = 0.1;
/** 이만큼 내내 소음 값보다 작으면 창(WINDOW_MS)이 차지 않아도 바로 내린다 */
const FAST_FALL_MS = 1000;
/** 말은 크고 작아지기를 반복한다. 최근 1초의 소리 폭이 이보다 작으면(일정한 소음) 말 시작으로 보지 않는다 */
const SPEECH_SWING_DB = 6;
/** 말 시작 판단에서 큰 소리를 모으는 시간 */
const LOUD_WINDOW_MS = 300;
/** "말을 했는지"(보낼지) 셀 때 켜진 직후 이만큼은 세지 않는다: 마이크 켜짐 소리, 단축키 누르는 소리 */
export const SPOKEN_IGNORE_START_MS = 400;
/** 말소리선 위에 있던 시간을 합쳐 이보다 짧으면 말하지 않은 것으로 보고 받아 적지 않는다 (기본값. 설정 > 음성 대화 "최소 말소리 길이") */
export const MIN_SPOKEN_MS = VAD_LIMITS.spokenDefault * 1000;
/** 멈춤 판단은 짧게 튀는 소리에 흔들리지 않게 부드럽게 한 소리 크기로 한다 (0~1, 클수록 빨리 따라감) */
const SMOOTH = 0.35;

export const levelToDb = (rms: number): number => (rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100);

/** 소리 크기 목록의 백분위 값 (p: 0~1) */
export function percentile(values: number[], p: number): number {
  if (!values.length) return -100;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** 조용할 때 잰 소리들 → 주변 소음 값 (듣는 동안 고쳐 나갈 때와 같은 방법) */
export function noiseOf(quiet: number[]): number {
  return Math.round(Math.min(NOISE_MAX_DB, Math.max(NOISE_MIN_DB, percentile(quiet, NOISE_PCT))));
}

const MARGIN_MIN = VAD_LIMITS.marginMin;
const MARGIN_MAX = VAD_LIMITS.marginMax;

/**
 * 마이크 맞추기: 조용할 때(주변 소음)와 말할 때의 소리 크기를 재서 주변 소음과 알맞은 차이(margin)를 정한다.
 * 말소리선은 소음과 말소리의 중간쯤. 차이가 너무 작으면 이유를 돌려준다.
 */
export function calibrate(quiet: number[], speech: number[]): { noise: number; voice: number; margin: number } | { error: string; noise: number; voice: number } {
  const noise = noiseOf(quiet);
  const voice = Math.round(percentile(speech, 0.9));
  if (voice - noise < 10) {
    if (noise > -40) return { error: '주변이 시끄러워서 말소리와 구분하기 어려워요. 조용한 곳에서 다시 해 주세요.', noise, voice };
    return { error: '목소리가 작게 들려요. 마이크에 가까이 대고 평소처럼 말해 주세요.', noise, voice };
  }
  const margin = Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, Math.round((voice - noise) * 0.5)));
  return { noise, voice, margin };
}

export class VadLogic {
  private o: Required<VadOptions>;
  private start = -1;
  private calib: number[] = [];
  private recent: { t: number; db: number }[] = [];
  /** 말소리선 위였던 시각들 (최근 0.3초) */
  private loudTimes: number[] = [];
  private quietSince = -1;
  private loudRun = 0;
  private smooth: number | null = null;
  /** 지금 주변 소음 (null이면 아직 재는 중) */
  noise: number | null;
  /** 말소리가 섞이지 않은 소리로 정한 주변 소음. 다음 듣기의 시작값으로 기억할 값 */
  keepNoise: number | null;
  state: 'calibrating' | 'waiting' | 'speech' | 'done';
  /** 말 시작으로 판정한 적이 있는지 (자동으로 끝내기용, 0.15초면 됨) */
  heard = false;
  /** 켜진 직후(SPOKEN_IGNORE_START_MS)를 빼고 말소리선 위에 있던 시간의 합 (ms). 보낼지 판단에 쓴다 */
  spokenMs = 0;
  /** 가장 컸던 소리 (dB, 켜진 직후 제외) */
  peakDb = -100;
  private lastT = -1;

  constructor(opts: VadOptions) {
    this.o = { calibrateMs: 300, minSpeechMs: 120, adapt: true, ...opts };
    this.noise = opts.noiseDb;
    this.keepNoise = opts.noiseDb;
    this.state = opts.noiseDb === null ? 'calibrating' : 'waiting';
  }

  /** 말소리선 (이보다 크면 말) */
  get speechLine(): number | null {
    return this.noise === null ? null : this.noise + this.o.marginDb;
  }

  /** 멈춤선 (이보다 작으면 조용) */
  get silenceLine(): number | null {
    return this.noise === null ? null : this.noise + SILENCE_DB;
  }

  /** 최근 소리 중 말소리선 아래의 소리로 주변 소음을 고친다. 2.5초 내내 말소리선 위면(쉼이 없음) 소음이 커진 것으로 본다 */
  private adapt(t: number): void {
    if (!this.o.adapt || this.noise === null) return;
    while (this.recent.length && t - this.recent[0].t > WINDOW_MS) this.recent.shift();
    // 잠깐이라도 내내 소음 값보다 작으면 소음 값이 너무 큰 것이다 (지난번 값이 높게 남은 경우)
    const last = this.recent.filter((x) => t - x.t <= FAST_FALL_MS).map((x) => x.db);
    if (last.length >= 20 && percentile(last, 0.95) < this.noise) {
      this.noise += (percentile(last, NOISE_PCT) - this.noise) * NOISE_FALL;
      this.keepNoise = this.noise;
      return;
    }
    if (this.recent.length < 20 || t - this.recent[0].t < WINDOW_MS - 100) return; // 1초 이상 모였을 때만
    const line = this.noise + this.o.marginDb;
    const all = this.recent.map((x) => x.db);
    const below = all.filter((d) => d < line);
    let target: number;
    let rate = NOISE_FALL;
    let mixed = false;
    if (below.length >= 10) {
      target = percentile(below, NOISE_PCT);
      if (target > this.noise) {
        rate = NOISE_RISE;
        // 폭이 크면 말소리가 섞인 것이다. 말의 큰 쪽이 아니라 작은 쪽까지만 따라가고, 그 값은 기억하지 않는다
        const floor = percentile(below, 0.1);
        mixed = percentile(below, 0.95) - floor >= SPEECH_SWING_DB;
        if (mixed) {
          if (floor <= this.noise) return;
          target = floor;
        }
      }
    } else {
      // 쉼 없이 계속 크고 크기도 거의 일정함(폭이 작음) = 주변이 시끄러워진 것 (팬·에어컨).
      // 말은 계속 크더라도 음절마다 크고 작아지므로(폭이 큼) 소음으로 보지 않는다 → 긴 말이 중간에 끊기지 않게
      const floor = percentile(all, 0.1);
      if (floor < line || percentile(all, 0.95) - floor >= SPEECH_SWING_DB) return;
      target = floor;
    }
    target = Math.min(NOISE_MAX_DB, Math.max(NOISE_MIN_DB, target));
    // 한 번에 확 바뀌지 않게 조금씩
    this.noise += (target - this.noise) * rate;
    if (!mixed) this.keepNoise = this.noise;
  }

  /** 최근 1초 소리의 폭 (큰 쪽 - 작은 쪽). 일정한 소음은 작고, 말은 크다 */
  private swing(t: number): number {
    const last = this.recent.filter((x) => t - x.t <= 1000).map((x) => x.db);
    if (last.length < 3) return Infinity; // 막 시작했으면 따지지 않는다
    return percentile(last, 0.95) - percentile(last, 0.1);
  }

  /** 소리 크기(dBFS)와 시각(ms)을 넣는다. 일이 생기면 알려 준다 */
  feed(db: number, t: number): VadEvent | null {
    if (this.state === 'done') return null;
    if (this.start < 0) this.start = t;
    const elapsed = t - this.start;
    const dt = this.lastT < 0 ? 0 : Math.min(200, t - this.lastT);
    this.lastT = t;
    this.recent.push({ t, db });
    this.smooth = this.smooth === null ? db : this.smooth + (db - this.smooth) * SMOOTH;

    if (this.state === 'calibrating') {
      this.calib.push(db);
      if (elapsed < this.o.calibrateMs) return null;
      // 처음부터 말한 경우를 생각해 아래쪽(조용한 쪽) 값을 소음으로 본다
      this.noise = Math.round(percentile(this.calib, 0.3));
      this.keepNoise = this.noise;
      this.state = 'waiting';
    }
    this.adapt(t);
    const speechLine = this.speechLine as number;
    const silenceLine = this.silenceLine as number;
    if (elapsed >= SPOKEN_IGNORE_START_MS) {
      if (db > this.peakDb) this.peakDb = db;
      if (db >= speechLine) this.spokenMs += dt;
    }

    if (this.state === 'waiting') {
      if (db >= speechLine) this.loudTimes.push(t);
      while (this.loudTimes.length && t - this.loudTimes[0] > LOUD_WINDOW_MS) this.loudTimes.shift();
      // 소리 크기는 50ms마다 재므로, 모인 횟수 × 50ms ≈ 큰 소리였던 시간
      const loudMs = this.loudTimes.length * 50;
      if (db >= speechLine && loudMs > this.o.minSpeechMs && this.swing(t) >= SPEECH_SWING_DB) {
        this.state = 'speech';
        this.heard = true;
        this.quietSince = -1;
        return 'speech';
      }
      if (elapsed >= this.o.noSpeechMs) {
        this.state = 'done';
        return 'nospeech';
      }
      return null;
    }

    // speech: (부드럽게 한) 소리가 멈춤선 아래로 내려오면 멈춤 시간을 재기 시작하고, silenceMs가 지나면 끝.
    // 다시 말소리선을 넘으면 처음부터. 두 선 사이(애매한 구간)는 재던 시간을 그대로 둔다 (소음이 조금 튀어도 끊기지 않게)
    const level = this.smooth as number;
    this.loudRun = db >= speechLine ? this.loudRun + 1 : 0;
    if (this.loudRun >= 2) this.quietSince = -1; // 0.1초 넘게 말소리선 위 = 다시 말함 (한 번 툭 튀는 소리는 무시)
    else if (level <= silenceLine && this.quietSince < 0) this.quietSince = t;
    if (this.quietSince >= 0 && t - this.quietSince >= this.o.silenceMs) {
      this.state = 'done';
      return 'silence';
    }
    return null;
  }
}

/** 사람 말소리 대역 (Hz) */
export const VOICE_BAND = { low: 300, high: 3400 } as const;

/**
 * 마이크 소리 크기를 일정 간격으로 잰다. 말소리 대역(300~3400Hz)만 거른 뒤의 크기다.
 * 창이 숨겨져도 돌도록 타이머를 쓴다 (requestAnimationFrame은 멈춤).
 * stop()에서 오디오 처리기를 닫는다 (마이크 스트림은 만든 쪽이 닫는다).
 */
export class MicMeter {
  private ctx: AudioContext;
  private src: MediaStreamAudioSourceNode;
  private analyser: AnalyserNode;
  private data: Float32Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval>;

  constructor(stream: MediaStream, onLevel: (db: number, t: number) => void, intervalMs = 50) {
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(stream);
    // 낮은 소리(팬·에어컨)와 아주 높은 소리를 걸러 말소리 대역만 남긴다 (두 번씩 걸러 더 확실하게)
    const filters = [
      ['highpass', VOICE_BAND.low],
      ['highpass', VOICE_BAND.low],
      ['lowpass', VOICE_BAND.high],
      ['lowpass', VOICE_BAND.high]
    ].map(([type, f]) => {
      const b = this.ctx.createBiquadFilter();
      b.type = type as BiquadFilterType;
      b.frequency.value = f as number;
      b.Q.value = 0.707;
      return b;
    });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    let node: AudioNode = this.src;
    for (const f of filters) node = node.connect(f);
    node.connect(this.analyser); // 스피커로는 내보내지 않는다
    this.data = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.data);
      let sum = 0;
      for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
      onLevel(levelToDb(Math.sqrt(sum / this.data.length)), performance.now());
    }, intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    try {
      this.src.disconnect();
    } catch {
      /* 이미 끊김 */
    }
    void this.ctx.close().catch(() => {});
  }
}

/** 마이크 열기 (말소리 감지에 맞춘 설정). 자동 음량 조절을 끄는 이유: 조용할 때 소음을 키워서 "조용해짐"을 못 알아채게 만든다 */
export async function openMic(): Promise<MediaStream> {
  const ok = await window.app.media.askMic();
  if (!ok) throw new Error('마이크 권한이 없습니다. 맥: 시스템 설정 > 개인정보 보호 및 보안 > 마이크, 윈도우: 설정 > 개인 정보 > 마이크에서 허용하세요.');
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
}

/**
 * 듣기를 끝낼 때 말을 거의 안 했으면 받아 적지 않고 그냥 닫는다.
 * 조용한 소리를 위스퍼에 보내면 "MBC 뉴스 ○○○입니다" 같은 글을 지어내 내 말로 전송되기 때문.
 * 기준: 켜진 직후 0.4초를 빼고 말소리선 위에 있던 시간의 합이 minMs(설정, 기본 0.3초) 미만 (키보드·켜짐 소리·짧은 주변 소리는 넘지 못함).
 * 말소리 감지를 안 켰으면(누르고 말하기) 알 수 없으므로 닫지 않는다.
 */
export function shouldSkipTranscribe(vadOn: boolean, spokenMs: number, minMs: number = MIN_SPOKEN_MS): boolean {
  return vadOn && spokenMs < minMs;
}

/**
 * 받아 적은 글이 실제 말이 아니라 잡음일 가능성이 큰지 (이어서 대화에서 기침·문소리를 거르는 데 쓴다).
 * 위스퍼는 조용하거나 잡음뿐인 소리에서 "감사합니다" 같은 글을 지어내는 일이 있다.
 */
const NOISE_PHRASES = ['감사합니다', '시청해주셔서감사합니다', '구독과좋아요부탁드립니다', '고맙습니다', '네', '음', '어', '아', 'thankyou', 'thanksforwatching', 'you'];
/** 위스퍼가 조용한 소리에서 자주 지어내는 방송·자막 문구 */
const NOISE_PATTERNS = [/^mbc뉴스.{0,8}입니다$/, /^(kbs|sbs|jtbc|ytn)뉴스.{0,8}입니다$/, /자막(제공|제작)/, /^다음영상에서(만나요|뵙겠습니다)$/, /구독.{0,4}좋아요/, /시청해?주셔서/];
export function looksLikeNoise(text: string): boolean {
  if (isRepetitive(text)) return true;
  const t = String(text || '')
    .toLowerCase()
    .replace(/[\s.,!?~…·"'“”‘’()[\]-]/g, '');
  if (t.length < 2) return true;
  return NOISE_PHRASES.includes(t) || NOISE_PATTERNS.some((re) => re.test(t));
}
