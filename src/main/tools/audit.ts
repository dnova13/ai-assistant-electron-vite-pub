// 실행 기록: 한 줄에 JSON 하나 (actions.jsonl). 2MB가 넘으면 actions.1.jsonl로 넘기고 새로 쓴다.
import fs from 'node:fs';
import path from 'node:path';

export interface Audit {
  file: string;
  log(entry: Record<string, unknown>): void;
}

export function createAudit(file: string, { maxBytes = 2 * 1024 * 1024 }: { maxBytes?: number } = {}): Audit {
  return {
    file,
    log(entry) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
        } catch {
          /* 아직 파일 없음 */
        }
        fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n', 'utf8');
      } catch (e) {
        console.error('실행 기록 실패:', (e as Error).message);
      }
    }
  };
}
