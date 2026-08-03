/**
 * Spider-Man 沉浸主题工具函数
 *
 * 集中管理 CSS 变量同步逻辑，消除 main.tsx / themeStore.ts / ThemeTab.tsx 中的重复代码。
 * 所有三处统一调用此文件中的函数，避免一处改漏导致不一致。
 */

/** Spider-Man 主题默认背景图 */
const SPIDERMAN_DEFAULT_BG = 'https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920';

/** 图片亮度缓存（0-255，null=未检测），存储在 localStorage 中 */
const BRIGHTNESS_KEY = 'spiderman-brightness';

function getCachedBrightness(): number | null {
  try {
    const v = window.localStorage.getItem(BRIGHTNESS_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function setCachedBrightness(value: number): void {
  try {
    window.localStorage.setItem(BRIGHTNESS_KEY, String(Math.round(value)));
  } catch { /* ignore */ }
}

/** 从 localStorage 读取 spiderman-theme 配置 */
export function readSpiderManConfig(): Record<string, unknown> {
  try {
    const stored = window.localStorage.getItem('spiderman-theme');
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/** 将 spidermanTheme 保存到 localStorage（供 syncSpiderManCssVarsToDom 读取） */
export function saveSpiderManConfig(config: Record<string, unknown>): void {
  try {
    window.localStorage.setItem('spiderman-theme', JSON.stringify(config));
  } catch {
    // localStorage 可能已满，静默失败
  }
}

/**
 * 使用 canvas 检测图片平均亮度（0-255）。
 * 缩放到 32×32 像素检测，兼顾性能与准确性。
 */
export function detectImageBrightness(url: string): Promise<number> {
  return new Promise((resolve) => {
    if (!url) { resolve(0); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(128); return; }
        ctx.drawImage(img, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          // 标准亮度感知公式: 0.299*R + 0.587*G + 0.114*B
          total += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        const avg = total / (data.length / 4);
        resolve(avg);
      } catch {
        resolve(128); // 检测失败时假设中等亮度
      }
    };
    img.onerror = () => resolve(128);
    img.src = url;
  });
}

/**
 * 检测背景图片亮度并缓存到 localStorage。
 * 返回亮度值（0-255），供后续 CSS 变量同步使用。
 */
export async function detectAndCacheBrightness(url: string): Promise<number> {
  const brightness = await detectImageBrightness(url);
  setCachedBrightness(brightness);
  return brightness;
}

/**
 * 根据用户偏好 opacity 和图片亮度，计算自适应遮罩强度。
 *
 * 核心逻辑：
 * - 用户控制 bgOpacity（0-1），表示"希望背景多清晰"
 * - 用户期望的遮罩 = 1 - bgOpacity
 * - 但图片越亮，所需最低遮罩越高，否则文字不可读
 * - 自适应遮罩 = max(用户期望遮罩, 亮度决定的最低遮罩)
 *
 * 最低遮罩映射：
 *   亮度 0   (纯黑) → 最低遮罩 0.15 (几乎全透)
 *   亮度 128 (中灰) → 最低遮罩 0.40
 *   亮度 255 (纯白) → 最低遮罩 0.65 (强遮罩)
 */
export function computeAdaptiveOverlay(
  userOpacity: number,
  imageBrightness: number | null,
): number {
  const userOverlay = 1 - userOpacity; // 用户期望的遮罩强度
  if (imageBrightness === null) return userOverlay; // 无亮度信息时用用户值

  // 亮度 → 最低遮罩：线性映射
  // 0 → 0.15, 128 → 0.40, 255 → 0.65
  const minOverlay = 0.15 + (imageBrightness / 255) * 0.5;

  return Math.max(userOverlay, Math.min(minOverlay, 0.95));
}

/**
 * 同步 Spider-Man CSS 变量到 DOM
 *
 * 从 localStorage 读取 spiderman-theme 配置，将 CSS 变量写入 document.documentElement。
 * 与 main.tsx 内联脚本保持完全一致的逻辑，确保首屏加载不闪烁。
 *
 * 关键改进：使用自适应遮罩（computeAdaptiveOverlay），根据图片亮度自动调整。
 *
 * @param config 可选配置对象，不传则从 localStorage 读取
 * @param brightness 可选图片亮度值（0-255），不传则从缓存读取
 */
export function syncSpiderManCssVarsToDom(
  config?: Record<string, unknown>,
  brightness?: number | null,
): void {
  if (typeof document === 'undefined') return;

  const cfg = config ?? readSpiderManConfig();

  // 明确检查用户是否选择了「关闭背景」（backgroundImage === ''）
  const bgOff = 'backgroundImage' in cfg && !cfg.backgroundImage;
  const bg = bgOff ? '' : ((cfg.backgroundImage as string) || SPIDERMAN_DEFAULT_BG);

  if (bgOff || !bg) {
    document.documentElement.setAttribute('data-spiderman-bg-off', '');
  } else {
    document.documentElement.style.setProperty('--spiderman-bg-image', `url('${bg}')`);
    document.documentElement.removeAttribute('data-spiderman-bg-off');
  }

  // ===== 自适应遮罩计算 =====
  // 读取亮度缓存（参数优先，其次缓存，最后 null）
  const imgBrightness = brightness ?? getCachedBrightness();
  const bgOpacity = (cfg.backgroundOpacity as number) ?? 0.2;

  // 用户期望的遮罩 = 1 - bgOpacity
  const userOverlay = Math.max(0, Math.min(1, 1 - bgOpacity));

  // 自适应遮罩 = max(用户期望, 亮度最低要求)
  const adaptiveOverlay = computeAdaptiveOverlay(bgOpacity, imgBrightness);

  // 写入实际生效的遮罩值
  document.documentElement.style.setProperty('--spiderman-bg-overlay', String(adaptiveOverlay));

  // 写入用户期望值（供 UI 显示差异）
  document.documentElement.style.setProperty('--spiderman-user-overlay', String(userOverlay));

  // 写入图片亮度值（供 UI 使用）
  if (imgBrightness !== null) {
    document.documentElement.dataset.spidermanBrightness = String(Math.round(imgBrightness));
  }

  // 写入自适应 vs 用户期望的差值（用于 UI 高亮）
  const diff = adaptiveOverlay - userOverlay;
  document.documentElement.style.setProperty('--spiderman-overlay-boost', String(diff > 0.02 ? diff : 0));

  // 蛛网纹理透明度
  document.documentElement.style.setProperty('--spiderman-web-opacity', String((cfg.webTextureOpacity as number) ?? 0.15));

  // 背景位置
  document.documentElement.style.setProperty(
    '--spiderman-bg-position',
    `${(cfg.backgroundPositionX as number) ?? 50}% ${(cfg.backgroundPositionY as number) ?? 50}%`,
  );

  // 背景缩放
  document.documentElement.style.setProperty('--spiderman-bg-size', (cfg.backgroundSize as string) ?? 'cover');

  // 面板透明度
  document.documentElement.style.setProperty('--spiderman-panel-opacity', String((cfg.panelOpacity as number) ?? 0.55));

  // 内容卡片透明度
  document.documentElement.style.setProperty('--spiderman-surface-opacity', String((cfg.surfaceOpacity as number) ?? 0.5));

  // 面板磨砂强度（0 → none 避免创建叠加上下文）
  const blur = (cfg.panelBlur as number) ?? 8;
  document.documentElement.style.setProperty('--spiderman-panel-blur', blur > 0 ? `blur(${blur}px)` : 'none');

  // 同步面具头像 URL
  if (cfg.avatarUrl) {
    document.documentElement.style.setProperty('--spiderman-avatar-url', `url('${cfg.avatarUrl}')`);
  } else {
    document.documentElement.style.removeProperty('--spiderman-avatar-url');
  }

  // 蓝色强调强度
  document.documentElement.style.setProperty(
    '--spiderman-blue-accent',
    String((cfg.blueAccent as number) ?? 0.5)
  );
}