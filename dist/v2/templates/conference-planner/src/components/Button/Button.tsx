'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & Readonly<{
  children: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  pressed?: boolean;
  variant?: 'primary' | 'secondary';
}>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  className,
  disabled = false,
  loading = false,
  loadingLabel = 'Loading',
  pressed,
  type = 'button',
  variant = 'primary',
  ...buttonProps
}, ref) {
  const classes = [styles.button, variant === 'secondary' ? styles.secondary : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...buttonProps}
      aria-busy={loading || undefined}
      aria-pressed={pressed}
      className={classes}
      disabled={disabled || loading}
      ref={ref}
      type={type}
    >
      {loading ? <span aria-hidden="true" className={styles.spinner} /> : null}
      {loading ? loadingLabel : children}
    </button>
  );
});
