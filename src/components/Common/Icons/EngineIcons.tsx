import type { IconProps } from './types';

/** AI 引擎图标 - 芯片样式 */
export function IconAIEngine({ size = 16, className = '', ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      {...props}
    >
      <rect
        x="3"
        y="3"
        width="10"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle
        cx="8"
        cy="8"
        r="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 1V3M8 13V15M1 8H3M13 8H15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M3.5 3.5L2 2M3.5 12.5L2 14M12.5 3.5L14 2M12.5 12.5L14 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** API/服务器图标 */
export function IconAPI({ size = 16, className = '', ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      {...props}
    >
      <rect
        x="2"
        y="4"
        width="12"
        height="8"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle
        cx="5"
        cy="8"
        r="1"
        fill="currentColor"
      />
      <circle
        cx="8"
        cy="8"
        r="1"
        fill="currentColor"
      />
      <circle
        cx="11"
        cy="8"
        r="1"
        fill="currentColor"
      />
    </svg>
  );
}

/** 翻译/语言图标 */
export function IconTranslate({ size = 16, className = '', ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2.5 8H13.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 1.5C8 1.5 5.5 4 5.5 8C5.5 12 8 14.5 8 14.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 1.5C8 1.5 10.5 4 10.5 8C10.5 12 8 14.5 8 14.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** 聊天机器人图标 */
export function IconBot({ size = 16, className = '', ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      {...props}
    >
      <rect
        x="2.5"
        y="4"
        width="11"
        height="9"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5.5 8V9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M10.5 8V9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M6.5 11.5H9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8 1V4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle
        cx="8"
        cy="1"
        r="0.5"
        fill="currentColor"
      />
    </svg>
  );
}

/** 窗口图标 */
export function IconWindow({ size = 16, className = '', ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      {...props}
    >
      <rect
        x="2"
        y="3"
        width="12"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2 6H14"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle
        cx="4.5"
        cy="4.5"
        r="0.5"
        fill="currentColor"
      />
      <circle
        cx="6.5"
        cy="4.5"
        r="0.5"
        fill="currentColor"
      />
    </svg>
  );
}
