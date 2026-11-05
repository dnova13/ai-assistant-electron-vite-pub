// 인증 앱(Microsoft Authenticator, Google Authenticator)의 6자리 코드 (TOTP, RFC 6238: 30초, SHA-1, 6자리).
// 같은 비밀 키를 두 앱에 등록하면 두 앱의 코드가 같다. 비밀 키는 이 컴퓨터에만 둔다 (remote/state.ts).
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('잘못된 키입니다.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 새 비밀 키 (20바이트 = 32글자) */
export const newSecret = (): string => base32Encode(crypto.randomBytes(20));

export const STEP_SEC = 30;
export const stepOf = (ms: number): number => Math.floor(ms / 1000 / STEP_SEC);

export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export const totp = (secret: string, ms = Date.now()): string => hotp(secret, stepOf(ms));

/**
 * 코드가 맞으면 맞은 시간 칸(step)을 돌려준다. 앞뒤 한 칸(±30초)까지 봐 준다 (폰 시계가 조금 틀려도 되게).
 * afterStep 이하의 칸은 받지 않는다 (한 번 쓴 코드를 다시 못 쓰게).
 */
export function verifyTotp(secret: string, code: string, { now = Date.now(), afterStep = -1, window = 1 }: { now?: number; afterStep?: number; window?: number } = {}): number | null {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepOf(now);
  for (let d = -window; d <= window; d++) {
    const s = cur + d;
    if (s <= afterStep) continue;
    const want = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return s;
  }
  return null;
}

/** 인증 앱에 등록할 주소 (QR로 만든다) */
export function otpauthUri(secret: string, account: string, issuer = 'AI비서'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SEC}`;
}
