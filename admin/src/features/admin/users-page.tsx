import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ColumnDef,
  getCoreRowModel,
  type PaginationState,
  useReactTable,
} from '@tanstack/react-table';
import {
  Ban,
  Images,
  Search,
  Settings2,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from '@/components/layout/page-toolbar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardFooter,
  CardHeader,
  CardTable,
} from '@/components/ui/card';
import { DataGrid } from '@/components/ui/data-grid';
import { DataGridPagination } from '@/components/ui/data-grid-pagination';
import { DataGridTable } from '@/components/ui/data-grid-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage, size, type Account, type Page } from '@/lib/api';
import { cn, formatDateTime, quotaPercent } from '@/lib/utils';

const QUOTA_PRESETS_MIB = [
  ['512 MiB', 512],
  ['1 GiB', 1024],
  ['5 GiB', 5120],
  ['10 GiB', 10240],
  ['50 GiB', 51200],
] as const;

export function UsersPage() {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 48,
  });
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [quotaMib, setQuotaMib] = useState('1024');
  const [quotaDirty, setQuotaDirty] = useState(false);
  const [disabledFlag, setDisabledFlag] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [confirmBanToggle, setConfirmBanToggle] = useState(false);
  const [confirmReset2fa, setConfirmReset2fa] = useState(false);
  const [busy, setBusy] = useState(false);

  const client = useQueryClient();

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(searchInput.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [debouncedQuery, statusFilter]);

  const page = pagination.pageIndex + 1;
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (debouncedQuery) params.set('q', debouncedQuery);
  if (statusFilter !== 'all') params.set('status', statusFilter);

  const users = useQuery({
    queryKey: ['users', page, debouncedQuery, statusFilter],
    queryFn: () => api<Page<Account>>(`/admin/users?${params.toString()}`),
  });

  const items = users.data?.items || [];
  const totalCount =
    users.data?.total ??
    (users.data?.has_more ? page * 48 + 1 : (page - 1) * 48 + items.length);

  const editingAccount = items.find((a) => a.user.id === editingId) || null;

  useEffect(() => {
    if (
      !users.isPending &&
      !users.isFetching &&
      !users.isError &&
      pagination.pageIndex > 0 &&
      items.length === 0
    ) {
      setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }));
    }
  }, [
    users.isPending,
    users.isFetching,
    users.isError,
    items.length,
    pagination.pageIndex,
  ]);

  function openManageSheet(account: Account) {
    setEditingId(account.user.id);
    setQuotaMib(
      String(Number((account.user.quota_bytes / 1024 / 1024).toFixed(2))),
    );
    setQuotaDirty(false);
    setDisabledFlag(account.user.disabled);
    setResetPassword('');
  }

  async function handleCreateUser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    if (new TextEncoder().encode(password).length < 12) {
      toast.error('初始密码至少需要 12 个字节');
      return;
    }
    setBusy(true);
    try {
      await api('/admin/users', 'POST', { username, password });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['users'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      toast.success(`用户 ${username} 已创建`);
      setCreateOpen(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveUser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editingAccount || busy) return;
    if (
      resetPassword &&
      new TextEncoder().encode(resetPassword).length < 12
    ) {
      toast.error('重置密码至少需要 12 个字节');
      return;
    }
    setBusy(true);
    try {
      await api(`/admin/users/${editingAccount.user.id}`, 'PATCH', {
        quota_bytes: quotaDirty
          ? Math.round(Number(quotaMib) * 1024 * 1024)
          : editingAccount.user.quota_bytes,
        disabled: disabledFlag,
        password: resetPassword || null,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['users'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
      ]);
      toast.success('用户配置已保存');
      setResetPassword('');
      setEditingId(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleExempt(exempt: boolean) {
    if (!editingAccount || busy) return;
    setBusy(true);
    try {
      await api(`/admin/users/${editingAccount.user.id}/moderation`, 'PATCH', {
        exempt,
      });
      await client.invalidateQueries({ queryKey: ['users'] });
      toast.success(exempt ? '已加入免审白名单' : '已移出免审白名单');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleContentBan() {
    if (!editingAccount || busy) return;
    setBusy(true);
    try {
      const command = editingAccount.user.content_ban ? 'unban' : 'ban';
      await api(`/admin/users/${editingAccount.user.id}/moderation`, 'PATCH', {
        action: command,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['users'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      toast.success(command === 'ban' ? '已执行内容封禁' : '已解除内容封禁');
      setConfirmBanToggle(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetUser2fa() {
    if (!editingAccount || busy) return;
    setBusy(true);
    try {
      await api(`/admin/users/${editingAccount.user.id}/reset-2fa`, 'POST');
      await client.invalidateQueries({ queryKey: ['users'] });
      toast.success('已清除该用户的二步验证并下线旧会话');
      setConfirmReset2fa(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<ColumnDef<Account>[]>(
    () => [
      {
        id: 'user',
        header: '用户',
        cell: ({ row }) => {
          const u = row.original.user;
          return (
            <div className="flex items-center gap-3 min-w-[180px]">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm border border-primary/20">
                {u.username.slice(0, 1).toUpperCase()}
              </span>
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-mono truncate">
                    {u.username}
                  </span>
                  {u.is_admin && (
                    <Badge size="xs" variant="primary" appearance="light">
                      管理员
                    </Badge>
                  )}
                </div>
                {u.created_at && (
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    创建于 {formatDateTime(u.created_at)}
                  </p>
                )}
              </div>
            </div>
          );
        },
        size: 240,
      },
      {
        id: 'status',
        header: '账号状态',
        cell: ({ row }) =>
          row.original.user.disabled ? (
            <Badge size="sm" variant="destructive" appearance="light">
              已禁用
            </Badge>
          ) : (
            <Badge size="sm" variant="success" appearance="light">
              正常
            </Badge>
          ),
        size: 110,
      },
      {
        id: 'moderation',
        header: '审核与合规',
        cell: ({ row }) => {
          const u = row.original.user;
          return (
            <div className="flex flex-wrap items-center gap-1.5 min-w-[160px]">
              {u.content_ban ? (
                <Badge size="sm" variant="destructive" appearance="light">
                  {u.content_ban === 'auto' ? '自动封禁' : '手动封禁'}
                </Badge>
              ) : u.is_admin || u.moderation_exempt ? (
                <Badge size="sm" variant="info" appearance="light">
                  免审白名单
                </Badge>
              ) : (
                <Badge size="sm" variant="secondary" appearance="light">
                  常规审核
                </Badge>
              )}
              {u.violation_count > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  违规 {u.violation_count} 次
                </span>
              )}
            </div>
          );
        },
        size: 190,
      },
      {
        id: 'quota',
        header: '存储配额使用',
        cell: ({ row }) => {
          const { used_bytes, user } = row.original;
          const pct = quotaPercent(used_bytes, user.quota_bytes);
          return (
            <div className="space-y-1.5 min-w-[200px] max-w-[240px]">
              <div className="flex items-center justify-between text-xs tabular-nums">
                <span className="font-medium text-mono">
                  {size(used_bytes)}{' '}
                  <span className="text-muted-foreground font-normal">
                    / {size(user.quota_bytes)}
                  </span>
                </span>
                <span className="text-muted-foreground">{pct}%</span>
              </div>
              <Progress
                value={pct}
                indicatorClassName={cn(
                  pct >= 95
                    ? 'bg-destructive'
                    : pct >= 80
                      ? 'bg-amber-500'
                      : 'bg-primary',
                )}
              />
            </div>
          );
        },
        size: 240,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const account = row.original;
          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" asChild>
                <Link
                  to={`/app/admin/images?user=${account.user.id}&username=${encodeURIComponent(account.user.username)}`}
                >
                  <Images className="size-3.5" />
                  图片
                </Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openManageSheet(account)}
              >
                <Settings2 className="size-3.5" />
                管理
              </Button>
            </div>
          );
        },
        size: 150,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: items,
    columns,
    pageCount: Math.max(1, Math.ceil(totalCount / 48)),
    state: { pagination },
    onPaginationChange: setPagination,
    manualPagination: true,
    getRowId: (row) => row.user.id,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="container space-y-5">
      <Toolbar className="pb-1">
        <ToolbarHeading
          title="用户与配额"
          description="创建平台账号、分配存储配额、管理登录权限与内容审核白名单"
          badge={
            users.data?.total !== undefined ? (
              <Badge variant="secondary" appearance="light" size="sm">
                {users.data.total} 位用户
              </Badge>
            ) : undefined
          }
        />
        <ToolbarActions>
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus />
            创建用户
          </Button>
        </ToolbarActions>
      </Toolbar>

      <DataGrid
        table={table}
        recordCount={totalCount}
        isLoading={users.isPending}
        emptyMessage="未找到匹配的用户账号"
      >
        <Card>
          <CardHeader className="py-3.5">
            <div className="flex flex-wrap items-center gap-2.5 w-full">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="size-3.5 text-muted-foreground absolute start-2.5 top-1/2 -translate-y-1/2" />
                <Input
                  variant="sm"
                  value={searchInput}
                  maxLength={100}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="搜索用户名…"
                  aria-label="搜索用户名"
                  className="ps-8 pe-7"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput('')}
                    className="cursor-pointer absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  aria-label="用户状态筛选"
                  size="sm"
                  className="w-[130px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部用户</SelectItem>
                  <SelectItem value="active">正常可用</SelectItem>
                  <SelectItem value="disabled">已禁用账号</SelectItem>
                  <SelectItem value="banned">内容封禁</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>

          {users.isError ? (
            <div role="alert" className="p-10 text-center space-y-3">
              <p className="text-sm text-destructive">
                {errorMessage(users.error)}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void users.refetch()}
              >
                重试
              </Button>
            </div>
          ) : (
            <CardTable>
              <ScrollArea>
                <DataGridTable />
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </CardTable>
          )}

          <CardFooter>
            <DataGridPagination />
          </CardFooter>
        </Card>
      </DataGrid>

      {/* Create User Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          if (!busy) setCreateOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>创建新用户</DialogTitle>
            <DialogDescription>
              新账号默认分配 1 GiB 存储配额，创建后可在管理抽屉中随时调整
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => void handleCreateUser(e)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="new-user-name">用户名</Label>
              <Input
                id="new-user-name"
                name="username"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_\-]{3,32}"
                title="3–32 位字母、数字、下划线或连字符"
                autoComplete="off"
                placeholder="3–32 位字母、数字、下划线或连字符"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-user-pwd">初始密码</Label>
              <Input
                id="new-user-pwd"
                name="password"
                type="password"
                required
                maxLength={128}
                autoComplete="new-password"
                placeholder="至少 12 个字节"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '创建中…' : '创建账号'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Right-hand User Governance Sheet */}
      <Sheet
        open={!!editingAccount}
        onOpenChange={(open) => {
          if (!open && !busy) setEditingId(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 gap-0 flex flex-col"
        >
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle>
              管理用户 · {editingAccount?.user.username}
            </SheetTitle>
            <SheetDescription>
              调整容量配额、重置登录密码或变更内容治理策略
            </SheetDescription>
          </SheetHeader>

          {editingAccount && (
            <ScrollArea className="flex-1 px-6 py-5">
              <div className="space-y-6">
                {/* Storage Summary */}
                <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">当前已用空间</span>
                    <span className="font-semibold text-mono tabular-nums">
                      {size(editingAccount.used_bytes)} /{' '}
                      {size(editingAccount.user.quota_bytes)}
                    </span>
                  </div>
                  <Progress
                    value={quotaPercent(
                      editingAccount.used_bytes,
                      editingAccount.user.quota_bytes,
                    )}
                  />
                </div>

                {/* Quota, Password & Disabled Form */}
                <form
                  onSubmit={(e) => void handleSaveUser(e)}
                  className="space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor="edit-user-quota">容量配额（MiB）</Label>
                    <Input
                      id="edit-user-quota"
                      type="number"
                      required
                      min={0}
                      max={8583068847}
                      step="any"
                      value={quotaMib}
                      onChange={(e) => {
                        setQuotaMib(e.target.value);
                        setQuotaDirty(true);
                      }}
                    />
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {QUOTA_PRESETS_MIB.map(([label, mib]) => (
                        <Button
                          key={label}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => {
                            setQuotaMib(String(mib));
                            setQuotaDirty(true);
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="edit-user-pwd">
                      重置登录密码（留空则不修改）
                    </Label>
                    <Input
                      id="edit-user-pwd"
                      type="password"
                      maxLength={128}
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder="输入新密码以强制重置并下线旧会话"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3.5">
                    <div>
                      <p className="text-sm font-medium text-mono">禁用账号登录</p>
                      <p className="text-xs text-muted-foreground">
                        撤销全部登录会话并禁止新上传（已有外链保留）
                      </p>
                    </div>
                    <Switch
                      checked={disabledFlag}
                      disabled={editingAccount.user.is_admin}
                      onCheckedChange={setDisabledFlag}
                      aria-label="禁用账号"
                    />
                  </div>

                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? '保存中…' : '保存配额与账号设置'}
                  </Button>
                </form>

                {/* Moderation Controls */}
                <div className="border-t border-border pt-5 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    内容审核治理
                  </h3>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3.5">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium text-mono flex items-center gap-1.5">
                        <ShieldCheck className="size-4 text-primary" />
                        免审白名单
                      </p>
                      <p className="text-xs text-muted-foreground">
                        新上传与 AI 生成图片跳过自动视觉审核
                      </p>
                    </div>
                    <Switch
                      checked={
                        editingAccount.user.is_admin ||
                        editingAccount.user.moderation_exempt
                      }
                      disabled={busy || editingAccount.user.is_admin}
                      onCheckedChange={(v) => void handleToggleExempt(v)}
                      aria-label="审核白名单"
                    />
                  </div>

                  {!editingAccount.user.is_admin &&
                    editingAccount.user.totp_enabled && (
                      <div className="rounded-xl border border-border p-3.5 flex items-center justify-between gap-3">
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium text-mono">
                            二步验证器（已开启）
                          </p>
                          <p className="text-xs text-muted-foreground">
                            用户丢失手机或恢复码时可协助清除 2FA
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setConfirmReset2fa(true)}
                        >
                          重置二步验证
                        </Button>
                      </div>
                    )}

                  {!editingAccount.user.is_admin && (
                    <div className="rounded-xl border border-border p-3.5 flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium text-mono">
                          累计违规：{editingAccount.user.violation_count} 次
                        </p>
                        <p className="text-xs text-muted-foreground">
                          状态：
                          {editingAccount.user.content_ban === 'auto'
                            ? '自动触发内容封禁'
                            : editingAccount.user.content_ban === 'manual'
                              ? '管理员手动封禁'
                              : '正常允许创作与分享'}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={
                          editingAccount.user.content_ban
                            ? 'outline'
                            : 'destructive'
                        }
                        disabled={busy}
                        onClick={() => setConfirmBanToggle(true)}
                      >
                        <Ban className="size-3.5" />
                        {editingAccount.user.content_ban
                          ? '解除封禁'
                          : '内容封禁'}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmBanToggle} onOpenChange={setConfirmBanToggle}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {editingAccount?.user.content_ban
                ? `解除「${editingAccount.user.username}」的内容封禁？`
                : `对「${editingAccount?.user.username}」执行内容封禁？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {editingAccount?.user.content_ban
                ? '解除后该账号可恢复上传图片、AI 生图及公开分享。'
                : '封禁后该账号仍可登录查看，但无法上传新图、AI 生图或新增公开分享。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant={
                editingAccount?.user.content_ban ? 'primary' : 'destructive'
              }
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void handleToggleContentBan();
              }}
            >
              确认执行
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReset2fa} onOpenChange={setConfirmReset2fa}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              重置「{editingAccount?.user.username}」的二步验证？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将清除该账号的 TOTP 验证器与恢复码，并强制下线其全部已登录设备。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void handleResetUser2fa();
              }}
            >
              确认重置 2FA
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
