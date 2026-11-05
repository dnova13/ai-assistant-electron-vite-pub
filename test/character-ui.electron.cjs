// 실행: npm run build 후 node test/character-ui.electron.cjs. 실제 앱을 임시 데이터로 실행한다.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..'),base=fs.mkdtempSync(path.join(os.tmpdir(),'character-ui-qa-'));
fs.cpSync(path.join(project,'characters/sample'),path.join(base,'characters/sample'),{recursive:true});
for(const name of ['assets'])fs.cpSync(path.join(project,name),path.join(base,name),{recursive:true});
const user=path.join(base,'my-characters/other');fs.mkdirSync(user,{recursive:true});
fs.writeFileSync(path.join(user,'config.json'),JSON.stringify({name:'시험 캐릭터',type:'image',persona:'다른 캐릭터',image:'character.svg',icon:'character.svg'}));
fs.writeFileSync(path.join(user,'character.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="30" fill="green"/></svg>');
fs.writeFileSync(path.join(base,'new.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="purple"/></svg>');
fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'character-qa',version:'0.0.0',main:'bootstrap.cjs'}));
async function run(project){
 const {app,BrowserWindow,dialog,session}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const base=__dirname;app.setName('Character QA');app.setPath('userData',path.join(base,'profile'));app.disableHardwareAcceleration();
 globalThis.fetch=async()=>{throw Error('외부 HTTP 차단');};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(base,'new.svg')]});
 app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true})));
 require(path.join(project,'out/main/index.js'));
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function wait(fn){for(let i=0;i<160;i++){try{const result=await fn();if(result)return result;}catch{}await sleep(50);}throw Error('시험 대기 시간 초과');}
 try{
  const chat=await wait(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')));
  const js=(code,w=chat)=>w.webContents.executeJavaScript('(async()=>{return '+code+'})()').catch(e=>{throw Error(code.slice(0,140)+' → '+e.message);});
  await wait(()=>js("!!document.getElementById('input')"));
  const original=fs.readFileSync(path.join(base,'characters/sample/config.json'),'utf8');
  await js("window.app.history.append('sample',[{role:'user',text:'기록 보존'}])");
  await js("window.app.settingsWindow.open('character')");
  const settings=await wait(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/settings.html')));
  await wait(()=>js("!!document.querySelector('[data-char=sample] .charVisibility')",settings));
  const click=(selector,w=settings)=>js(`document.querySelector(${JSON.stringify(selector)}).click()`,w);
  await click('[data-char=sample] .charVisibility');
  await wait(()=>js("document.querySelector('.chatEmpty h2')?.textContent==='대화할 캐릭터를 선택해 주세요'"));
  assert.equal(await js("document.querySelectorAll('#charBar .barItem').length"),1);
  assert.equal(await js("document.getElementById('input').placeholder"),'대화할 캐릭터를 먼저 선택해 주세요');
  assert.equal(await js("(await window.app.settings.load()).settings.character"),'sample');
  await click('[data-char=other] .charVisibility');
  await wait(()=>js("document.querySelector('.chatEmpty h2')?.textContent==='표시 중인 캐릭터가 없습니다'"));
  assert.equal(await js("document.querySelectorAll('#charBar .barItem').length"),0);
  assert.equal(await js("['input','btnMic','btnSend'].every(id=>document.getElementById(id).disabled)"),true);
  await js("document.querySelector('.chatEmpty button').click()");
  assert.equal(await js("document.querySelector('.tab.active').textContent",settings),'캐릭터');
  fs.writeFileSync(path.join(base,'empty.png'),(await chat.webContents.capturePage()).toPNG());
  const stale=await js("window.app.settings.load()");
  await js(`window.app.settings.save({...${JSON.stringify(stale.settings)},hiddenCharacters:[]})`);
  assert.deepEqual(await js("(await window.app.settings.load()).settings.hiddenCharacters"),['sample','other']);
  // 숨겨도 편집 가능하고 기본 비서 삭제는 IPC에서도 금지한다.
  assert.equal(await js("document.getElementById('charEditName').disabled",settings),false);
  for(const [id,value] of [['charEditName','수정 비서'],['charEditPersona','새 말투']]){
   await js(`(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,settings);
  }
  await click('#btnCharEditSave');
  await wait(()=>js("(await window.app.characters.list()).find(c=>c.id==='sample').config.name==='수정 비서'"));
  await wait(()=>js("!document.getElementById('btnCharEditImage').disabled",settings));
  await click('#btnCharEditImage');
  const image=await wait(()=>js("(await window.app.characters.list()).find(c=>c.id==='sample').config.image.startsWith('character-') && (await window.app.characters.list()).find(c=>c.id==='sample').config.image"));
  assert.equal(await js(`(await fetch('app://local/characters/sample/${image}')).ok`),true);
  assert.equal(fs.readFileSync(path.join(base,'characters/sample/config.json'),'utf8'),original);
  assert.equal(await js("window.app.characters.remove('sample').then(()=>false,()=>true)"),true);
  const store=await js("window.app.settings.load()");
  store.settings.profiles.qa={name:'시험 AI',type:'ollama',baseUrl:'https://unit.invalid',model:'qa'};store.settings.characterAi={sample:'qa',other:'qa'};
  store.settings.characterVoice={sample:{engine:'builtin',volume:12,rate:1,wakeName:'수정호출어'},other:{engine:'builtin',volume:34,rate:1}};
  await js(`window.app.settings.save(${JSON.stringify(store.settings)})`);
  await wait(()=>js("!document.getElementById('btnCharReset').disabled",settings));
  assert.equal(await js("(()=>{const head=document.querySelector('.charEditHead');return head.querySelector('button').getBoundingClientRect().left>head.querySelector('b').getBoundingClientRect().right})()",settings),true);
  await click('#btnCharReset');
  await wait(()=>js("(await window.app.characters.list()).find(c=>c.id==='sample').config.name==='기본 비서'"));
  await wait(()=>js("!document.getElementById('btnCharReset').disabled",settings));
  const reset=await js("window.app.settings.load()");assert.equal(reset.settings.characterVoice.sample?.volume ?? 100,100);assert.equal(reset.settings.characterVoice.sample?.wakeName ?? '','');assert.equal(reset.settings.characterAi.sample,undefined);assert.equal(reset.settings.characterAi.other,'qa');assert.ok(reset.settings.profiles.qa);assert.equal(reset.settings.characterVoice.other.volume,34);
  assert.equal((await js("window.app.history.load('sample')")).some(m=>m.text==='기록 보존'),true);
  assert.deepEqual(reset.settings.hiddenCharacters,['sample','other']);
  assert.equal(await js("(await window.app.characters.list()).find(c=>c.id==='sample').config.image"),'character.svg');
  fs.writeFileSync(path.join(base,'reset.png'),(await settings.webContents.capturePage()).toPNG());
  await click('[data-char=sample] .charVisibility');
  await wait(()=>js("document.querySelectorAll('#charBar .barItem').length===1 && !document.querySelector('.chatEmpty')"));
  assert.equal(await js("document.getElementById('input').disabled"),false);
  await click('[data-char=other]');
  await wait(()=>js("!document.getElementById('btnCharReset')",settings));
  fs.writeFileSync(path.join(base,'settings.png'),(await settings.webContents.capturePage()).toPNG());
  console.log('캐릭터 Electron QA 통과: 즉시 숨김·자동전환 없음·전체 숨김·입력 차단·설정 바로가기·재표시·기본 비서 편집/그림/원본 보존/삭제 거절·제목 오른쪽 초기화·목소리/대화 기록/숨김 보존. 결과: '+base);
  app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
}
fs.writeFileSync(path.join(base,'bootstrap.cjs'),`(${run.toString()})(${JSON.stringify(project)});`);
const env={...process.env,ELECTRON_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[base],{env,encoding:'utf8',timeout:45000});
if(result.stdout)process.stdout.write(result.stdout);
if(result.status!==0){process.stderr.write(result.stderr||result.error?.message||'Electron QA 실패');process.exitCode=1;}
