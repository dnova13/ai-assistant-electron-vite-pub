// 메신저로 보낸 파일: 기록(글 파일)과, 올린 날짜 기준으로 메신저 메시지를 지우기 위한 목록.
// - sent-files.txt: 보낸 시각, 이름, 크기, 원래 경로 (파일 내용은 남기지 않는다). 2MB가 넘으면 sent-files.1.txt로 넘긴다.
// - sent-messages.json: 지울 메시지 목록 (메신저, 대화방, 메시지 id, 올린 시각)
import fs from 'node:fs';
import path from 'node:path';
import { formatBytes } from '@shared/local-files';

export interface SentRecord {
  messenger: 'discord';
  channelId: string;
  messageId: string;
  sentAt: number;
  name: string;
}

export function createSentStore(dir: string, { maxLogBytes = 2 * 1024 * 1024 }: { maxLogBytes?: number } = {}) {
  const listFile = path.join(dir, 'sent-messages.json');
  const logFile = path.join(dir, 'sent-files.txt');
  let list: SentRecord[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(listFile, 'utf8')) as unknown;
    if (Array.isArray(raw)) list = raw.filter((x): x is SentRecord => !!x && typeof x === 'object' && typeof (x as SentRecord).messageId === 'string');
  } catch {
    /* 처음 */
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(listFile, JSON.stringify(list, null, 2), 'utf8');
  };

  return {
    logFile,
    /** 보낸 파일 한 건: 글 기록 + 지울 목록 */
    add(rec: SentRecord, info: { size: number; from: string }): void {
      list.push(rec);
      save();
      try {
        fs.mkdirSync(dir, { recursive: true });
        try {
          if (fs.statSync(logFile).size > maxLogBytes) fs.renameSync(logFile, logFile.replace(/\.txt$/, '.1.txt'));
        } catch {
          /* 아직 없음 */
        }
        const line = `${new Date(rec.sentAt).toISOString()}\t디스코드\t${rec.name}\t${formatBytes(info.size)} (${info.size}B)\t${info.from}\n`;
        fs.appendFileSync(logFile, line, 'utf8');
      } catch (e) {
        console.error('보낸 파일 기록 실패:', (e as Error).message);
      }
    },
    /** 올린 지 days일이 지난 것 */
    due(days: number, now = Date.now()): SentRecord[] {
      const limit = now - days * 86_400_000;
      return list.filter((r) => r.sentAt <= limit);
    },
    all: (): SentRecord[] => [...list],
    remove(ids: string[]): void {
      if (!ids.length) return;
      const set = new Set(ids);
      list = list.filter((r) => !set.has(r.messageId));
      save();
    },
    count: (): number => list.length
  };
}

export type SentStore = ReturnType<typeof createSentStore>;
