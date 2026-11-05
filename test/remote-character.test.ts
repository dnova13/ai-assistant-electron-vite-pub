import { describe, it, expect } from 'vitest';
import { remoteCharacter } from '../src/shared/remote-character';
import { normalize } from '../src/main/settings';
import type { Character } from '../src/shared/types';

const characters = ['a', 'b', 'c'].map(id => ({ id, config: { name: id } })) as Character[];
const settings = () => normalize({ profiles: { first: { type: 'assistant', baseUrl: 'https://unit.invalid' }, second: { type: 'assistant', baseUrl: 'https://unit.invalid' } }, characterAi: { a: 'first', b: 'second', c: 'first' }, characterOrder: ['b', 'c', 'a'] });

describe('비서 서버 요청 캐릭터', () => {
  it('주소가 같아도 등록 프로필 ID를 사용하며 순서의 첫 표시 캐릭터를 고른다', () => {
    expect(remoteCharacter(settings(), characters, 'first')?.id).toBe('c');
    expect(remoteCharacter(settings(), characters, 'second')?.id).toBe('b');
  });
  it('현재 표시 캐릭터가 같은 프로필이면 목록의 앞 캐릭터로 전환하지 않는다', () => {
    const s = settings(); s.character = 'a';
    expect(remoteCharacter(s, characters, 'first')?.id).toBe('a');
  });
  it('현재 캐릭터가 다른 프로필이면 같은 주소여도 등록 프로필의 첫 표시 캐릭터로 전환한다', () => {
    const s = settings(); s.character = 'b';
    expect(remoteCharacter(s, characters, 'first')?.id).toBe('c');
  });
  it('현재 캐릭터가 숨김·삭제 상태면 남은 첫 표시 캐릭터로 전환한다', () => {
    const s = settings(); s.character = 'a'; s.hiddenCharacters = ['a'];
    expect(remoteCharacter(s, characters, 'first')?.id).toBe('c');
    s.hiddenCharacters = []; s.character = 'gone'; s.characterAi.gone = 'first';
    expect(remoteCharacter(s, characters, 'first')?.id).toBe('c');
  });
  it('숨김 캐릭터를 제외하고 모두 숨겼으면 다른 AI로 대체하지 않는다', () => {
    const s = settings(); s.hiddenCharacters = ['c'];
    expect(remoteCharacter(s, characters, 'first')?.id).toBe('a');
    s.hiddenCharacters.push('a');
    expect(remoteCharacter(s, characters, 'first')).toBeNull();
  });
  it('없는 프로필·삭제된 캐릭터·지정 없는 캐릭터는 고르지 않는다', () => {
    const s = settings(); s.characterAi.gone = 'first'; delete s.characterAi.a; delete s.characterAi.c;
    expect(remoteCharacter(s, characters, 'first')).toBeNull();
    expect(remoteCharacter(s, characters, '')).toBeNull();
    expect(remoteCharacter(s, characters, 'missing')).toBeNull();
  });
});
