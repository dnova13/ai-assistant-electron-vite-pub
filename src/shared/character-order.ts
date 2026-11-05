// 캐릭터 순서: 설정(characterOrder)에 id 목록으로 저장한다. 목록에 없는 캐릭터(새로 추가한 것)는 맨 뒤.

/** 저장된 순서대로 정렬 (없는 id는 원래 순서로 뒤에) */
export function sortCharacters<T extends { id: string }>(list: T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rank.get(a.c.id) ?? Infinity) - (rank.get(b.c.id) ?? Infinity) || a.i - b.i)
    .map((x) => x.c);
}

/** 저장할 순서: 문자열만, 중복 없이, 지금 있는 캐릭터만. 빠진 캐릭터는 뒤에 붙인다 */
export function cleanOrder(order: unknown, ids: readonly string[]): string[] {
  const have = new Set(ids);
  const out: string[] = [];
  if (Array.isArray(order)) for (const v of order) if (typeof v === 'string' && have.has(v) && !out.includes(v)) out.push(v);
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** id를 to번째(0부터)로 옮긴다. 범위 밖이면 맨 앞/맨 뒤 */
export function moveTo(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const out = ids.filter((x) => x !== id);
  out.splice(Math.min(out.length, Math.max(0, to)), 0, id);
  return out;
}

/** 끌어 놓기: id를 target 자리로 (오른쪽으로 끌면 target 뒤, 왼쪽으로 끌면 target 앞에 놓임) */
export function dropOn(ids: readonly string[], id: string, target: string): string[] {
  const to = ids.indexOf(target);
  if (to < 0 || id === target) return [...ids];
  return moveTo(ids, id, to);
}

/** 삭제 잠금: id를 잠그거나 푼다 (있는 캐릭터만, 중복 없이). 잠긴 캐릭터는 삭제할 수 없다 */
export function setLocked(locked: readonly string[], id: string, on: boolean, ids: readonly string[]): string[] {
  const have = new Set(ids);
  const base = locked.filter((x, i) => have.has(x) && locked.indexOf(x) === i && x !== id);
  return on && have.has(id) ? [...base, id] : base;
}

/** 숨겨진 캐릭터는 자동으로 다른 캐릭터로 대체하지 않는다. */
export function visibleCharacters<T extends { id: string }>(list: T[], hidden: readonly string[] = []): T[] {
  return list.filter((c) => !hidden.includes(c.id));
}
export function selectedCharacter<T extends { id: string }>(list: T[], id: string, hidden: readonly string[] = []): T | null {
  return visibleCharacters(list, hidden).find((c) => c.id === id) || null;
}
