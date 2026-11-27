import { type MouseEventHandler } from 'react';
import { Waves } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function BrandLogo({
  to = '/',
  compact = false,
  className,
  onClick,
}: {
  to?: string;
  compact?: boolean;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2.5 select-none group focus-visible:outline-hidden',
        className,
      )}
    >
      <span className="flex size-8.5 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs transition-transform group-hover:scale-[1.02]">
        <Waves className="size-4.5" />
      </span>
      {!compact && (
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[17px] font-semibold tracking-tight text-mono">
            PicCove
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            图湾
          </span>
        </span>
      )}
    </Link>
  );
}
