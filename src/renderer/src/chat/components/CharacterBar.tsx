// 대화 창 위쪽 캐릭터 선택 바: 둥근 그림 + 이름(길면 …). 누르면 그 캐릭터 대화로 (듣는 중·답하는 중이면 멈추고 바꿈), 끌면 순서 바꾸기.
// 가로로 넘치면 < > 버튼으로 스크롤한다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Character } from '@shared/types';
import { Avatar, toAvatar } from './Avatar';

interface Props {
  characters: Character[];
  currentId: string;
  onSelect: (id: string) => void;
  onReorder: (from: string, to: string) => void;
}

export function CharacterBar({ characters, currentId, onSelect, onReorder }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [dragId, setDragId] = useState('');
  const [overId, setOverId] = useState('');

  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, characters.length]);

  // 고른 캐릭터가 가려져 있으면 보이게
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('.barItem.active');
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    measure();
  }, [currentId, characters, measure]);

  const scrollBy = (dir: -1 | 1) => {
    const el = box.current;
    if (el) el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.7), behavior: 'smooth' });
  };

  // 마우스 휠(세로)을 가로 스크롤로
  const onWheel = (e: React.WheelEvent) => {
    const el = box.current;
    if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
  };

  return (
    <div id="charBar" role="tablist" aria-label="캐릭터">
      {(canLeft || canRight) && (
        <button className="barArrow" id="barLeft" title="왼쪽으로" disabled={!canLeft} onClick={() => scrollBy(-1)}>
          ‹
        </button>
      )}
      <div className="barScroll" ref={box} onScroll={measure} onWheel={onWheel}>
        {characters.map((c) => {
          const a = toAvatar(c);
          const active = c.id === currentId;
          return (
            <button
              key={c.id}
              role="tab"
              aria-selected={active}
              data-id={c.id}
              className={`barItem${active ? ' active' : ''}${dragId === c.id ? ' dragging' : ''}${overId === c.id && dragId !== c.id ? ' dropHere' : ''}`}
              title={a.name}
              draggable
              onClick={() => !active && onSelect(c.id)}
              onDragStart={(e) => {
                setDragId(c.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', c.id);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(c.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== c.id) onReorder(dragId, c.id);
                setDragId('');
                setOverId('');
              }}
              onDragEnd={() => {
                setDragId('');
                setOverId('');
              }}
            >
              <Avatar character={a} size={44} />
              <span className="barName">{a.name}</span>
            </button>
          );
        })}
      </div>
      {(canLeft || canRight) && (
        <button className="barArrow" id="barRight" title="오른쪽으로" disabled={!canRight} onClick={() => scrollBy(1)}>
          ›
        </button>
      )}
    </div>
  );
}
