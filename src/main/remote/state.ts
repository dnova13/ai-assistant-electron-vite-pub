// 원격 승인 상태: 인증 앱 비밀 키, 잠금 해제 시각, 원격 중지, 복구 코드.
// settings.json과 따로 둔다 (설정창의 "저장"이 편집 중인 값으로 이 상태를 덮어쓰지 않게). 비밀 키는 OS 보안 저장소로 암호화한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SafeStorageLike } from '../settings';
import { newSecret, otpauthUri, verifyTotp } from '../totp';

interface Disk {
  secretEnc?: string;
  /** 암호화를 쓸 수 없는 시스템이면 그대로 (설정 파일의 토큰과 같은 방식) */
  secret?: string;
  unlockedUntil: number;
  /** 마지막으로 받은 코드의 시간 칸 (같은 코드를 다시 못 쓰게) */
  lastStep: number;
  stopped: boolean;
  /** 복구 코드의 해시 (쓰면 지운다) */
  recovery: string[];
  /** 비서 서버 연결: 등록 정보와 서버 원격 허용 스위치 (기본 꺼짐) */
  server: ServerLinkInfo;
}

export interface ServerLinkInfo {
  /** 앱에서 연결을 해제해도 기존 ID는 기억한다. */
  attached: boolean;
  on: boolean;
  profile: string;
  computerId: string;
  computerName: string;
}

const blankServer = (): ServerLinkInfo => ({ attached: false, on: false, profile: '', computerId: '', computerName: '' });

const blank = (): Disk => ({ unlockedUntil: 0, lastStep: -1, stopped: false, recovery: [], server: blankServer() });
const hash = (s: string) => crypto.createHash('sha256').update(s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

export function createRemoteState(file: string, safeStorage: SafeStorageLike | null, { now = Date.now }: { now?: () => number } = {}) {
  const canEncrypt = (): boolean => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  let disk: Disk = blank();
  let authorizationVersion = 0;
  try {
    disk = { ...blank(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Disk>) };
  } catch {
    /* 처음 */
  }

  const storedServer = (): ServerLinkInfo => {
    const raw = disk.server || blankServer();
    return { ...blankServer(), ...raw, attached: typeof raw.attached === 'boolean' ? raw.attached : !!raw.computerId };
  };

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const secret = (): string => {
    try {
      if (disk.secretEnc && canEncrypt() && safeStorage) return safeStorage.decryptString(Buffer.from(disk.secretEnc, 'base64'));
    } catch {
      return ''; // 다른 컴퓨터에서 복사한 파일 → 다시 만들어야 함
    }
    return disk.secret || '';
  };

  return {
    file,
    /** 두 원격 연결 중 한쪽이 인증을 끝내도 기존 실행 요청을 무효화한다. 디스크에 저장하지 않는다. */
    authorizationVersion: (): number => authorizationVersion,
    hasKey: (): boolean => !!secret(),
    /** 새 키를 만든다. 있던 키는 폐기되고 잠긴다. 복구 코드 8개는 이때 한 번만 돌려준다 */
    newKey(account: string): { secret: string; uri: string; recovery: string[] } {
      authorizationVersion++;
      const s = newSecret();
      const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
      if (canEncrypt() && safeStorage) {
        disk.secretEnc = safeStorage.encryptString(s).toString('base64');
        delete disk.secret;
      } else {
        disk.secret = s;
        delete disk.secretEnc;
      }
      disk.unlockedUntil = 0;
      disk.lastStep = -1;
      disk.recovery = recovery.map(hash);
      save();
      return { secret: s, uri: otpauthUri(s, account), recovery };
    },
    /** 코드가 맞는지만 본다 (설정 화면의 시험용, 잠금은 그대로) */
    check(code: string): boolean {
      const s = secret();
      return !!s && verifyTotp(s, code, { now: now() }) !== null;
    },
    /** 코드가 맞으면 minutes 동안 잠금을 풀고 원격 중지도 푼다 */
    unlockWithCode(code: string, minutes: number): boolean {
      const s = secret();
      if (!s) return false;
      const step = verifyTotp(s, code, { now: now(), afterStep: disk.lastStep });
      if (step === null) return false;
      disk.lastStep = step;
      authorizationVersion++;
      disk.unlockedUntil = now() + minutes * 60_000;
      disk.stopped = false;
      save();
      return true;
    },
    /** 복구 코드 (한 번만 쓰임) */
    unlockWithRecovery(code: string, minutes: number): boolean {
      const h = hash(code);
      const i = disk.recovery.indexOf(h);
      if (i < 0 || !secret()) return false;
      disk.recovery.splice(i, 1);
      authorizationVersion++;
      disk.unlockedUntil = now() + minutes * 60_000;
      disk.stopped = false;
      save();
      return true;
    },
    isUnlocked: (): boolean => !disk.stopped && disk.unlockedUntil > now(),
    unlockedUntil: (): number => (disk.unlockedUntil > now() ? disk.unlockedUntil : 0),
    lock(): void {
      authorizationVersion++;
      disk.unlockedUntil = 0;
      save();
    },
    isStopped: (): boolean => disk.stopped,
    setStopped(on: boolean): void {
      if (on) authorizationVersion++;
      disk.stopped = on;
      if (on) disk.unlockedUntil = 0;
      save();
    },
    recoveryLeft: (): number => (secret() ? disk.recovery.length : 0),
    server: (): ServerLinkInfo => storedServer(),
    setServer(patch: Partial<ServerLinkInfo>): void {
      disk.server = { ...storedServer(), ...patch };
      if (patch.computerId !== undefined && patch.attached === undefined) disk.server.attached = !!patch.computerId;
      save();
    },
    detachServer(): void {
      disk.server = { ...storedServer(), on: false, attached: false };
      save();
    },
    clearServer(): void {
      disk.server = blankServer();
      save();
    }
  };
}

export type RemoteState = ReturnType<typeof createRemoteState>;
