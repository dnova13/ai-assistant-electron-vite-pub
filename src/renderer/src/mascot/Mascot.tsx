import { selectedCharacter } from '@shared/character-order';
// 마스코트 창: 캐릭터와 말풍선만 보여 준다. 대화·목소리·녹음은 대화 창이 하고, 여기는 받은 상태를 그린다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { MascotMessage } from '@shared/types';
import { CharacterView } from '../shared/CharacterView';
import { MicIcon } from '../shared/MicIcon';
import type { CharacterStage } from '../lib/character';
import { bindMascotBubble } from '../lib/mascot-bubble';

const A = () => window.app;

export function Mascot() {
  const stage = useRef<CharacterStage | null>(null);
  const current = useRef<{ id: string | null; lowSpec: boolean | null }>({ id: null, lowSpec: null });
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hit = useRef<HTMLDivElement>(null);
  const bubbleEl = useRef<HTMLDivElement>(null);
  const bubbleText = useRef<HTMLDivElement>(null);
  const bubbleLayout = useRef<ReturnType<typeof bindMascotBubble> | null>(null);
  const hovering = useRef(false);
  /** 말풍선 위에 마우스가 있으면 사라지지 않는다 */
  const overBubble = useRef(false);
  /** 맨 아래를 따라갈지 (사용자가 위로 올려 읽는 중이면 false) */
  const stick = useRef(true);
  const lastText = useRef('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [notice, setNotice] = useState('');
  const down = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [bubble, setBubble] = useState('');
  const [recording, setRecording] = useState(false);
  /** 항상 듣기(호출어) 설정 */
  const [wakeOn, setWakeOn] = useState(false);
  /** 지금 호출어를 기다리는 중 (마이크 켜짐) */
  const [wakeListening, setWakeListening] = useState(false);

  // 다 보여 준 말풍선은 9초 뒤에 닫는다. 마우스가 말풍선 위에 있으면 기다린다.
  const hideLater = useCallback(() => {
    clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(function tick() {
      if (overBubble.current) bubbleTimer.current = setTimeout(tick, 1500);
      else setBubble('');
    }, 9000);
  }, []);

  const showBubble = useCallback(
    (text: string, final: boolean) => {
      clearTimeout(bubbleTimer.current);
      // 이어지는 글이 아니면(새 답) 다시 맨 아래를 따라간다
      if (!text || !text.startsWith(lastText.current)) stick.current = true;
      lastText.current = text;
      setBubble(text); // 긴 답은 말풍선 안에서 스크롤한다
      if (text && final) hideLater();
    },
    [hideLater]
  );

  // 글이 늘어나면 맨 아래로 (위로 올려 읽는 중이면 그대로)
  useLayoutEffect(() => {
    bubbleLayout.current?.place();
    const el = bubbleText.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [bubble]);

  useLayoutEffect(() => {
    if (!bubbleEl.current || !bubbleText.current || !hit.current) return;
    const layout = bindMascotBubble(bubbleEl.current, bubbleText.current, hit.current, () => stage.current?.bounds() || null, () => stick.current);
    bubbleLayout.current = layout;
    return () => { layout.dispose(); bubbleLayout.current = null; };
  }, []);

  const onBubbleScroll = () => {
    const el = bubbleText.current;
    if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 6;
  };

  const loadCharacter = useCallback(async (force: boolean) => {
    const { settings } = await A().settings.load();
    setWakeOn(!!settings.voice.wake.enabled);
    const list = await A().characters.list();
    const c = selectedCharacter(list, settings.character, settings.hiddenCharacters);
    const id = c ? c.id : null;
    if (!force && id === current.current.id && settings.lowSpec === current.current.lowSpec) return;
    current.current = { id, lowSpec: settings.lowSpec };
    await stage.current?.show(c, { lowSpec: settings.lowSpec });
    bubbleLayout.current?.schedule();
  }, []);

  // 대화 창이 보내는 상태
  useEffect(() => {
    void loadCharacter(true);
    return A().mascot.onUpdate((m: MascotMessage) => {
      switch (m.type) {
        case 'mouth':
          stage.current?.setMouth(Number(m.v) || 0);
          bubbleLayout.current?.schedule();
          break;
        case 'state':
          stage.current?.setState(m.state);
          bubbleLayout.current?.schedule();
          break;
        case 'bubble':
          showBubble(m.text, m.final);
          break;
        case 'wake':
          setWakeListening(!!m.on);
          break;
        case 'notice':
          clearTimeout(noticeTimer.current);
          setNotice(m.text);
          noticeTimer.current = setTimeout(() => setNotice(''), 3000);
          break;
        case 'recording':
          setRecording(!!m.on);
          if (m.on) showBubble('듣고 있어요…', false);
          break;
        case 'character':
        case 'settings':
          void loadCharacter(m.type === 'character');
          break;
      }
    });
  }, [loadCharacter, showBubble]);

  // 마우스: 캐릭터 위에서만 클릭을 받는다. 투명한 곳에서는 클릭이 뒤로 지나간다 (맥·윈도우). 마우스 이동은 계속 들어온다.
  useEffect(() => {
    const setHover = (on: boolean) => {
      if (on !== hovering.current) {
        hovering.current = on;
        A().mascot.hover(on);
      }
    };
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      setHover(!!el && (!!hit.current?.contains(el) || !!bubbleEl.current?.contains(el)));
    };
    const onLeave = () => setHover(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // 끌면 창이 따라오고, 그냥 누르면 대화 창 열기/닫기
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('#toolbar')) return;
    down.current = { x: e.screenX, y: e.screenY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    A().mascot.drag('start');
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = down.current;
    if (!d) return;
    if (Math.abs(e.screenX - d.x) + Math.abs(e.screenY - d.y) > 4) d.moved = true;
    if (d.moved) A().mascot.drag('move');
  };
  const onPointerEnd = () => {
    const d = down.current;
    if (!d) return;
    A().mascot.drag('end');
    if (!d.moved) A().mascot.click();
    down.current = null;
  };

  return (
    <>
      <div
        id="bubble"
        ref={bubbleEl}
        className={bubble ? '' : 'hidden'}
        onClick={() => A().mascot.click()}
        onMouseEnter={() => (overBubble.current = true)}
        onMouseLeave={() => (overBubble.current = false)}
      >
        <div id="bubbleText" ref={bubbleText} aria-live="polite" onScroll={onBubbleScroll}>
          {bubble}
        </div>
      </div>
      <div id="notice" className={notice ? '' : 'hidden'} role="status">
        {notice}
      </div>
      <div id="hit" ref={hit} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <CharacterView onReady={(s) => (stage.current = s)} onNotice={(m) => showBubble(m, true)} emptyText="캐릭터 없음" />
        <div id="toolbar">
          <button id="btnChat" title="대화 창" onClick={() => A().mascot.click()}>
            💬
          </button>
          <button id="btnMic" className={recording ? 'rec' : ''} title="말하기 (단축키와 같음)" onClick={() => A().mascot.mic()}>
            <MicIcon size={16} />
          </button>
          <button id="btnWake" className={wakeOn ? 'on' : ''} title={wakeOn ? '항상 듣기 끄기 (호출어)' : '항상 듣기 켜기 (호출어로 부르기)'} onClick={() => A().mascot.wake()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 9a6 6 0 0 1 12 0c0 3-2 4-3 5.5S14 18 12 19.5 8 20 8 17" />
              <path d="M10 9a2 2 0 0 1 4 0" />
            </svg>
          </button>
          <button id="btnHide" title="캐릭터 숨기기 (트레이 메뉴에서 다시 켬)" onClick={() => A().mascot.hide()}>
            ✕
          </button>
        </div>
        <div id="recDot" className={recording ? '' : 'hidden'} title="녹음 중" />
        <div id="wakeDot" className={wakeListening && !recording ? '' : 'hidden'} title="호출어를 기다리는 중 (마이크 켜짐)" />
      </div>
    </>
  );
}
