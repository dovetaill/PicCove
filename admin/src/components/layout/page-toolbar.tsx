import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-4 pb-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolbarHeading({
  title,
  description,
  badge,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-center gap-1.5 min-w-0">
      {title && (
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-mono wrap-anywhere">
            {title}
          </h1>
          {badge}
        </div>
      )}
      {description && (
        <p className="text-sm text-muted-foreground leading-relaxed wrap-anywhere">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}

export function ToolbarActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', className)}>
      {children}
    </div>
  );
}
