// 로컬 컨트롤에서 앱(메인·화면)과 시험이 같이 쓰는 값: 확인 문구, 기간의 범위, 같은 이름 처리, 받은 파일의 실행 파일 판별.
import type { ActionName, FilesSettings, RemoteSettings, RootEntry } from './types';

/* ---------------- 확인 문구 (앱과 메신저가 같다) ---------------- */

/** 동작별 확인 질문. 삭제는 두 번 묻는다. 빈 배열 = 확인 없이 바로 실행 */
export const CONFIRM_QUESTIONS: Record<ActionName, string[]> = {
  'file.search': [],
  'file.open': [],
  'file.reveal': [],
  'file.mkdir': [],
  'file.create': [],
  'file.list': [],
  'file.send': [],
  'file.move': ['이동하겠습니까?'],
  'file.copy': ['복사하겠습니까?'],
  'file.rename': ['이름을 바꾸겠습니까?'],
  'file.backup': ['백업하겠습니까?'],
  'file.delete': ['삭제하겠습니까?', '정말로 삭제하겠습니까?']
};

/** 찾기·목록 결과의 첫 줄 (앱과 메신저가 같다) */
export function resultHead(r: { query: string; items: unknown[]; list?: boolean; rootList?: boolean }): string {
  const n = r.items.length;
  if (r.rootList) return n ? `허용 폴더 목록 ${n}개` : '허용 폴더가 없습니다.';
  if (r.list) return n ? `'${r.query}' 목록 ${n}개` : `'${r.query}' 폴더가 비어 있습니다.`;
  return n ? `'${r.query}' 찾기 결과 ${n}개` : `'${r.query}'이(가) 들어간 파일이 허용 폴더에 없습니다.`;
}

/** 삭제가 끝나면 이 말만 알린다 (`_to_delete/` 위치는 적지 않는다) */
export const DELETED_TEXT = '삭제했습니다.';

/** 삭제한 파일을 모아 두는 폴더 (허용 폴더마다 맨 위에 하나) */
export const TRASH_DIR = '_to_delete';
/** 백업 폴더 이름 (백업할 파일이 있는 폴더 안) */
export const BACKUP_DIR = 'backup';
/** 받은 파일 기본 폴더 이름 (다운로드 폴더 아래) */
export const RECEIVED_DIR_NAME = 'AI비서 받은 파일';

/* ---------------- 기간 ---------------- */

/** `_to_delete/` 자동 비우기, 보낸 파일 메시지 자동 삭제: 일(day) */
export const DAYS = { min: 1, def: 30, max: 365 };
/** 잠금 해제 시간: 분(minute). 최소 10분, 최대 90일, 기본 30일 */
export const UNLOCK_MIN = { min: 10, def: 30 * 24 * 60, max: 90 * 24 * 60 };

const clampInt = (v: unknown, r: { min: number; def: number; max: number }): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : r.def;
};
export const normalizeDays = (v: unknown): number => clampInt(v, DAYS);
export const normalizeUnlockMinutes = (v: unknown): number => clampInt(v, UNLOCK_MIN);

/** 분을 "30일", "2시간 30분"처럼 */
export function formatMinutes(min: number): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d}일` : '', h ? `${h}시간` : '', m ? `${m}분` : ''].filter(Boolean).join(' ') || '0분';
}

/* ---------------- 설정 기본값 ---------------- */

export function defaultFiles(): FilesSettings {
  // 임시값: _to_delete는 처음에 직접 관리 (앱이 지우지 않음)
  return { trashMode: 'manual', trashDays: DAYS.def, receivedDir: '' };
}

export function normalizeFiles(raw: unknown): FilesSettings {
  const d = defaultFiles();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<FilesSettings>;
  return {
    trashMode: r.trashMode === 'auto' ? 'auto' : 'manual',
    trashDays: normalizeDays(r.trashDays ?? d.trashDays),
    receivedDir: typeof r.receivedDir === 'string' ? r.receivedDir.trim() : ''
  };
}

export function defaultRemote(): RemoteSettings {
  return { enabled: false, discord: { apiKey: '', userId: '' }, unlockMinutes: UNLOCK_MIN.def, sentDeleteDays: DAYS.def };
}

export function normalizeRemote(raw: unknown): RemoteSettings {
  const d = defaultRemote();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RemoteSettings>;
  const dc = (r.discord && typeof r.discord === 'object' ? r.discord : {}) as Partial<RemoteSettings['discord']>;
  return {
    enabled: r.enabled === true,
    discord: {
      apiKey: typeof dc.apiKey === 'string' ? dc.apiKey.trim() : '',
      userId: typeof dc.userId === 'string' ? dc.userId.replace(/\D/g, '') : ''
    },
    unlockMinutes: normalizeUnlockMinutes(r.unlockMinutes ?? d.unlockMinutes),
    sentDeleteDays: normalizeDays(r.sentDeleteDays ?? d.sentDeleteDays)
  };
}

/* ---------------- 날짜·같은 이름 ---------------- */

const pad = (n: number) => String(n).padStart(2, '0');
/** 2026-10-21 (이 컴퓨터 시각) */
export const dateStr = (t: number | Date = Date.now()): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** 081430 (시·분·초) */
export const timeStr = (t: number | Date = Date.now()): string => {
  const d = new Date(t);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

/** 이름을 이름 부분과 확장자로 (폴더는 확장자 없음) */
export function splitName(name: string, isDir = false): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: '' };
  const i = name.lastIndexOf('.');
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i) } : { stem: name, ext: '' };
}

/**
 * 같은 이름이 있으면 덮어쓰지 않을 새 이름. 날짜를 붙이고, 그래도 겹치면 번호를 붙인다.
 * 보고서.pdf → 보고서 2026-10-21.pdf → 보고서 2026-10-21 (2).pdf
 * withDate=false면 처음부터 날짜를 붙이지 않고 비어 있으면 그대로 쓴다.
 */
export function uniqueName(name: string, exists: (n: string) => boolean, opts: { isDir?: boolean; stamp?: string; always?: boolean } = {}): string {
  if (!opts.always && !exists(name)) return name;
  const { stem, ext } = splitName(name, opts.isDir);
  const base = `${stem} ${opts.stamp || dateStr()}`;
  let cand = `${base}${ext}`;
  for (let i = 2; exists(cand); i++) cand = `${base} (${i})${ext}`;
  return cand;
}

/* ---------------- 받은 파일 ---------------- */

/** 받은 파일에서 실행 파일로 보는 확장자 (사용자 결정, 고정). 맨 끝 확장자로 판단 */
export const RECEIVED_EXEC_EXT = [
  '.exe', '.msi', '.com', '.scr',
  '.bat', '.cmd', '.ps1', '.vbs', '.wsf',
  '.app', '.dmg', '.pkg', '.command',
  '.sh',
  '.js', '.py', '.jar',
  '.lnk', '.reg', '.inf'
];

export const RECEIVED_EXEC_WARNING = '프로그램 파일이라 앱에서 열지 않습니다. 폴더 열기로 위치만 확인하세요.';

export function isReceivedExecutable(name: string): boolean {
  const n = String(name).trim().toLowerCase();
  const i = n.lastIndexOf('.');
  return i >= 0 && RECEIVED_EXEC_EXT.includes(n.slice(i));
}

/** 1234567 → 1.2MB */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 설정에 저장할 허용 폴더 값 (원격 허용 체크 포함) */
export const rootsToSave = (roots: RootEntry[]): RootEntry[] => roots.map(({ id, label, path, remote }) => ({ id, label, path, remote: !!remote }));
