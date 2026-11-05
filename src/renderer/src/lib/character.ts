// 캐릭터 그리기. 이미지 캐릭터와 Live2D 캐릭터가 같은 모양의 함수를 가진다:
//   load / setMouth(0~1) / setExpression(name) / setState('idle'|'thinking'|'talking') / destroy()
// React 컴포넌트(CharacterView)가 DOM 요소를 넘겨 주고, 그리기 자체는 여기서 직접 한다.
import type { Character, Live2DConfig, StageState } from '@shared/types';

const encodePath = (rel: string) => String(rel).split('/').map(encodeURIComponent).join('/');

export const characterBase = (id: string) => `app://local/characters/${encodeURIComponent(id)}/`;
export const characterFileUrl = (id: string, rel: string) => characterBase(id) + encodePath(rel);

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`불러오지 못함: ${src}`));
    document.head.appendChild(s);
  });
}

export interface CharacterBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Renderer {
  bounds(): CharacterBounds | null;
  setMouth(v: number): void;
  setExpression(name: string): void;
  setState(s: StageState): void;
  destroy(): void;
}

/* ---------------- 이미지 ---------------- */

class ImageRenderer implements Renderer {
  private measuredSource = '';
  private content = { left: 0, top: 0, width: 1, height: 1 };
  constructor(private img: HTMLImageElement) {}

  load(base: string, cfg: { image?: string; icon?: string }): boolean {
    const f = cfg.image || cfg.icon;
    if (f) this.img.src = base + encodePath(f);
    else this.img.removeAttribute('src');
    this.img.classList.remove('hidden');
    return !!f;
  }

  bounds(): CharacterBounds | null {
    const img = this.img;
    if (!img.complete || !img.naturalWidth || img.classList.contains('hidden')) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const source = img.currentSrc || img.src;
    if (source !== this.measuredSource) {
      this.measuredSource = source;
      this.content = { left: 0, top: 0, width: 1, height: 1 };
      // 투명 여백을 한 번 측정한다. 작은 사본을 사용하고 원본 이미지에는 쓰지 않는다.
      try {
        const ratio = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            if (pixels[(y * canvas.width + x) * 4 + 3] <= 8) continue;
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
          if (right >= left && bottom >= top) this.content = { left: left / canvas.width, top: top / canvas.height, width: (right - left + 1) / canvas.width, height: (bottom - top + 1) / canvas.height };
        }
      } catch { /* 측정할 수 없는 이미지는 요소 크기를 사용한다. */ }
    }
    const c = this.content;
    return { left: rect.left + rect.width * c.left, top: rect.top + rect.height * c.top, width: rect.width * c.width, height: rect.height * c.height };
  }

  // 입 모양 대신 살짝 들썩이게 해서 말하는 느낌만 준다
  setMouth(v: number): void {
    this.img.style.transform = v > 0.02 ? `translateY(${(-v * 5).toFixed(1)}px) scaleY(${(1 + v * 0.015).toFixed(3)})` : '';
  }
  setExpression(): void {}
  setState(s: StageState): void {
    this.img.dataset.state = s;
  }
  destroy(): void {
    this.img.style.transform = '';
    this.img.dataset.state = '';
    this.img.classList.add('hidden');
  }
}

/* ---------------- Live2D (Cubism 4) ---------------- */

/* eslint-disable @typescript-eslint/no-explicit-any -- PixiJS 6 / pixi-live2d-display는 실행 중에 불러오는 전역 라이브러리라 타입이 없다 */
class Live2DRenderer implements Renderer {
  private static libs: Promise<void> | null = null;

  // 순서: Cubism Core → PixiJS → unsafe-eval 대체(CSP 때문) → pixi-live2d-display(cubism4)
  static ensureLibs(): Promise<void> {
    if (!Live2DRenderer.libs) {
      Live2DRenderer.libs = (async () => {
        const st = await window.app.live2d.status();
        if (!st.core) {
          throw new Error(`Cubism Core 파일(live2dcubismcore.min.js)이 없습니다. vendor 폴더 또는 ${st.userDir} 에 넣어 주세요.`);
        }
        await loadScript('app://local/vendor/live2dcubismcore.min.js');
        await loadScript('app://local/vendor/pixi.min.js');
        await loadScript('app://local/vendor/pixi-unsafe-eval.min.js');
        await loadScript('app://local/vendor/cubism4.min.js');
        if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D 라이브러리를 불러오지 못했습니다. npm install을 다시 실행하세요.');
        window.PIXI.live2d.Live2DModel.registerTicker(window.PIXI.Ticker);
      })().catch((e) => {
        Live2DRenderer.libs = null; // 다음에 다시 시도
        throw e;
      });
    }
    return Live2DRenderer.libs;
  }

  private mouth = 0;
  private cfg: Live2DConfig = { model: '' };
  private canvas: HTMLCanvasElement | null = null;
  private app: any = null;
  private model: any = null;
  private mouthId = 'ParamMouthOpenY';
  private observer: ResizeObserver | null = null;
  private onVisibility: (() => void) | null = null;

  constructor(
    private box: HTMLElement,
    private lowSpec = false
  ) {}

  async load(base: string, cfg: Live2DConfig): Promise<void> {
    await Live2DRenderer.ensureLibs();
    const PIXI = window.PIXI;
    this.cfg = cfg;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'live2d';
    this.box.appendChild(this.canvas);
    // 저사양 모드: 해상도 1배, 안티에일리어싱 끔, 초당 30프레임
    this.app = new PIXI.Application({
      view: this.canvas,
      backgroundAlpha: 0,
      antialias: !this.lowSpec,
      autoDensity: true,
      resolution: this.lowSpec ? 1 : window.devicePixelRatio || 1,
      resizeTo: this.box
    });
    this.app.ticker.maxFPS = this.lowSpec ? 30 : 60;
    // 창이 안 보이면 그리기를 멈춘다
    this.onVisibility = () => {
      if (!this.app) return;
      if (document.hidden) this.app.ticker.stop();
      else this.app.ticker.start();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    const model = await PIXI.live2d.Live2DModel.from(base + encodePath(cfg.model), { autoInteract: false });
    if (!this.app) {
      model.destroy(); // 불러오는 사이 캐릭터가 바뀜
      return;
    }
    this.model = model;
    this.app.stage.addChild(model);
    this.mouthId = (cfg.params && cfg.params.mouthOpen) || 'ParamMouthOpenY';
    // 모션이 파라미터를 덮어쓴 뒤, 그리기 직전에 입 모양을 넣는다
    model.internalModel.on('beforeModelUpdate', () => {
      if (this.mouth <= 0) return;
      try {
        model.internalModel.coreModel.setParameterValueById(this.mouthId, this.mouth);
      } catch {
        /* 모델에 그 파라미터가 없음 */
      }
    });
    this.fit();
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.box);
  }

  private fit(): void {
    if (!this.model || !this.app) return;
    const w = this.box.clientWidth;
    const h = this.box.clientHeight;
    const m = this.model;
    m.scale.set(1);
    const s = Math.min(w / m.width, h / m.height) * (Number(this.cfg.scale) || 1);
    m.scale.set(s);
    m.x = (w - m.width) / 2 + (Number(this.cfg.offsetX) || 0);
    m.y = h - m.height + (Number(this.cfg.offsetY) || 0);
  }

  setMouth(v: number): void {
    this.mouth = v;
  }

  bounds(): CharacterBounds | null {
    if (!this.model || !this.app || !this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const bounds = this.model.getBounds();
    const scaleX = rect.width / this.app.screen.width;
    const scaleY = rect.height / this.app.screen.height;
    return { left: rect.left + bounds.x * scaleX, top: rect.top + bounds.y * scaleY, width: bounds.width * scaleX, height: bounds.height * scaleY };
  }

  setExpression(name: string): void {
    const id = this.cfg.expressions && this.cfg.expressions[name];
    if (id && this.model) this.model.expression(id);
  }

  setState(s: StageState): void {
    if (!this.model) return;
    const map: Record<StageState, string> = { thinking: 'thinking', talking: 'happy', idle: 'neutral' };
    this.setExpression(map[s]);
    const group = this.cfg.motions && this.cfg.motions[s];
    if (group) this.model.motion(group);
  }

  destroy(): void {
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.observer) this.observer.disconnect();
    if (this.app) this.app.destroy(true, { children: true, texture: true, baseTexture: true });
    this.app = null;
    this.model = null;
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ---------------- 무대: 캐릭터 종류에 맞는 렌더러를 고른다 ---------------- */

export interface StageElements {
  box: HTMLElement;
  img: HTMLImageElement;
  empty: HTMLElement;
}

export class CharacterStage {
  private renderer: Renderer | null = null;
  private token = 0;

  constructor(
    private el: StageElements,
    private onNotice: (msg: string) => void = () => {}
  ) {}

  async show(character: Character | null, { lowSpec = false }: { lowSpec?: boolean } = {}): Promise<void> {
    const token = ++this.token;
    if (this.renderer) this.renderer.destroy();
    this.renderer = null;
    this.el.empty.classList.toggle('hidden', !!character);
    if (!character) return;
    const cfg = character.config || {};
    const base = characterBase(character.id);

    if (cfg.type === 'live2d' && cfg.live2d && cfg.live2d.model) {
      const r = new Live2DRenderer(this.el.box, lowSpec);
      try {
        await r.load(base, cfg.live2d);
        if (token !== this.token) return r.destroy();
        this.renderer = r;
        return;
      } catch (e) {
        r.destroy();
        if (token !== this.token) return;
        this.onNotice(`Live2D를 불러오지 못해 이미지로 표시합니다. (${(e as Error).message})`);
      }
    }
    const img = new ImageRenderer(this.el.img);
    const has = img.load(base, cfg);
    this.renderer = img;
    if (!has) this.el.empty.classList.remove('hidden');
  }

  setMouth(v: number): void {
    this.renderer?.setMouth(v);
  }
  bounds(): CharacterBounds | null {
    return this.renderer?.bounds() || null;
  }
  setState(s: StageState): void {
    this.renderer?.setState(s);
  }
  setExpression(name: string): void {
    this.renderer?.setExpression(name);
  }
  destroy(): void {
    this.token++;
    this.renderer?.destroy();
    this.renderer = null;
  }
}
