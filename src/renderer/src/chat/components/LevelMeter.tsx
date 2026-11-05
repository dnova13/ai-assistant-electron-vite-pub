// 소리 크기 막대: 지금 소리 + 주변 소음선(회색) + 멈춤선(노랑) + 말소리선(초록). 설정 > 음성과 듣는 중 대화 창에서 같이 쓴다.
import { useEffect, useState } from 'react';
import type { ChatController } from '../controller';
import type { MicLevel } from '../../lib/voice';

const LO = -90;
const HI = -10;
/** dBFS → 막대 위치 % */
export const meterPos = (db: number) => `${Math.round(((Math.max(LO, Math.min(HI, db)) - LO) / (HI - LO)) * 100)}%`;

interface Props {
  /** 지금 소리 (null이면 마이크 꺼짐) */
  db: number | null;
  noise: number | null;
  speechLine: number | null;
  silenceLine: number | null;
  id?: string;
  compact?: boolean;
}

export function LevelMeter({ db, noise, speechLine, silenceLine, id, compact }: Props) {
  const loud = db !== null && speechLine !== null && db >= speechLine;
  const quiet = db !== null && silenceLine !== null && db <= silenceLine;
  return (
    <div className={compact ? 'meter compact' : 'meter'} id={id} title="지금 소리 크기 (말소리 대역)">
      <div className={`meterFill ${loud ? 'loud' : quiet ? 'quiet' : ''}`} style={{ width: db === null ? '0%' : meterPos(db) }} />
      {noise !== null && <div className="meterMark noise" style={{ left: meterPos(noise) }} title={`주변 소음 ${Math.round(noise)}dB`} />}
      {silenceLine !== null && <div className="meterMark silence" style={{ left: meterPos(silenceLine) }} title={`멈춤선 ${Math.round(silenceLine)}dB (이 아래면 조용)`} />}
      {speechLine !== null && <div className="meterMark speech" style={{ left: meterPos(speechLine) }} title={`말소리선 ${Math.round(speechLine)}dB (이 위면 말)`} />}
    </div>
  );
}

/** 대화 창 입력줄 위: 듣는 동안만 보이는 작은 막대와 숫자 */
export function ListeningMeter({ controller, on }: { controller: ChatController; on: boolean }) {
  const [l, setL] = useState<MicLevel | null>(null);
  useEffect(() => controller.onMicLevel(setL), [controller]);
  if (!on || !l) return null;
  const state = l.speechLine !== null && l.db >= l.speechLine ? '말소리' : l.silenceLine !== null && l.db <= l.silenceLine ? '조용함' : '애매함';
  return (
    <div id="listenMeter">
      <LevelMeter db={l.db} noise={l.noise} speechLine={l.speechLine} silenceLine={l.silenceLine} compact />
      <span className="listenNums">
        지금 {Math.round(l.db)} · 소음 {l.noise === null ? '재는 중' : Math.round(l.noise)} · 말소리선 {l.speechLine === null ? '-' : Math.round(l.speechLine)} dB · {state}
      </span>
    </div>
  );
}
