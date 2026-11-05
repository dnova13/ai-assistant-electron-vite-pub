// ChatGPT(OpenAI 호환)·Claude·Gemini 직접 연결이 각 회사 API 모양대로 요청하고 스트림을 읽는지,
// 가짜 서버로 확인한다 (실제 키 없이).
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as api from '../src/main/api/client';
import type { ChatEvent, ProviderType } from '../src/shared/types';

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}
let seen: Seen[] = [];
let rejectTemperature = false;

const sse = (res: http.ServerResponse, chunks: unknown[], done = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`event: x\r\ndata: ${JSON.stringify(c)}\r\n\r\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* multipart 등 JSON이 아닌 본문 */
    }
    const url = req.url || '';
    seen.push({ path: url, headers: req.headers, body });
    const json = (code: number, o: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (rejectTemperature && 'temperature' in body) return json(400, { error: { message: 'Unsupported parameter: temperature' } });
    // OpenAI
    if (url === '/v1/models') return json(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'local-llm' }] });
    if (url === '/v1/chat/completions') return sse(res, [{ choices: [{ delta: { role: 'assistant' } }] }, { choices: [{ delta: { content: '안녕' } }] }, { choices: [{ delta: { content: '하세요' } }] }], true);
    // Claude
    if (url.startsWith('/a/v1/models')) return json(200, { data: [{ id: 'claude-sonnet-4-5' }] });
    if (url === '/a/v1/messages')
      return sse(res, [
        { type: 'message_start' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '반가' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '워요' } },
        { type: 'message_stop' }
      ]);
    // Gemini
    if (url.startsWith('/g/models?'))
      return json(200, {
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
        ]
      });
    if (url.startsWith('/g/models/gemini-2.5-flash:streamGenerateContent'))
      return sse(res, [
        { candidates: [{ content: { parts: [{ text: '생각 중', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: '좋은 ' }] } }] },
        { candidates: [{ content: { parts: [{ text: '아침' }] } }] }
      ]);
    if (url.startsWith('/g/models/blocked:'))
      return sse(res, [{ promptFeedback: { blockReason: 'SAFETY' } }]);
    // 음성 인식
    if (url === '/v1/audio/transcriptions') return json(200, { text: ' 안녕하세요 오픈에이아이 ' });
    if (url.startsWith('/g/models/gemini-2.5-flash:generateContent'))
      return json(200, { candidates: [{ content: { parts: [{ text: '안녕하세요 ' }, { text: '제미나이' }] } }] });
    // 자동 인식용
    if (url === '/ol/api/tags') return json(200, { models: [{ name: 'llama3' }] });
    if (url === '/as/v1/health') return json(200, { api: '1', server: 'x', features: {} });
    // 내 서버: 입구가 /ai-agent 인 서버
    if (url === '/ai-agent/health') return json(200, { api: '1', server: 'agent', features: { client_actions: ['file.backup'] } });
    if (url === '/ai-agent/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return res.end(JSON.stringify({ type: 'client_action', id: 'a1', action: 'file.backup', args: { target: '메모.txt' }, say: '백업' }) + '\n' + JSON.stringify({ type: 'done', text: '백업' }) + '\n');
    }
    if (url === '/ai-agent/actions/a1/result') {
      res.writeHead(204);
      return res.end();
    }
    if (url === '/html/api/tags' || url === '/html/models' || url === '/html/v1/models' || url === '/html/v1/health') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>hello</html>');
    }
    // Open WebUI: /api/models 에만 OpenAI 호환 목록이 있다 (/models, /v1/models 는 없음)
    if (url === '/ow/api/models') return json(200, { data: [{ id: 'doc-ai' }, { id: 'llama3.1:8b' }] });
    if (url.startsWith('/locked/')) return json(401, { error: 'no' });
    json(404, {});
  });
});

let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const prof = (type: ProviderType, path: string, extra: Record<string, unknown> = {}) => ({
  type,
  baseUrl: base + path,
  apiKey: 'k-123',
  model: '',
  systemPrompt: '비서',
  temperature: 0.7,
  timeoutSec: 10,
  ...extra
});

async function talk(p: ReturnType<typeof prof>, history: api.ChatCall['history'] = []) {
  seen = [];
  const events: ChatEvent[] = [];
  await api.chat(p, { text: '질문', history, client: { persona: '고양이 말투' } }, (e) => events.push(e));
  const last = events.at(-1);
  return { events, last, text: last && last.type === 'done' ? last.text : null, req: seen.at(-1) as Seen };
}

test('openai: 모델 목록과 스트리밍', async () => {
  const h = await api.health(prof('openai', '/v1'));
  assert.equal(h.provider, 'openai');
  assert.deepEqual(h.models, ['gpt-4o-mini', 'local-llm']); // 호환 서버는 거르지 않음
  const r = await talk(prof('openai', '/v1', { model: 'gpt-4o-mini' }), [{ role: 'user', content: '전' }, { role: 'assistant', content: '답' }]);
  assert.equal(r.text, '안녕하세요');
  assert.equal(r.req.headers.authorization, 'Bearer k-123');
  const msgs = r.req.body.messages as { role: string; content: string }[];
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /고양이 말투/);
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(r.req.body.stream, true);
});

test('claude: x-api-key 헤더, system 분리, 번갈아 나오는 대화', async () => {
  const h = await api.health(prof('anthropic', '/a'));
  assert.deepEqual(h.models, ['claude-sonnet-4-5']);
  // 주소에 /v1 을 붙여 넣어도 동작
  const r = await talk(prof('anthropic', '/a/v1', { model: 'claude-sonnet-4-5' }), [
    { role: 'assistant', content: '먼저 온 답' },
    { role: 'user', content: '앞 질문' },
    { role: 'user', content: '또 질문' }
  ]);
  assert.equal(r.text, '반가워요');
  assert.equal(r.req.headers['x-api-key'], 'k-123');
  assert.equal(r.req.headers.authorization, undefined);
  assert.equal(r.req.headers['anthropic-version'], '2023-06-01');
  assert.match(String(r.req.body.system), /비서/);
  const msgs = r.req.body.messages as { role: string; content: string }[];
  assert.deepEqual(msgs.map((m) => m.role), ['user']); // 앞의 assistant는 빠지고 user 셋은 합쳐짐
  assert.match(msgs[0].content, /앞 질문[\s\S]*또 질문[\s\S]*질문/);
  assert.equal(typeof r.req.body.max_tokens, 'number');
});

test('gemini: 모델 거르기, 생각 과정 숨김, role=model', async () => {
  const h = await api.health(prof('gemini', '/g'));
  assert.deepEqual(h.models, ['gemini-2.5-flash']);
  const r = await talk(prof('gemini', '/g', { model: 'gemini-2.5-flash' }), [{ role: 'user', content: '전' }, { role: 'assistant', content: '답' }]);
  assert.equal(r.text, '좋은 아침');
  assert.ok(!r.events.some((e) => e.type === 'delta' && e.text.includes('생각')));
  assert.equal(r.req.headers['x-goog-api-key'], 'k-123');
  assert.match(r.req.path, /alt=sse/);
  const contents = r.req.body.contents as { role: string }[];
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.ok(r.req.body.systemInstruction);
});

test('gemini: 차단되면 오류 이벤트', async () => {
  const r = await talk(prof('gemini', '/g', { model: 'blocked' }));
  assert.equal(r.last?.type, 'error');
});

test('temperature를 거부하는 모델이면 빼고 다시 보낸다', async () => {
  rejectTemperature = true;
  try {
    const r = await talk(prof('openai', '/v1', { model: 'o3' }));
    assert.equal(r.text, '안녕하세요');
    assert.ok(!('temperature' in r.req.body));
  } finally {
    rejectTemperature = false;
  }
});

test('키가 없거나 http 원격 주소면 요청 전에 막는다', async () => {
  const codeIs = (code: string) => (e: unknown) => (e as api.ApiError).code === code;
  await assert.rejects(api.health({ ...prof('gemini', '/g'), apiKey: '' }), codeIs('auth'));
  await assert.rejects(api.health({ ...prof('anthropic', ''), baseUrl: 'http://example.com' }), codeIs('bad_url'));
  await assert.rejects(api.chat(prof('anthropic', '/a'), { text: 'x' }, () => {}), codeIs('no_model'));
});

test('직접 연결 종류는 음성 기능이 없다고 알려 준다', async () => {
  await assert.rejects(api.tts(prof('openai', '/v1'), '안녕', 'default'), (e: unknown) => (e as api.ApiError).code === 'unsupported');
});

/* ---------------- 자동 인식 ---------------- */

test('auto: Ollama 서버 알아보기 (/v1을 붙여 넣어도)', async () => {
  const p = { type: 'auto' as const, baseUrl: base + '/ol', apiKey: '', timeoutSec: 10 };
  const d = await api.detect(p);
  assert.equal(d.type, 'ollama');
  assert.equal(d.baseUrl, base + '/ol');
  const h = await api.health(p);
  assert.equal(h.provider, 'ollama');
  assert.deepEqual(h.models, ['llama3']);
});

test('auto: OpenAI 호환 서버 — /v1 없이 적어도 찾는다', async () => {
  const d = await api.detect({ type: 'auto', baseUrl: base, apiKey: 'k', timeoutSec: 10 });
  assert.equal(d.type, 'openai');
  assert.equal(d.baseUrl, base + '/v1');
});

test('auto: Open WebUI — 주소만 적어도 /api를 찾고, /api를 적어도 된다', async () => {
  const a = await api.detect({ type: 'auto', baseUrl: base + '/ow', apiKey: 'k', timeoutSec: 10 });
  assert.equal(a.type, 'openai');
  assert.equal(a.baseUrl, base + '/ow/api');
  const b = await api.detect({ type: 'auto', baseUrl: base + '/ow/api', apiKey: 'k', timeoutSec: 10 });
  assert.equal(b.baseUrl, base + '/ow/api');
  const h = await api.health({ type: 'auto', baseUrl: base + '/ow', apiKey: 'k', timeoutSec: 10 });
  assert.equal(h.provider, 'openai');
  assert.deepEqual(h.models, ['doc-ai', 'llama3.1:8b']);
  assert.equal(h.resolvedUrl, base + '/ow/api'); // 화면에 인식한 주소를 보여 줌
});

test('auto: 비서 서버 알아보기', async () => {
  const d = await api.detect({ type: 'auto', baseUrl: base + '/as', apiKey: '', timeoutSec: 10 });
  assert.equal(d.type, 'assistant');
  assert.equal(d.baseUrl, base + '/as/v1');
  const h = await api.health({ type: 'auto', baseUrl: base + '/as', apiKey: '', timeoutSec: 10 });
  assert.equal(h.server, 'x');
});

test('내 서버: 경로가 없으면 /v1, 있으면 적은 그대로가 입구', () => {
  assert.equal(api.assistantEntry('https://서버.example'), 'https://서버.example/v1');
  assert.equal(api.assistantEntry('https://서버.example/'), 'https://서버.example/v1');
  assert.equal(api.assistantEntry('https://서버.example/v1'), 'https://서버.example/v1');
  assert.equal(api.assistantEntry('https://서버.example/ai-agent/'), 'https://서버.example/ai-agent');
  assert.equal(api.assistantEntry('주소 아님'), '주소 아님');
});

test('내 서버: 입구가 /ai-agent 여도 확인·대화·결과 보고가 그 경로로 간다', async () => {
  const p = { type: 'assistant' as const, baseUrl: base + '/ai-agent', apiKey: 'k', timeoutSec: 10 };
  const h = await api.health(p);
  assert.equal(h.server, 'agent');
  assert.deepEqual(h.features.clientActions, ['file.backup']);
  const events: ChatEvent[] = [];
  await api.chat(p, { text: '메모.txt 백업해줘' }, (e) => events.push(e));
  assert.equal(events[0].type, 'client_action');
  await api.reportAction(p, 'a1', { status: 'done', detail: '' });
  assert.equal(seen.at(-1)?.path, '/ai-agent/actions/a1/result');
});

test('auto: 아무 웹페이지가 200을 줘도 속지 않는다', async () => {
  await assert.rejects(api.detect({ type: 'auto', baseUrl: base + '/html', apiKey: '', timeoutSec: 10 }), (e: unknown) => (e as api.ApiError).code === 'unreachable');
});

test('auto: 인증이 필요하면 키 안내', async () => {
  await assert.rejects(api.detect({ type: 'auto', baseUrl: base + '/locked', apiKey: '', timeoutSec: 10 }), (e: unknown) => (e as api.ApiError).code === 'auth');
});

test('auto: 대화도 인식한 종류로 보낸다', async () => {
  seen = [];
  const events: ChatEvent[] = [];
  await api.chat({ type: 'auto', baseUrl: base, apiKey: 'k', model: 'm', systemPrompt: '', temperature: 0.7, timeoutSec: 10 }, { text: '질문' }, (e) => events.push(e));
  assert.equal(seen.at(-1)?.path, '/v1/chat/completions');
  assert.equal(events.at(-1)?.type, 'done');
});

/* ---------------- 음성 인식 ---------------- */

test('stt: OpenAI는 multipart(file, model, language)로 보내고 글을 받는다', async () => {
  seen = [];
  const r = await api.stt(prof('openai', '/v1', { model: 'gpt-4o-mini' }), Buffer.from('RIFFxxxx'), 'audio/webm;codecs=opus');
  assert.equal(r.text, '안녕하세요 오픈에이아이');
  const req = seen.at(-1) as Seen;
  assert.equal(req.path, '/v1/audio/transcriptions');
  assert.equal(req.headers.authorization, 'Bearer k-123');
  assert.match(String(req.headers['content-type']), /multipart\/form-data/);
});

test('stt: Gemini는 음성을 inline_data로 보내 받아 적는다', async () => {
  seen = [];
  const r = await api.stt(prof('gemini', '/g', { model: 'gemini-2.5-flash' }), Buffer.from('RIFFxxxx'), 'audio/wav');
  assert.equal(r.text, '안녕하세요 제미나이');
  const req = seen.at(-1) as Seen;
  assert.equal(req.headers['x-goog-api-key'], 'k-123');
  const parts = (req.body.contents as { parts: { inline_data?: { mime_type: string; data: string } }[] }[])[0].parts;
  const audio = parts.find((p) => p.inline_data)?.inline_data;
  assert.equal(audio?.mime_type, 'audio/wav');
  assert.equal(Buffer.from(audio?.data || '', 'base64').toString(), 'RIFFxxxx');
});

test('stt: health가 음성 인식 가능 여부를 알려 준다 (Gemini O, Claude X, 호환 서버 X)', async () => {
  assert.equal((await api.health(prof('gemini', '/g'))).features.stt, true);
  assert.equal((await api.health(prof('anthropic', '/a'))).features.stt, false);
  assert.equal((await api.health(prof('openai', '/v1'))).features.stt, false); // 공식 주소가 아니면 알 수 없음
});

test('stt: Claude는 지원하지 않는다고 알려 준다', async () => {
  await assert.rejects(api.stt(prof('anthropic', '/a'), Buffer.alloc(1), 'audio/wav'), (e: unknown) => (e as api.ApiError).code === 'unsupported');
});

/* ---------------- Gemini 모델 거르기 ---------------- */

test('Gemini 모델 목록: 대화·음성 입력에 못 쓰는 것과 종료된 것을 빼고, 무료 구간 있는 것부터', async () => {
  const { isUsableGeminiModel, geminiFree, geminiLabel, sortGeminiModels } = await import('../src/shared/gemini-models');
  const all = ['gemini-4-argon', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-pro-preview-customtools', 'gemini-3.1-flash-lite-preview', 'gemini-nano-banana-2.1',
    'gemini-3.5-flash-lite', 'gemini-omni-1.1-flash', 'gemini-3.5-transcribe', 'gemini-robotics-er-2-preview', 'gemini-2.5-computer-use-preview-10-2025', 'gemini-3.8-flash-tts', 'gemini-3.8-live', 'gemini-3.8-flash'];
  const kept = sortGeminiModels(all.filter(isUsableGeminiModel));
  assert.deepEqual(kept, ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-4-argon']);
  assert.equal(geminiFree('gemini-3.8-flash'), true);
  assert.equal(geminiFree('gemini-4-argon'), false);
  assert.equal(geminiFree('gemini-flash-latest'), null);
  assert.match(geminiLabel('gemini-3.5-flash-lite'), /무료/);
  assert.match(geminiLabel('gemini-3.1-pro-preview'), /유료/);
});
