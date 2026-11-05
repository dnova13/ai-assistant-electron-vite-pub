// 메인 프로세스: 설정, 서버 통신, 파일 작업, 창·트레이·단축키를 묶는다.
// 화면(렌더러)은 preload가 열어 준 IPC로만 이 기능들을 쓴다.
import { app, ipcMain, shell, dialog, session, systemPreferences, safeStorage, globalShortcut, utilityProcess } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { remoteCharacter, NO_REMOTE_CHARACTER } from '@shared/remote-character';
import { formatBytes } from '@shared/local-files';
import fs from 'node:fs';
import os from 'node:os';
import QRCode from 'qrcode';

import * as appProtocol from './protocol';
import { createStore } from './settings';
import type { SettingsStore } from './settings';
import { createHistory } from './history';
import type { History } from './history';
import * as api from './api/client';
import * as stt from './stt';
import * as tts from './tts';
import { LocalStt } from './stt-local';
import { normalizeStt, LOCAL_MODELS } from '@shared/stt';
import { normalizeTtsOut } from '@shared/voice';
import { blankProfile, charProfile, migrateCharPrefs, migrateWakeName, withCharacter } from '@shared/char-prefs';
import { normalizeWake, wakeModel } from '@shared/wake';
import * as policy from './tools/policy';
import { ToolBroker } from './tools/broker';
import { selectNameMatcher } from './tools/name-method';
import { createAudit } from './tools/audit';
import type { Audit } from './tools/audit';
import { WindowManager } from './windows';
import { allowedRootDir, emptyTrash, receivedDir, receivedRootEntry } from './files';
import { createRemoteState } from './remote/state';
import type { RemoteState } from './remote/state';
import { createSentStore } from './remote/sent';
import type { SentStore } from './remote/sent';
import { RemoteHub, SOURCE_LABEL, newHubCounters } from './remote/hub';
import { DiscordTransport } from './remote/discord';
import { connectThenSave } from './remote/discord-connect';
import { AUTH_REQUIRED } from '@shared/remote-auth';
import { ServerLink } from './remote/server-link';
import { ServerTransport, fetchDiscordFile, handleServerMessage } from './remote/server-hub';
import { serverFileChat } from './remote/file-chat';
import { cleanOrder, setLocked, sortCharacters } from '@shared/character-order';
import { IMAGE_EXTS, addImageCharacter, addLive2dCharacter, afterDelete, characterPath, cleanName, deleteCharacter, replaceCharacterImage, resetBuiltinCharacter, updateCharacter } from './character-add';
import { dirOfCharacter, migrateOldCharacters, scanCharacterDirs } from './character-dirs';
import type {
  ChatRequest,
  ChatWireEvent,
  Character,
  DragPhase,
  IpcResult,
  MascotMessage,
  Profile,
  RootEntry,
  Settings,
  SettingsSaveResult,
  ToolRequest,
  ActionReport,
  ActionArgs,
  LocalSttModel,
  RemoteEvent,
  RemoteStatus
} from '@shared/types';

appProtocol.registerScheme(); // ready 전에

// 두 번 실행하면 새로 띄우지 않고 이미 떠 있는 창을 보여 준다 (단축키·트레이가 겹치지 않게)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// 개발 중(npm run dev)에는 Vite 개발 서버가 화면을 내보낸다
const DEV_URL = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL.replace(/\/+$/, '') : null;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : null;
const ORIGIN = appProtocol.ORIGIN;
const ALLOWED_ORIGINS = DEV_ORIGIN ? [ORIGIN, DEV_ORIGIN] : [ORIGIN];

const APP_ROOT = app.getAppPath(); // 프로젝트 폴더 (설치본은 app.asar)
/** 기본 캐릭터 폴더 (읽기 전용: 개발 중 characters/, 설치본은 앱에 묶인 characters/) */
let charactersDir = '';
/** 내가 추가한 캐릭터 폴더 (추가·수정·삭제는 여기서만: 개발 중 my-characters/, 설치본은 사용자 데이터 폴더의 my-characters/) */
let myCharactersDir = '';
let store: SettingsStore;
let settings: Settings;
let history: History;
let broker: ToolBroker;
let audit: Audit;
let windows: WindowManager;
let localStt: LocalStt;
const chats = new Map<string, AbortController>(); // reqId -> 중단용
// 원격(메신저): 인증 상태, 보낸 파일 기록, 규칙(hub), 디스코드 연결
let remoteState: RemoteState;
let sentStore: SentStore;
let hub: RemoteHub;
let discord: DiscordTransport | null = null;
let serverLink: ServerLink | null = null;
let serverHub: RemoteHub;
let serverTransport: ServerTransport;
let serverLinkError = ''; // 연결을 시작하지 못한 이유 (프로필 없음 등)
const remoteChats = new Map<string, (text: string | void) => void>(); // 메신저 대화 reqId -> 화면의 답을 기다리는 곳

/* ---------------- 설정 ---------------- */

function defaultRoots(): RootEntry[] {
  const roots: RootEntry[] = [];
  for (const [id, label] of [
    ['documents', '문서'],
    ['downloads', '다운로드'],
    ['desktop', '바탕화면']
  ] as const) {
    try {
      roots.push({ id, label, path: app.getPath(id) });
    } catch {
      /* 없는 경우 */
    }
  }
  return roots;
}

const rootList = (): RootEntry[] => (settings.tools.allowedRoots == null ? defaultRoots() : settings.tools.allowedRoots);
/** 받은 파일 폴더 (설정이 비었으면 다운로드/AI비서 받은 파일) */
const receivedInfo = (dir = settings.files.receivedDir) => receivedDir({ receivedDir: dir }, app.getPath('downloads'));
// 받은 파일 폴더는 자동으로 허용 폴더에 들어간다 (사용자가 고른 다른 폴더는 설정 > 파일 제어 > 허용 경로에서 허락)
const validRoots = () => {
  const extra = receivedRootEntry(receivedInfo().path);
  return policy.validateRoots(extra ? [...rootList(), extra] : rootList()).roots;
};
const remoteRoots = () => validRoots().filter((r) => r.remote);
// AI와 목소리는 캐릭터마다 고른다. 지금 캐릭터(또는 요청에 적힌 캐릭터) 기준으로 바꿔 끼운 설정을 쓴다
const NO_AI = '이 캐릭터가 쓸 AI가 선택되지 않았습니다. 설정 > 캐릭터 > 프로필 > AI에서 골라 주세요.';
const charView = (charId = settings.character): Settings => withCharacter(settings, charId);
/** 캐릭터의 AI. 고르지 않았으면 오류 (대화·연결 확인) */
function needProfile(charId = settings.character): Profile {
  const p = charProfile(settings, charId);
  if (!p) throw new api.ApiError(Object.keys(settings.profiles).length ? NO_AI : 'AI 프로필이 없습니다. 설정 > AI에서 추가해 주세요.', 'no_profile');
  return p;
}
/** 캐릭터의 AI. 없으면 빈 프로필 (음성 인식·TTS가 대화 서버를 빌릴 때: 없으면 그 단계만 안 된다) */
const softProfile = (charId = settings.character): Profile => charProfile(settings, charId) || { ...blankProfile(''), baseUrl: '' };

// 연결 테스트처럼 화면이 편집 중인 프로필을 줄 때만 그것을 쓴다
function pickProfile(p: unknown): Profile {
  if (p && typeof p === 'object' && typeof (p as Profile).baseUrl === 'string') return { ...blankProfile(''), ...(p as Partial<Profile>) };
  return needProfile();
}

/** 앱 안 위스퍼 작업 프로세스의 기록 (1MB가 넘으면 앞부분을 버리고 새로 쓴다) */
let whisperLog = '';
function writeWorkerLog(line: string): void {
  if (!whisperLog) return;
  try {
    fs.mkdirSync(path.dirname(whisperLog), { recursive: true });
    if (fs.existsSync(whisperLog) && fs.statSync(whisperLog).size > 1024 * 1024) fs.renameSync(whisperLog, whisperLog + '.1');
    fs.appendFileSync(whisperLog, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 기록 실패는 무시 */
  }
}

function patchSettings(patch: Partial<Settings>): Settings {
  settings = store.save({ ...settings, ...patch });
  return settings;
}

/* ---------------- 캐릭터 ---------------- */

function ensureCharacters(): void {
  // 설치본: 예전에는 사용자 데이터 폴더의 characters 에 기본+추가가 섞여 있었다 → 추가한 것만 my-characters로 복사 (원래 폴더는 그대로 둠)
  if (app.isPackaged) migrateOldCharacters(path.join(app.getPath('userData'), 'characters'), myCharactersDir);
  else fs.mkdirSync(myCharactersDir, { recursive: true });
}

function scanCharacters(): Character[] {
  return scanCharacterDirs(charactersDir, myCharactersDir);
}

/* ---------------- IPC ---------------- */

const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame ? event.senderFrame.url : '';
  return ALLOWED_ORIGINS.some((o) => url.startsWith(o + '/'));
};

// 오류를 { ok:false, error } 로 돌려준다 (Electron이 붙이는 긴 오류 문구를 피하려고)
function handle<A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<R>> => {
    if (!fromApp(event)) return { ok: false, error: '허용되지 않은 요청입니다.' };
    try {
      return { ok: true, data: await fn(event, ...(args as A)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e), code: (e as { code?: string }).code };
    }
  });
}

// 응답이 필요 없는 잦은 메시지 (입 모양 등)
function on<A extends unknown[]>(channel: string, fn: (event: IpcMainEvent, ...args: A) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (fromApp(event)) fn(event, ...(args as A));
  });
}

/* ---------------- 원격 (메신저) ---------------- */

const toRenderer = (channel: string, msg: unknown): void => {
  const wc = windows && windows.main && !windows.main.isDestroyed() ? windows.main.webContents : null;
  if (wc) wc.send(channel, msg);
};
interface RemoteRequestContext { characterId: string; profile?: Profile; persona?: string }
const remoteScope = new AsyncLocalStorage<RemoteRequestContext>();
const remoteChatContexts = new Map<string, RemoteRequestContext>();

/** 인증을 통과한 서버 파일 요청만 등록 프로필의 첫 표시 캐릭터로 배정한다. */
async function prepareServerCharacter(): Promise<string | void> {
  const context = remoteScope.getStore();
  if (!context) return NO_REMOTE_CHARACTER;
  if (context.characterId) return;
  const profileId = remoteState.server().profile;
  const character = remoteCharacter(settings, scanCharacters(), profileId);
  if (!character) return NO_REMOTE_CHARACTER;
  context.characterId = character.id;
  context.persona = character.config.persona || '';
  context.profile = serverProfile(profileId) || undefined;
  if (settings.character !== character.id) {
    settings = patchSettings({ prevCharacter: settings.character, character: character.id });
    windows.relay({ type: 'settings' }); windows.command('settingsChanged'); windows.updateTray();
  }
}

const emitRemote = (ev: RemoteEvent): void => {
  const context = remoteScope.getStore();
  if (context?.characterId && (ev.type === 'line' || ev.type === 'received')) {
    const id = randomUUID(), time = new Date().toISOString();
    history.append(context.characterId, [{ id, time, role: ev.type === 'line' ? ev.role : 'bot',
      text: ev.type === 'line' ? ev.text : `파일 받음: ${ev.name} (${formatBytes(ev.size)})`, source: ev.source, memory: false }]);
    ev = { ...ev, characterId: context.characterId, historyId: id, time };
  }
  toRenderer('remote:event', ev);
  // 설정창에는 연결 상태만 보낸다. 대화와 파일 내용은 대화창에만 전달한다.
  if (ev.type === 'status') windows.settingsWindow?.webContents.send('remote:event', ev);
};

function remoteStatus(): RemoteStatus {
  const d = discord ? discord.status : { connected: false, connecting: false, botName: '', error: '' };
  const link = remoteState.server();
  const st = serverLink ? serverLink.status : ({ state: 'off', error: '' } as const);
  return {
    enabled: settings.remote.enabled,
    connected: d.connected,
    connecting: d.connecting,
    botName: d.botName,
    error: d.error,
    keySet: remoteState.hasKey(),
    unlockedUntil: remoteState.unlockedUntil(),
    stopped: remoteState.isStopped(),
    recoveryLeft: remoteState.recoveryLeft(),
    sentCount: sentStore.count(),
    server: {
      on: link.on,
      registered: link.attached && !!link.computerId,
      name: link.attached ? link.computerName : '',
      profile: link.profile,
      state: st.state,
      error: serverLinkError || st.error
    }
  };
}
const pushRemoteStatus = (): void => emitRemote({ type: 'status', status: remoteStatus() });

/** 메신저 대화: 화면(지금 캐릭터)이 답하게 하고 그 답을 기다린다 */
function remoteChat(text: string): Promise<string | void> {
  return new Promise((resolve, reject) => {
    if (!windows || !windows.main || windows.main.isDestroyed()) return reject(new Error('앱 대화 창이 준비되지 않았습니다.'));
    const reqId = `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      remoteChats.delete(reqId); remoteChatContexts.delete(reqId);
      reject(new Error('답을 기다리는 시간이 지났습니다.'));
    }, 5 * 60_000);
    const context = remoteScope.getStore() || { characterId: settings.character };
    remoteChatContexts.set(reqId, context);
    remoteChats.set(reqId, (answer) => {
      clearTimeout(timer);
      remoteChats.delete(reqId); remoteChatContexts.delete(reqId);
      resolve(answer);
    });
    emitRemote({ type: 'chat', reqId, text, source: SOURCE_LABEL, characterId: context.characterId });
  });
}

/** 설정대로 디스코드에 연결하거나 끊는다 */
/** 지금 연결을 끊고 그 값으로 연결을 시작한다 (준비 완료는 기다리지 않는다) */
async function startDiscord(apiKey: string, userId: string): Promise<DiscordTransport> {
  resetRemoteAuthentication();
  if (discord) await discord.stop();
  const d = new DiscordTransport(() => pushRemoteStatus(), (q, a, signal) => api.interpretConfirmation(needProfile(), q, a, signal));
  discord = d;
  hub.transport = d;
  try {
    await d.start(apiKey, userId, (m) => void remoteScope.run({ characterId: settings.character }, () => hub.onMessage(m)), () => d.send(AUTH_REQUIRED));
  } catch (e) {
    throw new Error(d.status.error || (e as Error).message); // 안내 문구로 바꾼 이유를 쓴다
  }
  return d;
}

async function restartRemote(): Promise<void> {
  if (discord || settings.remote.enabled) resetRemoteAuthentication();
  if (discord) await discord.stop();
  discord = null;
  hub.transport = null;
  const r = settings.remote;
  if (r.enabled && r.discord.apiKey && r.discord.userId) {
    try {
      await startDiscord(r.discord.apiKey, r.discord.userId);
      void hub.deleteSent().catch(() => {});
    } catch (e) {
      console.warn('디스코드 연결 실패:', (e as Error).message);
    }
  } else if (r.enabled) {
    emitRemote({ type: 'status', status: { ...remoteStatus(), error: '봇 토큰과 내 디스코드 사용자 ID를 넣어 주세요.' } });
    return;
  }
  pushRemoteStatus();
}

/** 인증 상태는 두 연결에서 공유한다. 연결 해제 시 기존 확인 요청도 끝낸다. */
function resetRemoteAuthentication(): void {
  hub.resetAuthentication();
  serverHub.resetAuthentication();
  pushRemoteStatus();
}

function discordConnectionKey(): string {
  const r = settings.remote;
  return JSON.stringify([r.enabled, r.discord.apiKey, r.discord.userId]);
}

/** 내 서버 프로필. 없거나 내 서버가 아니면 null */
function serverProfile(id: string): Profile | null {
  const p = settings.profiles[id];
  return p && p.type === 'assistant' ? p : null;
}

/** 스위치가 켜져 있으면 다시 연결하고, 꺼져 있으면 끊는다 */
function restartServerLink(): void {
  if (serverLink) serverLink.stop();
  serverLink = null;
  serverLinkError = '';
  const info = remoteState.server();
  if (info.attached && info.on && info.computerId) {
    const p = serverProfile(info.profile);
    if (!p || !p.baseUrl || !p.apiKey) {
      serverLinkError = '등록에 쓴 내 서버 프로필을 찾지 못했습니다. 설정 > AI에서 주소와 키를 확인하세요.';
    } else {
      serverLink = new ServerLink({
        url: api.computerLinkUrl(p.baseUrl),
        key: p.apiKey,
        computerId: info.computerId,
        onChange: () => pushRemoteStatus(),
        onRejected: (reason) => {
          // 서버에서 등록을 지웠다: 스위치를 끄고 다시 등록하게 한다. 이유는 화면에 남긴다
          if (reason === 'unknown_computer') remoteState.detachServer();
          audit.log({ status: 'rejected', action: 'remote.serverLink', source: { kind: 'local' }, detail: reason });
          pushRemoteStatus();
        },
        onRenamed: (name) => {
          remoteState.setServer({ computerName: name });
          pushRemoteStatus();
        },
        onMessage: (m) => handleServerMessage(serverTransport, m, (msg) => remoteScope.run({ characterId: '' }, () => serverHub.onMessage(msg))),
        onDown: () => serverTransport.cancelWaiting()
      });
      serverLink.start();
    }
  }
  pushRemoteStatus();
}

const serverProfileKey = (id: string): string => {
  const p = serverProfile(id);
  return p ? JSON.stringify([p.baseUrl, p.apiKey]) : '';
};

/** 앱을 켤 때와 몇 시간마다: _to_delete 자동 비우기, 기간이 지난 보낸 파일 메시지 지우기 */
function housekeeping(): void {
  try {
    if (settings.files.trashMode === 'auto') {
      const n = emptyTrash(validRoots(), settings.files.trashDays);
      if (n) audit.log({ status: 'done', action: 'trash.empty', removed: n, days: settings.files.trashDays, source: { kind: 'local' } });
    }
  } catch (e) {
    console.error('자동 비우기 실패:', e);
  }
  if (hub && hub.transport && discord && discord.status.connected) {
    void hub
      .deleteSent()
      .then((r) => r.deleted && pushRemoteStatus())
      .catch(() => {});
  }
}

function registerIpc(): void {
  const settingsSender = (e: IpcMainInvokeEvent | IpcMainEvent) => e.sender === windows.settingsWindow?.webContents;
  const chatSender = (e: IpcMainInvokeEvent | IpcMainEvent) => e.sender === windows.main?.webContents;
  handle('settings-window:open', (_e, tab: unknown) => { windows.showSettings(tab === 'character' ? 'character' : undefined); return true; });
  handle('settings-window:close', (e) => { if (!settingsSender(e)) throw new Error('설정창 요청이 아닙니다.'); windows.settingsWindow?.close(); return true; });
  handle('settings-window:refresh', (e) => { if (!settingsSender(e)) throw new Error('설정창 요청이 아닙니다.'); windows.command('settingsSnapshot'); return true; });
  handle('settings-window:call', (e, method: unknown, args: unknown) => {
    if (!settingsSender(e) || !windows.main || windows.main.isDestroyed()) throw new Error('설정 요청을 처리할 대화창이 없습니다.');
    return windows.settingsBridge.call(method, args, (call) => windows.main!.webContents.send('settings-window:request', call));
  });
  on('settings-window:publish', (e, view: unknown) => { if (chatSender(e)) windows.settingsWindow?.webContents.send('settings-window:view', view); });
  on('settings-window:reply', (e, id: string, value: unknown, error?: string) => { if (chatSender(e)) windows.settingsBridge.finish(id, value, error); });

  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    charactersDir,
    myCharactersDir,
    logFile: audit.file,
    historyDir: history.dir,
    encrypted: store.encrypted(),
    shortcut: windows.ptt
  }));

  handle('settings:load', () => ({ settings, roots: rootList() }));
  handle('settings:save', (_e, next: Settings): SettingsSaveResult => {
    const prevKeys = { ...settings.shortcut };
    const prevRemote = discordConnectionKey();
    const prevServerProfile = serverProfileKey(remoteState.server().profile);
    // 캐릭터를 바꾸면 직전 캐릭터를 기억한다 (그 캐릭터를 삭제하면 직전 것으로 돌아가려고)
    if (next && typeof next.character === 'string' && next.character !== settings.character) next = { ...next, prevCharacter: settings.character };
    else if (next) next = { ...next, prevCharacter: settings.prevCharacter };
    if (next) next = { ...next, characterOrder: settings.characterOrder, lockedCharacters: settings.lockedCharacters, hiddenCharacters: settings.hiddenCharacters }; // 순서는 characters:setOrder로만 바꾼다 (설정창을 오래 열어 둬도 되돌아가지 않게)
    settings = store.save(next);
    // 단축키가 안 되면 이전 것으로 되돌리고 알려 준다
    const scErr = windows.setShortcuts(settings.shortcut).errors;
    let shortcutError: string | null = null;
    if (scErr.ptt || scErr.ttsToggle) {
      shortcutError = [scErr.ptt, scErr.ttsToggle].filter(Boolean).join('\n');
      const sc = { ...settings.shortcut };
      if (scErr.ptt) sc.ptt = windows.keys.ptt || prevKeys.ptt;
      if (scErr.ttsToggle) sc.ttsToggle = windows.keys.ttsToggle || prevKeys.ttsToggle;
      settings = store.save({ ...settings, shortcut: sc });
    }
    if (windows.main) windows.main.setAlwaysOnTop(!!settings.alwaysOnTop);
    windows.setMascot(!!settings.mascot.enabled);
    windows.relay({ type: 'settings' });
    windows.updateTray();
    const { errors } = policy.validateRoots(rootList());
    // 기간만 저장할 때는 인증을 유지하고, 연결 정보가 바뀐 경우에만 다시 연결한다.
    if (discordConnectionKey() !== prevRemote) void restartRemote();
    if (serverProfileKey(remoteState.server().profile) !== prevServerProfile) restartServerLink();
    return { settings, roots: rootList(), rootErrors: errors, shortcutError };
  });

  handle('characters:list', () => sortCharacters(scanCharacters(), settings.characterOrder));
  handle('characters:setHidden', (_e, id: unknown, hidden: unknown) => {
    const next = setLocked(settings.hiddenCharacters, String(id ?? ''), !!hidden, scanCharacters().map((c) => c.id));
    settings = patchSettings({ hiddenCharacters: next });
    windows.relay({ type: 'settings' }); windows.command('settingsChanged');
    return next;
  });
  handle('characters:reset', (_e, id: unknown) => {
    resetBuiltinCharacter(charactersDir, myCharactersDir, id);
    const characterAi = { ...settings.characterAi }, characterVoice = { ...settings.characterVoice };
    delete characterAi[String(id)]; delete characterVoice[String(id)];
    settings = patchSettings({ characterAi, characterVoice });
    windows.relay({ type: 'settings' }); windows.command('settingsChanged');
    return true;
  });
  // 삭제 잠금: 잠긴 캐릭터는 ✕로 지울 수 없다 (바로 저장)
  handle('characters:setLocked', (_e, id: unknown, locked: unknown) => {
    const next = setLocked(settings.lockedCharacters, String(id ?? ''), !!locked, scanCharacters().map((c) => c.id));
    settings = patchSettings({ lockedCharacters: next });
    windows.relay({ type: 'settings' });
    return next;
  });
  // 캐릭터 순서: 선택 바·설정 > 캐릭터 > 순서에서 바꾸면 바로 저장한다
  handle('characters:setOrder', (_e, order: unknown) => {
    const next = cleanOrder(order, scanCharacters().map((c) => c.id));
    settings = patchSettings({ characterOrder: next });
    windows.relay({ type: 'settings' });
    return next;
  });
  // 캐릭터 추가: 화면은 이름·성격·종류만 보내고, 파일 고르기와 복사는 메인이 한다 (화면은 경로를 모름)
  handle('characters:add', async (_e, req: unknown) => {
    const r = (req && typeof req === 'object' ? req : {}) as { kind?: unknown; name?: unknown; persona?: unknown };
    cleanName(r.name); // 대화 상자를 띄우기 전에 이름부터 확인
    const live2d = r.kind === 'live2d';
    const opts = live2d
      ? { title: 'Live2D 모델 폴더 고르기 (.model3.json이 든 폴더)', properties: ['openDirectory'] as 'openDirectory'[] }
      : { title: '캐릭터 그림 고르기', properties: ['openFile'] as 'openFile'[], filters: [{ name: '그림 파일', extensions: IMAGE_EXTS.map((x) => x.slice(1)) }] };
    const picked = (windows.settingsWindow || windows.main) ? await dialog.showOpenDialog((windows.settingsWindow || windows.main)!, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return null;
    const input = { name: r.name, persona: r.persona };
    const c = live2d ? addLive2dCharacter(myCharactersDir, picked.filePaths[0], input, charactersDir) : addImageCharacter(myCharactersDir, picked.filePaths[0], input, charactersDir);
    return { id: c.id, name: c.config.name || c.id };
  });
  // 고른 캐릭터 수정: 이름·성격, 그림 바꾸기(이전 그림은 지움), 폴더 열기
  handle('characters:update', (_e, id: unknown, req: unknown) => {
    const r = (req && typeof req === 'object' ? req : {}) as { name?: unknown; persona?: unknown };
    const c = updateCharacter(myCharactersDir, id, { name: r.name, persona: r.persona }, charactersDir);
    return { id: c.id, name: c.config.name || c.id };
  });
  handle('characters:replaceImage', async (_e, id: unknown) => {
    const root = dirOfCharacter(charactersDir, myCharactersDir, String(id ?? ''));
    if (!root) throw new Error('캐릭터를 찾지 못했습니다.');
    characterPath(root, id); // 창을 띄우기 전에 캐릭터부터 확인
    const opts = { title: '바꿀 그림 고르기', properties: ['openFile'] as 'openFile'[], filters: [{ name: '그림 파일', extensions: IMAGE_EXTS.map((x) => x.slice(1)) }] };
    const picked = (windows.settingsWindow || windows.main) ? await dialog.showOpenDialog((windows.settingsWindow || windows.main)!, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return null;
    const c = replaceCharacterImage(myCharactersDir, id, picked.filePaths[0], charactersDir);
    return { id: c.id, name: c.config.name || c.id };
  });
  handle('characters:openOne', async (_e, id: unknown) => {
    // 폴더 열기는 읽기만이라 기본 캐릭터도 된다
    const where = dirOfCharacter(charactersDir, myCharactersDir, String(id ?? ''));
    if (!where) throw new Error('캐릭터를 찾지 못했습니다. 목록을 새로고침하세요.');
    const err = await shell.openPath(characterPath(where, id));
    if (err) throw new Error(err);
    return true;
  });
  // 캐릭터 삭제 (실제로 지움, 기본 캐릭터는 안 됨). 지금 캐릭터를 지웠으면 직전 캐릭터 → 없으면 기본 캐릭터로
  handle('characters:remove', (_e, id: unknown) => {
    const del = String(id ?? '');
    if (settings.lockedCharacters.includes(del)) throw new Error('잠겨 있어서 삭제할 수 없습니다. 잠금을 먼저 풀어 주세요.');
    deleteCharacter(myCharactersDir, del); // 기본 캐릭터 폴더는 넘기지 않는다
    const left = new Set(scanCharacters().map((c) => c.id));
    const next = afterDelete(settings.character, settings.prevCharacter, del, (x) => left.has(x));
    if (next.character !== settings.character || next.prevCharacter !== settings.prevCharacter) {
      settings = patchSettings(next);
      windows.relay({ type: 'settings' });
    }
    return next;
  });

  // 캐릭터별 대화 기록
  handle('history:load', (_e, id: unknown) => history.load(String(id || '')));
  handle('history:append', (_e, id: unknown, entries: unknown) => history.append(String(id || ''), entries));
  handle('history:clear', (_e, id: unknown) => !!history.clear(String(id || '')));

  // 서버 통신 ----------------------------------------------------------
  handle('api:health', (_e, profile: unknown) => api.health(pickProfile(profile)));

  // 대화는 시작만 하고 바로 돌아간다. 이벤트와 끝 신호(_end)는 같은 통로(api:event)로 보낸다.
  // invoke 응답과 send 메시지는 도착 순서가 보장되지 않아서, 끝을 invoke 응답으로 알리면 마지막 이벤트를 놓친다.
  handle('api:chat', (event, reqIdRaw: unknown, reqRaw: unknown) => {
    const reqId = String(reqIdRaw);
    const req = (reqRaw && typeof reqRaw === 'object' ? reqRaw : {}) as Partial<ChatRequest>;
    const text = String(req.text || '').slice(0, 8000);
    const character = String(req.character || '');
    const ctrl = new AbortController();
    chats.set(reqId, ctrl);
    const sender = event.sender;
    let full = '';
    let finished = false;
    const send = (ev: ChatWireEvent) => {
      if (!sender.isDestroyed()) sender.send('api:event', { reqId, event: ev });
    };
    // Ollama 직접 모드의 대화 기억 = 이 캐릭터의 기록 (비서 서버는 session별로 서버가 기억)
    let profile: Profile;
    try {
      profile = needProfile(character || settings.character);
    } catch (e) {
      setTimeout(() => send({ type: '_end', error: (e as Error).message, code: 'no_profile' }), 0);
      chats.delete(reqId);
      return true;
    }
    const records = history.load(character);
    const past = records.filter(m => m.id !== reqId + ':user').filter(m => m.memory !== false && (m.role === 'user' || m.role === 'bot')).map((m) => ({ role: m.role === 'bot' ? ('assistant' as const) : ('user' as const), content: m.text }));
    const source = req.source === SOURCE_LABEL ? SOURCE_LABEL : undefined;
    const sentAt = typeof req.time === 'number' && Number.isFinite(req.time) && Math.abs(req.time - Date.now()) < 86400000 ? req.time : Date.now();
    const userEntry = { id: reqId + ':user', role: 'user' as const, text: records.find(m => m.id === reqId + ':user')?.text || text, source, time: new Date(sentAt).toISOString() };
    history.append(character, [userEntry]);
    let action = false, firstAnswerAt = '';
    api
      .chat(
        profile,
        {
          text,
          input: req.input === 'voice' ? 'voice' : 'text',
          session: character,
          lowSpec: settings.lowSpec,
          history: past,
          client: { os: process.platform, app: app.getVersion(), character, persona: String(req.persona || '') }
        },
        (ev) => {
          if (ev.type === 'client_action') { action = true; history.append(character, [{ ...userEntry, memory: false }]); }
          if ((ev.type === 'delta' || ev.type === 'done') && !firstAnswerAt) firstAnswerAt = new Date().toISOString();
          if (ev.type === 'delta') full += ev.text;
          if (ev.type === 'done') {
            finished = true;
            if (ev.text) full = ev.text;
          }
          send(ev);
        },
        ctrl.signal
      )
      .then(() => {
        if (finished && full.trim()) history.append(character, [{ id: reqId + ':bot', role: 'bot', text: full, source, time: firstAnswerAt || new Date().toISOString(), memory: !action }]);
        send({ type: '_end' });
      })
      .catch((e: api.ApiError) => send({ type: '_end', error: e.message || String(e), code: e.code }))
      .finally(() => chats.delete(reqId));
    return true;
  });
  handle('api:abort', (_e, reqId: unknown) => {
    const c = chats.get(String(reqId));
    if (c) c.abort();
    return !!c;
  });
  handle('api:interpretConfirmation', (_e, question: string, answer: string) => api.interpretConfirmation(needProfile(), String(question), String(answer)));
  handle('api:confirm', (_e, id: unknown, approve: unknown) => api.confirm(needProfile(), String(id), !!approve));
  handle('api:report', (_e, id: unknown, result: ActionReport) => api.reportAction(needProfile(), String(id), result || { status: 'failed', detail: '' }));
  // 음성 인식: 설정 > 음성의 순서대로 시도 (대화 AI와 따로)
  handle('api:stt', (_e, audio: Uint8Array, mime: unknown) => {
    const buf = Buffer.from(audio);
    if (buf.length > 10 * 1024 * 1024) throw new Error('음성이 너무 깁니다 (10MB 이하).');
    return stt.transcribe(buf, String(mime || 'audio/wav'), { settings: charView(), chatProfile: softProfile(), local: localStt });
  });
  // 설정 창의 연결 테스트 (편집 중인 값을 받는다)
  handle('stt:testServer', (_e, cfg: unknown) => stt.detectServer(normalizeStt({ server: cfg }).server));
  handle('stt:testCloud', (_e, cfg: unknown) => stt.testCloud(settings, normalizeStt({ cloud: cfg }).cloud));
  handle('stt:localStatus', () => localStt.status());
  handle('stt:localDownload', (_e, model: unknown) => {
    if (!LOCAL_MODELS.includes(model as LocalSttModel)) throw new Error('알 수 없는 모델입니다.');
    return localStt.download(model as LocalSttModel);
  });
  handle('stt:localCancel', () => localStt.cancel());
  // 호출어: 짧은 말소리 구간을 앱 안 위스퍼(받아 둔 가장 작은 모델)로만 받아 적는다. 소리는 밖으로 안 나가고 저장하지 않는다
  handle('stt:localQuick', async (_e, wav: unknown, want: unknown) => {
    const model = wakeModel(localStt.status().downloaded, LOCAL_MODELS.includes(want as LocalSttModel) ? (want as LocalSttModel) : undefined);
    if (!model) throw new Error('이 컴퓨터용 위스퍼 모델이 없습니다 (설정 > 음성).');
    const buf = Buffer.from(wav as Uint8Array);
    if (buf.length > 16000 * 2 * 6 + 1000) throw new Error('호출어 구간이 너무 깁니다.');
    const text = await Promise.race([
      localStt.transcribe(buf, model),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error('이 컴퓨터 위스퍼가 답하지 않습니다.')), 15000))
    ]);
    return { text, model };
  });
  // 호출어 판단 결과를 whisper.log에 남긴다: 위스퍼가 무엇으로 들었는지 보려고 (이 컴퓨터 안에만, 한 줄 200자까지)
  handle('stt:wakeLog', (_e, entry: unknown) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as { model?: unknown; text?: unknown; result?: unknown };
    const one = (v: unknown, max: number) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
    const result = e.result === 'match' ? '맞음' : e.result === 'noise' ? '잡음으로 봄' : '아님';
    writeWorkerLog(`[호출어] ${one(e.model, 10)}: "${one(e.text, 200)}" → ${result}`);
  });
  // "네 말씀하세요" 음성 파일: 고른 파일을 사용자 데이터 폴더 sounds/ 에 복사해 두고 이름으로만 읽는다
  const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
  const AUDIO_MIME: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.webm': 'audio/webm' };
  handle('wake:pickAck', async (_e) => {
    const opts = { title: '"네 말씀하세요" 음성 파일', properties: ['openFile'] as 'openFile'[], filters: [{ name: '소리 파일', extensions: Object.keys(AUDIO_MIME).map((x) => x.slice(1)) }] };
    const r = (windows.settingsWindow || windows.main) ? await dialog.showOpenDialog((windows.settingsWindow || windows.main)!, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!AUDIO_MIME[ext]) throw new Error('wav, mp3, m4a, ogg, aac, webm 파일만 쓸 수 있습니다.');
    const size = fs.statSync(src).size;
    if (size > 2 * 1024 * 1024) throw new Error('2MB보다 작은 짧은 파일을 고르세요.');
    fs.mkdirSync(soundsDir(), { recursive: true });
    const file = `ack${ext}`;
    fs.copyFileSync(src, path.join(soundsDir(), file));
    return { file };
  });
  handle('wake:ackAudio', (_e, f: unknown) => {
    const file = normalizeWake({ ackFile: f }).ackFile;
    if (!file) throw new Error('음성 파일 이름이 잘못되었습니다.');
    const audio = fs.readFileSync(path.join(soundsDir(), file));
    return { audio: new Uint8Array(audio), mime: AUDIO_MIME[path.extname(file).toLowerCase()] || 'audio/wav' };
  });
  // 답을 소리로 읽기: TTS 서버(주소가 비면 대화 서버)에서 소리를 받는다. 이 컴퓨터 내장 목소리는 화면이 직접 읽는다
  const toAudio = (r: { audio: Buffer; mime: string }) => ({ audio: new Uint8Array(r.audio), mime: r.mime });
  handle('api:tts', async (_e, text: unknown, voice: unknown) =>
    toAudio(await tts.synthesize(String(text || '').slice(0, 2000), voice ? String(voice) : 'default', { settings: charView(), chatProfile: softProfile() }))
  );
  handle('tts:testServer', (_e, cfg: unknown) => tts.detectServer(normalizeTtsOut({ server: cfg }).server));
  handle('tts:preview', async (_e, cfg: unknown, text: unknown, voice: unknown) =>
    toAudio(await tts.synthesize(String(text || '').slice(0, 300), voice ? String(voice) : 'default', { settings: charView(), chatProfile: softProfile(), server: normalizeTtsOut({ server: cfg }).server }))
  );

  // 파일 작업 (확인·검증은 broker가 한다) ------------------------------
  handle('tools:prepare', (_e, req: ToolRequest) => broker.prepareAsync(req || { action: '' }));
  handle('tools:execute', (_e, id: unknown, opts: { overwrite?: boolean } | undefined) => broker.execute(String(id), opts || {}));
  handle('tools:cancel', (_e, id: unknown) => broker.cancel(String(id)));
  handle('tools:validateRoots', (_e, list: unknown) => {
    const { roots, errors } = policy.validateRoots(list);
    return { roots: roots.map(({ id, label, path: p }) => ({ id, label, path: p })), errors };
  });
  handle('tools:defaultRoots', () => defaultRoots());
  handle('tools:pickFolder', async (_e) => {
    const opts = { title: '허용할 폴더 선택', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const r = (windows.settingsWindow || windows.main) ? await dialog.showOpenDialog((windows.settingsWindow || windows.main)!, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    const { errors } = policy.validateRoots([{ path: p }]);
    return { path: p, label: path.basename(p), error: errors[0] ? errors[0].reason : null };
  });
  handle('tools:openLog', async () => {
    fs.mkdirSync(path.dirname(audit.file), { recursive: true });
    if (!fs.existsSync(audit.file)) fs.writeFileSync(audit.file, '');
    shell.showItemInFolder(audit.file);
    return true;
  });
  handle('tools:openRoot', async (_e, dir: unknown) => {
    const err = await shell.openPath(allowedRootDir(dir, rootList()));
    if (err) throw new Error(err);
    return true;
  });
  handle('tools:openCharacters', async () => {
    fs.mkdirSync(myCharactersDir, { recursive: true });
    const err = await shell.openPath(myCharactersDir);
    if (err) throw new Error(err);
    return true;
  });


  // 로컬 파일 관리 (받은 파일 폴더, _to_delete 비우기) ------------------------------
  handle('files:receivedDir', (_e, dir: unknown) => receivedInfo(typeof dir === 'string' ? dir : settings.files.receivedDir));
  handle('files:pickReceivedDir', async (_e) => {
    const opts = { title: '받은 파일을 저장할 폴더 선택', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const r = (windows.settingsWindow || windows.main) ? await dialog.showOpenDialog((windows.settingsWindow || windows.main)!, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const { errors } = policy.validateRoots([{ path: r.filePaths[0] }]);
    if (errors[0]) throw new Error(errors[0].reason);
    return r.filePaths[0];
  });
  handle('files:openReceivedDir', async (_e, dir: unknown) => {
    const p = receivedInfo(typeof dir === 'string' ? dir : settings.files.receivedDir).path;
    fs.mkdirSync(p, { recursive: true });
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });

  // 원격 (메신저) ------------------------------
  handle('remote:status', () => remoteStatus());
  handle('remote:newKey', async () => {
    resetRemoteAuthentication();
    const k = remoteState.newKey(os.hostname() || 'computer');
    hub.stoppedByBadCodes = false;
    const qr = await QRCode.toDataURL(k.uri, { margin: 1, width: 220 });
    audit.log({ status: 'done', action: 'remote.newKey', source: { kind: 'local' } });
    pushRemoteStatus();
    return { qr, secret: k.secret, recovery: k.recovery };
  });
  handle('remote:checkCode', (_e, code: unknown) => remoteState.check(String(code || '')));
  handle('remote:lock', () => {
    resetRemoteAuthentication();
    return remoteStatus();
  });
  handle('remote:setStopped', (_e, on: unknown) => {
    if (on) resetRemoteAuthentication();
    remoteState.setStopped(!!on);
    if (!on) hub.stoppedByBadCodes = false; // 앱에서 다시 켜면 코드 틀림 중지도 풀린다
    audit.log({ status: 'done', action: on ? 'remote.stop' : 'remote.resume', source: { kind: 'local' } });
    pushRemoteStatus();
    return remoteStatus();
  });
  handle('remote:reconnect', async () => {
    await restartRemote();
    return remoteStatus();
  });
  handle('remote:connectDiscord', async (_e, raw: unknown) => {
    const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const input = { enabled: v.enabled === true, apiKey: String(v.apiKey || '').trim(), userId: String(v.userId || '').trim() };
    const r = await connectThenSave(input, {
      start: startDiscord,
      save: (x) => {
        settings = store.save({ ...settings, remote: { ...settings.remote, enabled: x.enabled, discord: { ...settings.remote.discord, apiKey: x.apiKey, userId: x.userId } } });
        windows.relay({ type: 'settings' });
      },
      restore: () => void restartRemote(),
      isCurrent: (t) => t === discord
    });
    return { ...r, status: remoteStatus() };
  });
  handle('remote:serverRegister', async (_e, profile: unknown, name: unknown) => {
    const info = remoteState.server();
    if (info.attached) throw new Error('이미 연결되어 있습니다. 먼저 연결을 해제하세요.');
    const id = String(profile || '');
    const p = serverProfile(id);
    if (!p) throw new Error('내 서버 프로필을 고르세요. 설정 > AI에서 저장한 프로필만 쓸 수 있습니다.');
    const r = await api.registerComputer(p, String(name || ''), info.computerId || undefined);
    remoteState.setServer({ attached: true, on: false, profile: id, computerId: r.id, computerName: r.name });
    audit.log({ status: 'done', action: 'remote.serverRegister', source: { kind: 'local' }, detail: r.name });
    restartServerLink();
    return remoteStatus();
  });
  handle('remote:serverUnregister', () => {
    const info = remoteState.server();
    serverHub.resetAuthentication();
    remoteState.detachServer();
    audit.log({ status: 'done', action: 'remote.serverDisconnect', source: { kind: 'local' }, detail: info.computerName });
    restartServerLink();
    return remoteStatus();
  });
  handle('remote:serverAllow', (_e, on: unknown) => {
    if (!remoteState.server().attached || !remoteState.server().computerId) throw new Error('먼저 이 컴퓨터를 서버에 등록하세요.');
    remoteState.setServer({ on: !!on });
    audit.log({ status: 'done', action: on ? 'remote.serverAllow' : 'remote.serverDeny', source: { kind: 'local' } });
    restartServerLink();
    return remoteStatus();
  });
  handle('remote:deleteAllSent', async () => {
    if (!discord || !discord.status.connected) throw new Error('디스코드에 연결되어 있어야 지울 수 있습니다.');
    const r = await hub.deleteSent({ all: true });
    pushRemoteStatus();
    return r;
  });
  handle('remote:openSentLog', async () => {
    fs.mkdirSync(path.dirname(sentStore.logFile), { recursive: true });
    if (!fs.existsSync(sentStore.logFile)) fs.writeFileSync(sentStore.logFile, '');
    shell.showItemInFolder(sentStore.logFile);
    return true;
  });
  handle('remote:runAction', (_e, _reqId: unknown, action: unknown, args: unknown) =>
    remoteScope.run(remoteChatContexts.get(String(_reqId || '')) || { characterId: settings.character }, () => hub.runAction(String(action || ''), (args && typeof args === 'object' ? args : {}) as ActionArgs, { kind: 'server', id: String(_reqId || '') }))
  );
  handle('remote:download', (_e, fileId: unknown) => {
    const id = String(fileId || '');
    return (serverHub.hasFile(id) ? serverHub : hub).download(id);
  });
  on('remote:reply', (_e, reqId: unknown, text: unknown) => {
    const r = remoteChats.get(String(reqId || ''));
    if (r) r(typeof text === 'string' ? text : undefined);
  });

  // 마이크 권한 (맥은 처음 한 번 시스템 창이 뜬다)
  handle('media:askMic', async () => {
    if (process.platform !== 'darwin') return true;
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    if (status === 'denied' || status === 'restricted') return false;
    return systemPreferences.askForMediaAccess('microphone');
  });

  handle('live2d:status', () => ({
    core: !!appProtocol.cubismCorePath(APP_ROOT, app.getPath('userData')),
    userDir: path.join(app.getPath('userData'), 'live2d')
  }));

  // 창·마스코트 --------------------------------------------------------
  handle('win:showChat', () => {
    windows.showChat();
    return true;
  });
  on('voice:recording', (_e, flag: unknown) => windows.setRecording(!!flag));
  on('mascot:relay', (_e, msg: MascotMessage) => {
    if (msg && typeof msg === 'object' && typeof msg.type === 'string') windows.relay(msg);
  });
  on('mascot:hover', (_e, flag: unknown) => windows.mascotHover(!!flag));
  on('mascot:drag', (_e, phase: DragPhase) => windows.mascotDrag(phase));
  on('mascot:click', () => windows.toggleChat());
  on('mascot:mic', () => windows.command('ptt'));
  on('mascot:wake', () => windows.toggleWake());
  on('mascot:hide', () => windows.applySetting({ mascot: { ...settings.mascot, enabled: false } }));
}

function setupSession(): void {
  const ses = session.defaultSession;
  // 마이크만, 그리고 앱 화면에서 온 요청만 허용
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const url = String((details as { requestingUrl?: string }).requestingUrl || '');
    const ok = ALLOWED_ORIGINS.some((o) => url.startsWith(o + '/'));
    const types = (details as { mediaTypes?: string[] }).mediaTypes;
    const audioOnly = !types || types.every((t) => t === 'audio');
    cb(ok && permission === 'media' && audioOnly);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && ALLOWED_ORIGINS.includes(origin));

  // 개발 중: Vite 개발 서버 화면에도 보안 정책을 건다 (React 새로고침용 인라인 스크립트와 웹소켓만 더 허용)
  if (DEV_ORIGIN) {
    const devCsp =
      `default-src 'self' ${ORIGIN}; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${ORIGIN}; style-src 'self' 'unsafe-inline'; ` +
      `img-src 'self' data: blob: ${ORIGIN}; media-src 'self' blob:; connect-src 'self' ws: ${ORIGIN}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'`;
    ses.webRequest.onHeadersReceived({ urls: [`${DEV_ORIGIN}/*`] }, (details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [devCsp] } });
    });
  }
}

app.on('second-instance', () => {
  if (windows) windows.showChat();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  const userData = app.getPath('userData');
  charactersDir = app.isPackaged ? path.join(process.resourcesPath, 'characters') : path.join(APP_ROOT, 'characters');
  myCharactersDir = app.isPackaged ? path.join(userData, 'my-characters') : path.join(APP_ROOT, 'my-characters');
  store = createStore(path.join(userData, 'settings.json'), safeStorage);
  settings = store.load();
  // 예전 설정(전체에 하나뿐인 AI·TTS)이면 캐릭터마다 한 번 옮긴다
  if (!settings.charPrefsMigrated) {
    try {
      settings = store.save(migrateCharPrefs(settings, scanCharacters().map((c) => c.id)));
    } catch (e) {
      console.warn('캐릭터별 AI·목소리로 옮기지 못했습니다:', e);
    }
  }
  // 예전 설정의 전체 호출어 이름은 지금 캐릭터의 호출어로 옮긴다 (호출어는 캐릭터마다)
  if (settings.voice.wake.name) settings = store.save(migrateWakeName(settings));
  history = createHistory(path.join(userData, 'history'));
  audit = createAudit(path.join(userData, 'logs', 'actions.jsonl'));
  broker = new ToolBroker({
    getRoots: validRoots, getRemoteRoots: remoteRoots, shell, audit,
    getNameMatcher: (source) => {
      const p = source.kind === 'remote' && source.via === '비서 봇'
        ? serverProfile(remoteState.server().profile) : charProfile(settings, settings.character);
      return selectNameMatcher(settings.tools.nameMethod, p?.type === 'assistant' ? (query, candidates) => api.matchFileNames(p, query, candidates) : null);
    }
  });
  remoteState = createRemoteState(path.join(userData, 'remote-state.json'), safeStorage);
  sentStore = createSentStore(path.join(userData, 'logs'));
  const hubCounters = newHubCounters(); // 앱 봇과 비서 봇이 횟수 제한을 함께 쓴다
  hub = new RemoteHub({
    requireAuthentication: true,
    broker,
    state: remoteState,
    sent: sentStore,
    counters: hubCounters,
    via: '앱 봇',
    getSettings: () => settings,
    getRoots: remoteRoots,
    getReceivedDir: () => receivedInfo().path,
    emit: (ev) => {
      emitRemote(ev);
      if (ev.type !== 'status') pushRemoteStatus();
    },
    chat: remoteChat
  });
  // 비서 봇 지시: 같은 규칙, 같은 잠금. 원격 허용 폴더만 다룬다
  serverTransport = new ServerTransport(
    (m) => serverLink?.send(m),
    async (turn, filePath, name, note) => {
      const info = remoteState.server();
      const p = serverProfile(info.profile);
      if (!p) throw new Error('등록에 쓴 내 서버 프로필을 찾지 못했습니다.');
      await api.uploadComputerFile(p, info.computerId, turn, new Uint8Array(fs.readFileSync(filePath)), name, note, settings.remote.sentDeleteDays);
    },
    (question, answer, signal) => {
      const p = serverProfile(remoteState.server().profile);
      if (!p) return Promise.resolve('unknown');
      return api.interpretConfirmation(p, question, answer, signal);
    }
  );
  serverHub = new RemoteHub({
    prepareRequest: prepareServerCharacter,
    broker,
    counters: hubCounters,
    state: remoteState,
    sent: sentStore,
    getSettings: () => settings,
    getRoots: remoteRoots,
    getReceivedDir: () => receivedInfo().path,
    emit: (ev) => {
      emitRemote(ev);
      if (ev.type !== 'status') pushRemoteStatus();
    },
    chat: async (text, context) => {
      emitRemote({ type: 'line', role: 'user', text, source: SOURCE_LABEL });
      const target = remoteScope.getStore();
      const answer = await serverFileChat(text, {
        character: target?.characterId ? { id: target.characterId, persona: target.persona || '' } : undefined,
        profile: remoteScope.getStore()?.profile || serverProfile(remoteState.server().profile),
        chat: api.chat,
        runAction: (id, action, args) => serverHub.runAction(action, args, { kind: 'server', id, channel: context?.channel }),
        reportAction: api.reportAction
      });
      if (answer) emitRemote({ type: 'line', role: 'sys', text: answer, source: SOURCE_LABEL });
      return answer;
    },
    checkAuthor: false,
    via: '비서 봇',
    fetchFile: fetchDiscordFile
  });
  serverHub.transport = serverTransport;
  // 앱 안 위스퍼: 무거운 계산은 별도 프로세스(stt-worker)에서
  whisperLog = path.join(userData, 'logs', 'whisper.log');
  localStt = new LocalStt(
    path.join(userData, 'whisper'),
    (env) => {
      // 작업 프로세스의 출력(단계·오류)을 기록 파일에 남긴다: 맥·윈도우에서 엔진이 갑자기 꺼질 때 원인을 볼 수 있게
      const child = utilityProcess.fork(path.join(__dirname, 'stt-worker.js'), [], {
        serviceName: 'whisper',
        env: { ...process.env, ...env },
        stdio: 'pipe',
        // 맥: 서명이 다른 라이브러리(onnxruntime의 dylib)를 불러올 수 있게 Plugin 도우미로 띄운다
        allowLoadingUnsignedLibraries: process.platform === 'darwin'
      });
      writeWorkerLog(`--- 시작 electron ${process.versions.electron} ${process.platform}/${process.arch}`);
      child.once('spawn', () => writeWorkerLog(`--- 떴음 (pid ${child.pid})`));
      const pipe = (s: NodeJS.ReadableStream | null, tag: string) =>
        s && s.on('data', (d: Buffer) => String(d).split('\n').filter(Boolean).forEach((l) => writeWorkerLog(`${tag} ${l}`)));
      pipe(child.stdout, '[out]');
      pipe(child.stderr, '[err]');
      child.on('exit', (code) => writeWorkerLog(`--- 끝 (코드 ${code})`));
      return child;
    },
    (p) => {
      const wc = windows && windows.main && !windows.main.isDestroyed() ? windows.main.webContents : null;
      if (wc) wc.send('stt:progress', p);
    },
    whisperLog
  );
  windows = new WindowManager({
    appRoot: APP_ROOT,
    pageBase: DEV_URL || `${ORIGIN}/renderer`,
    allowedOrigins: ALLOWED_ORIGINS,
    preload: path.join(__dirname, '../preload/index.js'),
    getSettings: () => settings,
    saveSettings: patchSettings
  });

  ensureCharacters();
  appProtocol.register({ appRoot: APP_ROOT, rendererDir: path.join(__dirname, '../renderer'), builtinCharactersDir: charactersDir, userCharactersDir: myCharactersDir, userData, devOrigin: DEV_ORIGIN });
  setupSession();
  registerIpc();
  windows.createMain();
  windows.createTray();
  const sc = windows.setShortcuts(settings.shortcut);
  for (const e of Object.values(sc.errors)) console.warn(e);
  windows.setMascot(!!settings.mascot.enabled);
  // 원격(디스코드) 연결, 자동 비우기·보낸 파일 지우기 (켤 때 한 번, 그 뒤 6시간마다)
  void restartRemote();
  restartServerLink();
  housekeeping();
  setInterval(housekeeping, 6 * 60 * 60_000).unref();

  app.on('activate', () => windows.showChat()); // 맥: 독 아이콘 클릭
});

app.on('before-quit', () => {
  if (windows) windows.quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (discord) void discord.stop();
  if (serverLink) serverLink.stop();
  if (localStt) localStt.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
