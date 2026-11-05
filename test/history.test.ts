import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistory } from '../src/main/history';

test('캐릭터별로 따로 저장되고, 지우면 _to_delete로 옮겨진다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const h = createHistory(dir, { max: 3 });
  h.append('hana', [{ role: 'user', text: '안녕' }, { role: 'bot', text: '반가워요' }]);
  h.append('rin', [{ role: 'user', text: '하이' }]);
  assert.equal(h.load('hana').length, 2);
  assert.equal(h.load('rin').length, 1);
  h.append('hana', [{ role: 'user', text: 'a' }, { role: 'bot', text: 'b' }]);
  assert.deepEqual(h.load('hana').map((m) => m.text), ['반가워요', 'a', 'b']); // 최대 3개
  h.append('hana', [{ role: 'system', text: 'x' }, { role: 'user', text: '   ' }]); // 이상한 항목은 버림
  assert.equal(h.load('hana').length, 3);
  const moved = h.clear('hana') || '';
  assert.ok(moved.includes(`${path.sep}_to_delete${path.sep}`));
  assert.ok(fs.existsSync(moved));
  assert.equal(h.load('hana').length, 0);
  assert.equal(h.load('rin').length, 1);
});

test('이상한 캐릭터 id도 안전한 파일 이름이 된다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const h = createHistory(dir);
  h.append('../../etc/passwd', [{ role: 'user', text: 'x' }]);
  h.append('하나', [{ role: 'user', text: 'y' }]);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => /^c_[0-9a-f]{16}\.json$/.test(f)));
  assert.equal(h.load('하나')[0].text, 'y');
});


test('출처·원래 시각·검색 결과·실패 표시를 보관하고 같은 메시지는 한 번만 저장한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const h = createHistory(dir);
  const first = { id: 'request:user', role: 'user', text: '파일 복사 메모', time: '2026-11-05T01:00:00.000Z', source: '디스코드', memory: false };
  const result = { id: 'result', role: 'bot', text: '찾기 결과', time: '2026-11-05T01:00:01.000Z', results: [{ path: '/qa/메모', display: '시험/메모' }], memory: false };
  h.append('sample', [result, first]);
  h.append('sample', [{ ...first, text: '파일 복사 메모.txt' }, { id: 'error', role: 'bot', text: '실패했습니다.', tone: 'error', memory: false }, { role: 'sys', text: '취소했습니다.', source: '디스코드' }, { role: 'err', text: '오류' }]);
  const restored = createHistory(dir).load('sample');
  assert.equal(restored.length, 5);
  assert.deepEqual(restored[0], { ...first, text: '파일 복사 메모.txt' });
  assert.deepEqual(restored[1], result);
  assert.equal(restored[2].tone, 'error');
  assert.deepEqual(restored.slice(-2).map(m => m.role), ['sys', 'err']);
  assert.ok(restored.slice(2).every(m => m.id && m.time));
  const archived = h.clear('sample');
  assert.ok(archived);
  assert.deepEqual(JSON.parse(fs.readFileSync(archived, 'utf8')).messages, restored);
});

test('이전 시각 없는 기록을 읽고 새 기록과 합쳐도 보존한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ messages: [{ role: 'user', text: '예전 기록' }] }));
  const h = createHistory(dir);
  h.append('sample', [{ id: 'new', role: 'user', text: '새 기록' }]);
  assert.deepEqual(h.load('sample')[0], { role: 'user', text: '예전 기록' });
  assert.equal(h.load('sample')[1].id, 'new');
});
