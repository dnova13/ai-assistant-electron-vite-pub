// 설정 > 캐릭터 > 프로필 / ＋ 추가 (part로 두 작은 탭이 같은 부품을 나눠 쓴다): 고르기, 고른 캐릭터 수정·삭제, 캐릭터 추가(그림 파일·Live2D 폴더), 폴더 열기, 대화 기록 지우기, Live2D 준비 상태.
// 수정·추가 칸은 안에서 기본(이름·성격·그림) / AI / 목소리 탭으로 나뉜다. 수정 칸의 `저장`은 이름·성격과 이 캐릭터의 AI·목소리를 한 번에 저장한다 (설정 전체는 저장하지 않음).
import { useEffect, useState } from 'react';
import type { Character, CharacterVoice, Settings } from '@shared/types';
import { charVoice, charWakeName, defaultCharVoice, wakeConflicts } from '@shared/char-prefs';
import { characterFileUrl } from '../../lib/character';
import { CharAiPicker, CharVoiceEditor } from './CharPrefsFields';
import { applyItem } from './itemSave';
import type { ItemApi } from './itemSave';

interface Props {
  /** edit = 캐릭터 고르기·수정·삭제, add = 캐릭터 추가 (설정의 두 탭이 같은 부품을 나눠 쓴다) */
  part: 'edit' | 'add';
  characters: Character[];
  /** 삭제 잠금이 걸린 캐릭터 id (잠금은 바로 저장됨) */
  locked: string[];
  hidden: string[];
  onHidden: (id: string, on: boolean) => Promise<void>;
  onLock: (id: string, on: boolean) => void;
  selected: string;
  onSelect: (id: string) => void;
  onReload: () => Promise<void>;
  /** 캐릭터를 고치거나 지운 뒤 (설정·목록을 다시 읽음) */
  onChanged: () => Promise<void>;
  /** 지운 뒤 편집 중인 설정의 캐릭터를 맞춘다 */
  onDeleted: (next: { character: string; prevCharacter: string }) => void;
  onClearHistory: () => void;
  live2dHint: string;
  /** 편집 중인 설정 (캐릭터별 AI·목소리) */
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  /** 설정 > AI 탭으로 가기 */
  onGoAi: () => void;
  /** 항목별 저장 */
  api: ItemApi;
  onSaveResult: (ok: boolean) => void;
}

type InnerTab = 'basic' | 'ai' | 'voice';
const INNER: [InnerTab, string][] = [
  ['basic', '기본'],
  ['ai', 'AI'],
  ['voice', '목소리']
];

/** 수정·추가 칸 안의 작은 탭: 기본 / AI / 목소리 */
function InnerTabs({ value, onChange, idPrefix }: { value: InnerTab; onChange: (t: InnerTab) => void; idPrefix: string }) {
  return (
    <nav className="subtabs innerTabs" role="tablist">
      {INNER.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={`subtab${value === id ? ' active' : ''}`} data-inner={id} id={`${idPrefix}-${id}`} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

/** 캐릭터의 AI 고르기 ('' = 선택 안 함) */
const setAi = (s: Settings, cid: string, pid: string): Settings => {
  const characterAi = { ...s.characterAi };
  if (pid) characterAi[cid] = pid;
  else delete characterAi[cid];
  return { ...s, characterAi };
};

const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** 삭제 잠금 아이콘: 잠김 = 빨간 동그라미에 흰 자물쇠, 풀림 = 회색 동그라미에 열린 자물쇠 */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg className="lockSvg" viewBox="0 0 28 28" width="20" height="20" aria-hidden="true">
      <defs>
        <linearGradient id={locked ? 'lkOn' : 'lkOff'} x1="0" y1="0" x2="0" y2="1">
          {locked ? (
            <>
              <stop offset="0" stopColor="#ef6a62" />
              <stop offset="1" stopColor="#b3231b" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor="#5b6190" />
              <stop offset="1" stopColor="#3a3f66" />
            </>
          )}
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="12.5" fill={`url(#${locked ? 'lkOn' : 'lkOff'})`} stroke={locked ? '#f3b9b4' : '#8a90bd'} strokeWidth="1.5" />
      <rect x="8.5" y="13" width="11" height="8" rx="1.8" fill="#fff" />
      <path d={locked ? 'M10.8 13v-2.6a3.2 3.2 0 0 1 6.4 0V13' : 'M10.8 13v-2.6a3.2 3.2 0 0 1 6.2-1.1'} fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="14" cy="16.6" r="1.2" fill={locked ? '#b3231b' : '#3a3f66'} />
    </svg>
  );
}

export function CharacterTab({ part, characters, locked, hidden, onHidden, onLock, selected, onSelect, onReload, onChanged, onDeleted, onClearHistory, live2dHint, settings, update, onGoAi, api, onSaveResult }: Props) {
  const cur = characters.find((c) => c.id === selected) || null;
  const [eTab, setETab] = useState<InnerTab>('basic');
  const [aTab, setATab] = useState<InnerTab>('basic');
  const [addAi, setAddAi] = useState('');
  const [addVoice, setAddVoice] = useState<CharacterVoice>(defaultCharVoice());
  const nameOf = (c: Character) => String(c.config.name || c.id);
  /** 이 호출어와 같은 다른 캐릭터 이름들 */
  const conflictsFor = (wake: string, exceptId: string) =>
    wakeConflicts(
      wake,
      settings,
      characters.filter((c) => c.id !== exceptId).map((c) => ({ id: c.id, name: nameOf(c) }))
    );
  const [eName, setEName] = useState('');
  const [ePersona, setEPersona] = useState('');
  const [eRes, setERes] = useState({ cls: '', text: '' });
  const [eBusy, setEBusy] = useState(false);
  /** ✕를 누른 캐릭터 (그 줄에서 삭제/취소를 묻는 중) */
  const [askDel, setAskDel] = useState<string | null>(null);
  const [delRes, setDelRes] = useState({ cls: '', text: '' });
  const [delBusy, setDelBusy] = useState(false);
  // 고른 캐릭터(또는 그 이름·성격)가 바뀌면 수정 칸을 그 값으로
  useEffect(() => {
    setEName(cur ? String(cur.config.name || cur.id) : '');
    setEPersona(cur ? String(cur.config.persona || '') : '');
  }, [selected, cur && cur.config.name, cur && cur.config.persona]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 캐릭터를 고르면 수정 결과 문구를 닫는다 (같은 캐릭터를 고친 뒤에는 남김)
  useEffect(() => {
    setERes({ cls: '', text: '' });
  }, [selected]);

  const run = async (fn: () => Promise<string | null>) => {
    setEBusy(true);
    try {
      const msg = await fn();
      if (msg !== null) {
        await onChanged();
        setERes({ cls: 'ok', text: msg });
      }
    } catch (e) {
      setERes({ cls: 'fail', text: errText(e) });
    } finally {
      setEBusy(false);
    }
  };
  // 저장: 이름·성격(캐릭터 폴더) + 이 캐릭터의 AI·목소리(설정)를 한 번에. 다른 설정은 저장하지 않는다
  const saveInfo = async () => {
    if (!cur) return;
    setEBusy(true);
    setERes({ cls: '', text: '' });
    try {
      if (!eName.trim()) throw new Error('캐릭터 이름을 적어 주세요.');
      if ((eName.trim() !== String(cur.config.name || '') || ePersona.trim() !== String(cur.config.persona || ''))) {
        await window.app.characters.update(cur.id, { name: eName.trim(), persona: ePersona.trim() });
      }
      const ok = await api.save({ kind: 'char', id: cur.id }, undefined, { silent: true });
      onSaveResult(ok);
      if (ok) await onChanged();
    } catch (e) {
      setERes({ cls: 'fail', text: errText(e) });
      onSaveResult(false);
    } finally {
      setEBusy(false);
    }
  };
  const reset = () => run(async () => {
    if (!cur?.builtin) return null;
    await window.app.characters.reset(cur.id);
    const saved = await window.app.settings.load();
    update((s) => applyItem(s, saved.settings, { kind: 'char', id: cur.id }));
    // 초기화 IPC가 해당 캐릭터만 저장했다. 오래된 설정창 값으로 전체 설정을 다시 저장하지 않는다.
    onSaveResult(true);
    return '기본 비서를 초기 설정으로 되돌렸습니다.';
  });
  const changeImage = () =>
    run(async () => {
      if (!cur) return null;
      const r = await window.app.characters.replaceImage(cur.id);
      return r ? '그림을 바꿨습니다.' : null;
    });
  // 목록의 ✕ → 그 줄에서 "삭제"를 한 번 더 누르면 지운다 (되돌릴 수 없음)
  const remove = async (c: Character) => {
    const nm = String(c.config.name || c.id);
    setDelBusy(true);
    try {
      const next = await window.app.characters.remove(c.id);
      onDeleted(next);
      await onChanged();
      setDelRes({ cls: 'ok', text: `"${nm}"을(를) 삭제했습니다.` });
    } catch (e) {
      setDelRes({ cls: 'fail', text: errText(e) });
    } finally {
      setAskDel(null);
      setDelBusy(false);
    }
  };
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [kind, setKind] = useState<'image' | 'live2d'>('image');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState({ cls: '', text: '' });

  const add = async () => {
    if (!name.trim()) return setRes({ cls: 'fail', text: '캐릭터 이름을 적어 주세요.' });
    setBusy(true);
    setRes({ cls: '', text: kind === 'live2d' ? '폴더를 고르세요… (복사하는 데 조금 걸릴 수 있음)' : '그림 파일을 고르세요…' });
    try {
      const r = await window.app.characters.add({ kind, name: name.trim(), persona: persona.trim() });
      if (!r) return setRes({ cls: '', text: '' });
      await onReload();
      onSelect(r.id);
      // 추가할 때 고른 AI·목소리를 새 캐릭터에 바로 저장
      const put = (s: Settings): Settings => ({ ...setAi(s, r.id, addAi), characterVoice: { ...s.characterVoice, [r.id]: addVoice } });
      update(put);
      const saved = await api.save({ kind: 'char', id: r.id }, put(settings));
      setAddAi('');
      setAddVoice(defaultCharVoice());
      setATab('basic');
      setName('');
      setPersona('');
      setRes({ cls: saved ? 'ok' : 'fail', text: `"${r.name}"을(를) 추가했습니다${saved ? ' (AI·목소리도 저장됨)' : '. AI·목소리는 저장하지 못했습니다'}. 이 캐릭터로 바꾸려면 아래 "저장"을 누르세요.${kind === 'live2d' ? ' 표정·모션은 캐릭터 폴더의 config.json에서 맞춥니다.' : ''}` });
    } catch (e) {
      setRes({ cls: 'fail', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={part === 'add' ? 'tab-charadd' : 'tab-character'} className="tabPane">
      {part === 'edit' && (
        <>
          <div id="characterList">
            {!characters.length && <p className="hint">캐릭터가 없습니다. 캐릭터 폴더에 폴더를 추가하세요.</p>}
            {characters.map((c) => {
              const icon = c.config.icon || c.config.image;
              return (
                <div key={c.id} className={selected === c.id ? 'charItem selected' : 'charItem'} data-char={c.id} onClick={() => onSelect(c.id)}>
                  <img src={icon ? characterFileUrl(c.id, icon) : undefined} alt="" />
                  <div className="charText">
                    <div className="nm">
                      {c.config.name || c.id}
                      <span className="tag">{c.config.type === 'live2d' ? 'Live2D' : '이미지'}</span>
                    </div>
                    <div className="ds">{c.config.persona || ''}</div>
                  </div>
                  <button type="button" className={`charVisibility${hidden.includes(c.id) ? ' on' : ''}`} title={hidden.includes(c.id) ? '챗에 표시하기' : '챗에서 안 보이기'} aria-label={`${nameOf(c)} ${hidden.includes(c.id) ? '챗에 표시하기' : '챗에서 안 보이기'}`} aria-pressed={hidden.includes(c.id)} onClick={(e) => {
                    e.stopPropagation();
                    void onHidden(c.id, !hidden.includes(c.id)).catch((err) => setERes({ cls: 'fail', text: errText(err) }));
                  }}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{hidden.includes(c.id) && <path d="m3 3 18 18"/>}</svg>
                  </button>
                  {!c.builtin && (
                    <button
                      type="button"
                      className={locked.includes(c.id) ? 'charLock on' : 'charLock'}
                      title={locked.includes(c.id) ? '잠겨 있음 (누르면 풀기)' : '삭제 잠금 걸기'}
                      aria-label={`${c.config.name || c.id} 삭제 잠금 ${locked.includes(c.id) ? '풀기' : '걸기'}`}
                      aria-pressed={locked.includes(c.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (askDel === c.id) setAskDel(null);
                        onLock(c.id, !locked.includes(c.id));
                      }}
                    >
                      <LockIcon locked={locked.includes(c.id)} />
                    </button>
                  )}
                  {!c.builtin &&
                    !locked.includes(c.id) &&
                    (askDel === c.id ? (
                      <span className="charDelAsk" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="danger charDelYes" disabled={delBusy} onClick={() => void remove(c)}>
                          삭제
                        </button>
                        <button type="button" className="charDelNo" onClick={() => setAskDel(null)}>
                          취소
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="charDel"
                        title={`${c.config.name || c.id} 삭제`}
                        aria-label={`${c.config.name || c.id} 삭제`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDelRes({ cls: '', text: '' });
                          setAskDel(c.id);
                        }}
                      >
                        ✕
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
          {askDel && <p className="warn" id="charDeleteWarn">삭제하면 캐릭터 폴더를 지웁니다. 되돌릴 수 없습니다 (대화 기록은 남음).</p>}
          {delRes.text && (
            <p id="charDeleteResult" className={delRes.cls === 'fail' ? 'warn' : 'hint'}>
              {delRes.text}
            </p>
          )}
          {cur && (
            <div className="sttBox" id="charEditBox">
              <div className="charEditHead"><b>고른 캐릭터 수정</b>{cur.builtin && <button id="btnCharReset" type="button" disabled={eBusy} onClick={() => void reset()}>초기화</button>}</div>
              <InnerTabs value={eTab} onChange={setETab} idPrefix="charEditTab" />
              {eTab === 'ai' && (
                <>
                  <CharAiPicker profiles={settings.profiles} value={settings.characterAi[cur.id] || ''} onChange={(pid) => update((s) => setAi(s, cur.id, pid))} onGoAi={onGoAi} />
                  <p className="hint">AI·목소리는 이 칸의 "저장"을 누르면 적용됩니다.</p>
                </>
              )}
              {eTab === 'voice' && (
                <>
                  <CharVoiceEditor
                    value={charVoice(settings, cur.id)}
                    onChange={(v) => update((s) => ({ ...s, characterVoice: { ...s.characterVoice, [cur.id]: v } }))}
                    servers={settings.ttsServers}
                    configVoice={(cur.config.voice && cur.config.voice.voice) || ''}
                    charName={nameOf(cur)}
                    wakeConflicts={conflictsFor(charWakeName(settings, cur.id, nameOf(cur)), cur.id)}
                  />
                  <p className="hint">AI·목소리는 이 칸의 "저장"을 누르면 적용됩니다.</p>
                </>
              )}
              {eTab === 'basic' && (
              <>
              <label>
                이름
                <input id="charEditName" type="text" maxLength={30} value={eName} onChange={(e) => setEName(e.target.value)} />
              </label>
              <label>
                성격·말투
                <textarea id="charEditPersona" rows={2} maxLength={500} value={ePersona} onChange={(e) => setEPersona(e.target.value)} />
              </label>
              <div className="row wrap">
                {cur.config.type !== 'live2d' && (
                  <button id="btnCharEditImage" type="button" disabled={eBusy} onClick={() => void changeImage()}>
                    그림 바꾸기
                  </button>
                )}
                <button id="btnCharEditFolder" type="button" onClick={() => window.app.characters.openOne(cur.id).catch((e) => setERes({ cls: 'fail', text: errText(e) }))}>
                  이 캐릭터 폴더 열기
                </button>
              </div>
              <p className="hint">
                {cur.builtin ? '기본 비서는 수정·숨김이 가능하며 삭제할 수 없습니다. 제목 오른쪽 초기화로 이름·성격·그림·AI·목소리를 최초 설정으로 되돌립니다. ' : '삭제는 목록의 ✕ (빨간 자물쇠로 잠그면 ✕가 사라져 실수로 못 지움). 지금 쓰는 캐릭터를 삭제하면 직전에 쓰던 캐릭터(없으면 기본 캐릭터)로 돌아갑니다. '}
                {cur.builtin ? '' : cur.config.type === 'live2d' ? 'Live2D 표정·모션은 캐릭터 폴더의 config.json에서 맞춥니다. ' : '그림을 바꾸면 이전 그림은 지웁니다. '}
                {'그림 바꾸기는 바로 적용되고, 이름·성격은 이 칸의 "저장"으로 적용됩니다.'}
              </p>
              </>
              )}
              <div className="row wrap" id="charEditFoot">
                <button id="btnCharEditSave" type="button" className="primary" disabled={eBusy} onClick={() => void saveInfo()}>
                  저장
                </button>
                <span id="charEditResult" className={eRes.cls}>
                  {eRes.text}
                </span>
              </div>
            </div>
          )}
          <div className="row">
            <button id="btnReloadChars" type="button" onClick={() => void onReload()}>
              목록 새로고침
            </button>
          </div>
          <div className="row">
            <button id="btnClearHistory" type="button" onClick={onClearHistory}>
              선택한 캐릭터 대화 기록 지우기
            </button>
          </div>
          <p className="hint">
            대화 기록은 캐릭터마다 따로 저장됩니다. 지운 기록은 삭제하지 않고 기록 폴더의 _to_delete로 옮깁니다. 비서 서버의 대화 기억은 채팅으로 '초기화'를 보내 지웁니다.
          </p>
        </>
      )}
      {part === 'add' && (
        <>
          <div className="sttBox" id="charAddBox">
            <b>캐릭터 추가</b>
            <InnerTabs value={aTab} onChange={setATab} idPrefix="charAddTab" />
            {aTab === 'ai' && <CharAiPicker profiles={settings.profiles} value={addAi} onChange={setAddAi} onGoAi={onGoAi} />}
            {aTab === 'voice' && (
              <CharVoiceEditor value={addVoice} onChange={setAddVoice} servers={settings.ttsServers} configVoice="" charName={name.trim()} wakeConflicts={conflictsFor(addVoice.wakeName || name.trim(), '')} />
            )}
            {aTab === 'basic' && (
            <>
            <label>
              이름
              <input id="charAddName" type="text" maxLength={30} placeholder="예: 하나" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              성격·말투 (비워도 됨)
              <textarea id="charAddPersona" rows={2} maxLength={500} placeholder="예: 밝고 친근한 비서. 존댓말로 짧게 답한다." value={persona} onChange={(e) => setPersona(e.target.value)} />
            </label>
            <div className="row">
              <label className="check">
                <input id="charAddImage" type="radio" name="charAddKind" checked={kind === 'image'} onChange={() => setKind('image')} /> 그림 (png, jpg, webp, gif, svg)
              </label>
              <label className="check">
                <input id="charAddLive2d" type="radio" name="charAddKind" checked={kind === 'live2d'} onChange={() => setKind('live2d')} /> Live2D (모델 폴더)
              </label>
            </div>
            </>
            )}
            <div className="row wrap">
              <button id="btnCharAdd" type="button" disabled={busy} onClick={() => void add()}>
                {kind === 'live2d' ? '모델 폴더 고르고 추가' : '그림 고르고 추가'}
              </button>
              <span id="charAddResult" className={res.cls}>
                {res.text}
              </span>
            </div>
            <p className="hint">
              기본·AI·목소리 탭을 오가며 정한 뒤 위 버튼 하나로 만듭니다 (AI·목소리도 같이 저장됩니다). 고른 파일은 내 캐릭터 폴더(my-characters)에 복사됩니다 (원본은 그대로). Live2D는 Cubism 4 모델(.model3.json이 든 폴더)만 됩니다.
            </p>
          </div>
          <div className="row">
            <button id="btnOpenChars" type="button" onClick={() => window.app.characters.openFolder().catch(() => {})}>
              내 캐릭터 폴더 열기
            </button>
          </div>
          <p className="hint" id="live2dHint">
            {live2dHint}
          </p>
        </>
      )}
    </div>
  );
}
