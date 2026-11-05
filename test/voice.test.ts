// 음성 대화와 답 읽기: 말소리 감지, 마이크 맞추기, 잡음 거르기, 설정 기본값·옮기기, 읽기 순서(내장 / 서버 실패 시 내장), TTS 서버
import { test, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VadLogic, calibrate, looksLikeNoise, levelToDb, noiseOf, shouldSkipTranscribe } from '../src/renderer/src/lib/vad';
import { LipSync, TtsQueue, type Speaker } from '../src/renderer/src/lib/voice';
import { createStore, defaults, normalize } from '../src/main/settings';
import { blankProfile } from '../src/shared/char-prefs';
import { halfSec, normalizeFollowUp, normalizeTtsOut, normalizeVad, ttsActive, ttsServerReady } from '../src/shared/voice';
import * as tts from '../src/main/tts';
import type { Health, Settings } from '../src/shared/types';

/* ---------------- 말소리 감지 ---------------- */

/** 50ms마다 소리 크기를 넣고 생긴 일을 [시각, 일]로 모은다 */
function run(vad: VadLogic, levels: [number, number][]): [number, string][] {
  const out: [number, string][] = [];
  let t = 0;
  for (const [db, ms] of levels) {
    for (let i = 0; i < ms; i += 50, t += 50) {
      const ev = vad.feed(db, t);
      if (ev) out.push([t, ev]);
    }
  }
  return out;
}

const V = { marginDb: 12, silenceMs: 1500, noSpeechMs: 5000 };

test('말소리 감지: 일정한(폭이 없는) 소리는 말 시작으로 보지 않는다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60, noSpeechMs: 2000 });
  assert.deepEqual(run(vad, [[-30, 2500]]).map((e) => e[1]), ['nospeech']);
  const talk = new VadLogic({ ...V, noiseDb: -60 });
  const ev = run(talk, Array.from({ length: 10 }, (_, i) => [i % 2 ? -36 : -22, 100] as [number, number]));
  assert.deepEqual(ev.map((e) => e[1]), ['speech']);
});

test('말소리 감지: 두 선 (말소리선 = 소음 + 12, 멈춤선 = 소음 + 3)', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60 });
  assert.equal(vad.speechLine, -48);
  assert.equal(vad.silenceLine, -57);
});

test('말소리 감지: 말한 뒤 소음 근처로 내려와 조용함 기준 시간이 지나면 silence', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60 });
  const ev = run(vad, [
    [-60, 500],
    [-30, 1000],
    [-60, 2500]
  ]);
  assert.deepEqual(
    ev.map((e) => e[1]),
    ['speech', 'silence']
  );
  // 말이 1500ms에 끝남 → 약 1.5초 뒤 끝 (부드럽게 하느라 조금 늦을 수 있음)
  const at = ev[1][0];
  assert.ok(at >= 1500 + 1450 && at <= 1500 + 1900, String(at));
  assert.equal(vad.heard, true);
});

test('말소리 감지: 처음에 말이 없으면 nospeech', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60, noSpeechMs: 3000 });
  const ev = run(vad, [[-60, 5000]]);
  assert.deepEqual(ev, [[3000, 'nospeech']]);
  assert.equal(vad.heard, false);
});

test('말소리 감지: 음절 사이에 잠깐씩 작아지는 말도 말 시작으로 본다 (0.1초 크고 0.05초 작음 반복)', () => {
  const vad = new VadLogic({ ...V, noiseDb: -45 });
  const syll: [number, number][] = [];
  for (let i = 0; i < 8; i++) syll.push([-21, 100], [-44, 50]);
  const ev = run(vad, [[-45, 1000], ...syll, [-45, 2000]]);
  assert.deepEqual(ev.map((e) => e[1]), ['speech', 'silence']);
  assert.ok(ev[0][0] < 1000 + 400, `빨리 알아챔: ${ev[0][0]}`);
});

test('말소리 감지: 문소리 같은 짧은 소리(0.1초)는 말로 보지 않는다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60, noSpeechMs: 3000 });
  const ev = run(vad, [
    [-60, 500],
    [-20, 100],
    [-60, 3000]
  ]);
  assert.deepEqual(
    ev.map((e) => e[1]),
    ['nospeech']
  );
});

test('말소리 감지: 말 사이 짧은 쉼(0.8초)에는 끊지 않는다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60 });
  const ev = run(vad, [
    [-30, 600],
    [-60, 800],
    [-30, 500],
    [-60, 2500]
  ]);
  assert.deepEqual(
    ev.map((e) => e[1]),
    ['speech', 'silence']
  );
  assert.ok(ev[1][0] > 1900 + 1400, '마지막 말 뒤에 끝나야 함');
});

test('말소리 감지: 주변 소음이 오르내려도(-52 ~ -46) 소음 근처면 멈춤으로 본다 (예전 방식은 기준 -48에 걸려 안 끝남)', () => {
  const vad = new VadLogic({ ...V, noiseDb: -50 });
  const noisy: [number, number][] = [];
  for (let i = 0; i < 40; i++) noisy.push([[-52, -47, -49, -46, -51][i % 5], 50]);
  const talk: [number, number][] = Array.from({ length: 10 }, (_, i) => [i % 2 ? -36 : -22, 100] as [number, number]); // 말은 음절마다 크고 작아짐
  const ev = run(vad, [...talk, ...noisy]);
  assert.deepEqual(
    ev.map((e) => e[1]),
    ['speech', 'silence']
  );
  assert.ok(ev[1][0] < 1000 + 2200, String(ev[1][0]));
});

test('말소리 감지: 잰 소음보다 실제 소음이 커져도(에어컨) 듣는 동안 따라가서 결국 끝난다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60 }); // 설정에서 잰 값
  const ev = run(vad, [
    [-20, 1000],
    [-45, 8000] // 실제 소음: 말소리선(-48)과 멈춤선(-57) 사이
  ]);
  assert.deepEqual(
    ev.map((e) => e[1]),
    ['speech', 'silence']
  );
  assert.ok((vad.noise as number) > -50, `소음 값이 따라 올라감: ${vad.noise}`);
  assert.ok(ev[1][0] < 1000 + 6500, String(ev[1][0]));
});

test('말소리 감지: 일정한 소음이 말소리선보다 커도(잰 값이 너무 낮음) 말로 보지 않고, 소음 값을 따라 올린다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60 });
  const ev = run(vad, [[-40, 6000]]); // 말 없이 일정한 소음만
  assert.deepEqual(ev.map((e) => e[1]), ['nospeech']); // 소음을 말로 보내지 않는다
  assert.ok((vad.noise as number) > -45, String(vad.noise));
});

test('말소리 감지: 시끄러운 방(잰 값이 너무 낮음)에서 몇 초 뒤에 말해도 말과 멈춤을 알아챈다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60, noSpeechMs: 8000 });
  const noisy = (ms: number): [number, number][] => Array.from({ length: ms / 50 }, (_, i) => [[-41, -40, -42, -39, -40][i % 5], 50] as [number, number]);
  const ev = run(vad, [...noisy(3000), [-15, 1500], ...noisy(4000)]);
  assert.deepEqual(ev.map((e) => e[1]), ['speech', 'silence']);
  assert.ok(ev[0][0] >= 3000, `말은 3초부터: ${ev[0][0]}`);
});

test('말소리 감지: 쉼 없이 6초 동안 길게 말해도(음절마다 크고 작아짐) 소음으로 보지 않고 끊지 않는다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60 });
  const talk = Array.from({ length: 60 }, (_, i) => [i % 2 ? -36 : -22, 100] as [number, number]);
  const ev = run(vad, [...talk, [-60, 2500]]);
  assert.deepEqual(ev.map((e) => e[1]), ['speech', 'silence']);
  assert.ok(ev[1][0] > 6000 + 1400, `말이 끝난 뒤에 끝나야 함: ${ev[1][0]}`);
  assert.ok((vad.noise as number) < -50, `소음 값이 말소리로 끌려가지 않음: ${vad.noise}`);
});

/** 음절마다 크고 작아지는 말. 큰 쪽이 center + 6 */
const talkAt = (center: number, ms: number): [number, number][] => Array.from({ length: ms / 50 }, (_, i) => [center + [6, 2, -3, -8, 4, -1, -10, 5][i % 8], 50] as [number, number]);

test('말소리 감지: 크게 말하고 멈춘 뒤에도 소음 값이 말소리로 끌려 올라가지 않아 다시 말하면 알아듣는다', () => {
  const first = new VadLogic({ ...V, noiseDb: -54 });
  run(first, [...talkAt(-38, 3000), [-88, 1000], ...talkAt(-38, 1500), [-88, 3000]]);
  assert.ok((first.keepNoise as number) <= -54, `기억할 소음 값이 오르지 않음: ${first.keepNoise}`);
  const next = new VadLogic({ ...V, noiseDb: first.keepNoise });
  const ev = run(next, [[-88, 800], ...talkAt(-38, 2000)]);
  assert.equal(ev[0][1], 'speech');
});

test('말소리 감지: 말소리선을 못 넘는 말(여유값 25)이 이어져도 소음 값으로 들어가지 않고, 큰 소리는 다시 잡는다', () => {
  const vad = new VadLogic({ ...V, marginDb: 25, noiseDb: -54 });
  run(vad, talkAt(-38, 3000));
  assert.ok((vad.noise as number) < -45, `소음 값이 말소리로 올라가지 않음: ${vad.noise}`);
  assert.equal(vad.keepNoise, -54);
  const next = new VadLogic({ ...V, marginDb: 25, noiseDb: vad.keepNoise, noSpeechMs: 3000 });
  assert.equal(run(next, [[-88, 500], ...talkAt(-22, 1000)])[0][1], 'speech');
});

test('말소리 감지: 소음 값이 높게 남았어도(-35) 조용해지면 1초쯤 뒤 내려와 다시 말을 알아듣는다', () => {
  const vad = new VadLogic({ ...V, noiseDb: -35 });
  const ev = run(vad, [[-88, 1500], ...talkAt(-38, 1000)]);
  assert.deepEqual(ev.map((e) => e[1]), ['speech']);
  assert.ok(ev[0][0] < 2000, `조용해진 뒤 바로 잡음: ${ev[0][0]}`);
});

test('말소리 감지: 소음 값이 없으면 처음 0.3초를 재서 시작', () => {
  const vad = new VadLogic({ ...V, noiseDb: null, silenceMs: 1000 });
  assert.equal(vad.speechLine, null);
  const ev = run(vad, [
    [-55, 400],
    [-30, 600],
    [-55, 1800]
  ]);
  assert.ok(Math.abs((vad.noise as number) + 55) < 2, String(vad.noise));
  assert.deepEqual(
    ev.map((e) => e[1]),
    ['speech', 'silence']
  );
});

test('말소리 감지: 고쳐 나가기를 끄면 소음 값은 그대로', () => {
  const vad = new VadLogic({ ...V, noiseDb: -60, adapt: false });
  run(vad, [[-45, 4000]]);
  assert.equal(vad.noise, -60);
});

test('소리 크기 → dB', () => {
  assert.equal(levelToDb(1), 0);
  assert.equal(Math.round(levelToDb(0.01)), -40);
  assert.equal(levelToDb(0), -100);
});

test('주변 소음 재기: 조용할 때 소리의 위쪽 값(요동을 덮게)', () => {
  assert.equal(noiseOf([-60, -58, -59, -57, -61, -56, -58, -60]), -58);
  assert.equal(noiseOf([]), -100);
});

test('마이크 맞추기: 주변 소음과 차이(margin)를 정하고, 차이가 작으면 이유를 알려 준다', () => {
  const quiet = Array.from({ length: 40 }, (_, i) => -58 + (i % 3));
  const speech = Array.from({ length: 60 }, (_, i) => (i % 4 ? -28 : -50));
  const r = calibrate(quiet, speech);
  assert.ok(!('error' in r));
  if (!('error' in r)) {
    assert.equal(r.noise, -56); // 조용할 때 소리의 위쪽(75%) 값
    assert.equal(r.voice, -28);
    assert.equal(r.margin, 14); // (−28 − −56) × 0.5
  }
  const wide = calibrate(Array(40).fill(-80), Array(60).fill(-20));
  assert.ok(!('error' in wide) && wide.margin === 25, '최대 25');
  const loud = calibrate(Array(40).fill(-35), Array(60).fill(-30));
  assert.ok('error' in loud && /시끄러워서/.test(loud.error));
  const soft = calibrate(Array(40).fill(-65), Array(60).fill(-60));
  assert.ok('error' in soft && /작게/.test(soft.error));
});

test('이어서 듣기: 잡음처럼 보이는 받아쓰기는 말이 없던 것으로 본다', () => {
  for (const t of ['', '.', '음', '감사합니다.', '시청해 주셔서 감사합니다', 'Thank you.']) assert.equal(looksLikeNoise(t), true, t);
  for (const t of ['우산 챙겨야 해?', '고마워', '내일은?']) assert.equal(looksLikeNoise(t), false, t);
});

/* ---------------- 설정 ---------------- */

test('설정 기본값: 자동 전송·이어서 대화·내장 목소리', () => {
  const d = defaults();
  assert.equal(d.voice.autoSend, true);
  assert.deepEqual(d.voice.vad, { autoStop: true, silenceSec: 1.5, noSpeechSec: 5, noiseDb: null, marginDb: 12, minSpokenSec: 0.3 });
  assert.deepEqual(d.voice.followUp, { enabled: true, waitSec: 6, endChime: true });
  assert.equal(d.voice.ttsOut.source, 'builtin');
  assert.equal(d.voice.ttsOut.fallbackBuiltin, true);
});

test('설정 옮기기: 예전 설정(자동 전송 없음)은 바로 보내기를 한 번 켜고, 그 뒤에는 사용자 선택을 지킨다', () => {
  const old = normalize({ voice: { tts: true, autoSend: false } });
  assert.equal(old.voice.autoSend, true);
  assert.equal(old.voice.vad.autoStop, true);
  const later = normalize(JSON.parse(JSON.stringify({ ...old, voice: { ...old.voice, autoSend: false } })));
  assert.equal(later.voice.autoSend, false);
});

test('설정 정리: 범위 밖 값과 잘못된 값', () => {
  assert.deepEqual(normalizeVad({ autoStop: 'x', silenceSec: 9, noSpeechSec: 0, noiseDb: -200, marginDb: 99 }), { autoStop: true, silenceSec: 3, noSpeechSec: 0.5, noiseDb: -100, marginDb: 25, minSpokenSec: 0.3 });
  assert.equal(normalizeVad({ noiseDb: null }).noiseDb, null);
  assert.equal(normalizeVad({ noiseDb: '-55.4' }).noiseDb, -55);
  assert.equal(normalizeVad({ marginDb: 2 }).marginDb, 6);
  // 예전 고정 기준(thresholdDb)은 버리고, 소음은 다시 잰다
  const old = normalizeVad({ thresholdDb: -40 });
  assert.equal(old.noiseDb, null);
  assert.ok(!('thresholdDb' in old));
  const n = normalize({ voice: { followUp: { waitSec: 99 }, ttsOut: { source: 'cloud', builtin: { rate: 5 }, server: { baseUrl: ' http://x:1/ ' } } } });
  assert.equal(n.voice.followUp.waitSec, 15);
  assert.equal(n.voice.ttsOut.source, 'builtin');
  assert.equal(n.voice.ttsOut.builtin.rate, 2);
  assert.equal(n.voice.ttsOut.server.baseUrl, 'http://x:1');
});

test('시간 설정은 0.5초 단위로 맞추고 범위 안으로 (숫자 칸 입력)', () => {
  assert.equal(halfSec('2.3', 1.5, 1, 3), 2.5);
  assert.equal(halfSec(2.2, 1.5, 1, 3), 2);
  assert.equal(halfSec('20', 6, 3, 15), 15);
  assert.equal(halfSec('abc', 6, 3, 15), 6);
  assert.equal(halfSec(0.7, 5, 2, 15), 2);
  assert.deepEqual(normalizeVad({ silenceSec: 1.74, noSpeechSec: 4.3 }), { autoStop: true, silenceSec: 1.5, noSpeechSec: 4.5, noiseDb: null, marginDb: 12, minSpokenSec: 0.3 });
  assert.equal(normalizeFollowUp({ waitSec: 6.5 }).waitSec, 6.5);
  assert.equal(normalizeFollowUp({ waitSec: 7.8 }).waitSec, 8);
});

test('TTS 음량: 기본 100%, 0~100 정수로', () => {
  assert.equal(defaults().voice.ttsOut.volume, 100);
  assert.equal(normalizeTtsOut({}).volume, 100);
  assert.equal(normalizeTtsOut({ volume: 37.6 }).volume, 38);
  assert.equal(normalizeTtsOut({ volume: 150 }).volume, 100);
  assert.equal(normalizeTtsOut({ volume: -5 }).volume, 0);
  assert.equal(normalizeTtsOut({ volume: 'x' }).volume, 100);
});

test('단축키 설정: TTS 켜기/끄기는 기본 비어 있고, 예전 설정에도 채워진다', () => {
  assert.deepEqual(defaults().shortcut, { ptt: 'CommandOrControl+Shift+Space', ttsToggle: '' });
  const old = normalize({ shortcut: { ptt: 'Alt+F2' } });
  assert.deepEqual(old.shortcut, { ptt: 'Alt+F2', ttsToggle: '' });
  assert.equal(normalize({ shortcut: { ptt: 'Alt+F2', ttsToggle: 5 } }).shortcut.ttsToggle, '');
});

test('TTS 서버 키도 암호화해서 저장한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-key-'));
  const file = path.join(dir, 'settings.json');
  const fake = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from('enc:' + s), decryptString: (b: Buffer) => b.toString().slice(4) };
  const store = createStore(file, fake);
  const s = defaults();
  s.voice.ttsOut = normalizeTtsOut({ source: 'server', server: { baseUrl: 'http://x', apiKey: 'tts-secret' } });
  store.save(s);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('tts-secret'));
  assert.equal(store.load().voice.ttsOut.server.apiKey, 'tts-secret');
});

const health = (ttsOn: boolean): Health => ({
  provider: 'assistant',
  api: '1',
  server: 'x',
  version: '',
  model: '',
  models: [],
  voices: [],
  features: { chatStream: true, stt: false, tts: ttsOn, serverConfirm: false, sessions: true, lowSpec: false, clientActions: [] },
  warning: ''
});

test('읽기 켜짐 판단: 내장 / 서버 / 서버 없음이면 내장으로', () => {
  const s: Settings = defaults();
  assert.equal(ttsActive(s, null, true), true);
  assert.equal(ttsActive(s, null, false), false); // 이 컴퓨터에 목소리 없음
  s.voice.ttsOut.source = 'server';
  assert.equal(ttsServerReady(s, health(false)), false);
  assert.equal(ttsServerReady(s, health(true)), true); // 주소 비움 → 대화 서버 TTS
  assert.equal(ttsActive(s, health(false), true), true); // 서버 없음 → 내장으로
  s.voice.ttsOut.fallbackBuiltin = false;
  assert.equal(ttsActive(s, health(false), true), false);
  s.voice.ttsOut.server.baseUrl = 'http://tts';
  assert.equal(ttsActive(s, null, false), true);
  s.voice.tts = false;
  assert.equal(ttsActive(s, health(true), true), false);
});

/* ---------------- 읽기 순서 (TtsQueue) ---------------- */

class FakeSpeaker implements Speaker {
  said: string[] = [];
  canceled = 0;
  ok = true;
  speak(text: string) {
    this.said.push(text);
    return new Promise<void>((r) => setTimeout(r, 5));
  }
  cancel() {
    this.canceled++;
  }
  available() {
    return this.ok;
  }
}

test('읽기: 내장 목소리로 문장마다 읽고, 다 읽으면 whenIdle이 끝난다', async () => {
  const sp = new FakeSpeaker();
  let synthCalls = 0;
  const speaking: boolean[] = [];
  const q = new TtsQueue({ synth: async () => (synthCalls++, { audio: new Uint8Array(), mime: 'audio/wav' }), builtin: sp, lip: new LipSync(() => {}), onSpeaking: (on) => speaking.push(on) });
  q.enabled = true;
  q.mode = 'builtin';
  q.feed('안녕하세요. **오늘** 날씨는 ');
  q.feed('맑아요! 코드는 `x` 입니다');
  q.flush();
  await q.whenIdle();
  assert.deepEqual(sp.said, ['안녕하세요.', '오늘 날씨는 맑아요!', '코드는 입니다']);
  assert.equal(synthCalls, 0);
  assert.deepEqual(speaking, [true, false]);
  await q.whenIdle(); // 읽을 것이 없으면 바로 끝남
});

test('읽기: 서버가 실패하면 그 답의 남은 문장을 내장 목소리로 읽고, 알림은 한 번만', async () => {
  const sp = new FakeSpeaker();
  let synthCalls = 0;
  const fallbacks: string[] = [];
  const errors: string[] = [];
  const q = new TtsQueue({
    synth: async () => {
      synthCalls++;
      throw new Error('서버 꺼짐');
    },
    builtin: sp,
    lip: new LipSync(() => {}),
    onFallback: (e) => fallbacks.push(e.message),
    onError: (e) => errors.push(e.message)
  });
  q.enabled = true;
  q.mode = 'server';
  q.fallback = true;
  q.feed('첫 문장. 둘째 문장. 셋째 문장. ');
  q.flush();
  await q.whenIdle();
  assert.deepEqual(sp.said, ['첫 문장.', '둘째 문장.', '셋째 문장.']);
  assert.deepEqual(fallbacks, ['서버 꺼짐']);
  assert.deepEqual(errors, []);
  assert.ok(synthCalls <= 2, `서버는 처음 실패 뒤로 더 부르지 않음 (미리 요청 1개 포함): ${synthCalls}`);
});

test('읽기: 내장으로 넘어가기를 끄면 오류로 알린다', async () => {
  const sp = new FakeSpeaker();
  const errors: string[] = [];
  const q = new TtsQueue({
    synth: async () => {
      throw new Error('서버 꺼짐');
    },
    builtin: sp,
    lip: new LipSync(() => {}),
    onError: (e) => errors.push(e.message)
  });
  q.enabled = true;
  q.mode = 'server';
  q.fallback = false;
  q.feed('한 문장. ');
  await q.whenIdle();
  assert.deepEqual(sp.said, []);
  assert.deepEqual(errors, ['서버 꺼짐']);
});

test('읽기: stop은 남은 문장을 버리고 내장 목소리를 멈춘다', async () => {
  const sp = new FakeSpeaker();
  const q = new TtsQueue({ synth: async () => ({ audio: new Uint8Array(), mime: 'audio/wav' }), builtin: sp, lip: new LipSync(() => {}) });
  q.enabled = true;
  q.feed('하나. 둘. 셋. ');
  q.stop();
  await q.whenIdle();
  assert.ok(sp.said.length <= 1);
  assert.equal(sp.canceled, 1);
});

test('읽기: TTS를 끄면(단축키) 읽던 소리가 멈추고, 이어서 오는 답 글은 읽지 않는다', async () => {
  const sp = new FakeSpeaker();
  const q = new TtsQueue({ synth: async () => ({ audio: new Uint8Array(), mime: 'audio/wav' }), builtin: sp, lip: new LipSync(() => {}) });
  q.enabled = true;
  q.feed('하나. 둘. ');
  q.stop();
  q.enabled = false; // 컨트롤러가 TTS 끄기 단축키에서 하는 일
  q.feed('셋. 넷. ');
  q.flush();
  await q.whenIdle();
  assert.ok(sp.said.length <= 1);
  assert.ok(!sp.said.some((t) => /셋|넷/.test(t)));
});

/* ---------------- TTS 서버 ---------------- */

let last: { url: string; body: string; auth: string } | null = null;
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const url = req.url || '';
    const json = (code: number, o: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.endsWith('/v1/tts') || url.endsWith('/v1/audio/speech')) last = { url, body: raw, auth: String(req.headers.authorization || '') };
    // 규약 v1 (대화 서버 겸 TTS)
    if (url === '/v1srv/v1/health') return json(200, { api: '1', server: 'x', features: { tts: true, stt: false, chatStream: true }, tts_voices: ['yuna', 'char-a'] });
    if (url === '/v1srv/v1/tts') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(WAV);
    }
    if (url === '/notts/v1/health') return json(200, { api: '1', features: { tts: false } });
    // OpenAI 호환 오픈소스 TTS (형식 이름을 안 붙여 줌)
    if (url === '/oa/v1/models') return json(200, { data: [{ id: 'kokoro' }, { id: 'xtts-v2' }] });
    if (url === '/oa/v1/audio/voices') return json(200, { voices: ['af_bella', 'ko_char'] });
    if (url === '/oa/v1/audio/speech') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(WAV);
    }
    if (url === '/key/v1/models') return json(401, { error: 'no key' });
    if (url === '/text/v1/models') return json(200, { data: [{ id: 'm' }] });
    if (url === '/text/v1/audio/speech') return json(200, { ok: true });
    json(404, {});
  });
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  last = null;
  tts.clearCache();
});

const cfg = (baseUrl: string, patch: Partial<Settings['voice']['ttsOut']['server']> = {}) => ({ baseUrl, apiKey: '', voice: '', model: '', ...patch });

test('TTS 서버 종류: 규약 v1 / OpenAI 호환(목소리 목록) / 지원 안 함 / 키 / 없음', async () => {
  assert.deepEqual(await tts.detectServer(cfg(base + '/v1srv')), { kind: 'v1', voices: ['yuna', 'char-a'], models: [] });
  assert.deepEqual(await tts.detectServer(cfg(base + '/oa/v1')), { kind: 'openai', voices: ['af_bella', 'ko_char'], models: ['kokoro', 'xtts-v2'] });
  await assert.rejects(tts.detectServer(cfg(base + '/notts')), /지원하지 않는다고/);
  await assert.rejects(tts.detectServer(cfg(base + '/key')), /인증 실패/);
  await assert.rejects(tts.detectServer(cfg(base + '/none')), /찾지 못했습니다/);
  await assert.rejects(tts.detectServer(cfg('ftp://x')), /http/);
});

function deps(server: Settings['voice']['ttsOut']['server'], chatBase = base + '/v1srv/v1') {
  const s = defaults();
  s.voice.ttsOut = normalizeTtsOut({ source: 'server', server });
  return { settings: s, chatProfile: { ...blankProfile(), type: 'assistant' as const, baseUrl: chatBase } };
}

test('TTS 서버: 주소를 비우면 대화 서버(규약 v1)의 TTS를 캐릭터 목소리로', async () => {
  const r = await tts.synthesize('안녕', 'char-a', deps(cfg('')));
  assert.equal(r.mime, 'audio/wav');
  assert.equal(last?.url, '/v1srv/v1/tts');
  assert.equal(JSON.parse(last!.body).voice, 'char-a');
});

test('TTS 서버: OpenAI 호환 서버로 보내고, 형식 이름이 없어도 wav로 알아본다', async () => {
  const r = await tts.synthesize('안녕하세요', 'default', deps(cfg(base + '/oa', { apiKey: 'k1' })));
  assert.equal(r.mime, 'audio/wav');
  assert.equal(last?.url, '/oa/v1/audio/speech');
  assert.equal(last?.auth, 'Bearer k1');
  const body = JSON.parse(last!.body);
  assert.deepEqual(body, { model: 'xtts-v2', input: '안녕하세요', voice: 'af_bella', response_format: 'wav' }); // 모델을 비우면 TTS처럼 보이는 모델
  // 설정의 목소리·모델이 우선, 그다음 캐릭터 목소리
  await tts.synthesize('a', 'char-x', deps(cfg(base + '/oa', { voice: 'ko_char', model: 'kokoro' })));
  assert.deepEqual(JSON.parse(last!.body).voice, 'ko_char');
  assert.deepEqual(JSON.parse(last!.body).model, 'kokoro');
  await tts.synthesize('a', 'char-x', deps(cfg(base + '/oa')));
  assert.deepEqual(JSON.parse(last!.body).voice, 'char-x');
});

test('TTS 서버: 오디오가 아닌 응답은 오류', async () => {
  await assert.rejects(tts.synthesize('a', 'default', deps(cfg(base + '/text'))), /오디오가 아닙니다/);
});

test('듣기를 끝낼 때 말을 거의 안 했으면 받아 적지 않는다 (감지를 켰을 때만)', () => {
  assert.equal(shouldSkipTranscribe(true, 0), true); // 조용히 켰다 끔 → 위스퍼에 안 보냄
  assert.equal(shouldSkipTranscribe(true, 250), true); // 키보드 소리 정도
  assert.equal(shouldSkipTranscribe(true, 300), false); // 말을 했음 → 받아 적음
  assert.equal(shouldSkipTranscribe(false, 0), false); // 누르고 말하기: 알 수 없으니 그대로 받아 적음
});

test('말소리 시간: 켜진 직후 소리는 빼고, 짧게 튄 소리는 말로 치지 않는다', () => {
  const run = (loud: (t: number) => boolean) => {
    const v = new VadLogic({ noiseDb: -52, marginDb: 12, silenceMs: 1500, noSpeechMs: 30000, adapt: false });
    for (let t = 0; t <= 3000; t += 50) v.feed(loud(t) ? -35 : -52, t);
    return v;
  };
  const pop = run((t) => t >= 100 && t < 350); // 켜질 때 0.25초 "툭" + 단축키 소리
  assert.equal(pop.spokenMs, 0);
  assert.equal(shouldSkipTranscribe(true, pop.spokenMs), true);
  const click = run((t) => t >= 1000 && t < 1200); // 중간에 0.2초 키보드 소리
  assert.equal(click.heard, true); // 말 시작 판정(자동으로 끝내기용)은 그대로 빠르다
  assert.ok(click.spokenMs < 300, `${click.spokenMs}`);
  assert.equal(shouldSkipTranscribe(true, click.spokenMs), true);
  const talk = run((t) => (t >= 800 && t < 1300) || (t >= 1400 && t < 1700)); // 0.8초 말
  assert.ok(talk.spokenMs >= 700, `${talk.spokenMs}`);
  assert.equal(shouldSkipTranscribe(true, talk.spokenMs), false);
  assert.equal(talk.peakDb, -35);
});

test('최소 말소리 길이 설정: 기본 0.3초, 0.1초 단위, 0~2초', () => {
  assert.equal(normalizeVad({}).minSpokenSec, 0.3);
  assert.equal(normalizeVad({ minSpokenSec: 0.6 }).minSpokenSec, 0.6);
  assert.equal(normalizeVad({ minSpokenSec: 0.66 }).minSpokenSec, 0.7);
  assert.equal(normalizeVad({ minSpokenSec: 5 }).minSpokenSec, 2);
  assert.equal(normalizeVad({ minSpokenSec: -1 }).minSpokenSec, 0);
  assert.equal(normalizeVad({ minSpokenSec: 'x' }).minSpokenSec, 0.3);
  // 설정 값을 기준으로 쓴다: 0.45초 말소리는 기준 0.3이면 보내고 0.6이면 안 보냄, 0이면 끔
  assert.equal(shouldSkipTranscribe(true, 450, 300), false);
  assert.equal(shouldSkipTranscribe(true, 450, 600), true);
  assert.equal(shouldSkipTranscribe(true, 0, 0), false);
});
