import type { Status } from '../controller';

export function TopBar({ name, status, onSettings, hideStatus = false }: { name: string; status: Status; hideStatus?: boolean; onSettings: () => void }) {
  return (
    <header id="topbar">
      <div id="charName">{name}</div>
      <div id="status" className={`status ${status.kind}${hideStatus ? ' hidden' : ''}`} title={status.title}>
        {status.text}
      </div>
      <button id="btnSettings" title="설정" onClick={onSettings}>
        ⚙
      </button>
    </header>
  );
}
