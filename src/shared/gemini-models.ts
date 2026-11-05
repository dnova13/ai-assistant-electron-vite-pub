// Gemini 모델 목록 거르기와 무료 구간 표시.
// 근거: ai.google.dev 의 pricing / models / deprecations 문서 (2026-10-18 확인). 구글이 바꾸면 여기만 고친다.
// API의 모델 목록에는 대화·음성 입력에 쓸 수 없는 모델(이미지·영상 생성, TTS, 실시간, 로봇, 종료된 것)도 섞여 나온다.

/** 대화·음성 입력(generateContent)에 쓸 수 없는 종류 */
const UNSUPPORTED = [
  /image|nano-banana/i, // 이미지 생성
  /omni/i, // 영상 생성
  /tts/i, // 글 → 음성
  /live|native-audio/i, // 실시간 음성 대화 (WebSocket 전용)
  /embedding/i,
  /robotics/i,
  /computer-use/i,
  /customtools/i, // 도구 호출 전용 변형
  /transcribe/i, // 전용 받아쓰기 모델: generateContent로 보내면 빈 결과가 나온다는 보고가 있어 뺀다
  /veo|lyria|imagen|deep-research|antigravity|aqa|learnlm|gemma/i
];

/** 종료된 모델 (deprecations 문서) */
const SHUT_DOWN = new Set(['gemini-3.1-flash-lite-preview', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-pro-preview', 'gemini-2.5-computer-use-preview-10-2025']);

/** 무료 구간(Free tier)이 있는 모델 (pricing 문서, Standard 기준) */
const FREE = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash', // 3.8-flash로 연결됨
  'gemini-3.6-flash',
  'gemini-3.5-flash', // 3.6-flash로 연결됨
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro'
]);

/** 무료 구간이 없는 모델 */
const PAID = new Set(['gemini-4-argon', 'gemini-3.1-pro-preview']);

export function isUsableGeminiModel(id: string): boolean {
  const m = id.replace(/^models\//, '');
  return /gemini/i.test(m) && !SHUT_DOWN.has(m) && !UNSUPPORTED.some((re) => re.test(m));
}

/** true: 무료 구간 있음, false: 유료만, null: 문서로 확인 못 함 (예: -latest 별칭) */
export function geminiFree(id: string): boolean | null {
  const m = id.replace(/^models\//, '');
  if (FREE.has(m)) return true;
  if (PAID.has(m)) return false;
  return null;
}

export function geminiLabel(id: string): string {
  const f = geminiFree(id);
  if (f === true) return `${id} · 무료 구간 있음`;
  if (f === false) return `${id} · 유료`;
  return /-latest$/.test(id) ? `${id} · 별칭 (가리키는 모델에 따름)` : id;
}

/** 무료 → 별칭·미확인 → 유료 순서로 (같은 무리 안에서는 원래 순서) */
export function sortGeminiModels(ids: string[]): string[] {
  const rank = (id: string) => (geminiFree(id) === true ? 0 : geminiFree(id) === null ? 1 : 2);
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map((x) => x.id);
}
