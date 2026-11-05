import { test, expect, vi, afterEach } from 'vitest';
import { createSaveNotice } from '../src/shared/save-notice';
import { connectionInfo, patchProfile, profileSub } from '../src/shared/profile-summary';
import { normalize, createStore } from '../src/main/settings';
import { blankProfile } from '../src/shared/char-prefs';
import type { Health } from '../src/shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { tmpBase } from './tmp-base';

afterEach(() => vi.useRealTimers());
test('저장 성공·실패는 다른 색상용 종류와 문구를 반환하고 각각 1초 후 사라진다', () => {
  vi.useFakeTimers();
  const change = vi.fn();
  const toast = createSaveNotice(change);
  toast.show(true);
  expect(change).toHaveBeenLastCalledWith({ kind: 'success', text: '저장되었습니다.' });
  vi.advanceTimersByTime(999);
  expect(change).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(change).toHaveBeenLastCalledWith(null);
  toast.show(false);
  expect(change).toHaveBeenLastCalledWith({ kind: 'error', text: '저장에 실패했습니다.' });
  vi.advanceTimersByTime(1000);
  expect(change).toHaveBeenLastCalledWith(null);
});
test('이전 알림의 타이머가 연속 저장 결과를 먼저 지우지 않는다', () => {
  vi.useFakeTimers();
  const change = vi.fn(); const toast = createSaveNotice(change);
  toast.show(true); vi.advanceTimersByTime(700); toast.show(false);
  vi.advanceTimersByTime(300);
  expect(change).toHaveBeenLastCalledWith({ kind: 'error', text: '저장에 실패했습니다.' });
  vi.advanceTimersByTime(700); expect(change).toHaveBeenLastCalledWith(null);
});
test('창 닫기·해제 후 기존 타이머가 남지 않는다', () => {
  vi.useFakeTimers();
  const change = vi.fn(); const toast = createSaveNotice(change);
  toast.show(true); toast.clear(); change.mockClear(); vi.advanceTimersByTime(1000);
  expect(change).not.toHaveBeenCalled();
  toast.show(true); toast.dispose(); change.mockClear(); toast.show(false); vi.advanceTimersByTime(1000);
  expect(change).not.toHaveBeenCalled();
});
const health = { provider: 'assistant', server: 'assistant-server', version: '0.4.0', model: 'model-for-test' } as Health;
const profile = () => ({ ...blankProfile(), type: 'assistant' as const, connectionInfo: connectionInfo(health) });
test('내 서버 카드에는 확인된 정보만 표시하고 정보가 없으면 종류만 표시한다', () => {
  expect(profileSub({ ...blankProfile(), type: 'assistant' })).toBe('내 서버');
  expect(profileSub(profile())).toBe('내 서버 · assistant-server 0.4.0 · 모델 model-for-test');
  expect(profileSub({ ...profile(), connectionInfo: { server: '', version: '', model: '' } })).toBe('내 서버');
});
test('서버 주소·종류·키가 바뀌면 확인 정보가 지워지고 이름·타임아웃 변경에는 유지된다', () => {
  for (const patch of [{ baseUrl: 'changed' }, { type: 'ollama' as const }, { apiKey: 'changed' }]) expect(patchProfile(profile(), patch).connectionInfo).toBeUndefined();
  expect(patchProfile(profile(), { name: '다른 이름', timeoutSec: 120 }).connectionInfo).toEqual(profile().connectionInfo);
});
test('연결 확인 정보는 저장·재로드해도 남고 응답에 없던 모델을 만들지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(tmpBase(), 'profile-info-'));
  const store = createStore(path.join(dir, 'settings.json'), null);
  store.save(normalize({ profiles: { a: profile() } }));
  expect(profileSub(store.load().profiles.a)).toBe(profileSub(profile()));
  expect(connectionInfo({ ...health, model: '' })).toEqual({ server: 'assistant-server', version: '0.4.0', model: '' });
  expect(connectionInfo({ ...health, provider: 'ollama' })).toBeUndefined();
  expect(normalize({ profiles: { a: { ...profile(), type: 'gemini' } } }).profiles.a.connectionInfo).toBeUndefined();
});
