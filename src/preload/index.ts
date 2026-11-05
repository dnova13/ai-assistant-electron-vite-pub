// 화면이 쓸 수 있는 기능만 열어 둔다. 파일·네트워크·창 조작은 전부 메인 프로세스가 처리한다.
// 대화 창(index.html)과 마스코트 창(mascot.html)이 같은 preload를 쓴다.
// 모양은 src/shared/types.ts 의 AppApi 와 같다.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, AppCommand, ChatEvent, ChatWireEvent, IpcResult, LocalSttProgress, MascotMessage, RemoteEvent } from '@shared/types';

class AppError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T> | undefined;
  if (!r || !r.ok) throw new AppError((r && !r.ok && r.error) || '알 수 없는 오류', r && !r.ok ? r.code : undefined);
  return r.data;
}

function listen<T>(channel: string, cb: (msg: T) => void): () => void {
  const h = (_e: Electron.IpcRendererEvent, msg: T) => cb(msg);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const appApi: AppApi = {
  info: () => call('app:info'),
  settingsWindow: {
    open: (tab) => call('settings-window:open', tab), close: () => call('settings-window:close'), refresh: () => call('settings-window:refresh'),
    call: (method, args) => call('settings-window:call', method, args),
    publish: (view) => ipcRenderer.send('settings-window:publish', view),
    reply: (id, value, error) => ipcRenderer.send('settings-window:reply', id, value, error),
    onView: (cb) => listen('settings-window:view', cb), onCall: (cb) => listen('settings-window:request', cb)
  },
  settings: {
    load: () => call('settings:load'),
    save: (s) => call('settings:save', s)
  },
  characters: {
    list: () => call('characters:list'),
    openFolder: () => call('tools:openCharacters'),
    setOrder: (order) => call('characters:setOrder', order),
    setHidden: (id, hidden) => call('characters:setHidden', id, hidden),
    reset: (id) => call('characters:reset', id),
    setLocked: (id, locked) => call('characters:setLocked', id, locked),
    add: (req) => call('characters:add', req),
    update: (id, req) => call('characters:update', id, req),
    replaceImage: (id) => call('characters:replaceImage', id),
    openOne: (id) => call('characters:openOne', id),
    remove: (id) => call('characters:remove', id)
  },
  history: {
    load: (id) => call('history:load', id),
    append: (id, entries) => call('history:append', id, entries),
    clear: (id) => call('history:clear', id)
  },
  api: {
    health: (profile) => call('api:health', profile),
    chat: (reqId, req, onEvent) =>
      new Promise<true>((resolve, reject) => {
        const h = (_e: Electron.IpcRendererEvent, msg: { reqId: string; event: ChatWireEvent }) => {
          if (!msg || msg.reqId !== reqId) return;
          const ev = msg.event;
          if (ev.type === '_end') {
            ipcRenderer.removeListener('api:event', h);
            if (ev.error) reject(new AppError(ev.error, ev.code));
            else resolve(true);
            return;
          }
          try {
            onEvent(ev as ChatEvent);
          } catch (e) {
            console.error(e);
          }
        };
        ipcRenderer.on('api:event', h);
        call('api:chat', reqId, req).catch((e) => {
          ipcRenderer.removeListener('api:event', h);
          reject(e);
        });
      }),
    abort: (reqId) => call('api:abort', reqId),
    interpretConfirmation: (question, answer) => call('api:interpretConfirmation', question, answer),
    confirm: (id, approve) => call('api:confirm', id, approve),
    report: (id, result) => call('api:report', id, result),
    stt: (audio, mime) => call('api:stt', audio, mime),
    tts: (text, voice) => call('api:tts', text, voice)
  },
  tts: {
    testServer: (cfg) => call('tts:testServer', cfg),
    preview: (cfg, text, voice) => call('tts:preview', cfg, text, voice)
  },
  stt: {
    localQuick: (wav, model) => call('stt:localQuick', wav, model),
    wakeLog: (entry) => call('stt:wakeLog', entry),
    testServer: (cfg) => call('stt:testServer', cfg),
    testCloud: (cfg) => call('stt:testCloud', cfg),
    localStatus: () => call('stt:localStatus'),
    localDownload: (model) => call('stt:localDownload', model),
    localCancel: () => call('stt:localCancel'),
    onLocalProgress: (cb) => listen<LocalSttProgress>('stt:progress', cb)
  },
  tools: {
    prepare: (req) => call('tools:prepare', req),
    execute: (id, opts) => call('tools:execute', id, opts),
    cancel: (id) => call('tools:cancel', id),
    validateRoots: (list) => call('tools:validateRoots', list),
    defaultRoots: () => call('tools:defaultRoots'),
    pickFolder: () => call('tools:pickFolder'),
    openLog: () => call('tools:openLog'),
    openRoot: (dir) => call('tools:openRoot', dir)
  },
  files: {
    receivedDir: (dir) => call('files:receivedDir', dir),
    pickReceivedDir: () => call('files:pickReceivedDir'),
    openReceivedDir: (dir) => call('files:openReceivedDir', dir)
  },
  remote: {
    status: () => call('remote:status'),
    newKey: () => call('remote:newKey'),
    checkCode: (code) => call('remote:checkCode', code),
    lock: () => call('remote:lock'),
    setStopped: (on) => call('remote:setStopped', on),
    reconnect: () => call('remote:reconnect'),
    connectDiscord: (input) => call('remote:connectDiscord', input),
    serverRegister: (profile, name) => call('remote:serverRegister', profile, name),
    serverUnregister: () => call('remote:serverUnregister'),
    serverAllow: (on) => call('remote:serverAllow', on),
    deleteAllSent: () => call('remote:deleteAllSent'),
    openSentLog: () => call('remote:openSentLog'),
    onEvent: (cb) => listen<RemoteEvent>('remote:event', cb),
    reply: (reqId, text) => ipcRenderer.send('remote:reply', reqId, text),
    runAction: (reqId, action, args) => call('remote:runAction', reqId, action, args),
    download: (fileId) => call('remote:download', fileId)
  },
  media: {
    askMic: () => call('media:askMic'),
    recording: (on) => ipcRenderer.send('voice:recording', !!on)
  },
  live2d: {
    status: () => call('live2d:status')
  },
  win: {
    showChat: () => call('win:showChat'),
    // 트레이·단축키·마스코트에서 오는 명령
    onCommand: (cb) => listen<AppCommand>('app:command', cb)
  },
  wake: {
    pickAck: () => call('wake:pickAck'),
    ackAudio: (file) => call('wake:ackAudio', file)
  },
  mascot: {
    relay: (msg) => ipcRenderer.send('mascot:relay', msg),
    wake: () => ipcRenderer.send('mascot:wake'),
    onUpdate: (cb) => listen<MascotMessage>('mascot:update', cb),
    hover: (on) => ipcRenderer.send('mascot:hover', !!on),
    drag: (phase) => ipcRenderer.send('mascot:drag', phase),
    click: () => ipcRenderer.send('mascot:click'),
    mic: () => ipcRenderer.send('mascot:mic'),
    hide: () => ipcRenderer.send('mascot:hide')
  }
};

contextBridge.exposeInMainWorld('app', appApi);
