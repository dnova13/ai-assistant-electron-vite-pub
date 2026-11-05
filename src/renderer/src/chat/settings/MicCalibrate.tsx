// 설정 > 음성 > 마이크 맞추기: 주변 소음을 재고(조용히 2초), "말소리는 주변 소음보다 몇 dB 커야 하나"(N)를 정한다.
// 마이크 맞추기 = 조용히 2초 + 말하기 3초로 주변 소음과 N을 한 번에 정한다. 소리 크기 막대로 확인할 수 있다.
// 마이크는 이 화면에서만 잠깐 켜고, 끝나거나 설정 창을 닫으면 바로 끈다.
import { useEffect, useRef, useState } from 'react';
import { MicMeter, SILENCE_DB, calibrate, noiseOf, openMic } from '../../lib/vad';
import { VAD_LIMITS } from '@shared/voice';
import type { VadSettings } from '@shared/types';
import { LevelMeter } from '../components/LevelMeter';

/** 소음·말소리 기준 한 쌍: 음성 대화는 voice.vad, 호출어는 voice.wake의 것을 넘긴다 (서로 따로) */
export type MicLevels = Pick<VadSettings, 'noiseDb' | 'marginDb'>;

interface Props {
  vad: MicLevels;
  /** 지난번 듣는 동안 고쳐 둔 주변 소음 (있으면 보여 준다) */
  learnedNoise: number | null;
  onChange: (patch: Partial<MicLevels>) => void;
}

type Phase = 'off' | 'meter' | 'quiet' | 'speak';
const QUIET_MS = 2000;
const SPEAK_MS = 3000;

export function MicCalibrate({ vad, learnedNoise, onChange }: Props) {
  const [phase, setPhase] = useState<Phase>('off');
  const [level, setLevel] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ cls: '' | 'ok' | 'fail'; text: string }>({ cls: '', text: '' });
  /** 지금 단계가 끝날 때까지 남은 초 (조용히 2초 / 말하기 3초 안내에 보여 준다) */
  const [left, setLeft] = useState(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const meter = useRef<MicMeter | null>(null);
  const collect = useRef<{ phase: Phase; quiet: number[]; speech: number[] }>({ phase: 'off', quiet: [], speech: [] });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const noise = vad.noiseDb;
  const speechLine = noise === null ? null : noise + vad.marginDb;
  const silenceLine = noise === null ? null : noise + SILENCE_DB;

  const stopCount = () => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    setLeft(0);
  };

  /** ms 동안 남은 초를 센다 */
  const countDown = (ms: number) => {
    stopCount();
    const end = Date.now() + ms;
    setLeft(Math.ceil(ms / 1000));
    tick.current = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 200);
  };

  const stopMic = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    stopCount();
    if (meter.current) meter.current.stop();
    meter.current = null;
    if (stream.current) stream.current.getTracks().forEach((t) => t.stop());
    stream.current = null;
    collect.current.phase = 'off';
    setPhase('off');
    setLevel(null);
  };

  // 설정 창을 닫거나 탭을 바꾸면 마이크를 끈다
  useEffect(() => stopMic, []);

  const startMic = async (): Promise<boolean> => {
    if (meter.current) return true;
    try {
      stream.current = await openMic();
      meter.current = new MicMeter(stream.current, (db) => {
        setLevel(db);
        const c = collect.current;
        if (c.phase === 'quiet') c.quiet.push(db);
        else if (c.phase === 'speak') c.speech.push(db);
      });
      return true;
    } catch (e) {
      setMsg({ cls: 'fail', text: e instanceof Error ? e.message : String(e) });
      stopMic();
      return false;
    }
  };

  const toggleMeter = async () => {
    if (phase !== 'off') return stopMic();
    setMsg({ cls: '', text: '' });
    if (await startMic()) setPhase('meter');
  };

  /** withSpeech: 마이크 맞추기(소음 + 말소리), 아니면 주변 소음만 */
  const run = async (withSpeech: boolean) => {
    setMsg({ cls: '', text: '' });
    if (!(await startMic())) return;
    collect.current = { phase: 'quiet', quiet: [], speech: [] };
    setPhase('quiet');
    countDown(QUIET_MS);
    const finishQuiet = () => {
      if (!withSpeech) {
        const n = noiseOf(collect.current.quiet);
        stopMic();
        onChange({ noiseDb: n });
        setMsg({ cls: 'ok', text: `주변 소음 ${n}dB로 정했어요 → 말소리선 ${n + vad.marginDb}dB, 멈춤선 ${n + SILENCE_DB}dB (저장하면 적용)` });
        return;
      }
      collect.current.phase = 'speak';
      setPhase('speak');
      countDown(SPEAK_MS);
      timers.current.push(
        setTimeout(() => {
          const { quiet, speech } = collect.current;
          stopMic();
          const r = calibrate(quiet, speech);
          if ('error' in r) {
            const hint = r.voice - r.noise < 3 ? ' 조용히 하는 2초 동안 말하거나 소리가 났을 수 있어요. 다시 누르고 빨간 글씨를 따라 해 주세요.' : '';
            setMsg({ cls: 'fail', text: `${r.error} (소음 ${r.noise}dB, 말소리 ${r.voice}dB)${hint}` });
            return;
          }
          onChange({ noiseDb: r.noise, marginDb: r.margin });
          setMsg({ cls: 'ok', text: `맞췄어요: 소음 ${r.noise}dB, 말소리 ${r.voice}dB → 말소리는 소음보다 ${r.margin}dB 크게 (말소리선 ${r.noise + r.margin}dB). 저장하면 적용` });
        }, SPEAK_MS)
      );
    };
    timers.current.push(setTimeout(finishQuiet, QUIET_MS));
  };

  const busy = phase === 'quiet' || phase === 'speak';
  const guide = phase === 'quiet' ? `조용히 해 주세요 — ${left}초 (주변 소음을 재는 중)` : phase === 'speak' ? `지금 말해 주세요 — ${left}초 (평소 크기로 "오늘 날씨 어때?")` : '';

  return (
    <div className="sttBox" id="micBox">
      <b>마이크 맞추기 (주변 소음과 말소리)</b>
      <ol className="calHowto" id="micHowto">
        <li>"마이크 맞추기"를 누릅니다.</li>
        <li>
          <b className="calAlertText">조용히 해 주세요</b> (2초) — 주변 소음을 잽니다. 말하지 말고 기다리세요.
        </li>
        <li>
          <b className="calSpeakText">말해 주세요</b> (3초) — 평소 크기로 "오늘 날씨 어때?"처럼 말합니다.
        </li>
        <li>결과가 나오면 아래 "저장"을 눌러야 적용됩니다.</li>
      </ol>
      <LevelMeter id="micMeter" db={phase === 'off' ? null : level} noise={noise} speechLine={speechLine} silenceLine={silenceLine} />
      <div className="meterLegend">
        <span className="lg noise">주변 소음</span>
        <span className="lg silence">멈춤선 (소음 + {SILENCE_DB})</span>
        <span className="lg speech">말소리선 (소음 + {vad.marginDb})</span>
        {phase !== 'off' && level !== null && <span className="meterDb">지금 {Math.round(level)} dB</span>}
      </div>
      <p id="noiseValue" className="hint">
        주변 소음: {noise === null ? '아직 안 잼 (듣기 시작할 때 잠깐 재요)' : `${noise} dB`}
        {learnedNoise !== null && learnedNoise !== noise ? ` · 지난번 듣는 동안 맞춰진 값 ${Math.round(learnedNoise)} dB` : ''}
      </p>
      <div className="row wrap">
        <button id="btnNoiseMeasure" type="button" disabled={busy} onClick={() => void run(false)}>
          주변 소음 재기
        </button>
        <button id="btnMicCalibrate" type="button" disabled={busy} onClick={() => void run(true)}>
          마이크 맞추기
        </button>
        <button id="btnMicMeter" type="button" disabled={busy} onClick={() => void toggleMeter()}>
          {phase === 'meter' ? '소리 크기 보기 끄기' : '소리 크기 보기'}
        </button>
        {noise !== null && (
          <button id="btnNoiseClear" type="button" disabled={busy} onClick={() => onChange({ noiseDb: null })} title="잰 값을 지우고, 듣기 시작할 때 잠깐 재도록">
            지우기
          </button>
        )}
      </div>
      {(guide || msg.text) && (
        <span id="micCalResult" className={guide ? (phase === 'speak' ? 'calSpeak' : 'calAlert') : msg.cls}>
          {guide || msg.text}
        </span>
      )}
      <ul className="calButtons hint">
        <li>
          <b>주변 소음 재기</b>: 조용히 2초만 재서 주변 소음만 정합니다.
        </li>
        <li>
          <b>마이크 맞추기</b>: 조용히 2초 + 말하기 3초로 주변 소음과 아래 기준(N dB)을 함께 정합니다.
        </li>
        <li>
          <b>소리 크기 보기</b>: 지금 마이크에 들어오는 크기를 막대로 봅니다. 잰 값은 바꾸지 않습니다.
        </li>
        <li>
          <b>지우기</b>: 잰 값을 지웁니다. 듣기 시작할 때 저절로 잽니다 (맞추지 않아도 듣는 동안 자동으로 맞춰 나갑니다).
        </li>
      </ul>
      <label htmlFor="vadMargin">말소리는 주변 소음보다 {vad.marginDb} dB 커야 함</label>
      <input id="vadMargin" type="range" min={VAD_LIMITS.marginMin} max={VAD_LIMITS.marginMax} step={1} value={vad.marginDb} onChange={(e) => onChange({ marginDb: parseInt(e.target.value, 10) })} />
      <p className="hint">
        말이 멈추면 소리가 주변 소음 근처(소음 + {SILENCE_DB}dB 이내)로 내려오고, 그 상태가 "조용함 기준 시간"만큼 이어지면 보냅니다. 주변 소음은 여기서 잰 값으로 시작해서 듣는 동안 자동으로 맞춰
        나갑니다. 숫자(dB)를 작게 하면 작은 목소리도 잡지만 소음에 반응하기 쉽고, 크게 하면 소음에 강하지만 작게 말하면 안 잡힙니다. 숫자는 마이크로 들어온 말소리 대역(300~3400Hz)의 상대 크기(0이 가장
        큼)라서 소음계의 데시벨과 다릅니다.
      </p>
    </div>
  );
}
