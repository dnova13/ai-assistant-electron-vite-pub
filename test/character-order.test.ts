import { describe, it, expect } from 'vitest';
import { cleanOrder, dropOn, moveTo, setLocked, sortCharacters } from '../src/shared/character-order';
import { normalize } from '../src/main/settings';

const L = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (l: { id: string }[]) => l.map((x) => x.id);

describe('캐릭터 순서', () => {
  it('저장된 순서대로, 없는 캐릭터는 원래 순서로 뒤에', () => {
    expect(ids(sortCharacters(L('a', 'b', 'c', 'd'), ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(sortCharacters(L('a', 'b'), []))).toEqual(['a', 'b']);
  });
  it('지워진 캐릭터가 순서에 남아 있어도 문제없다', () => {
    expect(ids(sortCharacters(L('a', 'b'), ['x', 'b', 'a']))).toEqual(['b', 'a']);
  });
  it('저장할 순서를 정리한다 (문자열만·중복 제거·있는 것만·빠진 건 뒤에)', () => {
    expect(cleanOrder(['b', 'b', 'zz', 3, 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(cleanOrder('나쁜 값', ['a', 'b'])).toEqual(['a', 'b']);
  });
  it('번호로 옮기기·범위 밖은 맨 앞/뒤', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'b', 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveTo(['a', 'b'], 'zz', 0)).toEqual(['a', 'b']);
  });
  it('끌어 놓기: 오른쪽으로 끌면 뒤, 왼쪽으로 끌면 앞', () => {
    expect(dropOn(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(dropOn(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(dropOn(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c']);
  });
  it('설정에 없으면 빈 순서, 나쁜 값은 정리', () => {
    expect(normalize({}).characterOrder).toEqual([]);
    expect(normalize({ characterOrder: ['a', 'a', 5, 'b'] }).characterOrder).toEqual(['a', 'b']);
  });
});

describe('삭제 잠금', () => {
  it('잠그고 풀기 (중복 없이)', () => {
    expect(setLocked([], 'a', true, ['a', 'b'])).toEqual(['a']);
    expect(setLocked(['a'], 'a', true, ['a', 'b'])).toEqual(['a']);
    expect(setLocked(['a', 'b'], 'a', false, ['a', 'b'])).toEqual(['b']);
  });
  it('없는 캐릭터는 잠그지 않고, 지워진 캐릭터의 잠금은 정리', () => {
    expect(setLocked([], 'zz', true, ['a'])).toEqual([]);
    expect(setLocked(['gone', 'a'], 'b', true, ['a', 'b'])).toEqual(['a', 'b']);
  });
  it('설정에 없으면 빈 목록, 나쁜 값은 정리', () => {
    expect(normalize({}).lockedCharacters).toEqual([]);
    expect(normalize({ lockedCharacters: ['a', 'a', 1] }).lockedCharacters).toEqual(['a']);
  });
});
