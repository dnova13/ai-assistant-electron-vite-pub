// 실행: npm run build 후 node test/mascot-bubble.electron.cjs. 실제 마스코트 화면과 임시 SVG만 사용한다.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..'), base = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-bubble-qa-'));
fs.cpSync(path.join(project, 'assets'), path.join(base, 'assets'), { recursive: true });
const fixtures = [
  { id: 'wide', w: 600, h: 180, y: 0, x: 0, cw: 600, ch: 180, color: '#65a8dc' },
  { id: 'square', w: 600, h: 600, y: 0, x: 0, cw: 600, ch: 600, color: '#81c6a4' },
  { id: 'tall', w: 300, h: 800, y: 0, x: 0, cw: 300, ch: 800, color: '#d8a579' },
  { id: 'padded', w: 400, h: 800, y: 240, x: 160, cw: 200, ch: 520, color: '#be9bdf' },
  { id: 'tiny', w: 20, h: 20, y: 0, x: 0, cw: 20, ch: 20, color: '#e4bb68' }
];
for (const f of fixtures) {
  const folder = path.join(base, 'my-characters', f.id); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ name: f.id, type: 'image', image: 'character.svg', persona: '' }));
  fs.writeFileSync(path.join(folder, 'character.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}"><rect x="${f.x}" y="${f.y}" width="${f.cw}" height="${f.ch}" fill="${f.color}"/><circle cx="${f.x + f.cw * .35}" cy="${f.y + f.ch * .3}" r="${f.cw * .05}" fill="#24304b"/><circle cx="${f.x + f.cw * .65}" cy="${f.y + f.ch * .3}" r="${f.cw * .05}" fill="#24304b"/></svg>`);
}
fs.mkdirSync(path.join(base, 'profile'));
fs.writeFileSync(path.join(base, 'profile/settings.json'), JSON.stringify({ character: 'wide', mascot: { enabled: true }, voice: { tts: false } }));
fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'mascot-bubble-qa', version: '0.0.0', main: 'bootstrap.cjs' }));

async function run(project, fixtures) {
  const { app, BrowserWindow, session } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  app.setName('Mascot Bubble QA'); app.setPath('userData', path.join(__dirname, 'profile')); app.disableHardwareAcceleration();
  globalThis.fetch = async () => { throw Error('외부 HTTP 차단'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true })));
  require(path.join(project, 'out/main/index.js'));
  async function wait(fn) {
    for (let i = 0; i < 200; i++) {
      try { const value = await fn(); if (value) return value; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('시험 대기 시간 초과');
  }
  try {
    const chat = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/index.html')));
    const mascot = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/mascot.html')));
    const js = (code, win = mascot) => win.webContents.executeJavaScript('(async()=>{return ' + code + '})()');
    await wait(() => js("document.getElementById('characterImg')?.complete && document.getElementById('characterImg')?.naturalWidth>0"));
    let current = fixtures[0];
    const send = async (text, final = false) => {
      await js(`window.app.mascot.relay(${JSON.stringify({ type: 'bubble', text, final })})`, chat);
      await wait(() => js(`document.getElementById('bubbleText').textContent===${JSON.stringify(text)}`));
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    };
    const metrics = () => js(`(()=>{
      const image=document.getElementById('characterImg').getBoundingClientRect(), b=document.getElementById('bubble').getBoundingClientRect(), t=document.getElementById('bubbleText');
      const top=image.top+image.height*${current.y / current.h}, center=image.left+image.width*${(current.x + current.cw / 2) / current.w};
      return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,gap:top-b.bottom-7,center,tip:b.left+parseFloat(getComputedStyle(document.getElementById('bubble')).getPropertyValue('--bubble-tip-left')),height:innerHeight,width:innerWidth,scroll:t.scrollTop,client:t.clientHeight,total:t.scrollHeight,textWidth:t.scrollWidth,clientWidth:t.clientWidth};
    })()`);
    const check = async label => {
      const m = await metrics();
      assert.ok(m.top >= 5.5 && m.bottom + 7 <= m.height, label + ': 창 안 표시');
      assert.ok(m.left >= 9 && m.right <= m.width - 9, label + ': 좌우 표시');
      assert.ok(Math.abs(m.gap - 8) < 2, label + ': 캐릭터 간격 ' + m.gap);
      assert.ok(Math.abs(m.tip - m.center) < 2, label + ': 꼬리 중심');
      assert.ok(m.textWidth <= m.clientWidth + 1, label + ': 가로 넘침 없음');
      return m;
    };
    const long = Array.from({ length: 120 }, (_, i) => `${i + 1}. 긴 답변을 읽는 시험입니다. 한글과 English, 숫자 123을 함께 표시합니다.`).join('\n');
    for (const f of fixtures) {
      current = f;
      const loaded = await js('window.app.settings.load()', chat);
      await js(`window.app.settings.save({...${JSON.stringify(loaded.settings)},character:${JSON.stringify(f.id)}})`, chat);
      await wait(() => js(`document.getElementById('characterImg').currentSrc.includes('/${f.id}/') && document.getElementById('characterImg').complete`));
      await send('듣고 있어요…'); await check(f.id + ' 짧은 글');
      await send('답변하는 중이에요. 끝나면 다시 눌러 주세요.'); await check(f.id + ' 두 줄');
      await send(long); const m = await check(f.id + ' 긴 글');
      assert.ok(m.total > m.client, '긴 글 스크롤');
      assert.ok(m.total - m.client - m.scroll <= 6, '마지막 줄 따라가기');
      assert.equal(await js(`document.getElementById('bubbleText').textContent===${JSON.stringify(long)}`), true);
      fs.writeFileSync(path.join(__dirname, f.id + '-long.png'), (await mascot.webContents.capturePage()).toPNG());
      await send('https://unit.invalid/' + 'LongWord'.repeat(600)); await check(f.id + ' 공백 없는 긴 글');
    }
    current = fixtures.find(f => f.id === 'tall');
    const loaded = await js('window.app.settings.load()', chat);
    await js(`window.app.settings.save({...${JSON.stringify(loaded.settings)},character:'tall'})`, chat);
    await wait(() => js("document.getElementById('characterImg').currentSrc.includes('/tall/') && document.getElementById('characterImg').complete"));
    let streamed = '';
    for (let i = 0; i < 20; i++) {
      streamed += `진행 ${i}: 스트리밍 답변이 늘어납니다.\n`;
      await send(streamed); await check('스트리밍 ' + i);
    }
    await js("(()=>{const t=document.getElementById('bubbleText');t.scrollTop=30;t.dispatchEvent(new Event('scroll',{bubbles:true}));})()");
    const before = (await metrics()).scroll;
    streamed += '추가된 마지막 문장\n'.repeat(30);
    await send(streamed);
    assert.ok(Math.abs((await metrics()).scroll - before) < 2, '위로 읽는 중 위치 유지');
    await js("(()=>{const t=document.getElementById('bubbleText');t.scrollTop=t.scrollHeight;t.dispatchEvent(new Event('scroll',{bubbles:true}));})()");
    streamed += '다시 따라갈 문장\n'.repeat(10); await send(streamed);
    const end = await metrics(); assert.ok(end.total - end.client - end.scroll <= 6, '아래로 돌아오면 다시 따라가기');
    await send('새 답변'); await check('새 짧은 답');
    assert.equal((await metrics()).scroll, 0);
    await js("window.app.mascot.relay({type:'mouth',v:1})", chat);
    await new Promise(resolve => setTimeout(resolve, 90)); await check('입 모양 들썩임');
    mascot.setSize(320, 340); await send(long); await check('창 폭 변경');
    mascot.setSize(240, 340); await send('마지막 짧은 답'); await check('창 폭 복원');
    fs.writeFileSync(path.join(__dirname, 'tall-short.png'), (await mascot.webContents.capturePage()).toPNG());
    console.log('마스코트 말풍선 Electron QA 통과: 가로/정사각/세로/투명 여백/작은 이미지, 짧은 글/두 줄/120줄/긴 단어, 20회 스트리밍, 스크롤 유지·복원, 새 답변, 들썩임·창 폭 변경. 결과: ' + __dirname);
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
}
fs.writeFileSync(path.join(base, 'bootstrap.cjs'), `(${run.toString()})(${JSON.stringify(project)},${JSON.stringify(fixtures)});`);
const env = { ...process.env, ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [base], { env, encoding: 'utf8', timeout: 60000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) { process.stderr.write(result.stderr || result.error?.message || 'Electron QA 실패'); process.exitCode = 1; }
