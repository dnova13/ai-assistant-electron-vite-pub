import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Msg } from '../controller';
import { formatClock, formatDay, formatDayLabel } from '@shared/chat-time';
import { Avatar, type AvatarCharacter } from './Avatar';

const SLOW_AFTER = 5; // 초: 이때부터 경과 시간을 보여 준다
const VERY_SLOW_AFTER = 20; // 초: 이때부터 안내 문구를 보여 준다

/** 답을 기다리는 말풍선: 점 세 개가 물결치고, 오래 걸리면 경과 시간과 안내를 덧붙인다 */
export function Waiting() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const timer = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="waiting" role="status" aria-label="답을 기다리는 중">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {sec >= SLOW_AFTER && <span className="waitSec">기다리는 중 · {sec}초</span>}
      {sec >= VERY_SLOW_AFTER && <span className="waitHint">모델을 불러오는 중일 수 있어요. 처음 한 번은 오래 걸려요. ■로 멈출 수 있어요.</span>}
    </span>
  );
}

interface Props {
  character: AvatarCharacter | null;
  messages: Msg[];
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  /** 메신저로 받은 파일의 다운로드 */
  onDownload?: (msgId: number) => void;
}

const PILL_HIDE_MS = 1500; // 스크롤을 멈추고 이 시간이 지나면 날짜 알약을 숨긴다
const PILL_ZONE = 40; // 날짜 구분선이 맨 위에서 이만큼 안에 있으면 같은 날짜가 겹쳐 보이므로 알약을 숨긴다

export function Messages({ character, messages, onOpen, onReveal, onDownload }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const auto = useRef(false); // 새 글 때문에 우리가 스크롤을 옮긴 경우 (날짜 알약을 띄우지 않는다)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pill, setPill] = useState('');

  // 새 글이 오면 맨 아래로
  useLayoutEffect(() => {
    if (box.current) {
      auto.current = true;
      box.current.scrollTop = box.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  // 직접 스크롤하면 맨 위에 보이는 대화의 날짜를 알약으로 잠깐 보여 준다
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    if (auto.current) {
      auto.current = false;
      return;
    }
    const top = el.scrollTop;
    const nearSep = Array.from(el.querySelectorAll<HTMLElement>('.daySep')).some((d) => d.offsetTop - top > -12 && d.offsetTop - top < PILL_ZONE);
    const first = Array.from(el.querySelectorAll<HTMLElement>('[data-day]')).find((r) => r.offsetTop + r.offsetHeight > top + 4);
    setPill(nearSep || !first ? '' : first.dataset.day || '');
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPill(''), PILL_HIDE_MS);
  };

  let lastDay = '';
  let lastLabel = '';
  return (
    <div id="msgWrap">
      {pill && <div className="datePill" aria-hidden="true">{pill}</div>}
      <div id="messages" ref={box} aria-live="polite" onScroll={onScroll}>
        {messages.map((m, i) => {
          const day = m.time !== undefined ? formatDay(m.time) : '';
          // 날짜가 바뀌는 곳(처음 포함)에 구분선
          const sep = day && day !== lastDay ? <div key={`d${m.id}`} className="daySep"><span>{formatDayLabel(m.time as number)}</span></div> : null;
          if (day) {
            lastDay = day;
            lastLabel = formatDayLabel(m.time as number);
          }
          const dayAttr = lastLabel || undefined; // 스크롤 알약에 보여 줄 날짜
          const body = (
            <div className={`msg ${m.role}${m.tone ? ` ${m.tone}` : ''}`}>
              {m.source && <span className="msgSource">{m.source}</span>}
              {m.pending ? <Waiting /> : m.text}
              {m.received && (
                <div className="received" data-state={m.received.state}>
                  {m.received.state === 'ready' && (
                    <button className="btnDownload" onClick={() => onDownload && onDownload(m.id)}>
                      다운로드
                    </button>
                  )}
                  {m.received.state === 'downloading' && <span className="hint">내려받는 중…</span>}
                  {m.received.state === 'failed' && (
                    <>
                      <button className="btnDownload" onClick={() => onDownload && onDownload(m.id)}>
                        다시 받기
                      </button>
                    </>
                  )}
                  {m.received.state === 'done' && m.received.path && (
                    <>
                      {!m.received.executable && (
                        <button className="btnRecvOpen" onClick={() => onOpen(m.received!.path!)}>
                          열기
                        </button>
                      )}
                      <button className="btnRecvReveal" onClick={() => onReveal(m.received!.path!)}>
                        폴더 열기
                      </button>
                    </>
                  )}
                  {m.received.message && <p className={m.received.state === 'failed' || m.received.executable ? 'warn recvMsg' : 'hint recvMsg'}>{m.received.message}</p>}
                </div>
              )}
              {m.results && m.results.length > 0 && (
                <div className="results">
                  {m.results.map((it) => (
                    <div className="result" key={it.path}>
                      <span title={it.path}>{it.display}</span>
                      <button onClick={() => onOpen(it.path)}>열기</button>
                      <button onClick={() => onReveal(it.path)}>위치</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
          const time = m.time !== undefined && !m.pending ? <div className={`msgTime t-${m.role}`}>{formatClock(m.time)}</div> : null;
          let row;
          if (m.role === 'user') {
            row = (
              <div key={m.id} className="row r-user" data-day={dayAttr}>
                <div className="userCol">{body}{time}</div>
              </div>
            );
          } else if (m.role === 'bot') {
            // 캐릭터가 연달아 말하면 첫 말풍선에만 그림과 이름을 보여 준다
            const first = messages[i - 1]?.role !== 'bot';
            row = (
              <div key={m.id} className={`row r-bot${first ? '' : ' cont'}`} data-day={dayAttr}>
                {first ? <Avatar character={character} /> : <span className="avatar spacer" />}
                <div className="botCol">
                  {first && <div className="botName">{character?.name || '비서'}</div>}
                  {body}
                  {time}
                </div>
              </div>
            );
          } else {
            row = (
              <div key={m.id} className={`row r-${m.role}`} data-day={dayAttr}>
                <div className="sysCol">{body}{time}</div>
              </div>
            );
          }
          return sep ? [sep, row] : row;
        })}
      </div>
    </div>
  );
}
