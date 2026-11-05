// 설정창: AI(프로필 목록), 캐릭터(안에 프로필·순서·＋추가, 그 안에 기본·AI·목소리), 음성, TTS(서버 목록), 단축키, 파일 제어(관리·허용 경로·이름 찾기), 원격(디스코드·인증 앱), 기타 여덟 탭.
// 열 때 저장된 설정을 복사해 편집하고(draft), 저장을 눌러야 반영된다.
// 맨 아래 저장은 전체 저장(창은 안 닫음). AI 프로필·TTS 서버·캐릭터는 수정 화면의 저장으로 그 항목만 저장한다 (itemSave.ts).
import { useEffect, useRef, useState } from 'react';
import type { Character, RootEntry, RootError, Settings } from '@shared/types';
import type { SettingsActions, SettingsState } from './window-bridge';
import { AiTab } from './AiTab';
import { createSaveNotice, type SaveNotice } from '@shared/save-notice';
import { SaveToast } from './SaveToast';
import { mergeSettingsDraft } from '@shared/settings-draft';
import { CharacterTab } from './CharacterTab';
import { CharacterOrderTab } from './CharacterOrderTab';
import { ToolsTab } from './ToolsTab';
import { GeneralTab } from './GeneralTab';
import { VoiceTab } from './VoiceTab';
import { TtsSection } from './TtsSection';
import { ShortcutTab } from './ShortcutTab';
import { RemoteTab } from './RemoteTab';
import { charWakeName } from '@shared/char-prefs';
import { applyItem, removeItem, type ItemApi, type ItemKey } from './itemSave';

type TabId = 'ai' | 'character' | 'voice' | 'tts' | 'shortcut' | 'tools' | 'remote' | 'general';
const TABS: [TabId, string][] = [
  ['ai', 'AI'],
  ['character', '캐릭터'],
  ['voice', '음성'],
  ['tts', 'TTS'],
  ['shortcut', '단축키'],
  ['tools', '파일 제어'],
  ['remote', '원격'],
  ['general', '기타']
];

// 캐릭터 탭 안의 작은 탭: 프로필(고르기·수정), 순서, 오른쪽 끝에 추가
type CharSub = 'profile' | 'order' | 'add';
const CHAR_SUBS: [CharSub, string][] = [
  ['profile', '프로필'],
  ['order', '순서'],
  ['add', '＋ 추가']
];

interface Props {
  open: boolean;
  onClose: () => void;
  controller: SettingsActions;
  state: SettingsState;
  standalone?: boolean;
}

export interface Draft {
  settings: Settings;
  roots: RootEntry[];
}

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

export function SettingsModal({ open, onClose, controller, state, standalone = false }: Props) {
  const [tab, setTab] = useState<TabId>(new URLSearchParams(window.location.search).get('tab') === 'character' ? 'character' : 'ai');
  useEffect(() => window.app.win.onCommand(({ cmd, data }) => {
    if (cmd === 'settingsTab' && data === 'character') setTab('character');
  }), []);
  const [charSub, setCharSub] = useState<CharSub>('profile');
  const [draft, setDraft] = useState<Draft | null>(null);
  const baseline = useRef<Draft | null>(null);
  const ready = !!state.settings;
  const [characters, setCharacters] = useState<Character[]>([]);
  const [rootErrors, setRootErrors] = useState<RootError[]>([]);
  const [live2dHint, setLive2dHint] = useState('');
  const [saving, setSaving] = useState(false);
  const visible = useRef(open);
  visible.current = open;
  const [notice, setNotice] = useState<SaveNotice | null>(null);
  const feedback = useRef<ReturnType<typeof createSaveNotice> | null>(null);
  if (!feedback.current) feedback.current = createSaveNotice(setNotice);
  useEffect(() => () => feedback.current?.dispose(), []);
  useEffect(() => { if (!open) feedback.current?.clear(); }, [open]);

  // 열 때마다 저장된 설정으로 새로 시작한다
  useEffect(() => {
    if (!open || !state.settings) {
      setDraft(null);
      return;
    }
    const d: Draft = { settings: clone(state.settings), roots: clone(state.roots) };
    setDraft(d);
    baseline.current = clone(d);
    let alive = true;
    (async () => {
      const list = await controller.reloadCharacters();
      const st = await window.app.live2d.status();
      const v = await window.app.tools.validateRoots(d.roots);
      if (!alive) return;
      setCharacters(list);
      setLive2dHint(
        `기본 캐릭터 폴더(읽기 전용): ${state.info?.charactersDir || ''}\n내 캐릭터 폴더: ${state.info?.myCharactersDir || ''}\nLive2D Cubism Core: ${st.core ? '있음' : `없음 (vendor 폴더 또는 ${st.userDir} 에 live2dcubismcore.min.js를 넣으세요)`}`
      );
      setRootErrors(v.errors);
    })().catch((e) => controller.addMsg('err', (e as Error).message));
    return () => {
      alive = false;
    };
    // 열릴 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);

  // 설정창이 열린 채 단축키·트레이로 TTS를 켜고 끄면, 편집 중인 값도 맞춘다 (저장할 때 되돌아가지 않게)
  const liveTts = state.settings ? state.settings.voice.tts : null;
  useEffect(() => {
    if (liveTts === null) return;
    setDraft((d) => (d && d.settings.voice.tts !== liveTts ? { ...d, settings: { ...d.settings, voice: { ...d.settings.voice, tts: liveTts } } } : d));
  }, [liveTts]);
  // 트레이·바탕화면 캐릭터에서 항상 듣기(호출어)를 바꿔도 같이 맞춘다
  const liveWake = state.settings ? state.settings.voice.wake.enabled : null;
  useEffect(() => {
    if (liveWake === null) return;
    setDraft((d) =>
      d && d.settings.voice.wake.enabled !== liveWake ? { ...d, settings: { ...d.settings, voice: { ...d.settings.voice, wake: { ...d.settings.voice.wake, enabled: liveWake } } } } : d
    );
  }, [liveWake]);

  // 순서를 바꾸면(선택 바·순서 탭) 캐릭터 탭의 목록도 같은 순서로
  useEffect(() => {
    if (open) setCharacters(state.characters);
  }, [open, state.characters]);

  // 즉시 저장한 숨김은 오래 열린 편집 사본으로 되돌리지 않는다.
  useEffect(() => {
    if (!state.settings) return;
    const hiddenCharacters = state.settings.hiddenCharacters;
    setDraft((d) => d ? { ...d, settings: { ...d.settings, hiddenCharacters } } : d);
    if (baseline.current) baseline.current.settings.hiddenCharacters = hiddenCharacters;
  }, [state.settings?.hiddenCharacters]);

  const update = (fn: (s: Settings) => Settings) => setDraft((d) => (d ? { ...d, settings: fn(d.settings) } : d));
  const setRoots = (roots: RootEntry[], errors: RootError[] = []) => {
    setDraft((d) => (d ? { ...d, roots } : d));
    setRootErrors(errors);
  };

  // 전체 저장: 저장하고 설정창은 그대로 둔다 (저장된 값으로 다시 맞춘다)
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    let ok = false;
    try {
      const base = baseline.current || draft;
      const settings = mergeSettingsDraft(base.settings, draft.settings, state.settings!);
      const roots = mergeSettingsDraft(base.roots, draft.roots, state.roots);
      ok = await controller.saveSettings(settings, roots);
    } catch { controller.addMsg('err', '설정을 저장하지 못했습니다. 다른 창에서 같은 설정을 바꿨다면 설정창을 다시 열어 확인해 주세요.'); }
    visible.current && feedback.current?.show(ok);
    if (ok) {
      try {
        const r = await window.app.settings.load();
        baseline.current = { settings: clone(r.settings), roots: clone(r.roots) };
        setDraft(clone(baseline.current));
      } catch {
        /* 편집 중인 값을 그대로 둔다 */
      }
    }
    setSaving(false);
  };

  // 항목별 저장: 저장된 설정에 그 항목만 바꿔서 저장한다
  const saveItem = async (key: ItemKey, from?: Settings, options?: { silent?: boolean }): Promise<boolean> => {
    if (!draft || !state.settings) return false;
    const src = from || draft.settings;
    let ok = false;
    try { ok = await controller.saveSettings(applyItem(state.settings, src, key), state.roots); }
    catch { /* 저장 버튼을 다시 누를 수 있게 실패를 반환한다. */ }
    if (!options?.silent) visible.current && feedback.current?.show(ok);
    if (ok) {
      try {
        const r = await window.app.settings.load();
        if (baseline.current) baseline.current.settings = applyItem(baseline.current.settings, r.settings, key);
        setDraft((d) => (d ? { ...d, settings: applyItem(d.settings, r.settings, key) } : d)); // 저장하며 다듬어진 값으로
      } catch {
        /* 그대로 둔다 */
      }
    }
    return ok;
  };
  const removeItemNow = async (key: ItemKey): Promise<boolean> => {
    if (!draft || !state.settings) return false;
    update((x) => removeItem(x, key));
    return saveItem(key, removeItem(draft.settings, key), { silent: true });
  };
  const revertItem = (key: ItemKey) => {
    if (state.settings) update((x) => applyItem(x, state.settings as Settings, key));
  };
  const itemApi: ItemApi | null = state.settings ? { saved: state.settings, save: saveItem, remove: removeItemNow, revert: revertItem } : null;

  const s = draft?.settings;

  return (
    <div id="settingsModal" className={`${open ? 'modal' : 'modal hidden'}${standalone ? ' settingsStandalone' : ''}`}>
      {draft && s && (
        <div className="modalBody">
          <div className="modalHead">
            <h2>설정</h2>
            {open && <SaveToast notice={notice} />}
            <button id="btnCloseSettings" title="닫기" onClick={onClose}>
              ✕
            </button>
          </div>

          <nav className="tabs">
            {TABS.map(([id, label]) => (
              <button key={id} className={tab === id ? 'tab active' : 'tab'} data-tab={id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>

          {tab === 'ai' && itemApi && <AiTab settings={s} update={update} encrypted={!!state.info?.encrypted} characters={characters} api={itemApi} />}

          {tab === 'character' && (
            <nav className="subtabs" role="tablist">
              {CHAR_SUBS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={charSub === id}
                  className={`subtab${charSub === id ? ' active' : ''}${id === 'add' ? ' subAdd' : ''}`}
                  data-sub={id}
                  onClick={() => setCharSub(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}

          {tab === 'character' && charSub !== 'order' && itemApi && (
            <CharacterTab
              part={charSub === 'add' ? 'add' : 'edit'}
              characters={characters}
              locked={state.settings?.lockedCharacters ?? []}
              hidden={state.settings?.hiddenCharacters ?? []}
              onHidden={(id, on) => controller.setCharacterHidden(id, on)}
              onLock={(id, on) => void controller.setCharacterLocked(id, on)}
              selected={s.character}
              onSelect={(id) => update((x) => ({ ...x, character: id }))}
              onReload={async () => setCharacters(await controller.reloadCharacters())}
              onChanged={async () => setCharacters(await controller.afterCharacterChange())}
              onDeleted={(n) => update((x) => ({ ...x, character: n.character, prevCharacter: n.prevCharacter }))}
              onClearHistory={() => void controller.clearHistory(s.character || controller.characterId())}
              live2dHint={live2dHint}
              settings={s}
              update={update}
              onGoAi={() => setTab('ai')}
              api={itemApi}
              onSaveResult={(ok) => visible.current && feedback.current?.show(ok)}
            />
          )}

          {tab === 'character' && charSub === 'order' && <CharacterOrderTab characters={state.characters} onOrder={(o) => void controller.setCharacterOrder(o)} />}

          {tab === 'voice' && (
            <VoiceTab
              settings={s}
              update={update}
              health={state.health}
              localStt={state.localStt}
              onLocalChanged={() => void controller.refreshLocalStt()}
              learnedNoise={controller.learnedNoiseDb()}
              learnedWakeNoise={controller.learnedWakeNoiseDb()}
              characterName={charWakeName(s, s.character, controller.characterName(s.character))}
            />
          )}

          {tab === 'tts' && itemApi && <TtsSection settings={s} update={update} characters={characters} api={itemApi} />}

          {tab === 'shortcut' && <ShortcutTab settings={s} update={update} info={state.info} />}

          {tab === 'tools' && <ToolsTab roots={draft.roots} errors={rootErrors} setRoots={setRoots} onError={(m) => controller.addMsg('err', m)} settings={s} update={update} />}

          {tab === 'remote' && <RemoteTab savedSettings={state.settings || s} characters={characters} settings={s} update={update} item={itemApi} onError={(m) => controller.addMsg('err', m)} />}

          {tab === 'general' && <GeneralTab settings={s} update={update} info={state.info} />}

          <div className="modalFoot">
            <button id="btnSaveSettings" className="primary" disabled={saving} onClick={() => void save()}>
              저장
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
