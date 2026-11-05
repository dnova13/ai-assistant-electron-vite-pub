// 서버와 통신하는 코드는 전부 여기에 있다 (Electron 메인 프로세스에서 실행).
// 화면(렌더러)에서 직접 요청하지 않는 이유: CORS·혼합 콘텐츠 차단을 피하고, 토큰을 화면 코드에 두지 않기 위해서.
//
// provider
//   auto      : 주소로 아래 셋(assistant/ollama/openai) 중 알아서 고른다 (detect)
//   assistant : 비서 서버 (/v1/...)  — 대화, 서버 확인, 앱 작업 요청, STT, TTS
//   ollama    : Ollama 직접 (/api/...) — 대화만
//   openai    : ChatGPT 또는 OpenAI 호환 서버 (/chat/completions, SSE) — 대화만
//   anthropic : Claude (/v1/messages, SSE) — 대화만
//   gemini    : Gemini (/models/{모델}:streamGenerateContent, SSE) — 대화만
// 직접 연결 종류는 대화 기억을 앱의 캐릭터별 기록으로 보낸다.
import type { ActionArgs, ActionReport, ChatEvent, Health, Profile } from '@shared/types';
import { isUsableGeminiModel, sortGeminiModels } from '@shared/gemini-models';
import { CONFIRM_PROMPT, confirmationDecision, type ConfirmationDecision } from '@shared/confirmation';
import type { FileNameCandidate } from '@shared/file-names';

const EVENT_TYPES = new Set(['delta', 'client_action', 'confirm', 'done', 'error']);
const MAX_TEXT = 64 * 1024;

export class ApiError extends Error {
  code: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code || 'api_error';
  }
}

/** 메인 프로세스가 서버에 보내는 대화 요청 */
export interface ChatCall {
  text: string;
  input?: 'text' | 'voice';
  session?: string;
  lowSpec?: boolean;
  history?: { role: 'user' | 'assistant'; content: string }[];
  client?: { os?: string; app?: string; character?: string; persona?: string };
}

/** sttModel: OpenAI 호환 음성 인식 모델 (기본 whisper-1) */
export type ProfileLike = Pick<Profile, 'type' | 'baseUrl' | 'apiKey'> & Partial<Profile> & { sttModel?: string };
type OnEvent = (ev: ChatEvent) => void;

const cleanBase = (url: string): string => String(url || '').trim().replace(/\/+$/, '');

function authHeaders(profile: ProfileLike, json: boolean, noAuth?: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (profile.apiKey && !noAuth) h.Authorization = `Bearer ${profile.apiKey}`;
  return h;
}

interface IdleTimer {
  signal: AbortSignal;
  touch(): void;
  readonly timedOut: boolean;
  done(): void;
}

// 시간 제한: 처음 응답까지 ms, 스트림은 조각 사이 ms 동안 아무것도 없으면 끊는다.
function idleTimer(ms: number, userSignal?: AbortSignal): IdleTimer {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
  };
  const onUser = () => ctrl.abort();
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort();
    else userSignal.addEventListener('abort', onUser, { once: true });
  }
  arm();
  return {
    signal: ctrl.signal,
    touch: arm,
    get timedOut() {
      return timedOut;
    },
    done() {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onUser);
    }
  };
}

function networkError(e: unknown, t?: IdleTimer): ApiError {
  if (t && t.timedOut) return new ApiError('응답 시간이 초과되었습니다. 모델이 로딩 중일 수 있으니 잠시 후 다시 시도하세요.', 'timeout');
  if (e instanceof Error && e.name === 'AbortError') return new ApiError('요청을 중단했습니다.', 'aborted');
  if (e instanceof ApiError) return e;
  return new ApiError('서버에 연결할 수 없습니다. 설정의 주소와 서버 상태를 확인하세요.', 'unreachable');
}

async function httpError(res: Response): Promise<ApiError> {
  let msg = '';
  try {
    const body = (await res.json()) as { error?: string | { message?: string } };
    msg = (body && typeof body.error === 'object' && body.error && body.error.message) || (typeof body.error === 'string' ? body.error : '');
  } catch {
    /* 본문이 JSON이 아님 */
  }
  const s = res.status;
  if (s === 401 || s === 403) return new ApiError('인증 실패: 설정의 토큰(API 키)을 확인하세요.', 'auth');
  if (s === 404 && !msg) return new ApiError('이 주소에서 API를 찾지 못했습니다. 설정의 서버 종류와 주소를 확인하세요.', 'not_found');
  if (s === 413) return new ApiError(msg || '음성이 너무 깁니다 (60초 이하).', 'too_large');
  return new ApiError(msg || `서버 응답 오류 (${s})`, `http_${s}`);
}

interface SendOpts {
  method?: string;
  json?: unknown;
  body?: FormData | string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bearer 대신 headers로 키를 보내는 서버(Claude, Gemini) */
  noAuth?: boolean;
}

async function send(profile: ProfileLike, path: string, { method = 'GET', json, body, headers, signal, timeoutMs, noAuth }: SendOpts = {}) {
  const base = cleanBase(profile.baseUrl);
  if (!/^https?:\/\//i.test(base)) throw new ApiError('서버 주소는 http:// 또는 https:// 로 시작해야 합니다.', 'bad_url');
  const t = idleTimer(timeoutMs ?? (profile.timeoutSec || 60) * 1000, signal);
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { ...authHeaders(profile, json !== undefined, noAuth), ...(headers || {}) },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: t.signal
    });
  } catch (e) {
    t.done();
    throw networkError(e, t);
  }
  if (!res.ok) {
    t.done();
    throw await httpError(res);
  }
  return { res, timer: t };
}

async function readJson<T = Record<string, unknown>>(profile: ProfileLike, path: string, opts?: SendOpts): Promise<T> {
  const { res, timer } = await send(profile, path, opts);
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw e instanceof SyntaxError ? new ApiError('서버 응답을 읽을 수 없습니다 (JSON 아님).', 'bad_response') : networkError(e, timer);
  } finally {
    timer.done();
  }
}

/** 음성 인식 설정의 연결 테스트용: GET 해서 JSON을 읽는다 */
export const getJson = <T = Record<string, unknown>>(profile: ProfileLike, path: string, timeoutMs = 5000) => readJson<T>(profile, path, { timeoutMs });

// NDJSON 스트림을 한 줄씩 읽는다.
async function readNdjson(res: Response, timer: IdleTimer, onObject: (o: Record<string, unknown>) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flushLine = (line: string) => {
    line = line.trim();
    if (!line) return;
    if (line.length > MAX_TEXT * 2) return; // 비정상적으로 긴 줄은 버린다
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj && typeof obj === 'object') onObject(obj as Record<string, unknown>);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      timer.touch();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        flushLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    buf += dec.decode();
    flushLine(buf);
  } catch (e) {
    throw networkError(e, timer);
  }
}

// SSE(text/event-stream) 스트림에서 "data:" 줄만 꺼낸다. OpenAI·Claude·Gemini가 쓴다.
async function readSse(res: Response, timer: IdleTimer, onData: (data: string) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flushLine = (line: string) => {
    line = line.replace(/\r$/, '');
    if (!line.startsWith('data:')) return; // event:, id:, 빈 줄, 주석은 건너뜀
    const data = line.slice(5).trim();
    if (data && data.length <= MAX_TEXT * 4) onData(data);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      timer.touch();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        flushLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    buf += dec.decode();
    flushLine(buf);
  } catch (e) {
    throw networkError(e, timer);
  }
}

const parseJson = (s: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function sanitizeArgs(args: Record<string, unknown>): ActionArgs {
  const out: ActionArgs = {};
  for (const k of ['target', 'dest', 'root', 'query', 'name'] as const) {
    const v = args[k];
    if (typeof v === 'string') out[k] = v.slice(0, 4096);
  }
  if (typeof args.sameFolder === 'boolean') out.sameFolder = args.sameFolder;
  return out;
}

// 서버가 보낸 이벤트를 검사해서 모양이 맞는 것만 넘긴다.
export function sanitizeEvent(raw: unknown): ChatEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;
  if (typeof ev.type !== 'string' || !EVENT_TYPES.has(ev.type)) return null;
  const str = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
  switch (ev.type) {
    case 'delta':
      return typeof ev.text === 'string' ? { type: 'delta', text: str(ev.text) } : null;
    case 'done':
      return { type: 'done', text: typeof ev.text === 'string' ? str(ev.text) : null };
    case 'error':
      return { type: 'error', code: str(ev.code, 64) || 'server_error', message: str(ev.message, 2000) || '서버 오류' };
    case 'confirm':
      if (!str(ev.id, 200)) return null;
      return {
        type: 'confirm',
        id: str(ev.id, 200),
        message: str(ev.message, 2000) || '서버 작업을 실행할까요?',
        expiresIn: Math.max(5, Math.min(600, Number(ev.expires_in) || 60))
      };
    case 'client_action':
      if (!str(ev.id, 200) || !str(ev.action, 64)) return null;
      return {
        type: 'client_action',
        id: str(ev.id, 200),
        action: str(ev.action, 64),
        args: ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args) ? sanitizeArgs(ev.args as Record<string, unknown>) : {},
        say: str(ev.say, 2000)
      };
    default:
      return null;
  }
}

interface Provider {
  health(profile: ProfileLike): Promise<Health>;
  chat(profile: ProfileLike, req: ChatCall, onEvent: OnEvent, signal?: AbortSignal): Promise<void>;
  confirm?(profile: ProfileLike, id: string, approve: boolean): Promise<{ text: string }>;
  reportAction?(profile: ProfileLike, id: string, result: ActionReport): Promise<void>;
  stt?(profile: ProfileLike, audio: Buffer, mime: string): Promise<{ text: string }>;
  tts?(profile: ProfileLike, text: string, voice: string, lowSpec?: boolean): Promise<{ audio: Buffer; mime: string }>;
}

/* ---------------- provider: assistant (내 서버) ---------------- */

/** 내 서버의 입구: 주소에 경로가 없으면 /v1, 있으면 적은 그대로 (예: /v1, /ai-agent). 앱은 이 뒤에 /chat 등을 붙인다 */
export function assistantEntry(url: string): string {
  const base = cleanBase(url);
  try {
    return new URL(base).pathname === '/' ? base + '/v1' : base;
  } catch {
    return base; // 잘못된 주소는 send가 알려 준다
  }
}
const entry = (p: ProfileLike): ProfileLike => ({ ...p, baseUrl: assistantEntry(p.baseUrl) });

/** 내 서버에 이 컴퓨터를 등록한다. 번호는 서버가 정한다 */
export const registerComputer = (p: ProfileLike, name: string, computerId?: string) =>
  readJson<{ id: string; name: string }>(entry(p), '/computers', { method: 'POST', json: { name, ...(computerId ? { computer_id: computerId } : {}) }, timeoutMs: 10000 });

/** 실제 경로를 보내지 않고 내 서버에 기존 이름의 발음 비교를 요청한다. */
export async function matchFileNames(profile: ProfileLike, query: string, candidates: FileNameCandidate[]): Promise<string[]> {
  if (profile.type !== 'assistant') throw new ApiError('파일 이름 비교는 내 서버 연결에서만 됩니다.', 'unsupported');
  let result: { ids?: unknown };
  try {
    result = await readJson<{ ids?: unknown }>(entry(profile), '/files/match', { method: 'POST', json: { query, candidates }, timeoutMs: (profile.timeoutSec || 60) * 1000 });
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'not_found' || e.code === 'http_404')) throw new ApiError('파일 이름 비교를 지원하는 최신 비서 서버를 반영해 주세요.', 'unsupported');
    throw e;
  }
  const ids = result?.ids;
  const known = new Set(candidates.map((c) => c.id));
  if (!Array.isArray(ids) || ids.length > candidates.length || ids.some((id) => typeof id !== 'string' || !known.has(id)) || new Set(ids).size !== ids.length) throw new ApiError('파일 이름 비교 결과에 올바르지 않은 후보 번호가 있습니다.', 'bad_response');
  return ids as string[];
}

/** 비서 봇으로 보낼 파일을 진행 중인 요청에 붙인다 */
export async function uploadComputerFile(p: ProfileLike, id: string, turn: string, data: Uint8Array<ArrayBuffer>, name: string, note: string, days: number): Promise<void> {
  const headers = { 'x-file-name': encodeURIComponent(name), 'x-file-note': encodeURIComponent(note), 'x-delete-days': String(days), 'content-type': 'application/octet-stream' };
  const { timer } = await send(entry(p), `/computers/${encodeURIComponent(id)}/files?turn=${encodeURIComponent(turn)}`, { method: 'POST', body: data, headers, timeoutMs: 90000 });
  timer.done();
}

/** 앱이 먼저 여는 연결의 주소 */
export const computerLinkUrl = (baseUrl: string): string => assistantEntry(baseUrl).replace(/^http/i, 'ws') + '/computers/connect';

const assistant: Provider = {
  async health(profile) {
    const h = await readJson<Record<string, unknown>>(entry(profile), '/health', { timeoutMs: 8000 });
    const f = (h && (h.features as Record<string, unknown>)) || {};
    return {
      provider: 'assistant',
      api: String(h.api || ''),
      server: String(h.server || ''),
      version: String(h.version || ''),
      model: String(h.model || ''),
      models: h.model ? [String(h.model)] : [],
      voices: Array.isArray(h.tts_voices) ? h.tts_voices.filter((x): x is string => typeof x === 'string') : [],
      features: {
        chatStream: !!f.chat_stream,
        stt: !!f.stt,
        tts: !!f.tts,
        serverConfirm: !!f.server_confirm,
        sessions: !!f.sessions, // 캐릭터(session)별 대화 기억
        lowSpec: !!f.low_spec, // 저사양 요청을 알아들음
        clientActions: Array.isArray(f.client_actions) ? f.client_actions.filter((x): x is string => typeof x === 'string') : []
      },
      warning: h.api && String(h.api) !== '1' ? `서버 API 버전(${String(h.api)})이 앱(1)과 다릅니다.` : ''
    };
  },

  async chat(profile, req, onEvent, signal) {
    const { res, timer } = await send(entry(profile), '/chat', {
      method: 'POST',
      json: {
        text: req.text,
        input: req.input === 'voice' ? 'voice' : 'text',
        ...(req.session ? { session: String(req.session).slice(0, 64) } : {}),
        ...(req.lowSpec ? { options: { low_spec: true } } : {}),
        client: req.client || {}
      },
      signal,
      timeoutMs: (profile.timeoutSec || 60) * 1000
    });
    let full = '';
    let ended = false;
    try {
      await readNdjson(res, timer, (raw) => {
        if (ended) return;
        const ev = sanitizeEvent(raw);
        if (!ev) return;
        if (ev.type === 'delta') full += ev.text;
        if (ev.type === 'done') {
          ended = true;
          if (ev.text == null) ev.text = full;
        }
        if (ev.type === 'error') ended = true;
        onEvent(ev);
      });
    } finally {
      timer.done();
    }
    if (!ended) onEvent({ type: 'done', text: full }); // 끝 줄 없이 닫힌 경우
  },

  async confirm(profile, id, approve) {
    const r = await readJson<{ text?: unknown }>(entry(profile), '/confirm', { method: 'POST', json: { id, approve: !!approve }, timeoutMs: 120000 });
    return { text: typeof r.text === 'string' ? r.text : '' };
  },

  async reportAction(profile, id, result) {
    const { timer } = await send(entry(profile), `/actions/${encodeURIComponent(id)}/result`, {
      method: 'POST',
      json: { status: result.status, detail: String(result.detail || '').slice(0, 2000) },
      timeoutMs: 10000
    });
    timer.done();
  },

  async stt(profile, audio, mime) {
    const form = new FormData();
    const type = mime || 'audio/webm';
    const ext = type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', new Blob([new Uint8Array(audio)], { type }), `speech.${ext}`);
    form.append('language', 'ko');
    const r = await readJson<{ text?: unknown }>(entry(profile), '/stt', { method: 'POST', body: form, timeoutMs: 120000 });
    return { text: typeof r.text === 'string' ? r.text.trim() : '' };
  },

  async tts(profile, text, voice, lowSpec) {
    const { res, timer } = await send(entry(profile), '/tts', {
      method: 'POST',
      json: { text: String(text).slice(0, 500), voice: voice || 'default', format: 'wav', ...(lowSpec ? { low_spec: true } : {}) },
      timeoutMs: 30000
    });
    return readAudio(res, timer);
  }
};

/* ---------------- TTS 응답 읽기 (규약 v1, OpenAI 호환 공통) ---------------- */

/** 응답 형식 이름이 없거나 틀려도 소리 파일 머리로 알아본다 */
function audioMime(header: string | null, buf: Buffer): string | null {
  const h = (header || '').split(';')[0].trim().toLowerCase();
  if (h.startsWith('audio/')) return h;
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 3 && (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  return null;
}

async function readAudio(res: Response, timer: IdleTimer): Promise<{ audio: Buffer; mime: string }> {
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = audioMime(res.headers.get('content-type'), buf);
    if (!mime) throw new ApiError('TTS 응답이 오디오가 아닙니다.', 'bad_response');
    return { audio: buf, mime };
  } catch (e) {
    throw e instanceof ApiError ? e : networkError(e, timer);
  } finally {
    timer.done();
  }
}

/** OpenAI 호환 TTS (/audio/speech). 공식 OpenAI와 이 형식을 여는 오픈소스 TTS 서버가 같이 쓴다 */
export async function speech(profile: ProfileLike, text: string, voice: string, model: string, timeoutMs = 20000): Promise<{ audio: Buffer; mime: string }> {
  if (/api\.openai\.com/i.test(profile.baseUrl)) needKey(profile);
  const { res, timer } = await send(profile, '/audio/speech', {
    method: 'POST',
    json: { model, input: String(text).slice(0, 4000), voice, response_format: 'wav' },
    timeoutMs
  });
  return readAudio(res, timer);
}

/* ---------------- 직접 연결 공통 (Ollama, OpenAI, Claude, Gemini) ---------------- */

type Turn = { role: 'user' | 'assistant'; content: string };

/** 모델·시스템 프롬프트·대화 기억(캐릭터별 기록)을 정한다 */
function directInput(profile: ProfileLike, req: ChatCall): { model: string; system: string; history: Turn[] } {
  const model = (req.lowSpec && profile.lowSpecModel) || profile.model || '';
  if (!model) throw new ApiError('모델이 선택되지 않았습니다. 설정 > AI에서 연결 테스트 후 모델을 고르세요.', 'no_model');
  const system = [profile.systemPrompt, req.client && req.client.persona].filter(Boolean).join('\n\n');
  const history = (Array.isArray(req.history) ? req.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(req.lowSpec ? -6 : -16);
  return { model, system, history };
}

/** user/assistant가 번갈아 나오고 user로 시작하게 맞춘다 (Claude·Gemini가 요구) */
function alternate(history: Turn[], text: string): Turn[] {
  const out: Turn[] = [];
  for (const m of [...history, { role: 'user' as const, content: text }]) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ ...m });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const needKey = (profile: ProfileLike) => {
  if (!profile.apiKey) throw new ApiError('API 키가 비어 있습니다. 설정 > AI에 키를 넣으세요.', 'auth');
};

const needHttps = (profile: ProfileLike) => {
  const base = cleanBase(profile.baseUrl);
  // 이 컴퓨터 안의 프록시(localhost)만 http 허용
  if (!/^https:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(base)) throw new ApiError('이 서버 종류는 https:// 주소만 쓸 수 있습니다 (API 키 보호).', 'bad_url');
};

/** 일부 최신 모델은 temperature를 받지 않는다 → 400이면 빼고 한 번 더 */
async function withTempRetry<T>(run: (useTemp: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(true);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'http_400' && /temperature/i.test(e.message)) return run(false);
    throw e;
  }
}

const directFeatures = (stt = false) => ({ chatStream: true, stt, tts: false, serverConfirm: false, sessions: true, lowSpec: true, clientActions: [] as string[] });

function directHealth(type: 'openai' | 'anthropic' | 'gemini', server: string, profile: ProfileLike, models: string[], stt = false): Health {
  return { provider: type, api: '', server, version: '', model: profile.model || '', models, voices: [], features: directFeatures(stt), warning: '' };
}

/* ---------------- provider: openai (ChatGPT, LM Studio·vLLM 등 호환 서버) ---------------- */

const openai: Provider = {
  async health(profile) {
    const official = /api\.openai\.com/i.test(profile.baseUrl);
    if (official) needKey(profile);
    const data = await readJson<{ data?: { id?: string }[] }>(profile, '/models', { timeoutMs: 8000 });
    let models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter((x): x is string => !!x) : [];
    // 공식 서버는 이미지·음성·임베딩 모델도 섞여 있어서 대화용만 남긴다
    if (official) models = models.filter((m) => /^(gpt-|chatgpt-|o\d)/.test(m) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(m));
    // 음성 인식(/audio/transcriptions)은 공식 서버만 확실해서 그때만 켠다 (호환 서버는 서버마다 달라 알 수 없음)
    return directHealth('openai', official ? 'openai' : 'openai-compatible', profile, models.sort(), official);
  },

  async chat(profile, req, onEvent, signal) {
    if (/api\.openai\.com/i.test(profile.baseUrl)) needKey(profile);
    const { model, system, history } = directInput(profile, req);
    const messages = [...(system ? [{ role: 'system', content: system }] : []), ...history, { role: 'user', content: req.text }];
    const { res, timer } = await withTempRetry((useTemp) =>
      send(profile, '/chat/completions', {
        method: 'POST',
        json: { model, stream: true, messages, ...(useTemp ? { temperature: Number(profile.temperature) || 0.7 } : {}) },
        signal,
        timeoutMs: (profile.timeoutSec || 60) * 1000
      })
    );
    let full = '';
    let failed: string | null = null;
    try {
      await readSse(res, timer, (data) => {
        if (data === '[DONE]') return;
        const obj = parseJson(data);
        if (!obj) return;
        const err = obj.error as { message?: string } | undefined;
        if (err) failed = String(err.message || 'unknown');
        const choices = obj.choices as { delta?: { content?: unknown } }[] | undefined;
        const piece = choices && choices[0] && choices[0].delta && choices[0].delta.content;
        if (typeof piece === 'string' && piece) {
          full += piece;
          onEvent({ type: 'delta', text: piece });
        }
      });
    } finally {
      timer.done();
    }
    if (failed) onEvent({ type: 'error', code: 'openai_error', message: `OpenAI 오류: ${failed}` });
    else onEvent({ type: 'done', text: full });
  },

  // 음성 인식: 녹음 파일을 보내 글을 받는다 (요금은 음성 길이 기준)
  async stt(profile, audio, mime) {
    if (/api\.openai\.com/i.test(profile.baseUrl)) needKey(profile);
    const form = new FormData();
    const type = mime || 'audio/webm';
    const ext = type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'mp4' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type }), `speech.${ext}`);
    form.append('model', profile.sttModel || 'whisper-1');
    form.append('language', 'ko');
    const r = await readJson<{ text?: unknown }>(profile, '/audio/transcriptions', { method: 'POST', body: form, timeoutMs: 120000 });
    return { text: typeof r.text === 'string' ? r.text.trim() : '' };
  }
};

/* ---------------- provider: anthropic (Claude) ---------------- */

// 주소에 /v1 까지 넣었어도 동작하게 한다
const anthropicProfile = (p: ProfileLike): ProfileLike => ({ ...p, baseUrl: cleanBase(p.baseUrl).replace(/\/v1$/i, '') });
const anthropicHeaders = (p: ProfileLike) => ({ 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' });

const anthropic: Provider = {
  async health(raw) {
    const profile = anthropicProfile(raw);
    needKey(profile);
    needHttps(profile);
    const data = await readJson<{ data?: { id?: string }[] }>(profile, '/v1/models?limit=100', { timeoutMs: 8000, noAuth: true, headers: anthropicHeaders(profile) });
    const models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter((x): x is string => !!x) : [];
    return directHealth('anthropic', 'anthropic', profile, models);
  },

  async chat(raw, req, onEvent, signal) {
    const profile = anthropicProfile(raw);
    needKey(profile);
    needHttps(profile);
    const { model, system, history } = directInput(profile, req);
    const { res, timer } = await withTempRetry((useTemp) =>
      send(profile, '/v1/messages', {
        method: 'POST',
        noAuth: true,
        headers: anthropicHeaders(profile),
        json: {
          model,
          max_tokens: req.lowSpec ? 1024 : 4096,
          stream: true,
          ...(system ? { system } : {}),
          messages: alternate(history, req.text),
          ...(useTemp ? { temperature: Math.min(1, Number(profile.temperature) || 0.7) } : {}) // Claude는 0~1
        },
        signal,
        timeoutMs: (profile.timeoutSec || 60) * 1000
      })
    );
    let full = '';
    let failed: string | null = null;
    try {
      await readSse(res, timer, (data) => {
        const obj = parseJson(data);
        if (!obj) return;
        if (obj.type === 'error') {
          const err = obj.error as { message?: string } | undefined;
          failed = String((err && err.message) || 'unknown');
        }
        if (obj.type === 'content_block_delta') {
          const d = obj.delta as { type?: string; text?: unknown } | undefined;
          if (d && d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
            full += d.text;
            onEvent({ type: 'delta', text: d.text });
          }
        }
      });
    } finally {
      timer.done();
    }
    if (failed) onEvent({ type: 'error', code: 'anthropic_error', message: `Claude 오류: ${failed}` });
    else onEvent({ type: 'done', text: full });
  }
};

/* ---------------- provider: gemini (Google) ---------------- */

const geminiHeaders = (p: ProfileLike) => ({ 'x-goog-api-key': p.apiKey });

const gemini: Provider = {
  async health(profile) {
    needKey(profile);
    needHttps(profile);
    const data = await readJson<{ models?: { name?: string; supportedGenerationMethods?: string[] }[] }>(profile, '/models?pageSize=1000', {
      timeoutMs: 8000,
      noAuth: true,
      headers: geminiHeaders(profile)
    });
    const models = (Array.isArray(data.models) ? data.models : [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((m) => m && isUsableGeminiModel(m)); // 이미지·영상·TTS·실시간·종료된 모델은 뺀다 (shared/gemini-models.ts)
    return directHealth('gemini', 'gemini', profile, sortGeminiModels(models), true);
  },

  async chat(profile, req, onEvent, signal) {
    needKey(profile);
    needHttps(profile);
    const { model, system, history } = directInput(profile, req);
    const contents = alternate(history, req.text).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const id = encodeURIComponent(model.replace(/^models\//, ''));
    const { res, timer } = await withTempRetry((useTemp) =>
      send(profile, `/models/${id}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        noAuth: true,
        headers: geminiHeaders(profile),
        json: {
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          ...(useTemp ? { generationConfig: { temperature: Number(profile.temperature) || 0.7 } } : {})
        },
        signal,
        timeoutMs: (profile.timeoutSec || 60) * 1000
      })
    );
    let full = '';
    let failed: string | null = null;
    try {
      await readSse(res, timer, (data) => {
        const obj = parseJson(data);
        if (!obj) return;
        const err = obj.error as { message?: string } | undefined;
        if (err) failed = String(err.message || 'unknown');
        const fb = obj.promptFeedback as { blockReason?: string } | undefined;
        if (fb && fb.blockReason) failed = `요청이 차단되었습니다 (${fb.blockReason})`;
        const cands = obj.candidates as { content?: { parts?: { text?: unknown; thought?: boolean }[] } }[] | undefined;
        const parts = (cands && cands[0] && cands[0].content && cands[0].content.parts) || [];
        for (const part of parts) {
          if (part.thought) continue; // 생각 과정은 보여 주지 않는다
          if (typeof part.text === 'string' && part.text) {
            full += part.text;
            onEvent({ type: 'delta', text: part.text });
          }
        }
      });
    } finally {
      timer.done();
    }
    if (failed) onEvent({ type: 'error', code: 'gemini_error', message: `Gemini 오류: ${failed}` });
    else onEvent({ type: 'done', text: full });
  },

  // 음성 인식: 녹음을 Gemini에 보내 글로 받아 적게 한다 (wav/mp3/ogg/flac/aac. 앱이 wav로 바꿔 보낸다)
  async stt(profile, audio, mime) {
    needKey(profile);
    needHttps(profile);
    const model = (profile.model || '').replace(/^models\//, '');
    if (!model) throw new ApiError('모델이 선택되지 않았습니다. 설정 > AI에서 연결 테스트 후 모델을 고르세요.', 'no_model');
    if (audio.length > 14 * 1024 * 1024) throw new ApiError('음성이 너무 깁니다 (60초 이하).', 'too_large');
    const r = await readJson<{ candidates?: { content?: { parts?: { text?: unknown }[] } }[] }>(profile, `/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      noAuth: true,
      headers: geminiHeaders(profile),
      json: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: '이 음성을 한국어로 받아 적으세요. 들린 말만 그대로 쓰고, 설명·따옴표·머리말은 붙이지 마세요. 말이 없으면 빈 칸으로 두세요.' },
              { inline_data: { mime_type: (mime || 'audio/wav').split(';')[0], data: audio.toString('base64') } }
            ]
          }
        ],
        generationConfig: { temperature: 0 }
      },
      timeoutMs: 120000
    });
    const parts = (r.candidates && r.candidates[0] && r.candidates[0].content && r.candidates[0].content.parts) || [];
    return { text: parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim() };
  }
};

/* ---------------- provider: ollama (직접 연결, 대화만) ---------------- */

const ollama: Provider = {
  async health(profile) {
    const data = await readJson<{ models?: { name?: string }[] }>(profile, '/api/tags', { timeoutMs: 8000 });
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name).filter((x): x is string => !!x) : [];
    return {
      provider: 'ollama',
      api: '',
      server: 'ollama',
      version: '',
      model: profile.model || '',
      models,
      voices: [],
      features: { chatStream: true, stt: false, tts: false, serverConfirm: false, sessions: true, lowSpec: true, clientActions: [] },
      warning: ''
    };
  },

  // 저사양 모드: 저사양 모델(지정했을 때), 짧은 문맥(2048), 짧은 대화 기억(최근 6개)
  async chat(profile, req, onEvent, signal) {
    const { model, system, history } = directInput(profile, req);
    const { res, timer } = await send(profile, '/api/chat', {
      method: 'POST',
      json: {
        model,
        stream: true,
        keep_alive: '30m', // 다음 질문 때 모델을 다시 올리는 지연을 줄인다
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...history, { role: 'user', content: req.text }],
        options: { temperature: Number(profile.temperature) || 0.7, ...(req.lowSpec ? { num_ctx: 2048 } : {}) }
      },
      signal,
      timeoutMs: (profile.timeoutSec || 60) * 1000
    });
    let full = '';
    let failed: string | null = null;
    try {
      await readNdjson(res, timer, (obj) => {
        if (obj.error) failed = String(obj.error);
        const msg = obj.message as { content?: unknown } | undefined;
        const piece = msg && msg.content;
        if (typeof piece === 'string' && piece) {
          full += piece;
          onEvent({ type: 'delta', text: piece });
        }
      });
    } finally {
      timer.done();
    }
    if (failed) onEvent({ type: 'error', code: 'ollama_error', message: `Ollama 오류: ${failed}` });
    else onEvent({ type: 'done', text: full });
  }
};

const PROVIDERS: Record<string, Provider> = { assistant, ollama, openai, anthropic, gemini };

/* ---------------- auto: 주소만 보고 종류를 알아낸다 ---------------- */

export interface Detected {
  type: 'assistant' | 'ollama' | 'openai';
  baseUrl: string;
}

const detectCache = new Map<string, { at: number; found: Detected }>();
const DETECT_TTL = 5 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 주소로 서버 종류를 알아낸다. 순서: Ollama(/api/tags) → OpenAI 호환(/models, 없으면 /v1/models) → 비서 서버(/v1/health).
 * 응답 모양까지 확인해서 아무 웹페이지가 200을 줘도 속지 않는다.
 */
export async function detect(profile: ProfileLike): Promise<Detected> {
  const base = cleanBase(profile.baseUrl);
  const probe = async (b: string, path: string): Promise<Record<string, unknown> | null> => {
    try {
      const { res, timer } = await send({ ...profile, baseUrl: b }, path, { timeoutMs: 5000 });
      try {
        const j = await res.json();
        return isObj(j) ? j : null;
      } finally {
        timer.done();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'auth') authSeen = true;
      if (e instanceof ApiError && e.code === 'bad_url') throw e;
      return null;
    }
  };
  let authSeen = false;
  const root = base.replace(/\/v1$/i, '');
  const tags = await probe(root, '/api/tags');
  if (tags && Array.isArray(tags.models)) return { type: 'ollama', baseUrl: root };
  // 후보: 적은 주소, /v1 (LM Studio·vLLM), /api (Open WebUI의 OpenAI 호환 API. 워크스페이스 모델도 여기에만 보인다)
  for (const b of /\/(v1|api)$/i.test(base) ? [base] : [base, base + '/v1', base + '/api']) {
    const m = await probe(b, '/models');
    if (m && Array.isArray(m.data)) return { type: 'openai', baseUrl: b };
  }
  const h = await probe(root, '/v1/health');
  if (h && (h.api !== undefined || h.server !== undefined || h.features !== undefined)) return { type: 'assistant', baseUrl: root + '/v1' };
  if (authSeen) throw new ApiError('인증 실패: 설정의 API 키(토큰)를 확인하세요.', 'auth');
  throw new ApiError('이 주소에서 서버 종류를 알아내지 못했습니다. 주소와 서버 상태를 확인하세요. (Ollama, OpenAI 호환, 비서 서버를 찾아봤습니다)', 'unreachable');
}

async function resolve(profile: ProfileLike, fresh = false): Promise<{ prov: Provider; profile: ProfileLike }> {
  if (!profile) throw new ApiError('알 수 없는 서버 종류입니다.', 'bad_profile');
  if (profile.type === 'auto') {
    const key = cleanBase(profile.baseUrl) + '|' + (profile.apiKey ? 'k' : '');
    const hit = detectCache.get(key);
    let found: Detected;
    if (!fresh && hit && Date.now() - hit.at < DETECT_TTL) found = hit.found;
    else {
      found = await detect(profile);
      detectCache.set(key, { at: Date.now(), found });
    }
    return { prov: PROVIDERS[found.type], profile: { ...profile, type: found.type, baseUrl: found.baseUrl } };
  }
  const prov = PROVIDERS[profile.type];
  if (!prov) throw new ApiError(`알 수 없는 서버 종류입니다: ${profile.type}`, 'bad_profile');
  return { prov, profile };
}

async function need<K extends 'confirm' | 'reportAction' | 'stt' | 'tts'>(profile: ProfileLike, fn: K) {
  const r = await resolve(profile);
  const f = r.prov[fn];
  if (!f) throw new ApiError('이 서버 종류에서는 지원하지 않는 기능입니다 (음성 인식·목소리·서버 작업은 내 비서 서버만).', 'unsupported');
  return { f: f.bind(r.prov) as NonNullable<Provider[K]>, profile: r.profile };
}

export const health = async (profile: ProfileLike) => {
  const r = await resolve(profile, true); // 연결 테스트는 매번 새로 알아본다
  const h = await r.prov.health(r.profile);
  return { ...h, resolvedUrl: r.profile.baseUrl }; // 자동 인식이 붙인 /v1, /api를 화면에 보여 주려고
};
export const chat = async (profile: ProfileLike, req: ChatCall, onEvent: OnEvent, signal?: AbortSignal) => {
  const r = await resolve(profile);
  return r.prov.chat(r.profile, req, onEvent, signal);
};
export const confirm = async (profile: ProfileLike, id: string, approve: boolean) => {
  const n = await need(profile, 'confirm');
  return (n.f as NonNullable<Provider['confirm']>)(n.profile, id, approve);
};
export const reportAction = async (profile: ProfileLike, id: string, result: ActionReport) => {
  const n = await need(profile, 'reportAction');
  return (n.f as NonNullable<Provider['reportAction']>)(n.profile, id, result);
};
export const stt = async (profile: ProfileLike, audio: Buffer, mime: string) => {
  const n = await need(profile, 'stt');
  return (n.f as NonNullable<Provider['stt']>)(n.profile, audio, mime);
};
export const tts = async (profile: ProfileLike, text: string, voice: string, lowSpec?: boolean) => {
  const n = await need(profile, 'tts');
  return (n.f as NonNullable<Provider['tts']>)(n.profile, text, voice, lowSpec);
};


/** 일반 대화/도구 분류를 거치지 않고 확인 답의 뜻만 묻는다. */
export async function interpretConfirmation(profile: ProfileLike, question: string, answer: string, signal?: AbortSignal): Promise<ConfirmationDecision> {
  const known = confirmationDecision(answer);
  if (known !== 'unknown') return known;
  if (!question.trim() || question.length > 2000 || !answer.trim() || answer.length > 500) return 'unknown';
  const resolved = await resolve(profile);
  if (resolved.profile.type === 'assistant') {
    const result = await readJson<{ decision?: unknown }>(entry(resolved.profile), '/confirmation/interpret', { method: 'POST', json: { question, answer }, signal, timeoutMs: 15000 });
    return result.decision === 'yes' || result.decision === 'no' ? result.decision : 'unknown';
  }
  let text = '', invalid = false;
  await resolved.prov.chat({ ...resolved.profile, systemPrompt: '', timeoutSec: 15 }, { text: JSON.stringify({ question, answer }), history: [], client: { persona: CONFIRM_PROMPT } }, (ev) => {
    if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'done' && ev.text) text = ev.text;
    else if (ev.type === 'error' || ev.type === 'client_action' || ev.type === 'confirm') invalid = true;
  }, signal);
  const result = parseJson(text.trim());
  return !invalid && (result?.decision === 'yes' || result?.decision === 'no') ? result.decision : 'unknown';
}
