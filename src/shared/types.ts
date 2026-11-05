// 메인 프로세스·preload·화면이 함께 쓰는 타입. 여기를 바꾸면 세 곳이 같이 맞춰진다.

/* ---------------- 설정 ---------------- */

/** auto = 주소만 보고 Ollama / OpenAI 호환 / 비서 서버 중 알아서 고른다 */
export type ProviderType = 'auto' | 'assistant' | 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface Profile {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  lowSpecModel: string;
  systemPrompt: string;
  temperature: number;
  timeoutSec: number;
  /** 마지막으로 확인한 내 서버 정보. 연결 상태를 실시간으로 보장하는 값은 아니다. */
  connectionInfo?: import('./profile-summary').ConnectionInfo;
}

export interface RootEntry {
  id: string;
  label: string;
  path: string;
  /** 원격(메신저, 비서 봇) 지시가 다룰 수 있는 폴더. 기본은 안 됨 */
  remote?: boolean;
}

/** 설정 > TTS에 등록한 TTS 서버. 목소리는 캐릭터마다 고른다 (CharacterVoice.voice) */
export interface TtsServer {
  name: string;
  /** 비우면 캐릭터 AI 서버의 TTS (규약 v1) */
  baseUrl: string;
  apiKey: string;
  /** OpenAI 호환 서버의 모델 (비우면 알아서) */
  model: string;
}

/** 캐릭터마다 정하는 목소리 (설정 > 캐릭터 > 목소리) */
export interface CharacterVoice {
  /** builtin = 컴퓨터 음성, server = 등록한 TTS 서버 */
  engine: 'builtin' | 'server';
  /** TTS 서버 id (settings.ttsServers) */
  server: string;
  /** TTS 서버의 목소리 이름 (비우면 캐릭터 config.voice → 서버 기본) */
  voice: string;
  /** 컴퓨터 음성 이름 (비우면 한국어 목소리를 찾음) */
  builtinVoice: string;
  /** 배속 0.5~2 (컴퓨터 음성·서버 소리 모두) */
  rate: number;
  /** 음량 0~100 (%). 이 캐릭터와 대화할 때 알림음에도 쓴다 */
  volume: number;
  /** TTS 서버가 안 되면 컴퓨터 음성으로 읽기 */
  fallbackBuiltin: boolean;
  /** 호출어 (비우면 캐릭터 이름). 다른 캐릭터의 호출어로 부르면 그 캐릭터로 바뀐다 */
  wakeName: string;
}

export interface Settings {
  version: 2;
  /** 예전 설정의 "사용 중 프로필" (캐릭터마다 옮긴 뒤로는 쓰지 않음). withCharacter()가 캐릭터의 AI로 바꿔 끼운다 */
  activeProfile: string;
  profiles: Record<string, Profile>;
  /** 설정 > TTS의 TTS 서버 목록 */
  ttsServers: Record<string, TtsServer>;
  /** 캐릭터 id → AI 프로필 id. 없으면 선택 안 함 */
  characterAi: Record<string, string>;
  /** 캐릭터 id → 목소리. 없으면 컴퓨터 음성 기본값 */
  characterVoice: Record<string, CharacterVoice>;
  /** 예전 설정(전체 하나의 AI·TTS)을 캐릭터마다 옮겼는지 */
  charPrefsMigrated: boolean;
  character: string;
  /** 직전에 쓰던 캐릭터 (캐릭터를 삭제하면 이것으로 돌아감. 없으면 기본 캐릭터) */
  prevCharacter: string;
  /** 캐릭터 순서 (id 목록). 선택 바·설정 목록에 쓴다. 빠진 캐릭터는 맨 뒤 */
  characterOrder: string[];
  /** 삭제 잠금을 건 캐릭터 id (실수로 ✕를 눌러도 지워지지 않음) */
  lockedCharacters: string[];
  /** 대화창에서 숨긴 캐릭터. 설정 목록과 대화 기록은 유지한다. */
  hiddenCharacters: string[];
  alwaysOnTop: boolean;
  lowSpec: boolean;
  voice: {
    /** 답을 소리로 읽기 */
    tts: boolean;
    /** 음성 인식 결과를 바로 보내기 */
    autoSend: boolean;
    stt: SttSettings;
    vad: VadSettings;
    followUp: FollowUpSettings;
    /** 예전 설정의 전체 TTS (옮긴 뒤로는 저장만 됨). withCharacter()가 캐릭터 목소리로 바꿔 끼운다 */
    ttsOut: TtsOutSettings;
    wake: WakeSettings;
  };
  /** 전역 단축키. ptt = 말하기, ttsToggle = 답 읽기(TTS) 켜기/끄기 (기본 비어 있음). 빈 문자열이면 안 씀 */
  shortcut: { ptt: string; ttsToggle: string };
  mascot: {
    enabled: boolean;
    bounds: { x: number; y: number } | null;
    /** true = 활동이 없으면 숨기고 말을 걸면 다시 나타남, false = 계속 켜두기 */
    autoHide: boolean;
    /** 활동이 없을 때 숨기기까지 초 (1~10) */
    hideSec: number;
  };
  tools: { allowedRoots: RootEntry[] | null; nameMethod: import('./file-names').FileNameMethod };
  /** 로컬 파일 관리: 삭제한 파일(_to_delete) 비우기, 받은 파일 폴더 */
  files: FilesSettings;
  /** 원격(메신저) 연결: 디스코드 봇, 잠금 해제 시간, 보낸 파일 자동 삭제 */
  remote: RemoteSettings;
}

/** 설정 > 파일 제어 > 관리 */
export interface FilesSettings {
  /** manual = 직접 관리(앱은 비우지 않음), auto = 기간이 지난 날짜 폴더를 비움 */
  trashMode: 'manual' | 'auto';
  /** 자동 비우기 기간 (1~365일, 기본 30) */
  trashDays: number;
  /** 받은 파일 폴더 ('' = 기본: 다운로드 폴더 아래 "AI비서 받은 파일") */
  receivedDir: string;
}

/** 설정 > 원격 */
export interface RemoteSettings {
  /** 디스코드 봇 연결 켜기 */
  enabled: boolean;
  /** apiKey = 봇 토큰 (암호화 저장), userId = 내 디스코드 사용자 ID (이 사람의 DM만 받는다) */
  discord: { apiKey: string; userId: string };
  /** 인증 뒤 잠금 해제 시간 (분, 10분~90일, 기본 30일) */
  unlockMinutes: number;
  /** 메신저에 올린 파일 메시지를 올린 날짜 기준 이 일 수가 지나면 지운다 (1~365, 기본 30) */
  sentDeleteDays: number;
}

/** 원격 연결 상태 (설정 > 원격에 보여 준다) */
export interface RemoteStatus {
  enabled: boolean;
  connected: boolean;
  /** 디스코드에 연결하는 중 */
  connecting: boolean;
  /** 연결된 봇 이름 */
  botName: string;
  /** 연결 실패 이유 */
  error: string;
  /** 인증 앱 키를 만들었는지 */
  keySet: boolean;
  /** 잠금이 풀려 있는 마지막 시각 (밀리초, 0 = 잠김) */
  unlockedUntil: number;
  /** 원격 중지 상태 (모든 원격 요청을 거부) */
  stopped: boolean;
  /** 남은 복구 코드 수 */
  recoveryLeft: number;
  /** 기록해 둔 보낸 파일 메시지 수 */
  sentCount: number;
  /** 비서 서버 연결 */
  server: {
    /** 서버 원격 허용 스위치 */
    on: boolean;
    registered: boolean;
    name: string;
    profile: string;
    state: 'off' | 'connecting' | 'connected' | 'waiting';
    error: string;
  };
}

/** 메인 → 화면: 원격(메신저)에서 온 것 */
export type RemoteEvent = RemoteMessageContext & (
  /** 메신저에서 온 대화: 화면이 지금 캐릭터로 답하고 remote.reply로 돌려준다 */
  | { type: 'chat'; reqId: string; text: string; source: string }
  /** 메신저에서 한 일을 대화창에 한 줄로 남긴다 */
  | { type: 'line'; role: 'user' | 'sys' | 'err'; text: string; source: string }
  /** 메신저로 받은 파일: 대화창에 이름·크기와 다운로드 버튼 */
  | { type: 'received'; fileId: string; name: string; size: number; executable: boolean; source: string }
  | { type: 'status'; status: RemoteStatus });

export interface RemoteMessageContext { characterId?: string; historyId?: string; time?: string }

export interface ReceivedDownload {
  ok: boolean;
  /** 저장한 경로 */
  path: string;
  /** 허용 폴더 기준 표시 (받은 파일/보고서.pdf) */
  display: string;
  executable: boolean;
  message: string;
}

/* ---------------- 음성 대화 ---------------- */

/** 말이 멈추면 자동으로 끝내기 (말소리 감지) */
export interface VadSettings {
  autoStop: boolean;
  /** 말소리가 나온 뒤 이만큼 조용하면 끝낸다 (1~3초) */
  silenceSec: number;
  /** 처음 이만큼 말이 없으면 취소한다 (초) */
  noSpeechSec: number;
  /**
   * 주변 소음 (dBFS, 말소리 대역). 설정 > 음성 > 마이크 맞추기에서 잰 값. null이면 듣기 시작할 때 잠깐 잰다.
   * 듣는 동안에는 이 값에서 시작해 자동으로 고쳐 나간다.
   */
  noiseDb: number | null;
  /** 말소리 = 주변 소음 + 이만큼 (6~25dB). 말이 멈춤 = 주변 소음 + 3dB 이내 */
  marginDb: number;
  /** 듣기를 끝낼 때 말소리선 위였던 시간 합이 이보다 짧으면 받아 적지 않는다 (0~2초, 0.1초 단위, 기본 0.3). 주변 소리가 위스퍼로 가서 지어낸 글이 전송되는 것을 막음 */
  minSpokenSec: number;
}

/** 이어서 대화: 답이 끝나면 다시 듣는다 */
export interface FollowUpSettings {
  enabled: boolean;
  /** 답이 끝난 뒤 말을 기다리는 시간 (3~15초) */
  waitSec: number;
  /** 말이 없어 끝날 때 알림음 */
  endChime: boolean;
}

/** 호출어: 대기 중 마이크를 켜 두고 이름을 부르면 듣기 시작 (앱 안 위스퍼로 판단, 녹음은 밖으로 안 나감) */
export interface WakeSettings {
  /** 항상 듣기 (기본 꺼짐) */
  enabled: boolean;
  /** 호출어. 비우면 캐릭터 이름 */
  name: string;
  /** "네 말씀하세요" 음성 파일 (사용자 데이터 폴더 sounds/ 안의 파일 이름). 비우면 TTS → 알림음 */
  ackFile: string;
  /** 호출어를 받아 적을 앱 안 위스퍼 모델 (기본 small). 받아 두지 않았으면 받아 둔 가장 작은 모델로 대신 */
  model: LocalSttModel;
  /** 호출어 대기용 주변 소음 (dBFS). 음성 대화(voice.vad.noiseDb)와 따로 맞춘다. null이면 듣기 시작할 때 잠깐 잰다 */
  noiseDb: number | null;
  /** 호출어 대기용 "말소리 = 주변 소음 + 이만큼" (6~25dB). 음성 대화(voice.vad.marginDb)와 따로 맞춘다 */
  marginDb: number;
}

/* ---------------- 답을 소리로 읽기 (TTS) ---------------- */

/** builtin = 이 컴퓨터 내장 목소리, server = TTS 서버 */
export type TtsSource = 'builtin' | 'server';

export interface TtsOutSettings {
  source: TtsSource;
  /** 서버가 실패하면 내장 목소리로 읽기 */
  fallbackBuiltin: boolean;
  /** 음량 0~100 (%). 이 컴퓨터 목소리·서버 목소리·미리 듣기·알림음에 같이 쓴다 */
  volume: number;
  /** voice: 이 컴퓨터의 목소리 이름 (비우면 한국어 목소리를 찾음), rate: 속도 0.5~2 */
  builtin: { voice: string; rate: number };
  /** 주소를 비우면 대화 서버의 TTS(규약 v1). OpenAI 호환(/v1/audio/speech)과 규약 v1(/v1/tts)을 받는다 */
  server: { baseUrl: string; apiKey: string; voice: string; model: string };
}

export interface TtsServerTest {
  kind: 'v1' | 'openai';
  voices: string[];
  models: string[];
}

/* ---------------- 음성 인식 (대화 AI와 따로 고른다) ---------------- */

export type SttSourceId = 'server' | 'cloud' | 'local';
export type CloudSttProvider = 'gemini' | 'openai';
export type LocalSttModel = 'tiny' | 'base' | 'small' | 'medium';

export interface SttSettings {
  /** 위에서부터 시도하고, 실패하면 다음으로 */
  order: SttSourceId[];
  /** 내 서버 / 로컬: 규약 v1(/v1/stt) 또는 OpenAI 호환(/v1/audio/transcriptions). 주소를 비우면 대화 서버(클라우드가 아닐 때)를 쓴다 */
  server: { enabled: boolean; baseUrl: string; apiKey: string; model: string };
  /** 클라우드: 키를 비우면 같은 회사의 대화 프로필 키를 쓴다 */
  cloud: { enabled: boolean; provider: CloudSttProvider; apiKey: string; model: string };
  /** 이 컴퓨터(앱 안 위스퍼) */
  local: { enabled: boolean; model: LocalSttModel };
  /** 서버·클라우드가 이 시간 안에 답하지 않으면 다음으로 (초) */
  timeoutSec: number;
}

export interface SttFailure {
  source: SttSourceId;
  label: string;
  message: string;
}

export interface SttResult {
  text: string;
  source: SttSourceId;
  /** 실제로 인식한 곳 (예: "내 서버", "클라우드 (Gemini)", "이 컴퓨터") */
  label: string;
  /** 앞 순서에서 실패한 곳들 */
  failures: SttFailure[];
}

export interface SttServerTest {
  kind: 'v1' | 'openai';
  models: string[];
}

export interface LocalSttStatus {
  /** 받아 둔 모델 */
  downloaded: LocalSttModel[];
  /** 받는 중 */
  downloading: { model: LocalSttModel; progress: number } | null;
  /** 엔진을 쓸 수 없는 이유 (없으면 null) */
  unavailable: string | null;
  dir: string;
}

export interface LocalSttProgress {
  model: LocalSttModel;
  /** 0~1 */
  progress: number;
  file?: string;
  done?: boolean;
  error?: string;
}

export interface RootError {
  path: string;
  label: string;
  reason: string;
}

export interface SettingsLoad {
  settings: Settings;
  roots: RootEntry[];
}

export interface SettingsSaveResult extends SettingsLoad {
  rootErrors: RootError[];
  shortcutError: string | null;
}

export interface AppInfo {
  platform: string;
  version: string;
  /** 기본 캐릭터 폴더 (읽기 전용) */
  charactersDir: string;
  /** 내가 추가한 캐릭터 폴더 (my-characters) */
  myCharactersDir: string;
  logFile: string;
  historyDir: string;
  encrypted: boolean;
  shortcut: string | null;
}

/* ---------------- 캐릭터 ---------------- */

export interface Live2DConfig {
  model: string;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  params?: { mouthOpen?: string };
  expressions?: Record<string, string>;
  motions?: Record<string, string>;
}

export interface CharacterConfig {
  name?: string;
  type?: 'image' | 'live2d';
  persona?: string;
  image?: string;
  icon?: string;
  voice?: { voice?: string };
  live2d?: Live2DConfig;
}

export interface Character {
  id: string;
  config: CharacterConfig;
  /** 앱에 같이 들어 있는 기본 캐릭터 (읽기 전용: 이름·성격·그림 수정과 삭제를 막음) */
  builtin?: boolean;
}

export type StageState = 'idle' | 'thinking' | 'talking';

/* ---------------- 대화 기록 ---------------- */

export interface HistoryMessage {
  id?: string;
  role: 'user' | 'bot' | 'sys' | 'err';
  text: string;
  time?: string;
  source?: string;
  tone?: 'error';
  results?: SearchItem[];
  /** 파일 작업/알림 기록은 AI의 대화 기억과 구분한다. */
  memory?: boolean;
}

/* ---------------- 서버 통신 ---------------- */

export interface Features {
  chatStream: boolean;
  stt: boolean;
  tts: boolean;
  serverConfirm: boolean;
  sessions: boolean;
  lowSpec: boolean;
  clientActions: string[];
}

export interface Health {
  provider: ProviderType;
  api: string;
  server: string;
  version: string;
  model: string;
  models: string[];
  voices: string[];
  features: Features;
  warning: string;
  /** 연결 테스트가 실제로 쓴 주소 (자동 인식이 /v1, /api를 붙였으면 그것까지). 없으면 쓴 주소 그대로 */
  resolvedUrl?: string;
}

export interface ActionArgs {
  /** 정형 생성 명령의 위치·이름 경계를 앱에서 찾기 위한 원문 단어다. AI 분류 인자가 아니다. */
  createParts?: { text: string; quoted: boolean }[];
  /** 사용자가 선택한 위치·새 이름 조합. 생성 준비 단계에서 후보와 다시 대조한다. */
  createChoice?: string;
  /** 정형 찾기·열기·위치·이름 변경·백업·삭제·보내기 명령의 위치·대상 경계를 찾기 위한 원문 단어다. */
  openParts?: { text: string; quoted: boolean }[];
  /** 사용자가 선택한 검색 위치·대상 조합이다. */
  openChoice?: string;
  /** 정형 복사·이동의 출발/대상/도착 경계를 찾기 위한 단어다. */
  transferParts?: { text: string; quoted: boolean }[];
  transferChoice?: string;
  /** 자연어에서 명시한 같은 폴더 복사. 목적지 생략 복사도 같은 동작이다. */
  sameFolder?: boolean;
  target?: string;
  dest?: string;
  root?: string;
  query?: string;
  /** 이름 바꾸기·복사 사본의 새 이름, 폴더·파일 만들기의 이름 */
  name?: string;
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'confirm'; id: string; message: string; expiresIn: number }
  | { type: 'client_action'; id: string; action: string; args: ActionArgs; say: string };

/** 메인 → 화면: 대화 이벤트와 끝 신호(_end)는 같은 통로로 간다 */
export type ChatWireEvent = ChatEvent | { type: '_end'; error?: string; code?: string };

export interface ChatRequest {
  text: string;
  source?: string;
  time?: number;
  input?: 'text' | 'voice';
  character: string;
  persona?: string;
}

export interface ActionReport {
  status: 'done' | 'failed' | 'rejected' | 'expired';
  detail: string;
}

export interface TtsResult {
  audio: Uint8Array;
  mime: string;
}

/* ---------------- 파일 작업 ---------------- */

export type ActionName =
  | 'file.search'
  | 'file.open'
  | 'file.reveal'
  | 'file.move'
  | 'file.copy'
  | 'file.rename'
  | 'file.mkdir'
  /** 빈 파일 만들기 (확장자 없음 또는 .txt) */
  | 'file.create'
  /** 폴더 안의 내용 보기 */
  | 'file.list'
  | 'file.backup'
  | 'file.delete'
  /** 메신저로 파일 보내기 (메신저 요청에서만) */
  | 'file.send';

export interface ToolSource {
  /** local = 앱에서 직접, server = AI 서버가 요청, remote = 메신저에서 요청 */
  kind: 'local' | 'server' | 'remote';
  id?: string;
  /** 어느 쪽에서 왔는지: 비서 봇, 앱 봇 */
  via?: string;
}

export interface ToolRequest {
  action: string;
  args?: ActionArgs;
  source?: ToolSource;
}

export interface SearchItem {
  path: string;
  display: string;
  isDir: boolean;
}

export interface ChoiceOption {
  path: string;
  display: string;
  /** 선택값이 경로가 아닌 조합일 때 표시할 도움말. */
  title?: string;
}

export type PrepareResult =
  | { status: 'result'; query: string; items: SearchItem[]; list?: boolean; rootList?: boolean }
  | { status: 'choice'; field: 'target' | 'dest' | 'root' | 'createChoice' | 'openChoice' | 'transferChoice'; options: ChoiceOption[]; message: string }
  | {
      status: 'ready';
      id: string;
      needsConfirm: boolean;
      expiresInMs: number;
      summary: {
        action: ActionName;
        from: string;
        to: string | null;
        fromPath: string;
        toPath: string | null;
        conflict: boolean;
        warnings: string[];
        /** 확인 질문 (앱과 메신저가 같다). 비면 확인 없이 실행 */
        questions: string[];
      };
    }
  | { status: 'error'; code: string; message: string };

export interface ExecuteResult {
  ok: boolean;
  status: 'done' | 'failed' | 'expired';
  message: string;
  /** 결과 경로 (복사·이동·백업·이름 바꾸기·폴더 만들기·삭제 후 위치) */
  path?: string;
}

export interface PickedFolder {
  path: string;
  label: string;
  error: string | null;
}

/* ---------------- 창·마스코트 ---------------- */

export type MascotMessage =
  | { type: 'mouth'; v: number }
  | { type: 'state'; state: StageState }
  | { type: 'bubble'; text: string; final: boolean }
  | { type: 'recording'; on: boolean }
  /** 잠깐 보여 주는 알림 (말풍선과 따로) */
  | { type: 'notice'; text: string }
  /** 호출어를 기다리는 중 (마이크 켜짐) */
  | { type: 'wake'; on: boolean }
  | { type: 'character' }
  | { type: 'settings' };

export interface AppCommand {
  /** ttsToggled: TTS 켜기/끄기 단축키·트레이로 바뀜 (data: { on }) */
  cmd: 'ptt' | 'settingsChanged' | 'ttsToggled' | 'settingsSnapshot' | 'settingsTab';
  data?: unknown;
}

export type DragPhase = 'start' | 'move' | 'end';

/* ---------------- 화면에 열어 주는 기능 (preload → window.app) ---------------- */

export interface AppApi {
  info(): Promise<AppInfo>;
  settingsWindow: {
    open(tab?: 'character'): Promise<boolean>; close(): Promise<boolean>; refresh(): Promise<boolean>;
    call(method: import('./settings-window').SettingsMethod, args: unknown[]): Promise<unknown>;
    publish(view: import('./settings-window').SettingsView): void;
    reply(id: string, value: unknown, error?: string): void;
    onView(cb: (view: import('./settings-window').SettingsView) => void): () => void;
    onCall(cb: (call: import('./settings-window').SettingsCall) => void): () => void;
  };
  settings: {
    load(): Promise<SettingsLoad>;
    save(s: Settings): Promise<SettingsSaveResult>;
  };
  characters: {
    list(): Promise<Character[]>;
    openFolder(): Promise<boolean>;
    /** 캐릭터 순서 저장 (바로 저장됨). 정리된 순서를 돌려준다 */
    setOrder(order: string[]): Promise<string[]>;
    /** 삭제 잠금 걸기/풀기 (바로 저장됨). 잠긴 캐릭터 id 목록을 돌려준다 */
    setHidden(id: string, hidden: boolean): Promise<string[]>;
    reset(id: string): Promise<boolean>;
    setLocked(id: string, locked: boolean): Promise<string[]>;
    /** 캐릭터 추가: 파일(그림)·폴더(Live2D)를 고르는 창을 띄우고 복사한다. 고르기를 취소하면 null */
    add(req: { kind: 'image' | 'live2d'; name: string; persona: string }): Promise<{ id: string; name: string } | null>;
    /** 이름·성격 바꾸기 */
    update(id: string, req: { name: string; persona: string }): Promise<{ id: string; name: string }>;
    /** 그림 캐릭터의 그림 바꾸기 (고르는 창을 띄움, 이전 그림은 지움). 취소면 null */
    replaceImage(id: string): Promise<{ id: string; name: string } | null>;
    /** 이 캐릭터 폴더를 Finder/탐색기에서 열기 */
    openOne(id: string): Promise<boolean>;
    /** 삭제 (실제로 지움, 기본 캐릭터는 안 됨). 삭제 뒤 쓸 캐릭터를 돌려준다 */
    remove(id: string): Promise<{ character: string; prevCharacter: string }>;
  };
  history: {
    load(id: string): Promise<HistoryMessage[]>;
    append(id: string, entries: HistoryMessage[]): Promise<number>;
    clear(id: string): Promise<boolean>;
  };
  api: {
    health(profile?: Partial<Profile>): Promise<Health>;
    /** onEvent로 delta/client_action/confirm/done/error를 받고, 끝(_end)에서 끝난다 */
    chat(reqId: string, req: ChatRequest, onEvent: (ev: ChatEvent) => void): Promise<true>;
    abort(reqId: string): Promise<boolean>;
    interpretConfirmation(question: string, answer: string): Promise<import('./confirmation').ConfirmationDecision>;
    confirm(id: string, approve: boolean): Promise<{ text: string }>;
    report(id: string, result: ActionReport): Promise<void>;
    /** 음성 인식: 설정의 순서대로 시도한다 */
    stt(audio: Uint8Array, mime: string): Promise<SttResult>;
    /** 설정의 TTS 서버(주소가 비면 대화 서버)로 소리를 만든다. voice는 캐릭터 목소리 (설정에 목소리가 있으면 그것을 쓴다) */
    tts(text: string, voice: string): Promise<TtsResult>;
  };
  tts: {
    /** 설정 창의 연결 테스트 (편집 중인 값) */
    testServer(cfg: TtsOutSettings['server']): Promise<TtsServerTest>;
    /** 설정 창의 미리 듣기 (편집 중인 값) */
    preview(cfg: TtsOutSettings['server'], text: string, voice: string): Promise<TtsResult>;
  };
  stt: {
    /** 호출어용 짧은 받아 적기: 음성 인식 순서를 거치지 않고 앱 안 위스퍼(받아 둔 가장 작은 모델)로만. 소리는 밖으로 안 나간다 */
    /** 호출어 판단용 받아 적기. model: 쓰고 싶은 모델 (받아 두지 않았으면 받아 둔 가장 작은 모델) */
    localQuick(wav: Uint8Array, model?: LocalSttModel): Promise<{ text: string; model: string }>;
    /** 호출어 판단 결과를 whisper.log에 남긴다 (이 컴퓨터 안에만) */
    wakeLog(entry: { model: string; text: string; result: 'match' | 'no' | 'noise' }): Promise<void>;
    testServer(cfg: SttSettings['server']): Promise<SttServerTest>;
    testCloud(cfg: SttSettings['cloud']): Promise<{ models: string[] }>;
    localStatus(): Promise<LocalSttStatus>;
    localDownload(model: LocalSttModel): Promise<boolean>;
    localCancel(): Promise<boolean>;
    onLocalProgress(cb: (p: LocalSttProgress) => void): () => void;
  };
  tools: {
    prepare(req: ToolRequest): Promise<PrepareResult>;
    execute(id: string, opts?: { overwrite?: boolean }): Promise<ExecuteResult>;
    cancel(id: string): Promise<boolean>;
    validateRoots(list: RootEntry[]): Promise<{ roots: RootEntry[]; errors: RootError[] }>;
    defaultRoots(): Promise<RootEntry[]>;
    pickFolder(): Promise<PickedFolder | null>;
    openLog(): Promise<boolean>;
    openRoot(dir: string): Promise<boolean>;
  };
  files: {
    /** 받은 파일 폴더 (설정이 비었으면 기본 경로). 편집 중인 값을 넘기면 그 값 기준 */
    receivedDir(dir?: string): Promise<{ path: string; isDefault: boolean; defaultPath: string }>;
    /** 받은 파일 폴더 고르기 (고르는 창). 취소면 null */
    pickReceivedDir(): Promise<string | null>;
    /** 받은 파일 폴더를 Finder/탐색기에서 열기 (없으면 만든다) */
    openReceivedDir(dir?: string): Promise<boolean>;
  };
  remote: {
    status(): Promise<RemoteStatus>;
    /** 인증 앱 키를 새로 만든다 (있던 키는 폐기, 잠금). QR 그림(data URL)과 복구 코드는 이때 한 번만 보여 준다 */
    newKey(): Promise<{ qr: string; secret: string; recovery: string[] }>;
    /** 인증 앱에 등록한 코드가 맞는지 시험 (잠금은 풀지 않음) */
    checkCode(code: string): Promise<boolean>;
    lock(): Promise<RemoteStatus>;
    setStopped(on: boolean): Promise<RemoteStatus>;
    /** 설정을 저장한 뒤 디스코드에 다시 연결 */
    reconnect(): Promise<RemoteStatus>;
    /** 입력한 값으로 먼저 연결해 보고, 되면 저장한다 */
    connectDiscord(input: { enabled: boolean; apiKey: string; userId: string }): Promise<{ ok: boolean; error: string; status: RemoteStatus }>;
    /** 내 서버 프로필로 이 컴퓨터를 등록 */
    serverRegister(profile: string, name: string): Promise<RemoteStatus>;
    serverUnregister(): Promise<RemoteStatus>;
    /** 서버 원격 허용 스위치 */
    serverAllow(on: boolean): Promise<RemoteStatus>;
    /** 기록해 둔 보낸 파일 메시지를 날짜와 상관없이 모두 지운다 */
    deleteAllSent(): Promise<{ deleted: number; failed: number }>;
    openSentLog(): Promise<boolean>;
    onEvent(cb: (ev: RemoteEvent) => void): () => void;
    /** 메신저 대화(chat 이벤트)에 대한 답 */
    /** text가 없으면 원격 허브가 파일 작업 결과를 이미 보냈다. */
    reply(reqId: string, text: string | void): void;
    /** 메신저 대화 중 AI 서버가 요청한 파일 작업 (메신저 규칙으로 확인·실행) */
    runAction(reqId: string, action: string, args: ActionArgs): Promise<ActionReport>;
    /** 받은 파일 내려받기 (받은 파일 폴더로) */
    download(fileId: string): Promise<ReceivedDownload>;
  };
  media: {
    askMic(): Promise<boolean>;
    recording(on: boolean): void;
  };
  live2d: {
    status(): Promise<{ core: boolean; userDir: string }>;
  };
  win: {
    showChat(): Promise<boolean>;
    onCommand(cb: (c: AppCommand) => void): () => void;
  };
  wake: {
    /** "네 말씀하세요" 음성 파일 고르기 → 사용자 데이터 폴더 sounds/ 에 복사하고 파일 이름을 돌려준다 (취소면 null) */
    pickAck(): Promise<{ file: string } | null>;
    /** 복사해 둔 음성 파일 읽기 */
    ackAudio(file: string): Promise<TtsResult>;
  };
  mascot: {
    relay(msg: MascotMessage): void;
    /** 항상 듣기(호출어) 켜기/끄기 */
    wake(): void;
    onUpdate(cb: (m: MascotMessage) => void): () => void;
    hover(on: boolean): void;
    drag(phase: DragPhase): void;
    click(): void;
    mic(): void;
    hide(): void;
  };
}

/** IPC 응답 모양: 오류를 { ok:false, error } 로 돌려준다 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };
