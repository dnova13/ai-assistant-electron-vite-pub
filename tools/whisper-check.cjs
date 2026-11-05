// 앱 안 위스퍼 점검: 엔진(onnxruntime-node, transformers.js) → 모델 → 받아 적기를 차례로 해 보고, 어디서 멈추는지 보여 준다.
// 앱이 "위스퍼 엔진이 종료되었습니다 (코드 …)"라고 할 때 원인을 찾는 데 쓴다.
//
// 사용 (프로젝트 폴더에서):
//   1) 그냥 Node로:      node tools/whisper-check.cjs tiny
//      모델 버전 고르기:    node tools/whisper-check.cjs small fp32   (q8 기본, fp32, fp16, q4, int8, uint8)
//   2) Electron 안에서:  ELECTRON_RUN_AS_NODE=1 npx electron tools/whisper-check.cjs tiny
//      (윈도우 PowerShell: $env:ELECTRON_RUN_AS_NODE=1; npx electron tools/whisper-check.cjs tiny)
// 엔진 설정 (환경 변수): WHISPER_THREADS=1 (계산 스레드 수), WHISPER_ARENA=1 (엔진 메모리 풀 켜기 — 앱은 끈다. 맥 Electron에서 small 이상이 이것 때문에 죽었다)
//   예: WHISPER_THREADS=1 ELECTRON_RUN_AS_NODE=1 npx electron tools/whisper-check.cjs small
// 1은 되는데 2에서 멈추면 Electron 안에서만 생기는 문제다. 둘 다 멈추면 엔진·모델 문제다.
// 모델은 앱과 같은 곳(사용자 데이터 폴더의 whisper/)을 쓴다. 없으면 받는다 (tiny 약 40MB).
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const model = process.argv[2] || 'tiny';
const dtype = process.argv[3] || 'q8';
if (!['q8', 'fp32', 'fp16', 'q4', 'int8', 'uint8', 'q4f16'].includes(dtype)) {
  console.error('버전은 q8, fp32, fp16, q4, int8, uint8, q4f16 중 하나');
  process.exit(2);
}
if (!['tiny', 'base', 'small', 'medium'].includes(model)) {
  console.error('모델은 tiny, base, small, medium 중 하나');
  process.exit(2);
}

function userDataDir() {
  const name = 'ai-assistant-electron-vite';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}초] ${s}`);
const mem = () => `메모리 ${Math.round(process.memoryUsage().rss / 1048576)}MB`;

(async () => {
  step(`node ${process.versions.node}, electron ${process.versions.electron || '(아님: 그냥 Node)'}, ${process.platform}/${process.arch}, 모델 ${model} (${dtype})`);
  const cacheDir = path.join(userDataDir(), 'whisper');
  fs.mkdirSync(cacheDir, { recursive: true });
  step(`모델 폴더: ${cacheDir}`);

  step('1. onnxruntime-node 불러오기');
  const ort = require('onnxruntime-node');
  step(`   됨 (${Object.keys(ort).length}개 항목) · ${mem()}`);

  step('2. transformers.js 불러오기');
  const T = await import('@huggingface/transformers');
  T.env.cacheDir = cacheDir;
  T.env.allowLocalModels = false;
  if (process.env.STT_REMOTE_HOST) T.env.remoteHost = process.env.STT_REMOTE_HOST; // 시험용
  if (process.env.STT_CACHE_DIR) T.env.cacheDir = process.env.STT_CACHE_DIR; // 시험용
  step(`   됨 · ${mem()}`);

  const repo = (process.env.STT_REPO_PREFIX || 'Xenova/whisper-') + model;
  const sessionOptions = {};
  if (process.env.WHISPER_THREADS) {
    sessionOptions.intraOpNumThreads = Number(process.env.WHISPER_THREADS);
    sessionOptions.interOpNumThreads = 1;
  }
  if (!process.env.WHISPER_ARENA) sessionOptions.enableCpuMemArena = false; // 앱과 같게 (WHISPER_NO_ARENA는 예전 이름, 이제 기본)
  if (Object.keys(sessionOptions).length) step(`   엔진 설정: ${JSON.stringify(sessionOptions)}`);
  step(`3. 모델 받기·올리기: ${repo} (${dtype})`);
  let last = -10;
  const asr = await T.pipeline('automatic-speech-recognition', repo, {
    dtype,
    device: 'cpu',
    session_options: sessionOptions,
    progress_callback: (i) => {
      if (i.status === 'progress_total' && i.progress - last >= 10) {
        last = i.progress;
        step(`   받는 중 ${Math.floor(i.progress)}%`);
      } else if (i.status === 'ready') step('   파일 준비됨, 올리는 중');
    }
  });
  step(`   모델 준비됨 · ${mem()}`);

  // 조용한 소리에서는 위스퍼가 같은 말을 길게 지어내므로, 작은 소리(잡음)를 넣고 글자 수를 제한한다
  step('4. 받아 적기 (2초짜리 작은 잡음)');
  const pcm = new Float32Array(32000).map(() => (Math.random() - 0.5) * 0.02);
  const out = await asr(pcm, { language: 'korean', task: 'transcribe', max_new_tokens: 32 });
  step(`   결과: ${JSON.stringify(out)} · ${mem()}`);

  step('끝: 정상입니다.');
  process.exit(0);
})().catch((e) => {
  console.error(`\n오류 (${((Date.now() - t0) / 1000).toFixed(1)}초):`, e && e.stack ? e.stack : e);
  process.exit(1);
});

process.on('exit', (code) => {
  if (code !== 0 && code !== 1 && code !== 2) console.error(`\n갑자기 끝남 (코드 ${code}) — 마지막으로 보인 단계에서 멈춘 것입니다.`);
});
