// 실행: npm run dist:mac 후 node test/packaged-mac.electron.cjs [앱 경로]. 실제 설정 대신 임시 프로필을 쓴다.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

async function main() {
  assert.equal(process.platform, 'darwin', '맥에서 실행해 주세요.');
  const project = path.resolve(__dirname, '..');
  const appPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(project, 'dist/mac-arm64', fs.readdirSync(path.join(project, 'dist/mac-arm64')).find(name => name.endsWith('.app')));
  const output = path.join(project, '.test-tmp');
  fs.mkdirSync(output, { recursive: true });
  const base = fs.mkdtempSync(path.join(output, 'packaged-mac-'));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile);
  const executable = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trimEnd();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawn(path.join(appPath, 'Contents/MacOS', executable), ['--user-data-dir=' + profile, '--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', exited = false;
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  child.on('exit', () => { exited = true; });
  const connections = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(fn) {
    let last;
    for (let i = 0; i < 160; i++) {
      if (exited) throw Error('설치본이 종료됐습니다.\n' + logs);
      try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
      await pause(100);
    }
    throw Error('설치본 화면 대기 시간 초과: ' + (last?.message || '') + '\n' + logs);
  }
  async function connect(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    connections.push(socket);
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('검사 응답 시간 초과: ' + method)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    return {
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      },
      async capture(name) {
        const result = await send('Page.captureScreenshot');
        fs.writeFileSync(path.join(base, name + '.png'), Buffer.from(result.data, 'base64'));
      }
    };
  }
  try {
    const port = await wait(() => {
      const value = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      return /^\d+$/.test(value) && value;
    });
    const target = suffix => wait(async () => {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      const pages = await response.json();
      return pages.find(page => page.type === 'page' && page.url === 'app://local/renderer/' + suffix);
    });
    const chat = await connect(await target('index.html'));
    await wait(() => chat.evaluate("!!document.getElementById('btnSettings') && !!document.getElementById('chat')"));
    const count = await chat.evaluate('window.app.characters.list().then(list=>list.length)');
    assert.ok(count > 0, '설치본 기본 캐릭터 읽기');
    await chat.capture('chat');
    await chat.evaluate("window.app.settingsWindow.open('general')");
    const settings = await connect(await target('settings.html'));
    await wait(() => settings.evaluate('document.body.innerText.trim().length > 20'));
    await settings.capture('settings');
    await chat.evaluate('(async()=>{const {settings}=await window.app.settings.load();return window.app.settings.save({...settings,mascot:{...settings.mascot,enabled:true}});})()');
    const mascot = await connect(await target('mascot.html'));
    await wait(() => mascot.evaluate("document.getElementById('characterImg')?.naturalWidth > 0"));
    assert.equal(await mascot.evaluate("getComputedStyle(document.getElementById('characterImg')).borderRadius"), '4px');
    await mascot.capture('mascot');
    assert.equal(exited, false, '설치본 실행 유지');
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ appPath, chat: true, settings: true, mascot: true, mascotRadius: '4px', characterCount: count }, null, 2));
    console.log('맥 설치본 QA 통과: 대화 창·기본 캐릭터·IPC·독립 설정 창·마스코트·4px 모서리. 결과: ' + base);
  } finally {
    connections.forEach(socket => socket.close());
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
      if (!exited) child.kill('SIGKILL');
    }
    fs.writeFileSync(path.join(base, 'process.log'), logs);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
