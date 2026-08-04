/**
 * 主题预设资产 — 预设头像列表
 *
 * 从旧 ThemeTab SPIDERMAN_MASKS 迁移，通用化为任意沉浸主题可用的头像选择。
 */

export interface PresetAvatar {
  src: string;
  label: string;
}

export const PRESET_AVATARS: PresetAvatar[] = [
  { src: '/spiderman/062a7b7e3de3931c1f2892c3268fc09d.jpg', label: '本地头像 1' },
  { src: '/spiderman/09fca96a312390d96dcad588fd3ef02a.jpg', label: '本地头像 2' },
  { src: '/spiderman/1c28d5d56749d9244e5bea157668dad5.jpg', label: '本地头像 3' },
  { src: '/spiderman/b34f8cb8d3e94d6c49b52e520904183d.jpg', label: '本地头像 4' },
];

/**
 * 预设背景壁纸列表
 * 提供多种风格的高质量 Unsplash 背景图，用户可一键选用
 */
export interface PresetBackground {
  src: string;
  label: string;
  /** 预览缩略图，不设置时使用 src 原图 */
  thumbnail?: string;
}

export const PRESET_BACKGROUNDS: PresetBackground[] = [
  { src: '/spiderman/062a7b7e3de3931c1f2892c3268fc09d.jpg', label: '本地背景 1' },
  { src: '/spiderman/09fca96a312390d96dcad588fd3ef02a.jpg', label: '本地背景 2' },
  { src: '/spiderman/1c28d5d56749d9244e5bea157668dad5.jpg', label: '本地背景 3' },
  { src: '/spiderman/b34f8cb8d3e94d6c49b52e520904183d.jpg', label: '本地背景 4' },
];
