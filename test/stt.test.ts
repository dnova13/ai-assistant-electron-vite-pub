// 음성 인식: 순서대로 시도·폴백, 내 서버 종류 알아보기, 클라우드 키 빌려 쓰기, 앱 안 위스퍼 관리, 설정 저장.
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as stt from '../src/main/stt';
import { LocalStt, wavToPcm, type WorkerLike } from '../src/main/stt-local';
import { createStore, defaults } from '../src/main/settings';
import { blankProfile } from '../src/shared/char-prefs';
import { defaultStt, normalizeStt, sttReadiness } from '../src/shared/stt';
import type { LocalSttProgress, Profile, Settings, SttSettings } from '../src/shared/types';

/* ---------------- 가짜 서버들 ---------------- */

let hits: string[] = [];
let slowMs = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const url = req.url || '';
    hits.push(url);
    const json = (code: number, o: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    // 규약 v1 서버 (/v1)
    if (url === '/v1srv/v1/health') return json(200, { api: '1', server: 'x', features: { stt: true } });
    if (url === '/v1srv/v1/stt') return setTimeout(() => json(200, { text: '규약 서버 인식' }), slowMs);
    // 음성 인식이 없는 규약 서버
    if (url === '/nostt/v1/health') return json(200, { api: '1', features: { stt: false } });
    // OpenAI 호환 위스퍼 서버
    if (url === '/oa/v1/models') return json(200, { data: [{ id: 'Systran/faster-whisper-small' }] });
    if (url === '/oa/v1/audio/transcriptions') {
      const model = /name="model"\r\n\r\n([^\r]+)/.exec(raw);
      return json(200, { text: `호환 서버 인식 (${model ? model[1] : '?'})` });
    }
    // 고장 난 서버
    if (url.startsWith('/broken/')) return json(500, { error: '서버 고장' });
    // Gemini
    if (url.startsWith('/g/models/gem-x:generateContent')) return json(200, { candidates: [{ content: { parts: [{ text: '제미나이 인식' }] } }] });
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

const WAV = Buffer.from('RIFF....WAVE');

function settingsWith(sttPatch: Partial<SttSettings>, chat?: Partial<Profile>): Settings {
  const s = defaults();
  // 처음 설치에는 프로필이 없으므로 시험용으로 만든다
  s.profiles.local = { ...blankProfile('로컬'), type: 'ollama', baseUrl: base + '/ollama', ...(chat || {}) };
  s.profiles.gemini = { ...blankProfile('Gemini'), type: 'gemini', baseUrl: base + '/g', apiKey: 'gk', model: 'gem-x' };
  s.activeProfile = 'local';
  s.voice.stt = normalizeStt({ ...defaultStt(), ...sttPatch });
  return s;
}

const fakeLocal = (text = '이 컴퓨터 인식', ready = true): stt.LocalEngine => ({
  isReady: () => ready,
  transcribe: async () => text
});

const run = (s: Settings, local: stt.LocalEngine | null = null) => stt.transcribe(WAV, 'audio/wav', { settings: s, chatProfile: s.profiles[s.activeProfile], local });

/* ---------------- 설정 ---------------- */

test('normalizeStt: 기본값과 빠진 순서 채우기', () => {
  const n = normalizeStt({ order: ['local', 'bogus'], timeoutSec: 999, cloud: { provider: 'x' } });
  assert.deepEqual(n.order, ['local', 'server', 'cloud']);
  assert.equal(n.timeoutSec, 60);
  assert.equal(n.cloud.provider, 'gemini');
  assert.equal(n.cloud.enabled, false); // 클라우드는 기본 꺼짐
  assert.equal(n.server.enabled, true);
});

test('sttReadiness: 주소 없는 내 서버는 대화 서버가 지원할 때만, 클라우드 대화면 안 씀', () => {
  const s = settingsWith({});
  assert.equal(sttReadiness(s, null, []).ready, false);
  assert.equal(sttReadiness(s, { features: { stt: true } as never }, []).ready, true);
  const cloudChat = settingsWith({}, { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  assert.equal(sttReadiness(cloudChat, { features: { stt: true } as never }, []).ready, false);
});

test('sttReadiness: 클라우드는 키(또는 같은 회사 대화 프로필 키), 이 컴퓨터는 받은 모델', () => {
  const s = settingsWith({ server: { enabled: false, baseUrl: '', apiKey: '', model: '' }, cloud: { enabled: true, provider: 'gemini', apiKey: '', model: '' } });
  assert.equal(sttReadiness(s, null, []).ready, true); // gemini 대화 프로필에 키가 있음
  const l = settingsWith({ server: { enabled: false, baseUrl: '', apiKey: '', model: '' }, local: { enabled: true, model: 'small' } });
  assert.equal(sttReadiness(l, null, []).ready, false);
  assert.equal(sttReadiness(l, null, ['small']).ready, true);
});

test('설정 저장: 음성 인식 키도 암호화해서 저장하고 다시 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-set-'));
  const file = path.join(dir, 'settings.json');
  const fake = { isEncryptionAvailable: () => true, encryptString: (x: string) => Buffer.from('enc:' + x), decryptString: (b: Buffer) => b.toString().slice(4) };
  const store = createStore(file, fake);
  const s = defaults();
  s.voice.stt.server.apiKey = 'srv-secret';
  s.voice.stt.cloud.apiKey = 'cloud-secret';
  store.save(s);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('srv-secret') && !disk.includes('cloud-secret'));
  const back = store.load();
  assert.equal(back.voice.stt.server.apiKey, 'srv-secret');
  assert.equal(back.voice.stt.cloud.apiKey, 'cloud-secret');
});

/* ---------------- 내 서버 ---------------- */

test('detectServer: 규약 v1 / OpenAI 호환 / 음성 인식 없음 / 못 찾음', async () => {
  assert.equal((await stt.detectServer({ baseUrl: base + '/v1srv', apiKey: '' })).kind, 'v1');
  const oa = await stt.detectServer({ baseUrl: base + '/oa/v1', apiKey: '' });
  assert.equal(oa.kind, 'openai');
  assert.deepEqual(oa.models, ['Systran/faster-whisper-small']);
  await assert.rejects(stt.detectServer({ baseUrl: base + '/nostt', apiKey: '' }), /지원하지 않는다/);
  await assert.rejects(stt.detectServer({ baseUrl: base + '/none', apiKey: '' }), /찾지 못했습니다/);
});

test('내 서버(규약 v1)로 인식', async () => {
  const r = await run(settingsWith({ server: { enabled: true, baseUrl: base + '/v1srv', apiKey: '', model: '' } }));
  assert.equal(r.text, '규약 서버 인식');
  assert.equal(r.source, 'server');
  assert.equal(r.failures.length, 0);
});

test('내 서버(OpenAI 호환)로 인식 — 모델을 비우면 서버의 첫 모델', async () => {
  const r = await run(settingsWith({ server: { enabled: true, baseUrl: base + '/oa', apiKey: '', model: '' } }));
  assert.equal(r.text, '호환 서버 인식 (Systran/faster-whisper-small)');
});

/* ---------------- 순서·폴백 ---------------- */

test('내 서버가 고장 나면 다음(이 컴퓨터)으로 넘어가고 실패 이유를 남긴다', async () => {
  const s = settingsWith({
    server: { enabled: true, baseUrl: base + '/v1srv', apiKey: '', model: '' },
    local: { enabled: true, model: 'small' }
  });
  s.voice.stt.server.baseUrl = base + '/broken';
  const r = await run(s, fakeLocal());
  assert.equal(r.source, 'local');
  assert.equal(r.text, '이 컴퓨터 인식');
  assert.equal(r.failures[0].source, 'server');
});

test('내 서버가 시간 안에 답하지 않으면 다음으로', async () => {
  slowMs = 4000;
  try {
    const s = settingsWith({ server: { enabled: true, baseUrl: base + '/v1srv', apiKey: '', model: '' }, local: { enabled: true, model: 'small' }, timeoutSec: 3 });
    const t0 = Date.now();
    const r = await run(s, fakeLocal());
    assert.equal(r.source, 'local');
    assert.match(r.failures[0].message, /3초 안에 답이 없습니다/);
    assert.ok(Date.now() - t0 < 3900);
  } finally {
    slowMs = 0;
  }
}, 10000);

test('클라우드(Gemini): 꺼져 있으면 건너뛰고, 켜면 대화 프로필의 키·모델을 빌려 쓴다', async () => {
  const off = settingsWith({ server: { enabled: false, baseUrl: '', apiKey: '', model: '' } });
  await assert.rejects(run(off), /켜진 음성 인식이 없습니다/);
  const on = settingsWith({ server: { enabled: false, baseUrl: '', apiKey: '', model: '' }, cloud: { enabled: true, provider: 'gemini', apiKey: '', model: '' } });
  hits = [];
  const r = await run(on);
  assert.equal(r.text, '제미나이 인식');
  assert.equal(r.source, 'cloud');
  assert.equal(r.label, '클라우드 (Gemini)');
  assert.ok(hits.some((h) => h.startsWith('/g/models/gem-x:generateContent')));
});

test('주소 없는 내 서버: 대화 AI가 클라우드면 음성을 보내지 않는다', async () => {
  const s = settingsWith({ local: { enabled: true, model: 'small' } }, { type: 'gemini', baseUrl: base + '/g', apiKey: 'gk', model: 'gem-x' });
  hits = [];
  const r = await run(s, fakeLocal());
  assert.equal(r.source, 'local');
  assert.equal(hits.length, 0);
});

test('모두 실패하면 이유를 모아 알려 준다', async () => {
  const s = settingsWith({ server: { enabled: true, baseUrl: base + '/broken', apiKey: '', model: '' }, local: { enabled: true, model: 'small' } });
  await assert.rejects(run(s, fakeLocal('', false)), (e: Error) => /내 서버 \/ 로컬/.test(e.message) && /이 컴퓨터/.test(e.message));
});

test('순서를 바꾸면 그 순서대로 시도한다', async () => {
  const s = settingsWith({ order: ['local', 'server', 'cloud'], server: { enabled: true, baseUrl: base + '/v1srv', apiKey: '', model: '' }, local: { enabled: true, model: 'small' } });
  const r = await run(s, fakeLocal());
  assert.equal(r.source, 'local');
});

/* ---------------- 앱 안 위스퍼 ---------------- */

function wav16k(samples: number[]): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
}

test('wavToPcm: 16kHz 16비트 모노를 -1~1 로', () => {
  const pcm = wavToPcm(wav16k([0, 16384, -32768]));
  assert.deepEqual([...pcm], [0, 0.5, -1]);
  assert.throws(() => wavToPcm(Buffer.from('not a wav at all, definitely not')), /wav 형식이 아닙니다/);
});

class FakeWorker implements WorkerLike {
  sent: Record<string, unknown>[] = [];
  private onMsg: ((m: never) => void)[] = [];
  private onExit: ((c: number) => void)[] = [];
  killed = false;
  postMessage(msg: Record<string, unknown>) {
    this.sent.push(msg);
    const reply = (m: Record<string, unknown>) => setTimeout(() => this.onMsg.forEach((f) => f(m as never)), 5);
    if (msg.type === 'load') {
      if (msg.model === 'medium') return; // 끝나지 않는 받기 (취소 시험용)
      reply({ id: msg.id, type: 'progress', progress: 0.5, file: 'onnx/encoder_model_quantized.onnx' });
      setTimeout(() => reply({ id: msg.id, ok: true }), 10);
    } else if (msg.type === 'transcribe') {
      reply({ id: msg.id, ok: true, text: ` 샘플 ${(msg.pcm as Float32Array).length}개 ` });
    }
  }
  on(ev: 'message' | 'exit', cb: (x: never) => void) {
    if (ev === 'message') this.onMsg.push(cb);
    else this.onExit.push(cb as (c: number) => void);
    return this;
  }
  kill() {
    this.killed = true;
    setTimeout(() => this.onExit.forEach((f) => f(1)), 1);
    return true;
  }
}

test('LocalStt: 받기 진행률 → 표시 파일 → 인식', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const progress: LocalSttProgress[] = [];
  let spawnedEnv: Record<string, string> = {};
  const w = new FakeWorker();
  const local = new LocalStt(dir, (env) => ((spawnedEnv = env), w), (p) => progress.push(p));
  assert.deepEqual(local.status().downloaded, []);
  await local.download('small');
  assert.equal(spawnedEnv.STT_CACHE_DIR, dir);
  assert.ok(progress.some((p) => p.progress === 0.5 && p.file));
  assert.ok(progress.at(-1)?.done && !progress.at(-1)?.error);
  assert.deepEqual(local.status().downloaded, ['small']);
  assert.ok(fs.existsSync(path.join(dir, 'small.ready')));
  const text = await local.transcribe(wav16k(new Array(3200).fill(0)), 'small');
  assert.equal(text, '샘플 3200개');
});

test('LocalStt: 받기 취소 → 엔진을 끄고 "취소" 오류, 표시 파일 없음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const progress: LocalSttProgress[] = [];
  const w = new FakeWorker();
  const local = new LocalStt(dir, () => w, (p) => progress.push(p));
  const p = local.download('medium');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(local.status().downloading?.model, 'medium');
  assert.equal(local.cancel(), true);
  await assert.rejects(p, /취소했습니다/);
  assert.equal(w.killed, true);
  assert.equal(local.status().downloading, null);
  assert.ok(!fs.existsSync(path.join(dir, 'medium.ready')));
});

test('LocalStt: 받지 않은 모델로는 인식하지 않는다', async () => {
  const local = new LocalStt(fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-')), () => new FakeWorker(), () => {});
  await assert.rejects(local.transcribe(wav16k([0]), 'base'), /아직 받지 않았습니다/);
});
