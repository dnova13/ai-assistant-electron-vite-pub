// 시간(초) 설정: 슬라이더(기본 0.5초 단위, step으로 바꿈) + 숫자 입력. 숫자 칸은 칸에서 나가거나 Enter를 누르면 범위 안의 단위로 맞춘다.
import { useEffect, useState } from 'react';
import { SEC_STEP, stepSec } from '@shared/voice';

interface Props {
  id: string;
  label: string;
  /** 숫자 뒤에 붙는 설명 (예: "말이 끝나고 이만큼 조용하면 보냄") */
  note?: string;
  value: number;
  min: number;
  max: number;
  /** 단위 (기본 0.5초) */
  step?: number;
  onChange: (v: number) => void;
}

const show = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function SecondsField({ id, label, note, value, min, max, step = SEC_STEP, onChange }: Props) {
  const fit = (v: unknown) => stepSec(v, value, min, max, step);
  const [text, setText] = useState(show(value));
  const [editing, setEditing] = useState(false);

  // 슬라이더나 다른 곳에서 값이 바뀌면 칸도 맞춘다 (입력 중에는 그대로)
  useEffect(() => {
    if (!editing) setText(show(value));
  }, [value, editing]);

  const commit = () => {
    const v = fit(text.replace(',', '.'));
    setEditing(false);
    setText(show(v));
    if (v !== value) onChange(v);
  };

  return (
    <div className="secField">
      <label htmlFor={id}>
        {label}
        {note ? ` (${note})` : ''}
      </label>
      <div className="row">
        <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(fit(e.target.value))} />
        <input
          id={`${id}Num`}
          className="secNum"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={text}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setEditing(true);
            setText(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <span className="secUnit">초</span>
      </div>
    </div>
  );
}
