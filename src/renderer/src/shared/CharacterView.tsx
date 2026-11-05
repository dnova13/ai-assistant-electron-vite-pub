// 캐릭터 무대. 그리기는 lib/character.ts 가 DOM에 직접 한다 (입 모양이 초당 60번 바뀌므로 React로 다시 그리지 않음).
// 대화 창과 마스코트 창이 같이 쓴다.
import { memo, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { CharacterStage } from '../lib/character';

interface Props {
  onReady: (stage: CharacterStage | null) => void;
  onNotice: (msg: string) => void;
  emptyText: ReactNode;
}

export const CharacterView = memo(function CharacterView({ onReady, onNotice, emptyText }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const empty = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  const notice = useRef(onNotice);
  ready.current = onReady;
  notice.current = onNotice;

  useEffect(() => {
    if (!box.current || !img.current || !empty.current) return;
    const stage = new CharacterStage({ box: box.current, img: img.current, empty: empty.current }, (m) => notice.current(m));
    ready.current(stage);
    return () => {
      ready.current(null);
      stage.destroy();
    };
  }, []);

  // className은 처음에만 정하고, 이후 보이기·숨기기는 CharacterStage가 직접 바꾼다
  return (
    <div id="stageBox" ref={box}>
      <img id="characterImg" ref={img} className="hidden" alt="" draggable={false} />
      <div id="noCharacter" ref={empty} className="hidden">
        {emptyText}
      </div>
    </div>
  );
});
