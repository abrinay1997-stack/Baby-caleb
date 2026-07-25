import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SectionHeaderProps {
  kicker: string;
  title: string;
  description?: string;
  centered?: boolean;
  className?: string;
}

export function SectionHeader({ kicker, title, description, centered = false, className }: SectionHeaderProps) {
  return (
    <div className={cn('mb-16 md:mb-24', centered ? 'text-center' : '', className)}>
      <span className="mono text-accent mb-6 block">{kicker}</span>
      <h2 className={cn('text-3xl md:text-5xl text-fg text-balance leading-tight', centered ? 'mx-auto' : 'max-w-2xl', description ? 'mb-8' : '')}>
        {title}
      </h2>
      {description && (
        <p className={cn('text-muted text-lg leading-relaxed', centered ? 'mx-auto max-w-2xl' : 'max-w-md')}>
          {description}
        </p>
      )}
    </div>
  );
}
