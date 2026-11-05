// 로컬 파일 관리: 받은 파일 폴더(기본: 다운로드/AI비서 받은 파일, 자동으로 허용 폴더), 삭제한 파일(_to_delete) 자동 비우기.
import fs from 'node:fs';
import path from 'node:path';
import type { FilesSettings, RootEntry } from '@shared/types';
import { RECEIVED_DIR_NAME, TRASH_DIR, dateStr } from '@shared/local-files';
import type { Root } from './tools/policy';

export const RECEIVED_ROOT_ID = 'received';
export const RECEIVED_ROOT_LABEL = '받은 파일';

/** 받은 파일 폴더 (설정이 비었으면 다운로드 폴더 아래 기본 폴더). downloadsDir = OS가 알려 준 이 사용자의 다운로드 폴더 */
export function receivedDir(files: Pick<FilesSettings, 'receivedDir'>, downloadsDir: string): { path: string; isDefault: boolean; defaultPath: string } {
  const defaultPath = path.join(downloadsDir, RECEIVED_DIR_NAME);
  const custom = (files.receivedDir || '').trim();
  return custom ? { path: custom, isDefault: false, defaultPath } : { path: defaultPath, isDefault: true, defaultPath };
}

/** 받은 파일 폴더를 만들고 허용 폴더 항목으로 돌려준다 (자동 허용). 만들 수 없으면 null */
export function receivedRootEntry(dir: string): RootEntry | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  return { id: RECEIVED_ROOT_ID, label: RECEIVED_ROOT_LABEL, path: dir };
}

/** 열어도 되는 허용 폴더인지 본다. 저장된 목록에 있고 실제 폴더여야 한다. 없는 폴더를 새로 만들지 않는다 */
export function allowedRootDir(target: unknown, roots: Pick<RootEntry, 'path'>[]): string {
  const dir = typeof target === 'string' ? target : '';
  if (!roots.some((r) => r.path === dir)) throw new Error('저장한 뒤에 열 수 있습니다.');
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // 없는 경로는 아래에서 같은 오류로 알린다
  }
  if (!isDir) throw new Error(`폴더를 찾을 수 없습니다: ${dir}`);
  return dir;
}

/**
 * 자동 비우기: 허용 폴더마다 _to_delete/<날짜>/ 중 days일이 지난 날짜 폴더를 지운다 (진짜로 지움).
 * 날짜 이름이 아닌 폴더·파일은 건드리지 않는다. 지운 날짜 폴더 수를 돌려준다.
 */
export function emptyTrash(roots: Root[], days: number, now = Date.now()): number {
  const limit = dateStr(now - days * 86_400_000); // 이 날짜 이하(포함)면 지운다
  let removed = 0;
  for (const r of roots) {
    const dir = path.join(r.real, TRASH_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n) || n > limit) continue;
      const full = path.join(dir, n);
      try {
        if (!fs.lstatSync(full).isDirectory()) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch (e) {
        console.error('비우기 실패:', full, (e as Error).message);
      }
    }
  }
  return removed;
}
