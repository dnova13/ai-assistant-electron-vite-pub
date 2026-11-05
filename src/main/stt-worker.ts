// 앱 안 위스퍼: Electron utilityProcess에서 돈다 (무거운 계산이 메인 프로세스·화면을 멈추지 않게).
// transformers.js(onnxruntime-node)로 위스퍼를 CPU에서 돌린다. 맥·윈도우가 같은 코드다.
// 메시지: { id, type: 'load', model } → progress… → { id, ok }
//         { id, type: 'transcribe', model, pcm(Float32Array, 16kHz 모노) } → { id, ok, text }
//         { type: 'stage', stage } — 지금 하는 일 (엔진이 갑자기 꺼졌을 때 어디서 멈췄는지 알 수 있게). 같은 내용을 표준 오류 출력에도 남긴다 → 메인이 기록 파일에 쓴다
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { maxTokensFor } from '@shared/transcript';

type Req = { id: number; type: 'load'; model: string } | { id: number; type: 'transcribe'; model: string; pcm: Float32Array };
type Transformers = typeof import('@huggingface/transformers');

const port = process.parentPort;

function stage(s: string): void {
  console.error(`[whisper] ${s}`);
  port.postMessage({ type: 'stage', stage: s });
}

process.on('uncaughtException', (e) => {
  console.error('[whisper] 처리 못 한 오류:', e && (e as Error).stack ? (e as Error).stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[whisper] 처리 못 한 약속 오류:', e && (e as Error).stack ? (e as Error).stack : e);
});

/** 엔진(transformers.js + onnxruntime-node)은 처음 쓸 때 불러온다. 불러오다 꺼지면 "엔진 불러오기" 단계에서 멈춘 것 */
let engine: Promise<Transformers> | null = null;
function loadEngine(): Promise<Transformers> {
  if (!engine) {
    engine = (async () => {
      stage(`엔진 불러오기 (node ${process.versions.node}, electron ${process.versions.electron || '-'}, ${process.platform}/${process.arch})`);
      // transformers.js가 onnxruntime-node(네이티브)를 같이 불러온다. 여기서 꺼지면 네이티브 엔진 문제
      stage('엔진 불러오기: transformers.js + onnxruntime-node');
      const T = await import('@huggingface/transformers');
      // 모델은 앱의 사용자 폴더에 받아 둔다. 시험에서는 받는 곳을 바꿀 수 있다.
      T.env.cacheDir = process.env.STT_CACHE_DIR || T.env.cacheDir;
      T.env.allowLocalModels = false;
      if (process.env.STT_REMOTE_HOST) T.env.remoteHost = process.env.STT_REMOTE_HOST;
      stage('엔진 준비됨');
      return T;
    })();
    engine.catch(() => (engine = null));
  }
  return engine;
}

/** 크기 이름 → 받을 모델. q8: 받는 양과 메모리를 줄인 버전 */
const repo = (model: string) => (process.env.STT_REPO_PREFIX || 'Xenova/whisper-') + model;

const loaded = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function load(model: string, onProgress?: (p: number, file?: string) => void): Promise<AutomaticSpeechRecognitionPipeline> {
  let p = loaded.get(model);
  let lastPct = -1;
  if (!p) {
    p = (async () => {
      const T = await loadEngine();
      stage(`모델 받기·확인: ${model}`);
      let ready = false;
      const asr = (await T.pipeline('automatic-speech-recognition', repo(model), {
        dtype: 'q8',
        device: 'cpu',
        // 엔진의 메모리 풀(큰 덩어리를 미리 잡아 두는 것)을 끈다. Electron 안(특히 맥)에서는 small 이상 모델로 계산할 때
        // 아주 큰 메모리를 한 번에 요청하다 엔진이 SIGTRAP(코드 5)으로 죽었다. 끄면 메모리도 덜 쓴다
        session_options: { enableCpuMemArena: false },
        progress_callback: (info) => {
          if (info.status === 'ready' && !ready) {
            ready = true;
            stage(`모델 올리기: ${model}`);
          }
          if (!onProgress || info.status !== 'progress_total') return;
          // 진행률은 아주 자주 오므로 1% 단위로만 알린다
          const pct = Math.max(0, Math.min(100, Math.floor(info.progress)));
          if (pct === lastPct) return;
          lastPct = pct;
          onProgress(pct / 100);
        }
      })) as AutomaticSpeechRecognitionPipeline;
      stage(`모델 준비됨: ${model}`);
      return asr;
    })();
    p.catch(() => loaded.delete(model)); // 실패하면 다음에 다시 시도
    loaded.set(model, p);
  }
  return p;
}

port.on('message', async (e: { data: Req }) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model, (progress, file) => port.postMessage({ id: msg.id, type: 'progress', progress, file }));
      port.postMessage({ id: msg.id, ok: true });
    } else if (msg.type === 'transcribe') {
      const asr = await load(msg.model);
      stage(`받아 적기: ${msg.model}, ${(msg.pcm.length / 16000).toFixed(1)}초`);
      // 조용하거나 잡음뿐인 소리에서 같은 말을 끝없이 지어내지 않게, 소리 길이에 맞춰 글자 수를 제한한다
      const sec = msg.pcm.length / 16000;
      const out = await asr(msg.pcm, { language: 'korean', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, max_new_tokens: maxTokensFor(sec) });
      const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
      stage('받아 적기 끝');
      port.postMessage({ id: msg.id, ok: true, text: String(text || '').trim() });
    }
  } catch (err) {
    console.error('[whisper] 오류:', err instanceof Error ? err.stack || err.message : err);
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

port.postMessage({ type: 'ready' });
