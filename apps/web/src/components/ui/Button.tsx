import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'outline' | 'danger' | 'ghost';

const variantClass: Record<Variant, string> = {
  primary: 'btn-primary',
  outline: 'btn-outline',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', className = '', children, ...rest }: ButtonProps) {
  const classes = ['btn', variantClass[variant], className].filter(Boolean).join(' ');
  // `type` defaults to "button": a bare button inside a form submits it.
  return (
    <button className={classes} {...rest} type={rest.type ?? 'button'}>
      {children}
    </button>
  );
}
