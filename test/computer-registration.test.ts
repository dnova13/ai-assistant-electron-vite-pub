import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerComputer } from '../src/main/api/client';
const profile = { type: 'assistant' as const, baseUrl: 'https://unit.invalid/v1', apiKey: '' };
afterEach(() => vi.restoreAllMocks());
describe('컴퓨터 등록 재사용 요청', () => {
  it('최초 등록은 ID 발급을 서버에 맡긴다', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'pc_new', name: '소니' }));
    expect(await registerComputer(profile, '소니')).toEqual({ id: 'pc_new', name: '소니' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ name: '소니' });
  });
  it('재연결과 이름 변경은 기억한 ID를 함께 보낸다', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'pc_old', name: '작업용' }));
    expect(await registerComputer(profile, '작업용', 'pc_old')).toEqual({ id: 'pc_old', name: '작업용' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ name: '작업용', computer_id: 'pc_old' });
    expect(fetch.mock.calls[0][1]?.method).toBe('POST');
  });
  it.each([403, 409])('소유자/이름 충돌 %s는 새 ID 요청으로 우회하지 않는다', async status => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: '시험 거절' }, { status }));
    await expect(registerComputer(profile, '소니', 'pc_old')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
