// app://local/... 프로토콜. 화면 파일, 캐릭터 파일, Live2D 라이브러리를 이 주소로만 내보낸다.
// file:// 대신 쓰는 이유
//  - 맥(/Users/...)과 윈도우(C:\...) 경로 차이, 한글·공백 경로 인코딩 문제가 사라진다
//  - Live2D 모델(JSON, 텍스처)을 fetch/XHR로 읽을 수 있다 (file://은 막힘)
//  - 앱이 정한 폴더 밖의 파일은 화면에서 읽을 수 없다
//
// 경로
//   /renderer/...    빌드된 화면 (out/renderer)
//   /characters/<id>/...  캐릭터 폴더 (기본 캐릭터 폴더 → 없으면 내 캐릭터 폴더에서 읽음)
//   /vendor/...      Live2D 라이브러리 (node_modules) 와 Cubism Core (사용자가 넣음)
import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { dirForCharacterUrl } from './character-dirs';

const SCHEME = 'app';
const HOST = 'local';
export const ORIGIN = `${SCHEME}://${HOST}`;

// 화면 보안 정책. 네트워크는 메인 프로세스가 하므로 화면은 app://local 밖으로 요청하지 않는다.
// wasm-unsafe-eval: Live2D Cubism Core(WebAssembly)용
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.moc3': 'application/octet-stream'
};

// Live2D에 필요한 라이브러리 (npm install로 받는다). Cubism Core는 라이선스상 직접 받아서 넣는다.
const VENDOR: Record<string, string[]> = {
  'pixi.min.js': ['node_modules', 'pixi.js', 'dist', 'browser', 'pixi.min.js'],
  'pixi-unsafe-eval.min.js': ['node_modules', '@pixi', 'unsafe-eval', 'dist', 'browser', 'unsafe-eval.min.js'],
  'cubism4.min.js': ['node_modules', 'pixi-live2d-display', 'dist', 'cubism4.min.js']
};
export const CUBISM_CORE = 'live2dcubismcore.min.js';

export function registerScheme(): void {
  // app.ready 전에 불러야 한다. secure: 마이크(getUserMedia)를 쓰려면 보안 컨텍스트여야 함
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
  ]);
}

function inside(base: string, rel: string, followLinks: boolean): string | null {
  const target = path.resolve(base, ...rel.split('/').filter(Boolean));
  const r = path.relative(base, target);
  if (!r || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) return null;
  if (followLinks) {
    try {
      const rb = fs.realpathSync(base);
      const rr = path.relative(rb, fs.realpathSync(target));
      if (rr === '..' || rr.startsWith('..' + path.sep) || path.isAbsolute(rr)) return null; // 링크로 밖을 가리킴
    } catch {
      return null;
    }
  }
  return target;
}

export function cubismCorePath(appRoot: string, userData: string): string | null {
  const cands = [path.join(userData, 'live2d', CUBISM_CORE), path.join(appRoot, 'vendor', CUBISM_CORE)];
  return cands.find((p) => fs.existsSync(p)) || null;
}

export interface ProtocolOptions {
  appRoot: string;
  rendererDir: string;
  /** 기본 캐릭터 폴더 (읽기 전용) */
  builtinCharactersDir: string;
  /** 내가 추가한 캐릭터 폴더 (my-characters) */
  userCharactersDir: string;
  userData: string;
  /** 개발 중(Vite 개발 서버)에는 화면 주소가 http://localhost:5173 이라 그 주소에서 읽을 수 있게 허용한다 */
  devOrigin?: string | null;
}

export function register({ appRoot, rendererDir, builtinCharactersDir, userCharactersDir, userData, devOrigin }: ProtocolOptions): void {
  const notFound = () => new Response('not found', { status: 404 });
  protocol.handle(SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.host !== HOST) return notFound();
    let p: string;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (p.includes('\0') || p.includes('\\')) return new Response('bad request', { status: 400 });

    let file: string | null = null;
    if (p.startsWith('/renderer/')) file = inside(rendererDir, p.slice('/renderer/'.length), false);
    else if (p.startsWith('/characters/')) {
      // 읽기만 한다: 기본 캐릭터는 기본 폴더에서, 그 밖은 내 폴더에서
      const rel = p.slice('/characters/'.length);
      file = inside(dirForCharacterUrl(builtinCharactersDir, userCharactersDir, rel), rel, true);
    }
    else if (p.startsWith('/vendor/')) {
      const name = p.slice('/vendor/'.length);
      if (name === CUBISM_CORE) file = cubismCorePath(appRoot, userData);
      else if (VENDOR[name]) file = path.join(appRoot, ...VENDOR[name]);
    }
    try {
      if (!file || !fs.statSync(file).isFile()) return notFound();
    } catch {
      return notFound();
    }
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    if (devOrigin) headers['Access-Control-Allow-Origin'] = devOrigin;
    const res = await net.fetch(pathToFileURL(file).toString());
    return new Response(res.body, { status: 200, headers });
  });
}
