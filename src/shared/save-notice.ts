// 설정창의 공통 저장 알림. 이전 타이머가 새 알림을 지우지 않게 취소한다.
export type SaveNotice = { kind: 'success' | 'error'; text: string };
export function createSaveNotice(change: (notice: SaveNotice | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const clear = () => { clearTimeout(timer); timer = undefined; change(null); };
  return {
    show(ok: boolean) {
      if (!active) return;
      clearTimeout(timer);
      change({ kind: ok ? 'success' : 'error', text: ok ? '저장되었습니다.' : '저장에 실패했습니다.' });
      timer = setTimeout(clear, 1000);
    },
    clear,
    dispose() { active = false; clearTimeout(timer); }
  };
}
