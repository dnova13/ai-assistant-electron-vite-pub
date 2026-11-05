// 설정 > 일반: 마스코트, 저사양 모드, 항상 위 (단축키는 설정 > 단축키)
import type { AppInfo, Settings } from '@shared/types';
import { MASCOT_HIDE } from '@shared/mascot';
import { SecondsField } from './SecondsField';

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  info: AppInfo | null;
}

export function GeneralTab({ settings, update, info }: Props) {
  const setMascot = (patch: Partial<Settings['mascot']>) => update((s) => ({ ...s, mascot: { ...s.mascot, ...patch } }));
  return (
    <div id="tab-general" className="tabPane">
      <label className="check">
        <input id="optMascot" type="checkbox" checked={settings.mascot.enabled} onChange={(e) => update((s) => ({ ...s, mascot: { ...s.mascot, enabled: e.target.checked } }))} />{' '}
        바탕화면에 캐릭터 띄우기 (마스코트)
      </label>
      <p className="hint">캐릭터를 누르면 대화 창이 열리고, 끌면 옮겨집니다. 대화 창을 닫아도 트레이 아이콘에서 다시 열 수 있습니다.</p>
      {settings.mascot.enabled && (
        <div id="mascotHide" className="subBox">
          <label className="check">
            <input id="optMascotAutoHide" type="checkbox" checked={settings.mascot.autoHide} onChange={(e) => setMascot({ autoHide: e.target.checked })} /> 자동 숨김 기능
          </label>
          {settings.mascot.autoHide && (
            <SecondsField id="mascotHideSec" label="숨기기까지" note="활동이 없으면 이만큼 지나 숨김. 말을 걸면 다시 나타남" value={settings.mascot.hideSec} min={MASCOT_HIDE.min} max={MASCOT_HIDE.max} step={MASCOT_HIDE.step} onChange={(v) => setMascot({ hideSec: v })} />
          )}
        </div>
      )}
      <label className="check">
        <input id="optLowSpec" type="checkbox" checked={settings.lowSpec} onChange={(e) => update((s) => ({ ...s, lowSpec: e.target.checked }))} /> 저사양 모드
      </label>
      <p className="hint">작은 모델(직접 연결: 저사양 모델, 비서 서버: 서버에 요청), 짧은 대화 기억, 가벼운 목소리 요청, 캐릭터 그리기 30프레임.</p>
      <label className="check">
        <input id="optTop" type="checkbox" checked={settings.alwaysOnTop} onChange={(e) => update((s) => ({ ...s, alwaysOnTop: e.target.checked }))} /> 대화 창 항상 위에 표시
      </label>
      <p className="hint" id="appInfo" style={{ whiteSpace: 'pre-line' }}>
        {info ? `버전 ${info.version} · ${info.platform}\n실행 기록: ${info.logFile}\n대화 기록: ${info.historyDir}` : ''}
      </p>
    </div>
  );
}
