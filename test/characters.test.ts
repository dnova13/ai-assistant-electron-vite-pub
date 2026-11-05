// 캐릭터 추가: 그림 파일·Live2D 폴더를 캐릭터 폴더에 복사하고 config.json을 만든다 (설정 > 캐릭터 > 캐릭터 추가)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addImageCharacter, addLive2dCharacter, afterDelete, assertNotBuiltin, characterPath, cleanName, cleanPersona, deleteCharacter, findModel3, folderId, replaceCharacterImage, updateCharacter } from '../src/main/character-add';
import { normalize } from '../src/main/settings';
import { dirForCharacterUrl, dirOfCharacter, migrateOldCharacters, scanCharacterDirs } from '../src/main/character-dirs';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readCfg = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, id, 'config.json'), 'utf8'));

test('이름·성격 정리, 폴더 이름 만들기', () => {
  assert.throws(() => cleanName('   '), /이름을 적어/);
  assert.equal(cleanName('  하나\n 비서 '), '하나 비서');
  assert.equal(cleanName('가'.repeat(40)).length, 30);
  assert.equal(cleanPersona('a'.repeat(600)).length, 500);
  const dir = tmp('chars-');
  assert.equal(folderId('하나 비서', dir), '하나-비서');
  assert.equal(folderId('_숨김/이름:*?', dir), '숨김이름'); // _로 시작하면 목록에 안 나오므로 뺀다, OS가 못 쓰는 글자 뺌
  assert.equal(folderId('...', dir), 'character');
  assert.equal(folderId('CON', dir), 'character'); // 윈도우 예약 이름
  fs.mkdirSync(path.join(dir, '하나'));
  fs.mkdirSync(path.join(dir, '하나-2'));
  assert.equal(folderId('하나', dir), '하나-3');
});

test('그림 캐릭터 추가: 파일 복사 + config.json, 같은 이름이면 -2', () => {
  const src = tmp('src-');
  const png = path.join(src, '내 그림.PNG');
  fs.writeFileSync(png, 'png');
  const dir = path.join(tmp('chars-'), 'characters'); // 폴더가 없어도 만든다
  const c = addImageCharacter(dir, png, { name: '하나', persona: '밝은 비서' });
  assert.equal(c.id, '하나');
  assert.deepEqual(readCfg(dir, '하나'), { name: '하나', type: 'image', persona: '밝은 비서', image: 'character.png', icon: 'character.png', voice: { voice: 'default' } });
  assert.equal(fs.readFileSync(path.join(dir, '하나', 'character.png'), 'utf8'), 'png');
  assert.ok(fs.existsSync(png)); // 원본은 그대로
  assert.equal(addImageCharacter(dir, png, { name: '하나', persona: '' }).id, '하나-2');
});

test('그림 캐릭터: 그림이 아니거나 이름이 없으면 오류, 폴더를 만들지 않는다', () => {
  const src = tmp('src-');
  const txt = path.join(src, 'a.txt');
  fs.writeFileSync(txt, 'x');
  const dir = tmp('chars-');
  assert.throws(() => addImageCharacter(dir, txt, { name: '하나', persona: '' }), /그림 파일만/);
  assert.throws(() => addImageCharacter(dir, path.join(src, 'a.png'), { name: '', persona: '' }), /이름을 적어/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

function fakeModel(root: string, sub: string, model: object): void {
  fs.mkdirSync(path.join(root, sub, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(root, sub, 'hana.model3.json'), JSON.stringify(model));
  fs.writeFileSync(path.join(root, sub, 'hana.moc3'), 'moc');
  fs.writeFileSync(path.join(root, sub, 'textures', 't.png'), 'png');
}

test('Live2D 캐릭터 추가: 폴더를 model/로 복사, .model3.json 찾기, 입 파라미터·기본 모션 채우기', () => {
  const src = tmp('l2d-');
  fakeModel(src, 'runtime', { Groups: [{ Name: 'LipSync', Ids: ['ParamMouthOpen'] }], FileReferences: { Motions: { TapBody: [], Idle: [] } } });
  fs.writeFileSync(path.join(src, '.DS_Store'), 'x');
  assert.equal(findModel3(src), 'runtime/hana.model3.json');
  const dir = tmp('chars-');
  const c = addLive2dCharacter(dir, src, { name: 'Hana', persona: '' });
  const cfg = readCfg(dir, c.id);
  assert.equal(cfg.type, 'live2d');
  assert.equal(cfg.live2d.model, 'model/runtime/hana.model3.json');
  assert.equal(cfg.live2d.params.mouthOpen, 'ParamMouthOpen');
  assert.equal(cfg.live2d.motions.idle, 'Idle');
  assert.ok(fs.existsSync(path.join(dir, c.id, 'model', 'runtime', 'textures', 't.png')));
  assert.ok(!fs.existsSync(path.join(dir, c.id, 'model', '.DS_Store'))); // 숨김 파일은 안 가져옴
});

test('Live2D: 모델 파일이 없거나 캐릭터 폴더 안을 고르면 오류', () => {
  const dir = tmp('chars-');
  const empty = tmp('l2d-');
  fs.writeFileSync(path.join(empty, 'old.model.json'), '{}'); // Cubism 2
  assert.throws(() => addLive2dCharacter(dir, empty, { name: 'a', persona: '' }), /\.model3\.json\)이 없습니다/);
  fakeModel(dir, 'inside', {});
  assert.throws(() => addLive2dCharacter(dir, path.join(dir, 'inside'), { name: 'a', persona: '' }), /캐릭터 폴더 안의 폴더/);
  const src = tmp('l2d-');
  fakeModel(src, '', {}); // 그룹·모션 없음 → 기본값
  const c = addLive2dCharacter(dir, src, { name: 'b', persona: '' });
  assert.equal(readCfg(dir, c.id).live2d.params.mouthOpen, 'ParamMouthOpenY');
  assert.equal(readCfg(dir, c.id).live2d.model, 'model/hana.model3.json');
});

/* ---------------- 수정·삭제 ---------------- */

const SAMPLE_CFG = JSON.stringify({ name: '기본 비서', type: 'image', image: 'character.svg', icon: 'character.svg', voice: { voice: 'v1' } });

/** builtin = 기본 캐릭터 폴더(읽기 전용), dir = 내가 추가한 캐릭터 폴더 */
function setup() {
  const builtin = tmp('builtin-');
  const dir = tmp('mine-');
  const src = tmp('src-');
  const png = path.join(src, 'a.png');
  fs.writeFileSync(png, 'A');
  fs.mkdirSync(path.join(builtin, 'sample'));
  fs.writeFileSync(path.join(builtin, 'sample', 'config.json'), SAMPLE_CFG);
  fs.writeFileSync(path.join(builtin, 'sample', 'character.svg'), '<svg/>');
  const c = addImageCharacter(dir, png, { name: '하나', persona: '원래' }, builtin);
  return { builtin, dir, src, id: c.id };
}

test('이름·성격 수정: 다른 항목(목소리 등)은 그대로', () => {
  const { dir, id } = setup();
  const c = updateCharacter(dir, id, { name: ' 새 이름 ', persona: '바뀐 성격' });
  assert.equal(c.config.name, '새 이름');
  assert.deepEqual(readCfg(dir, id), { name: '새 이름', type: 'image', persona: '바뀐 성격', image: 'character.png', icon: 'character.png', voice: { voice: 'default' } });
  assert.throws(() => updateCharacter(dir, id, { name: '', persona: '' }), /이름을 적어/);
});

test('그림 바꾸기: 새 이름으로 복사, 이전 그림은 지움, Live2D는 안 됨', () => {
  const { dir, src, id } = setup();
  const b = path.join(src, 'b.webp');
  fs.writeFileSync(b, 'B');
  const c = replaceCharacterImage(dir, id, b);
  assert.match(String(c.config.image), /^character-\d+\.webp$/);
  assert.equal(c.config.icon, c.config.image);
  assert.equal(fs.readFileSync(path.join(dir, id, String(c.config.image)), 'utf8'), 'B');
  assert.ok(!fs.existsSync(path.join(dir, id, 'character.png'))); // 이전 그림 지움
  assert.ok(fs.existsSync(b)); // 원본은 그대로
  assert.throws(() => replaceCharacterImage(dir, id, path.join(src, 'x.txt')), /그림 파일만/);
  // config에 폴더 밖 경로가 있어도 밖의 파일은 지우지 않는다
  const outside = path.join(dir, 'outside.png');
  fs.writeFileSync(outside, 'keep');
  const cfg = readCfg(dir, id);
  fs.writeFileSync(path.join(dir, id, 'config.json'), JSON.stringify({ ...cfg, image: '../outside.png' }));
  replaceCharacterImage(dir, id, b);
  assert.ok(fs.existsSync(outside));
  const l2d = tmp('l2d-');
  fakeModel(l2d, '', {});
  const lc = addLive2dCharacter(dir, l2d, { name: 'L', persona: '' });
  assert.throws(() => replaceCharacterImage(dir, lc.id, b), /Live2D 캐릭터는/);
});

test('삭제: 폴더째 지움, 기본 캐릭터는 안 됨, 이상한 이름은 거부', () => {
  const { builtin, dir, id } = setup();
  assert.throws(() => deleteCharacter(dir, 'sample'), /기본 캐릭터는 삭제할 수 없습니다/);
  assert.ok(fs.existsSync(path.join(builtin, 'sample', 'character.svg')));
  for (const bad of ['../x', '..', '', '_live2d-template', '.hidden', 'a/b', '없는캐릭터']) assert.throws(() => characterPath(dir, bad), /잘못|찾지 못했/, bad);
  deleteCharacter(dir, id);
  assert.ok(!fs.existsSync(path.join(dir, id)));
  assert.throws(() => deleteCharacter(dir, id), /찾지 못했/);
});

test('삭제 뒤 캐릭터: 지금 것을 지우면 직전 → 없으면 기본, 다른 것을 지우면 그대로', () => {
  const has = (...ids: string[]) => (x: string) => ids.includes(x);
  assert.deepEqual(afterDelete('hana', 'dul', 'hana', has('dul', 'sample')), { character: 'dul', prevCharacter: '' });
  assert.deepEqual(afterDelete('hana', '', 'hana', has('sample')), { character: 'sample', prevCharacter: '' });
  assert.deepEqual(afterDelete('hana', 'gone', 'hana', has('sample')), { character: 'sample', prevCharacter: '' }); // 직전 것도 이미 없음
  assert.deepEqual(afterDelete('hana', 'dul', 'dul', has('hana', 'sample')), { character: 'hana', prevCharacter: '' }); // 직전 것을 지움 → 기억만 비움
  assert.deepEqual(afterDelete('hana', 'dul', 'set', has('hana', 'dul', 'sample')), { character: 'hana', prevCharacter: 'dul' });
});

test('설정: 직전 캐릭터 기본값', () => {
  assert.equal(normalize({}).prevCharacter, '');
  assert.equal(normalize({ prevCharacter: 3 }).prevCharacter, '');
  assert.equal(normalize({ prevCharacter: 'hana' }).prevCharacter, 'hana');
  assert.equal(normalize({ character: '' }).character, 'sample');
});

/* ---------------- 폴더 분리: 기본 캐릭터(읽기 전용) / 내가 추가한 캐릭터 ---------------- */

const snapshot = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((f) => {
      const p = path.join(dir, f);
      return `${f}:${fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : 'dir'}`;
    });

test('기본 캐릭터: 수정·그림 바꾸기·삭제 모두 거부되고 기본 폴더는 그대로', () => {
  const { builtin, dir, src } = setup();
  const before = snapshot(builtin);
  const b = path.join(src, 'b.png');
  fs.writeFileSync(b, 'B');
  assert.throws(() => updateCharacter(dir, 'sample', { name: '바꿈', persona: '' }), /기본 캐릭터는 이름·성격을 바꿀 수 없습니다/);
  assert.throws(() => replaceCharacterImage(dir, 'sample', b), /기본 캐릭터는 그림을 바꿀 수 없습니다/);
  assert.throws(() => deleteCharacter(dir, 'sample'), /기본 캐릭터는 삭제할 수 없습니다/);
  assert.throws(() => assertNotBuiltin('sample', '지울'), /기본 캐릭터는 지울 수 없습니다/);
  // 기본 폴더 경로를 실수로 넘겨도 삭제·수정은 안 된다 (id로 한 번 더 막음)
  assert.throws(() => deleteCharacter(builtin, 'sample'), /기본 캐릭터는/);
  assert.throws(() => updateCharacter(builtin, 'sample', { name: 'x', persona: '' }), /기본 캐릭터는/);
  assert.throws(() => replaceCharacterImage(builtin, 'sample', b), /기본 캐릭터는/);
  assert.deepEqual(snapshot(builtin), before);
});

test('새 캐릭터 폴더 이름은 내 폴더와 기본 폴더 이름을 모두 피한다', () => {
  const { builtin, dir, src } = setup();
  fs.mkdirSync(path.join(builtin, 'extra'));
  assert.equal(folderId('sample', dir, builtin), 'sample-2'); // 기본 캐릭터 이름
  assert.equal(folderId('extra', dir, builtin), 'extra-2'); // 기본 폴더에 있는 이름
  assert.equal(folderId('extra', dir), 'extra');
  const png = path.join(src, 'c.png');
  fs.writeFileSync(png, 'C');
  const c = addImageCharacter(dir, png, { name: 'sample', persona: '' }, builtin);
  assert.equal(c.id, 'sample-2');
  assert.ok(fs.existsSync(path.join(dir, 'sample-2', 'character.png')));
  assert.ok(!fs.existsSync(path.join(builtin, 'sample-2'))); // 새 캐릭터는 내 폴더에만 생김
});

test('캐릭터 목록: 기본(builtin 표시) + 내 것, 같은 이름은 기본이 이김, _로 시작하면 뺌', () => {
  const { builtin, dir } = setup();
  fs.mkdirSync(path.join(builtin, '_live2d-template'));
  fs.writeFileSync(path.join(builtin, '_live2d-template', 'config.json'), '{}');
  fs.mkdirSync(path.join(dir, 'sample')); // 내 폴더에 같은 이름
  fs.writeFileSync(path.join(dir, 'sample', 'config.json'), JSON.stringify({ name: '가짜 기본' }));
  const list = scanCharacterDirs(builtin, dir);
  assert.deepEqual(list.map((c) => [c.id, !!c.builtin]), [['sample', true], ['하나', false]]);
  assert.equal(list[0].config.name, '기본 비서');
  assert.deepEqual(scanCharacterDirs(path.join(builtin, 'none'), path.join(dir, 'none')), []); // 폴더가 없어도 오류 없음
});

test('그림 주소: 기본 캐릭터는 기본 폴더, 그 밖은 내 폴더, 이상한 이름은 내 폴더(읽기 검사는 protocol의 inside)', () => {
  const { builtin, dir, id } = setup();
  assert.equal(dirOfCharacter(builtin, dir, 'sample'), builtin);
  assert.equal(dirOfCharacter(builtin, dir, id), dir);
  assert.equal(dirOfCharacter(builtin, dir, '없음'), null);
  assert.equal(dirOfCharacter(builtin, dir, '../x'), null);
  assert.equal(dirForCharacterUrl(builtin, dir, 'sample/character.svg'), builtin);
  assert.equal(dirForCharacterUrl(builtin, dir, `${id}/character.png`), dir);
  assert.equal(dirForCharacterUrl(builtin, dir, '../etc/passwd'), dir);
  assert.equal(dirForCharacterUrl(builtin, dir, ''), dir);
});

test('설치본 예전 폴더 옮기기: 추가한 캐릭터만 복사, 원래 폴더와 기본 캐릭터는 그대로, 두 번째부터는 아무것도 안 함', () => {
  const old = tmp('old-');
  const mine = path.join(tmp('mine-'), 'my-characters');
  for (const id of ['sample', 'hana', '_live2d-template']) {
    fs.mkdirSync(path.join(old, id));
    fs.writeFileSync(path.join(old, id, 'config.json'), JSON.stringify({ name: id }));
  }
  fs.writeFileSync(path.join(old, 'hana', 'character.png'), 'png');
  fs.mkdirSync(path.join(old, 'noconfig'));
  const before = snapshot(old);
  assert.equal(migrateOldCharacters(old, mine), 1);
  assert.deepEqual(fs.readdirSync(mine), ['hana']);
  assert.equal(fs.readFileSync(path.join(mine, 'hana', 'character.png'), 'utf8'), 'png');
  assert.deepEqual(snapshot(old), before); // 지우지 않음
  fs.writeFileSync(path.join(mine, 'hana', 'config.json'), JSON.stringify({ name: '내가 고침' }));
  assert.equal(migrateOldCharacters(old, mine), 0); // 이미 my-characters가 있으면 덮어쓰지 않음
  assert.equal(JSON.parse(fs.readFileSync(path.join(mine, 'hana', 'config.json'), 'utf8')).name, '내가 고침');
  assert.equal(migrateOldCharacters(path.join(old, 'none'), path.join(tmp('x-'), 'my')), 0); // 예전 폴더가 없으면 빈 폴더만 만듦
});
