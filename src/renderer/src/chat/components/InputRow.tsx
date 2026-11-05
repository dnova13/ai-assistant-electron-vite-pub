import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatController, ChatState } from '../controller';
import { MicIcon } from '../../shared/MicIcon';

export function InputRow({ state, controller }: { state: ChatState; controller: ChatController }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const noCharacter = !controller.character();
  const hasVisible = state.characters.some((c) => !state.settings?.hiddenCharacters?.includes(c.id));
  const stt = controller.sttReadiness().ready;
  const micDisabled = noCharacter || state.transcribing || (!controller.canRecord() && !state.recording);

  // 입력창 높이를 글 길이에 맞춘다 (최대 110px, 넘으면 스크롤)
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 110)}px`;
    el.style.overflowY = el.scrollHeight > 108 ? 'auto' : 'hidden';
  }, [state.input]);

  useEffect(() => {
    if (state.focusTick) input.current?.focus();
  }, [state.focusTick]);

  return (
    <div id="inputRow">
      <button
        id="btnMic"
        className={state.recording ? 'rec' : ''}
        disabled={micDisabled}
        title={stt ? '음성 입력 (누르고 말하면, 말이 멈출 때 보냄)' : '음성 입력: 쓸 수 있는 음성 인식이 없습니다 (설정 > 음성)'}
        onClick={() => void controller.toggleMic()}
      >
        <MicIcon />
      </button>
      <textarea
        id="input"
        ref={input}
        rows={1}
        disabled={noCharacter}
        placeholder={noCharacter ? (hasVisible ? '대화할 캐릭터를 먼저 선택해 주세요' : '대화할 캐릭터를 먼저 표시해 주세요') : state.placeholder}
        value={state.input}
        onChange={(e) => controller.setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            controller.submit();
          }
        }}
      />
      <button id="btnStop" className={state.busy || state.speaking ? '' : 'hidden'} title="응답·목소리 멈추기" onClick={() => controller.stopAll()}>
        ■
      </button>
      <button id="btnSend" className="primary" disabled={noCharacter || state.busy} onClick={() => controller.submit()}>
        보내기
      </button>
    </div>
  );
}
