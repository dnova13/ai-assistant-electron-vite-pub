// 받아 적은 글 다듬기: 위스퍼가 조용한 소리에서 지어내는 반복 줄이기·버리기
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cleanTranscript, isRepetitive, maxTokensFor } from '../src/shared/transcript';
import { looksLikeNoise } from '../src/renderer/src/lib/vad';

// 맥에서 실제로 나온 결과 (1~2초 조용한 소리, tiny·base)
const MAC_TINY = ' ' + Array(13).fill('이곳은').join(' ') + '이곳은 ' + Array(16).fill('이곳은').join(' ') + '이곳은 ' + Array(20).fill('이곳은').join(' ');
const MAC_BASE = ' 이곳은 이곳은 이곳은 이곳은 이곳은 이곳은 이곳은 이곳은 이곳은 이곳은 이곳';

test('반복만 있는 결과는 지어낸 것으로 보고 버린다 (맥 tiny·base 결과)', () => {
  assert.equal(cleanTranscript(MAC_TINY), '');
  assert.equal(cleanTranscript(MAC_BASE), '');
  assert.equal(isRepetitive(MAC_TINY), true);
  assert.equal(cleanTranscript(' toward toward toward toward toward toward toward toward toward'), '');
});

test('보통 말은 그대로', () => {
  for (const t of ['오늘 날씨 어때?', '내일 아침 7시에 깨워 줘', '네 네 알겠어요', '하나 둘 셋 넷 다섯']) assert.equal(cleanTranscript(t), t);
  assert.equal(isRepetitive('오늘 날씨 어때?'), false);
  assert.equal(cleanTranscript(''), '');
});

test('말 뒤에 붙은 반복은 한 번만 남긴다', () => {
  assert.equal(cleanTranscript('오늘 날씨 어때 어때 어때 어때 어때'), '오늘 날씨 어때');
  assert.equal(cleanTranscript('불 꺼 줘 불 꺼 줘 불 꺼 줘 불 꺼 줘'), '불 꺼 줘');
  assert.equal(cleanTranscript('좋아요좋아요좋아요 고마워'), '좋아요 고마워');
});

test('최대 글자 조각 수: 소리 길이에 맞춤', () => {
  assert.equal(maxTokensFor(1), 25);
  assert.equal(maxTokensFor(2), 40);
  assert.equal(maxTokensFor(0.1), 18); // 최소 0.5초로 계산
  assert.equal(maxTokensFor(60), 440); // 30초 덩어리 기준 최대
});

test('호출어·이어서 대화: 반복과 방송 문구는 잡음으로 본다', () => {
  assert.equal(looksLikeNoise(MAC_BASE), true);
  assert.equal(looksLikeNoise(' MBC 뉴스 김상현입니다.'), true); // 맥 small 결과
  assert.equal(looksLikeNoise('자막 제공: 아무개'), true);
  assert.equal(looksLikeNoise('날씨가 좋습니다.'), false);
  assert.equal(looksLikeNoise('루나야'), false);
});
