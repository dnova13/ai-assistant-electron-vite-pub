// 두 창의 송신자를 메인에서 확인한다. 임의의 컨트롤러 메서드는 호출할 수 없다.
import { randomUUID } from 'node:crypto';
import { SETTINGS_METHODS, type SettingsCall } from '@shared/settings-window';
export class SettingsBridge {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  call(method: unknown, args: unknown, send: (call: SettingsCall) => void): Promise<unknown> {
    if (!SETTINGS_METHODS.includes(method as never) || !Array.isArray(args) || args.length > 3) return Promise.reject(new Error('허용되지 않은 설정 요청입니다.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('설정 요청 시간이 지났습니다. 다시 시도해 주세요.')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      try { send({ id, method: method as SettingsCall['method'], args }); }
      catch { this.finish(id, null, '대화창에 요청을 전달하지 못했습니다.'); }
    });
  }
  finish(id: string, value: unknown, error?: string): void {
    const p = this.pending.get(id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(value);
  }
  cancel(): void { for (const id of [...this.pending.keys()]) this.finish(id, null, '설정창 또는 대화창이 닫혔습니다.'); }
}
