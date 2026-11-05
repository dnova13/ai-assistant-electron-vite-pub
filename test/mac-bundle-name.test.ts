import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const fix = createRequire(import.meta.url)('../tools/fix-mac-bundle-name.cjs');
const macTest = test.runIf(process.platform === 'darwin');

function fixture(displayName: string, productFilename = displayName.normalize('NFD')) {
  const appOutDir = mkdtempSync(path.join(tmpdir(), 'mac-bundle-name-test-'));
  const sanitizedProductName = displayName.normalize('NFD');
  const contents = path.join(appOutDir, productFilename + '.app', 'Contents');
  const helper = path.join(contents, 'Frameworks', sanitizedProductName + ' Helper.app');
  mkdirSync(helper, { recursive: true });
  const plist = path.join(contents, 'Info.plist');
  const values = { CFBundleName: displayName, CFBundleDisplayName: displayName, CFBundleExecutable: productFilename, CFBundleIdentifier: 'com.example.test', NSMicrophoneUsageDescription: '마이크 시험' };
  writeFileSync(plist, JSON.stringify(values));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plist]);
  return { plist, values, context: { electronPlatformName: 'darwin', appOutDir, packager: { appInfo: { productFilename, sanitizedProductName } } } };
}

for (const name of ['AI 비서', 'AI café', 'AI Assistant']) {
  macTest('맥 빌드 이름 일치·표시 이름 보존·반복 실행: ' + name, async () => {
    const { plist, values, context } = fixture(name);
    await fix(context);
    const result = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    assert.deepEqual(result, { ...values, CFBundleName: context.packager.appInfo.sanitizedProductName });
    const once = readFileSync(plist);
    await fix(context);
    assert.deepEqual(readFileSync(plist), once);
  });
}

macTest('실행 파일 이름이 달라도 Helper의 제품 이름으로 맞춘다', async () => {
  const { plist, context } = fixture('AI 비서', 'assistant-launcher');
  await fix(context);
  const name = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trimEnd();
  assert.equal(name, 'AI 비서'.normalize('NFD'));
});

macTest('Helper가 없으면 앱 정보를 바꾸지 않고 빌드를 실패시킨다', async () => {
  const { plist, context } = fixture('AI 비서');
  context.packager.appInfo.sanitizedProductName = '없는 보조 프로그램';
  const before = readFileSync(plist);
  await assert.rejects(fix(context), { code: 'ENOENT' });
  assert.deepEqual(readFileSync(plist), before);
});

test('윈도우·리눅스 빌드는 맥 파일이나 명령에 접근하지 않는다', async () => {
  await fix({ electronPlatformName: 'win32' });
  await fix({ electronPlatformName: 'linux' });
});
