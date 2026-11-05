// 설정 > AI: AI 프로필 목록(＋ 추가, ✕ 삭제, 쓰는 캐릭터 얼굴) → 줄을 누르면 수정 화면(서버 종류, 주소, 토큰, 연결 테스트, 모델).
// 처음에는 프로필이 없다. 캐릭터마다 설정 > 캐릭터 > AI에서 프로필을 고른다. 연결 확인은 수정 화면의 연결 테스트로만 한다.
import { useEffect, useRef, useState } from 'react';
import type { Character, Profile, ProviderType, Settings } from '@shared/types';
import { blankProfile, charactersUsingProfile, newId } from '@shared/char-prefs';
import { EditBar, ItemList, useEditFlow } from './ItemList';
import { itemDirty, type ItemApi } from './itemSave';
import { profileSub, patchProfile, sameConnection, connectionInfo } from '@shared/profile-summary';
import { geminiLabel } from '@shared/gemini-models';
import { CHOICE_LABEL, OFFICIAL_OPENAI, PROVIDER_INFO, choiceOf, type Choice } from '@shared/providers';

interface Props {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  encrypted: boolean;
  characters: Character[];
  api: ItemApi;
}

const KIND_NAME: Record<string, string> = { ollama: 'Ollama', openai: 'OpenAI 호환 서버', assistant: '비서 서버' };
/** 인식 결과 이름. 주소가 /api로 끝나는 OpenAI 호환 서버는 Open WebUI일 가능성이 커서 함께 알려 준다 */
const kindText = (provider: string, url?: string): string =>
  provider === 'openai' && url && /\/api$/i.test(url) ? 'OpenAI 호환 서버 (Open WebUI 등)' : KIND_NAME[provider] || provider;

/** 모델 목록 + 지금 값 (목록에 없어도 보이게) */
function modelOptions(models: string[], current: string, emptyLabel?: string, gemini = false): { value: string; label: string }[] {
  const list = models.length ? [...models] : current ? [current] : [];
  if (current && !list.includes(current)) list.unshift(current);
  if (emptyLabel !== undefined) list.unshift('');
  if (!list.length) list.push('');
  return list.map((m) => ({ value: m, label: m ? (gemini ? geminiLabel(m) : m) : emptyLabel !== undefined ? emptyLabel : '(연결 테스트로 모델을 불러오세요)' }));
}

export function AiTab({ settings, update, encrypted, characters, api }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const userOf = (pid: string) => charactersUsingProfile(settings, pid).map((cid) => characters.find((c) => c.id === cid)).filter((c): c is Character => !!c);

  // 지우면 바로 저장된다. 이 프로필을 고른 캐릭터는 "선택 안 함"
  const remove = (pid: string) => api.remove({ kind: 'profile', id: pid });
  const add = () => {
    const nid = newId('p', settings.profiles);
    update((s) => ({ ...s, profiles: { ...s.profiles, [nid]: blankProfile(`새 AI ${Object.keys(s.profiles).length + 1}`) } }));
    setEditing(nid);
  };

  if (!editing || !settings.profiles[editing])
    return (
      <div id="tab-ai" className="tabPane">
        <ItemList
          kind="ai"
          heading="AI 프로필"
          items={Object.entries(settings.profiles).map(([pid, p]) => ({ id: pid, title: p.name || pid, sub: profileSub(p), users: userOf(pid) }))}
          addLabel="AI 프로필 추가"
          emptyText="아직 AI 프로필이 없어요."
          onAdd={add}
          onOpen={setEditing}
          onDelete={remove}
          deleteNote={(it) =>
            `API 키도 같이 지워집니다.${it.users.length ? ` 이 AI를 쓰던 캐릭터(${it.users.map((c) => c.config.name || c.id).join(', ')})는 "선택 안 함"이 됩니다.` : ''}`
          }
        />
        <p className="hint">캐릭터마다 쓸 AI는 설정 &gt; 캐릭터 &gt; 프로필 &gt; AI에서 고릅니다. 줄을 누르면 고칠 수 있고, 연결은 고치는 화면의 "연결 테스트"로 확인합니다.</p>
      </div>
    );

  return (
    <ProfileEditor
      key={editing}
      id={editing}
      settings={settings}
      update={update}
      encrypted={encrypted}
      users={userOf(editing)}
      api={api}
      onBack={() => setEditing(null)}
      onDelete={async () => {
        await remove(editing);
        setEditing(null);
      }}
    />
  );
}

interface EditorProps {
  id: string;
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  encrypted: boolean;
  users: Character[];
  api: ItemApi;
  onBack: () => void;
  onDelete: () => void | Promise<unknown>;
}

/** AI 프로필 고치기 (예전 설정 > AI 화면과 같은 칸) */
function ProfileEditor({ id, settings, update, encrypted, users, api, onBack, onDelete }: EditorProps) {
  const p = settings.profiles[id];
  const key = { kind: 'profile' as const, id };
  const flow = useEditFlow(itemDirty(settings, api.saved, key), () => api.save(key), onBack, () => api.revert(key));
  const [askDel, setAskDel] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [detected, setDetected] = useState<ProviderType | null>(null); // 자동 인식 결과
  const [test, setTest] = useState<{ cls: '' | 'ok' | 'fail'; text: string }>({ cls: '', text: '' });

  const current = useRef(p);
  current.current = p;
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);
  const setP = (patch: Partial<Profile>) => {
    if (!sameConnection(p, { ...p, ...patch })) {
      attempt.current++;
      setTest({ cls: '', text: '' });
      setDetected(null);
      setModels([]);
    }
    update((s) => s.profiles[id] ? { ...s, profiles: { ...s.profiles, [id]: patchProfile(s.profiles[id], patch) } } : s);
  };

  const testConnection = async () => {
    const serial = ++attempt.current;
    const tested = p;
    setP({ connectionInfo: undefined });
    setTest({ cls: '', text: '확인 중…' });
    try {
      const h = await window.app.api.health(tested);
      if (serial !== attempt.current || !sameConnection(current.current, tested)) return;
      update((s) => s.profiles[id] && sameConnection(s.profiles[id], tested)
        ? { ...s, profiles: { ...s.profiles, [id]: { ...s.profiles[id], connectionInfo: connectionInfo(h) } } } : s);
      setDetected(h.provider);
      if (h.provider !== 'assistant') setModels(h.models);
      setTest({
        cls: 'ok',
        text:
          h.provider !== 'assistant'
            ? `연결 성공${p.type === 'auto' ? ` · ${kindText(h.provider, h.resolvedUrl)}로 인식${h.resolvedUrl && h.resolvedUrl !== p.baseUrl.replace(/\/+$/, '') ? ` (주소 ${h.resolvedUrl})` : ''}` : ''} (모델 ${h.models.length}개)${!p.model && h.models.length ? ' · 아래에서 모델을 고르세요' : ''}`
            : `연결 성공 · ${h.server} ${h.version} · 모델 ${h.model || '?'}${h.warning ? ' · ' + h.warning : ''}`
      });
    } catch (e) {
      if (serial !== attempt.current || !sameConnection(current.current, tested)) return;
      setTest({ cls: 'fail', text: (e as Error).message });
    }
  };

  const info = PROVIDER_INFO[p.type] || PROVIDER_INFO.auto;
  const choice = choiceOf(p.type, p.baseUrl);
  // 자동 인식한 결과가 비서 서버면 모델 칸은 서버가 정하므로 숨긴다
  const direct = p.type === 'auto' ? detected !== 'assistant' : info.direct;
  const cloud = choice === 'openai' || choice === 'anthropic' || choice === 'gemini';
  const choices: Choice[] = ['openai', 'anthropic', 'gemini', 'own', 'assistant'];

  // 종류를 바꾸면 주소가 비었거나 다른 종류의 기본 주소일 때 새 기본 주소로 바꾸고, 모델은 비운다. 내 서버끼리 바꾸면 적은 주소를 그대로 둔다
  const changeChoice = (c: Choice) => {
    const type: ProviderType = c === 'own' ? 'auto' : c;
    const url = c === 'openai' ? OFFICIAL_OPENAI : c === 'own' ? (cloud || !p.baseUrl ? PROVIDER_INFO.auto.baseUrl : p.baseUrl) : c === 'assistant' && !cloud ? p.baseUrl : PROVIDER_INFO[type].baseUrl;
    setP({ type, baseUrl: url, model: '', lowSpecModel: '' });
    setModels([]);
    setDetected(null);
    setTest({ cls: '', text: '' });
  };

  return (
    <div id="tab-ai" className="tabPane">
      <div className="editHead">
        <button id="btnAiBack" type="button" className="backBtn" onClick={flow.tryBack}>
          ‹ 목록
        </button>
        {askDel ? (
          <span className="itemAsk">
            <button id="btnDelProfileYes" type="button" className="danger" onClick={onDelete}>
              삭제
            </button>
            <button type="button" onClick={() => setAskDel(false)}>
              취소
            </button>
          </span>
        ) : (
          <button id="btnDelProfile" type="button" onClick={() => setAskDel(true)}>
            삭제
          </button>
        )}
      </div>
      {askDel && (
        <p className="warn">
          "{p.name || id}"을(를) 삭제할까요? API 키도 같이 지워집니다.
          {users.length ? ` 이 AI를 쓰던 캐릭터(${users.map((c) => c.config.name || c.id).join(', ')})는 "선택 안 함"이 됩니다.` : ''} 바로 삭제됩니다.
        </p>
      )}
      <label>
        프로필 이름
        <input id="profName" type="text" value={p.name} onChange={(e) => setP({ name: e.target.value })} onBlur={() => !p.name.trim() && setP({ name: '새 AI' })} />
      </label>
      <label>
        서버 종류
        <select id="profType" value={choice} onChange={(e) => changeChoice(e.target.value as Choice)}>
          {choices.map((c) => (
            <option key={c} value={c}>
              {CHOICE_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      {cloud ? (
        <details id="advUrl">
          <summary>고급: 서버 주소 (프록시를 쓸 때만)</summary>
        <label>
          서버 주소
          <input
            id="profUrl"
            type="text"
            placeholder={info.urlPlaceholder}
            value={p.baseUrl}
            onChange={(e) => setP({ baseUrl: e.target.value.trim() })}
          />
        </label>
        </details>
      ) : (
      <label>
        서버 주소
        <input
          id="profUrl"
          type="text"
          placeholder={info.urlPlaceholder}
          value={p.baseUrl}
          onChange={(e) => setP({ baseUrl: e.target.value.trim() })}
        />
      </label>
      )}
      {p.type === 'auto' && (
        <p className="hint" id="urlHint">
          Ollama, LM Studio, Open WebUI는 주소(예: http://서버:3011)만 적으면 종류와 /v1, /api 경로를 알아서 찾습니다. Open WebUI는 워크스페이스 모델(문서 비서 등)도 모델 목록에 나옵니다. 이런 서버는 대화만 되고 파일 작업은 안 됩니다
          (파일 작업은 서버 종류 "내 서버"). 문서에 없는 질문은 모델이 일반 지식으로 답할 수 있습니다.
        </p>
      )}
      {p.type === 'assistant' && (
        <p className="hint" id="urlHint">
          내가 만든 서버처럼 앱 API 규약을 따르는 서버에 연결합니다. 자연스러운 문장의 파일 작업이 됩니다. 주소에 경로가 없으면 /v1로 연결하고, 입구가 다르면 https://서버주소/ai-agent처럼 입구까지 적습니다. 믿는 서버만 연결하세요.
        </p>
      )}
      <label>
        <span id="keyLabel">{info.keyLabel}</span>
        <div className="row">
          <input id="profKey" type={showKey ? 'text' : 'password'} autoComplete="off" value={p.apiKey} onChange={(e) => setP({ apiKey: e.target.value.trim() })} />
          <button id="btnShowKey" type="button" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '숨김' : '보기'}
          </button>
        </div>
      </label>
      <div className="row">
        <button id="btnTest" type="button" onClick={() => void testConnection()}>
          연결 테스트
        </button>
        <span id="testResult" className={test.cls}>
          {test.text}
        </span>
      </div>
      {direct && (
        <div id="ollamaFields">
          <label>
            모델
            <select id="profModel" value={p.model} onChange={(e) => setP({ model: e.target.value })}>
              {modelOptions(models, p.model, undefined, p.type === 'gemini').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            저사양 모델 (저사양 모드일 때, 비우면 위 모델)
            <select id="profLowModel" value={p.lowSpecModel} onChange={(e) => setP({ lowSpecModel: e.target.value })}>
              {modelOptions(models, p.lowSpecModel, '(위 모델과 같음)', p.type === 'gemini').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            시스템 프롬프트
            <textarea id="profPrompt" rows={3} value={p.systemPrompt} onChange={(e) => setP({ systemPrompt: e.target.value })} />
          </label>
          <label className="half">
            Temperature
            <input
              id="profTemp"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={p.temperature}
              onChange={(e) => setP({ temperature: Number.isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0.7 })}
            />
          </label>
        </div>
      )}
      <label className="half">
        타임아웃(초, 응답 조각 사이)
        <input id="profTimeout" type="number" min="5" max="600" value={p.timeoutSec} onChange={(e) => setP({ timeoutSec: parseInt(e.target.value, 10) || 60 })} />
      </label>
      {cloud && (
        <p className="hint" id="cloudHint">
          이 종류는 대화 내용이 해당 회사 서버로 전송됩니다.{' '}
          {choice === 'anthropic'
            ? '음성 인식은 설정 > 음성에서 따로 고릅니다 (Claude는 음성을 받지 않음).'
            : '음성 인식은 설정 > 음성에서 따로 고릅니다 (클라우드 단계를 켜면 이 키를 같이 쓸 수 있음).'}{' '}
          파일 명령은 앱 안에서 처리되어 그대로 쓸 수 있습니다.
        </p>
      )}
      <p className="hint" id="keyHint">
        {encrypted
          ? '토큰은 운영체제 보안 저장소(맥 키체인, 윈도우 DPAPI)로 암호화해서 저장합니다.'
          : '이 시스템에서는 암호화 저장을 쓸 수 없어 토큰을 설정 파일에 그대로 저장합니다.'}
      </p>
      <EditBar prefix="btnAiProfile" flow={flow} />
    </div>
  );
}
