/**
 * 按钮组件
 */

import { ButtonHTMLAttributes, forwardRef } from 'react';
import { clsx } from 'clsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 变体 */
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** 大小 */
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed';

    const variantStyles = {
      primary: 'bg-gradient-to-r from-primary to-primary-600 text-white hover:from-primary-hover hover:to-primary-700 shadow-soft hover:shadow-medium transition-all',
      secondary: 'bg-background-surface text-text-primary border border-border hover:bg-background-hover hover:border-border-strong transition-all',
      danger: 'bg-danger text-white hover:bg-danger/90 shadow-soft hover:shadow-medium transition-all',
      ghost: 'text-text-primary hover:bg-background-hover transition-all',
    };

    const sizeStyles = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-base',
      lg: 'px-6 py-3 text-lg',
    };

    return (
      <button
        ref={ref}
        className={clsx(baseStyles, variantStyles[variant], sizeStyles[size], className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
