// 실행: npm run build 후 node test/settings-window.electron.cjs. 개인 데이터와 외부 연결을 사용하지 않는다.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-window-qa-'));
for (const name of ['characters/sample', 'assets']) fs.cpSync(path.join(project, name), path.join(base, name), { recursive: true });
fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'settings-window-qa', version: '0.0.0', main: 'bootstrap.cjs' }));

async function run(project) {
  const { app, BrowserWindow, session } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  app.setName('Settings Window QA');
  app.setPath('userData', path.join(__dirname, 'profile'));
  app.disableHardwareAcceleration();
  globalThis.fetch = async () => { throw Error('외부 HTTP 차단'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true })));
  require(path.join(project, 'out/main/index.js'));
  async function wait(fn) {
    for (let i = 0; i < 160; i++) {
      try { const result = await fn(); if (result) return result; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('시험 대기 시간 초과');
  }
  try {
    const chat = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/index.html')));
    const js = (code, win = chat) => win.webContents.executeJavaScript('(async()=>{return ' + code + '})()');
    await wait(() => chat.isVisible());
    await wait(() => js("!!document.getElementById('input')"));
    await js("window.app.settingsWindow.open('character')");
    const settings = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/settings.html')));
    await wait(() => settings.isVisible());
    await wait(() => js("!!document.getElementById('charEditName')", settings));
    assert.equal(settings.getParentWindow(), null);
    assert.equal(settings.isModal(), false);
    // 네이티브 제목줄이 있으면 콘텐츠 높이가 외곽 창 높이보다 작다.
    assert.deepEqual(settings.getContentBounds(), settings.getBounds());
    assert.equal(await js("document.querySelectorAll('.modalHead h2').length", settings), 1);
    assert.equal(await js("getComputedStyle(document.querySelector('.modalHead')).getPropertyValue('-webkit-app-region')", settings), 'drag');
    assert.equal(await js("getComputedStyle(document.getElementById('btnCloseSettings')).getPropertyValue('-webkit-app-region')", settings), 'no-drag');

    const chatBounds = chat.getBounds();
    settings.setPosition(chatBounds.x + 100, chatBounds.y + 30);
    assert.ok(settings.getBounds().x + settings.getBounds().width > chatBounds.x + chatBounds.width);
    await js("(()=>{const input=document.getElementById('charEditName');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'작성 중 보존');input.dispatchEvent(new Event('input',{bubbles:true}));})()", settings);
    await wait(() => js("document.getElementById('charEditName').value==='작성 중 보존'", settings));
    chat.close();
    await wait(() => !chat.isVisible() && !settings.isVisible());
    assert.equal(chat.isDestroyed(), false);
    assert.equal(settings.isDestroyed(), false);
    chat.show();
    chat.focus();
    await js("window.app.settingsWindow.open('character')");
    await wait(() => settings.isVisible());
    assert.equal(BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('/settings.html')).length, 1);
    assert.equal(await js("document.getElementById('charEditName').value", settings), '작성 중 보존');
    await js("document.getElementById('btnCharEditSave').click()", settings);
    await wait(() => js("(await window.app.characters.list()).find(c=>c.id==='sample').config.name==='작성 중 보존'"));
    fs.writeFileSync(path.join(__dirname, 'settings.png'), (await settings.webContents.capturePage()).toPNG());

    // 실제 마우스 입력으로 내부 닫기 버튼을 눌러 드래그 영역에서 제외되었는지 확인한다.
    const point = await js("(()=>{const b=document.getElementById('btnCloseSettings').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()", settings);
    settings.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    settings.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait(() => settings.isDestroyed());
    assert.equal(chat.isVisible(), true);
    await js("window.app.settingsWindow.open('character')");
    const reopened = await wait(() => BrowserWindow.getAllWindows().find(w => w !== settings && w.webContents.getURL().includes('/settings.html')));
    await wait(() => reopened.isVisible());
    chat.destroy();
    await wait(() => reopened.isDestroyed());
    console.log('설정창 Electron QA 통과: 기본 제목줄 제거·독립 이동·제목 드래그 영역·내부 닫기 클릭·동시 숨김·편집값 보존·저장·중복 방지·대화창 파괴 시 정리. 결과: ' + __dirname);
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
}

fs.writeFileSync(path.join(base, 'bootstrap.cjs'), `(${run.toString()})(${JSON.stringify(project)});`);
const env = { ...process.env, ELECTRON_RENDERER_URL: '' };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [base], { env, encoding: 'utf8', timeout: 45000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) { process.stderr.write(result.stderr || result.error?.message || 'Electron QA 실패'); process.exitCode = 1; }
