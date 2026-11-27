import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  Check,
  ChevronsUpDown,
  FolderInput,
  HardDrive,
  ListTodo,
  RefreshCw,
  Server,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Toolbar, ToolbarHeading } from '@/components/layout/page-toolbar';
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
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  api,
  errorMessage,
  size,
  useSettings,
  type Account,
  type AiConfig,
  type Album,
  type FileJob,
  type FileJobItem,
  type ImportCandidate,
  type Page,
  type StorageLocation,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { SystemServiceCard } from './system-service-card';

const SECTIONS = [
  ['ai', 'AI 生图与审核', Sparkles],
  ['registration', '用户注册', UserPlus],
  ['storage', '存储位置', HardDrive],
  ['migration', '图片迁移', ArrowRightLeft],
  ['import', '批量导入', FolderInput],
  ['jobs', '任务记录', ListTodo],
  ['system', '版本与服务', Server],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

const JOB_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  migration: '存储迁移',
  cleanup: '清理旧副本',
  import: '批量导入',
};

function AiSettingsPanel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => api<AiConfig>('/admin/ai'),
  });

  if (query.isPending) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground" role="status">
          正在读取 AI 配置…
        </CardContent>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-3" role="alert">
          <p className="text-sm text-destructive">{errorMessage(query.error)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <AiSettingsForm
      config={query.data}
      onSaved={() => {
        void client.invalidateQueries({ queryKey: ['ai-config'] });
        void client.invalidateQueries({ queryKey: ['ai-status'] });
      }}
    />
  );
}

function AiSettingsForm({
  config,
  onSaved,
}: {
  config: AiConfig;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<'images' | 'responses'>(
    config.generation_mode,
  );
  const [genUrl, setGenUrl] = useState(config.generation.base_url);
  const [modUrl, setModUrl] = useState(config.moderation.base_url);
  const [moderationEnabled, setModerationEnabled] = useState(
    config.moderation_enabled,
  );
  const genUrlChanged =
    genUrl.trim().replace(/\/+$/, '') !==
    config.generation.base_url.trim().replace(/\/+$/, '');
  const modUrlChanged =
    modUrl.trim().replace(/\/+$/, '') !==
    config.moderation.base_url.trim().replace(/\/+$/, '');
  const [beforePublish, setBeforePublish] = useState(config.before_publish);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function discoverModels(
    provider: 'generation' | 'moderation',
    form: HTMLFormElement,
  ) {
    const values = new FormData(form);
    setFetchingProvider(provider);
    try {
      const list = await api<string[]>('/admin/ai/models', 'POST', {
        provider,
        base_url: String(values.get(`${provider}_url`) || '').trim(),
        key: String(values.get(`${provider}_key`) || ''),
      });
      setModels((prev) => ({ ...prev, [provider]: list }));
      if (list.length) {
        toast.success(`已拉取 ${list.length} 个可用模型`);
      } else {
        toast.info('上游未返回模型列表，请直接输入模型 ID');
      }
    } catch (error) {
      setModels((prev) => ({ ...prev, [provider]: [] }));
      toast.error(`${errorMessage(error)}（可直接手动填写模型 ID）`);
    } finally {
      setFetchingProvider(null);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const el = e.currentTarget;
    const form = new FormData(el);

    const generation = {
      base_url: String(form.get('generation_url') || '').trim(),
      key: String(form.get('generation_key') || ''),
      model: String(form.get('generation_model') || '').trim(),
    };
    const moderation = {
      base_url: String(form.get('moderation_url') || '').trim(),
      key: String(form.get('moderation_key') || ''),
      model: String(form.get('moderation_model') || '').trim(),
    };
    const imageModel = String(form.get('image_model') || '').trim();

    setSaving(true);
    try {
      await api('/admin/ai', 'PATCH', {
        generation,
        moderation,
        generation_mode: mode,
        image_model: imageModel,
        moderation_enabled: moderationEnabled,
        before_publish: beforePublish,
        daily_limit: Number(form.get('daily_limit')),
        concurrent_limit: Number(form.get('concurrent_limit')),
        ban_threshold: Number(form.get('ban_threshold')),
      });
      for (const fieldName of ['generation_key', 'moderation_key']) {
        const input = el.elements.namedItem(
          fieldName,
        ) as HTMLInputElement | null;
        if (input) input.value = '';
      }
      toast.success('AI 设置已保存');
      onSaved();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
      {/* Generation Provider Card */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>AI 图片生成接口</CardTitle>
            <CardDescription>
              配置 OpenAI 兼容图片接口与模型，清空基础地址可停用生图
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 max-w-sm">
            <Label>生图调用协议</Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as 'images' | 'responses')}
            >
              <SelectTrigger aria-label="生图方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="images">独立图片模型（推荐）</SelectItem>
                <SelectItem value="responses">
                  Responses 对话工具调用模式
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gen-url">API 基础地址</Label>
              <Input
                id="gen-url"
                name="generation_url"
                type="url"
                value={genUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => {
                  setGenUrl(e.target.value);
                  setModels((prev) => ({ ...prev, generation: [] }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gen-key">
                API 密钥
                {config.generation_key_set && !genUrlChanged && (
                  <span className="text-xs font-normal text-muted-foreground ms-1.5">
                    （已保存，留空不修改）
                  </span>
                )}
              </Label>
              <Input
                id="gen-key"
                name="generation_key"
                type="password"
                required={
                  !!genUrl.trim() &&
                  (!config.generation_key_set || genUrlChanged)
                }
                autoComplete="new-password"
                maxLength={4096}
                placeholder={
                  config.generation_key_set && !genUrlChanged
                    ? '••••••••'
                    : 'sk-...'
                }
                onChange={() =>
                  setModels((prev) => ({ ...prev, generation: [] }))
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!fetchingProvider || saving}
              onClick={(e) => {
                if (e.currentTarget.form)
                  void discoverModels('generation', e.currentTarget.form);
              }}
            >
              <RefreshCw
                className={
                  fetchingProvider === 'generation' ? 'animate-spin' : undefined
                }
              />
              拉取模型列表
            </Button>
            {models.generation?.length ? (
              <span className="text-xs text-muted-foreground">
                已读取 {models.generation.length} 个模型
              </span>
            ) : null}
          </div>

          <datalist id="generation-models">
            {models.generation?.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gen-image-model">图片模型 ID</Label>
              <Input
                id="gen-image-model"
                name="image_model"
                list="generation-models"
                required={!!genUrl.trim()}
                defaultValue={config.image_model}
                maxLength={200}
                placeholder="例如 gpt-image-1"
              />
            </div>
            {mode === 'responses' && (
              <div className="space-y-2">
                <Label htmlFor="gen-chat-model">主对话模型 ID</Label>
                <Input
                  id="gen-chat-model"
                  name="generation_model"
                  list="generation-models"
                  required={!!genUrl.trim()}
                  defaultValue={config.generation.model}
                  maxLength={200}
                  placeholder="例如 gpt-4.1"
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Moderation Provider Card */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>内容视觉审核</CardTitle>
            <CardDescription>
              自动拦截明确违规内容并计次，疑似内容转入人工复核队列
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="mod-enable-switch" className="text-xs">
              启用审核
            </Label>
            <Switch
              id="mod-enable-switch"
              checked={moderationEnabled}
              onCheckedChange={setModerationEnabled}
              aria-label="开启新增图片审核"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="mod-url">审核 API 基础地址</Label>
              <Input
                id="mod-url"
                name="moderation_url"
                type="url"
                required={moderationEnabled}
                value={modUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => {
                  setModUrl(e.target.value);
                  setModels((prev) => ({ ...prev, moderation: [] }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mod-key">
                API 密钥
                {config.moderation_key_set && !modUrlChanged && (
                  <span className="text-xs font-normal text-muted-foreground ms-1.5">
                    （已保存，留空不修改）
                  </span>
                )}
              </Label>
              <Input
                id="mod-key"
                name="moderation_key"
                type="password"
                required={
                  moderationEnabled &&
                  (!config.moderation_key_set || modUrlChanged)
                }
                autoComplete="new-password"
                maxLength={4096}
                placeholder={
                  config.moderation_key_set && !modUrlChanged
                    ? '••••••••'
                    : 'sk-...'
                }
                onChange={() =>
                  setModels((prev) => ({ ...prev, moderation: [] }))
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!fetchingProvider || saving}
              onClick={(e) => {
                if (e.currentTarget.form)
                  void discoverModels('moderation', e.currentTarget.form);
              }}
            >
              <RefreshCw
                className={
                  fetchingProvider === 'moderation' ? 'animate-spin' : undefined
                }
              />
              拉取模型列表
            </Button>
            {models.moderation?.length ? (
              <span className="text-xs text-muted-foreground">
                已读取 {models.moderation.length} 个模型
              </span>
            ) : null}
          </div>

          <datalist id="moderation-models">
            {models.moderation?.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="mod-model">视觉审核模型 ID</Label>
              <Input
                id="mod-model"
                name="moderation_model"
                list="moderation-models"
                required={moderationEnabled}
                defaultValue={config.moderation.model}
                maxLength={200}
                placeholder="输入支持视觉输入的模型 ID"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ban-threshold">累计违规自动封禁阈值</Label>
              <Input
                id="ban-threshold"
                type="number"
                name="ban_threshold"
                required
                min={1}
                max={10000}
                defaultValue={config.ban_threshold}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3.5">
            <div>
              <p className="text-sm font-medium text-mono">先审后发模式</p>
              <p className="text-xs text-muted-foreground">
                开启后新上传图片需审核通过才允许匿名外链访问（关闭则为先发后审）
              </p>
            </div>
            <Switch
              checked={beforePublish}
              onCheckedChange={setBeforePublish}
              aria-label="先审后发"
            />
          </div>
        </CardContent>
      </Card>

      {/* Quota Card */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>用户生图配额限制</CardTitle>
            <CardDescription>控制普通用户的每日生图上限与并发数</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ai-daily-limit">每日图片生成上限（UTC）</Label>
            <Input
              id="ai-daily-limit"
              type="number"
              name="daily_limit"
              required
              min={1}
              max={10000}
              defaultValue={config.daily_limit}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-concurrent-limit">单用户最大并发任务数</Label>
            <Input
              id="ai-concurrent-limit"
              type="number"
              name="concurrent_limit"
              required
              min={1}
              max={4}
              defaultValue={config.concurrent_limit}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? '正在保存…' : '保存 AI 设置'}
        </Button>
      </div>
    </form>
  );
}

function RegistrationPanel() {
  const settings = useSettings();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function toggleOpen(open: boolean) {
    setBusy(true);
    try {
      await api('/settings', 'PATCH', { registration_open: open });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['settings'] }),
        client.invalidateQueries({ queryKey: ['admin-overview'] }),
      ]);
      toast.success(open ? '已开启公开注册' : '已关闭公开注册');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>用户自助注册</CardTitle>
          <CardDescription>控制访客是否可在登录页自行注册账号</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
          <div className="space-y-1">
            <h3 id="registration-label" className="text-sm font-semibold text-mono">
              允许新用户自助注册
            </h3>
            <p className="text-xs text-muted-foreground">
              新注册账号默认分配 1 GiB 配额；关闭后仅管理员可手动创建账号
            </p>
          </div>
          <Switch
            aria-labelledby="registration-label"
            checked={settings.data?.registration_open || false}
            disabled={busy || !settings.data}
            onCheckedChange={(v) => void toggleOpen(v)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StorageLocationsPanel() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);

  const locations = useQuery({
    queryKey: ['storage-locations'],
    queryFn: () =>
      api<{ items: StorageLocation[]; allowed_roots: string[] }>(
        '/storage-locations',
      ),
    refetchInterval: 10000,
  });

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const formEl = e.currentTarget;
    const path = String(new FormData(formEl).get('path') || '').trim();
    setBusy(true);
    try {
      await api('/storage-locations', 'POST', { path });
      formEl.reset();
      await client.invalidateQueries({ queryKey: ['storage-locations'] });
      toast.success('存储位置已添加');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectDefault(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/storage-locations/${id}/default`, 'POST');
      await client.invalidateQueries({ queryKey: ['storage-locations'] });
      toast.success('默认写入存储已切换');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>存储位置管理</CardTitle>
          <CardDescription>
            管理图片物理存储挂载点，切换默认目录不会移动历史图片
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {locations.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            正在读取存储目录…
          </p>
        ) : locations.isError ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">
              {errorMessage(locations.error)}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void locations.refetch()}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {locations.data.items.map((loc) => (
              <div
                key={loc.id}
                className="rounded-xl border border-border p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <code className="text-sm font-semibold text-mono break-all">
                    {loc.path}
                  </code>
                  {loc.default ? (
                    <Badge variant="primary" appearance="light">
                      默认存储
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !!loc.error}
                      onClick={() => void selectDefault(loc.id)}
                    >
                      设为默认
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground block">图片数量</span>
                    <span className="font-medium text-mono tabular-nums">
                      {loc.count} 张
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">已占空间</span>
                    <span className="font-medium text-mono tabular-nums">
                      {size(loc.used_bytes)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">磁盘可用</span>
                    <span className="font-medium text-mono tabular-nums">
                      {loc.available_bytes == null
                        ? '暂不可用'
                        : size(loc.available_bytes)}
                    </span>
                  </div>
                </div>

                {loc.error && (
                  <p role="alert" className="text-xs text-destructive">
                    {loc.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => void handleAdd(e)}
          className="border-t border-border pt-5 space-y-3"
        >
          <div className="space-y-1">
            <Label htmlFor="storage-path">添加新存储位置</Label>
            {locations.data && locations.data.allowed_roots.length > 0 && (
              <p className="text-xs text-muted-foreground">
                允许挂载根目录：
                {locations.data.allowed_roots.map((r) => (
                  <code
                    key={r}
                    className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono"
                  >
                    {r}
                  </code>
                ))}
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2.5">
            <Input
              id="storage-path"
              name="path"
              required
              placeholder="例如 /storage/pictures"
              className="flex-1"
            />
            <Button type="submit" disabled={busy}>
              添加位置
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function MigrationPanel({ onJobCreated }: { onJobCreated: (id: string) => void }) {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  const locations = useQuery({
    queryKey: ['storage-locations'],
    queryFn: () =>
      api<{ items: StorageLocation[]; allowed_roots: string[] }>(
        '/storage-locations',
      ),
  });

  async function executeMigrate() {
    if (busy) return;
    setBusy(true);
    try {
      const created = await api<{ id: string }>('/file-jobs/migrate', 'POST', {
        source_id: source,
        target_id: target,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['storage-locations'] }),
        client.invalidateQueries({ queryKey: ['file-jobs'] }),
      ]);
      toast.success('存储迁移任务已创建');
      setConfirmOpen(false);
      onJobCreated(created.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const options = locations.data?.items.map((loc) => (
    <SelectItem key={loc.id} value={loc.id}>
      {loc.path}
    </SelectItem>
  ));

  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>跨存储平滑迁移</CardTitle>
            <CardDescription>
              将源目录原图完整复制并校验后切换至目标目录，全程保持图片外链不变
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>源存储位置</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger aria-label="原存储位置">
                  <SelectValue placeholder="选择源目录" />
                </SelectTrigger>
                <SelectContent>{options}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>目标存储位置</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger aria-label="目标存储位置">
                  <SelectValue placeholder="选择目标目录" />
                </SelectTrigger>
                <SelectContent>{options}</SelectContent>
              </Select>
            </div>
          </div>

          <Button
            disabled={busy || !source || !target || source === target}
            onClick={() => setConfirmOpen(true)}
          >
            <ArrowRightLeft />
            开始迁移
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认启动存储迁移？</AlertDialogTitle>
            <AlertDialogDescription>
              若源目录当前为默认写入位置，默认写入也将一并切换到目标目录。旧目录原图副本会暂时保留，迁移完成后可在任务记录中安全清理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void executeMigrate();
              }}
            >
              {busy ? '创建中…' : '确认开始迁移'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BatchImportPanel({
  onJobCreated,
}: {
  onJobCreated: (id: string) => void;
}) {
  const [userSearch, setUserSearch] = useState('');
  const [userPickerOpen, setUserPickerOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{
    id: string;
    username: string;
  } | null>(null);
  const [albumId, setAlbumId] = useState('none');
  const [isPublic, setIsPublic] = useState(false);
  const [chosenKeys, setChosenKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  const candidates = useQuery({
    queryKey: ['import-candidates'],
    queryFn: () =>
      api<{ enabled: boolean; items: ImportCandidate[] }>('/import-candidates'),
    enabled: false,
  });

  const users = useQuery({
    queryKey: ['import-users-search', userSearch.trim()],
    queryFn: () =>
      api<Page<Account>>(
        `/admin/users?page=1&status=active${userSearch.trim() ? `&q=${encodeURIComponent(userSearch.trim())}` : ''}`,
      ),
    enabled: !!candidates.data?.enabled,
  });

  const albums = useQuery({
    queryKey: ['import-albums', selectedUser?.id],
    queryFn: () => api<Album[]>(`/import-albums/${selectedUser!.id}`),
    enabled: !!selectedUser?.id,
  });

  async function submitImport() {
    if (!selectedUser || !chosenKeys.length || busy || !candidates.data) return;
    setBusy(true);
    try {
      const created = await api<{ id: string }>('/file-jobs/import', 'POST', {
        user_id: selectedUser.id,
        album_id: albumId === 'none' ? null : albumId,
        is_public: isPublic,
        files: candidates.data.items.filter((f) => chosenKeys.includes(f.key)),
      });
      await client.invalidateQueries({ queryKey: ['file-jobs'] });
      toast.success('批量导入任务已创建');
      setChosenKeys([]);
      onJobCreated(created.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>服务端目录批量导入</CardTitle>
          <CardDescription>
            扫描服务端待导入目录中的图片并批量归入指定用户图库（单批最多 1000 张）
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost">
                导入说明
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 text-xs text-muted-foreground leading-relaxed">
              将图片通过 SFTP 放入服务端待导入挂载目录后点击扫描；正在传输中的文件请使用 <code className="font-mono text-foreground">.part</code> 临时后缀避免提前读入。
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            variant="outline"
            disabled={candidates.isFetching}
            onClick={() => {
              setChosenKeys([]);
              void candidates.refetch();
            }}
          >
            <RefreshCw
              className={candidates.isFetching ? 'animate-spin' : undefined}
            />
            {candidates.isFetching ? '扫描中…' : '扫描待导入图片'}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {candidates.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(candidates.error)}
          </p>
        )}

        {!candidates.data ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            点击右上角「扫描待导入图片」读取待导入文件列表。
          </p>
        ) : !candidates.data.enabled ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            服务端尚未配置待导入挂载目录，请参考运维手册启用。
          </p>
        ) : (
          <div className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              {/* Searchable User Combobox (Preserves selection across searches!) */}
              <div className="space-y-2">
                <Label>归属目标用户</Label>
                <Popover open={userPickerOpen} onOpenChange={setUserPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={userPickerOpen}
                      aria-label="导入到用户"
                      className="w-full justify-between font-normal"
                    >
                      <span className="truncate">
                        {selectedUser ? selectedUser.username : '搜索并选择用户…'}
                      </span>
                      <ChevronsUpDown className="size-4 opacity-50 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[260px] p-2 space-y-2" align="start">
                    <Input
                      variant="sm"
                      value={userSearch}
                      maxLength={100}
                      onChange={(e) => setUserSearch(e.target.value)}
                      placeholder="输入用户名搜索…"
                    />
                    <ScrollArea className="max-h-48">
                      <div className="space-y-0.5">
                        {users.data?.items.map(({ user: u }) => (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => {
                              if (selectedUser?.id !== u.id) {
                                setSelectedUser({
                                  id: u.id,
                                  username: u.username,
                                });
                                setAlbumId('none');
                              }
                              setUserPickerOpen(false);
                            }}
                            className="cursor-pointer w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs hover:bg-accent text-start"
                          >
                            <span className="font-medium truncate">
                              {u.username}
                            </span>
                            {selectedUser?.id === u.id && (
                              <Check className="size-3.5 text-primary shrink-0" />
                            )}
                          </button>
                        ))}
                        {users.data && users.data.items.length === 0 && (
                          <p className="py-4 text-center text-xs text-muted-foreground">
                            未找到匹配用户
                          </p>
                        )}
                      </div>
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>归入相册</Label>
                <Select
                  value={albumId}
                  onValueChange={setAlbumId}
                  disabled={!selectedUser}
                >
                  <SelectTrigger aria-label="导入相册">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不放入相册</SelectItem>
                    {albums.data?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3.5">
              <div>
                <p className="text-sm font-medium text-mono">设为公开访问</p>
                <p className="text-xs text-muted-foreground">
                  默认以私有状态导入，开启后直接生成可公开访问外链
                </p>
              </div>
              <Switch
                checked={isPublic}
                onCheckedChange={setIsPublic}
                aria-label="公开导入图片"
              />
            </div>

            {candidates.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                待导入目录中没有发现可导入的图片文件
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    共扫描到 {candidates.data.items.length} 个文件，已选{' '}
                    <strong className="text-foreground">
                      {chosenKeys.length}
                    </strong>{' '}
                    个
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setChosenKeys(
                        chosenKeys.length === candidates.data!.items.length
                          ? []
                          : candidates.data!.items.map((f) => f.key),
                      )
                    }
                  >
                    {chosenKeys.length === candidates.data.items.length
                      ? '取消全选'
                      : '全选全部'}
                  </Button>
                </div>

                <ScrollArea className="h-64 rounded-xl border border-border">
                  <ul className="divide-y divide-border">
                    {candidates.data.items.map((file) => {
                      const checked = chosenKeys.includes(file.key);
                      return (
                        <li key={file.key}>
                          <label className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs cursor-pointer hover:bg-muted/40">
                            <span className="flex items-center gap-2.5 min-w-0">
                              <Checkbox
                                size="sm"
                                checked={checked}
                                onCheckedChange={(v) =>
                                  setChosenKeys((prev) =>
                                    v === true
                                      ? [...prev, file.key]
                                      : prev.filter((k) => k !== file.key),
                                  )
                                }
                              />
                              <span className="font-mono break-all">
                                {file.key}
                              </span>
                            </span>
                            <span className="text-muted-foreground tabular-nums shrink-0">
                              {size(file.size)}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </ScrollArea>

                <Button
                  disabled={busy || !selectedUser || chosenKeys.length === 0}
                  onClick={() => void submitImport()}
                >
                  <FolderInput />
                  {busy
                    ? '正在创建任务…'
                    : `导入所选图片（${chosenKeys.length}）`}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function JobsPanel({ initialJobId }: { initialJobId?: string }) {
  const [detailId, setDetailId] = useState(initialJobId || '');
  const [detailPage, setDetailPage] = useState(1);
  const [cleanupTargetId, setCleanupTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  useEffect(() => {
    if (initialJobId) {
      setDetailId(initialJobId);
      setDetailPage(1);
    }
  }, [initialJobId]);

  const jobs = useQuery({
    queryKey: ['file-jobs'],
    queryFn: () => api<FileJob[]>('/file-jobs'),
    refetchInterval: (q) =>
      q.state.data?.some((j) => ['queued', 'running'].includes(j.status))
        ? 3000
        : false,
  });

  const selectedJob = jobs.data?.find((j) => j.id === detailId);

  const details = useQuery({
    queryKey: ['file-job', detailId, detailPage],
    queryFn: () =>
      api<FileJobItem[]>(`/file-jobs/${detailId}?page=${detailPage}`),
    enabled: !!detailId,
    refetchInterval:
      selectedJob && ['queued', 'running'].includes(selectedJob.status)
        ? 3000
        : false,
  });

  async function retryJob(id: string) {
    setBusy(true);
    try {
      await api(`/file-jobs/${id}/retry`, 'POST');
      await client.invalidateQueries({ queryKey: ['file-jobs'] });
      toast.success('已重新排队失败项');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCleanup() {
    if (!cleanupTargetId || busy) return;
    setBusy(true);
    try {
      const created = await api<{ id?: string }>(
        `/file-jobs/${cleanupTargetId}/cleanup`,
        'POST',
      );
      await client.invalidateQueries({ queryKey: ['file-jobs'] });
      toast.success('旧副本清理任务已创建');
      setCleanupTargetId(null);
      if (created?.id) {
        setDetailId(created.id);
        setDetailPage(1);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>后台文件任务记录</CardTitle>
            <CardDescription>
              跟踪存储迁移、批量导入与旧副本清理任务的执行进度
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {jobs.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              正在读取任务列表…
            </p>
          ) : jobs.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              暂无后台文件任务记录
            </p>
          ) : (
            <div className="space-y-3">
              {jobs.data?.map((job) => {
                const pct =
                  job.total > 0
                    ? Math.min(100, Math.round((job.completed / job.total) * 100))
                    : job.status === 'completed'
                      ? 100
                      : 0;
                const isSelected = detailId === job.id;
                return (
                  <div
                    key={job.id}
                    className={cn(
                      'rounded-xl border p-4 space-y-3 transition-colors',
                      isSelected ? 'border-primary bg-primary/5' : 'border-border',
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-mono">
                          {JOB_LABELS[job.kind] || job.kind}
                        </h3>
                        <Badge
                          size="xs"
                          appearance="light"
                          variant={
                            job.status === 'completed'
                              ? 'success'
                              : job.status === 'failed'
                                ? 'destructive'
                                : 'warning'
                          }
                        >
                          {JOB_LABELS[job.status] || job.status}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        完成 {job.completed} / {job.total} · 失败 {job.failed}
                      </span>
                    </div>

                    <Progress value={pct} />

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant={isSelected ? 'secondary' : 'outline'}
                        onClick={() => {
                          setDetailId(isSelected ? '' : job.id);
                          setDetailPage(1);
                        }}
                      >
                        {isSelected ? '收起明细' : '查看明细'}
                      </Button>
                      {job.status === 'failed' && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void retryJob(job.id)}
                        >
                          重试失败项
                        </Button>
                      )}
                      {job.kind === 'migration' &&
                        job.status === 'completed' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setCleanupTargetId(job.id)}
                          >
                            清理源目录旧副本
                          </Button>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {detailId && (
            <div className="border-t border-border pt-5 space-y-3">
              <h3 className="text-sm font-semibold text-mono">任务逐项结果</h3>
              {details.isError ? (
                <p role="alert" className="text-xs text-destructive">
                  读取文件明细失败
                </p>
              ) : (
                <ScrollArea className="max-h-72 rounded-xl border border-border">
                  <ul className="divide-y divide-border text-xs">
                    {details.data?.map((item) => (
                      <li
                        key={item.id}
                        className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="font-mono break-all">
                          {item.source_key}
                        </span>
                        <span
                          className={cn(
                            item.status === 'failed'
                              ? 'text-destructive font-medium'
                              : 'text-muted-foreground',
                          )}
                        >
                          {JOB_LABELS[item.status] || item.status}
                          {item.error ? `：${item.error}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={detailPage === 1}
                  onClick={() => setDetailPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={details.data?.length !== 48}
                  onClick={() => setDetailPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!cleanupTargetId}
        onOpenChange={(open) => {
          if (!open && !busy) setCleanupTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理本次迁移的源目录旧副本？</AlertDialogTitle>
            <AlertDialogDescription>
              系统将再次逐张校验目标目录原图完整性，仅删除已确认迁移成功且未发生变化的源文件副本。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmCleanup();
              }}
            >
              {busy ? '提交中…' : '确认清理旧副本'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SystemServicePanel() {
  return <SystemServiceCard refetchInterval={5000} />;
}

export function AdminSettingsPage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [focusJobId, setFocusJobId] = useState<string | undefined>(undefined);

  const activeSection: SectionId = SECTIONS.some(
    ([id]) => hash === `#settings-${id}`,
  )
    ? (hash.slice(10) as SectionId)
    : 'ai';

  const jumpToJob = (jobId: string) => {
    setFocusJobId(jobId);
    navigate('#settings-jobs');
  };

  return (
    <div className="container space-y-6">
      <Toolbar>
        <ToolbarHeading
          title="系统设置"
          description="配置 AI 接口、注册策略、物理存储目录、数据迁移导入与版本升级"
        />
      </Toolbar>

      <div className="grid lg:grid-cols-12 gap-6 items-start">
        {/* Left Settings Navigation */}
        <nav
          aria-label="设置分类"
          className="lg:col-span-3 flex lg:flex-col gap-1 overflow-x-auto pb-1 lg:pb-0 lg:sticky lg:top-[calc(var(--header-height)+24px)]"
        >
          {SECTIONS.map(([id, label, Icon]) => {
            const active = activeSection === id;
            return (
              <Link
                key={id}
                to={`#settings-${id}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-secondary-foreground hover:bg-accent',
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Active Panel ONLY (Zero Hidden Background Polling!) */}
        <div className="lg:col-span-9 min-w-0">
          {activeSection === 'ai' && <AiSettingsPanel />}
          {activeSection === 'registration' && <RegistrationPanel />}
          {activeSection === 'storage' && <StorageLocationsPanel />}
          {activeSection === 'migration' && (
            <MigrationPanel onJobCreated={jumpToJob} />
          )}
          {activeSection === 'import' && (
            <BatchImportPanel onJobCreated={jumpToJob} />
          )}
          {activeSection === 'jobs' && <JobsPanel initialJobId={focusJobId} />}
          {activeSection === 'system' && <SystemServicePanel />}
        </div>
      </div>
    </div>
  );
}
