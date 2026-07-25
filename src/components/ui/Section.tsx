import { forwardRef } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  variant?: 'bg' | 'surface' | 'sage';
  containerSize?: 'normal' | 'wide' | 'none';
  containerClassName?: string;
  padding?: boolean;
}

export const Section = forwardRef<HTMLElement, SectionProps>(
  ({ children, className, variant = 'bg', containerSize = 'normal', containerClassName, padding = true, ...props }, ref) => {
    
    const bgClasses = {
      'bg': 'bg-bg',
      'surface': 'bg-surface',
      'sage': 'bg-sage text-bg',
    };

    const containerClasses = {
      'normal': 'container-normal',
      'wide': 'container-wide',
      'none': '',
    };

    return (
      <section
        ref={ref}
        className={cn(
          bgClasses[variant],
          padding && 'section-padding',
          className
        )}
        {...props}
      >
        <div className={cn(containerClasses[containerSize], containerClassName)}>
          {children}
        </div>
      </section>
    );
  }
);

Section.displayName = 'Section';
