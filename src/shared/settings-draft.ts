// 열어 둔 설정창에서 고치지 않은 값은 대화창의 최신 값을 사용한다.
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function mergeSettingsDraft<T>(base: T, draft: T, latest: T): T {
  if (equal(base,draft)) return latest;
  if (equal(base,latest) || equal(draft,latest)) return draft;
  if (object(base) && object(draft) && object(latest)) {
    const keys = new Set([...Object.keys(base),...Object.keys(draft),...Object.keys(latest)]);
    return Object.fromEntries([...keys].map(k => [k,mergeSettingsDraft(base[k],draft[k],latest[k])]).filter(([,v]) => v !== undefined)) as T;
  }
  throw new Error('다른 창에서 같은 설정이 바뀌었습니다. 설정창을 다시 열어 확인해 주세요.');
}
