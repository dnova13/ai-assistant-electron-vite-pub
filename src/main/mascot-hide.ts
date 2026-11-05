// 바탕화면 캐릭터 자동 숨김: 활동(생각 중·말풍선·녹음·말하는 중)이 없는 채로 N초가 지나면 숨기고, 다시 말을 걸면 나타난다.
// 창을 직접 다루지 않고 show/hide 함수만 받는다 (시험하기 쉽게).
import type { MascotMessage } from '@shared/types';

export interface AutoHideOptions {
  /** 지금 설정: on = 답한 뒤 숨기기, sec = 숨기기까지 초 */
  config: () => { on: boolean; sec: number };
  show: () => void;
  hide: () => void;
}

export class MascotAutoHide {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private recording = false;
  hidden = false;

  constructor(private o: AutoHideOptions) {}

  /** 대화 창이 마스코트에 보내는 메시지를 먼저 여기로 거친다 */
  feed(msg: MascotMessage): void {
    if (!this.o.config().on) return;
    switch (msg.type) {
      case 'recording':
        this.recording = msg.on;
        if (msg.on) this.wake();
        else this.later();
        break;
      case 'state':
        if (msg.state === 'idle') this.later();
        else this.wake();
        break;
      case 'bubble':
        if (!msg.text) break;
        if (msg.final) this.later();
        else this.wake();
        break;
      case 'notice':
        this.wake();
        this.later();
        break;
      default:
        break;
    }
  }

  /** 설정이 바뀌었거나 창이 새로 생겼을 때: 켜져 있으면 지금부터 활동 없음을 센다. 끄면 대기 중인 숨김을 취소하고 숨겨져 있으면 다시 보인다 */
  settingsChanged(hasWindow = true): void {
    if (this.o.config().on && hasWindow) {
      if (!this.hidden) this.later();
      return;
    }
    clearTimeout(this.timer);
    if (this.hidden) this.reveal();
  }

  /** 창이 없어졌을 때 */
  reset(): void {
    clearTimeout(this.timer);
    this.hidden = false;
    this.recording = false;
  }

  private reveal(): void {
    this.hidden = false;
    this.o.show();
  }

  private wake(): void {
    clearTimeout(this.timer);
    if (this.hidden) this.reveal();
  }

  private later(): void {
    clearTimeout(this.timer);
    if (this.recording) return;
    this.timer = setTimeout(() => {
      if (this.recording || !this.o.config().on) return;
      this.hidden = true;
      this.o.hide();
    }, this.o.config().sec * 1000);
  }
}
