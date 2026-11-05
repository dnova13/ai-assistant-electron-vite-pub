// 확인 창 (파일 작업, 서버 작업). 열려 있는 동안 남은 시간을 세고, 0이 되면 'expired'로 닫는다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONFIRM_AGAIN, decideConfirmation, type ConfirmationInterpreter } from '@shared/confirmation';
import type { Dialog, DialogValue } from '../controller';
import { bindDialogKeyboard } from '../../lib/dialog-keyboard';

export function ConfirmDialog({ dialog, onResolve, interpret }: { dialog: Dialog | null; onResolve: (v: DialogValue) => void; interpret?: ConfirmationInterpreter }) {
  const [left, setLeft] = useState(0);
  const [answer, setAnswer] = useState('');
  const [hint, setHint] = useState('');
  const [checking, setChecking] = useState(false);
  const current = useRef(dialog); current.current = dialog;
  const request = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setAnswer(''); setHint(''); setChecking(false);
    return () => { request.current?.abort(); };
  }, [dialog]);
  const finish = (value: DialogValue) => { request.current?.abort(); onResolve(value); };
  const submitAnswer = async () => {
    if (!dialog || checking || (request.current && !request.current.signal.aborted) || !answer.trim()) return;
    const original = dialog;
    const abort = new AbortController(); request.current = abort;
    setChecking(true);
    const question = [dialog.title, ...dialog.lines.filter(l => l.kind === 'note' && l.cls === 'msgline').map(l => l.kind === 'note' ? l.text : '')].join('\n');
    const decision = await decideConfirmation(question, answer, interpret, abort.signal);
    if (abort.signal.aborted || current.current !== original) return;
    setChecking(false); request.current = null;
    if (decision === 'unknown') { setHint(CONFIRM_AGAIN); return; }
    const button = dialog.buttons.find(b => b.label === (decision === 'yes' ? '예' : '아니오'));
    if (button) finish(button.value);
  };
  const panel = useRef<HTMLDivElement>(null);

  // 시간 세기
  useEffect(() => {
    if (!dialog || !dialog.seconds) return;
    let n = dialog.seconds;
    setLeft(n);
    const t = setInterval(() => {
      n -= 1;
      setLeft(n);
      if (n <= 0) {
        clearInterval(t);
        finish('expired');
      }
    }, 1000);
    return () => clearInterval(t);
  }, [dialog, onResolve]);

  // 후보와 확인 버튼은 같은 키보드 조작을 쓴다.
  useLayoutEffect(() => {
    if (!dialog || !panel.current) return;
    return bindDialogKeyboard(panel.current, () => finish(null));
  }, [dialog, onResolve]);

  return (
    <div id="actionModal" className={dialog ? 'modal' : 'modal hidden'}>
      <div className="modalBody small" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="actTitle">
        <h2 id="actTitle">{dialog?.title}</h2>
        <div id="actBody">
          {dialog?.lines.map((l, i) =>
            l.kind === 'kv' ? (
              <div className="kv" key={i}>
                <span className="k">{l.label}</span>
                <span className={l.mono ? 'v mono' : 'v'}>{l.value}</span>
              </div>
            ) : (
              <p className={l.cls} key={i}>
                {l.text}
              </p>
            )
          )}
          {dialog?.choices && (
            <div className="choices">
              {dialog.choices.map((o) => (
                <button key={o.path} className="choice" title={o.title ?? o.path} onClick={() => finish(o.path)}>
                  {o.display}
                </button>
              ))}
            </div>
          )}
        </div>
        <p id="actTimer" className="hint">
          {dialog?.seconds ? `${left}초 안에 승인하지 않으면 취소됩니다.` : ''}
        </p>
        {dialog && !dialog.choices && dialog.buttons.some(b => b.label === '예') && <form onSubmit={e => { e.preventDefault(); void submitAnswer(); }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" style={{ flex: 1, minWidth: 0 }} aria-label="확인 답변" placeholder="예 / 아니오 또는 다른 표현으로 답하기" maxLength={500} value={answer} disabled={checking} onChange={e => setAnswer(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (!e.repeat) void submitAnswer(); } }} />
            <button type="submit" disabled={checking || !answer.trim()}>{checking ? '확인 중…' : '답하기'}</button>
          </div>
          {hint && <p role="status" className="hint">{hint}</p>}
        </form>}
        <div id="actButtons" className="modalFoot">
          {dialog?.buttons.map((b) => (
            <button key={b.label} data-dialog-initial={b.value === dialog.initialValue ? 'true' : undefined} data-dialog-cancel={b.value === null || b.value === false ? 'true' : undefined} className={b.kind || ''} onClick={() => finish(b.value)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
