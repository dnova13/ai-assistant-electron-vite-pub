// 설정 > 단축키: 말하기, TTS 켜기/끄기. 둘 다 전역 단축키라 다른 프로그램을 쓰는 중(바탕화면 모드)에도 된다.
import { useEffect, useState } from 'react';
import type { AppInfo, Settings } from '@shared/types';
import { prettyKey, toAccelerator } from '../../lib/accelerator';
import { DEFAULT_PTT } from '@shared/voice';

type Name = keyof Settings['shortcut'];

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  info: AppInfo | null;
}

interface FieldProps {
  id: string;
  /** 버튼 id 앞부분 (btnPtt → btnPttRecord, btnPttDefault, btnPttClear) */
  btn: string;
  label: string;
  value: string;
  /** 기본값. 빈 문자열이면 "기본값으로" 대신 비어 있는 것이 기본 */
  def: string;
  platform: string;
  /** 다른 단축키와 같으면 경고 */
  clash: string | null;
  onChange: (v: string) => void;
  hint: string;
}

function ShortcutField({ id, btn, label, value, def, platform, clash, onChange, hint }: FieldProps) {
  const [capturing, setCapturing] = useState(false);

  // "바꾸기"를 누르면 다음에 누르는 키 조합을 단축키로 받는다
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(false);
      const acc = toAccelerator(e, platform);
      if (acc) {
        onChange(acc);
        setCapturing(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, platform]);

  return (
    <div className="sttBox" id={`${id}Box`}>
      <label>
        {label}
        <div className="row">
          <input id={id} type="text" readOnly value={capturing ? '' : prettyKey(value, platform)} placeholder={capturing ? '원하는 키 조합을 누르세요 (Esc 취소)' : '없음'} />
          <button id={`${btn}Record`} type="button" onClick={() => setCapturing(true)}>
            {capturing ? '입력 중…' : '바꾸기'}
          </button>
          {def && (
            <button
              id={`${btn}Default`}
              type="button"
              disabled={value === def}
              title={`기본값: ${prettyKey(def, platform)}`}
              onClick={() => {
                onChange(def);
                setCapturing(false);
              }}
            >
              기본값으로
            </button>
          )}
          <button
            id={`${btn}Clear`}
            type="button"
            disabled={!value}
            onClick={() => {
              onChange('');
              setCapturing(false);
            }}
          >
            끄기
          </button>
        </div>
      </label>
      {clash && (
        <p className="warn" id={`${id}Clash`}>
          {clash}
        </p>
      )}
      <p className="hint" id={`${id}Hint`}>
        {hint}
      </p>
    </div>
  );
}

export function ShortcutTab({ settings, update, info }: Props) {
  const platform = info ? String(info.platform) : '';
  const sc = settings.shortcut;
  const set = (name: Name) => (v: string) => update((s) => ({ ...s, shortcut: { ...s.shortcut, [name]: v } }));
  const same = !!sc.ptt && sc.ptt === sc.ttsToggle;

  return (
    <div id="tab-shortcut" className="tabPane">
      <p className="hint">어디서든(다른 프로그램을 쓰는 중에도) 동작하는 단축키입니다. 저장하면 적용됩니다. 다른 프로그램의 같은 키를 가로채므로 잘 안 쓰는 조합을 고르세요.</p>
      <ShortcutField
        id="optPtt"
        btn="btnPtt"
        label="말하기"
        value={sc.ptt}
        def={DEFAULT_PTT}
        platform={platform}
        clash={null}
        onChange={set('ptt')}
        hint={
          sc.ptt
            ? `지금: ${prettyKey(sc.ptt, platform)}. 누르면 듣기 시작하고 말이 멈추면 자동으로 보냅니다 (설정 > 음성). 말하는 중에 다시 누르면 바로 보내고, 답을 읽는 중에 누르면 읽기를 멈추고 듣습니다.`
            : '말하기 단축키를 쓰지 않습니다. 마이크 버튼으로 말할 수 있습니다.'
        }
      />
      <ShortcutField
        id="optTtsKey"
        btn="btnTtsKey"
        label="TTS 켜기/끄기"
        value={sc.ttsToggle}
        def=""
        platform={platform}
        clash={same ? '말하기 단축키와 같습니다. 다른 키를 고르세요.' : null}
        onChange={set('ttsToggle')}
        hint={
          sc.ttsToggle
            ? `지금: ${prettyKey(sc.ttsToggle, platform)}. 누르면 답 읽기가 꺼지고(읽던 소리도 바로 멈춤, 답 글은 그대로 나옴) 다시 누르면 켜집니다. 설정 > TTS의 "답을 소리로 읽기"도 같이 바뀝니다. 트레이 메뉴에도 있습니다.`
            : '기본은 비어 있습니다. "바꾸기"로 정하세요. 트레이 메뉴의 "TTS 끄기/켜기"로도 바꿀 수 있습니다.'
        }
      />
    </div>
  );
}
