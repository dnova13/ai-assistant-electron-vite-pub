import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkAccelerator, isDevToolsKey } from '../src/main/shortcut';

test('단축키 형식 검사', () => {
  for (const ok of ['CommandOrControl+Shift+Space', 'Alt+F2', 'F9', 'Ctrl+Shift+M', 'Command+Option+1', 'Shift++', 'Super+Up']) {
    assert.equal(checkAccelerator(ok), null, ok);
  }
  assert.match(checkAccelerator('Nope+Key+Q') || '', /알 수 없는 조합키/);
  assert.match(checkAccelerator('Ctrl+Shift+Banana') || '', /알 수 없는 키/);
  assert.match(checkAccelerator('M') || '', /같이 눌러야/);
  assert.match(checkAccelerator('Ctrl+Ctrl+M') || '', /두 번/);
  assert.match(checkAccelerator('Ctrl+') || '', /알 수 없는 키/);
});

test('개발자 도구 키: F12, 맥 Cmd+Option+I, 그 밖 Ctrl+Shift+I (다른 키는 아님)', () => {
  assert.equal(isDevToolsKey({ key: 'F12' }, 'darwin'), true);
  assert.equal(isDevToolsKey({ key: 'F12' }, 'win32'), true);
  assert.equal(isDevToolsKey({ key: 'i', meta: true, alt: true }, 'darwin'), true);
  assert.equal(isDevToolsKey({ key: 'I', control: true, shift: true }, 'win32'), true);
  assert.equal(isDevToolsKey({ key: 'i', control: true, shift: true }, 'linux'), true);
  assert.equal(isDevToolsKey({ key: 'i', control: true, shift: true }, 'darwin'), false); // 맥은 Cmd+Option+I
  assert.equal(isDevToolsKey({ key: 'i', meta: true, alt: true }, 'win32'), false);
  assert.equal(isDevToolsKey({ key: 'i' }, 'darwin'), false);
  assert.equal(isDevToolsKey({ key: 'F11' }, 'darwin'), false);
});
