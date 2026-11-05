// 설정 > 음성 > 음성 대화: 말이 멈추면 자동으로 끝내기, 바로 보내기, 마이크 맞추기, 이어서 대화
import type { FollowUpSettings, Settings, VadSettings } from '@shared/types';
import { FOLLOW_LIMITS, SPOKEN_STEP, VAD_LIMITS } from '@shared/voice';
import { MicCalibrate } from './MicCalibrate';
import { SecondsField } from './SecondsField';

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  /** 지난번 듣는 동안 맞춰진 주변 소음 */
  learnedNoise?: number | null;
}

export function VoiceConvSection({ settings, update, learnedNoise = null }: Props) {
  const v = settings.voice;
  const setVad = (patch: Partial<VadSettings>) => update((s) => ({ ...s, voice: { ...s.voice, vad: { ...s.voice.vad, ...patch } } }));
  const setFollow = (patch: Partial<FollowUpSettings>) => update((s) => ({ ...s, voice: { ...s.voice, followUp: { ...s.voice.followUp, ...patch } } }));

  return (
    <>
      <h3 className="sttTitle">음성 대화</h3>
      <div className="sttBox" id="vadBox">
        <label className="check">
          <input id="optAutoStop" type="checkbox" checked={v.vad.autoStop} onChange={(e) => setVad({ autoStop: e.target.checked })} /> 말이 멈추면 자동으로 끝내기
        </label>
        {v.vad.autoStop && (
          <>
            <SecondsField id="vadSilence" label="조용함 기준 시간" note="말이 끝나고 이만큼 조용하면 보냄" value={v.vad.silenceSec} min={VAD_LIMITS.silenceMin} max={VAD_LIMITS.silenceMax} onChange={(x) => setVad({ silenceSec: x })} />
            <SecondsField id="vadNoSpeech" label="처음에 말이 없으면 취소" value={v.vad.noSpeechSec} min={VAD_LIMITS.noSpeechMin} max={VAD_LIMITS.noSpeechMax} onChange={(x) => setVad({ noSpeechSec: x })} />
            <SecondsField
              id="vadMinSpoken"
              label="최소 말소리 길이"
              note="이보다 짧으면 보내지 않음"
              value={v.vad.minSpokenSec}
              min={VAD_LIMITS.spokenMin}
              max={VAD_LIMITS.spokenMax}
              step={SPOKEN_STEP}
              onChange={(x) => setVad({ minSpokenSec: x })}
            />
            <p className="hint" id="vadMinSpokenHint">
              말소리(녹색)가 합쳐서 이 시간보다 짧으면 말을 안 한 것으로 보고 보내지 않습니다 (조용한 소리를 받아 적으면 "MBC 뉴스 …" 같은 글이 지어져서). 주변 소리가 잘못 전송되면 올리고, "네" 같은 짧은 대답이 무시되면 내리세요. 기본 0.3초, 0이면 끔.
            </p>
          </>
        )}
        <label className="check">
          <input id="optAutoSend" type="checkbox" checked={v.autoSend} onChange={(e) => update((s) => ({ ...s, voice: { ...s.voice, autoSend: e.target.checked } }))} /> 알아들은 글을 바로 보내기
        </label>
        <p className="hint">
          {v.vad.autoStop ? '말하기 단축키나 마이크 버튼을 누르고 말하면, 말이 멈췄을 때 저절로 보냅니다. 말하는 중에 다시 누르면 바로 보내고, Esc는 취소입니다 (최대 60초).' : '마이크 버튼을 눌러 말하고, 다시 누르면 보냅니다 (최대 60초, Esc로 취소).'}{' '}
          바로 보내기를 끄면 알아들은 글을 입력창에서 확인하고 보냅니다.
        </p>
      </div>

      {v.vad.autoStop && <MicCalibrate vad={v.vad} learnedNoise={learnedNoise} onChange={setVad} />}

      <div className="sttBox" id="followBox">
        <label className="check">
          <input id="optFollowUp" type="checkbox" checked={v.followUp.enabled} onChange={(e) => setFollow({ enabled: e.target.checked })} /> 이어서 대화 (답이 끝나면 다시 듣기)
        </label>
        {v.followUp.enabled && (
          <>
            <SecondsField id="followWait" label="기다리는 시간" note="이 안에 말이 없으면 끝" value={v.followUp.waitSec} min={FOLLOW_LIMITS.waitMin} max={FOLLOW_LIMITS.waitMax} onChange={(x) => setFollow({ waitSec: x })} />
            <label className="check">
              <input id="optEndChime" type="checkbox" checked={v.followUp.endChime} onChange={(e) => setFollow({ endChime: e.target.checked })} /> 끝날 때 알림음 (TTS 음량을 따름)
            </label>
          </>
        )}
        {v.followUp.enabled && (!v.vad.autoStop || !v.autoSend) && <p className="warn">이어서 대화는 "말이 멈추면 자동으로 끝내기"와 "바로 보내기"가 켜져 있어야 동작합니다.</p>}
        <p className="hint">말로 물었을 때만 이어서 듣습니다. 답을 읽는 동안에는 듣지 않고, 다 읽은 뒤에 듣기 시작합니다. 기침 같은 짧은 소리는 말이 없던 것으로 봅니다.</p>
      </div>
    </>
  );
}
