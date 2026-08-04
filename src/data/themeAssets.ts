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
  { src: 'https://www.pngmart.com/files/10/Spider-Man-Mask-Logo-PNG-Transparent-Image.png', label: '经典面具 1' },
  { src: 'https://www.pngarts.com/files/3/Spider-Man-Mask-Transparent-Background-PNG.png', label: '经典面具 2' },
  { src: 'https://purepng.com/public/uploads/large/purepng.com-spider-man-maskspider-manspidermansuperherocomic-bookmarvel-comicscharacterstan-lee-1701528655211dzh6y.png', label: '经典面具 3' },
  { src: 'https://www.pngmart.com/files/10/Spider-Man-Mask-Logo-PNG-Photos.png', label: '经典面具 4' },
  { src: 'https://www.citypng.com/public/uploads/preview/hd-mask-spiderman-realistic-png-735811696952449ro3pyf5lqp.png', label: '写实面具' },
  { src: 'https://www.pngplay.com/wp-content/uploads/15/Spiderman-Mask-Transparent-PNG.png', label: '透明面具' },
  { src: 'https://www.citypng.com/public/uploads/preview/hd-mask-spiderman-3d-png-11695958056q2ii6wyjfz.png', label: '3D 面具' },
  { src: 'https://media3.giphy.com/media/gjJHFL9KPkbLErYPrr/giphy.gif', label: '动态蜘蛛感应' },
  { src: '/spiderman/062a7b7e3de3931c1f2892c3268fc09d.jpg', label: '本地头像 1' },
  { src: '/spiderman/09fca96a312390d96dcad588fd3ef02a.jpg', label: '本地头像 2' },
  { src: '/spiderman/1c28d5d56749d9244e5bea157668dad5.jpg', label: '本地头像 3' },
  { src: '/spiderman/b34f8cb8d3e94d6c49b52e520904183d.jpg', label: '本地头像 4' },
];
