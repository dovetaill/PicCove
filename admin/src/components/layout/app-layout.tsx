import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Alert, AlertIcon, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { UploadCenterSheet } from '@/features/uploads/upload-center-sheet';
import { UploadProvider } from '@/features/uploads/upload-manager';
import { useIsMobile } from '@/hooks/use-mobile';
import { api, useMe, type Account, type AdminOverview } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CommandPalette } from './command-palette';
import { Header } from './header';
import { LayoutProvider, useLayout } from './layout-context';
import { Sidebar } from './sidebar';

export function AdminOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return null;
  return me.data?.user.is_admin ? children : <Navigate to="/app" replace />;
}

function WorkspaceShell({ account }: { account: Account }) {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const { sidebarCollapse, uploadSheetOpen, setUploadSheetOpen } = useLayout();
  const isFullHeightStudio = pathname === '/app/ai';

  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<AdminOverview>('/admin/overview'),
    enabled: account.user.is_admin,
    refetchInterval: 30000,
    retry: false,
  });

  useEffect(() => {
    const body = document.body.classList;
    if (sidebarCollapse) {
      body.add('sidebar-collapse');
    } else {
      body.remove('sidebar-collapse');
    }
  }, [sidebarCollapse]);

  useEffect(() => {
    const body = document.body.classList;
    body.add('demo1', 'sidebar-fixed', 'header-fixed');
    const timer = window.setTimeout(() => {
      body.add('layout-initialized');
    }, 300);
    return () => {
      body.remove(
        'demo1',
        'sidebar-fixed',
        'sidebar-collapse',
        'header-fixed',
        'layout-initialized',
      );
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div
      className={cn(
        'demo1 sidebar-fixed header-fixed flex min-h-dvh w-full',
        sidebarCollapse && 'sidebar-collapse',
      )}
    >
      {!isMobile && (
        <Sidebar
          account={account}
          pendingReviews={overview.data?.reviews_pending}
        />
      )}

      <div className="wrapper flex grow flex-col min-w-0">
        <Header
          account={account}
          pendingReviews={overview.data?.reviews_pending}
        />

        <main
          role="main"
          className={cn(
            'grow min-w-0',
            isFullHeightStudio ? 'flex flex-col' : 'py-6',
          )}
        >
          {account.user.content_ban && (
            <div className={cn(isFullHeightStudio ? 'px-4 pt-3' : 'container mb-5')}>
              <Alert variant="destructive" appearance="light">
                <AlertIcon>
                  <AlertTriangle />
                </AlertIcon>
                <AlertTitle>
                  当前账号因违规（累计 {account.user.violation_count} 次）已被限制上传、生图及新增公开分享，如有疑问请联系管理员。
                </AlertTitle>
              </Alert>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <CommandPalette account={account} />
      <UploadCenterSheet
        open={uploadSheetOpen}
        onOpenChange={setUploadSheetOpen}
      />
    </div>
  );
}

export function AppLayout() {
  const me = useMe();
  const queryClient = useQueryClient();
  const prevOwnerRef = useRef<string | null>(null);

  useEffect(() => {
    const nextId = me.data?.user.id ?? null;
    if (prevOwnerRef.current && prevOwnerRef.current !== nextId) {
      queryClient.removeQueries({
        predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'settings',
      });
    }
    prevOwnerRef.current = nextId;
  }, [me.data?.user.id, queryClient]);

  if (me.isPending) {
    return (
      <div
        role="status"
        className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-muted-foreground"
      >
        <LoaderCircle className="size-6 animate-spin text-primary" />
        <span className="text-sm font-medium">正在进入图湾工作台…</span>
      </div>
    );
  }

  if (me.isError && !me.data) {
    return (
      <div
        role="alert"
        className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center"
      >
        <p className="text-sm text-muted-foreground">无法连接工作台服务</p>
        <Button variant="outline" onClick={() => void me.refetch()}>
          重新加载
        </Button>
      </div>
    );
  }

  if (!me.data) {
    return <Navigate to="/login" replace />;
  }

  return (
    <LayoutProvider>
      <UploadProvider key={me.data.user.id} owner={me.data.user.id}>
        <WorkspaceShell key={me.data.user.id} account={me.data} />
      </UploadProvider>
    </LayoutProvider>
  );
}
