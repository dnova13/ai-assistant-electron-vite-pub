// tools/mock-server.js (가짜 비서 서버) 타입. 시험에서 불러 쓴다.
import type { Server } from 'node:http';
export const server: Server;
export function makeWav(text: string): Buffer;
