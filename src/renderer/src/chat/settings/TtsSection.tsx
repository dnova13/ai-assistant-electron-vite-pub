// 설정 > TTS: 답을 소리로 읽기 켜기/끄기(맨 위), TTS 서버 목록(＋ 추가, ✕ 삭제, 쓰는 캐릭터 얼굴) → 줄을 누르면 서버 수정.
// 목소리·배속·음량·"안 되면 컴퓨터 음성"은 캐릭터마다 설정 > 캐릭터 > 목소리에서 고른다.
import { useState } from 'react';
import type { Character, Settings, TtsServer } from '@shared/types';
import { blankTtsServer, charactersUsingTts, newId } from '@shared/char-prefs';
import { EditBar, ItemList, useEditFlow } from './ItemList';
import { itemDirty, type ItemApi } from './itemSave';

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  characters: Character[];
  api: ItemApi;
}

type Result = { cls: '' | 'ok' | 'fail'; text: string };
const EMPTY: Result = { cls: '', text: '' };
const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function TtsSection({ settings, update, characters, api }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const userOf = (sid: string) => charactersUsingTts(settings, sid).map((cid) => characters.find((c) => c.id === cid)).filter((c): c is Character => !!c);

  // 지우면 바로 저장된다. 이 서버를 쓰던 캐릭터는 컴퓨터 음성
  const remove = (sid: string) => api.remove({ kind: 'tts', id: sid });
  const add = () => {
    const nid = newId('tts', settings.ttsServers);
    update((s) => ({ ...s, ttsServers: { ...s.ttsServers, [nid]: blankTtsServer(`새 TTS ${Object.keys(s.ttsServers).length + 1}`) } }));
    setEditing(nid);
  };

  return (
    <div id="tab-tts" className="tabPane">
      <div className="sttBox" id="ttsOnBox">
        <label className="check">
          <input id="optTts" type="checkbox" checked={settings.voice.tts} onChange={(e) => update((x) => ({ ...x, voice: { ...x.voice, tts: e.target.checked } }))} /> 답변을 소리로 읽기
        </label>
        <p className="hint">설정 &gt; 단축키의 "TTS 켜기/끄기"나 트레이 메뉴로도 바꿀 수 있습니다. 끄면 답은 글로만 나옵니다.</p>
      </div>
      {editing && settings.ttsServers[editing] ? (
        <ServerEditor
          key={editing}
          id={editing}
          settings={settings}
          server={settings.ttsServers[editing]}
          set={(patch) => update((s) => (s.ttsServers[editing] ? { ...s, ttsServers: { ...s.ttsServers, [editing]: { ...s.ttsServers[editing], ...patch } } } : s))}
          users={userOf(editing)}
          api={api}
          onBack={() => setEditing(null)}
          onDelete={async () => {
            await remove(editing);
            setEditing(null);
          }}
        />
      ) : (
        <>
          <ItemList
            kind="tts"
            heading="TTS 서버"
            items={Object.entries(settings.ttsServers).map(([sid, t]) => ({
              id: sid,
              title: t.name || sid,
              sub: `${t.baseUrl || '캐릭터 AI 서버의 TTS'}${t.model ? ` · ${t.model}` : ''}`,
              users: userOf(sid)
            }))}
            addLabel="TTS 서버 추가"
            emptyText="등록한 TTS 서버가 없어요. 캐릭터는 컴퓨터 음성으로 읽습니다."
            onAdd={add}
            onOpen={setEditing}
            onDelete={remove}
            deleteNote={(it) => `키도 같이 지워집니다.${it.users.length ? ` 이 서버를 쓰던 캐릭터(${it.users.map((c) => c.config.name || c.id).join(', ')})는 컴퓨터 음성으로 읽습니다.` : ''}`}
          />
          <p className="hint">캐릭터마다 읽는 방식(컴퓨터 음성 / TTS 서버)·목소리·배속·음량은 설정 &gt; 캐릭터 &gt; 프로필 &gt; 목소리에서 고릅니다.</p>
        </>
      )}
    </div>
  );
}

interface EditorProps {
  id: string;
  api: ItemApi;
  settings: Settings;
  server: TtsServer;
  set: (patch: Partial<TtsServer>) => void;
  users: Character[];
  onBack: () => void;
  onDelete: () => void | Promise<unknown>;
}

function ServerEditor({ id, api, settings, server: t, set, users, onBack, onDelete }: EditorProps) {
  const key = { kind: 'tts' as const, id };
  const flow = useEditFlow(itemDirty(settings, api.saved, key), () => api.save(key), onBack, () => api.revert(key));
  const [askDel, setAskDel] = useState(false);
  const [testRes, setTestRes] = useState<Result>(EMPTY);
  const [found, setFound] = useState<{ voices: string[]; models: string[] }>({ voices: [], models: [] });

  const testServer = async () => {
    setTestRes({ cls: '', text: '확인 중…' });
    try {
      const r = await window.app.tts.testServer({ baseUrl: t.baseUrl, apiKey: t.apiKey, voice: '', model: t.model });
      setFound({ voices: r.voices, models: r.models });
      setTestRes({
        cls: 'ok',
        text:
          r.kind === 'v1'
            ? `연결 성공 · 규약 v1 서버 (목소리 읽기 지원${r.voices.length ? `, 목소리 ${r.voices.length}개` : ''})`
            : `연결 성공 · OpenAI 호환 서버 (모델 ${r.models.length}개${r.voices.length ? `, 목소리 ${r.voices.length}개` : ''})`
      });
    } catch (e) {
      setTestRes({ cls: 'fail', text: errText(e) });
    }
  };

  return (
    <div className="sttBox" id="ttsBox">
      <div className="editHead">
        <button id="btnTtsBack" type="button" className="backBtn" onClick={flow.tryBack}>
          ‹ 목록
        </button>
        {askDel ? (
          <span className="itemAsk">
            <button id="btnTtsDelYes" type="button" className="danger" onClick={onDelete}>
              삭제
            </button>
            <button type="button" onClick={() => setAskDel(false)}>
              취소
            </button>
          </span>
        ) : (
          <button id="btnTtsDel" type="button" onClick={() => setAskDel(true)}>
            삭제
          </button>
        )}
      </div>
      {askDel && (
        <p className="warn">
          "{t.name}"을(를) 삭제할까요? 키도 같이 지워집니다.
          {users.length ? ` 이 서버를 쓰던 캐릭터(${users.map((c) => c.config.name || c.id).join(', ')})는 컴퓨터 음성으로 읽습니다.` : ''} 바로 삭제됩니다.
        </p>
      )}
      <label>
        이름
        <input id="ttsServerName" type="text" maxLength={40} value={t.name} onChange={(e) => set({ name: e.target.value })} onBlur={() => !t.name.trim() && set({ name: 'TTS' })} />
      </label>
      <label>
        주소
        <input
          id="ttsServerUrl"
          type="text"
          placeholder="비우면 캐릭터 AI 서버의 TTS (규약 v1) · 예: http://192.168.0.10:8880"
          value={t.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value.trim() })}
        />
      </label>
      {t.baseUrl ? (
        <>
          <label>
            키 (서버가 요구할 때만)
            <input id="ttsServerKey" type="password" autoComplete="off" value={t.apiKey} onChange={(e) => set({ apiKey: e.target.value.trim() })} />
          </label>
          <label>
            모델 (OpenAI 호환 서버일 때, 비우면 알아서 고름)
            <input id="ttsServerModel" type="text" list="ttsServerModels" value={t.model} onChange={(e) => set({ model: e.target.value.trim() })} />
            <datalist id="ttsServerModels">
              {found.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <div className="row">
            <button id="btnTtsServerTest" type="button" onClick={() => void testServer()}>
              연결 테스트
            </button>
            <span id="ttsServerResult" className={testRes.cls}>
              {testRes.text}
            </span>
          </div>
          {found.voices.length > 0 && <p className="hint">이 서버의 목소리: {found.voices.slice(0, 12).join(', ')}{found.voices.length > 12 ? ' …' : ''} (캐릭터 &gt; 목소리에서 고름)</p>}
        </>
      ) : (
        <p className="hint">주소를 비우면 그 캐릭터가 쓰는 AI 서버(규약 v1 비서 서버)의 목소리 읽기를 씁니다.</p>
      )}
      <p className="hint">OpenAI 호환(/v1/audio/speech)과 규약 v1(/v1/tts) 서버를 받습니다. 내 서버에 올린 오픈소스 TTS나 클라우드 TTS(주소와 키)를 넣을 수 있습니다.</p>
      <EditBar prefix="btnTtsServer" flow={flow} />
    </div>
  );
}
