// 화면과 실행 사이의 문지기.
// 1) prepare: 요청을 검사해 계획을 만들고 id를 준다 (화면은 이 id로만 실행할 수 있다)
// 2) execute: 확인이 필요한 작업은 60초 안에, 한 번만 실행된다
// 화면에서 온 경로도 매번 다시 검사하므로, 화면 코드가 잘못돼도 허용 폴더 밖은 건드릴 수 없다.
import crypto from 'node:crypto';
import { ACTIONS, ToolError, prepare, execute, isAction, matchRoot, stripKo } from './executor';
import type { Plan, ShellLike } from './executor';
import type { Platform, Root } from './policy';
import { checkExisting } from './policy';
import { prepareNameArgs } from './name-matcher';
import { prepareCreateArgs } from './create-command';
import { prepareOpenArgs, prepareSearchArgs } from './open-command';
import { prepareTransferArgs } from './transfer-command';
import type { FileNameMatcher } from '@shared/file-names';
import type { Audit } from './audit';
import type { ExecuteResult, PrepareResult, ToolRequest, ToolSource } from '@shared/types';

interface Pending {
  plan: Plan;
  source: ToolSource;
  expiresAt: number;
  needsConfirm: boolean;
}

export interface BrokerOptions {
  getRoots: () => Root[];
  /** 원격 지시가 다룰 수 있는 폴더 (없으면 전체) */
  getRemoteRoots?: () => Root[];
  shell: ShellLike;
  /** 내 서버에 연결된 경로에만 기존 이름 비교를 제공한다. */
  getNameMatcher?: (source: ToolSource) => FileNameMatcher | null;
  audit?: Audit | null;
  ttlMs?: number;
  now?: () => number;
  platform?: Platform;
}

export class ToolBroker {
  private getRoots: () => Root[];
  private getRemoteRoots: (() => Root[]) | null;
  private shell: ShellLike;
  private audit: Audit | null;
  private ttlMs: number;
  private now: () => number;
  private platform: Platform;
  private pending = new Map<string, Pending>();
  private getNameMatcher: BrokerOptions['getNameMatcher'];

  constructor({ getRoots, getRemoteRoots, getNameMatcher, shell, audit = null, ttlMs = 60000, now = Date.now, platform = process.platform }: BrokerOptions) {
    this.getRoots = getRoots;
    this.getRemoteRoots = getRemoteRoots || null;
    this.shell = shell;
    this.getNameMatcher = getNameMatcher;
    this.audit = audit;
    this.ttlMs = ttlMs;
    this.now = now;
    this.platform = platform;
  }

  private rootsFor(source: ToolSource): Root[] {
    return source.kind === 'remote' && this.getRemoteRoots ? this.getRemoteRoots() : this.getRoots();
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, p] of this.pending) {
      if (t > p.expiresAt) {
        this.pending.delete(id);
        this.log(p, 'expired');
      }
    }
  }

  private log(p: Pending, status: string, extra: Record<string, unknown> = {}): void {
    if (!this.audit) return;
    this.audit.log({ status, action: p.plan.action, src: p.plan.src, dst: p.plan.dst || null, source: p.source, ...extra });
  }

  prepare(req: ToolRequest): PrepareResult {
    this.sweep();
    const action = req && req.action;
    const source: ToolSource =
      req && req.source && typeof req.source === 'object'
        ? { kind: req.source.kind === 'server' || req.source.kind === 'remote' ? req.source.kind : 'local', id: req.source.id ? String(req.source.id) : undefined, via: typeof req.source.via === 'string' ? req.source.via : undefined }
        : { kind: 'local' };
    if (source.kind !== 'remote' && !source.via) source.via = '로컬';
    try {
      if (req.args?.transferParts) throw new ToolError('복사·이동의 위치와 대상은 비동기 준비 단계에서 확인해야 합니다.', 'bad_args');
      if (req.args?.openParts) throw new ToolError('명령의 위치와 대상은 비동기 준비 단계에서 확인해야 합니다.', 'bad_args');
      if ((action === 'file.open' || action === 'file.reveal' || action === 'file.rename' || action === 'file.copy' || action === 'file.move') && req.args?.root && !matchRoot(req.args.root, this.rootsFor(source)) && !this.rootsFor(source).some((r) => r.real === req.args!.root)) throw new ToolError('검색 위치는 비동기 준비 단계에서 확인해야 합니다.', 'bad_args');
      if (req.args?.createParts) throw new ToolError('생성 위치와 이름은 비동기 준비 단계에서 확인해야 합니다.', 'bad_args');
      if (isAction(action) && ACTIONS[action].remoteOnly && source.kind !== 'remote') throw new ToolError('파일 보내기는 메신저(디스코드)에서만 됩니다.', 'remote_only');
      const out = prepare(action, req.args || {}, this.rootsFor(source), { platform: this.platform });
      if ('result' in out) return { status: 'result', ...out.result };
      if ('choice' in out) return { status: 'choice', ...out.choice };
      if (!isAction(action)) throw new ToolError('지원하지 않는 작업입니다.', 'unsupported');
      const id = crypto.randomUUID();
      const needsConfirm = ACTIONS[action].confirm;
      const expiresAt = this.now() + this.ttlMs;
      this.pending.set(id, { plan: out.plan, source, expiresAt, needsConfirm });
      return {
        status: 'ready',
        id,
        needsConfirm,
        expiresInMs: this.ttlMs,
        summary: {
          action,
          from: out.plan.display.src,
          to: out.plan.display.dst || null,
          fromPath: out.plan.src,
          toPath: out.plan.dst || null,
          conflict: !!out.plan.conflict,
          warnings: out.plan.warnings || [],
          questions: ACTIONS[action].questions
        }
      };
    } catch (e) {
      if (!(e instanceof ToolError)) console.error(e);
      if (this.audit) this.audit.log({ status: 'refused', action, source, reason: (e as Error).message });
      return {
        status: 'error',
        code: (e as ToolError).code || 'error',
        message: e instanceof ToolError ? e.message : `처리하지 못했습니다: ${(e as Error).message}`
      };
    }
  }

  /** 정형 생성의 위치·이름 경계와 이름 비교를 해결한 뒤 실행 계획을 만든다. */
  async prepareAsync(req: ToolRequest): Promise<PrepareResult> {
    const source: ToolSource = req?.source && typeof req.source === 'object'
      ? { kind: req.source.kind === 'server' || req.source.kind === 'remote' ? req.source.kind : 'local', id: req.source.id, via: req.source.via }
      : { kind: 'local' };
    try {
      if (req?.action === 'file.list' && !req.args?.dest && !req.args?.target && !req.args?.root) return this.prepare(req);
      const matcher = this.getNameMatcher?.(source) || null;
      if (!isAction(req?.action) || (ACTIONS[req.action].remoteOnly && source.kind !== 'remote')) return this.prepare(req);
      if (req.action === 'file.search') {
        const out = await prepareSearchArgs(req.args || {}, this.rootsFor(source), matcher, this.platform);
        const paths = out.status === 'result' ? out.items.map((o) => o.path) : out.options.map((o) => out.field === 'openChoice' ? JSON.parse(o.path)[0] as string | null : o.path);
        if (paths.some((p) => p !== null && !checkExisting(p, this.rootsFor(source), this.platform).ok)) throw new ToolError('찾는 동안 허용 범위가 바뀌었습니다.', 'denied');
        return out;
      }
      if (req.action === 'file.copy' || req.action === 'file.move') {
        const out = await prepareTransferArgs(req.action, req.args || {}, this.rootsFor(source), matcher, this.platform);
        if ('status' in out) {
          const paths = out.options.flatMap((o) => (JSON.parse(o.path) as [string, string]).slice(0, 2));
          if (paths.some((p) => !checkExisting(p, this.rootsFor(source), this.platform).ok)) throw new ToolError('복사·이동을 준비하는 동안 허용 범위가 바뀌었습니다.', 'denied');
          return out;
        }
        req = { ...req, args: out.args };
      }
      if (req.action === 'file.open' || req.action === 'file.reveal' || req.action === 'file.rename' || req.action === 'file.backup' || req.action === 'file.delete' || req.action === 'file.send') {
        const out = await prepareOpenArgs(req.args || {}, this.rootsFor(source), matcher, this.platform, req.action === 'file.reveal');
        if ('status' in out) {
          const paths = out.options.map((o) => out.field === 'openChoice' ? JSON.parse(o.path)[0] as string | null : o.path);
          if (paths.some((p) => p !== null && !checkExisting(p, this.rootsFor(source), this.platform).ok)) throw new ToolError('대상을 찾는 동안 허용 폴더가 바뀌었습니다. 다시 요청해 주세요.', 'denied');
          return out;
        }
        req = { ...req, args: out.args };
      }
      if ((req.action === 'file.create' || req.action === 'file.mkdir' || req.action === 'file.list') && req.args?.root && !req.args.createParts) {
        const out = await prepareOpenArgs({ root: req.args.root, target: stripKo(req.args.dest || req.args.target || '') }, this.rootsFor(source), matcher, this.platform);
        if ('status' in out) return { ...out, field: out.field === 'target' ? 'dest' : out.field };
        const checked = checkExisting(out.args.target!, this.rootsFor(source), this.platform);
        if (!checked.ok || !checked.isDir) throw new ToolError('지정 위치는 기존 폴더여야 합니다.', 'bad_args');
        req = { ...req, args: { ...req.args, root: undefined, dest: checked.real } };
      }
      if ((req.action === 'file.create' || req.action === 'file.mkdir') && req.args?.createParts) {
        const out = await prepareCreateArgs(req.args, this.rootsFor(source), matcher, this.platform);
        if ('status' in out) {
          const paths = out.options.map((o) => out.field === 'createChoice' ? JSON.parse(o.path)[0] as string : o.path);
          if (paths.some((p) => !checkExisting(p, this.rootsFor(source), this.platform).ok)) throw new ToolError('위치를 찾는 동안 허용 폴더가 바뀌었습니다. 다시 요청해 주세요.', 'denied');
          return out;
        }
        req = { ...req, args: out.args };
      }
      if (!matcher) return this.prepare(req);
      const out = await prepareNameArgs(req.action, req.args || {}, this.rootsFor(source), matcher, this.platform);
      if ('args' in out) return this.prepare({ ...req, args: out.args });
      const paths = out.status === 'choice' ? out.options.map((o) => o.path) : out.items.map((o) => o.path);
      if (paths.some((p) => !checkExisting(p, this.rootsFor(source), this.platform).ok)) throw new ToolError('이름을 비교하는 동안 허용 폴더가 바뀌었습니다. 다시 요청해 주세요.', 'denied');
      return out;
    } catch (e) {
      return { status: 'error', code: (e as ToolError).code || 'name_match_failed', message: (e as Error).message };
    }
  }

  /** 실행하지 않고 계획만 본다 (메신저 보내기처럼 실행을 broker 밖에서 할 때). 한 번만 꺼낼 수 있다 */
  take(id: string): { plan: Plan; source: ToolSource } | null {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    return { plan: p.plan, source: p.source };
  }

  /** take로 꺼낸 작업의 결과를 기록한다 */
  record(taken: { plan: Plan; source: ToolSource }, status: 'done' | 'failed', extra: Record<string, unknown> = {}): void {
    this.log({ plan: taken.plan, source: taken.source, expiresAt: 0, needsConfirm: false }, status, extra);
  }

  async execute(id: string, opts: { overwrite?: boolean } = {}): Promise<ExecuteResult> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, status: 'expired', message: '확인 시간이 지났거나 이미 처리된 요청입니다. 다시 요청해 주세요.' };
    this.pending.delete(id); // 한 번만
    try {
      const r = await execute(p.plan, { overwrite: !!opts.overwrite }, this.rootsFor(p.source), this.shell, { platform: this.platform });
      this.log(p, 'done', r.path ? { result: r.path } : {});
      return { ok: true, status: 'done', message: r.message, path: r.path };
    } catch (e) {
      this.log(p, 'failed', { reason: (e as Error).message });
      return { ok: false, status: 'failed', message: e instanceof ToolError ? e.message : `실패했습니다: ${(e as Error).message}` };
    }
  }

  cancel(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.log(p, 'rejected');
    return true;
  }
}
