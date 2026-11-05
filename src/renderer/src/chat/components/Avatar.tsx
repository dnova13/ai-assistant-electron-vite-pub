// 둥근 캐릭터 그림. 그림이 없거나 못 읽으면 이름 첫 글자 (말풍선 옆·선택 바·순서 목록이 같은 부품을 쓴다)
import { useEffect, useState, type CSSProperties } from 'react';
import type { Character } from '@shared/types';
import { characterFileUrl } from '../../lib/character';

export interface AvatarCharacter {
  id: string;
  name: string;
  /** 동그란 그림으로 쓸 파일 (캐릭터 폴더 안 경로). 없으면 이름 첫 글자 */
  icon?: string;
}

export const toAvatar = (c: Character): AvatarCharacter => ({ id: c.id, name: c.config.name || c.id, icon: c.config.icon || c.config.image });

export function Avatar({ character, size }: { character: AvatarCharacter | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const src = character?.icon ? characterFileUrl(character.id, character.icon) : '';
  useEffect(() => setBroken(false), [src]);
  const style = size ? ({ '--sz': `${size}px` } as CSSProperties) : undefined;
  return (
    <span className="avatar" aria-hidden="true" style={style}>
      {src && !broken ? <img src={src} alt="" draggable={false} onError={() => setBroken(true)} /> : (character?.name || '비서').trim().slice(0, 1) || '?'}
    </span>
  );
}
