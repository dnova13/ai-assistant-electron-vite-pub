// 설정 > AI·TTS의 목록: ＋ 추가, 줄(이름 / 설명 / 쓰는 캐릭터 얼굴), ✕ 삭제(그 줄에서 한 번 더 묻기), 줄을 누르면 수정.
// 캐릭터 얼굴은 겹쳐서 5개까지 (((, 넘으면 +N에 마우스를 올리면 나머지 이름 목록.
import { useState } from 'react';
import type { Character } from '@shared/types';
import { Avatar, toAvatar } from '../components/Avatar';

const STACK_MAX = 5;

/** 겹친 캐릭터 얼굴 (뒤 그림의 3/5를 앞 그림이 가린다) */
export function AvatarStack({ characters, emptyText = '쓰는 캐릭터 없음' }: { characters: Character[]; emptyText?: string }) {
  if (!characters.length) return <span className="stackEmpty">{emptyText}</span>;
  const shown = characters.slice(0, STACK_MAX);
  const rest = characters.slice(STACK_MAX);
  return (
    <span className="avatarStack" aria-label={`쓰는 캐릭터: ${characters.map((c) => c.config.name || c.id).join(', ')}`}>
      {shown.map((c, i) => (
        <span key={c.id} className="stackItem" style={{ zIndex: i + 1 }} title={String(c.config.name || c.id)}>
          <Avatar character={toAvatar(c)} size={22} />
        </span>
      ))}
      {rest.length > 0 && (
        <span className="stackMore" tabIndex={0}>
          +{rest.length}
          <span className="stackPop" role="tooltip">
            {rest.map((c) => (
              <span key={c.id}>{c.config.name || c.id}</span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

export interface ListItem {
  id: string;
  title: string;
  sub: string;
  users: Character[];
}

interface Props {
  /** 시험·스타일용 id 앞부분 (ai, tts) */
  kind: string;
  heading: string;
  items: ListItem[];
  addLabel: string;
  emptyText: string;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void | Promise<unknown>;
  /** 삭제를 물을 때 덧붙일 설명 (쓰는 캐릭터가 어떻게 되는지) */
  deleteNote: (item: ListItem) => string;
}

export function ItemList({ kind, heading, items, addLabel, emptyText, onAdd, onOpen, onDelete, deleteNote }: Props) {
  const [ask, setAsk] = useState<string | null>(null);
  const asking = items.find((x) => x.id === ask) || null;
  return (
    <div className="itemList" id={`${kind}List`}>
      <div className="itemHead">
        <b>{heading}</b>
        <button type="button" className="itemAdd" id={`${kind}Add`} onClick={onAdd}>
          ＋ 추가
        </button>
      </div>
      {!items.length ? (
        <div className="itemEmpty" id={`${kind}Empty`}>
          <p>{emptyText}</p>
          <button type="button" className="primary" onClick={onAdd}>
            ＋ {addLabel}
          </button>
        </div>
      ) : (
        <div className="itemRows">
          {items.map((it) => (
            <div
              key={it.id}
              className={ask === it.id ? 'itemRow asking' : 'itemRow'}
              data-id={it.id}
              role="button"
              tabIndex={0}
              onClick={() => ask !== it.id && onOpen(it.id)}
              onKeyDown={(e) => e.key === 'Enter' && ask !== it.id && onOpen(it.id)}
            >
              <div className="itemMain">
                <div className="itemTitle">{it.title}</div>
                <div className="itemSub">{it.sub}</div>
                <AvatarStack characters={it.users} />
              </div>
              {ask === it.id ? (
                <span className="itemAsk" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="danger itemDelYes" onClick={() => (setAsk(null), onDelete(it.id))}>
                    삭제
                  </button>
                  <button type="button" className="itemDelNo" onClick={() => setAsk(null)}>
                    취소
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="charDel itemDel"
                  title={`${it.title} 삭제`}
                  aria-label={`${it.title} 삭제`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAsk(it.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {asking && (
        <p className="warn" id={`${kind}DeleteWarn`}>
          "{asking.title}"을(를) 삭제할까요? {deleteNote(asking)} 바로 삭제됩니다.
        </p>
      )}
    </div>
  );
}

/**
 * 수정 화면의 저장·나가기. 저장하면 그 항목만 저장하고 목록으로 돌아간다.
 * ‹ 목록을 누를 때 고친 값이 있으면 버릴지 한 번 묻는다.
 */
export function useEditFlow(dirty: boolean, save: () => Promise<boolean>, back: () => void, revert: () => void) {
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  return {
    asking,
    saving,
    tryBack: () => (dirty ? setAsking(true) : back()),
    keepEditing: () => setAsking(false),
    discard: () => {
      revert();
      back();
    },
    saveAndBack: async () => {
      setSaving(true);
      const ok = await save();
      setSaving(false);
      if (ok) back();
    }
  };
}

export function EditBar({ prefix, flow }: { prefix: string; flow: ReturnType<typeof useEditFlow> }) {
  return (
    <div className="editFoot" id={`${prefix}Foot`}>
      {flow.asking && (
        <p className="warn" id={`${prefix}DiscardWarn`}>
          저장하지 않은 수정이 있습니다. 버리고 목록으로 갈까요?
        </p>
      )}
      <div className="row">
        {flow.asking ? (
          <>
            <button id={`${prefix}Discard`} type="button" className="danger" onClick={flow.discard}>
              버리기
            </button>
            <button id={`${prefix}Keep`} type="button" onClick={flow.keepEditing}>
              계속 수정
            </button>
          </>
        ) : (
          <button id={`${prefix}Save`} type="button" className="primary" disabled={flow.saving} onClick={() => void flow.saveAndBack()}>
            저장
          </button>
        )}
      </div>
    </div>
  );
}
