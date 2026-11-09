import { forwardRef } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'accent' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  asChild?: boolean;
}

export const buttonVariants = ({ variant = 'accent', size = 'md', className }: Partial<ButtonProps> & { className?: string }) => {
  return cn(
    'inline-flex items-center justify-center font-bold rounded-pill transition-all duration-300 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4',
    {
      'bg-accent text-accent-fg hover:opacity-90 shadow-glow': variant === 'accent',
      'bg-transparent border border-accent-edge text-accent-strong hover:bg-accent hover:text-accent-fg': variant === 'outline',
      'bg-transparent hover:bg-surface text-fg': variant === 'ghost',
    },
    {
      'px-4 py-2 text-sm': size === 'sm',
      'px-6 py-3 text-sm md:text-base': size === 'md',
      'px-8 py-4 md:px-10 md:py-5 text-lg md:text-xl': size === 'lg',
    },
    className
  );
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={buttonVariants({ variant, size, className })}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';
