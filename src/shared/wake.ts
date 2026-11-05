// 호출어: 설정 기본값·정리, 받아 적은 글이 호출어로 시작하는지 비교. 메인과 화면이 같이 쓴다.
import type { VadSettings, WakeSettings } from './types';
import { VAD_LIMITS } from './voice';
import { LOCAL_MODELS } from './stt';
import type { LocalSttModel } from './types';

/** 호출어를 들었을 때 하는 말 (음성 파일이 없을 때 TTS로 읽거나 말풍선에 보여 준다) */
export const WAKE_ACK_TEXT = '네, 말씀하세요.';

/** 호출어 기본 모델: tiny는 짧은 한국어 이름을 자주 틀려서 small */
export const WAKE_DEFAULT_MODEL: LocalSttModel = 'small';

export function defaultWake(): WakeSettings {
  return { enabled: false, name: '', ackFile: '', model: WAKE_DEFAULT_MODEL, noiseDb: null, marginDb: VAD_LIMITS.marginDefault };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 호출어 설정 정리. 소음·말소리 기준(noiseDb, marginDb)은 예전에는 음성 대화와 하나였다:
 * 호출어 설정에 아직 없으면 그때의 음성 대화 값(inherit)을 처음 한 번 복사한다. 그 뒤로는 따로 간다.
 */
export function normalizeWake(raw: unknown, inherit?: Pick<VadSettings, 'noiseDb' | 'marginDb'>): WakeSettings {
  const r = isObj(raw) ? raw : {};
  const d = defaultWake();
  const nz = 'noiseDb' in r ? r.noiseDb : inherit ? inherit.noiseDb : d.noiseDb;
  const mg = 'marginDb' in r ? r.marginDb : inherit ? inherit.marginDb : d.marginDb;
  const num = (v: unknown, def: number, lo: number, hi: number): number => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const file = typeof r.ackFile === 'string' ? r.ackFile.trim() : '';
  return {
    enabled: r.enabled === true,
    name: typeof r.name === 'string' ? r.name.trim().slice(0, 20) : '',
    // 앱이 사용자 데이터 폴더의 sounds/ 에 복사해 둔 파일 이름만 (경로는 받지 않는다)
    ackFile: /^[\w.-]{1,64}$/.test(file) && !file.startsWith('.') ? file : '',
    model: (LOCAL_MODELS as unknown[]).includes(r.model) ? (r.model as LocalSttModel) : WAKE_DEFAULT_MODEL,
    noiseDb: nz === null || nz === undefined || nz === '' || !Number.isFinite(Number(nz)) ? null : Math.round(num(nz, -60, VAD_LIMITS.noiseMin, VAD_LIMITS.noiseMax)),
    marginDb: Math.round(num(mg, d.marginDb, VAD_LIMITS.marginMin, VAD_LIMITS.marginMax))
  };
}

/** 비교용: 소문자, 글자·숫자만 */
export const normWake = (s: string): string =>
  String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

function edits(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// 한글을 초성·중성·종성 자모로 쪼갠다 (위스퍼가 "짱구"를 "장구"처럼 자모 하나만 다르게 적는 것을 알아보려고)
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];

/** 글자 하나를 [초성, 중성, 종성]으로 (한글 글자가 아니면 그대로 하나) */
function jamoOf(ch: string): string[] {
  const c = ch.codePointAt(0)! - 0xac00;
  if (c < 0 || c > 11171) return [ch];
  const out = [CHO[Math.floor(c / 588)], JUNG[Math.floor((c % 588) / 28)]];
  if (c % 28) out.push(JONG[c % 28]);
  return out;
}

/** 소리가 가까워 서로 헷갈리는 자모 (평음·경음·격음, 모음 일부). 이런 바꿔치기는 반만 틀린 것으로 센다 */
const NEAR = ['ㄱㄲㅋ', 'ㄷㄸㅌ', 'ㅂㅃㅍ', 'ㅈㅉㅊ', 'ㅅㅆ', 'ㅐㅔ', 'ㅒㅖ', 'ㅗㅜ', 'ㅡㅜ'];
const subCost = (a: string, b: string): number => (a === b ? 0 : NEAR.some((g) => g.includes(a) && g.includes(b)) ? 0.5 : 1);

/** 두 글을 자모 단위로 비교한 거리 (가까운 자모 바꿔치기 0.5, 나머지 1) */
export function jamoDistance(a: string, b: string): number {
  const x = [...a].flatMap(jamoOf);
  const y = [...b].flatMap(jamoOf);
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(x[i - 1], y[j - 1]));
  return d[x.length][y.length];
}

/** 호출어 앞에 붙어도 되는 짧은 말 ("아 루나야", "저기 루나") */
const FILLERS = ['', '아', '어', '야', '음', '저기', '저기요', '헤이', '오케이', 'hey', 'ok', 'okay', 'hi'];

/**
 * 받아 적은 글이 호출어로 시작하는지. 앞에 "아", "저기" 같은 짧은 말은 붙어도 되지만,
 * 문장 중간에 이름이 나오는 것("나는 루나를 좋아해")은 호출이 아니다.
 * 이름이 3글자 이상이면 한 글자 틀린 것도 받는다 (위스퍼가 이름을 조금 다르게 적을 때).
 * 소리가 가까운 자모 하나(ㅈ/ㅉ, ㅗ/ㅜ 등)가 다른 것은 2글자 이름도 받는다.
 */
export function matchWake(text: string, name: string): boolean {
  if (matchStart(normWake(text), normWake(name))) return true;
  // "윤나야, 짱구야!"처럼 다른 이름을 부르는 말("~야/아")이 먼저 나오고 바로 뒤에 이름이 오는 경우
  const words = String(text || '').split(/[\s,.!?~·…]+/).filter(Boolean);
  const first = normWake(words[0] || '');
  return words.length >= 2 && [...first].length <= 4 && /[야아여]$/.test(first) && matchStart(normWake(words[1]), normWake(name));
}

/** 받아 적은 글(정리한 것)이 이름으로 시작하는지 */
function matchStart(t: string, n: string): boolean {
  if (!n || !t) return false;
  for (const f of FILLERS) {
    if (!t.startsWith(f)) continue;
    const head = t.slice(f.length, f.length + n.length);
    if (head === n) return true;
    if ([...n].length >= 3 && head.length === n.length && edits(head, n) <= 1) return true;
    // 소리가 가까운 자모 하나가 다르게 적힌 것 (짱구→장구, 미르→미루). 2글자 이름은 반 칸(가까운 자모 하나)만, 3글자 이상은 한 칸까지
    if (head.length === n.length && jamoDistance(head, n) <= ([...n].length >= 3 ? 1 : 0.5)) return true;
  }
  return false;
}

/** 실제로 쓸 호출어: 설정의 이름 → 비었으면 캐릭터 이름 */
export function wakeName(s: WakeSettings, characterName: string): string {
  return s.name || String(characterName || '').trim();
}

/** 호출어 받아 적기에 쓸 앱 안 위스퍼 모델: 고른 모델을 받아 뒀으면 그것, 아니면 받아 둔 것 중 가장 작은 것 */
export function wakeModel(downloaded: LocalSttModel[], preferred?: LocalSttModel): LocalSttModel | null {
  if (preferred && downloaded.includes(preferred)) return preferred;
  return LOCAL_MODELS.find((m) => downloaded.includes(m)) || null;
}

/** 고른 모델을 받아 두지 않아 다른 모델로 듣고 있으면 그 안내 (아니면 null) */
export function wakeModelNote(s: WakeSettings, downloaded: LocalSttModel[]): string | null {
  const used = wakeModel(downloaded, s.model);
  if (!used || used === s.model) return null;
  return `호출어 모델 ${s.model}을(를) 받아 두지 않아 ${used}(으)로 듣습니다. 설정 > 음성 > 음성 인식 > 이 컴퓨터에서 ${s.model}을(를) 받으면 더 잘 알아듣습니다.`;
}

/** 지금 호출어를 쓸 수 없는 이유 (쓸 수 있으면 null) */
export function wakeBlocked(s: WakeSettings, characterName: string, downloaded: LocalSttModel[]): string | null {
  if (!wakeModel(downloaded)) return '이 컴퓨터(앱 안) 위스퍼 모델이 없습니다. 설정 > 음성 > 음성 인식 > 이 컴퓨터에서 모델을 먼저 받으세요 (tiny나 base 권장).';
  if (!normWake(wakeName(s, characterName))) return '호출어 이름이 없습니다. 설정 > 캐릭터 > 프로필 > 목소리에서 호출어를 적으세요.';
  return null;
}
