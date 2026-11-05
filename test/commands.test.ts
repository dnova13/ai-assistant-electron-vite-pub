// 화면의 "파일 …" 명령 해석과 단축키 입력 변환
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeFileText, parseLocalCommand, tokenize } from '../src/shared/commands';
const transfer = (action: string, words: string[]) => ({ action, args: { target: words.join(' '), transferParts: words.map(text => ({ text, quoted: false })) } });
import { toAccelerator } from '../src/renderer/src/lib/accelerator';

test('파일 명령 해석', () => {
  assert.equal(parseLocalCommand('안녕'), null); // 파일 명령이 아니면 서버로
  assert.deepEqual(parseLocalCommand('파일 찾기 회의록'), { action: 'file.search', args: { query: '회의록' } });
  assert.deepEqual(parseLocalCommand('파일 열기 보고서.pdf'), { action: 'file.open', args: { target: '보고서.pdf' } });
  assert.deepEqual(parseLocalCommand('파일 이동 "회의 자료.pdf" 바탕화면'), { action: 'file.move', args: { target: '회의 자료.pdf 바탕화면', transferParts: [{ text: '회의 자료.pdf', quoted: true }, { text: '바탕화면', quoted: false }] } });
  assert.deepEqual(parseLocalCommand('파일 이동 보고서.pdf'), transfer('file.move', ['보고서.pdf'])); // 폴더가 없음
  assert.deepEqual(parseLocalCommand('파일 삭제 보고서.pdf'), { action: 'file.delete', args: { target: '보고서.pdf' } });
  assert.deepEqual(parseLocalCommand('파일 이름 보고서.pdf 최종.pdf'), { action: 'file.rename', args: { target: '보고서.pdf', name: '최종.pdf' } });
  assert.deepEqual(parseLocalCommand('파일 폴더 문서 2026'), { action: 'file.mkdir', args: { dest: '문서', name: '2026' } });
  assert.deepEqual(parseLocalCommand('파일 백업 "회의 자료.pdf"'), { action: 'file.backup', args: { target: '회의 자료.pdf' } });
  assert.deepEqual(parseLocalCommand('파일 보내기 보고서.pdf'), { action: 'file.send', args: { target: '보고서.pdf' } });
  assert.deepEqual(parseLocalCommand('파일 이름 보고서.pdf'), { help: true }); // 새 이름이 없음
  assert.deepEqual(tokenize(`a "b c" 'd e' “f g”`), ['a', 'b c', 'd e', 'f g']);
});

test('파일과 !파일은 정형 명령·도움말·자연어·질문을 동일하게 해석', () => {
  const move = transfer('file.move', ['메모.txt', '문서']);
  assert.deepEqual(parseLocalCommand('!파일 이동 메모.txt 문서'), move);
  assert.deepEqual(parseLocalCommand('파일 이동 메모.txt 문서'), move);
  for (const t of ['파일', '!파일', '파일 도움말', '!파일 도움말']) assert.deepEqual(parseLocalCommand(t), { help: true }, t);
  for (const t of ['파일 정리하는 법 알려줘', '파일 삭제하는 방법 알려줘', '파일 이동 방법 알려줘', '파일 찾기 어떻게 해?', '파일 열어줘', '파일 메모.txt 문서로 이동시켜줘', '파일들 찾아줘']) {
    assert.equal(parseLocalCommand(t), null, t);
    assert.equal(parseLocalCommand('!' + t), null, t);
  }
  assert.equal(parseLocalCommand('!파일 찾기 왜 설명서'), null);
  assert.deepEqual(parseLocalCommand('파일 찾기 "설명서"'), { action: 'file.search', args: { query: '설명서' } }); // 따옴표 안은 질문 검사 안 함
});

test('파일 명령: 새 동작과 같은 뜻의 말', () => {
  for (const v of ['생성', '생성해', '등록', '등록해', '추가', '추가해', '만들기', '만들어']) {
    assert.deepEqual(parseLocalCommand(`파일 ${v} 문서 메모`), { action: 'file.create', args: { dest: '문서', name: '메모' } });
    assert.deepEqual(parseLocalCommand(`!파일 ${v} 문서/2026 메모.txt`), { action: 'file.create', args: { dest: '문서/2026', name: '메모.txt' } });
    assert.deepEqual(parseLocalCommand(`파일 폴더 ${v} 문서 2026`), { action: 'file.mkdir', args: { dest: '문서', name: '2026' } });
  }
  assert.deepEqual(parseLocalCommand('파일 생성 메모'), { help: true }); // 위치가 없음
  assert.deepEqual(parseLocalCommand('파일 폴더 생성 2026'), { action: 'file.mkdir', args: { dest: '생성', name: '2026' } }); // 단어 둘은 기존 형식
  assert.deepEqual(parseLocalCommand('파일 목록 문서'), { action: 'file.list', args: { dest: '문서' } });
  assert.deepEqual(parseLocalCommand('파일 목록'), { action: 'file.list', args: {} });
  assert.deepEqual(parseLocalCommand('!파일 목록'), { action: 'file.list', args: {} });
  assert.deepEqual(parseLocalCommand('파일 보기 보고서.pdf'), { action: 'file.open', args: { target: '보고서.pdf' } });
  for (const v of ['이름변경', '이름수정']) assert.deepEqual(parseLocalCommand(`파일 ${v} a.txt b.txt`), { action: 'file.rename', args: { target: 'a.txt', name: 'b.txt' } });
  assert.deepEqual(parseLocalCommand('파일 이동 바탕화면 test 문서'), transfer('file.move', ['바탕화면', 'test', '문서']));
});

test('단축키 입력 변환: 맥은 Cmd, 윈도우는 Ctrl, 글자 하나는 거부', () => {
  const k = (code: string, m: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  assert.equal(toAccelerator(k('Space', { metaKey: true, shiftKey: true }), 'darwin'), 'CommandOrControl+Shift+Space');
  assert.equal(toAccelerator(k('Space', { ctrlKey: true, shiftKey: true }), 'win32'), 'CommandOrControl+Shift+Space');
  assert.equal(toAccelerator(k('KeyM'), 'win32'), null);
  assert.equal(toAccelerator(k('F9'), 'win32'), 'F9');
});


test('파일 접두어만 통일하고 자연어 위치·새 이름·다른 명령은 보존한다', () => {
  for (const body of ['테스트에 메모ㄴㄹㄴ 만들어줘', 'test 에서 메모 추가해', '문서에 메모.txt 등록해줘', '할일.txt에 내용 추가해', '없는동작 a', '찾기 "설명서"', '생성 문서 메모.md', '이동 a', '도움말', '']) {
    const plain = `파일 ${body}`.trim();
    assert.equal(normalizeFileText(`  !${plain}  `), plain);
    assert.deepEqual(parseLocalCommand('!' + plain), parseLocalCommand(plain), body);
  }
  for (const text of ['!파일함', '!메모 추가 a', '메모 !파일', '!파일test', '!!파일 찾기 a']) {
    assert.equal(normalizeFileText(text), text);
    assert.equal(parseLocalCommand(text), null);
  }
  assert.equal(parseLocalCommand('!파일 테스트에 메모ㄴㄹㄴ 만들어줘'), null);
});
