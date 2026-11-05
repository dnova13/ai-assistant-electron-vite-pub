// 캐릭터별 대화 기록. 사용자 데이터 폴더/history/<캐릭터>.json
// - 화면: 캐릭터를 바꾸면 그 캐릭터와 나눈 대화를 다시 보여 준다
// - Ollama 직접 모드: 이 기록이 모델에 보내는 대화 기억이 된다 (비서 서버 모드에서는 서버가 session별로 기억)
// - 지우기: 파일을 삭제하지 않고 history/_to_delete/ 로 옮긴다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HistoryMessage } from '@shared/types';

const ROLES = new Set(['user', 'bot', 'sys', 'err']);

const isMessage = (m: unknown): m is HistoryMessage =>
  !!m && typeof m === 'object' && ROLES.has((m as HistoryMessage).role) && typeof (m as HistoryMessage).text === 'string';

export function createHistory(dir: string, { max = 200 }: { max?: number } = {}) {
  // 캐릭터 id는 폴더 이름이지만, 파일 이름으로 쓰기 전에 안전한 글자만 남긴다
  const fileOf = (id: string): string => {
    const s = String(id || 'default');
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : `c_${crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)}`;
    return path.join(dir, `${safe}.json`);
  };

  const cleanMessage = (m: HistoryMessage): HistoryMessage => ({
    role: m.role, text: m.text.slice(0, 20000),
    ...(typeof m.id === 'string' && m.id.length <= 200 ? { id: m.id } : {}),
    ...(typeof m.time === 'string' && Number.isFinite(Date.parse(m.time)) ? { time: m.time } : {}),
    ...(typeof m.source === 'string' ? { source: m.source.slice(0, 64) } : {}),
    ...(m.tone === 'error' ? { tone: 'error' as const } : {}),
    ...(typeof m.memory === 'boolean' ? { memory: m.memory } : {}),
    ...(Array.isArray(m.results) ? { results: m.results.filter(x => x && typeof x.path === 'string' && typeof x.display === 'string').slice(0, 128) } : {})
  });

  function load(id: string): HistoryMessage[] {
    try {
      const data = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
      return Array.isArray(data.messages) ? data.messages.filter(isMessage).map(cleanMessage) : [];
    } catch {
      return [];
    }
  }

  function write(id: string, messages: HistoryMessage[]): void {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileOf(id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ character: String(id), messages }, null, 1), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function append(id: string, entries: unknown): number {
    const clean = (Array.isArray(entries) ? entries : [])
      .filter((m): m is HistoryMessage => isMessage(m) && !!m.text.trim())
      .map((m) => cleanMessage({ ...m, id: m.id || crypto.randomUUID(), time: m.time || new Date().toISOString() }));
    if (!clean.length) return load(id).length;
    const all = load(id);
    for (const message of clean) {
      const index = message.id ? all.findIndex(m => m.id === message.id) : -1;
      if (index < 0) all.push(message); else all[index] = message;
    }
    all.sort((a, b) => (Date.parse(a.time || '') || 0) - (Date.parse(b.time || '') || 0));
    if (all.length > max) all.splice(0, all.length - max);
    write(id, all);
    return all.length;
  }

  // 지우기 = 삭제 대신 _to_delete 폴더로 옮기기. 옮긴 경로를 돌려준다 (없으면 null)
  function clear(id: string): string | null {
    const file = fileOf(id);
    if (!fs.existsSync(file)) return null;
    const bin = path.join(dir, '_to_delete');
    fs.mkdirSync(bin, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(bin, `${path.basename(file, '.json')}-${stamp}.json`);
    fs.renameSync(file, dest);
    return dest;
  }

  return { load, append, clear, dir };
}

export type History = ReturnType<typeof createHistory>;
