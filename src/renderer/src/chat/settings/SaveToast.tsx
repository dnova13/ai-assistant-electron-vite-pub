import type { SaveNotice } from '@shared/save-notice';

export function SaveToast({ notice }: { notice: SaveNotice | null }) {
  if (!notice) return null;
  const ok = notice.kind === 'success';
  return <div className={`settingsToast ${notice.kind}`} role={ok ? 'status' : 'alert'} aria-atomic="true">
    <span className="settingsToastIcon" aria-hidden="true">{ok ? '✓' : '!'}</span>
    <span>{notice.text}</span>
  </div>;
}
