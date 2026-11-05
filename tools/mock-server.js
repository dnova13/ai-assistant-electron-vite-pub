#!/usr/bin/env node
'use strict';
// API 규약 v1을 흉내 내는 가짜 비서 서버. 의존성 없음.
// 실행: npm run mock   (주소 http://127.0.0.1:8765, 토큰 dev-token)
// 환경변수: MOCK_PORT, MOCK_TOKEN
//
// 시험해 볼 문장
//   "보고서.pdf 문서로 옮겨줘"  → client_action file.move
//   "보고서.pdf 열어줘"          → client_action file.open
//   "서비스 nginx 재시작"         → confirm
//   그 밖의 문장                  → 글자를 조금씩 흘려보내는 답변

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.MOCK_PORT || 8765);
const TOKEN = process.env.MOCK_TOKEN || 'dev-token';
const pending = new Map(); // confirm id -> expiresAt
const turns = new Map(); // session -> 대화 횟수 (캐릭터별 기억 흉내)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const fail = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 진폭이 오르내리는 소리를 만들어 립싱크가 움직이는지 볼 수 있게 한다.
function makeWav(text) {
  const rate = 16000;
  const seconds = Math.min(6, Math.max(0.6, [...text].length * 0.09));
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const syllable = Math.max(0, Math.sin(Math.PI * 2 * 4 * t)); // 초당 4음절 느낌
    const v = Math.sin(Math.PI * 2 * 220 * t) * 0.35 * syllable;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function fileName(text) {
  const m = text.match(/([^\s"'“”]+\.[A-Za-z0-9]{1,6})/);
  return m ? m[1] : null;
}

async function chat(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const line = (o) => res.write(JSON.stringify(o) + '\n');
  const text = String(body.text || '').trim();
  const file = fileName(text);

  if (/서비스\s+\S+\s+(재시작|시작|중지)/.test(text)) {
    const id = newId('c');
    pending.set(id, Date.now() + 60000);
    line({ type: 'confirm', id, message: `(가짜 서버) ${text.replace(/^서비스\s+/, '')} 을(를) 실행합니다.`, expires_in: 60 });
    line({ type: 'done' });
    return res.end();
  }
  if (file && /(옮겨|이동)/.test(text)) {
    const dest = /바탕화면|desktop/i.test(text) ? 'desktop' : /다운로드|downloads/i.test(text) ? 'downloads' : 'documents';
    const say = `${file}을(를) 옮길게요. 확인 창을 봐 주세요.`;
    line({ type: 'delta', text: say });
    line({ type: 'client_action', id: newId('a'), action: 'file.move', args: { target: file, dest }, say });
    line({ type: 'done', text: say });
    return res.end();
  }
  if (file && /(열어|열기)/.test(text)) {
    line({ type: 'delta', text: `${file}을(를) 열게요.` });
    line({ type: 'client_action', id: newId('a'), action: 'file.open', args: { target: file } });
    line({ type: 'done' });
    return res.end();
  }
  const session = typeof body.session === 'string' && body.session ? body.session : '(기본)';
  const n = (turns.get(session) || 0) + 1;
  turns.set(session, n);
  const low = body.options && body.options.low_spec ? ' · 저사양' : '';
  const answer = `(가짜 서버 · 기억 ${session} ${n}번째${low}) "${text}"라고 하셨네요. 규약 시험용 답변입니다. 문장 단위로 목소리를 읽는지도 확인해 보세요.`;
  for (const piece of answer.match(/.{1,6}/gsu) || []) {
    line({ type: 'delta', text: piece });
    await sleep(40);
  }
  line({ type: 'done', text: answer });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ${msg || ''}`);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    log('401');
    return fail(res, 401, 'unauthorized', '토큰이 없거나 틀렸습니다.');
  }
  try {
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      log();
      return sendJson(res, 200, {
        api: '1',
        server: 'mock-server',
        version: '0.0.1',
        model: 'mock-model',
        features: {
          chat_stream: true,
          stt: true,
          tts: true,
          server_confirm: true,
          sessions: true,
          low_spec: true,
          client_actions: ['file.open', 'file.reveal', 'file.move', 'file.copy', 'file.search']
        },
        tts_voices: ['default']
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      log(`${JSON.stringify(body.text)} session=${body.session || '-'}${body.options && body.options.low_spec ? ' low_spec' : ''}`);
      return chat(res, body);
    }
    if (req.method === 'POST' && url.pathname === '/v1/confirm') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const exp = pending.get(body.id);
      pending.delete(body.id);
      log(`${body.id} approve=${body.approve}`);
      if (!exp || Date.now() > exp) return fail(res, 410, 'expired', '시간이 지났거나 없는 요청입니다. 다시 요청해 주세요.');
      return sendJson(res, 200, { text: body.approve ? '(가짜 서버) 실행했습니다.' : '취소했습니다.' });
    }
    const m = url.pathname.match(/^\/v1\/actions\/([^/]+)\/result$/);
    if (req.method === 'POST' && m) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      log(`${decodeURIComponent(m[1])} ${body.status}: ${body.detail || ''}`);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/v1/stt') {
      const raw = await readBody(req, 10 * 1024 * 1024);
      log(`${raw.length} bytes ${req.headers['content-type'] || ''}`.slice(0, 120));
      return sendJson(res, 200, { text: '(가짜 인식) 오늘 날씨 어때?', language: 'ko', duration: 1.5 });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tts') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const wav = makeWav(String(body.text || ''));
      log(`${JSON.stringify(String(body.text || '').slice(0, 30))}${body.low_spec ? ' low_spec' : ''} -> ${wav.length} bytes`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      return res.end(wav);
    }
    log('404');
    return fail(res, 404, 'not_found', '없는 경로입니다.');
  } catch (e) {
    log(`error ${e.message}`);
    if (!res.headersSent) fail(res, e.status || 400, 'bad_request', e.status === 413 ? '음성이 너무 깁니다.' : '요청을 읽을 수 없습니다.');
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`가짜 비서 서버: http://127.0.0.1:${PORT}  (토큰: ${TOKEN})`);
  });
}

module.exports = { server, makeWav };
