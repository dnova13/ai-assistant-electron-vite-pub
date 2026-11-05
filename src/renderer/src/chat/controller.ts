import type { HistoryMessage } from '@shared/types';
import { selectedCharacter, visibleCharacters } from '@shared/character-order';
// 대화 창의 "두뇌": 대화, 목소리 재생, 녹음, 파일 작업, 확인 창.
// React와 떨어진 일반 클래스다. 화면(React)은 상태(ChatState)를 구독해서 그리고, 버튼을 누르면 여기 함수를 부른다.
// 마스코트 창은 여기서 보내는 상태(입 모양·말풍선·녹음 표시)를 받아 그리기만 한다.
import { parseTime } from '@shared/chat-time';
import type {
  ActionArgs,
  ActionReport,
  AppApi,
  AppInfo,
  Character,
  ChatEvent,
  ChoiceOption,
  Health,
  PrepareResult,
  RemoteEvent,
  RootEntry,
  SearchItem,
  Settings,
  StageState,
  ToolSource,
  LocalSttStatus
} from '@shared/types';
import { sttReadiness } from '@shared/stt';
import { charProfile, charProfileId, charTtsOut, charWakeName, findWakeCharacter, withCharacter } from '@shared/char-prefs';
import { ttsActive, ttsServerReady } from '@shared/voice';
import { BuiltinSpeaker, LipSync, Recorder, TtsQueue, toWav, type MicLevel } from '../lib/voice';
import { looksLikeNoise, shouldSkipTranscribe, type VadEvent, type VadOptions } from '../lib/vad';
import { playEndChime, playStartChime } from '../lib/sounds';
import { WakeListener } from '../lib/wake';
import { WAKE_ACK_TEXT, wakeBlocked, wakeModelNote } from '@shared/wake';
import type { CharacterStage } from '../lib/character';
import { ACTION_NAMES, LOCAL_HELP, isSupportedAction, normalizeFileText, parseLocalCommand } from '../lib/commands';
import { RECEIVED_EXEC_WARNING, formatBytes, resultHead, rootsToSave } from '@shared/local-files';

const GREETING = "안녕하세요! 무엇을 도와드릴까요?\n파일 작업은 '파일 찾기 이름'처럼 입력하세요.";
const SHOW_HISTORY = 60; // 캐릭터를 바꿀 때 다시 보여 줄 대화 수
const DEFAULT_PLACEHOLDER = "메시지 또는 '파일 찾기 이름'";
const ECHO_GAP_MS = 350; // 읽기가 끝난 뒤 다시 듣기 전 잠깐 쉰다 (스피커 소리 끝이 마이크에 들어가지 않게)

/* ---------------- 상태 모양 ---------------- */

export type MsgRole = 'user' | 'bot' | 'sys' | 'err';
export type ListenKind = 'manual' | 'followup';

export interface Msg {
  historyId?: string;
  id: number;
  role: MsgRole;
  text: string;
  /** 파일 찾기 결과 (열기·위치 버튼과 함께 보여 준다) */
  results?: SearchItem[];
  /** 답을 기다리는 중 (점 애니메이션과 경과 시간을 보여 준다) */
  pending?: boolean;
  /** 보낸·받은 시각 (밀리초). 말풍선 아래 시각과 날짜 구분선에 쓴다. 없으면 시각 표시를 생략 */
  time?: number;
  /** 메신저에서 온 것 (예: 디스코드). 말풍선 위에 작게 표시 */
  source?: string;
  /** 메신저로 받은 파일: 다운로드 → 열기 / 폴더 열기 (실행 파일은 폴더 열기만) */
  received?: ReceivedFile;
  /** 캐릭터 말풍선의 종류: 'error'면 빨간 말풍선 (파일 작업이 안 될 때 등) */
  tone?: 'error';
}

export interface ReceivedFile {
  fileId: string;
  name: string;
  size: number;
  executable: boolean;
  state: 'ready' | 'downloading' | 'done' | 'failed';
  /** 저장한 경로 (done) */
  path?: string;
  /** 결과·오류 문구 */
  message?: string;
}

export type DialogValue = string | boolean | null;

export type DialogLine = { kind: 'kv'; label: string; value: string; mono?: boolean } | { kind: 'note'; text: string; cls: 'hint' | 'warn' | 'msgline' };

export interface DialogButton {
  label: string;
  value: DialogValue;
  kind?: 'primary' | 'danger';
}

export interface Dialog {
  title: string;
  lines: DialogLine[];
  /** 후보 목록 (누르면 그 경로가 값이 된다) */
  choices?: ChoiceOption[];
  buttons: DialogButton[];
  /** 처음 초점을 둘 버튼 값. 생략하면 취소 버튼을 우선한다. */
  initialValue?: DialogValue;
  /** 남은 시간(초). 0이 되면 'expired' */
  seconds?: number;
}

export interface Status {
  kind: 'on' | 'off' | 'wait';
  text: string;
  title: string;
}

export interface ChatState {
  info: AppInfo | null;
  settings: Settings | null;
  roots: RootEntry[];
  characters: Character[];
  health: Health | null;
  messages: Msg[];
  status: Status;
  busy: boolean;
  recording: boolean;
  /** 듣는 중일 때: manual = 단축키·마이크 버튼, followup = 답 뒤에 이어서 듣기 */
  listenKind: ListenKind | null;
  speaking: boolean;
  transcribing: boolean;
  input: string;
  inputKind: 'text' | 'voice';
  placeholder: string;
  dialog: Dialog | null;
  /** 값이 바뀌면 입력창에 초점을 준다 */
  focusTick: number;
  /** 앱 안 위스퍼 상태 (받은 모델, 받는 중) */
  localStt: LocalSttStatus | null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code) : '');

/* ---------------- 컨트롤러 ---------------- */

export class ChatController {
  private A: AppApi;
  private state: ChatState;
  private listeners = new Set<() => void>();
  /** 듣는 중 소리 크기 표시 (초당 20번이라 React 상태로 돌리지 않는다) */
  private levelSubs = new Set<(l: MicLevel | null) => void>();
  /** 듣는 동안 고쳐 나간 주변 소음. base: 그때의 설정값 (설정에서 다시 재면 버린다) */
  private learnedNoise: { db: number; base: number | null } | null = null;
  /** 호출어 대기용으로 듣는 동안 고쳐 둔 주변 소음 (음성 대화 것과 따로) */
  private learnedWakeNoise: { db: number; base: number | null } | null = null;
  /** 항상 듣기(호출어): 대기 중에만 켜진다 */
  private wake: WakeListener | null = null;
  private wakeHandling = false;
  private wakeFailed = '';
  private wakeNoticed = '';
  /** 고른 호출어 모델이 없어 다른 모델로 듣는다는 안내 (같은 안내는 한 번만) */
  private wakeModelNoticed = '';
  private wakeSyncQueued = false;
  /** 켜 둔 호출어 듣기의 설정 (바뀌면 다시 켠다) */
  private wakeKey = '';
  /** 호출어 듣기를 켤 때의 설정 소음 값 (고쳐 둔 소음을 기억할 때 쓴다) */
  private wakeBase: number | null = null;
  private stage: CharacterStage | null = null;
  private shownCharacter: string | null = null; // 화면에 보이는 대화 기록의 캐릭터
  private currentReq: string | null = null;
  private nextId = 1;
  private lastMouth = 0;
  private chain: Promise<unknown> = Promise.resolve(); // 확인 창은 한 번에 하나
  private dialogResolve: ((v: DialogValue) => void) | null = null;
  private lip: LipSync;
  private builtin: BuiltinSpeaker;
  private tts: TtsQueue;
  private recorder: Recorder;
  private unsubscribe: (() => void) | null = null;
  /** 사용자가 무언가 하면(말하기·Esc·멈추기·글 보내기) 올라간다. 기다리던 "이어서 듣기"는 이 값이 바뀌면 취소된다 */
  private convGen = 0;
  private fallbackNoticed = false;

  constructor(appApi: AppApi = window.app) {
    this.A = appApi;
    this.state = {
      info: null,
      settings: null,
      roots: [],
      characters: [],
      health: null,
      messages: [],
      status: { kind: 'off', text: '미연결', title: '' },
      busy: false,
      recording: false,
      listenKind: null,
      speaking: false,
      transcribing: false,
      input: '',
      inputKind: 'text',
      placeholder: DEFAULT_PLACEHOLDER,
      dialog: null,
      focusTick: 0,
      localStt: null
    };
    this.lip = new LipSync((v) => this.setMouth(v));
    this.builtin = new BuiltinSpeaker((v) => this.setMouth(v));
    this.tts = new TtsQueue({
      synth: (text) => this.A.api.tts(text, this.voiceName()),
      builtin: this.builtin,
      lip: this.lip,
      onSpeaking: (on) => {
        this.set({ speaking: on });
        this.setStageState(on ? 'talking' : this.state.busy ? 'thinking' : 'idle');
      },
      onError: (e) => {
        this.tts.stop();
        this.addMsg('err', `목소리를 만들지 못했습니다: ${e.message}`);
      },
      onFallback: (e) => {
        if (this.fallbackNoticed) return;
        this.fallbackNoticed = true; // 서버가 꺼져 있으면 답마다 나오지 않게 한 번만
        this.addMsg('sys', `TTS 서버 목소리를 만들지 못해 이 컴퓨터 목소리로 읽어요. (${e.message})`);
      }
    });
    this.recorder = new Recorder({ onAutoStop: () => void this.finishRecording() });
  }

  /* ----- React 연결 (useSyncExternalStore) ----- */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): ChatState => this.state;

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
    this.queueWakeSync();
  }

  /* ----- 도우미 ----- */

  get settings(): Settings {
    if (!this.state.settings) throw new Error('설정을 아직 읽지 못했습니다.');
    return this.state.settings;
  }

  character(): Character | null {
    const { characters, settings } = this.state;
    return settings ? selectedCharacter(characters, settings.character, settings.hiddenCharacters) : null;
  }

  characterId(): string {
    const c = this.character();
    return c ? c.id : '';
  }

  /** 지금 캐릭터 기준 설정 (AI = 캐릭터가 고른 프로필, 목소리 = 캐릭터 목소리) */
  private view(): Settings {
    return withCharacter(this.settings, this.characterId());
  }

  /** 지금 캐릭터의 음량 0~1 (답 읽기·알림음) */
  private charVolume(): number {
    return this.state.settings ? charTtsOut(this.state.settings, this.characterId()).volume / 100 : 1;
  }

  /** 지금 캐릭터가 대화할 수 없는 이유 (AI를 고르지 않음 / 프로필이 하나도 없음). 되면 '' */
  noAiReason(): string {
    const s = this.state.settings;
    if (!s) return '';
    if (!this.character()) return '대화할 캐릭터를 설정에서 표시하거나 선택해 주세요.';
    if (!Object.keys(s.profiles).length) return 'AI 프로필이 없습니다. 설정 > AI에서 추가해 주세요.';
    if (!charProfile(s, this.characterId())) return '이 캐릭터가 쓸 AI가 선택되지 않았습니다. 설정 > 캐릭터 > 프로필 > AI에서 골라 주세요.';
    return '';
  }

  private voiceName(): string {
    const c = this.character();
    return (c && c.config.voice && c.config.voice.voice) || 'default';
  }

  /** 설정 창의 미리 듣기용: 고른 캐릭터의 목소리 이름 */
  characterVoice(id: string): string {
    const c = this.state.characters.find((x) => x.id === id);
    return (c && c.config.voice && c.config.voice.voice) || 'default';
  }

  /** 음성 인식 설정으로 지금 🎤를 쓸 수 있는지 (대화 AI와 따로 판단) */
  sttReadiness(): ReturnType<typeof sttReadiness> {
    const s = this.state.settings;
    if (!s) return { ready: false, sources: [] };
    return sttReadiness(withCharacter(s, this.characterId()), this.state.health, this.state.localStt ? this.state.localStt.downloaded : []);
  }

  canRecord(): boolean {
    return !!this.character() && this.sttReadiness().ready && !this.state.busy;
  }

  async refreshLocalStt(): Promise<void> {
    try {
      this.set({ localStt: await this.A.stt.localStatus() });
    } catch {
      /* 엔진을 못 쓰는 환경 */
    }
  }

  onLabel(): string {
    return this.state.settings && this.state.settings.lowSpec ? '연결됨 · 저사양' : '연결됨';
  }

  /** 답 읽기 상태 (상태 표시 풍선말) */
  ttsLabel(): string {
    const s = this.state.settings;
    if (!s || !s.voice.tts) return '꺼짐';
    const t = charTtsOut(s, this.characterId());
    if (!this.tts.enabled) return t.source === 'builtin' ? '이 컴퓨터 목소리를 찾지 못함' : 'TTS 서버 없음';
    if (this.tts.mode === 'server') return `TTS 서버${this.tts.fallback ? ' (안 되면 이 컴퓨터 목소리)' : ''}`;
    return t.source === 'server' ? '이 컴퓨터 목소리 (TTS 서버가 없어서)' : '이 컴퓨터 목소리';
  }

  statusTitle(): string {
    const h = this.state.health;
    const s = this.state.settings;
    if (!h || !s) return '';
    const f = h.features;
    return [
      `AI: ${charProfile(s, this.characterId())?.name || '선택 안 함'}`,
      h.model ? `모델: ${h.model}` : '',
      `음성 인식: ${this.sttReadiness().ready ? '있음' : '없음'} (설정 > 음성)`,
      `목소리 읽기: ${this.ttsLabel()}`,
      s.lowSpec ? `저사양 모드${f.lowSpec ? '' : ' (서버가 아직 지원하지 않음)'}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  private setStatus(kind: Status['kind'], text: string, title = ''): void {
    this.set({ status: { kind, text, title } });
  }

  /* ----- 메시지 ----- */

  addMsg(role: MsgRole, text: string, extra: Partial<Msg> = {}): number {
    const id = this.nextId++;
    this.set({ messages: [...this.state.messages, { id, role, text, time: Date.now(), ...extra }] });
    return id;
  }

  /** 파일 작업 결과·거절처럼 캐릭터가 알려 주는 말: 그림과 이름이 붙은 캐릭터 말풍선으로. error면 빨간 말풍선 */
  private saveMessage(message: Msg, characterId: string, memory = false): Promise<unknown> {
    if (!characterId || !message.text.trim()) return Promise.resolve();
    return this.A.history.append(characterId, [{ id: message.historyId, role: message.role, text: message.text,
      time: new Date(message.time || Date.now()).toISOString(), source: message.source, tone: message.tone, results: message.results, memory }])
      .catch(() => this.addMsg('err', '대화 기록을 저장하지 못했습니다.'));
  }

  private say(text: string, extra: Partial<Msg> = {}, error = false, characterId = this.characterId()): number {
    const message: Msg = { id: this.nextId++, role: 'bot', text, time: Date.now(), ...extra, ...(error ? { tone: 'error' as const } : {}) };
    const alreadySaved = !!message.historyId;
    message.historyId ||= `local-${Date.now()}-${message.id}-${Math.random().toString(36).slice(2)}`;
    if (characterId === this.characterId()) this.set({ messages: [...this.state.messages, message] });
    if (!alreadySaved) void this.saveMessage(message, characterId);
    return message.id;
  }

  private updateMsg(id: number, text: string): void {
    // 답을 기다리던 말풍선이 처음 채워질 때 시각을 그때로 바꾼다 (보낸 때가 아니라 답이 온 때)
    this.set({ messages: this.state.messages.map((m) => (m.id === id ? { ...m, text, pending: false, time: m.pending ? Date.now() : m.time } : m)) });
  }

  private removeMsg(id: number): void {
    this.set({ messages: this.state.messages.filter((m) => m.id !== id) });
  }

  setInput(value: string): void {
    this.set({ input: value, inputKind: value ? this.state.inputKind : 'text' });
  }

  /* ----- 캐릭터·마스코트 ----- */

  attachStage(stage: CharacterStage | null): void {
    this.stage = stage;
  }

  // 마스코트 창으로 보내는 상태. 입 모양은 많이 바뀔 때만 보낸다 (초당 60번 다 보내지 않게)
  private setMouth(v: number): void {
    this.stage?.setMouth(v);
    if (Math.abs(v - this.lastMouth) > 0.03 || (v === 0 && this.lastMouth !== 0)) {
      this.lastMouth = v;
      this.A.mascot.relay({ type: 'mouth', v: Math.round(v * 100) / 100 });
    }
  }

  private setStageState(state: StageState): void {
    this.stage?.setState(state);
    this.A.mascot.relay({ type: 'state', state });
  }

  private bubble(text: string, final = false): void {
    this.A.mascot.relay({ type: 'bubble', text, final });
  }

  // 캐릭터를 그리고, 캐릭터가 바뀌었으면 그 캐릭터와의 대화 기록을 다시 보여 준다
  async applyCharacter({ force = false }: { force?: boolean } = {}): Promise<void> {
    const c = this.character();
    // 기록을 먼저 그린다 (캐릭터를 그리다 생긴 안내 문구가 기록을 다시 그릴 때 지워지지 않게)
    const id = this.characterId();
    if (force || id !== this.shownCharacter) {
      this.shownCharacter = id;
      await this.renderHistory();
    }
    await this.stage?.show(c, { lowSpec: this.settings.lowSpec });
    this.A.mascot.relay({ type: 'character' });
  }

  private async renderHistory(): Promise<void> {
    this.set({ messages: [] });
    if (!this.character()) return;
    const characterId = this.shownCharacter;
    let list: HistoryMessage[] = [];
    try {
      list = await this.A.history.load(this.shownCharacter || '');
    } catch (e) {
      this.addMsg('err', `대화 기록을 읽지 못했습니다: ${errMsg(e)}`);
    }
    if (characterId !== this.shownCharacter || characterId !== this.characterId()) return;
    const shown = list.slice(-SHOW_HISTORY);
    const msgs: Msg[] = [];
    if (list.length > shown.length) msgs.push({ id: this.nextId++, role: 'sys', text: `이전 대화 ${list.length - shown.length}개는 생략했습니다.`, time: parseTime(shown[0]?.time) });
    for (const m of shown) msgs.push({ id: this.nextId++, historyId: m.id, role: m.role, text: m.text, time: parseTime(m.time), source: m.source, tone: m.tone, results: m.results });
    // 지난 대화가 있으면 인사말을 덧붙이지 않는다 (캐릭터를 바꿀 때마다 같은 말이 생기던 것을 없앰). 대화가 비어 있을 때만 첫 인사
    const ids = new Set(msgs.map(m => m.historyId).filter(Boolean));
    const live = this.state.messages.filter(m => !m.historyId || !ids.has(m.historyId));
    if (!shown.length && !live.length) msgs.push({ id: this.nextId++, role: 'bot', text: GREETING, time: Date.now() });
    this.set({ messages: [...msgs, ...live].sort((a, b) => (a.time || 0) - (b.time || 0)) });
  }

  /** 캐릭터 그리기 중 생긴 안내 (Live2D 실패 등) */
  stageNotice = (msg: string): void => {
    this.addMsg('sys', msg);
  };

  /** 설정·서버 상태로 답 읽기를 정한다: 이 컴퓨터 목소리 / TTS 서버(안 되면 이 컴퓨터) */
  private applyVoiceFlags(): void {
    const s = this.state.settings;
    if (!s) {
      this.tts.enabled = false;
      return;
    }
    // 캐릭터마다 목소리·배속·음량이 다르다
    const v = withCharacter(s, this.characterId());
    const t = v.voice.ttsOut;
    this.builtin.voice = t.builtin.voice;
    this.builtin.rate = t.builtin.rate;
    this.builtin.volume = t.volume / 100;
    this.tts.volume = t.volume / 100;
    this.tts.rate = t.builtin.rate;
    this.tts.enabled = ttsActive(v, this.state.health, this.builtin.available());
    this.tts.mode = t.source === 'server' && ttsServerReady(v, this.state.health) ? 'server' : 'builtin';
    this.tts.fallback = t.fallbackBuiltin;
  }

  /* ---------------- 시작 ---------------- */

  async init(): Promise<void> {
    // 트레이·전역 단축키·마스코트에서 오는 명령
    const offCmd = this.A.win.onCommand(({ cmd, data }) => {
      if (cmd === 'ptt') void this.toggleMic();
      else if (cmd === 'settingsChanged') void this.reloadSettings();
      else if (cmd === 'ttsToggled') void this.onTtsToggled(!!(data && (data as { on?: boolean }).on));
    });
    // 앱 안 위스퍼 모델 받기 진행률
    const offStt = this.A.stt.onLocalProgress((p) => {
      const cur = this.state.localStt;
      if (cur) this.set({ localStt: { ...cur, downloading: p.done ? null : { model: p.model, progress: p.progress } } });
      if (p.done) void this.refreshLocalStt();
    });
    // 이 컴퓨터 목소리 목록은 늦게 채워진다
    const offVoices = this.builtin.onVoicesChanged(() => {
      this.applyVoiceFlags();
      if (this.state.health) this.setStatus(this.state.status.kind, this.state.status.text, this.statusTitle());
    });
    // 메신저(디스코드)에서 온 대화·기록·받은 파일
    const offRemote = this.A.remote ? this.A.remote.onEvent((ev) => this.onRemote(ev)) : () => {};
    this.unsubscribe = () => {
      offCmd();
      offStt();
      offVoices();
      offRemote();
    };
    try {
      const info = await this.A.info();
      const s = await this.A.settings.load();
      const characters = await this.A.characters.list();
      this.set({ info, settings: s.settings, roots: s.roots, characters });
      await this.applyCharacter({ force: true });
      await this.refreshLocalStt();
      await this.refreshConnection();
    } catch (e) {
      this.addMsg('err', `시작하지 못했습니다: ${errMsg(e)}`);
    }
  }

  dispose(): void {
    this.stopWake();
    if (this.unsubscribe) this.unsubscribe();
    this.convGen++;
    this.tts.stop();
    if (this.recorder.active) void this.recorder.stop(true);
  }

  async refreshConnection(): Promise<void> {
    const no = this.noAiReason();
    if (no) {
      // 캐릭터가 AI를 고르지 않았으면 서버에 묻지 않는다
      this.set({ health: null });
      this.applyVoiceFlags();
      this.setStatus('off', 'AI 없음', no);
      return;
    }
    this.setStatus('wait', '확인 중');
    try {
      const health = await this.A.api.health();
      this.set({ health });
      this.applyVoiceFlags();
      this.setStatus('on', this.onLabel(), this.statusTitle());
      if (health.warning) this.addMsg('sys', health.warning);
    } catch (e) {
      this.set({ health: null });
      this.applyVoiceFlags();
      this.setStatus('off', '미연결', errMsg(e));
    }
  }

  /* ---------------- 대화 ---------------- */

  private setBusy(on: boolean): void {
    this.set({ busy: on });
    this.setStageState(on ? 'thinking' : this.tts.playing ? 'talking' : 'idle');
  }

  /** 입력창의 글을 보낸다 */
  submit(): void {
    const kind = this.state.inputKind;
    void this.send(this.state.input, kind);
  }

  async send(raw: string, input: 'text' | 'voice' = 'text', remote?: { reqId: string; source: string; characterId?: string }): Promise<string | void> {
    const text = (raw || '').trim();
    if (!text || this.state.busy || (!remote && !this.character())) return '';
    if (!remote && text === '/clear') {
      this.convGen++;
      this.stopAll();
      this.set({ input: '', inputKind: 'text' });
      await this.clearHistory(this.characterId());
      return '';
    }
    const reqId = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const charId = remote?.characterId || this.characterId();
    let userMessageId: number;
    if (remote) userMessageId = this.addMsg('user', text, { source: remote.source, historyId: reqId + ':user' });
    else {
      if (input === 'text') this.convGen++; // 글로 보내면 기다리던 이어서 듣기를 취소
      this.set({ input: '', inputKind: 'text' });
      userMessageId = this.addMsg('user', text, { historyId: reqId + ':user' });
    }

    // 파일 명령은 서버로 보내지 않고 이 컴퓨터에서 처리 (메신저의 파일 명령은 메인이 이미 처리했다)
    const local = remote ? null : parseLocalCommand(text);
    const userMessage = this.state.messages.find(m => m.id === userMessageId)!;
    if (!local) this.setBusy(true); // 기록 IPC를 기다리는 동안 중복 전송하지 않는다.
    await this.saveMessage(userMessage, charId, !local);
    if (local) {
      if ('help' in local) {
        this.say(LOCAL_HELP, {}, false, charId);
        return '';
      }
      await this.runAction({ action: local.action, args: local.args, source: { kind: 'local' } }, charId);
      return '';
    }

    const no = this.noAiReason();
    if (no) {
      this.setBusy(false);
      this.addMsg('err', no);
      return no;
    }
    const c = this.state.characters.find(c => c.id === charId) || null;
    this.tts.stop();
    this.setBusy(true);
    const msgId = this.addMsg('bot', '', { pending: true, historyId: reqId + ':bot', source: remote?.source });
    let got = '';
    this.currentReq = reqId;
    const pendingWork: Promise<unknown>[] = [];
    let clientActionReceived = false;
    let answered = false;
    const onEvent = (ev: ChatEvent) => {
      switch (ev.type) {
        case 'delta':
          got += ev.text;
          this.updateMsg(msgId, got);
          this.tts.feed(ev.text);
          this.bubble(got, false);
          break;
        case 'client_action':
          clientActionReceived = true;
          pendingWork.push(this.handleServerAction(ev, remote, charId));
          break;
        case 'confirm':
          void this.A.win.showChat(); // 확인 창은 대화 창에 뜬다
          pendingWork.push(
            this.serverConfirm(ev).then((t) => {
              if (t) this.A.history.append(charId, [{ role: 'bot', text: t }]).catch(() => {});
            })
          );
          break;
        case 'done':
          if (!got && ev.text) {
            got = ev.text;
            this.updateMsg(msgId, got);
            this.tts.feed(got);
          }
          this.tts.flush();
          if (got) this.bubble(got, true);
          break;
        case 'error':
          this.addMsg('err', ev.message);
          if (!got) got = ev.message;
          break;
      }
    };
    try {
      // 대화 기록 저장과 Ollama 직접 모드의 대화 기억은 메인 프로세스가 캐릭터별로 처리한다
      await this.A.api.chat(reqId, { text: normalizeFileText(text), input, character: charId, source: remote?.source, time: userMessage.time, persona: c ? c.config.persona || '' : '' }, onEvent);
      answered = !!got;
      if (!got) this.removeMsg(msgId);
      this.setStatus('on', this.onLabel(), this.statusTitle());
    } catch (e) {
      if (!got) this.removeMsg(msgId);
      if (!got) got = errMsg(e);
      // 화면으로 넘어온 오류는 code가 사라질 수 있어서 문구로도 확인한다
      if (errCode(e) === 'aborted' || /중단했습니다/.test(errMsg(e))) this.addMsg('sys', '멈췄습니다.');
      else {
        this.addMsg('err', errMsg(e));
        this.bubble(errMsg(e), true);
        this.setStatus('off', '연결 실패', errMsg(e));
      }
    } finally {
      this.currentReq = null;
      this.setBusy(false);
      if (!document.hidden) this.set({ focusTick: this.state.focusTick + 1 });
    }
    await Promise.allSettled(pendingWork);
    // 말로 물어서 답을 받았으면, 답(읽기)이 끝난 뒤 이어서 듣는다
    if (answered && input === 'voice' && !remote) void this.followUp();
    // 원격 허브가 확인·취소·실행 결과를 이미 보냈다. AI의 실행 전 안내는 다시 보내지 않는다.
    return remote && clientActionReceived ? undefined : got;
  }

  /* ---------------- 메신저 (디스코드) ---------------- */

  /** 메신저 대화는 한 번에 하나씩, 앱이 다른 대화를 하는 중이면 끝날 때까지 기다린다 */
  private remoteChain: Promise<unknown> = Promise.resolve();

  private onRemote(ev: RemoteEvent): void {
    if ((ev.type === 'line' || ev.type === 'received') && ev.characterId && ev.characterId !== this.characterId()) return;
    if (ev.historyId && this.state.messages.some(m => m.historyId === ev.historyId)) return;
    if (ev.type === 'line') {
      this.addMsg(ev.role, ev.text, { source: ev.source, historyId: ev.historyId, time: ev.time ? parseTime(ev.time) : Date.now() });
    } else if (ev.type === 'received') {
      this.say(`파일 받음: ${ev.name} (${formatBytes(ev.size)})`, {
        source: ev.source, historyId: ev.historyId, time: ev.time ? parseTime(ev.time) : Date.now(),
        received: { fileId: ev.fileId, name: ev.name, size: ev.size, executable: ev.executable, state: 'ready' }
      });
    } else if (ev.type === 'chat') {
      const run = async () => {
        while (this.state.busy) await new Promise((r) => setTimeout(r, 300));
        let answer: string | void = '';
        try {
          if (ev.characterId && ev.characterId !== this.characterId()) await this.selectCharacter(ev.characterId);
          answer = await this.send(ev.text, 'text', { reqId: ev.reqId, source: ev.source, characterId: ev.characterId });
        } catch (e) {
          answer = `답하지 못했습니다: ${errMsg(e)}`;
        }
        this.A.remote.reply(ev.reqId, answer);
      };
      this.remoteChain = this.remoteChain.then(run, run);
    }
  }

  /** 받은 파일의 다운로드 버튼: 받은 파일 폴더에 저장 */
  async downloadReceived(msgId: number): Promise<void> {
    const m = this.state.messages.find((x) => x.id === msgId);
    if (!m || !m.received || m.received.state === 'downloading') return;
    const patch = (r: Partial<ReceivedFile>) =>
      this.set({ messages: this.state.messages.map((x) => (x.id === msgId && x.received ? { ...x, received: { ...x.received, ...r } } : x)) });
    patch({ state: 'downloading', message: '' });
    try {
      const r = await this.A.remote.download(m.received.fileId);
      patch(r.ok ? { state: 'done', path: r.path, message: r.executable ? RECEIVED_EXEC_WARNING : r.message } : { state: 'failed', message: r.message });
    } catch (e) {
      patch({ state: 'failed', message: errMsg(e) });
    }
  }

  // 서버가 요청한 파일 작업: 앱이 검사·확인·실행하고 결과를 서버에 알린다
  private async handleServerAction(ev: Extract<ChatEvent, { type: 'client_action' }>, remote?: { reqId: string; source: string; characterId?: string }, characterId = this.characterId()): Promise<void> {
    let result: ActionReport;
    if (remote) {
      // 메신저 대화 중이면 메신저 규칙(인증·메신저로 확인)으로 메인이 처리한다
      try {
        result = await this.A.remote.runAction(remote.reqId, ev.action, ev.args);
      } catch (e) {
        result = { status: 'failed', detail: errMsg(e) };
      }
    } else if (!isSupportedAction(ev.action)) {
      this.say(`서버가 지원하지 않는 작업을 요청했습니다: ${ev.action}`, {}, true, characterId);
      result = { status: 'failed', detail: `지원하지 않는 작업: ${ev.action}` };
    } else {
      if (ev.action !== 'file.open' && ev.action !== 'file.reveal') void this.A.win.showChat(); // 확인 창·결과는 대화 창에
      result = await this.runAction({ action: ev.action, args: ev.args, source: { kind: 'server', id: ev.id } }, characterId);
    }
    try {
      await this.A.api.report(ev.id, result);
    } catch (e) {
      console.warn('결과 보고 실패', e);
    }
  }

  stopAll(): void {
    this.convGen++;
    if (this.currentReq) void this.A.api.abort(this.currentReq);
    this.tts.stop();
  }

  /* ---------------- 확인 창 ---------------- */

  // 확인 창은 한 번에 하나: 순서대로 처리
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private ask(dialog: Dialog): Promise<DialogValue> {
    return new Promise((resolve) => {
      this.dialogResolve = resolve;
      this.set({ dialog });
    });
  }

  /** 확인 창의 버튼·후보·Esc·시간 초과 */
  resolveDialog = (value: DialogValue): void => {
    const r = this.dialogResolve;
    this.dialogResolve = null;
    this.set({ dialog: null });
    if (r) r(value);
  };

  /* ---------------- 파일 작업 ---------------- */

  /** 찾기 결과의 열기·위치 버튼 */
  openResult(path: string, action: 'file.open' | 'file.reveal'): void {
    void this.runAction({ action, args: { target: path }, source: { kind: 'local' } });
  }

  runAction(req: { action: string; args?: ActionArgs; source: ToolSource }, characterId = this.characterId()): Promise<ActionReport> {
    return this.enqueue(async () => {
      try {
        return await this.runActionSteps(req, characterId);
      } catch (e) {
        console.error(e);
        if (this.dialogResolve) this.resolveDialog(null);
        this.say(`파일 작업 중 오류: ${errMsg(e)}`, {}, true, characterId);
        return { status: 'failed', detail: errMsg(e) };
      }
    });
  }

  private async runActionSteps(req: { action: string; args?: ActionArgs; source: ToolSource }, characterId: string): Promise<ActionReport> {
    const say = (text: string, extra: Partial<Msg> = {}, error = false) => this.say(text, extra, error, characterId);
    const tools = this.A.tools;
    let args: ActionArgs = { ...(req.args || {}) };
    for (let step = 0; step < 4; step++) {
      const res = await tools.prepare({ action: req.action, args, source: req.source });
      if (res.status === 'error') {
        say(res.message, {}, true);
        return { status: 'failed', detail: res.message };
      }
      if (res.status === 'result') {
        say(resultHead(res), {
          results: res.items
        });
        return { status: 'done', detail: resultHead(res) };
      }
      if (res.status === 'choice') {
        const picked = await this.ask({
          title: '어느 것인가요?',
          lines: [{ kind: 'note', text: res.message, cls: 'msgline' }],
          choices: res.options,
          buttons: [{ label: '취소', value: null }]
        });
        if (typeof picked !== 'string' || picked === 'expired') {
          say('취소했습니다.');
          return { status: 'rejected', detail: '사용자가 취소했습니다.' };
        }
        args = { ...args, [res.field]: picked };
        continue;
      }
      // ready: 확인 질문을 차례로 (삭제는 "삭제하겠습니까?" → "정말로 삭제하겠습니까?"). 메신저와 같은 문구
      const t0 = Date.now();
      for (let qi = 0; qi < res.summary.questions.length; qi++) {
        const left = res.expiresInMs - (Date.now() - t0);
        const d = await this.ask(this.planDialog(res, req.source.kind, qi, left));
        if (d !== 'approve') {
          await tools.cancel(res.id);
          const expired = d === 'expired';
          say(expired ? '시간이 지나 취소했습니다.' : '취소했습니다.');
          return { status: expired ? 'expired' : 'rejected', detail: expired ? '확인 시간이 지났습니다.' : '사용자가 취소했습니다.' };
        }
      }
      const out = await tools.execute(res.id);
      say(out.message, {}, !out.ok);
      return { status: out.ok ? 'done' : out.status === 'expired' ? 'expired' : 'failed', detail: out.message };
    }
    return { status: 'failed', detail: '처리하지 못했습니다.' };
  }

  private planDialog(res: Extract<PrepareResult, { status: 'ready' }>, sourceKind: ToolSource['kind'], qi = 0, leftMs = res.expiresInMs): Dialog {
    const s = res.summary;
    const name = ACTION_NAMES[s.action] || s.action;
    const lines: DialogLine[] = [
      { kind: 'kv', label: '작업', value: name },
      { kind: 'kv', label: '대상', value: s.from },
      { kind: 'kv', label: '', value: s.fromPath, mono: true }
    ];
    if (s.to) lines.push({ kind: 'kv', label: '위치', value: s.to }, { kind: 'kv', label: '', value: s.toPath || '', mono: true });
    for (const w of s.warnings) lines.push({ kind: 'note', text: w, cls: 'warn' });
    if (sourceKind === 'server') lines.push({ kind: 'note', text: 'AI 서버가 요청한 작업입니다. 경로가 맞는지 확인하세요.', cls: 'hint' });
    if (s.action === 'file.delete') lines.push({ kind: 'note', text: '진짜로 지우지 않고 _to_delete 폴더로 옮깁니다.', cls: 'hint' });
    // 파일 작업은 예/아니오 순서다. 삭제의 두 질문만 아니오에서 시작한다.
    const buttons: DialogButton[] = [
      { label: '예', value: 'approve', kind: s.action === 'file.delete' ? 'danger' : 'primary' },
      { label: '아니오', value: null }
    ];
    const question = s.questions[qi] || `${name}하겠습니까?`;
    return { title: question, lines, buttons, initialValue: s.action === 'file.delete' ? null : 'approve', seconds: Math.max(1, Math.floor(leftMs / 1000) - 2) };
  }

  // 서버 쪽 위험 작업(서비스 재시작 등) 승인
  private serverConfirm(ev: Extract<ChatEvent, { type: 'confirm' }>): Promise<string> {
    return this.enqueue(async () => {
      const d = await this.ask({
        title: '서버 작업 확인',
        lines: [
          { kind: 'note', text: ev.message, cls: 'msgline' },
          { kind: 'note', text: '서버에서 실행되는 작업입니다.', cls: 'hint' }
        ],
        buttons: [
          { label: '예', value: true, kind: 'primary' },
          { label: '아니오', value: false }
        ],
        initialValue: true,
        seconds: Math.max(5, ev.expiresIn - 2)
      });
      try {
        const r = await this.A.api.confirm(ev.id, d === true);
        if (r.text) this.addMsg('bot', r.text);
        return r.text || '';
      } catch (e) {
        this.addMsg('err', errMsg(e));
        return '';
      }
    });
  }

  /* ---------------- 음성 입력 (마이크 버튼, 전역 단축키, 마스코트, 이어서 듣기) ---------------- */

  /** 이어서 대화는 "말이 멈추면 자동으로 끝내기"와 "바로 보내기"가 켜져 있어야 손 안 대고 이어진다 */
  followUpReady(): boolean {
    const v = this.state.settings && this.state.settings.voice;
    return !!v && v.followUp.enabled && v.vad.autoStop && v.autoSend;
  }

  async toggleMic(): Promise<void> {
    this.convGen++;
    if (this.recorder.active) return this.finishRecording();
    // 답을 받으면서 읽는 중이면 끊고 바로 듣는다 (끼어들기)
    if (this.state.busy && this.tts.playing) {
      this.stopAll();
      await this.waitFor(() => !this.state.busy, 3000);
    }
    if (!this.canRecord()) {
      const why = this.state.busy ? '답변하는 중이에요. 끝나면 다시 눌러 주세요.' : '쓸 수 있는 음성 인식이 없습니다 (설정 > 음성에서 내 서버·클라우드·이 컴퓨터 중 하나를 켜세요).';
      this.bubble(why, true);
      if (!this.state.busy) {
        void this.A.win.showChat();
        this.addMsg('sys', why);
      }
      return;
    }
    await this.startListening('manual');
  }

  private waitFor(cond: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => (cond() || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 50));
      tick();
    });
  }

  /** 듣는 중 소리 크기 받기 (대화 창의 막대). null이면 듣기 끝 */
  onMicLevel(cb: (l: MicLevel | null) => void): () => void {
    this.levelSubs.add(cb);
    return () => this.levelSubs.delete(cb);
  }

  private emitLevel(l: MicLevel | null): void {
    for (const cb of this.levelSubs) cb(l);
  }

  /** 설정 화면에 보여 줄: 지난번 듣는 동안 맞춰진 주변 소음 (음성 대화) */
  learnedNoiseDb(): number | null {
    return this.learnedNoise ? this.learnedNoise.db : null;
  }

  /** 설정 화면에 보여 줄: 지난번 호출어 대기 중 맞춰진 주변 소음 */
  learnedWakeNoiseDb(): number | null {
    return this.learnedWakeNoise ? this.learnedWakeNoise.db : null;
  }

  /** 주변 소음 시작값(음성 대화): 지난번 듣는 동안 고쳐 둔 값 → 설정에서 잰 값 → 없음(듣기 시작할 때 잠깐 잼) */
  noiseStart(): number | null {
    const set = this.settings.voice.vad.noiseDb;
    if (this.learnedNoise && this.learnedNoise.base === set) return this.learnedNoise.db;
    return set;
  }

  /** 주변 소음 시작값(호출어 대기): 호출어 설정의 값을 같은 방식으로 쓴다. 음성 대화 값과는 따로 */
  wakeNoiseStart(): number | null {
    const set = this.settings.voice.wake.noiseDb;
    if (this.learnedWakeNoise && this.learnedWakeNoise.base === set) return this.learnedWakeNoise.db;
    return set;
  }

  /** 듣기가 끝날 때 고쳐 둔 주변 소음을 기억한다 (앱을 끄면 사라지고, 다음엔 설정값부터) */
  private rememberNoise(): void {
    const n = this.recorder.noise;
    if (n !== null && Number.isFinite(n)) this.learnedNoise = { db: Math.round(n * 10) / 10, base: this.settings.voice.vad.noiseDb };
    this.emitLevel(null);
  }

  private vadOptions(kind: ListenKind): VadOptions | null {
    const v = this.settings.voice;
    if (!v.vad.autoStop) return null; // 누르고 말하기: 다시 누르거나 Esc, 60초
    const waitSec = kind === 'followup' ? v.followUp.waitSec : v.vad.noSpeechSec;
    return { noiseDb: this.noiseStart(), marginDb: v.vad.marginDb, silenceMs: v.vad.silenceSec * 1000, noSpeechMs: waitSec * 1000 };
  }

  private async startListening(kind: ListenKind): Promise<void> {
    try {
      this.tts.stop();
      await this.recorder.start({ vad: this.vadOptions(kind), onVad: (e) => this.onVad(e, kind), onLevel: (l) => this.emitLevel(l) });
      this.set({ recording: true, listenKind: kind, placeholder: kind === 'followup' ? '이어서 말씀하세요… (조용하면 끝나요)' : '듣는 중…' });
      this.A.media.recording(true);
      if (kind === 'followup') this.bubble('이어서 말씀하세요…', false);
    } catch (e) {
      this.set({ recording: false, listenKind: null });
      void this.A.win.showChat();
      this.addMsg('err', errMsg(e));
    }
  }

  private onVad(e: VadEvent, kind: ListenKind): void {
    if (e === 'silence') void this.finishRecording();
    else if (e === 'nospeech') void this.endWithoutSpeech(kind);
  }

  /** 말소리가 없어서 끝낸다. 이어서 듣기면 조용히(알림음) 끝내고 원래 대기로 돌아간다 */
  private async endWithoutSpeech(kind: ListenKind): Promise<void> {
    if (!this.recorder.active) return;
    this.rememberNoise();
    await this.recorder.stop(true);
    this.set({ recording: false, listenKind: null, placeholder: DEFAULT_PLACEHOLDER });
    this.A.media.recording(false);
    if (kind === 'followup') this.endFollowUp();
    else {
      this.bubble('말소리가 없어서 취소했어요.', true);
      this.addMsg('sys', '말소리가 없어서 취소했어요. 다시 말해 주세요.');
    }
  }

  private endFollowUp(): void {
    this.bubble('', false);
    if (this.settings.voice.followUp.endChime) playEndChime(this.charVolume());
  }

  /** 답(과 읽기)이 끝나면 다시 듣는다. 그 사이 사용자가 무언가 하면 취소된다 */
  private async followUp(): Promise<void> {
    if (!this.followUpReady()) return;
    const g = ++this.convGen;
    await this.tts.whenIdle();
    await new Promise((r) => setTimeout(r, ECHO_GAP_MS));
    if (g !== this.convGen || this.state.busy || this.state.transcribing || this.state.dialog || this.recorder.active || !this.canRecord()) return;
    await this.startListening('followup');
  }

  async finishRecording(cancel = false): Promise<void> {
    if (!this.recorder.active && !this.state.recording) return;
    if (cancel) this.convGen++;
    const kind = this.state.listenKind;
    // 멈추기 전에 본다: 말을 거의 안 했으면 받아 적지 않고 그냥 닫는다 (위스퍼가 지어낸 글이 전송되는 것을 막음)
    const sp = this.recorder.spoken;
    const minMs = Math.round(this.settings.voice.vad.minSpokenSec * 1000);
    const silent = !cancel && shouldSkipTranscribe(this.recorder.vadOn, sp ? sp.ms : 0, minMs);
    if (sp && !cancel) {
      const f = (n: number | null) => (n === null ? '-' : Math.round(n));
      console.info(`[음성] 듣기 끝(${kind || '-'}): 말소리 ${Math.round(sp.ms)}ms (기준 ${minMs}ms) · 가장 큰 소리 ${f(sp.peak)} · 소음 ${f(sp.noise)} · 말소리선 ${f(sp.line)} dB → ${silent ? '보내지 않음' : '받아 적음'}`);
    }
    this.rememberNoise();
    const blob = await this.recorder.stop(cancel);
    this.set({ recording: false, listenKind: null, placeholder: DEFAULT_PLACEHOLDER });
    this.A.media.recording(false);
    if (!blob) {
      this.bubble('', false);
      return;
    }
    if (silent) {
      if (kind === 'followup') this.endFollowUp();
      else this.bubble('', false);
      return;
    }
    if (blob.size < 1000) {
      if (kind === 'followup') return this.endFollowUp();
      this.bubble('너무 짧게 녹음됐어요.', true);
      this.addMsg('sys', '너무 짧게 녹음됐어요. 다시 말해 주세요.');
      return;
    }
    this.set({ transcribing: true, placeholder: '알아듣는 중…' });
    this.bubble('알아듣는 중…', false);
    try {
      // 16kHz 모노 wav로 바꿔 보낸다 (Gemini·앱 안 위스퍼가 webm을 못 받고, 크기도 일정하다)
      const audio = await toWav(blob);
      const r = await this.A.api.stt(new Uint8Array(await audio.arrayBuffer()), audio.type);
      // 클라우드로 넘어갔거나 앞 순서가 실패했으면 알려 준다 (음성이 밖으로 나갔는지 알 수 있게)
      if (r.failures.length || r.source === 'cloud') {
        const why = r.failures.map((f) => `${f.label}: ${f.message}`).join(' / ');
        this.addMsg('sys', `${r.label}에서 인식했어요.${why ? ` (앞 순서 실패 — ${why})` : ''}`);
      }
      // 이어서 듣기에서 기침·문소리 같은 잡음만 들어왔으면 말이 없던 것으로 본다
      if (kind === 'followup' && (!r.text || looksLikeNoise(r.text))) return this.endFollowUp();
      if (!r.text) {
        this.bubble('알아듣지 못했어요.', true);
        this.addMsg('sys', '알아듣지 못했어요. 다시 말해 주세요.');
        return;
      }
      if (this.settings.voice.autoSend) void this.send(r.text, 'voice');
      else {
        // 바로 보내지 않으면 사용자가 확인할 수 있게 대화 창을 띄운다
        this.bubble(`"${r.text}" — 대화 창에서 확인 후 보내세요.`, true);
        void this.A.win.showChat();
        this.set({ input: r.text, inputKind: 'voice', focusTick: this.state.focusTick + 1 });
      }
    } catch (e) {
      this.bubble(errMsg(e), true);
      this.addMsg('err', errMsg(e));
    } finally {
      this.set({ transcribing: false, placeholder: DEFAULT_PLACEHOLDER });
    }
  }

  /* ---------------- 항상 듣기 (호출어) ---------------- */

  /** 캐릭터 이름 (호출어를 비워 두면 이 이름) */
  characterName(id?: string): string {
    const c = id ? this.state.characters.find((x) => x.id === id) || null : this.character();
    return c ? String(c.config.name || c.id) : '';
  }

  /** 지금 호출어를 쓸 수 없는 이유 (설정·모델 기준). 쓸 수 있으면 null */
  wakeBlockedReason(): string | null {
    const s = this.state.settings;
    if (!s) return null;
    if (!this.character()) return '대화할 캐릭터가 없습니다.';
    // 호출어는 캐릭터마다: 지금 캐릭터의 호출어(비었으면 이름)로 판단
    return wakeBlocked(s.voice.wake, charWakeName(s, this.characterId(), this.characterName()), this.state.localStt ? this.state.localStt.downloaded : []);
  }

  private queueWakeSync(): void {
    if (this.wakeSyncQueued) return;
    this.wakeSyncQueued = true;
    queueMicrotask(() => {
      this.wakeSyncQueued = false;
      this.syncWake();
    });
  }

  /** 대기 중이고 항상 듣기가 켜져 있으면 호출어를 듣고, 아니면 끈다 (듣는 중·읽는 중·답하는 중에는 끔) */
  private syncWake(): void {
    const s = this.state.settings;
    const on = !!s && s.voice.wake.enabled;
    if (!on) this.wakeFailed = '';
    // 켰는데 쓸 수 없으면 한 번 알린다 (위스퍼 모델 상태를 읽은 뒤에만)
    const blocked = on && this.state.localStt ? this.wakeBlockedReason() : null;
    if (blocked && blocked !== this.wakeNoticed) {
      this.wakeNoticed = blocked;
      this.addMsg('sys', `항상 듣기(호출어)를 아직 쓸 수 없습니다: ${blocked}`);
    } else if (!blocked) this.wakeNoticed = '';
    const modelNote = on && !blocked && this.state.localStt ? wakeModelNote(s.voice.wake, this.state.localStt.downloaded) : null;
    if (modelNote && modelNote !== this.wakeModelNoticed) this.addMsg('sys', modelNote);
    this.wakeModelNoticed = modelNote || '';
    const st = this.state;
    const want = on && !!st.localStt && !blocked && !this.wakeFailed && !st.recording && !st.transcribing && !st.busy && !st.speaking && !st.dialog && !this.wakeHandling && !this.recorder.active;
    const key = s ? `${s.voice.wake.marginDb}|${s.voice.wake.noiseDb}` : '';
    if (this.wake && (!want || key !== this.wakeKey)) this.stopWake();
    if (want && !this.wake) {
      this.wakeKey = key;
      this.startWake();
    }
  }

  private startWake(): void {
    const v = this.settings.voice;
    this.wakeBase = v.wake.noiseDb;
    const w: WakeListener = new WakeListener({
      noiseDb: this.wakeNoiseStart(),
      marginDb: v.wake.marginDb,
      onSegment: (wav) => this.onWakeSegment(w, wav),
      onError: (e) => console.warn('호출어 받아 적기 실패', e.message)
    });
    this.wake = w;
    this.A.mascot.relay({ type: 'wake', on: true });
    w.start().catch((e) => {
      if (this.wake !== w) return;
      this.stopWake();
      this.wakeFailed = errMsg(e);
      this.addMsg('err', `항상 듣기(호출어)를 시작하지 못했습니다: ${this.wakeFailed}`);
    });
  }

  private stopWake(): void {
    const w = this.wake;
    if (!w) return;
    this.wake = null;
    const n = w.noise;
    if (n !== null && Number.isFinite(n)) this.learnedWakeNoise = { db: Math.round(n * 10) / 10, base: this.wakeBase };
    w.stop();
    this.A.mascot.relay({ type: 'wake', on: false });
  }

  /** 잘라 낸 말소리를 앱 안 위스퍼로 받아 적고, 호출어로 시작하면 듣기 시작 (받아 적은 글은 남기지 않는다) */
  private async onWakeSegment(w: WakeListener, wav: Uint8Array): Promise<void> {
    if (this.wake !== w) return;
    const r = await this.A.stt.localQuick(wav, this.settings.voice.wake.model);
    if (this.wake !== w || !this.state.settings) return;
    const noise = !r.text || looksLikeNoise(r.text);
    // 모든 캐릭터의 호출어를 같이 본다 (캐릭터 순서대로, 같은 호출어면 앞 캐릭터). 다른 캐릭터면 그 캐릭터로 바꾼다
    const chars = visibleCharacters(this.state.characters, this.settings.hiddenCharacters).map((c) => ({ id: c.id, name: String(c.config.name || c.id) }));
    const target = noise ? '' : findWakeCharacter(r.text, this.settings, chars);
    const hit = !!target;
    // 위스퍼가 무엇으로 들었는지 whisper.log에 남긴다 (이 컴퓨터 안에만): 이름을 자주 놓칠 때 원인을 보려고
    void this.A.stt.wakeLog({ model: r.model, text: r.text, result: hit ? 'match' : noise ? 'noise' : 'no' }).catch(() => {});
    if (!hit) return;
    if (target !== this.characterId()) {
      this.stopWake();
      await this.selectCharacter(target); // 그 캐릭터의 대화·AI·목소리로 바뀐다 (선택 바·바탕화면 캐릭터도)
    }
    await this.onWake();
  }

  /** 호출어를 들었다: "네 말씀하세요" → 듣기 시작 (그 뒤는 단축키로 시작한 것과 같다) */
  async onWake(): Promise<void> {
    if (this.wakeHandling) return;
    this.wakeHandling = true;
    this.stopWake();
    try {
      this.convGen++;
      this.bubble(WAKE_ACK_TEXT, false);
      this.set({ placeholder: WAKE_ACK_TEXT });
      await this.playAck();
      await new Promise((r) => setTimeout(r, ECHO_GAP_MS));
      if (this.state.busy || this.recorder.active) return;
      if (!this.canRecord()) {
        this.bubble('쓸 수 있는 음성 인식이 없어요 (설정 > 음성).', true);
        this.set({ placeholder: DEFAULT_PLACEHOLDER });
        return;
      }
      await this.startListening('manual');
    } finally {
      this.wakeHandling = false;
      this.queueWakeSync();
    }
  }

  /** "네 말씀하세요": 그 캐릭터의 목소리 설정으로 읽기 → 읽기가 꺼져 있거나 안 되면 알림음 (캐릭터 음량) */
  private async playAck(): Promise<void> {
    const vol = this.charVolume(); // 지금 캐릭터의 음량
    this.applyVoiceFlags(); // 방금 캐릭터가 바뀌었을 수 있다
    if (this.tts.enabled) {
      this.tts.feed(WAKE_ACK_TEXT + ' ');
      this.tts.flush();
      await this.tts.whenIdle();
      return;
    }
    playStartChime(vol);
    await new Promise((r) => setTimeout(r, 350));
  }

  /* ---------------- 설정 ---------------- */

  async reloadCharacters(): Promise<Character[]> {
    const characters = await this.A.characters.list();
    this.set({ characters });
    return characters;
  }

  /** 선택 바에서 캐릭터 고르기 (설정에서 고르는 것과 같다: 그 캐릭터의 대화·말투·목소리로 바뀐다).
   *  듣는 중·답을 기다리는 중·읽는 중이면 그것부터 멈추고 바꾼다 */
  async selectCharacter(id: string): Promise<void> {
    if (!this.state.settings || !selectedCharacter(this.state.characters, id, this.state.settings.hiddenCharacters) || id === this.state.settings.character) return;
    try {
      if (this.state.recording) await this.finishRecording(true); // 듣기 취소 (이어서 듣기 기다림 포함)
      if (this.state.busy || this.state.speaking) {
        this.stopAll();
        // 멈춘 답이 정리될 때까지 잠깐 기다린다 (멈췄다는 안내가 새 캐릭터 대화에 끼지 않게)
        for (let i = 0; i < 40 && this.state.busy; i++) await new Promise((r) => setTimeout(r, 50));
      }
      const s = this.state;
      if (!s.settings) return;
      const prevAi = charProfileId(s.settings, this.characterId());
      const r = await this.A.settings.save({ ...s.settings, character: id });
      this.set({ settings: r.settings, roots: r.roots });
      await this.applyCharacter({ force: false });
      // 캐릭터마다 AI·목소리가 다르다: AI가 바뀌었으면 연결을 다시 확인하고, 목소리는 늘 다시 맞춘다
      if (charProfileId(r.settings, id) !== prevAi) await this.refreshConnection();
      else this.applyVoiceFlags();
    } catch (e) {
      this.addMsg('err', `캐릭터를 바꾸지 못했습니다: ${errMsg(e)}`);
    }
  }

  /** 숨김은 즉시 저장한다. 선택 캐릭터를 다른 캐릭터로 바꾸지 않는다. */
  async setCharacterHidden(id: string, hidden: boolean): Promise<void> {
    await this.A.characters.setHidden(id, hidden);
    await this.reloadSettings();
  }

  /** 캐릭터 삭제 잠금 걸기/풀기 (바로 저장됨) */
  async setCharacterLocked(id: string, locked: boolean): Promise<void> {
    try {
      const saved = await this.A.characters.setLocked(id, locked);
      this.set({ settings: this.state.settings ? { ...this.state.settings, lockedCharacters: saved } : this.state.settings });
    } catch (e) {
      this.addMsg('err', `잠금을 바꾸지 못했습니다: ${errMsg(e)}`);
    }
  }

  /** 캐릭터 순서 바꾸기 (바로 저장됨). order = 새 순서의 id 목록 */
  async setCharacterOrder(order: string[]): Promise<void> {
    try {
      const saved = await this.A.characters.setOrder(order);
      const settings = this.state.settings ? { ...this.state.settings, characterOrder: saved } : this.state.settings;
      this.set({ settings });
      await this.reloadCharacters();
    } catch (e) {
      this.addMsg('err', `순서를 저장하지 못했습니다: ${errMsg(e)}`);
    }
  }

  /** 설정 > 캐릭터에서 캐릭터를 고치거나 지운 뒤: 설정(지금 캐릭터)·목록을 다시 읽고 캐릭터를 다시 그린다 */
  async afterCharacterChange(): Promise<Character[]> {
    const s = await this.A.settings.load();
    this.set({ settings: s.settings, roots: s.roots });
    const list = await this.reloadCharacters();
    await this.applyCharacter({ force: false });
    await this.refreshConnection();
    return list;
  }

  /** 설정창에서 저장. 성공하면 true (창을 닫는다) */
  async saveSettings(draft: Settings, draftRoots: RootEntry[]): Promise<boolean> {
    const next: Settings = { ...draft, tools: { ...draft.tools, allowedRoots: rootsToSave(draftRoots) } };
    const prevLow = this.settings.lowSpec;
    this.fallbackNoticed = false;
    let saveErrors = false;
    try {
      const r = await this.A.settings.save(next);
      this.set({ settings: r.settings, roots: r.roots });
      saveErrors = r.rootErrors.length > 0 || !!r.shortcutError;
      if (r.rootErrors.length) this.addMsg('err', '사용할 수 없는 허용 폴더가 있어 제외됩니다:\n' + r.rootErrors.map((e) => `${e.label}: ${e.reason}`).join('\n'));
      if (r.shortcutError) this.addMsg('err', `단축키를 바꾸지 못했습니다:\n${r.shortcutError}\n안 된 단축키는 이전 것을 그대로 씁니다.`);
    } catch (e) {
      this.addMsg('err', `설정을 저장하지 못했습니다: ${errMsg(e)}`);
      return false;
    }
    await this.reloadCharacters();
    await this.applyCharacter({ force: false }); // 캐릭터가 바뀌었으면 그 캐릭터의 대화 기록으로 바뀐다
    if (prevLow !== this.settings.lowSpec) this.addMsg('sys', this.settings.lowSpec ? '저사양 모드를 켰습니다.' : '저사양 모드를 껐습니다.');
    await this.refreshConnection();
    return !saveErrors;
  }

  // 트레이·마스코트에서 설정이 바뀌었을 때
  /**
   * TTS 켜기/끄기 단축키·트레이 (메인이 설정을 이미 저장했다). 끄면 읽던 소리만 멈추고 답 글은 그대로 나온다.
   * 이어서 대화도 그대로 이어지고, 이후 답은 글로만 나온다.
   */
  async onTtsToggled(on: boolean): Promise<void> {
    if (!on) {
      this.tts.stop();
      this.tts.enabled = false;
    }
    const msg = on ? 'TTS 기능을 사용합니다.' : 'TTS 기능을 사용하지 않습니다.';
    this.addMsg('sys', msg);
    this.A.mascot.relay({ type: 'notice', text: msg });
    try {
      const s = await this.A.settings.load();
      this.set({ settings: s.settings, roots: s.roots });
    } catch {
      /* 다음 설정 읽기 때 맞춰진다 */
    }
    this.applyVoiceFlags();
    if (this.state.health) this.setStatus(this.state.status.kind, this.state.status.text, this.statusTitle());
  }

  async reloadSettings(): Promise<void> {
    const prevLow = this.settings.lowSpec;
    const previousCharacter = this.characterId();
    const s = await this.A.settings.load();
    this.set({ settings: s.settings, roots: s.roots });
    if (previousCharacter !== this.characterId()) {
      this.stopAll();
      if (this.state.recording) await this.finishRecording(true);
      await this.applyCharacter({ force: true });
    }
    if (prevLow !== s.settings.lowSpec) {
      await this.stage?.show(this.character(), { lowSpec: s.settings.lowSpec });
      this.A.mascot.relay({ type: 'character' });
      this.addMsg('sys', s.settings.lowSpec ? '저사양 모드를 켰습니다.' : '저사양 모드를 껐습니다.');
    }
    await this.refreshConnection();
  }

  /** 설정 > 캐릭터 > 대화 기록 지우기 (_to_delete 폴더로 옮김) */
  async clearHistory(id: string): Promise<void> {
    const c = this.state.characters.find((x) => x.id === id);
    try {
      const moved = await this.A.history.clear(id);
      this.addMsg('sys', moved ? `${c ? c.config.name || c.id : id} 대화 기록을 지웠습니다 (기록 폴더의 _to_delete로 옮김).` : '지울 대화 기록이 없습니다.');
      if (id === this.shownCharacter) await this.renderHistory();
    } catch (e) {
      this.addMsg('err', errMsg(e));
    }
  }
}

/** 짧은 소리 재생 (다 들으면 끝나는 약속). 임시 주소는 끝나면 바로 푼다 */
function playClip(audio: Uint8Array, mime: string, volume: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime || 'audio/wav' }));
    const el = new Audio(url);
    el.volume = Math.min(1, Math.max(0, volume));
    let done = false;
    const end = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      el.pause();
      end();
    }, 8000);
    el.onended = () => end();
    el.onerror = () => end(new Error('소리를 재생하지 못했습니다.'));
    el.play().catch((e) => end(e instanceof Error ? e : new Error(String(e))));
  });
}
