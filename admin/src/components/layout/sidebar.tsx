import { useCallback } from 'react';
import { ChevronFirst } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { MenuConfig, MenuItem } from '@/config/types';
import {
  AccordionMenu,
  type AccordionMenuClassNames,
  AccordionMenuItem,
  AccordionMenuLabel,
} from '@/components/ui/accordion-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { size, type Account } from '@/lib/api';
import { cn, quotaPercent } from '@/lib/utils';
import { BrandLogo } from './brand-logo';
import { useLayout } from './layout-context';
import { buildSidebarMenu } from './menu-config';

export function SidebarNavContent({
  account,
  pendingReviews,
  onNavigate,
}: {
  account: Account;
  pendingReviews?: number;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const menu: MenuConfig = buildSidebarMenu(
    account.user.is_admin,
    pendingReviews,
  );
  const percent = quotaPercent(account.used_bytes, account.user.quota_bytes);

  const matchPath = useCallback(
    (path: string): boolean => {
      if (path === '/app' || path === '/app/admin') {
        return pathname === path;
      }
      return pathname === path || pathname.startsWith(`${path}/`);
    },
    [pathname],
  );

  const classNames: AccordionMenuClassNames = {
    root: 'lg:ps-1 space-y-1',
    group: 'gap-0.5',
    label:
      'uppercase text-[11px] font-semibold tracking-wider text-muted-foreground/75 pt-4 pb-1.5 first:pt-1',
    separator: '',
    item: 'h-9 rounded-lg px-2.5 text-secondary-foreground hover:bg-accent/70 hover:text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary data-[selected=true]:font-semibold transition-colors',
    sub: '',
    subTrigger: '',
    subContent: 'py-0',
    indicator: '',
  };

  return (
    <div className="flex flex-col grow min-h-0 justify-between">
      <ScrollArea className="flex grow shrink-0 py-4 px-4">
        <AccordionMenu
          selectedValue={pathname}
          matchPath={matchPath}
          type="single"
          collapsible
          classNames={classNames}
        >
          {menu.map((item: MenuItem, index: number) => {
            if (item.heading) {
              return (
                <AccordionMenuLabel key={`heading-${index}`}>
                  {item.heading}
                </AccordionMenuLabel>
              );
            }
            const Icon = item.icon;
            return (
              <AccordionMenuItem
                key={item.path || index}
                value={item.path || ''}
                className="text-[13.5px]"
              >
                <Link
                  to={item.path || '#'}
                  onClick={onNavigate}
                  title={item.title}
                  className="flex items-center justify-between grow gap-2.5 min-w-0"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    {Icon && (
                      <Icon
                        data-slot="accordion-menu-icon"
                        className="size-4.5 shrink-0"
                      />
                    )}
                    <span
                      data-slot="accordion-menu-title"
                      className="truncate"
                    >
                      {item.title}
                    </span>
                  </span>
                  {item.badge && (
                    <Badge
                      variant="warning"
                      appearance="light"
                      size="sm"
                      shape="circle"
                    >
                      {item.badge}
                    </Badge>
                  )}
                </Link>
              </AccordionMenuItem>
            );
          })}
        </AccordionMenu>
      </ScrollArea>

      <div className="sidebar-footer-expanded shrink-0 border-t border-border p-4">
        <div className="rounded-xl bg-muted/60 border border-border/70 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-muted-foreground">存储空间</span>
            <span
              className={cn(
                'font-semibold tabular-nums',
                percent >= 95
                  ? 'text-destructive'
                  : percent >= 80
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-mono',
              )}
            >
              {percent}%
            </span>
          </div>
          <Progress
            value={percent}
            indicatorClassName={cn(
              percent >= 95
                ? 'bg-destructive'
                : percent >= 80
                  ? 'bg-amber-500'
                  : 'bg-primary',
            )}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>已用 {size(account.used_bytes)}</span>
            <span>配额 {size(account.user.quota_bytes)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  account,
  pendingReviews,
}: {
  account: Account;
  pendingReviews?: number;
}) {
  const { sidebarCollapse, setSidebarCollapse, sidebarDark } = useLayout();

  return (
    <aside
      id="workspace-navigation"
      aria-label="工作台导航"
      className={cn(
        'sidebar bg-background lg:border-e lg:border-border lg:fixed lg:top-0 lg:bottom-0 lg:z-20 hidden lg:flex flex-col items-stretch shrink-0',
        sidebarDark && 'dark text-foreground',
      )}
    >
      <div className="sidebar-header hidden lg:flex items-center relative justify-between px-5 shrink-0 border-b border-border/70">
        <div className="default-logo flex items-center">
          <BrandLogo to="/app" />
        </div>
        <div className="small-logo items-center justify-center w-full">
          <BrandLogo to="/app" compact />
        </div>
        <Button
          onClick={(e) => {
            const next = !sidebarCollapse;
            setSidebarCollapse(next);
            if (next) {
              e.currentTarget.blur();
            }
          }}
          size="sm"
          mode="icon"
          variant="outline"
          aria-label={sidebarCollapse ? '展开导航' : '收起导航'}
          aria-expanded={!sidebarCollapse}
          aria-controls="workspace-navigation"
          className={cn(
            'size-7 absolute start-full top-2/4 -translate-x-2/4 -translate-y-2/4 rounded-full bg-background shadow-xs z-30',
            sidebarCollapse && 'rotate-180',
          )}
        >
          <ChevronFirst className="size-3.5!" />
        </Button>
      </div>

      <div className="overflow-hidden flex flex-col grow min-h-0">
        <div className="w-(--sidebar-default-width) flex flex-col grow min-h-0">
          <SidebarNavContent
            account={account}
            pendingReviews={pendingReviews}
          />
        </div>
      </div>
    </aside>
  );
}
