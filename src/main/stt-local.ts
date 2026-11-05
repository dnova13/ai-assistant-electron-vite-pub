// 앱 안 위스퍼 관리: 작업 프로세스(stt-worker) 띄우기, 모델 받기·진행률, 인식.
// 모델은 userData/whisper 에 받는다. 다 받으면 <모델>.ready 표시 파일을 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import type { LocalSttModel, LocalSttProgress, LocalSttStatus } from '@shared/types';
import { LOCAL_MODELS } from '@shared/stt';
import { cleanTranscript } from '@shared/transcript';
import type { LocalEngine } from './stt';

/** Electron utilityProcess 중 여기서 쓰는 부분 (시험에서는 가짜를 넣는다) */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  on(ev: 'message', cb: (msg: WorkerMsg) => void): unknown;
  on(ev: 'exit', cb: (code: number) => void): unknown;
  kill(): boolean;
}
type WorkerMsg = { id?: number; type?: string; ok?: boolean; text?: string; error?: string; progress?: number; file?: string; stage?: string };

export type SpawnWorker = (env: Record<string, string>) => WorkerLike;

interface Pending {
  resolve: (m: WorkerMsg) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number, file?: string) => void;
}

/** wav(16비트 PCM, 모노) → Float32Array. 앱의 녹음은 화면에서 16kHz 모노 wav로 바꿔 보낸다 */
export function wavToPcm(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('wav 형식이 아닙니다.');
  let off = 12;
  let channels = 1;
  let bits = 16;
  let rate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`16비트 wav만 받습니다 (${bits}비트).`);
      if (rate !== 16000) throw new Error(`16kHz wav만 받습니다 (${rate}Hz).`);
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2 * channels) / 0x8000;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav에 소리 데이터가 없습니다.');
}

export class LocalStt implements LocalEngine {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private downloading: { model: LocalSttModel; progress: number } | null = null;
  private unavailable: string | null = null;
  private cancelled = false;
  /** 작업 프로세스가 마지막으로 알린 단계 (갑자기 꺼졌을 때 어디서 멈췄는지) */
  private lastStage = '';

  constructor(
    readonly dir: string,
    private spawn: SpawnWorker,
    private emit: (p: LocalSttProgress) => void,
    /** 작업 프로세스의 출력을 남기는 기록 파일 (오류 문구에 위치를 알려 준다) */
    private logFile = ''
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private marker = (m: LocalSttModel) => path.join(this.dir, `${m}.ready`);

  isReady(model: LocalSttModel): boolean {
    return fs.existsSync(this.marker(model));
  }

  status(): LocalSttStatus {
    return {
      downloaded: LOCAL_MODELS.filter((m) => this.isReady(m)),
      downloading: this.downloading,
      unavailable: this.unavailable,
      dir: this.dir
    };
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    let w: WorkerLike;
    try {
      w = this.spawn({ STT_CACHE_DIR: this.dir });
    } catch (e) {
      this.unavailable = `위스퍼 엔진을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
      throw new Error(this.unavailable);
    }
    w.on('message', (m: WorkerMsg) => {
      if (m.type === 'stage' && m.stage) this.lastStage = m.stage;
      if (m.id == null) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        if (p.onProgress) p.onProgress(typeof m.progress === 'number' ? m.progress : -1, m.file);
        return;
      }
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error || '위스퍼 오류'));
    });
    w.on('exit', (code: number) => {
      if (this.worker === w) this.worker = null;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error(code === 0 ? '위스퍼 엔진이 멈췄습니다.' : this.crashMessage(code)));
      }
    });
    this.worker = w;
    return w;
  }

  /** 갑자기 꺼졌을 때 문구: 코드, 마지막 단계, 기록 파일 */
  private crashMessage(code: number): string {
    const where = this.lastStage ? `, 마지막 단계: ${this.lastStage}` : '';
    const log = this.logFile ? ` 자세한 기록: ${this.logFile}` : '';
    return `위스퍼 엔진이 종료되었습니다 (코드 ${code}${where}).${log}`;
  }

  private request(msg: Record<string, unknown>, onProgress?: Pending['onProgress']): Promise<WorkerMsg> {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ ...msg, id });
    });
  }

  /** 모델 받기 (이미 받았으면 바로 끝). 진행률은 emit으로 화면에 보낸다 */
  async download(model: LocalSttModel): Promise<boolean> {
    if (!LOCAL_MODELS.includes(model)) throw new Error(`알 수 없는 모델: ${model}`);
    if (this.downloading) throw new Error(`이미 ${this.downloading.model} 모델을 받는 중입니다.`);
    this.downloading = { model, progress: 0 };
    this.cancelled = false;
    this.emit({ model, progress: 0 });
    try {
      await this.request({ type: 'load', model }, (progress, file) => {
        if (progress >= 0 && this.downloading) this.downloading.progress = progress;
        this.emit({ model, progress: this.downloading ? this.downloading.progress : 0, file });
      });
      fs.writeFileSync(this.marker(model), new Date().toISOString());
      this.emit({ model, progress: 1, done: true });
      return true;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const net = /fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|403|network/i.test(raw);
      const error = this.cancelled ? '취소했습니다.' : net ? `${raw} — 인터넷 연결과 huggingface.co 접속을 확인하세요.` : raw;
      this.emit({ model, progress: 0, done: true, error });
      throw new Error(`모델을 받지 못했습니다: ${error}`);
    } finally {
      this.downloading = null;
    }
  }

  /** 받기 취소: 작업 프로세스를 끈다 (받던 파일은 다음에 이어서 다시 받는다) */
  cancel(): boolean {
    if (!this.worker) return false;
    this.cancelled = true;
    this.worker.kill();
    this.worker = null;
    return true;
  }

  async transcribe(wav: Buffer, model: LocalSttModel): Promise<string> {
    if (!this.isReady(model)) throw new Error(`위스퍼 모델(${model})을 아직 받지 않았습니다.`);
    const pcm = wavToPcm(wav);
    if (pcm.length < 1600) return ''; // 0.1초 미만
    const r = await this.request({ type: 'transcribe', model, pcm });
    return cleanTranscript(String(r.text || ''));
  }

  dispose(): void {
    this.cancel();
  }
}
