// 기본 원본 보존·편집 사본·초기화·숨김 상태를 실제 임시 파일로 검사한다.
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpBase } from './tmp-base';
import { updateCharacter, replaceCharacterImage, resetBuiltinCharacter, deleteCharacter } from '../src/main/character-add';
import { scanCharacterDirs, dirForCharacterUrl, builtinOverridesDir } from '../src/main/character-dirs';
import { defaults, normalize, createStore } from '../src/main/settings';
import { visibleCharacters, selectedCharacter, setLocked } from '../src/shared/character-order';
function setup() {
 const root=fs.mkdtempSync(path.join(tmpBase(),'builtin-edit-')),builtin=path.join(root,'characters'),user=path.join(root,'mine');
 fs.mkdirSync(path.join(builtin,'sample'),{recursive:true});fs.mkdirSync(user);
 const config={name:'기본 비서',type:'image',persona:'최초 말투',image:'character.svg',icon:'character.svg',voice:{voice:'default'}};
 fs.writeFileSync(path.join(builtin,'sample','config.json'),JSON.stringify(config));fs.writeFileSync(path.join(builtin,'sample','character.svg'),'<svg/>');
 const image=path.join(root,'new.png');fs.writeFileSync(image,'새 이미지');
 return {root,builtin,user,config,image};
}
test('기본 비서 수정은 편집 사본만 바꾸고 목록은 기본 비서 하나로 유지한다',()=>{
 const s=setup(),before=fs.readFileSync(path.join(s.builtin,'sample','config.json'),'utf8');
 updateCharacter(s.user,'sample',{name:'바뀐 이름',persona:'바뀐 말투'},s.builtin);
 const list=scanCharacterDirs(s.builtin,s.user);expect(list).toHaveLength(1);expect(list[0]).toMatchObject({id:'sample',builtin:true,config:{name:'바뀐 이름',persona:'바뀐 말투'}});
 expect(fs.readFileSync(path.join(s.builtin,'sample','config.json'),'utf8')).toBe(before);
 expect(dirForCharacterUrl(s.builtin,s.user,'sample/character.svg')).toBe(s.builtin);
});
test('그림 수정과 초기화는 원본/옛 수정본을 보존하고 이미지 경로를 복원한다',()=>{
 const s=setup();updateCharacter(s.user,'sample',{name:'수정',persona:'말투'},s.builtin);
 const changed=replaceCharacterImage(s.user,'sample',s.image,s.builtin);
 const file=String(changed.config.image);expect(dirForCharacterUrl(s.builtin,s.user,`sample/${file}`)).toBe(builtinOverridesDir(s.user));
 expect(fs.readFileSync(path.join(builtinOverridesDir(s.user),'sample',file),'utf8')).toBe('새 이미지');
 expect(fs.readFileSync(path.join(s.builtin,'sample','character.svg'),'utf8')).toBe('<svg/>');
 resetBuiltinCharacter(s.builtin,s.user,'sample');expect(scanCharacterDirs(s.builtin,s.user)[0].config).toEqual(s.config);
 expect(dirForCharacterUrl(s.builtin,s.user,'sample/character.svg')).toBe(s.builtin);
 expect(fs.readdirSync(path.join(builtinOverridesDir(s.user),'_to_delete')).some(n=>n.includes('-reset-'))).toBe(true);
 expect(()=>deleteCharacter(s.user,'sample')).toThrow('기본 캐릭터');
 expect(()=>resetBuiltinCharacter(s.builtin,s.user,'../sample')).toThrow();
});
test('숨김은 전부 가능하고 선택 캐릭터를 다른 캐릭터로 대체하지 않는다',()=>{
 const list=[{id:'sample'},{id:'other'}];let hidden=setLocked([],'sample',true,list.map(c=>c.id));
 expect(selectedCharacter(list,'sample',hidden)).toBeNull();expect(visibleCharacters(list,hidden)).toEqual([{id:'other'}]);
 hidden=setLocked(hidden,'other',true,list.map(c=>c.id));expect(visibleCharacters(list,hidden)).toEqual([]);
 hidden=setLocked(hidden,'sample',false,list.map(c=>c.id));expect(selectedCharacter(list,'sample',hidden)?.id).toBe('sample');
});
test('기존 설정에는 숨김이 없고 저장 후 재로드해도 숨김·대화 선택·다른 설정이 유지된다',()=>{
 const s=setup();expect(normalize({}).hiddenCharacters).toEqual([]);
 const store=createStore(path.join(s.root,'settings.json'), null);const first=defaults();first.hiddenCharacters=['sample','other'];first.character='sample';
 const saved=store.save(first);expect(saved.hiddenCharacters).toEqual(['sample','other']);
 expect(store.load().hiddenCharacters).toEqual(['sample','other']);expect(store.load().character).toBe('sample');
 expect(normalize({...first,hiddenCharacters:['sample','sample',false]}).hiddenCharacters).toEqual(['sample']);
});
