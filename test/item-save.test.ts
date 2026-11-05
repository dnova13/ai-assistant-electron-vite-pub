// 항목별 저장: 저장된 설정에 그 항목만 바꿔 넣는다 (다른 탭에서 고치던 값은 건드리지 않음)
import { describe, it, expect } from 'vitest';
import { normalize } from '../src/main/settings';
import { blankProfile } from '../src/shared/char-prefs';
import { applyItem, itemDirty, removeItem } from '../src/renderer/src/chat/settings/itemSave';

const saved = () =>
  normalize({
    profiles: { a: blankProfile('A'), b: blankProfile('B') },
    ttsServers: { t1: { name: 'T', baseUrl: 'http://t', apiKey: '', model: '' } },
    characterAi: { x: 'a' },
    characterVoice: { x: { engine: 'server', server: 't1', rate: 1.2 } },
    lowSpec: false,
    charPrefsMigrated: true
  });

describe('항목별 저장', () => {
  it('프로필 하나만 바꿔 저장하고 다른 편집 값은 저장하지 않는다', () => {
    const base = saved();
    const draft = { ...saved(), lowSpec: true, profiles: { ...base.profiles, a: { ...base.profiles.a, name: 'A2' } } };
    const next = applyItem(base, draft, { kind: 'profile', id: 'a' });
    expect(next.profiles.a.name).toBe('A2');
    expect(next.lowSpec).toBe(false);
    expect(itemDirty(draft, base, { kind: 'profile', id: 'a' })).toBe(true);
    expect(itemDirty(draft, base, { kind: 'profile', id: 'b' })).toBe(false);
  });
  it('새 프로필은 저장 전에는 달라진 것으로 본다', () => {
    const base = saved();
    const draft = { ...base, profiles: { ...base.profiles, n: blankProfile('N') } };
    expect(itemDirty(draft, base, { kind: 'profile', id: 'n' })).toBe(true);
    expect(applyItem(base, draft, { kind: 'profile', id: 'n' }).profiles.n.name).toBe('N');
    // 버리기 = 저장된 값으로 되돌림 → 새 항목은 사라진다
    expect(applyItem(draft, base, { kind: 'profile', id: 'n' }).profiles.n).toBeUndefined();
  });
  it('프로필을 지우면 그 프로필을 고른 캐릭터는 선택 안 함', () => {
    const next = removeItem(saved(), { kind: 'profile', id: 'a' });
    expect(next.profiles.a).toBeUndefined();
    expect(next.characterAi).toEqual({});
  });
  it('TTS 서버를 지우면 쓰던 캐릭터는 컴퓨터 음성', () => {
    const next = removeItem(saved(), { kind: 'tts', id: 't1' });
    expect(next.ttsServers.t1).toBeUndefined();
    expect(next.characterVoice.x.engine).toBe('builtin');
    expect(next.characterVoice.x.server).toBe('');
  });
  it('캐릭터를 저장할 때 고른 새 프로필·TTS 서버도 같이 저장한다', () => {
    const base = saved();
    const draft = {
      ...base,
      profiles: { ...base.profiles, n: blankProfile('N') },
      ttsServers: { ...base.ttsServers, t2: { name: 'T2', baseUrl: 'http://t2', apiKey: '', model: '' } },
      characterAi: { ...base.characterAi, y: 'n' },
      characterVoice: { ...base.characterVoice, y: { ...base.characterVoice.x, server: 't2' } }
    };
    const next = applyItem(base, draft, { kind: 'char', id: 'y' });
    expect(next.characterAi.y).toBe('n');
    expect(next.profiles.n.name).toBe('N');
    expect(next.ttsServers.t2.name).toBe('T2');
    expect(next.characterVoice.y.server).toBe('t2');
    expect(next.characterAi.x).toBe('a');
  });

  it('디스코드 칸은 켜기·토큰·ID만 저장한다', () => {
    const base = normalize({});
    const draft = normalize({ remote: { enabled: true, discord: { apiKey: 't', userId: '42' }, unlockMinutes: 99 } });
    const key = { kind: 'discord' } as const;
    expect(itemDirty(draft, base, key)).toBe(true);
    const next = applyItem(base, draft, key);
    expect(next.remote).toMatchObject({ enabled: true, discord: { apiKey: 't', userId: '42' }, unlockMinutes: base.remote.unlockMinutes });
    expect(itemDirty(draft, next, key)).toBe(false);
  });
});
