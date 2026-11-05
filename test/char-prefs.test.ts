// 캐릭터별 AI·목소리, TTS 서버 목록, 빈 프로필로 시작, 예전 설정 옮기기
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, defaults, normalize } from '../src/main/settings';
import { blankProfile, charProfile, charTtsOut, charVoice, charWakeName, charactersUsingProfile, charactersUsingTts, findWakeCharacter, migrateCharPrefs, migrateWakeName, wakeConflicts, withCharacter } from '../src/shared/char-prefs';

describe('처음 설치와 프로필', () => {
  it('처음에는 AI 프로필도 TTS 서버도 없고, 옮길 것도 없다', () => {
    const s = normalize(null);
    expect(s.profiles).toEqual({});
    expect(s.ttsServers).toEqual({});
    expect(s.activeProfile).toBe('');
    expect(s.charPrefsMigrated).toBe(true);
    expect(defaults().profiles).toEqual({});
  });
  it('프로필을 모두 지워도 비운 채로 둔다 (기본 프로필로 되살리지 않음)', () => {
    const s = normalize({ profiles: {}, charPrefsMigrated: true });
    expect(s.profiles).toEqual({});
  });
  it('지운 프로필을 고른 캐릭터는 선택 안 함, 지운 TTS 서버를 쓰던 캐릭터는 컴퓨터 음성', () => {
    const s = normalize({
      profiles: { a: blankProfile('A') },
      characterAi: { x: 'a', y: 'gone' },
      ttsServers: {},
      characterVoice: { x: { engine: 'server', server: 'gone', volume: 50 } },
      charPrefsMigrated: true
    });
    expect(s.characterAi).toEqual({ x: 'a' });
    expect(charProfile(s, 'y')).toBeNull();
    expect(charVoice(s, 'x').engine).toBe('builtin');
    expect(charVoice(s, 'x').volume).toBe(50);
  });
});

describe('캐릭터별 AI·목소리', () => {
  const base = () =>
    normalize({
      profiles: { a: blankProfile('A'), b: blankProfile('B') },
      ttsServers: { t1: { name: '내 TTS', baseUrl: 'http://tts/', apiKey: 'k', model: 'm' } },
      characterAi: { x: 'a', y: 'b' },
      characterVoice: { x: { engine: 'server', server: 't1', voice: '아이', rate: 1.5, volume: 70, fallbackBuiltin: false }, y: { engine: 'builtin', builtinVoice: 'Yuna', rate: 0.8 } },
      charPrefsMigrated: true
    });
  it('캐릭터마다 고른 프로필을 쓴다', () => {
    const s = base();
    expect(charProfile(s, 'x')?.name).toBe('A');
    expect(charProfile(s, 'y')?.name).toBe('B');
    expect(charProfile(s, 'z')).toBeNull();
    expect(withCharacter(s, 'y').activeProfile).toBe('b');
    expect(withCharacter(s, 'z').activeProfile).toBe('');
  });
  it('목소리는 TTS 서버(주소·키·모델) + 캐릭터의 목소리 이름·배속·음량으로 합친다', () => {
    const s = base();
    expect(charTtsOut(s, 'x')).toEqual({
      source: 'server',
      fallbackBuiltin: false,
      volume: 70,
      builtin: { voice: '', rate: 1.5 },
      server: { baseUrl: 'http://tts', apiKey: 'k', voice: '아이', model: 'm' }
    });
    expect(charTtsOut(s, 'y').source).toBe('builtin');
    expect(charTtsOut(s, 'y').builtin).toEqual({ voice: 'Yuna', rate: 0.8 });
    // 정하지 않은 캐릭터는 컴퓨터 음성 기본값
    expect(charTtsOut(s, 'z')).toMatchObject({ source: 'builtin', volume: 100, builtin: { voice: '', rate: 1 } });
  });
  it('이 프로필·서버를 쓰는 캐릭터', () => {
    const s = base();
    expect(charactersUsingProfile(s, 'a')).toEqual(['x']);
    expect(charactersUsingTts(s, 't1')).toEqual(['x']);
  });
});

describe('예전 설정 옮기기 (한 번만)', () => {
  const old = () =>
    normalize({
      activeProfile: 'local',
      profiles: { local: blankProfile('로컬'), other: blankProfile('다른') },
      voice: { ttsOut: { source: 'server', volume: 60, fallbackBuiltin: true, builtin: { voice: 'Yuna', rate: 1.2 }, server: { baseUrl: 'http://192.168.0.10:8880', apiKey: 'k', voice: 'nova', model: '' } } }
    });
  it('사용 중 프로필과 TTS를 기존 캐릭터마다 채운다', () => {
    const s = old();
    expect(s.charPrefsMigrated).toBe(false);
    const m = migrateCharPrefs(s, ['sample', 'hana']);
    expect(m.charPrefsMigrated).toBe(true);
    expect(m.characterAi).toEqual({ sample: 'local', hana: 'local' });
    const ids = Object.keys(m.ttsServers);
    expect(ids.length).toBe(1);
    expect(m.ttsServers[ids[0]]).toMatchObject({ name: '192.168.0.10:8880', baseUrl: 'http://192.168.0.10:8880', apiKey: 'k' });
    expect(charTtsOut(m, 'hana')).toMatchObject({ source: 'server', volume: 60, builtin: { voice: 'Yuna', rate: 1.2 }, server: { voice: 'nova' } });
    // 두 번째는 아무것도 바꾸지 않는다
    expect(migrateCharPrefs(m, ['sample', 'hana', 'new'])).toBe(m);
  });
  it('이 컴퓨터 목소리로 읽고 있었으면 TTS 서버를 만들지 않는다', () => {
    const s = normalize({ activeProfile: 'local', profiles: { local: blankProfile('로컬') }, voice: { ttsOut: { source: 'builtin', volume: 40 } } });
    const m = migrateCharPrefs(s, ['sample']);
    expect(m.ttsServers).toEqual({});
    expect(charTtsOut(m, 'sample')).toMatchObject({ source: 'builtin', volume: 40 });
  });
});

describe('저장', () => {
  it('TTS 서버 키도 암호화해서 저장하고 다시 읽는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-set-'));
    const file = path.join(dir, 'settings.json');
    const fake = { isEncryptionAvailable: () => true, encryptString: (x: string) => Buffer.from('enc:' + x), decryptString: (b: Buffer) => b.toString().slice(4) };
    const store = createStore(file, fake);
    const s = defaults();
    s.ttsServers = { t1: { name: 'T', baseUrl: 'http://t', apiKey: 'tts-secret', model: '' } };
    store.save(s);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('tts-secret');
    expect(store.load().ttsServers.t1.apiKey).toBe('tts-secret');
  });
  it('설정 파일이 없으면 빈 프로필로 시작한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-new-'));
    const s = createStore(path.join(dir, 'settings.json'), null).load();
    expect(s.profiles).toEqual({});
    expect(s.charPrefsMigrated).toBe(true);
  });
});

describe('호출어 (캐릭터마다)', () => {
  const s = normalize({ characterVoice: { a: { wakeName: '비서야' }, c: { wakeName: '짱구' } }, charPrefsMigrated: true });
  const chars = [
    { id: 'a', name: '기본 비서' },
    { id: 'b', name: '짱구' },
    { id: 'c', name: '흰둥이' }
  ];
  it('정해 둔 호출어 → 비었으면 캐릭터 이름', () => {
    expect(charWakeName(s, 'a', '기본 비서')).toBe('비서야');
    expect(charWakeName(s, 'b', '짱구')).toBe('짱구');
  });
  it('어느 캐릭터를 불렀는지 찾는다. 호출어가 같으면 순서가 앞인 캐릭터', () => {
    expect(findWakeCharacter('비서야 오늘 날씨 어때', s, chars)).toBe('a');
    expect(findWakeCharacter('짱구야', s, chars)).toBe('b'); // b(이름 짱구)와 c(호출어 짱구)가 같으면 앞의 b
    expect(findWakeCharacter('흰둥이야', s, chars)).toBe('');
    expect(findWakeCharacter('나는 짱구를 좋아해', s, chars)).toBe('');
  });
  it('호출어가 같은 다른 캐릭터를 알려 준다', () => {
    expect(wakeConflicts('짱구', s, chars.filter((c) => c.id !== 'b'))).toEqual(['흰둥이']);
    expect(wakeConflicts('비서야', s, chars.filter((c) => c.id !== 'a'))).toEqual([]);
  });
  it('예전 전체 호출어는 지금 캐릭터의 호출어로 옮기고 비운다', () => {
    const old = normalize({ character: 'hana', voice: { wake: { enabled: true, name: '루나' } }, charPrefsMigrated: true });
    const m = migrateWakeName(old);
    expect(charVoice(m, 'hana').wakeName).toBe('루나');
    expect(m.voice.wake.name).toBe('');
    expect(m.voice.wake.enabled).toBe(true);
    expect(migrateWakeName(m)).toBe(m);
  });
});
