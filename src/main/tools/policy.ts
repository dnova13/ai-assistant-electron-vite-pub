// 파일 작업 안전 규칙. 어떤 경로를 만질 수 있는지는 전부 여기서 정한다.
// 문자열만 다루는 함수는 platform을 인자로 받아 맥·윈도우 규칙을 어디서든 시험할 수 있다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RootEntry, RootError } from '@shared/types';

export type Platform = NodeJS.Platform | string;

/** 검사를 통과한 허용 폴더 (real = 실제 위치) */
export interface Root extends RootEntry {
  real: string;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  ino: number;
}

export type Checked =
  | { ok: false; reason: string }
  | { ok: true; real: string; root: Root; rel: string; isDir: boolean; display: string; stat: FileStat };

export type CheckedNew =
  | { ok: false; reason: string }
  | { ok: true; real: string; root: Root; exists: boolean; existingIsDir?: boolean; display: string; dirReal: string };

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// 허용 폴더 안에 있어도 건드리지 않는 폴더 이름 (비밀 키, 저장소 내부 등)
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git', '.svn', '.password-store', 'keychains', '.config']);

// 열면 프로그램이 실행되거나 설치되는 확장자 → "열기"를 거부한다
const EXECUTABLE_EXT = new Set([
  '.app', '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.msc', '.scr', '.cpl', '.pif', '.lnk', '.url',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.reg', '.jar',
  '.sh', '.bash', '.zsh', '.csh', '.command', '.tool', '.scpt', '.applescript', '.workflow', '.terminal',
  '.pkg', '.mpkg', '.dmg', '.py', '.pyw', '.pl', '.rb', '.php', '.appref-ms', '.application', '.gadget',
  '.inf', '.webloc', '.desktop'
]);

export const nfc = (s: string): string => String(s).normalize('NFC');
const P = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);
// 맥(기본 APFS)과 윈도우는 대소문자를 구분하지 않는다
const foldCase = (platform: Platform) => platform === 'win32' || platform === 'darwin';
const key = (s: string, platform: Platform) => (foldCase(platform) ? nfc(s).toLowerCase() : nfc(s));

export function isInside(parent: string, child: string, platform: Platform = process.platform): boolean {
  const p = P(platform);
  const rel = p.relative(key(parent, platform), key(child, platform));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
}

// 새로 만들 파일·폴더 이름 검사 (복사·이동의 결과 이름)
export function checkName(name: string, platform: Platform = process.platform): string | null {
  if (typeof name !== 'string' || !name) return '이름이 비어 있습니다.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '이름에 제어 문자가 있습니다.';
  if (name === '.' || name === '..') return '쓸 수 없는 이름입니다.';
  if (name.includes('/')) return '이름에 / 를 쓸 수 없습니다.';
  if (platform === 'win32') {
    if (/[<>:"\\|?*]/.test(name)) return '윈도우에서 쓸 수 없는 문자(< > : " \\ | ? *)가 있습니다.';
    if (WIN_RESERVED.test(name)) return `윈도우 예약 이름(${name})이라 쓸 수 없습니다.`;
    if (/[. ]$/.test(name)) return '윈도우에서는 이름이 점이나 공백으로 끝날 수 없습니다.';
  }
  if (platform === 'darwin' && name.includes(':')) return '맥에서 : 는 쓸 수 없습니다.';
  return null;
}

// 경로 문자열 자체의 형식 검사
export function checkRawPath(p: string, platform: Platform = process.platform): string | null {
  if (typeof p !== 'string' || !p.trim()) return '경로가 비어 있습니다.';
  if (p.includes('\0')) return '잘못된 경로입니다.';
  if (!P(platform).isAbsolute(p)) return '전체 경로가 아닙니다.';
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(p)) return '네트워크(UNC)·장치 경로(\\\\?\\, \\\\.\\)는 쓸 수 없습니다.';
    if (!/^[a-zA-Z]:[\\/]/.test(p)) return 'C:\\ 처럼 드라이브 문자로 시작하는 경로만 쓸 수 있습니다.';
    if (p.slice(2).includes(':')) return '경로에 : 를 쓸 수 없습니다 (대체 데이터 스트림 차단).';
  }
  return null;
}

export function hasSensitiveSegment(rel: string, platform: Platform = process.platform): boolean {
  return rel.split(platform === 'win32' ? /[\\/]+/ : /\/+/).some((seg) => SENSITIVE_SEGMENTS.has(nfc(seg).toLowerCase()));
}

interface EnvOpts {
  platform?: Platform;
  home?: string;
  env?: Record<string, string | undefined>;
}

// 허용 폴더로 지정할 수 없는 곳: 디스크 루트, 홈 폴더 자체(와 그 위), 시스템 폴더
export function forbiddenRootReason(dir: string, { platform = process.platform, home = os.homedir(), env = process.env }: EnvOpts = {}): string | null {
  const p = P(platform);
  if (platform === 'win32' ? /^[a-zA-Z]:[\\/]?$/.test(dir) : dir === '/') return '디스크 전체는 허용 폴더로 지정할 수 없습니다.';
  if (isInside(dir, home, platform)) return '홈 폴더 전체나 그 위 폴더는 너무 넓어서 지정할 수 없습니다. 문서·다운로드처럼 좁은 폴더를 고르세요.';
  const system =
    platform === 'win32'
      ? [
          env.SystemRoot || 'C:\\Windows',
          env.ProgramFiles || 'C:\\Program Files',
          env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
          env.ProgramData || 'C:\\ProgramData',
          env.APPDATA,
          env.LOCALAPPDATA
        ].filter((x): x is string => !!x)
      : ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/opt', '/dev', '/proc', '/sys', '/boot', '/root',
         p.join(home, 'Library'), p.join(home, '.ssh'), p.join(home, '.config')];
  for (const s of system) if (isInside(s, dir, platform)) return `시스템 폴더(${s}) 안은 지정할 수 없습니다.`;
  return null;
}

/* ---------------- 실제 파일 시스템을 쓰는 부분 ---------------- */

const realpath = (p: string): string => fs.realpathSync.native(p);

// 허용 폴더 목록 검사. 잘못된 항목은 errors로 돌려준다.
export function validateRoots(list: unknown, opts: EnvOpts = {}): { roots: Root[]; errors: RootError[] } {
  const platform = opts.platform || process.platform;
  const roots: Root[] = [];
  const errors: RootError[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(list) ? (list as Partial<RootEntry>[]) : []) {
    const raw = item && typeof item.path === 'string' ? item.path : '';
    const label = (item && typeof item.label === 'string' && item.label.trim()) || path.basename(raw) || raw;
    const fail = (reason: string) => errors.push({ path: raw, label, reason });
    const rawErr = checkRawPath(raw, platform);
    if (rawErr) {
      fail(rawErr);
      continue;
    }
    let real: string;
    try {
      real = realpath(raw);
    } catch {
      fail('폴더가 없습니다.');
      continue;
    }
    if (!fs.statSync(real).isDirectory()) {
      fail('폴더가 아닙니다.');
      continue;
    }
    const why = forbiddenRootReason(real, { platform, home: opts.home, env: opts.env });
    if (why) {
      fail(why);
      continue;
    }
    const k = key(real, platform);
    if (seen.has(k)) continue;
    seen.add(k);
    const id = (item.id && String(item.id)) || `r${roots.length + 1}`;
    roots.push({ id, label, path: raw, real, remote: !!item.remote });
  }
  return { roots, errors };
}

export function findRoot(real: string, roots: Root[], platform: Platform = process.platform): Root | null {
  // 겹치는 허용 폴더가 있으면 가장 안쪽 것을 고른다
  let best: Root | null = null;
  for (const r of roots) {
    if (isInside(r.real, real, platform) && (!best || r.real.length > best.real.length)) best = r;
  }
  return best;
}

export function displayOf(root: Root, real: string): string {
  const rel = path.relative(root.real, real);
  return rel ? `${root.label}/${rel.split(path.sep).join('/')}` : root.label;
}

// 있는 경로를 검사한다. 심볼릭 링크는 실제 위치로 풀어서 본다 (링크로 밖을 가리키는 것 차단).
export function checkExisting(p: string, roots: Root[], platform: Platform = process.platform): Checked {
  const rawErr = checkRawPath(p, platform);
  if (rawErr) return { ok: false, reason: rawErr };
  let real: string;
  try {
    real = realpath(p);
  } catch {
    return { ok: false, reason: '파일이나 폴더를 찾을 수 없습니다.' };
  }
  const root = findRoot(real, roots, platform);
  if (!root) return { ok: false, reason: '허용 폴더 밖이라 다룰 수 없습니다. 설정 > 파일 제어 > 허용 경로에서 허용 폴더를 확인하세요.' };
  const rel = path.relative(root.real, real);
  if (rel && hasSensitiveSegment(rel, platform)) return { ok: false, reason: '보호된 폴더(.ssh, .git, Library 등) 안이라 다룰 수 없습니다.' };
  const st = fs.lstatSync(real);
  return { ok: true, real, root, rel, isDir: st.isDirectory(), display: displayOf(root, real), stat: { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } };
}

// 아직 없는 경로(복사·이동 결과)를 검사한다. 부모 폴더는 있어야 한다.
export function checkNew(dir: string, name: string, roots: Root[], platform: Platform = process.platform): CheckedNew {
  const nameErr = checkName(name, platform);
  if (nameErr) return { ok: false, reason: nameErr };
  const d = checkExisting(dir, roots, platform);
  if (!d.ok) return d;
  if (!d.isDir) return { ok: false, reason: '대상이 폴더가 아닙니다.' };
  const target = path.join(d.real, name);
  let exists = false;
  try {
    fs.lstatSync(target);
    exists = true;
  } catch {
    /* 없음 */
  }
  if (exists) {
    const t = checkExisting(target, roots, platform);
    if (!t.ok) return t;
    return { ok: true, real: t.real, root: t.root, exists: true, existingIsDir: t.isDir, display: t.display, dirReal: d.real };
  }
  return { ok: true, real: target, root: d.root, exists: false, display: displayOf(d.root, target), dirReal: d.real };
}

export function isExecutableLike(real: string, platform: Platform = process.platform): boolean {
  const ext = path.extname(real).toLowerCase();
  if (EXECUTABLE_EXT.has(ext)) return true;
  if (platform !== 'win32') {
    try {
      const st = fs.statSync(real);
      if (st.isFile() && st.mode & 0o111) return true; // 실행 권한이 있는 파일 (스크립트 포함)
    } catch {
      return true;
    }
  }
  return false;
}
