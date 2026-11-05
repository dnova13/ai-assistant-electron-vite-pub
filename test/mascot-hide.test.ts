import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MascotAutoHide } from '../src/main/mascot-hide';
import { normalizeHideSec } from '../src/shared/mascot';
import { normalize as normalizeSettings } from '../src/main/settings';

function make(cfg = { on: true, sec: 3 }) {
  const log: string[] = [];
  const h = new MascotAutoHide({ config: () => cfg, show: () => log.push('show'), hide: () => log.push('hide') });
  return { h, log, cfg };
}

describe('마스코트 자동 숨김', () => {
  it('활동이 없으면(켠 채로 아무 말도 안 해도) 설정한 초 뒤에 숨긴다', () => {
    const { h, log } = make();
    h.settingsChanged(true);
    vi.advanceTimersByTime(3100);
    expect(log).toEqual(['hide']);
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('답이 끝나고 설정한 초가 지나면 숨긴다', () => {
    const { h, log } = make();
    h.feed({ type: 'bubble', text: '안녕', final: true });
    vi.advanceTimersByTime(2900);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(log).toEqual(['hide']);
  });

  it('숨겨진 뒤 말을 걸면(생각 중) 다시 나타나고, 끝나면 다시 숨긴다', () => {
    const { h, log } = make();
    h.feed({ type: 'state', state: 'idle' });
    vi.advanceTimersByTime(3000);
    h.feed({ type: 'state', state: 'thinking' });
    expect(log).toEqual(['hide', 'show']);
    h.feed({ type: 'bubble', text: '응', final: true });
    vi.advanceTimersByTime(3000);
    expect(log).toEqual(['hide', 'show', 'hide']);
  });

  it('말하는 중이거나 녹음 중에는 숨기지 않는다', () => {
    const { h, log } = make();
    h.feed({ type: 'bubble', text: '안녕', final: true });
    h.feed({ type: 'state', state: 'talking' });
    vi.advanceTimersByTime(10000);
    expect(log).toEqual([]);
    h.feed({ type: 'recording', on: true });
    h.feed({ type: 'state', state: 'idle' });
    vi.advanceTimersByTime(10000);
    expect(log).toEqual([]);
    h.feed({ type: 'recording', on: false });
    vi.advanceTimersByTime(3000);
    expect(log).toEqual(['hide']);
  });

  it('계속 켜두기(꺼짐)면 아무것도 안 한다', () => {
    const { h, log } = make({ on: false, sec: 3 });
    h.feed({ type: 'bubble', text: '안녕', final: true });
    vi.advanceTimersByTime(20000);
    expect(log).toEqual([]);
  });

  it('숨겨진 채로 계속 켜두기로 바꾸면 다시 보인다', () => {
    const { h, log, cfg } = make();
    h.feed({ type: 'state', state: 'idle' });
    vi.advanceTimersByTime(3000);
    cfg.on = false;
    h.settingsChanged();
    expect(log).toEqual(['hide', 'show']);
  });

  it('빈 말풍선(지우기)은 무시한다', () => {
    const { h, log } = make();
    h.feed({ type: 'bubble', text: '', final: false });
    vi.advanceTimersByTime(10000);
    expect(log).toEqual([]);
  });
});

describe('숨김 시간 설정', () => {
  it('1~10초 정수로 맞춘다', () => {
    expect(normalizeHideSec(0)).toBe(1);
    expect(normalizeHideSec(99)).toBe(10);
    expect(normalizeHideSec(4.4)).toBe(4);
    expect(normalizeHideSec('abc')).toBe(3);
  });
  it('저장된 설정에 없으면 계속 켜두기 + 3초', () => {
    const s = normalizeSettings({ mascot: { enabled: true } } as never);
    expect(s.mascot.autoHide).toBe(false);
    expect(s.mascot.hideSec).toBe(3);
  });
});
