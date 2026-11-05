// 실제 React 확인창을 개인 데이터와 분리한 별도 Electron 창에서 시험한다.
// 실행: node test/dialog-keyboard.electron.cjs (Electron을 실행할 수 있는 데스크톱 환경 필요)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-keyboard-qa-'));
const component = path.resolve(__dirname, '../src/renderer/src/chat/components/ConfirmDialog.tsx');
const controller = path.resolve(__dirname, '../src/renderer/src/chat/controller.ts');
buildSync({
  stdin: { resolveDir: path.resolve(__dirname, '..'), loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ConfirmDialog} from ${JSON.stringify(component)};
    import {ChatController} from ${JSON.stringify(controller)};
    const root=createRoot(document.getElementById('root'));
    window.results=[];window.outsideKeys=0;window.aiCalls=[];window.aiDecision='unknown';window.aiDelay=0;
    window.confirmAI=async(q,a)=>{window.aiCalls.push([q,a]);const result=window.aiDecision;await new Promise(r=>setTimeout(r,window.aiDelay));return result;};
    document.addEventListener('keydown',()=>window.outsideKeys++);
    const resolve=(v)=>{window.results.push(v);flushSync(()=>root.render(<ConfirmDialog dialog={null} onResolve={resolve} interpret={window.confirmAI}/>));};
    window.showFileDialog=(action,qi)=>{
      const questions=action==='file.delete'?['삭제하겠습니까?','정말로 삭제하겠습니까?']:['작업하겠습니까?'];
      const res={expiresInMs:60000,summary:{action,from:'시험/메모',fromPath:'/시험/메모',warnings:[],questions}};
      const dialog=(ChatController.prototype as any).planDialog.call(null,res,'local',qi||0);
      window.lastDialog=dialog;
      flushSync(()=>root.render(<ConfirmDialog dialog={dialog} onResolve={resolve} interpret={window.confirmAI}/>));
    };
    window.showDialog=(kind,seconds)=>{
      if(kind==='server'){
        // 실제 서버 확인창의 구성만 캡처한다. API에 도달하는 승인 대기는 끝내지 않는다.
        (ChatController.prototype as any).serverConfirm.call({enqueue:(f)=>f(),ask:(dialog)=>{
          window.lastDialog=dialog;
          flushSync(()=>root.render(<ConfirmDialog dialog={dialog} onResolve={resolve} interpret={window.confirmAI}/>));
          return new Promise(()=>{});
        }},{id:'qa',message:'서버 작업 시험',expiresIn:60});
        return;
      }
      const choices=kind==='choice'?[{path:'one',display:'첫 번째'},{path:'two',display:'두 번째'},{path:'three',display:'세 번째'}]:undefined;
      const buttons=choices?[{label:'취소',value:null}]:kind==='server'?[{label:'취소',value:false},{label:'승인',value:true}]:[{label:'아니오',value:null},{label:'예',value:'approve',kind:'primary'}];
      flushSync(()=>root.render(<ConfirmDialog dialog={{title:kind,lines:[],choices,buttons,seconds}} onResolve={resolve} interpret={window.confirmAI}/>));
    };
  ` }, alias: { '@shared': path.resolve(__dirname, '../src/shared') }, bundle: true, outfile: path.join(base, 'fixture.js'), platform: 'browser', jsx: 'automatic'
});
fs.writeFileSync(path.join(base, 'index.html'), '<meta charset="utf-8"><input id="outside"><button id="outsideBtn">바깥 버튼</button><div id="root"></div><script src="fixture.js"></script>');
// 테스트만 임시 프로필을 쓴다. 사용자 앱·서버·실제 파일 동작은 호출하지 않는다.
async function nativeTest() {
  const { app, BrowserWindow, session } = require('electron');
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const base = __dirname;
  app.setPath('userData', path.join(base, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    win = new BrowserWindow({ show: true, title: '키보드 조작 시험', webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadFile(path.join(base, 'index.html'));
    win.focus();
    const js = (code) => win.webContents.executeJavaScript(code).catch(error=>{throw Error(code.slice(0,180)+' → '+error.message)});
    const active = () => js('document.activeElement.textContent');
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await delay(35);
    };
    const show = async (kind, seconds) => { await js(`document.getElementById('outside').focus();window.showDialog(${JSON.stringify(kind)},${seconds || 0})`); };
    await show('choice');assert.equal(await active(), '취소');
    await key('Down');assert.equal(await active(), '첫 번째');
    await key('Right');assert.equal(await active(), '두 번째');
    await key('Up');assert.equal(await active(), '첫 번째');
    await key('Left');assert.equal(await active(), '취소');
    await key('Tab');assert.equal(await active(), '첫 번째');
    await key('Tab', ['shift']);assert.equal(await active(), '취소');
    await key('Up');assert.equal(await active(), '세 번째');
    await key('Enter');assert.deepEqual(await js('window.results'), ['three']);
    assert.equal(await js('document.activeElement.id'), 'outside');
    await show('confirm');assert.equal(await active(), '아니오');
    await key('Right');assert.equal(await active(), '예');
    await key('Enter');assert.deepEqual(await js('window.results'), ['three', 'approve']);
    await show('confirm');assert.equal(await active(), '아니오');
    // 길게 누른 Enter는 새 창의 현재 버튼도 실행하지 않는다.
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}))");
    assert.equal(await js('window.results.length'), 2);
    await key('Enter');assert.equal(await js('window.results.at(-1)'), null);
    await show('server');assert.equal(await active(), '예');
    assert.deepEqual(await js("[...document.querySelectorAll('#actButtons button')].map(b=>b.textContent)"), ['예','아니오']);
    await key('Enter');assert.equal(await js('window.results.at(-1)'), true);
    await show('choice');await key('Escape');assert.equal(await js('window.results.at(-1)'), null);
    await show('confirm');
    await js("document.getElementById('outsideBtn').focus()");assert.equal(await active(), '아니오');
    await key('Tab', ['shift']);assert.equal(await js('document.activeElement.tagName'), 'INPUT');
    await key('Tab', ['shift']);assert.equal(await active(), '예');
    await key('Space');assert.equal(await js('window.results.at(-1)'), 'approve');
    await show('choice');
    const count = await js('window.outsideKeys');await key('A');await key('Down');
    assert.equal(await js('window.outsideKeys'), count);
    assert.equal(await js("document.getElementById('outside').value"), '');
    // 시간 초과와 창 교체 뒤에도 취소 쪽 초점·해제가 유지된다.
    await js("window.showDialog('confirm',1)");assert.equal(await active(), '아니오');
    await delay(1250);assert.equal(await js('window.results.at(-1)'), 'expired');
    const after=await js('window.outsideKeys');await key('A');assert.ok(await js('window.outsideKeys') > after);
    // 실제 파일 작업 확인창: 버튼 배치와 각 동작의 기본 초점을 함께 검증한다.
    for (const action of ['file.copy','file.move','file.rename','file.backup','file.delete']) {
      for (const qi of action==='file.delete'?[0,1]:[0]) {
        await js(`window.showFileDialog(${JSON.stringify(action)},${qi})`);
        assert.deepEqual(await js("[...document.querySelectorAll('#actButtons button')].map(b=>b.textContent)"), ['예','아니오']);
        assert.equal(await active(), action==='file.delete'?'아니오':'예');
        if(action==='file.delete')assert.equal(await js('window.lastDialog.title'),qi===0?'삭제하겠습니까?':'정말로 삭제하겠습니까?');
        const count=await js('window.results.length');
        await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}))");
        assert.equal(await js('window.results.length'),count);
        await key('Enter');assert.equal(await js('window.results.at(-1)'),action==='file.delete'?null:'approve');
        await js(`window.showFileDialog(${JSON.stringify(action)},${qi})`);
        await key('Right');assert.equal(await active(),action==='file.delete'?'예':'아니오');
        await key('Enter');assert.equal(await js('window.results.at(-1)'),action==='file.delete'?'approve':null);
      }
    }
    const typeAnswer=async(text)=>{
      await js(`(()=>{const el=document.querySelector('input[aria-label="확인 답변"]');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await delay(30);await key('Enter');await delay(60);
    };
    await js("window.showFileDialog('file.copy',0)");
    await typeAnswer('어');assert.equal(await js('window.results.at(-1)'), 'approve');assert.equal(await js('window.aiCalls.length'),0);
    await js("window.aiDecision='yes';window.showFileDialog('file.copy',0)");
    await typeAnswer('그래 진행해');assert.equal(await js('window.results.at(-1)'), 'approve');assert.equal(await js('window.aiCalls.at(-1)[1]'),'그래 진행해');
    await js("window.aiDecision='unknown';window.showFileDialog('file.copy',0)");
    const n=await js('window.results.length');await typeAnswer('아마도');
    assert.equal(await js('window.results.length'),n);assert.ok(await js("document.getElementById('actBody').parentElement.textContent.includes('다시 답해')"));
    await typeAnswer('no');assert.equal(await js('window.results.at(-1)'),null);
    // AI 응답이 늦게 도착해도 새 확인창을 승인하지 않는다.
    await js("window.aiDecision='yes';window.aiDelay=300;window.showFileDialog('file.copy',0)");
    await typeAnswer('그래 진행해');await key('Escape');
    await js("window.showFileDialog('file.delete',1)");
    const late=await js('window.results.length');await delay(400);assert.equal(await js('window.results.length'),late);
    assert.equal(await js('window.lastDialog.title'),'정말로 삭제하겠습니까?');await key('Escape');
    console.log('Electron 키보드 시험 통과: 4방향·순환·Tab/Shift+Tab·Enter·Space·Esc·취소 초기값·반복 Enter 차단·배경 차단·초점 복원·시간 초과·예/아니오 순서·일반 작업 예·삭제 두 단계 아니오');
    win.destroy();app.exit(0);
  } catch (e) {
    console.error(e);if(win)win.destroy();app.exit(1);
  }
}
fs.writeFileSync(path.join(base, 'main.cjs'), `(${nativeTest.toString()})();`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(base, 'main.cjs')], { env, encoding: 'utf8', timeout: 30000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.error?.message || 'Electron 시험 실패');
  process.exitCode = 1;
}
