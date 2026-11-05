// 실제 임시 트리에서 위치 해석·동작별 깊이·발음 비교 후보 범위를 함께 검사한다.
import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ToolBroker } from '../src/main/tools/broker';
import { parseLocalCommand } from '../src/shared/commands';
import { validateRoots } from '../src/main/tools/policy';
import type { FileNameMatcher } from '../src/shared/file-names';
import { tmpBase } from './tmp-base';
function setup(matcher: FileNameMatcher | null = null) {
 const base=fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(),'scope-')));
 const top=path.join(base,'test'), music=path.join(top,'my music'), sub=path.join(music,'sub');
 fs.mkdirSync(sub,{recursive:true});
 for(const dir of [music,sub]) fs.writeFileSync(path.join(dir,'메모.txt'),'원본');
 fs.writeFileSync(path.join(sub,'하위전용.txt'),'하위');
 const roots=validateRoots([{id:'qa',label:'시험',path:base,remote:true}]).roots;
 const broker=new ToolBroker({getRoots:()=>roots,getRemoteRoots:()=>roots,getNameMatcher:()=>matcher,shell:{openPath:vi.fn(async()=>''),showItemInFolder:vi.fn()}});
 const command=(s:string)=>{const c=parseLocalCommand(s);if(!c||'help'in c)throw Error('시험 명령');return c;};
 return {base,top,music,sub,broker,command};
}
test.each(['file.open','file.rename','file.backup','file.delete','file.send','file.copy','file.move'])('%s: 자연어 위치는 바로 안만 찾고 하위 전용 대상은 거절한다',async(action)=>{
 const s=setup();const args={root:'my music',target:'메모',name:'새메모.txt',dest:'test'};
 const out=await s.broker.prepareAsync({action,args,source:{kind:'remote'}});
 expect(out.status).toBe('ready');if(out.status==='ready')expect(out.summary.fromPath).toBe(path.join(s.music,'메모.txt'));
 expect(await s.broker.prepareAsync({action,args:{...args,target:'하위전용'},source:{kind:'remote'}})).toMatchObject({status:'error'});
});
test.each(['열기','이름','백업','삭제','보내기','복사','이동'])('%s: 두 접두어 명령에서도 출발 위치를 바로 안으로 제한한다',async(verb)=>{
 const s=setup();const suffix=verb==='이름'?' 새메모.txt':verb==='이동'?' test':'';
 for(const prefix of ['파일','!파일']) {
  const req={...s.command(`${prefix} ${verb} "my music" 메모${suffix}`),source:{kind:'remote' as const}};
  let out=await s.broker.prepareAsync(req);
  if(out.status==='choice' && out.field==='transferChoice'){
   expect(out.options.some(o=>JSON.parse(o.path)[0]===path.join(s.sub,'메모.txt'))).toBe(false);
   const option=out.options.find(o=>JSON.parse(o.path)[0]===path.join(s.music,'메모.txt'))!;
   expect(option).toBeTruthy();out=await s.broker.prepareAsync({...req,args:{...req.args,transferChoice:option.path}});
  }
  expect(out.status).toBe('ready');if(out.status==='ready')expect(out.summary.fromPath).toBe(path.join(s.music,'메모.txt'));
 }
});
test.each(['위치','경로'])('%s: 상대 경로로 지정해도 하위 동명 파일까지 선택받는다',async(verb)=>{
 const s=setup();const out=await s.broker.prepareAsync(s.command(`파일 ${verb} "test/my music" 메모`));
 expect(out.status).toBe('choice');if(out.status==='choice')expect(out.options.map(o=>o.path)).toEqual(expect.arrayContaining([path.join(s.music,'메모.txt'),path.join(s.sub,'메모.txt')]));
});
test('찾기: 명령어 공백 위치와 자연어 root 모두 하위까지 목록으로 반환한다',async()=>{
 const s=setup();
 for(const req of [s.command('파일 찾기 "my music" 메모'),{action:'file.search',args:{root:'test/my music',query:'메모'}}]) {
  const out=await s.broker.prepareAsync(req);expect(out.status).toBe('result');
  if(out.status==='result')expect(out.items.map(o=>o.path)).toEqual([path.join(s.music,'메모.txt'),path.join(s.sub,'메모.txt')]);
 }
});
test('AI 발음 비교에 하위 폴더 파일을 보내지 않으며 위치 보기에는 보낸다',async()=>{
 const seen:string[][]=[];const matcher:FileNameMatcher=async(q,c)=>{if(q==='테스트')seen.push(c.map(v=>v.name));return c.filter(v=>v.name==='test').map(v=>v.id);};
 const s=setup(matcher);fs.writeFileSync(path.join(s.music,'test'),'상위');fs.writeFileSync(path.join(s.sub,'test'),'하위');
 const args={root:'my music',target:'테스트'};
 expect((await s.broker.prepareAsync({action:'file.open',args})).status).toBe('ready');
 expect(seen.at(-1)?.filter(n=>n==='test')).toHaveLength(1);
 expect((await s.broker.prepareAsync({action:'file.reveal',args})).status).toBe('choice');
 expect(seen.at(-1)?.filter(n=>n==='test')).toHaveLength(2);
});
test('위치 생략은 전체 검색, 절대 경로 위치는 바로 안, 명시 경로 이탈은 거절한다',async()=>{
 const s=setup();expect((await s.broker.prepareAsync(s.command('파일 열기 메모'))).status).toBe('choice');
 expect((await s.broker.prepareAsync({action:'file.open',args:{root:s.music,target:'메모'}})).status).toBe('ready');
 expect((await s.broker.prepareAsync({action:'file.open',args:{root:s.music,target:path.join(s.sub,'메모.txt')}})).status).toBe('error');
 expect((await s.broker.prepareAsync({action:'file.search',args:{root:'없는폴더',query:'메모'}})).status).toBe('error');
});
test('생성과 목록은 찾은 기존 폴더 자체에서 수행한다',async()=>{
 const s=setup();const out=await s.broker.prepareAsync(s.command('파일 생성 "my music" 새파일'));
 expect(out.status).toBe('ready');if(out.status==='ready'){await s.broker.execute(out.id);expect(fs.existsSync(path.join(s.music,'새파일'))).toBe(true);expect(fs.existsSync(path.join(s.sub,'새파일'))).toBe(false);}
 const list=await s.broker.prepareAsync({action:'file.list',args:{dest:'my music'}});
 expect(list.status).toBe('result');if(list.status==='result')expect(list.items.some(o=>o.path===path.join(s.sub,'메모.txt'))).toBe(false);
});

test.each(['file.copy','file.move','file.rename','file.delete','file.backup'])('%s 실행 뒤 하위 동명 파일과 내용은 유지한다',async(action)=>{
 const s=setup();const child=path.join(s.sub,'메모.txt');fs.writeFileSync(child,'하위 원본');
 const out=await s.broker.prepareAsync({action,args:{root:'my music',target:'메모',name:action==='file.rename'?'바뀐메모.txt':undefined,dest:action==='file.move'?'test':undefined}});
 expect(out.status).toBe('ready');if(out.status!=='ready')return;
 expect((await s.broker.execute(out.id)).ok).toBe(true);expect(fs.readFileSync(child,'utf8')).toBe('하위 원본');
 expect(fs.existsSync(path.join(s.music,'메모.txt'))).toBe(action==='file.copy'||action==='file.backup');
 if(action==='file.copy')expect(fs.existsSync(path.join(s.music,'메모 (1).txt'))).toBe(true);
 if(action==='file.move')expect(fs.existsSync(path.join(s.top,'메모.txt'))).toBe(true);
});
test('동명 위치는 실제 경로를 선택한 뒤 해당 폴더 바로 안만 처리한다',async()=>{
 const s=setup();const other=path.join(s.base,'other','my music');fs.mkdirSync(other,{recursive:true});fs.writeFileSync(path.join(other,'메모.txt'),'다른 위치');
 const args={root:'my music',target:'메모'};const first=await s.broker.prepareAsync({action:'file.open',args});
 expect(first.status).toBe('choice');if(first.status!=='choice')return;
 expect(first.field).toBe('root');expect(first.options).toHaveLength(2);
 const chosen=await s.broker.prepareAsync({action:'file.open',args:{...args,root:s.music}});
 expect(chosen.status).toBe('ready');if(chosen.status==='ready')expect(chosen.summary.fromPath).toBe(path.join(s.music,'메모.txt'));
});

test('루트 이름이 포함된 명시 경로는 깊은 곳의 동명 폴더로 대체하지 않는다',async()=>{
 const s=setup();
 // 시험/my music은 없고 시험/test/my music만 있다.
 expect((await s.broker.prepareAsync({action:'file.open',args:{root:'시험/my music',target:'메모'}})).status).toBe('error');
 expect((await s.broker.prepareAsync({action:'file.open',args:{root:'시험/test/my music',target:'메모'}})).status).toBe('ready');
});
