import { describe, it, expect } from 'vitest';
import { formatClock, formatDay, formatDayLabel, parseTime } from '../src/shared/chat-time';

const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe('대화 시각 표시', () => {
  it('오전·오후와 12시간제 (자정은 오전 12시, 정오는 오후 12시)', () => {
    expect(formatClock(at(2026, 10, 21, 0, 1, 7))).toBe('오전 12:01:07');
    expect(formatClock(at(2026, 10, 21, 9, 5, 0))).toBe('오전 09:05:00');
    expect(formatClock(at(2026, 10, 21, 12, 0, 0))).toBe('오후 12:00:00');
    expect(formatClock(at(2026, 10, 20, 23, 50, 7))).toBe('오후 11:50:07');
  });
  it('날짜는 yyyy.mm.dd, 자정 전후로 날짜가 바뀐다', () => {
    expect(formatDay(at(2026, 10, 20, 23, 59, 59))).toBe('2026.10.20');
    expect(formatDay(at(2026, 10, 21, 0, 0, 0))).toBe('2026.10.21');
    expect(formatDay(at(2026, 1, 5, 12, 0, 0))).toBe('2026.01.05');
  });
  it('구분선 날짜에 요일이 붙는다', () => {
    expect(formatDayLabel(at(2026, 10, 21, 0, 1, 7))).toBe('2026.10.21 (수)');
    expect(formatDayLabel(at(2026, 10, 18, 12, 0, 0))).toBe('2026.10.18 (일)');
    expect(formatDayLabel(at(2026, 10, 24, 23, 59, 59))).toBe('2026.10.24 (토)');
  });
  it('저장된 시각 읽기: 문자열·숫자는 되고 비었거나 이상하면 undefined', () => {
    const t = at(2026, 10, 21, 0, 1, 7);
    expect(parseTime(new Date(t).toISOString())).toBe(t);
    expect(parseTime(t)).toBe(t);
    expect(parseTime(undefined)).toBeUndefined();
    expect(parseTime('')).toBeUndefined();
    expect(parseTime('날짜아님')).toBeUndefined();
  });
});
