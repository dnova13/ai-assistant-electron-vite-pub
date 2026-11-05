// 호출어: 이름 비교, 설정 정리, 쓸 수 있는지 판단, 말소리 구간 자르기
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { defaultWake, jamoDistance, matchWake, normalizeWake, normWake, wakeBlocked, wakeModel, wakeModelNote, wakeName } from '../src/shared/wake';
import { WakeListener, WakeSegmenter, pcmToWav } from '../src/renderer/src/lib/wake';
import { defaults, normalize } from '../src/main/settings';

test('호출어 비교: 앞부분에 이름이 있으면 (띄어쓰기·문장부호·뒤에 붙는 말 상관없음)', () => {
  for (const t of ['루나야', '루나야, 오늘 날씨 어때?', '루나!', '아 루나야', '저기 루나', ' 루 나 야 ', 'Luna']) assert.equal(matchWake(t, t === 'Luna' ? 'luna' : '루나'), true, t);
  for (const t of ['오늘 날씨 어때', '나는 루나를 좋아해 정말로', '', '감사합니다']) assert.equal(matchWake(t, '루나'), false, t);
});

test('호출어 비교: 3글자 이상이면 한 글자 틀려도 받음 (위스퍼가 조금 다르게 적을 때)', () => {
  assert.equal(matchWake('하늘이야', '하늘아'), true);
  assert.equal(matchWake('샘플 비소야', '샘플 비서'), true);
  assert.equal(matchWake('삼풀 비소', '샘플 비서'), false); // 두 글자 틀림
  assert.equal(matchWake('루비', '루나'), false); // 2글자 이름은 정확히
});

test('호출어 비교: 소리가 가까운 자모 하나가 다르게 적힌 것은 2글자 이름도 받음 (로그에서 나온 실제 오인식)', () => {
  for (const t of ['장구야', '장구야, 이제 살아있니?', '장구요', '짱고양 답해']) assert.equal(matchWake(t, '짱구'), true, t);
  assert.equal(matchWake('미루야', '미르'), true); // ㅡ→ㅜ
  assert.equal(matchWake('타운아', '다온'), false); // 두 자모(합 1칸)는 2글자 이름에 너무 멀다
  assert.equal(matchWake('누나야', '루나'), false); // ㄴ/ㄹ은 가깝지 않음
  assert.equal(matchWake('루비야', '루나'), false);
  assert.equal(matchWake('감사합니다', '짱구'), false);
  assert.equal(matchWake('MBC 뉴스 김상렬입니다', '짱구'), false);
});

test('호출어 비교: 다른 이름을 부른 말이 먼저 나오고 바로 뒤에 이름이 오는 경우', () => {
  assert.equal(matchWake('윤나야, 짱구야!', '짱구'), true);
  assert.equal(matchWake('유나야 짱구야', '짱구'), true);
  assert.equal(matchWake('나는 루나를 좋아해', '루나'), false); // 앞말이 부르는 말이 아님
  assert.equal(matchWake('오늘 짱구야 어때', '짱구'), false);
  assert.equal(matchWake('오늘 날씨 짱구', '짱구'), false);
});

test('자모 거리: 가까운 자모 바꿔치기는 0.5, 그 밖은 1', () => {
  assert.equal(jamoDistance('짱구', '장구'), 0.5);
  assert.equal(jamoDistance('미르', '미루'), 0.5);
  assert.equal(jamoDistance('루나', '누나'), 1);
  assert.equal(jamoDistance('짱구', '짱구'), 0);
});

test('호출어 이름: 비우면 캐릭터 이름, 비교용 정리', () => {
  assert.equal(wakeName({ ...defaultWake(), name: '' }, '샘플 비서'), '샘플 비서');
  assert.equal(wakeName({ ...defaultWake(), name: '루나' }, '샘플 비서'), '루나');
  assert.equal(normWake(' 루나-야! '), '루나야');
});

test('호출어 설정: 기본 꺼짐, 정리 (파일은 이름만, 경로 거부)', () => {
  assert.deepEqual(defaults().voice.wake, { enabled: false, name: '', ackFile: '', model: 'small', noiseDb: null, marginDb: 12 });
  assert.deepEqual(normalizeWake({ enabled: 'yes', name: '  루나 ', ackFile: 'ack.mp3' }), { enabled: false, name: '루나', ackFile: 'ack.mp3', model: 'small', noiseDb: null, marginDb: 12 });
  assert.equal(normalizeWake({ model: 'base' }).model, 'base');
  assert.equal(normalizeWake({ model: 'large' }).model, 'small'); // 모르는 모델은 기본으로
  for (const bad of ['../x.wav', '/etc/passwd', 'a/b.wav', '.hidden', 'x'.repeat(80)]) assert.equal(normalizeWake({ ackFile: bad }).ackFile, '', bad);
  assert.deepEqual(normalize({ voice: { tts: true } }).voice.wake, defaultWake());
});

test('호출어 소음·말소리 기준은 음성 대화와 따로: 처음 한 번만 음성 대화 값을 복사', () => {
  // 예전 설정(호출어에 기준이 없음): 음성 대화 값을 복사
  const old = normalize({ voice: { vad: { noiseDb: -57, marginDb: 13 }, wake: { enabled: true, name: '루나' } } });
  assert.equal(old.voice.wake.noiseDb, -57);
  assert.equal(old.voice.wake.marginDb, 13);
  // 그 뒤로는 따로: 호출어 값을 바꿔도 음성 대화는 그대로, 음성 대화를 바꿔도 호출어는 그대로
  const saved = normalize({ ...old, voice: { ...old.voice, wake: { ...old.voice.wake, marginDb: 17 } } });
  assert.equal(saved.voice.wake.marginDb, 17);
  assert.equal(saved.voice.vad.marginDb, 13);
  const again = normalize({ ...saved, voice: { ...saved.voice, vad: { ...saved.voice.vad, marginDb: 9, noiseDb: -70 } } });
  assert.equal(again.voice.wake.marginDb, 17);
  assert.equal(again.voice.wake.noiseDb, -57);
  assert.equal(again.voice.vad.marginDb, 9);
  // 범위 밖·잘못된 값은 정리, noiseDb를 null로 지우면 null 그대로 (다시 복사하지 않음)
  assert.equal(normalizeWake({ marginDb: 99 }).marginDb, 25);
  assert.equal(normalizeWake({ marginDb: 'x' }).marginDb, 12);
  assert.equal(normalizeWake({ noiseDb: null }, { noiseDb: -50, marginDb: 10 }).noiseDb, null);
  assert.equal(normalizeWake({}, { noiseDb: -50, marginDb: 10 }).marginDb, 10);
});

test('호출어를 쓸 수 있는지: 앱 안 위스퍼 모델과 이름', () => {
  assert.match(wakeBlocked(defaultWake(), '샘플', []) || '', /위스퍼 모델/);
  assert.match(wakeBlocked(defaultWake(), '', ['tiny']) || '', /이름/);
  assert.equal(wakeBlocked(defaultWake(), '샘플', ['small']), null);
  assert.equal(wakeModel(['small', 'base']), 'base'); // 고른 모델이 없으면 받아 둔 것 중 가장 작은 것
  assert.equal(wakeModel([]), null);
});

test('호출어 모델: 고른 모델을 받아 뒀으면 그것, 아니면 가장 작은 것으로 대신하고 안내', () => {
  const w = { ...defaultWake(), model: 'small' as const };
  assert.equal(wakeModel(['tiny', 'small', 'medium'], 'small'), 'small');
  assert.equal(wakeModel(['tiny', 'medium'], 'small'), 'tiny');
  assert.equal(wakeModelNote(w, ['tiny', 'small']), null);
  assert.match(wakeModelNote(w, ['tiny', 'medium']) || '', /small.*받아 두지 않아 tiny/);
  assert.equal(wakeModelNote(w, []), null); // 모델이 아예 없으면 wakeBlocked가 알린다
});

/** 50ms마다 소리 크기를 넣고 잘린 구간을 모은다 */
function cut(seg: WakeSegmenter, levels: [number, number][]) {
  const out: { start: number; end: number }[] = [];
  let t = 0;
  for (const [db, ms] of levels)
    for (let i = 0; i < ms; i += 50, t += 50) {
      const s = seg.feed(db, t);
      if (s) out.push(s);
    }
  return out;
}
const talk = (ms: number): [number, number][] => Array.from({ length: ms / 100 }, (_, i) => [i % 2 ? -36 : -22, 100] as [number, number]);

test('구간 자르기: 말소리 구간마다 하나씩 (앞에 여유를 붙임), 조용할 때는 없음', () => {
  const seg = new WakeSegmenter({ noiseDb: -60, marginDb: 12 });
  const out = cut(seg, [[-60, 1000], ...talk(800), [-60, 1500], ...talk(600), [-60, 1500]]);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.ok(out[0].start < 1000 && out[0].start > 400, String(out[0].start));
  assert.ok(out[0].end >= 1700 && out[0].end <= 2400, String(out[0].end));
  assert.deepEqual(cut(new WakeSegmenter({ noiseDb: -60, marginDb: 12 }), [[-60, 5000]]), []);
});

test('구간 자르기: 긴 말은 3초에서 잘라 앞부분만, 그 말이 끝날 때까지 다음 구간 없음', () => {
  const seg = new WakeSegmenter({ noiseDb: -60, marginDb: 12 });
  const out = cut(seg, [[-60, 500], ...talk(6000), [-60, 1500], ...talk(600), [-60, 1000]]);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.ok(out[0].end - out[0].start <= 3600, '앞 3초 + 여유');
  assert.ok(out[1].start > 6000, '다음 말');
});

test('구간 자르기: 일정한 소음(팬)은 구간이 아님', () => {
  const seg = new WakeSegmenter({ noiseDb: -60, marginDb: 12 });
  assert.deepEqual(cut(seg, [[-40, 6000]]), []);
});

test('wav 만들기: 16kHz 16비트 모노', () => {
  const w = pcmToWav(new Float32Array([0, 0.5, -0.5, 1]));
  const b = Buffer.from(w);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(34), 16);
  assert.equal(b.length, 44 + 8);
  assert.equal(b.readInt16LE(46), Math.trunc(0.5 * 0x7fff));
});

test('받아 적는 중에 들어온 구간은 버리지 않고 맡아 뒀다가 처리 (가장 최근 것 하나만)', async () => {
  const got: number[] = [];
  let finish: (() => void) | null = null;
  const l = new WakeListener({
    noiseDb: null,
    marginDb: 12,
    onSegment: (wav) => {
      got.push(wav.length);
      return new Promise<void>((r) => (finish = r));
    }
  });
  // 마이크 없이: 최근 소리 조각을 직접 넣고(16kHz, 0.1초씩) 구간을 자른다
  const priv = l as unknown as { chunks: { t: number; data: Float32Array }[]; cut(s: { start: number; end: number }): void };
  priv.chunks = Array.from({ length: 40 }, (_, i) => ({ t: (i + 1) * 128, data: new Float32Array(2048) }));
  priv.cut({ start: 0, end: 500 }); // 첫 구간 → 바로 처리 (처리 중)
  priv.cut({ start: 0, end: 1000 }); // 처리 중에 들어옴 → 맡아 둠
  priv.cut({ start: 0, end: 2000 }); // 또 들어옴 → 이것만 남김 (가장 최근)
  assert.equal(got.length, 1);
  finish!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got.length, 2);
  assert.ok(got[1] > got[0], '맡아 둔 것은 가장 최근(가장 긴) 구간');
  finish!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got.length, 2); // 더 맡아 둔 것 없음
  l.stop();
});
