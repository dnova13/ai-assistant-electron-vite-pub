// 실제 이름의 사전 발음을 한글 자모와 비교한다. 단어별 한글 별칭을 만들지 않는다.
import { disassembleToGroups } from 'es-hangul';
import type { FileNameMatcher } from '@shared/file-names';

// 영어 발음 기호에 대한 공통 대응이다. 한국어에서 구분이 약한 자음은 비교용으로 합친다.
const SOUNDS: Record<string, string[]> = {
  AA: ['ㅏ'], AE: ['ㅔ'], AH: ['ㅓ', ''], AO: ['ㅗ'], AW: ['ㅏㅜ'], AY: ['ㅏㅣ'],
  EH: ['ㅔ'], ER: ['ㅓㄹ', 'ㅓ'], EY: ['ㅔㅣ', 'ㅔ'], IH: ['ㅣ'], IY: ['ㅣ'],
  OW: ['ㅗ', 'ㅗㅜ'], OY: ['ㅗㅣ'], UH: ['ㅜ'], UW: ['ㅜ'],
  B: ['ㅂ'], CH: ['ㅈ'], D: ['ㄷ'], DH: ['ㄷ'], F: ['ㅂ'], G: ['ㄱ'], HH: ['ㅎ'],
  JH: ['ㅈ'], K: ['ㄱ'], L: ['ㄹ'], M: ['ㅁ'], N: ['ㄴ'], NG: ['ŋ'], P: ['ㅂ'],
  R: ['ㄹ'], S: ['ㅅ'], SH: ['ㅅㅣ', 'ㅅ'], T: ['ㄷ'], TH: ['ㅅ'], V: ['ㅂ'],
  W: ['ㅜ'], Y: ['ㅣ'], Z: ['ㅈ', 'ㅅ'], ZH: ['ㅈ']
};
const JAMO: Record<string, string> = {
  ㄲ: 'ㄱ', ㅋ: 'ㄱ', ㄸ: 'ㄷ', ㅌ: 'ㄷ', ㅃ: 'ㅂ', ㅍ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ', ㅊ: 'ㅈ',
  ㅐ: 'ㅔ', ㅒ: 'ㅣㅔ', ㅖ: 'ㅣㅔ', ㅑ: 'ㅣㅏ', ㅕ: 'ㅣㅓ', ㅛ: 'ㅣㅗ', ㅠ: 'ㅣㅜ',
  ㅘ: 'ㅜㅏ', ㅙ: 'ㅜㅔ', ㅚ: 'ㅜㅔ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅣ', ㅡ: ''
};
const MAX_FORMS = 64;
let dictionaryPromise: Promise<Record<string, string>> | undefined;
const wordCache = new Map<string, string[]>();
const phraseCache = new Map<string, string[]>();
const cached = (cache: Map<string, string[]>, key: string, forms: string[]) => {
  if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
  cache.set(key, forms);
  return forms;
};
const join = (left: string[], right: string[]) => [...new Set(left.flatMap((l) => right.map((r) => l + r)))].slice(0, MAX_FORMS);
const compact = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s_.-]+/g, '');
const splitExt = (s: string) => {
  const m = /^(.*)(\.[a-z][a-z0-9]{0,7})$/i.exec(s);
  return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: s, ext: '' };
};
function tokens(s: string): string[] {
  return s.normalize('NFC').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+(?:'[a-z]+)?|[가-힣]+|\d+/g) || [];
}
function korean(s: string): string {
  return disassembleToGroups(s).map((group) => group.map((j, i) => {
    if (j === 'ㅇ') return i === 0 ? '' : 'ŋ';
    return JAMO[j] ?? j;
  }).join('')).join('');
}
function wordForms(word: string, dict: Record<string, string>): string[] {
  const found = wordCache.get(word);
  if (found) return found;
  if (/^[가-힣]+$/.test(word)) return cached(wordCache, word, [korean(word)]);
  if (/^\d+$/.test(word)) return [`#${word}#`];
  const pronunciations: string[] = [];
  if (Object.hasOwn(dict, word)) pronunciations.push(dict[word]);
  for (let i = 2; i <= 9; i++) if (Object.hasOwn(dict, `${word}(${i})`)) pronunciations.push(dict[`${word}(${i})`]);
  const all: string[] = [];
  for (const pronunciation of pronunciations) {
    const phones = pronunciation.split(' ').map((p) => p.replace(/\d/g, ''));
    let forms = [''];
    for (let i = 0; i < phones.length; i++) {
      const phone = phones[i];
      let values = SOUNDS[phone];
      if (!values) { forms = []; break; }
      // 자음 앞·단어 끝의 r은 영어 발음 차이를 고려한다.
      if (phone === 'R' && i > 0 && /^[AEIOU]/.test(phones[i - 1]) && (!phones[i + 1] || !/^[AEIOU]/.test(phones[i + 1]))) values = ['ㄹ', ''];
      forms = join(forms, values);
    }
    all.push(...forms);
  }
  return cached(wordCache, word, [...new Set(all)].slice(0, MAX_FORMS));
}
function phraseForms(parts: string[], dict: Record<string, string>): string[] {
  const key = parts.join(' ');
  const found = phraseCache.get(key);
  if (found) return found;
  let forms = [''];
  for (const part of parts) {
    forms = join(forms, wordForms(part, dict));
    if (!forms.length) break; // 사전에 없는 단어를 건너뛰어 엉뚱한 구절과 맞추지 않는다.
  }
  return cached(phraseCache, key, forms.filter(Boolean));
}
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  // 짧은 이름은 한 자음만 달라도 다른 이름이다. 긴 구절만 작은 인식 차이를 허용한다.
  const max = Math.max(a.length, b.length);
  return max >= 8 && Math.abs(a.length - b.length) <= 1 && distance(a, b) <= 1;
}

/** 서버·모델을 호출하지 않는다. 원래 글자로 찾은 이름도 포함하며 확장자는 따로 검사한다. */
export const matchLocalFileNames: FileNameMatcher = async (query, candidates) => {
  const dict = await (dictionaryPromise ??= import('cmu-pronouncing-dictionary').then((m) => m.dictionary));
  const q = splitExt(query.normalize('NFC').trim());
  const qparts = tokens(q.base);
  const qforms = phraseForms(qparts, dict);
  const ids: string[] = [];
  for (const candidate of candidates) {
    const c = splitExt(candidate.name.normalize('NFC'));
    if (q.ext && q.ext !== c.ext) continue;
    if (compact(q.base) && compact(c.base).includes(compact(q.base))) { ids.push(candidate.id); continue; }
    const parts = tokens(c.base);
    const numbers = qparts.filter((p) => /^\d+$/.test(p));
    if (numbers.some((n) => !parts.includes(n))) continue; // 연도·번호를 비슷한 발음으로 보정하지 않는다.
    let matches = false;
    // 부분 이름도 받되 단어 중간의 임의 발음 조각으로는 찾지 않는다.
    for (let start = 0; start < parts.length && !matches; start++) {
      for (let end = start + 1; end <= Math.min(parts.length, start + 8) && !matches; end++) {
        const forms = phraseForms(parts.slice(start, end), dict);
        matches = qforms.some((a) => forms.some((b) => alike(a, b)));
      }
    }
    if (matches) ids.push(candidate.id);
  }
  return ids;
};
