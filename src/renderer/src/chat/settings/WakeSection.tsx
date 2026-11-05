// 설정 > 음성 > 호출어: 항상 듣기 켜기/끄기, 호출어 모델, 주변 소음(음성 대화와 같은 설정).
// 호출어 이름은 캐릭터마다 설정 > 캐릭터 > 프로필 > 목소리에서 정하고, "네, 말씀하세요."는 그 캐릭터의 목소리로 읽는다.
// 호출어 판단은 앱 안 위스퍼로만 한다 (호출어 전의 소리는 밖으로 안 나가고 저장하지 않음).
import type { LocalSttModel, Settings, WakeSettings } from '@shared/types';
import { WAKE_ACK_TEXT, wakeBlocked, wakeModel, wakeModelNote, wakeName } from '@shared/wake';
import { LOCAL_MODELS, LOCAL_MODEL_INFO } from '@shared/stt';
import { MicCalibrate } from './MicCalibrate';

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  /** 고른 캐릭터의 호출어 (캐릭터 > 목소리의 호출어, 비었으면 캐릭터 이름) */
  characterName: string;
  /** 받아 둔 앱 안 위스퍼 모델 */
  downloaded: LocalSttModel[];
  /** 지난번 듣는 동안 맞춰진 주변 소음 */
  learnedNoise?: number | null;
}

export function WakeSection({ settings, update, characterName, downloaded, learnedNoise = null }: Props) {
  const w = settings.voice.wake;
  const setW = (patch: Partial<WakeSettings>) => update((s) => ({ ...s, voice: { ...s.voice, wake: { ...s.voice.wake, ...patch } } }));
  const blocked = wakeBlocked(w, characterName, downloaded);
  const model = wakeModel(downloaded, w.model);
  const modelNote = wakeModelNote(w, downloaded);
  // 소음·말소리 기준은 호출어 것을 따로 쓴다 (음성 대화 탭의 값과 서로 영향 없음)
  const levels = { noiseDb: w.noiseDb, marginDb: w.marginDb };
  const name = wakeName(w, characterName);
  const len = [...name.replace(/\s/g, '')].length;

  return (
    <>
      <h3 className="sttTitle">호출어</h3>
      <div className="sttBox" id="wakeBox">
        <label className="check">
          <input id="optWake" type="checkbox" checked={w.enabled} onChange={(e) => setW({ enabled: e.target.checked })} /> 항상 듣기 (호출어를 부르면 듣기 시작)
        </label>
        <p className="hint" id="wakeNameHint">
          {name ? `지금 캐릭터는 "${name}"(이)라고 부르면 듣기 시작합니다. "${name}야, …"처럼 뒤에 말을 붙여도 됩니다. ` : ''}
          호출어는 캐릭터마다 설정 &gt; 캐릭터 &gt; 프로필 &gt; 목소리에서 정합니다 (비우면 캐릭터 이름). 다른 캐릭터의 호출어로 부르면 그 캐릭터로 바뀌고, "{WAKE_ACK_TEXT}"는 그 캐릭터의 목소리로 읽습니다.
          {len > 0 && (len < 2 || len > 5) ? ' 2~4글자의 덜 흔한 이름이 잘 알아듣고 잘못 반응하지 않습니다.' : ' 2~4글자의 덜 흔한 이름을 권합니다 ("야", "저기" 같은 흔한 말은 잘못 반응하기 쉬움).'}
        </p>
        {blocked && (
          <p className="warn" id="wakeBlocked">
            {blocked}
          </p>
        )}
        <label>
          호출어 모델
          <select id="wakeModel" value={w.model} onChange={(e) => setW({ model: e.target.value as LocalSttModel })}>
            {LOCAL_MODELS.map((m) => (
              <option key={m} value={m} disabled={!downloaded.includes(m) && m !== w.model}>
                {LOCAL_MODEL_INFO[m].label}
                {downloaded.includes(m) ? '' : ' (받지 않음)'}
              </option>
            ))}
          </select>
        </label>
        {modelNote && !blocked && (
          <p className="warn" id="wakeModelNote">
            {modelNote}
          </p>
        )}
        <p className="hint">작은 모델은 빠르지만 짧은 이름을 자주 틀립니다. small을 권합니다. medium은 정확하지만 소리가 날 때마다 CPU를 많이 씁니다. 모델은 음성 인식 탭의 "이 컴퓨터"에서 받습니다.</p>
        <p className="hint">
          켜 두면 기다리는 동안에도 마이크가 켜져 있습니다 (맥은 메뉴 막대에 주황색 점). 말소리가 날 때만 이 컴퓨터의 위스퍼{model ? `(${model})` : ''}로 앞부분을 받아 적어 호출어인지 보고, 그 소리는 저장하거나 밖으로 보내지
          않습니다. 듣는 중·답을 읽는 중에는 쉬고, 끝나면 다시 기다립니다. 트레이 메뉴와 바탕화면 캐릭터에서도 켜고 끌 수 있습니다.
        </p>
        <b>주변 소음</b>
        <p className="hint" id="wakeNoiseInfo">
          호출어 대기용 설정입니다 (음성 대화 탭의 값과는 따로 저장됩니다). 지금: 주변 소음 {w.noiseDb === null ? '아직 안 잼' : `${w.noiseDb} dB`} · 말소리는 주변 소음보다 {w.marginDb} dB 커야 함
          {learnedNoise !== null ? ` · 최근 듣는 동안 맞춰진 소음 ${learnedNoise} dB` : ''}. 호출어를 자주 놓치거나 소음에 반응하면 아래 마이크 맞추기를 다시 하세요.
        </p>
      </div>

      <MicCalibrate vad={levels} learnedNoise={learnedNoise} onChange={setW} />
    </>
  );
}
