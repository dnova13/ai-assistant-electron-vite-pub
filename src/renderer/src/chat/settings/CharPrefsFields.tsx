// 설정 > 캐릭터 > 프로필·＋ 추가의 AI 탭과 목소리 탭 (캐릭터마다 고른다).
// AI: 등록한 AI 프로필 중 하나 (안 고르면 대화 안 됨). 목소리: 컴퓨터 음성 / 등록한 TTS 서버, 목소리, 배속, 음량, 안 되면 컴퓨터 음성.
import { useEffect, useRef, useState } from 'react';
import type { CharacterVoice, Profile, TtsServer } from '@shared/types';
import { BuiltinSpeaker } from '../../lib/voice';

const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const SAMPLE = '안녕하세요. 이 목소리로 답을 읽어 드릴게요.';

/* ---------------- AI ---------------- */

interface AiProps {
  profiles: Record<string, Profile>;
  /** 고른 프로필 id ('' = 선택 안 함) */
  value: string;
  onChange: (id: string) => void;
  /** 설정 > AI로 가기 */
  onGoAi: () => void;
}

export function CharAiPicker({ profiles, value, onChange, onGoAi }: AiProps) {
  const ids = Object.keys(profiles);
  if (!ids.length)
    return (
      <div className="charPrefBox" id="charAiNone">
        <p className="warn">AI 프로필이 없습니다. 설정 &gt; AI에서 먼저 추가하세요.</p>
        <button id="btnGoAi" type="button" className="primary" onClick={onGoAi}>
          설정 &gt; AI로 가기
        </button>
      </div>
    );
  return (
    <div className="charPrefBox">
      <label>
        이 캐릭터가 쓸 AI
        <select id="charAi" value={profiles[value] ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">선택하세요</option>
          {ids.map((id) => (
            <option key={id} value={id}>
              {profiles[id].name || id}
            </option>
          ))}
        </select>
      </label>
      {!profiles[value] && <p className="warn">AI를 고르지 않으면 이 캐릭터와 대화할 수 없습니다 (파일 명령은 됩니다).</p>}
      <p className="hint">
        AI 프로필은 설정 &gt; AI에서 추가·수정합니다.{' '}
        <button type="button" className="linkBtn" onClick={onGoAi}>
          설정 &gt; AI로 가기
        </button>
      </p>
    </div>
  );
}

/* ---------------- 목소리 ---------------- */

interface VoiceProps {
  value: CharacterVoice;
  onChange: (v: CharacterVoice) => void;
  servers: Record<string, TtsServer>;
  /** 캐릭터 config.json의 목소리 이름 (서버 목소리를 비웠을 때 쓰임) */
  configVoice: string;
  /** 캐릭터 이름 (호출어를 비우면 이 이름) */
  charName: string;
  /** 호출어가 같은 다른 캐릭터 이름들 */
  wakeConflicts: string[];
}

export function CharVoiceEditor({ value: v, onChange, servers, configVoice, charName, wakeConflicts }: VoiceProps) {
  const set = (patch: Partial<CharacterVoice>) => onChange({ ...v, ...patch });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [serverVoices, setServerVoices] = useState<string[]>([]);
  const [res, setRes] = useState<{ cls: '' | 'ok' | 'fail'; text: string }>({ cls: '', text: '' });
  const speaker = useRef<BuiltinSpeaker | null>(null);
  const audio = useRef<{ el: HTMLAudioElement; url: string } | null>(null);
  const srv = v.engine === 'server' ? servers[v.server] : undefined;

  const stopAudio = () => {
    if (audio.current) {
      audio.current.el.pause();
      URL.revokeObjectURL(audio.current.url);
      audio.current = null;
    }
  };

  // 이 컴퓨터의 목소리 목록 (늦게 채워질 수 있다)
  useEffect(() => {
    const sp = new BuiltinSpeaker();
    speaker.current = sp;
    const load = () => setVoices(sp.voices());
    load();
    const off = sp.onVoicesChanged(load);
    return () => {
      off();
      sp.cancel();
      stopAudio();
    };
  }, []);
  useEffect(() => setServerVoices([]), [v.server]);

  const korean = voices.filter((x) => /^ko/i.test(x.lang));
  const others = voices.filter((x) => !/^ko/i.test(x.lang));
  const option = (x: SpeechSynthesisVoice) => (
    <option key={x.name} value={x.name}>
      {x.name} ({x.lang})
    </option>
  );

  const loadServerVoices = async () => {
    if (!srv || !srv.baseUrl) return;
    setRes({ cls: '', text: '목소리 목록을 불러오는 중…' });
    try {
      const r = await window.app.tts.testServer({ baseUrl: srv.baseUrl, apiKey: srv.apiKey, voice: '', model: srv.model });
      setServerVoices(r.voices);
      setRes({ cls: r.voices.length ? 'ok' : '', text: r.voices.length ? `목소리 ${r.voices.length}개` : '이 서버는 목소리 목록을 주지 않습니다. 이름을 직접 적으세요.' });
    } catch (e) {
      setRes({ cls: 'fail', text: errText(e) });
    }
  };

  const preview = async () => {
    setRes({ cls: '', text: '읽는 중…' });
    stopAudio();
    speaker.current?.cancel();
    try {
      if (!srv) {
        const sp = speaker.current || new BuiltinSpeaker();
        sp.voice = v.builtinVoice;
        sp.rate = v.rate;
        sp.volume = v.volume / 100;
        await sp.speak(SAMPLE);
      } else {
        const r = await window.app.tts.preview({ baseUrl: srv.baseUrl, apiKey: srv.apiKey, voice: v.voice, model: srv.model }, SAMPLE, configVoice || 'default');
        const url = URL.createObjectURL(new Blob([r.audio as Uint8Array<ArrayBuffer>], { type: r.mime }));
        const el = new Audio(url);
        el.volume = v.volume / 100;
        el.playbackRate = v.rate;
        audio.current = { el, url };
        await new Promise<void>((resolve, reject) => {
          el.onended = () => resolve();
          el.onerror = () => reject(new Error('받은 소리를 재생하지 못했습니다.'));
          el.play().catch(reject);
        });
        stopAudio();
      }
      setRes({ cls: '', text: '' });
    } catch (e) {
      stopAudio();
      setRes({ cls: 'fail', text: errText(e) });
    }
  };

  const serverIds = Object.keys(servers);
  return (
    <div className="charPrefBox" id="charVoiceBox">
      <label>
        읽는 방식
        <select
          id="charVoiceEngine"
          value={srv ? `server:${v.server}` : 'builtin'}
          onChange={(e) => {
            const val = e.target.value;
            if (val === 'builtin') set({ engine: 'builtin' });
            else set({ engine: 'server', server: val.slice(7), voice: v.server === val.slice(7) ? v.voice : '' });
          }}
        >
          <option value="builtin">컴퓨터 음성</option>
          {serverIds.map((id) => (
            <option key={id} value={`server:${id}`}>
              TTS: {servers[id].name || id}
            </option>
          ))}
        </select>
      </label>
      {!serverIds.length && <p className="hint">TTS 서버는 설정 &gt; TTS에서 추가하면 여기에서 고를 수 있습니다.</p>}

      {srv && (
        <>
          <label>
            목소리 (비우면 {configVoice && configVoice !== 'default' ? `캐릭터 기본 "${configVoice}" → ` : ''}서버 기본)
            <div className="row">
              <input id="charVoiceName" type="text" list="charServerVoices" value={v.voice} onChange={(e) => set({ voice: e.target.value.trim() })} />
              {srv.baseUrl && (
                <button id="btnCharVoices" type="button" onClick={() => void loadServerVoices()}>
                  목록 불러오기
                </button>
              )}
            </div>
            <datalist id="charServerVoices">
              {serverVoices.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="check">
            <input id="charVoiceFallback" type="checkbox" checked={v.fallbackBuiltin} onChange={(e) => set({ fallbackBuiltin: e.target.checked })} /> TTS 서버가 안 되면 컴퓨터 음성으로 읽기
          </label>
        </>
      )}

      {(!srv || v.fallbackBuiltin) && (
        <label>
          컴퓨터 음성{srv ? ' (서버가 안 될 때)' : ''}
          <select id="charBuiltinVoice" value={v.builtinVoice} onChange={(e) => set({ builtinVoice: e.target.value })}>
            <option value="">자동 (한국어 목소리)</option>
            {v.builtinVoice && !voices.some((x) => x.name === v.builtinVoice) && <option value={v.builtinVoice}>{v.builtinVoice} (이 컴퓨터에 없음)</option>}
            {korean.length > 0 && <optgroup label="한국어">{korean.map(option)}</optgroup>}
            {others.length > 0 && <optgroup label="다른 언어">{others.map(option)}</optgroup>}
          </select>
        </label>
      )}

      <label>
        배속: {v.rate.toFixed(1)}배
        <input id="charVoiceRate" type="range" min={0.5} max={2} step={0.1} value={v.rate} onChange={(e) => set({ rate: Number(e.target.value) })} />
      </label>
      <label>
        음량: {v.volume}%
        <input id="charVoiceVolume" type="range" min={0} max={100} step={5} value={v.volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
      </label>
      <p className="hint">음량은 이 캐릭터와 대화할 때의 알림음에도 쓰입니다. 100%가 원래 크기입니다.</p>
      <label>
        호출어
        <input
          id="charWakeName"
          type="text"
          maxLength={20}
          placeholder={charName ? `비우면 캐릭터 이름 "${charName}"` : '예: 루나'}
          value={v.wakeName}
          onChange={(e) => set({ wakeName: e.target.value })}
        />
      </label>
      {wakeConflicts.length > 0 && (
        <p className="warn" id="charWakeConflict">
          다른 캐릭터({wakeConflicts.join(', ')})와 호출어가 같습니다. 부르면 캐릭터 순서에서 앞에 있는 캐릭터로 바뀝니다.
        </p>
      )}
      <p className="hint">
        설정 &gt; 음성 &gt; 호출어의 "항상 듣기"를 켜면 이 이름으로 부를 수 있습니다. 다른 캐릭터를 쓰는 중에 부르면 이 캐릭터로 바뀌고, "네, 말씀하세요."를 이 캐릭터 목소리로 읽습니다. 2~4글자의 덜 흔한 이름이 잘 알아듣습니다.
      </p>
      <div className="row">
        <button id="btnCharVoicePreview" type="button" onClick={() => void preview()}>
          미리 듣기
        </button>
        <span id="charVoiceResult" className={res.cls}>
          {res.text}
        </span>
      </div>
    </div>
  );
}
