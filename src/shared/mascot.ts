// 바탕화면 캐릭터(마스코트) 자동 숨김 설정. 숨기기까지 걸리는 시간은 1~10초.
export const MASCOT_HIDE = { min: 1, max: 10, def: 3, step: 1 } as const;

export function normalizeHideSec(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return MASCOT_HIDE.def;
  return Math.min(MASCOT_HIDE.max, Math.max(MASCOT_HIDE.min, Math.round(n)));
}
