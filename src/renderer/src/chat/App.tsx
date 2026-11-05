// 대화 창: 상단바, 대화(메신저 모양), 입력줄, 설정창, 확인 창
import { useEffect, useState } from 'react';
import { ChatController } from './controller';
import { useChat } from './useChat';
import { TopBar } from './components/TopBar';
import { Messages } from './components/Messages';
import { CharacterBar } from './components/CharacterBar';
import { toAvatar } from './components/Avatar';
import { dropOn, visibleCharacters } from '@shared/character-order';
import { InputRow } from './components/InputRow';
import { ListeningMeter } from './components/LevelMeter';
import { ConfirmDialog } from './components/ConfirmDialog';
import { connectSettingsHost } from './settings/window-bridge';

export function App() {
  const [controller] = useState(() => new ChatController());
  const state = useChat(controller);
  useEffect(() => connectSettingsHost(controller), [controller]);

  useEffect(() => {
    void controller.init();
    return () => controller.dispose();
  }, [controller]);

  // Esc: 듣기 취소, 읽는 중이면 읽기 멈춤 (기다리던 이어서 듣기도 취소된다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || state.dialog) return;
      if (state.recording) void controller.finishRecording(true);
      else if (state.speaking) controller.stopAll();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [controller, state.recording, state.speaking, state.dialog]);

  const c = controller.character();
  const visible = visibleCharacters(state.characters, state.settings?.hiddenCharacters);

  return (
    <>
      <TopBar hideStatus={!c} name={c ? c.config.name || c.id : 'AI 비서'} status={state.status} onSettings={() => { void window.app.settingsWindow.open(); }} />
      {!!visible.length && <CharacterBar
        characters={visible}
        currentId={c ? c.id : ''}
        onSelect={(id) => void controller.selectCharacter(id)}
        onReorder={(from, to) => void controller.setCharacterOrder(dropOn(state.characters.map((x) => x.id), from, to))}
      />}
      <section id="chat">
        {c ? <Messages messages={state.messages} character={c ? toAvatar(c) : null} onOpen={(p) => controller.openResult(p, 'file.open')} onReveal={(p) => controller.openResult(p, 'file.reveal')} onDownload={(id) => void controller.downloadReceived(id)} /> : <div className="chatEmpty" role="status">
          <div className="chatEmptyIcon" aria-hidden="true"><svg viewBox="0 0 48 48" width="52" height="52" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="24" cy="15" r="8"/><path d="M8 42v-4c0-8 7-13 16-13s16 5 16 13v4Z"/></svg></div>
          <h2>{visible.length ? '대화할 캐릭터를 선택해 주세요' : '표시 중인 캐릭터가 없습니다'}</h2>
          <p>{visible.length ? '위의 캐릭터를 선택하면 대화를 시작할 수 있어요.' : '설정에서 캐릭터를 표시하면 대화를 시작할 수 있어요.'}</p>
          {!visible.length && <button className="primary" onClick={() => void window.app.settingsWindow.open('character')}>캐릭터 설정 열기</button>}
        </div>}
        <ListeningMeter controller={controller} on={state.recording} />
        <InputRow state={state} controller={controller} />
      </section>
      <ConfirmDialog dialog={state.dialog} onResolve={controller.resolveDialog} interpret={(_q, a) => window.app.api.interpretConfirmation(_q, a)} />
    </>
  );
}
