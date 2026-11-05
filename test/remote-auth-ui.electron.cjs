// 실행: npm run build 후 node test/remote-auth-ui.electron.cjs. 실제 앱/IPC와 가짜 Discord Client로 검사한다.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..'), temp = path.join(project, '.test-tmp');
fs.mkdirSync(temp, { recursive: true });
const base = fs.mkdtempSync(path.join(temp, 'remote-auth-ui-'));
for (const name of ['characters/sample', 'assets']) fs.cpSync(path.join(project, name), path.join(base, name), { recursive: true });
const docs = path.join(base, 'qa-docs'); fs.mkdirSync(docs); fs.writeFileSync(path.join(docs, '메모.txt'), 'QA');
const privateDir = path.join(base, 'qa-private'); fs.mkdirSync(privateDir);
fs.mkdirSync(path.join(base, 'profile'));
fs.writeFileSync(path.join(base, 'profile/settings.json'), JSON.stringify({ tools: { allowedRoots: [{ id: 'qa', label: '시험', path: docs, remote: true }, { id: 'private', label: '개인', path: privateDir, remote: false }] }, files: { receivedDir: path.join(base, 'received') }, profiles: { qa: { name: '시험 AI', type: 'assistant', baseUrl: 'https://unit.invalid/v1', apiKey: '' } }, activeProfile: 'qa', characterAi: { sample: 'qa' }, voice: { tts: false } }));
const other = path.join(base, 'my-characters/other'); fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({ name: '다른 캐릭터', type: 'image', image: 'character.svg' }));
fs.copyFileSync(path.join(project, 'characters/sample/character.svg'), path.join(other, 'character.svg'));
const serverChar = path.join(base, 'my-characters/server-char'); fs.mkdirSync(serverChar, { recursive: true });
fs.writeFileSync(path.join(serverChar, 'config.json'), JSON.stringify({ name: '서버 캐릭터', type: 'image', image: 'character.svg' }));
fs.copyFileSync(path.join(project, 'characters/sample/character.svg'), path.join(serverChar, 'character.svg'));
fs.mkdirSync(path.join(base, 'profile/history'));
for (const id of ['sample', 'other']) fs.writeFileSync(path.join(base, 'profile/history', id + '.json'), JSON.stringify({ character: id, messages: [{ role: 'user', text: id + ' 기존 대화' }, { role: 'bot', text: id + ' 기존 답변' }] }));
fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'remote-auth-qa', version: '0.0.0', main: 'bootstrap.cjs' }));

async function run(project) {
  const { app, BrowserWindow, session, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const Module = require('node:module'), { EventEmitter } = require('node:events'), crypto = require('node:crypto');
  const messages = [], clients = [], answers = [], replies = [], reports = [];
  let nextAction = null, apiChats = 0, registerCalls = 0, offline = false, deleteCalls = 0;
  const registrations = [], sockets = [], socketMessages = [], directRequests = [], serverRequests = [];
  const computers = new Map();
  const realLoad = Module._load;
  const discord = realLoad.call(Module, 'discord.js', module);
  const dm = { type: discord.ChannelType.DM, send: async body => {
    messages.push(body);
    return { edit: async () => {}, awaitMessageComponent: async () => {
      const answer = answers.shift();
      if (answer === 'timeout') throw Error('시험 시간 초과');
      if (answer === 'text') return new Promise(() => {});
      const buttons = body.components.flatMap(row => row.components).map(button => button.toJSON());
      const chosen = buttons.find(button => button.custom_id.endsWith(':' + answer));
      if (!chosen) throw Error('시험 응답이 없습니다');
      return { user: { id: '42' }, customId: chosen.custom_id, update: async () => {} };
    } };
  } };
  class FakeClient extends EventEmitter {
    users = { fetch: async () => ({ createDM: async () => dm }) };
    constructor() { super(); clients.push(this); }
    async login() { setImmediate(() => this.emit(discord.Events.ClientReady, { user: { tag: '시험봇' } })); }
    async destroy() {}
  }
  Module._load = function(id, ...args) { return id === 'discord.js' ? { ...discord, Client: FakeClient } : realLoad.call(this, id, ...args); };
  app.setName('Remote Auth QA');
  app.setPath('userData', path.join(__dirname, 'profile'));
  app.disableHardwareAcceleration();
  globalThis.WebSocket = class FakeSocket {
    constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.({})); }
    send(text) {
      const m = JSON.parse(text);
      if (m.type === 'hello') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'welcome' }) }));
      else if (m.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'pong' }) }));
      else socketMessages.push(m);
    }
    close() {}
  };
  globalThis.fetch = async (url, options = {}) => {
    const address = new URL(String(url));
    if (address.origin !== 'https://unit.invalid') throw Error('외부 HTTP 차단');
    if (offline) throw Error('시험 오프라인');
    if (address.pathname.endsWith('/computers')) {
      if (options.method === 'POST') {
        registerCalls++;
        await new Promise(r=>setTimeout(r,80));
        const data = JSON.parse(options.body); registrations.push(data);
        const { name, computer_id } = data;
        const old=computers.get(computer_id);
        if ([...computers.values()].some(c=>c.name===name&&c.id!==old?.id)) return Response.json({error:'이미 있는 이름입니다.'},{status:409});
        const id=old?.id||'pc_qa_'+registerCalls;const entry={id,name};computers.set(id,entry);return Response.json(entry,{status:201});
      }
      return Response.json({computers:[...computers.values()]});
    }
    if (address.pathname.includes('/computers/') && options.method === 'DELETE') {
      deleteCalls++; throw Error('앱 연결 해제는 서버 삭제를 요청하면 안 됩니다.');
    }
    if (address.pathname.endsWith('/health')) return Response.json({ api: '1', server: 'QA', features: { chat_stream: true, client_actions: ['file.copy', 'file.delete', 'file.search'] } });
    if (address.pathname.includes('/actions/')) { reports.push(JSON.parse(options.body)); return Response.json({}); }
    if (address.pathname.endsWith('/confirmation/interpret')) {
      const data = JSON.parse(options.body);
      return Response.json({ decision: data.answer === '그래 진행해' ? 'yes' : data.answer === '하지 마' ? 'no' : 'unknown' });
    }
    if (address.pathname.endsWith('/chat/completions')) {
      directRequests.push(JSON.parse(options.body));
      return new Response('data: '+JSON.stringify({choices:[{delta:{content:'직접 AI 응답'}}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
    }
    if (address.pathname.endsWith('/chat')) {
      apiChats++; serverRequests.push(JSON.parse(options.body));
      const action = nextAction; nextAction = null;
      const events = action ? [{ type: 'delta', text: 'QA 사전 안내: 복사할게요. 확인 창을 봐 주세요.' }, { type: 'client_action', id: 'qa-action', ...action }, { type: 'done', text: 'QA 사전 안내: 복사할게요. 확인 창을 봐 주세요.' }] : [{ type: 'done', text: '일반 대화 응답입니다.' }];
      return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    throw Error('시험에서 지원하지 않는 API 경로');
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true })));
  require(path.join(project, 'out/main/index.js'));
  ipcMain.on('remote:reply', (_event, _id, text) => replies.push(text));
  async function wait(fn) {
    for (let i = 0; i < 200; i++) {
      try { const result = await fn(); if (result) return result; } catch {}
      await new Promise(r => setTimeout(r, 30));
    }
    throw Error('시험 대기 시간 초과');
  }
  function code(secret) {
    let bits = '', bytes = [];
    for (const c of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const hash = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = hash[19] & 15;
    return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
  }
  async function message(text, files = []) {
    const before = messages.length;
    clients.at(-1).emit(discord.Events.MessageCreate, { id: String(Date.now()), author: { bot: false, id: '42' }, channel: dm, content: text, attachments: new Map(files.map(f => [f.id, f])) });
    await wait(() => messages.length > before);
    return messages.slice(before).join('\n');
  }
  try {
    const chat = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/index.html')));
    const js = (code, w = chat) => w.webContents.executeJavaScript('(async()=>{return ' + code + '})()').catch(error => { throw Error(code.slice(0, 140) + ' → ' + error.message); });
    await wait(() => js("!!document.getElementById('input')"));
    const local = async text => {
      await js(`(()=>{const el=document.getElementById('input');Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await js("document.getElementById('btnSend').click()");
    };
    await wait(() => js("document.getElementById('messages').textContent.includes('sample 기존 대화')"));
    await local('/clear');
    await wait(() => js("(await window.app.history.load('sample')).length===0 && !document.getElementById('messages').textContent.includes('sample 기존 대화')"));
    assert.equal((await js("window.app.history.load('other')")).length, 2);
    const archived = path.join(__dirname, 'profile/history/_to_delete');
    assert.equal(fs.readdirSync(archived).filter(name => name.startsWith('sample-')).length, 1);
    assert.equal(apiChats, 0);
    for (const [i, command] of ['파일 목록', '!파일 목록'].entries()) {
      await local(command);
      await wait(() => js(`document.querySelectorAll('.results').length===${i + 1}`));
      const paths = await js("[...document.querySelectorAll('.results')].at(-1) && [...[...document.querySelectorAll('.results')].at(-1).querySelectorAll('.result > span')].map(el=>el.title)");
      assert.deepEqual(paths.sort(), [path.join(__dirname, 'qa-docs'), path.join(__dirname, 'qa-private'), path.join(__dirname, 'received')].sort());
    }
    await local('파일 목록 시험');
    await wait(() => js("[...document.querySelectorAll('.results')].at(-1)?.textContent.includes('메모.txt')"));
    await local('파일 도움말');
    await wait(() => js("[...document.querySelectorAll('.msg')].at(-1)?.textContent.startsWith('- 파일 명령')"));
    const help = await js("[...document.querySelectorAll('.msg')].at(-1).textContent");
    assert.ok(help.includes('\n\n- 안내\n\n'));
    assert.ok(help.includes('\n\n- 대화 기록\n\n'));
    assert.ok(help.includes('/clear'));
    assert.equal(apiChats, 0);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await js("(()=>{const box=document.getElementById('messages'),last=[...document.querySelectorAll('.msg')].at(-1);box.scrollTop+=last.getBoundingClientRect().top-box.getBoundingClientRect().top;})()");
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(__dirname, 'help-top.png'), (await chat.webContents.capturePage()).toPNG());
    await js("document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(__dirname, 'help-bottom.png'), (await chat.webContents.capturePage()).toPNG());
    const key = await js('window.app.remote.newKey()');
    await js('window.app.settingsWindow.open()');
    const settings = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/settings.html')));
    await wait(() => js("!!document.querySelector('[data-tab=remote]')", settings));
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`, settings);
    await click('[data-tab=remote]');
    await wait(() => js("!!document.getElementById('remote-tab-direct')", settings));
    assert.deepEqual(await js("[...document.querySelectorAll('.remoteTabs button')].map(el=>el.textContent)", settings), ['비서 서버 연결', '앱 직접 연결', '인증·잠금', '보낸 파일']);
    assert.equal(await js("document.getElementById('remote-tab-server').getAttribute('aria-selected')", settings), 'true');
    for (const sub of ['direct', 'server', 'auth', 'sent']) {
      await click('#remote-tab-' + sub);
      assert.equal(await js(`!document.getElementById('remote-panel-${sub}').hidden`, settings), true);
      assert.equal(await js("document.querySelectorAll('.remotePanel:not([hidden])').length", settings), 1);
      if (sub === 'auth') {
        assert.equal(await js("document.querySelector('#totpBox b').textContent", settings), '인증 앱 (Microsoft Authenticator, Google Authenticator) 등록');
        assert.equal(await js("document.getElementById('accessBox').textContent.includes('지금 잠그기')", settings), true);
      }
      fs.writeFileSync(path.join(__dirname, sub + '.png'), (await settings.webContents.capturePage()).toPNG());
    }
    await click('#remote-tab-direct');
    const setInput = (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`, settings);
    await click('#remoteEnabled');
    await setInput('#discordToken', 'qa-only'); await setInput('#discordUserId', '42');
    await click('#btnRemoteReconnect');
    await wait(() => js("(await window.app.remote.status()).connected"));
    await wait(() => messages.some(text => typeof text === 'string' && text.startsWith('먼저 인증해 주세요')));
    assert.match(await message('안녕'), /^먼저 인증해 주세요/);
    assert.match(await message('파일 찾기 메모'), /^먼저 인증해 주세요/);
    assert.match(await message('파일 목록'), /^먼저 인증해 주세요/);
    assert.match(await message('', [{ id: 'f', name: 'a.txt', size: 1, url: 'https://cdn.discordapp.com/qa' }]), /^먼저 인증해 주세요/);
    assert.equal(await js("document.querySelectorAll('.received').length"), 0);
    assert.match(await message('인증'), /^인증 방법/);
    assert.match(await message('인증 ' + code(key.secret)), /인증했습니다/);
    assert.match(await message('파일 찾기 메모'), /찾기 결과 1개/);
    for (const command of ['파일 목록', '!파일 목록']) {
      const listed = await message(command);
      assert.match(listed, /허용 폴더 목록 1개/);
      assert.ok(listed.includes(path.join(__dirname, 'qa-docs')));
      assert.equal(listed.includes('qa-private'), false);
      assert.equal(listed.includes('메모.txt'), false);
    }
    const helpStart = messages.length;
    await message('도움말');
    await wait(() => messages.slice(helpStart).join('\n').includes('비서 서버 DM은 파일 이름 찾기를 제외한'));
    const remoteHelp = messages.slice(helpStart).join('\n');
    assert.ok(remoteHelp.startsWith('- 파일 명령'));
    assert.ok(remoteHelp.includes('\n\n- 인증·잠금\n\n'));
    assert.ok(remoteHelp.includes('\n\n- 안내\n\n'));

    await wait(() => js("document.getElementById('directAuthState').textContent.includes('인증됨')", settings));
    // 실제 자연어 → API 스트림 → 화면 → 원격 허브 → Discord 결과 → IPC 답까지 검사한다.
    const qaDocs = path.join(__dirname, 'qa-docs');
    async function natural(action, args, responses = []) {
      const before = messages.length, replyCount = replies.length;
      nextAction = { action, args }; answers.push(...responses);
      await message('파일 메모를 시험에 처리해줘');
      await wait(() => replies.length > replyCount);
      assert.equal(replies.at(-1), undefined);
      const sent = messages.slice(before);
      assert.equal(sent.some(body => typeof body === 'string' && /QA 사전 안내|답이 없습니다/.test(body)), false);
      return sent;
    }
    // 실제 메인/전용 API/가짜 Discord 메시지를 통한 자유 답변과 즉시 답변.
    for (const word of ['어', 'yes', '그래 진행해', '하지 마']) {
      const before = messages.length;
      answers.push('text');
      await message('파일 복사 메모.txt');
      await wait(() => messages.slice(before).some(body => body.components));
      const reply = await message(word);
      assert.match(reply, word === '하지 마' ? /취소했습니다/ : /복사했습니다/);
    }
    const originalFiles = fs.readdirSync(qaDocs);
    const canceled = await natural('file.copy', { target: '메모.txt', dest: '시험' }, ['no']);
    assert.ok(canceled.includes('취소했습니다.'));
    assert.deepEqual(fs.readdirSync(qaDocs), originalFiles);
    const copyButtons = canceled.find(body => body.components).components[0].components.map(button => button.toJSON());
    assert.deepEqual(copyButtons.map(button => button.label), ['예', '아니오']);
    assert.equal(copyButtons[0].style, discord.ButtonStyle.Primary);
    const copied = await natural('file.copy', { target: '메모.txt', dest: '시험' }, ['yes']);
    assert.ok(copied.some(body => typeof body === 'string' && /복사했습니다/.test(body)));
    const afterCopy = fs.readdirSync(qaDocs);
    assert.equal(afterCopy.length, originalFiles.length + 1);
    const expired = await natural('file.copy', { target: '메모.txt', dest: '시험' }, ['timeout']);
    assert.ok(expired.includes('시간이 지나 취소했습니다.'));
    assert.deepEqual(fs.readdirSync(qaDocs), afterCopy);
    const failed = await natural('file.copy', { target: '없는파일.txt', dest: '시험' });
    assert.ok(failed.some(body => typeof body === 'string' && /찾지 못했습니다/.test(body)));
    assert.equal(reports.at(-1).status, 'failed');
    const found = await natural('file.search', { query: '메모' });
    assert.ok(found.some(body => typeof body === 'string' && /찾기 결과/.test(body)));
    const deleteCanceled = await natural('file.delete', { target: '메모.txt' }, ['yes', 'no']);
    assert.equal(deleteCanceled.filter(body => body.components).length, 2);
    assert.ok(deleteCanceled.includes('취소했습니다.'));
    assert.equal(fs.existsSync(path.join(qaDocs, '메모.txt')), true);
    for (const dialog of deleteCanceled.filter(body => body.components)) {
      const buttons = dialog.components[0].components.map(button => button.toJSON());
      assert.deepEqual(buttons.map(button => button.label), ['아니오', '예']);
      assert.equal(buttons[1].style, discord.ButtonStyle.Danger);
    }
    await natural('file.delete', { target: '메모.txt' }, ['yes', 'yes']);
    assert.equal(fs.existsSync(path.join(qaDocs, '메모.txt')), false);
    assert.equal(fs.existsSync(path.join(qaDocs, '_to_delete')), true);
    assert.match(await message('일반 대화 시험'), /일반 대화 응답입니다/);
    assert.equal(replies.at(-1), '일반 대화 응답입니다.');
    // 인증과 무관한 설정 저장은 연결을 다시 만들거나 인증을 끝내지 않는다.
    const current = await js('window.app.settings.load()'), beforeClients = clients.length;
    current.settings.remote.sentDeleteDays = 7;
    await js(`window.app.settings.save(${JSON.stringify(current.settings)})`);
    assert.equal(clients.length, beforeClients);
    assert.ok((await js('window.app.remote.status()')).unlockedUntil > Date.now());
    await click('#remoteEnabled'); await click('#btnSaveSettings');
    await wait(async () => !(await js('window.app.remote.status()')).connected);
    assert.equal((await js('window.app.remote.status()')).unlockedUntil, 0);
    await wait(() => js("!document.getElementById('btnSaveSettings').disabled && !document.getElementById('remoteEnabled').checked", settings));
    await click('#remoteEnabled');
    await wait(() => js("document.getElementById('remoteEnabled').checked && !document.getElementById('btnRemoteReconnect').disabled", settings));
    await click('#btnRemoteReconnect');
    await wait(() => js("(await window.app.remote.status()).connected"));
    assert.match(await message('파일 찾기 메모'), /^먼저 인증해 주세요/);
    // 새 인증 키로 재등록해 기다리는 시간 없이 재인증·폐기를 검사한다.
    const nextKey = await js('window.app.remote.newKey()');
    assert.match(await message('인증 ' + code(nextKey.secret)), /인증했습니다/);
    await click('#remote-tab-auth'); await click('#btnRemoteLock');
    await wait(async () => !(await js('window.app.remote.status()')).unlockedUntil);
    const thirdKey = await js('window.app.remote.newKey()');
    await message('인증 ' + code(thirdKey.secret));
    assert.match(await message('인증 폐기'), /현재 인증을 종료/);
    assert.equal((await js('window.app.remote.status()')).keySet, true);
    assert.equal((await js('window.app.remote.status()')).recoveryLeft, 8);
    await click('#remote-tab-direct');
    await wait(() => js("document.getElementById('directAuthState').textContent.includes('인증 필요')", settings));
    settings.setSize(460, 700);
    assert.equal(await js("(()=>{const b=document.querySelector('.remoteTabs').getBoundingClientRect();return [...document.querySelectorAll('.remoteTabs button')].every(el=>{const r=el.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right+1&&el.scrollWidth<=el.clientWidth})})()", settings), true);
    fs.writeFileSync(path.join(__dirname, 'direct.png'), (await settings.webContents.capturePage()).toPNG());
    settings.close();
    fs.writeFileSync(path.join(qaDocs, '입력시험.txt'), 'QA');
    const copyCount=()=>fs.readdirSync(qaDocs).filter(n=>n.startsWith('입력시험')).length;
    const typeLocalAnswer=async(word)=>{
      await js(`(()=>{const el=document.querySelector('input[aria-label="확인 답변"]');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(word)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await js("document.querySelector('#actionModal form').requestSubmit()");
    };
    for(const word of ['어','그래 진행해','아마도']){
      const n=copyCount();await local('파일 복사 시험 입력시험.txt');
      await wait(()=>js("!document.getElementById('actionModal').classList.contains('hidden')"));
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      if(word==='아마도')fs.writeFileSync(path.join(__dirname,'confirmation.png'),(await chat.webContents.capturePage()).toPNG());
      await typeLocalAnswer(word);
      if(word==='아마도'){
        await wait(()=>js("document.getElementById('actionModal').textContent.includes('다시 답해')"));
        assert.equal(copyCount(),n);await typeLocalAnswer('아니오');
      }
      await wait(()=>js("document.getElementById('actionModal').classList.contains('hidden')"));
      await wait(()=>copyCount()===n+(word==='아마도'?0:1));
    }
    // 등록/해제는 실제 설정창·메인 IPC·메모리 서버까지 검사한다.
    await js('window.app.settingsWindow.open()');
    const registrationWindow=await wait(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/settings.html')));
    await wait(()=>js("!!document.querySelector('[data-tab=remote]')",registrationWindow));
    await js("document.querySelector('[data-tab=remote]').click()",registrationWindow);
    await js("document.getElementById('remote-tab-server').click()",registrationWindow);
    const serverJs=code=>js(code,registrationWindow);
    const inputName=async(name)=>{
      await wait(()=>serverJs("!!document.getElementById('serverComputerInput')"));
      await serverJs(`(()=>{const el=document.getElementById('serverComputerInput');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(name)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const register=async(name='시험컴퓨터')=>{
      await inputName(name);const n=registerCalls;
      await serverJs("(()=>{const b=document.getElementById('btnServerRegister');b.click();b.click();})()");
      await wait(()=>serverJs("document.getElementById('btnServerUnregister')&&!document.getElementById('btnServerUnregister').disabled"));
      assert.equal(registerCalls,n+1);
    };
    const unregister=async()=>{
      await serverJs("document.getElementById('btnServerUnregister').click()");
      await serverJs("document.getElementById('btnServerUnregisterYes').click()");
      await wait(()=>serverJs("document.getElementById('serverComputerInput')?.value===''"));
    };
    const remembered=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'profile/remote-state.json'),'utf8')).server;
    await register();const first=registrations.at(-1);assert.equal(first.computer_id,undefined);
    const originalId=remembered().computerId;assert.equal(computers.size,1);
    offline=true;await unregister();offline=false;
    assert.equal(computers.size,1);assert.equal(remembered().computerId,originalId);assert.equal(remembered().attached,false);assert.equal(remembered().on,false);
    assert.equal((await js('window.app.remote.status()')).server.name,'');
    assert.equal((await js('window.app.settings.load()')).settings.remote.discord.userId,'42');
    await register();assert.equal(remembered().computerId,originalId);assert.equal(registrations.at(-1).computer_id,originalId);assert.equal(computers.size,1);
    await unregister();await register('작업용');assert.equal(remembered().computerId,originalId);assert.equal(computers.get(originalId).name,'작업용');assert.equal(computers.size,1);
    await unregister();computers.set('pc_other',{id:'pc_other',name:'중복이름'});
    await inputName('중복이름');const beforeConflict=registerCalls;
    await serverJs("document.getElementById('btnServerRegister').click()");
    await wait(()=>registerCalls===beforeConflict+1);await wait(()=>serverJs("!document.getElementById('btnServerRegister').disabled"));
    assert.equal((await js('window.app.remote.status()')).server.registered,false);assert.equal(remembered().computerId,originalId);assert.equal(computers.get(originalId).name,'작업용');
    computers.delete('pc_other');
    await register('작업용');
    const snapshot=(await js('window.app.settings.load()')).settings;
    await js('window.app.settings.save('+JSON.stringify({...snapshot,profiles:{}})+')');
    offline=true;await unregister();offline=false;
    assert.equal(remembered().computerId,originalId);assert.equal(computers.size,1);
    await js('window.app.settings.save('+JSON.stringify(snapshot)+')');
    await register('작업용');computers.clear(); // 디스코드에서 서버 등록을 삭제한 상황
    await unregister();await register('작업용');
    assert.notEqual(remembered().computerId,originalId);assert.equal(computers.size,1);
    await unregister();assert.equal(computers.size,1);assert.equal(deleteCalls,0);
    await serverJs('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(__dirname,'unregistered.png'),(await registrationWindow.webContents.capturePage()).toPNG());
    // 실제 메인/기록 저장소: 로컬·직접 연결의 요청/완료/실패/취소/검색 결과가 캐릭터 전환·재시작 뒤에도 남는다.
    const beforeReload = await js("window.app.history.load('sample')");
    assert.ok(beforeReload.some(m => m.role==='user' && m.text==='파일 목록' && !m.source));
    assert.ok(beforeReload.some(m => m.results?.length && m.memory===false));
    assert.ok(beforeReload.some(m => m.text.includes('복사했습니다') && m.source==='디스코드'));
    assert.ok(beforeReload.some(m => m.text.includes('취소했습니다') && m.source==='디스코드'));
    assert.ok(beforeReload.some(m => m.tone==='error' || m.role==='err'));
    assert.ok(beforeReload.every(m=>m.id && m.time));
    assert.equal(new Set(beforeReload.map(m=>m.id)).size,beforeReload.length);
    await js("document.querySelector('.barItem[data-id=other]').click()");
    await wait(()=>js("document.getElementById('messages').textContent.includes('other 기존 대화')"));
    await js("document.querySelector('.barItem[data-id=sample]').click()");
    await wait(()=>js("document.getElementById('messages').textContent.includes('복사했습니다')"));
    chat.webContents.reload();
    await wait(()=>js("!!document.getElementById('input') && document.getElementById('messages').textContent.includes('복사했습니다')"));
    assert.deepEqual(await js("window.app.history.load('sample')"),beforeReload);
    assert.ok(await js("[...document.querySelectorAll('.msgSource')].some(el=>el.textContent.includes('디스코드'))"));

    // 비서 서버 연결: 등록 프로필 ID·표시 순서로 배정하고 처리 중 선택 변경에도 결과 대상을 보존한다.
    await js("window.app.settings.save((()=>{const s="+JSON.stringify(snapshot)+";return {...s,character:'other',profiles:{...s.profiles,qa:{...s.profiles.qa,apiKey:'qa-only'},alt:{...s.profiles.qa,name:'다른 AI'}},characterAi:{sample:'qa','server-char':'qa',other:'alt'}};})())");
    chat.webContents.send('app:command',{cmd:'settingsChanged'});
    await js("window.app.characters.setOrder(['other','server-char','sample'])");
    await register('기록시험');
    await js('window.app.remote.serverAllow(true)');
    await wait(()=>js("(await window.app.remote.status()).server.state==='connected'"));
    let turn = 0;
    const startServer = (text, type='command', extra={}) => {
      const id = 'history-'+(++turn);
      sockets.at(-1).onmessage({data:JSON.stringify({type,id,text,...extra})});return id;
    };
    const serverReply = id => wait(()=>socketMessages.find(m=>m.type==='reply'&&m.id===id));
    const serverMessage = async (text,type='command',extra={})=>serverReply(startServer(text,type,extra));
    const serverKey=await js('window.app.remote.newKey()');
    assert.match((await serverMessage('인증 '+code(serverKey.secret))).text,/인증했습니다/);
    assert.match((await serverMessage('파일 목록')).text,/허용 폴더 목록/);
    await wait(()=>js("(await window.app.settings.load()).settings.character==='server-char'"));
    await wait(()=>js("document.getElementById('messages').textContent.includes('허용 폴더 목록')"));
    assert.equal((await js("window.app.history.load('other')")).length,2);
    assert.ok((await js("window.app.history.load('server-char')")).some(m=>m.source==='디스코드'&&m.text==='파일 목록'));
    await serverMessage('파일 생성 시험 서버기록.txt');
    assert.ok(fs.existsSync(path.join(qaDocs,'서버기록.txt')));
    const pending=await serverMessage('파일 복사 시험 서버기록.txt');
    assert.equal(pending.waiting,true);
    await js("document.querySelector('.barItem[data-id=sample]').click()");
    await wait(()=>js("(await window.app.settings.load()).settings.character==='sample'"));
    const sampleBefore=await js("window.app.history.load('sample')");
    assert.match((await serverMessage('어','answer',{promptId:pending.prompt.id})).text,/복사했습니다/);
    assert.deepEqual(await js("window.app.history.load('sample')"),sampleBefore);
    assert.ok((await js("window.app.history.load('server-char')")).some(m=>m.text.includes('서버기록 (1).txt')&&m.source==='디스코드'));
    // 현재 캐릭터가 같은 등록 프로필이면 순서가 뒤여도 유지하고 그쪽의 세션/기록을 사용한다.
    nextAction={action:'file.create',args:{dest:'시험',name:'현재캐릭터.txt'}};
    await serverMessage('파일 시험에서 현재캐릭터.txt 만들어줘');
    assert.ok(fs.existsSync(path.join(qaDocs,'현재캐릭터.txt')));
    assert.equal(serverRequests.at(-1).session,'sample');
    assert.equal(serverRequests.at(-1).client.character,'sample');
    assert.equal((await js('window.app.settings.load()')).settings.character,'sample');
    assert.ok((await js("window.app.history.load('sample')")).some(m=>m.text.includes('현재캐릭터.txt')&&m.source==='디스코드'));
    assert.equal((await js("window.app.history.load('server-char')")).some(m=>m.text.includes('현재캐릭터.txt')),false);
    const currentName=await js("(await window.app.characters.list()).find(c=>c.id==='sample').config.name");
    await wait(()=>serverJs(`document.getElementById('serverCharacterHint')?.textContent.includes(${JSON.stringify(currentName)})`));
    await js("document.querySelector('.barItem[data-id=other]').click()");
    await wait(()=>js("document.querySelector('.barItem[data-id=other]').getAttribute('aria-selected')==='true'"));
    // 다른 프로필 캐릭터에서는 첫 연결 캐릭터로 전환한다. 자연어도 동일 배정하고 결과를 보관한다.
    nextAction={action:'file.create',args:{dest:'시험',name:'서버자연어.txt'}};
    await serverMessage('파일 시험에서 서버자연어.txt 만들어줘');
    assert.ok(fs.existsSync(path.join(qaDocs,'서버자연어.txt')));
    assert.equal(serverRequests.at(-1).session,'server-char');
    assert.equal(serverRequests.at(-1).client.character,'server-char');
    await wait(()=>js("(await window.app.settings.load()).settings.character==='server-char'"));
    await js("window.app.characters.setHidden('server-char',true)");
    await serverMessage('파일 목록');
    await wait(()=>js("(await window.app.settings.load()).settings.character==='sample'"));
    await js("window.app.characters.setHidden('sample',true)");
    await serverJs("document.querySelector('[data-tab=remote]').click()");
    await serverJs("document.getElementById('remote-tab-server').click()");
    await wait(()=>serverJs("document.getElementById('serverCharacterWarning')?.textContent.includes('표시 캐릭터가 없습니다')"));
    const noTargetChats=apiChats;
    assert.match((await serverMessage('파일 생성 시험 실행금지.txt')).text,/표시 캐릭터가 없습니다/);
    assert.match((await serverMessage('파일 시험에서 실행금지.txt 만들어줘')).text,/설정 > 캐릭터/);
    assert.equal(apiChats,noTargetChats);assert.equal(fs.existsSync(path.join(qaDocs,'실행금지.txt')),false);
    assert.match((await serverMessage('인증')).text,/인증 방법/);
    await serverJs('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(__dirname,'missing-character.png'),(await registrationWindow.webContents.capturePage()).toPNG());
    await serverJs("document.querySelector('#serverCharacterWarning button').click()");
    await wait(()=>serverJs("document.querySelector('[data-tab=character]').classList.contains('active')"));
    await js("window.app.characters.setHidden('server-char',false)");
    await serverMessage('파일 목록');
    const restoredServer=await js("window.app.history.load('server-char')");
    await wait(()=>js("document.getElementById('messages').textContent.includes('서버자연어.txt')"));
    chat.webContents.reload();
    await wait(()=>js("!!document.getElementById('input') && document.getElementById('messages').textContent.includes('서버자연어.txt')"));
    assert.deepEqual(await js("window.app.history.load('server-char')"),restoredServer);
    assert.equal(new Set(restoredServer.map(m=>m.id)).size,restoredServer.length);
    // 저장된 파일·시스템 알림은 직접 AI의 대화 기억에 포함하지 않는다. 현재 사용자 발화 중복도 막는다.
    await js("window.app.settings.save({... (await window.app.settings.load()).settings,profiles:{direct:{name:'직접 AI',type:'openai',baseUrl:'https://unit.invalid/v1',apiKey:'qa-only',model:'qa'}},characterAi:{other:'direct'},character:'other'})");
    await js("window.app.history.append('other',[{id:'notice',role:'sys',text:'시스템 알림'},{id:'file-result',role:'bot',text:'파일 완료',memory:false},{id:'qa-memory:user',role:'user',text:'현재 질문'}])");
    await js("window.app.api.chat('qa-memory',{text:'현재 질문',character:'other'},()=>{})");
    const memory=directRequests.at(-1).messages;
    assert.deepEqual(memory.filter(m=>m.role!=='system').map(m=>m.content),['other 기존 대화','other 기존 답변','현재 질문']);
    assert.equal((await js("window.app.history.load('other')")).filter(m=>m.id==='qa-memory:user').length,1);
    console.log('대화 기록 저장·복원·디스코드 출처/시각·캐릭터 배정/중간 전환·숨김 제외·미설정 경고/안내·직접 AI 기억 필터 Electron QA 통과. 결과: '+__dirname);
    console.log('허용 폴더 목록·도움말·/clear·원격 인증·확인 Electron QA 통과: 4개 탭·최소 폭·상태 표시·연결 안내·미인증 대화/찾기/첨부 차단·인증 후 검색·기간 저장 시 인증 유지·연결 해제/재연결 시 재인증·앱 잠금·DM 인증 폐기·키 보존. 결과: ' + __dirname);
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
}
fs.writeFileSync(path.join(base, 'bootstrap.cjs'), `(${run.toString()})(${JSON.stringify(project)});`);
const env = { ...process.env, ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [base], { env, encoding: 'utf8', timeout: 75000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) { process.stderr.write(result.stderr || result.error?.message || 'Electron QA 실패'); process.exitCode = 1; }
