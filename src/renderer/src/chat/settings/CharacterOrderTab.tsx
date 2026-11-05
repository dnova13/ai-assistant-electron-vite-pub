// 설정 > 캐릭터 > 순서: 선택 바에 보이는 순서를 정한다. 줄을 고르고 위쪽 막대의 ↑ ↓ 맨위 맨아래로 옮기거나, 번호로 옮기기·끌어 놓기도 된다.
// 바뀐 순서는 저장 버튼 없이 바로 저장된다 (선택 바와 같은 순서를 쓴다).
import { useState } from 'react';
import type { Character } from '@shared/types';
import { dropOn, moveTo } from '@shared/character-order';
import { Avatar, toAvatar } from '../components/Avatar';

interface Props {
  characters: Character[];
  onOrder: (order: string[]) => void;
}

export function CharacterOrderTab({ characters, onOrder }: Props) {
  const ids = characters.map((c) => c.id);
  const [dragId, setDragId] = useState('');
  const [overId, setOverId] = useState('');
  const [sel, setSel] = useState('');
  const [nums, setNums] = useState<Record<string, string>>({});

  const goto = (id: string, n: number) => {
    if (!Number.isFinite(n)) return;
    onOrder(moveTo(ids, id, Math.round(n) - 1));
  };

  const cur = ids.includes(sel) ? sel : ids[0] || ''; // 고른 줄이 없으면 첫 줄
  const at = ids.indexOf(cur);

  return (
    <div id="tab-order" className="tabPane">
      <p className="hint">대화 창 위 캐릭터 바의 순서입니다. 바뀐 순서는 저장을 누르지 않아도 바로 저장됩니다. 캐릭터가 많으면 번호로 옮기는 게 빨라요.</p>
      <div id="orderBar">
        <span className="orderBarSide">
          <button className="ordUp" title="고른 캐릭터를 위로" disabled={at <= 0} onClick={() => onOrder(moveTo(ids, cur, at - 1))}>
            ↑ 위로
          </button>
          <button className="ordDown" title="고른 캐릭터를 아래로" disabled={at < 0 || at >= ids.length - 1} onClick={() => onOrder(moveTo(ids, cur, at + 1))}>
            ↓ 아래로
          </button>
        </span>
        <span className="orderBarSide">
          <button className="ordTop" title="고른 캐릭터를 맨 위로" disabled={at <= 0} onClick={() => onOrder(moveTo(ids, cur, 0))}>
            맨위
          </button>
          <button className="ordBottom" title="고른 캐릭터를 맨 아래로" disabled={at < 0 || at >= ids.length - 1} onClick={() => onOrder(moveTo(ids, cur, ids.length - 1))}>
            맨아래
          </button>
        </span>
      </div>
      <div id="orderList">
        {characters.map((c, i) => {
          const a = toAvatar(c);
          return (
            <div
              key={c.id}
              className={`orderRow${cur === c.id ? ' sel' : ''}${dragId === c.id ? ' dragging' : ''}${overId === c.id && dragId !== c.id ? ' dropHere' : ''}`}
              data-id={c.id}
              draggable
              onClick={() => setSel(c.id)}
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
                if (dragId && dragId !== c.id) onOrder(dropOn(ids, dragId, c.id));
                setDragId('');
                setOverId('');
              }}
              onDragEnd={() => {
                setDragId('');
                setOverId('');
              }}
            >
              <span className="orderNo">{i + 1}</span>
              <Avatar character={a} size={32} />
              <span className="orderName">{a.name}</span>
              <span className="orderBtns">
                <input
                  className="ordNum"
                  type="number"
                  min={1}
                  max={ids.length}
                  placeholder="번호"
                  title="이 번호로 옮기기 (Enter)"
                  value={nums[c.id] ?? ''}
                  onChange={(e) => setNums((m) => ({ ...m, [c.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    goto(c.id, Number(nums[c.id]));
                    setNums((m) => ({ ...m, [c.id]: '' }));
                  }}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
