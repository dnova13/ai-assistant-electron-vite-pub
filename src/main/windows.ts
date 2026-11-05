// 창 관리: 대화 창, 마스코트 창(투명 배경 캐릭터), 트레이 아이콘, 전역 단축키.
// 대화·목소리·녹음 같은 "두뇌"는 항상 대화 창 화면이 맡는다. 대화 창을 닫으면 숨기기만 해서 두뇌는 계속 돈다.
// 마스코트 창은 보여 주기만 한다: 대화 창이 보내는 입 모양·상태·말풍선을 받아 그린다.
import { BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, app } from 'electron';
import type { WebPreferences } from 'electron';
import path from 'node:path';
import { checkAccelerator, isDevToolsKey } from './shortcut';
import { SettingsBridge } from './settings-bridge';
import { MascotAutoHide } from './mascot-hide';
import type { AppCommand, DragPhase, MascotMessage, Settings } from '@shared/types';

const MASCOT_W = 240;

export type ShortcutName = 'ptt' | 'ttsToggle';
const SHORTCUT_LABEL: Record<ShortcutName, string> = { ptt: '말하기', ttsToggle: 'TTS 켜기/끄기' };
const MASCOT_H = 340;

export interface WindowManagerOptions {
  appRoot: string;
  /** 화면 주소의 앞부분: 설치본은 app://local/renderer, 개발 중에는 Vite 개발 서버 주소 */
  pageBase: string;
  /** 앱 화면으로 인정하는 주소 앞부분 (이 밖으로 이동 금지) */
  allowedOrigins: string[];
  preload: string;
  getSettings: () => Settings;
  saveSettings: (patch: Partial<Settings>) => Settings;
  platform?: NodeJS.Platform;
}

export class WindowManager {
  main: BrowserWindow | null = null;
  settingsWindow: BrowserWindow | null = null;
  settingsBridge = new SettingsBridge();
  mascot: BrowserWindow | null = null;
  /** 답한 뒤 자동 숨김 (설정 > 일반) */
  private autoHide = new MascotAutoHide({
    config: () => ({ on: !!this.settings.mascot.autoHide, sec: this.settings.mascot.hideSec }),
    show: () => {
      if (this.mascot && !this.mascot.isDestroyed()) this.mascot.showInactive();
    },
    hide: () => {
      if (this.mascot && !this.mascot.isDestroyed()) this.mascot.hide();
    }
  });
  tray: Tray | null = null;
  quitting = false;
  recording = false;
  /** 실제로 등록된 전역 단축키 (등록 못 했으면 null) */
  keys: Record<ShortcutName, string | null> = { ptt: null, ttsToggle: null };
  private drag: { cx: number; cy: number; x: number; y: number } | null = null;
  private opts: WindowManagerOptions;
  private platform: NodeJS.Platform;

  constructor(opts: WindowManagerOptions) {
    this.opts = opts;
    this.platform = opts.platform || process.platform;
  }

  /** 등록된 말하기 단축키 */
  get ptt(): string | null {
    return this.keys.ptt;
  }

  private pretty(acc: string): string {
    return acc.replace('CommandOrControl', this.platform === 'darwin' ? 'Cmd' : 'Ctrl');
  }

  private get settings(): Settings {
    return this.opts.getSettings();
  }

  private harden(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!this.opts.allowedOrigins.some((o) => url.startsWith(o + '/'))) e.preventDefault();
    });
    // 개발 모드(npm run dev)에서만: F12 (맥 Cmd+Option+I, 윈도우 Ctrl+Shift+I)로 개발자 도구를 열고 닫는다. 설치본(app.isPackaged)에서는 연결하지 않는다
    if (!app.isPackaged) {
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown' || !isDevToolsKey(input, this.platform)) return;
        e.preventDefault();
        const wc = win.webContents;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: 'detach' });
      });
    }
  }

  private webPrefs(): WebPreferences {
    // backgroundThrottling: 대화 창이 숨겨져 있어도 녹음·목소리·립싱크가 느려지지 않게
    return { preload: this.opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
  }

  /* ---------------- 대화 창 ---------------- */

  createMain(): BrowserWindow {
    const win = new BrowserWindow({
      width: 440,
      height: 760,
      minWidth: 440, // 이보다 좁으면 설정 창의 탭·순서 줄 등이 깨진다
      minHeight: 560,
      show: false,
      alwaysOnTop: !!this.settings.alwaysOnTop,
      backgroundColor: '#1e2030',
      icon: path.join(this.opts.appRoot, 'assets', 'icon.png'), // 리눅스 창 아이콘 (맥·윈도우는 설치본 아이콘을 씀)
      webPreferences: this.webPrefs()
    });
    win.setMenuBarVisibility(false);
    this.harden(win);
    win.once('ready-to-show', () => win.show());
    // 트레이나 마스코트가 있으면 닫기 = 숨기기 (종료는 트레이 메뉴 또는 Cmd+Q)
    win.on('close', (e) => {
      if (!this.quitting && (this.tray || this.mascot)) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('hide', () => {
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) this.settingsWindow.hide();
    });
    win.on('closed', () => {
      this.main = null;
      this.settingsBridge.cancel();
      this.settingsWindow?.destroy();
    });
    win.loadURL(`${this.opts.pageBase}/index.html`);
    this.main = win;
    return win;
  }

  /** 독립된 비차단 설정창. 두 번째 호출은 기존 창을 앞으로 가져온다. */
  showSettings(tab?: 'character'): BrowserWindow {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (this.settingsWindow.isMinimized()) this.settingsWindow.restore();
      if (tab) this.settingsWindow.webContents.send('app:command', { cmd: 'settingsTab', data: tab });
      this.settingsWindow.show(); this.settingsWindow.focus(); return this.settingsWindow;
    }
    const win = new BrowserWindow({ width: 480, height: 800, minWidth: 460, minHeight: 560, title: '설정', frame: false, show: false, backgroundColor: '#1e2030', webPreferences: this.webPrefs() });
    this.settingsWindow = win;
    win.setMenuBarVisibility(false); this.harden(win);
    // 로딩 도중 대화창을 숨긴 경우 설정창이 뒤늦게 혼자 나타나지 않게 한다.
    win.once('ready-to-show', () => { if (this.main?.isVisible()) win.show(); });
    win.on('closed', () => { if (this.settingsWindow === win) this.settingsWindow = null; this.settingsBridge.cancel(); });
    win.loadURL(`${this.opts.pageBase}/settings.html${tab ? `?tab=${tab}` : ''}`);
    return win;
  }

  showChat(): void {
    const win = this.main || this.createMain();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  toggleChat(): void {
    if (this.main && this.main.isVisible() && this.main.isFocused()) this.main.hide();
    else this.showChat();
  }

  command(cmd: AppCommand['cmd'], data?: unknown): void {
    if (this.main && !this.main.isDestroyed()) this.main.webContents.send('app:command', { cmd, data } satisfies AppCommand);
  }

  /* ---------------- 마스코트 창 ---------------- */

  private mascotPosition(): { x: number; y: number } {
    const saved = this.settings.mascot.bounds;
    if (saved) {
      const wa = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: MASCOT_W, height: MASCOT_H }).workArea;
      // 모니터를 뺐을 때 화면 밖에 남지 않게
      if (saved.x >= wa.x - MASCOT_W / 2 && saved.x <= wa.x + wa.width - MASCOT_W / 2 && saved.y >= wa.y - 20 && saved.y <= wa.y + wa.height - 60) {
        return { x: saved.x, y: saved.y };
      }
    }
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - MASCOT_W - 24, y: wa.y + wa.height - MASCOT_H - 8 };
  }

  setMascot(enabled: boolean): void {
    if (enabled && !this.mascot) {
      const win = new BrowserWindow({
        ...this.mascotPosition(),
        width: MASCOT_W,
        height: MASCOT_H,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        webPreferences: this.webPrefs()
      });
      this.harden(win);
      win.setAlwaysOnTop(true, 'floating');
      if (this.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // 투명한 곳은 클릭이 뒤 창으로 지나가게 한다 (캐릭터 위에 마우스가 오면 화면이 hover로 알려 줌)
      if (this.platform !== 'linux') win.setIgnoreMouseEvents(true, { forward: true });
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      win.on('moved', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (!win.isDestroyed()) {
            const [x, y] = win.getPosition();
            this.opts.saveSettings({ mascot: { ...this.settings.mascot, bounds: { x, y } } });
          }
        }, 500);
      });
      win.on('closed', () => {
        this.mascot = null;
        this.autoHide.reset();
        this.updateTray();
      });
      win.once('ready-to-show', () => win.showInactive());
      win.loadURL(`${this.opts.pageBase}/mascot.html`);
      this.mascot = win;
    } else if (!enabled && this.mascot) {
      const w = this.mascot;
      this.mascot = null;
      this.autoHide.reset();
      w.destroy();
    }
    this.autoHide.settingsChanged(!!this.mascot);
    this.updateTray();
  }

  relay(msg: MascotMessage): void {
    if (this.mascot && !this.mascot.isDestroyed()) this.autoHide.feed(msg); // 숨겨져 있으면 먼저 다시 보이게 한다
    // 자동 숨김으로 숨어 있어도 보낸다 (캐릭터를 바꾼 것 등을 놓치면 다시 나타날 때 옛 캐릭터가 보인다)
    if (this.mascot && !this.mascot.isDestroyed() && (this.mascot.isVisible() || this.autoHide.hidden)) this.mascot.webContents.send('mascot:update', msg);
  }

  mascotHover(on: boolean): void {
    if (this.mascot && this.platform !== 'linux') this.mascot.setIgnoreMouseEvents(!on, { forward: true });
  }

  mascotDrag(phase: DragPhase): void {
    if (!this.mascot) return;
    const cur = screen.getCursorScreenPoint();
    if (phase === 'start') {
      const [x, y] = this.mascot.getPosition();
      this.drag = { cx: cur.x, cy: cur.y, x, y };
    } else if (phase === 'move' && this.drag) {
      this.mascot.setPosition(Math.round(this.drag.x + cur.x - this.drag.cx), Math.round(this.drag.y + cur.y - this.drag.cy));
    } else if (phase === 'end') {
      this.drag = null;
    }
  }

  /* ---------------- 녹음 표시 ---------------- */

  setRecording(on: boolean): void {
    this.recording = !!on;
    this.relay({ type: 'recording', on: this.recording });
    if (this.tray) {
      if (this.platform === 'darwin') this.tray.setTitle(this.recording ? ' ● 녹음' : '');
      this.tray.setToolTip(this.recording ? 'AI 비서 — 녹음 중 (단축키를 다시 누르면 보냄)' : 'AI 비서');
    }
  }

  /* ---------------- 트레이 ---------------- */

  createTray(): void {
    try {
      const file = this.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
      const img = nativeImage.createFromPath(path.join(this.opts.appRoot, 'assets', file));
      if (this.platform === 'darwin') img.setTemplateImage(true); // 메뉴 막대 색(밝음/어두움)에 맞춰 자동 반전
      this.tray = new Tray(img);
      this.tray.setToolTip('AI 비서');
      if (this.platform !== 'darwin') this.tray.on('click', () => this.toggleChat());
      this.updateTray();
    } catch (e) {
      console.warn('트레이 아이콘을 만들지 못했습니다:', (e as Error).message);
      this.tray = null;
    }
  }

  updateTray(): void {
    if (!this.tray) return;
    const s = this.settings;
    const menu = Menu.buildFromTemplate([
      { label: '대화 창 열기', click: () => this.showChat() },
      {
        label: '바탕화면 캐릭터 (마스코트)',
        type: 'checkbox',
        checked: !!this.mascot,
        click: (item) => this.applySetting({ mascot: { ...this.settings.mascot, enabled: item.checked } })
      },
      { label: '저사양 모드', type: 'checkbox', checked: !!s.lowSpec, click: (item) => this.applySetting({ lowSpec: item.checked }) },
      { type: 'separator' },
      {
        label: this.ptt ? `말하기: ${this.pretty(this.ptt)}` : '말하기 단축키 없음',
        enabled: !!this.ptt,
        click: () => this.command('ptt')
      },
      {
        label: '항상 듣기 (호출어)',
        type: 'checkbox',
        checked: !!s.voice.wake.enabled,
        click: () => this.toggleWake()
      },
      {
        label: `${s.voice.tts ? 'TTS 끄기' : 'TTS 켜기'}${this.keys.ttsToggle ? ` (${this.pretty(this.keys.ttsToggle)})` : ''}`,
        click: () => this.toggleTts()
      },
      { type: 'separator' },
      { label: '종료', click: () => this.quit() }
    ]);
    this.tray.setContextMenu(menu);
  }

  // 트레이·마스코트에서 바꾼 설정을 저장하고 대화 창 화면에도 알린다
  applySetting(patch: Partial<Settings>): void {
    const s = this.opts.saveSettings(patch);
    this.setMascot(!!s.mascot.enabled);
    this.updateTray();
    this.command('settingsChanged');
  }

  /* ---------------- 항상 듣기(호출어) 켜기/끄기 ---------------- */

  /** 트레이·마스코트: 설정을 바꿔 저장하고 대화 창·마스코트에 알린다 (실제 마이크 켜기/끄기는 대화 창이 한다) */
  toggleWake(): boolean {
    const cur = this.settings;
    const on = !cur.voice.wake.enabled;
    this.applySetting({ voice: { ...cur.voice, wake: { ...cur.voice.wake, enabled: on } } });
    this.relay({ type: 'settings' });
    return on;
  }

  /* ---------------- 답 읽기(TTS) 켜기/끄기 ---------------- */

  /** 단축키·트레이: 설정의 "답을 소리로 읽기"를 바꿔 저장하고, 대화 창에 알린다 (읽던 소리는 대화 창이 멈춘다) */
  toggleTts(): boolean {
    const cur = this.settings;
    const on = !cur.voice.tts;
    this.opts.saveSettings({ voice: { ...cur.voice, tts: on } });
    this.updateTray();
    this.command('ttsToggled', { on });
    return on;
  }

  /* ---------------- 전역 단축키 ---------------- */

  private action(name: ShortcutName): () => void {
    return name === 'ptt' ? () => this.command('ptt') : () => void this.toggleTts();
  }

  private register(name: ShortcutName, acc: string): boolean {
    try {
      return globalShortcut.register(acc, this.action(name));
    } catch {
      return false;
    }
  }

  /**
   * 말하기·TTS 켜기/끄기 단축키를 한꺼번에 적용한다. 안 되는 것은 이전 단축키를 그대로 두고 errors에 이유를 남긴다.
   * 빈 문자열이면 그 단축키를 끈다.
   */
  setShortcuts(want: Record<ShortcutName, string>): { errors: Partial<Record<ShortcutName, string>> } {
    const errors: Partial<Record<ShortcutName, string>> = {};
    const names: ShortcutName[] = ['ptt', 'ttsToggle'];
    const next: Record<ShortcutName, string> = { ptt: String(want.ptt || '').trim(), ttsToggle: String(want.ttsToggle || '').trim() };
    for (const n of names) {
      if (!next[n]) continue;
      const bad = checkAccelerator(next[n]);
      if (bad) errors[n] = `${SHORTCUT_LABEL[n]}: ${bad} (${next[n]})`;
    }
    if (next.ptt && next.ptt === next.ttsToggle && !errors.ptt) errors.ttsToggle = `${SHORTCUT_LABEL.ttsToggle}: 말하기 단축키와 같습니다 (${next.ttsToggle})`;
    // 잘못된 것은 이전 값 유지
    for (const n of names) if (errors[n]) next[n] = this.keys[n] || '';
    if (names.every((n) => (this.keys[n] || '') === next[n])) {
      this.updateTray();
      return { errors };
    }
    const prev = { ...this.keys };
    for (const n of names) if (prev[n]) globalShortcut.unregister(prev[n] as string);
    this.keys = { ptt: null, ttsToggle: null };
    for (const n of names) {
      const acc = next[n];
      if (!acc) continue;
      if (this.register(n, acc)) {
        this.keys[n] = acc;
        continue;
      }
      if (!errors[n]) errors[n] = `${SHORTCUT_LABEL[n]}: 다른 프로그램이 이미 쓰고 있거나 쓸 수 없는 단축키입니다 (${this.pretty(acc)})`;
      const old = prev[n];
      if (old && old !== acc && !Object.values(this.keys).includes(old) && this.register(n, old)) this.keys[n] = old;
    }
    this.updateTray();
    return { errors };
  }

  quit(): void {
    this.quitting = true;
    app.quit();
  }
}
