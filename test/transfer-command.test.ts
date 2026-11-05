// 실제 임시 파일로 복사·이동의 출발/도착 경계, 사본 이름, 확인·권한을 검사한다.
import { test, expect } from 'vitest';
import fs from 'node:fs';import path from 'node:path';
import { ToolBroker } from '../src/main/tools/broker';
import { parseLocalCommand } from '../src/shared/commands';
import * as policy from '../src/main/tools/policy';
import { matchLocalFileNames } from '../src/main/tools/local-name-matcher';
import { sanitizeEvent } from '../src/main/api/client';
import type { ActionArgs, PrepareResult, ToolRequest } from '../src/shared/types';
import { tmpBase } from './tmp-base';
function setup() {
 const base=fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(),'transfer-'))),root=path.join(base,'root'),other=path.join(base,'other');
 const src=path.join(root,'test'),dest=path.join(root,'my music');for(const p of [src,dest,other])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(path.join(src,'코드2'),'original');fs.writeFileSync(path.join(src,'메모.txt'),'text');fs.writeFileSync(path.join(other,'코드2'),'outside');
 const roots=policy.validateRoots([{id:'qa',label:'시험',path:root,remote:true},{id:'other',label:'기타',path:other}]).roots;
 const broker=new ToolBroker({getRoots:()=>roots,getRemoteRoots:()=>roots.filter(r=>r.remote),getNameMatcher:()=>matchLocalFileNames,shell:{openPath:async()=>'',showItemInFolder:()=>{}}});
 const cmd=(text:string):ToolRequest=>{const c=parseLocalCommand(text);if(!c||'help'in c)throw new Error('시험 명령');return c;};
 const ready=async(req:ToolRequest,target:string,dest:string,name?:string):Promise<Extract<PrepareResult,{status:'ready'}>>=>{
  let out=await broker.prepareAsync(req);
  if(out.status==='choice'){
   expect(out.field).toBe('transferChoice');
   const option=out.options.find(o=>{const v=JSON.parse(o.path);return v[0]===target&&v[1]===dest&&v[2]===(name??null);});
   expect(option,JSON.stringify(out)).toBeTruthy();out=await broker.prepareAsync({...req,args:{...req.args,transferChoice:option!.path}});
  }
  expect(out.status,JSON.stringify(out)).toBe('ready');if(out.status!=='ready')throw new Error('시험 준비');return out;
 };
 return{root,src,dest,other,roots,broker,cmd,ready};
}

test.each(['파일','!파일'])('%s 복사·이동: 공백 도착 폴더와 출발 폴더를 함께 구분한다',async(prefix)=>{
 for(const action of ['복사','이동']){
  const s=setup(),file=path.join(s.src,'코드2');
  const out=await s.ready(s.cmd(`${prefix} ${action} test 코드2 my music`),file,s.dest);
  expect(out.needsConfirm).toBe(true);expect(fs.existsSync(path.join(s.dest,'코드2'))).toBe(false);
  expect((await s.broker.execute(out.id)).ok).toBe(true);expect(fs.readFileSync(path.join(s.dest,'코드2'),'utf8')).toBe('original');
  expect(fs.existsSync(file)).toBe(action==='복사');expect(fs.readFileSync(path.join(s.other,'코드2'),'utf8')).toBe('outside');
 }
});

test.each(['file.copy','file.move'])('%s 자연어 root와 공백 dest도 같은 범위를 쓴다',async(action)=>{
 const s=setup(),out=await s.broker.prepareAsync({action,args:{root:'test',target:'코드2',dest:'my music'}});
 expect(out.status).toBe('ready');if(out.status!=='ready')return;
 expect(out.summary.fromPath).toBe(path.join(s.src,'코드2'));expect(out.summary.toPath).toBe(path.join(s.dest,'코드2'));
});

test('출발 위치 생략 시 동명 파일은 경로로 선택한다',async()=>{
 const s=setup(),req=s.cmd('파일 복사 코드2 my music'),out=await s.broker.prepareAsync(req);
 expect(out.status).toBe('choice');if(out.status!=='choice')return;
 expect(out.options.some(o=>JSON.parse(o.path)[0]===path.join(s.src,'코드2'))).toBe(true);
 expect(out.options.some(o=>JSON.parse(o.path)[0]===path.join(s.other,'코드2'))).toBe(true);
});

test('같은 폴더 기본 복사는 (n)을 확장자 앞에 붙이고 원본을 유지한다',async()=>{
 const s=setup();
 for(const n of [1,2]){
  const out=await s.ready(s.cmd('파일 복사 test 메모.txt'),path.join(s.src,'메모.txt'),s.src);
  expect(out.summary.toPath).toBe(path.join(s.src,`메모 (${n}).txt`));await s.broker.execute(out.id);
 }
 expect(fs.readFileSync(path.join(s.src,'메모.txt'),'utf8')).toBe('text');
 const raw=await s.broker.prepareAsync({action:'file.copy',args:{target:path.join(s.src,'코드2'),sameFolder:true}});
 expect(raw.status).toBe('ready');if(raw.status==='ready')expect(raw.summary.toPath).toBe(path.join(s.src,'코드2 (1)'));
});

test('같은 폴더 새 이름 복사와 공백 이름 따옴표를 지원한다',async()=>{
 const s=setup(),out=await s.ready(s.cmd('파일 복사 test 코드2 "새 코드"'),path.join(s.src,'코드2'),s.src,'새 코드');
 expect(out.summary.toPath).toBe(path.join(s.src,'새 코드'));await s.broker.execute(out.id);
 expect(fs.readFileSync(path.join(s.src,'새 코드'),'utf8')).toBe('original');expect(fs.existsSync(path.join(s.src,'코드2'))).toBe(true);
 expect(await s.broker.prepareAsync({action:'file.copy',args:{root:'test',target:'코드2',sameFolder:true,name:'새 코드'}})).toMatchObject({status:'error',code:'conflict'});
});

test('도착 폴더와 새 이름 둘 다 가능하면 조합을 고른다',async()=>{
 const s=setup();const elsewhere=path.join(s.root,'nested','도착');fs.mkdirSync(elsewhere,{recursive:true});
 const out=await s.broker.prepareAsync(s.cmd('파일 복사 test 코드2 도착'));
 expect(out.status).toBe('choice');if(out.status!=='choice')return;
 const combos=out.options.map(o=>JSON.parse(o.path));
 expect(combos).toContainEqual([path.join(s.src,'코드2'),elsewhere,null]);
 expect(combos).toContainEqual([path.join(s.src,'코드2'),s.src,'도착']);
});

test('선택 취소·허위 선택·도착지 변경·실행 직전 충돌은 원본을 유지한다',async()=>{
 const s=setup(),req=s.cmd('파일 이동 test 코드2 my music'),ready=await s.ready(req,path.join(s.src,'코드2'),s.dest);
 s.broker.cancel(ready.id);expect((await s.broker.execute(ready.id)).ok).toBe(false);expect(fs.existsSync(path.join(s.src,'코드2'))).toBe(true);
 expect(await s.broker.prepareAsync({...req,args:{...req.args,transferChoice:'bad'}})).toMatchObject({status:'error',code:'changed'});
 const copy=await s.ready(s.cmd('파일 복사 test 메모.txt'),path.join(s.src,'메모.txt'),s.src);
 fs.writeFileSync(copy.summary.toPath!,'racer');expect((await s.broker.execute(copy.id)).ok).toBe(false);expect(fs.readFileSync(copy.summary.toPath!,'utf8')).toBe('racer');
});

test.each(['file.copy','file.move'])('%s의 원격 허용·출발 범위·목적지 필수 규칙을 지킨다',async(action)=>{
 const s=setup();expect(await s.broker.prepareAsync({action,args:{root:s.other,target:'코드2',dest:s.dest},source:{kind:'remote'}})).toMatchObject({status:'error'});
 expect(await s.broker.prepareAsync({action,args:{root:'my music',target:'코드2',dest:s.src}})).toMatchObject({status:'error'});
 expect(await s.broker.prepareAsync({action,args:{root:'test',target:'코드2',dest:path.dirname(s.root)}})).toMatchObject({status:'error'});
 if(action==='file.move')expect(await s.broker.prepareAsync({action,args:{root:'test',target:'코드2'}})).toMatchObject({status:'error'});
});

test('서버 sameFolder는 bool만 받고 정형 내부 인자는 버린다',()=>{
 const base={type:'client_action',id:'x',action:'file.copy'};
 const event=sanitizeEvent({...base,args:{target:'메모.txt',sameFolder:true,name:'새메모.txt',transferParts:[{}]}});
 expect(event?.type==='client_action'&&event.args).toEqual({target:'메모.txt',sameFolder:true,name:'새메모.txt'});
 const invalid=sanitizeEvent({...base,args:{target:'메모',sameFolder:'true'}});expect(invalid?.type==='client_action'&&invalid.args).toEqual({target:'메모'});
});
