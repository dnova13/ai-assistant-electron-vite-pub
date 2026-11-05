import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import type { BrowserWindow, Tray } from 'electron';
import type { Settings } from '../src/shared/types';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    minimized = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send: vi.fn() });
    constructor(public options: object) { super(); }
    setMenuBarVisibility() {}
    loadURL() {}
    show() { this.visible = true; }
    focus() {}
    hide() { if (this.visible) { this.visible = false; this.emit('hide'); } }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
  }
  return { BrowserWindow: Window, app: { isPackaged: true } };
});

import { WindowManager } from '../src/main/windows';

function setup(platform: NodeJS.Platform) {
  const settings = { alwaysOnTop: false } as Settings;
  const manager = new WindowManager({
    appRoot: '/qa', pageBase: 'app://local/renderer', allowedOrigins: ['app://local'],
    preload: '/qa/preload.js', getSettings: () => settings, saveSettings: () => settings, platform
  });
  const chat = manager.createMain();
  (chat as unknown as EventEmitter).emit('ready-to-show');
  const window = manager.showSettings('character');
  (window as unknown as EventEmitter).emit('ready-to-show');
  return { manager, chat, window };
}

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: 설정은 제목줄 없는 독립창이며 숨긴 창을 재사용한다`, () => {
    const { manager, chat, window } = setup(platform);
    expect((window as unknown as { options: object }).options).toMatchObject({ frame: false });
    expect((window as unknown as { options: object }).options).not.toHaveProperty('parent');
    expect((window as unknown as { options: object }).options).not.toHaveProperty('modal');
    chat.hide();
    expect(window.isVisible()).toBe(false);
    expect(window.isDestroyed()).toBe(false);
    manager.showChat();
    expect(manager.showSettings('character')).toBe(window);
    expect(window.isVisible()).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith('app:command', { cmd: 'settingsTab', data: 'character' });
  });

  test(`${platform}: 트레이·마스코트의 대화창 닫기는 두 창을 숨긴다`, () => {
    for (const kind of ['tray', 'mascot'] as const) {
      const { manager, chat, window } = setup(platform);
      if (kind === 'tray') manager.tray = {} as Tray;
      else manager.mascot = {} as BrowserWindow;
      chat.close();
      expect(chat.isVisible()).toBe(false);
      expect(window.isVisible()).toBe(false);
      expect(chat.isDestroyed()).toBe(false);
      expect(window.isDestroyed()).toBe(false);
    }
  });

  test(`${platform}: 전환 숨김과 로딩 중 숨김도 설정창을 남기지 않는다`, () => {
    const { manager, chat, window } = setup(platform);
    manager.toggleChat();
    expect(window.isVisible()).toBe(false);
    manager.showChat();
    window.close();
    const pending = manager.showSettings();
    chat.hide();
    (pending as unknown as EventEmitter).emit('ready-to-show');
    expect(pending.isVisible()).toBe(false);
    expect(pending.isDestroyed()).toBe(false);
  });

  test(`${platform}: 설정만 닫기와 대화창 실제 종료를 구별한다`, () => {
    const { manager, chat, window } = setup(platform);
    window.close();
    expect(chat.isVisible()).toBe(true);
    const next = manager.showSettings();
    expect(next).not.toBe(window);
    manager.tray = {} as Tray;
    manager.quitting = true;
    chat.close();
    expect(chat.isDestroyed()).toBe(true);
    expect(next.isDestroyed()).toBe(true);
    expect(manager.main).toBe(null);
    expect(manager.settingsWindow).toBe(null);
  });
}
