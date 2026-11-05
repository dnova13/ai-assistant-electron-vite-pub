// 대화창의 시각 표시: 말풍선 아래 시각, 날짜 구분선·스크롤 날짜 (모두 이 컴퓨터의 시간대)

const two = (n: number): string => String(n).padStart(2, '0');

/** 저장된 시각(ISO 문자열 등)을 밀리초로. 없거나 읽을 수 없으면 undefined */
export function parseTime(v: string | number | undefined | null): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** "오전 12:01:07" (12시간제, 자정은 오전 12시, 정오는 오후 12시) */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? '오전' : '오후'} ${two(h12)}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** 날짜 구분선·스크롤 날짜에 쓰는 "2026.10.21" (같은 날이면 같은 값) */
export function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())}`;
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/** 구분선·날짜 알약에 보여 주는 "2026.10.21 (수)" */
export function formatDayLabel(ms: number): string {
  return `${formatDay(ms)} (${WEEK[new Date(ms).getDay()]})`;
}
