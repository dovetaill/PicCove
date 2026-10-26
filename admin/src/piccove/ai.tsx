import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, useMe, type Page, type Picture, type User } from './api';

export const reviewLabels: Record<string, string> = {
  unreviewed: '未审核',
  exempt: '免审',
  pending: '待审核',
  running: '审核中',
  passed: '通过',
  blocked: '违规',
  review: '疑似违规',
  failed: '审核失败',
};
function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败';
}
function useSave() {
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  async function save(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      await client.invalidateQueries();
      return true;
    } catch (error) {
      toast.error(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, save };
}
type Provider = { base_url: string; key: string; model: string };
type Config = {
  generation: Provider;
  moderation: Provider;
  image_model: string;
  moderation_enabled: boolean;
  before_publish: boolean;
  daily_limit: number;
  concurrent_limit: number;
  ban_threshold: number;
  generation_key_set?: boolean;
  moderation_key_set?: boolean;
};
function ConfigForm({ config }: { config: Config }) {
  const action = useSave();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const provider = (name: string): Provider => ({
      base_url: String(form.get(`${name}_url`) || '').trim(),
      key: String(form.get(`${name}_key`) || ''),
      model: String(form.get(`${name}_model`) || '').trim(),
    });
    void action.save(async () => {
      await api('/admin/ai', 'PATCH', {
        generation: provider('generation'),
        moderation: provider('moderation'),
        image_model: form.get('image_model'),
        moderation_enabled: form.has('moderation_enabled'),
        before_publish: form.has('before_publish'),
        daily_limit: Number(form.get('daily_limit')),
        concurrent_limit: Number(form.get('concurrent_limit')),
        ban_threshold: Number(form.get('ban_threshold')),
      });
      for (const name of ['generation_key', 'moderation_key']) {
        const field = element.elements.namedItem(name);
        if (field instanceof HTMLInputElement) field.value = '';
      }
      toast.success('AI 设置已保存');
    });
  }
  return (
    <form className="cove-form" onSubmit={submit}>
      {(['generation', 'moderation'] as const).map((name) => (
        <fieldset key={name} className="space-y-3 border rounded-lg p-4">
          <legend>
            {name === 'generation'
              ? '生图 API · Responses'
              : '审核 API · 视觉 Chat Completions'}
          </legend>
          <label>
            API 基础地址
            <Input
              name={`${name}_url`}
              type="url"
              defaultValue={config[name].base_url}
              placeholder="https://example.com/v1"
            />
          </label>
          <label>
            API 密钥{config[`${name}_key_set`] ? '（已配置，留空保留）' : ''}
            <Input
              name={`${name}_key`}
              type="password"
              autoComplete="new-password"
              maxLength={4096}
            />
          </label>
          <label>
            {name === 'generation' ? '对话模型' : '视觉审核模型'}
            <Input
              name={`${name}_model`}
              defaultValue={config[name].model}
              maxLength={200}
            />
          </label>
        </fieldset>
      ))}
      <label>
        图片工具模型
        <Input
          name="image_model"
          defaultValue={config.image_model}
          maxLength={200}
        />
      </label>
      <label>
        <input
          type="checkbox"
          name="moderation_enabled"
          defaultChecked={config.moderation_enabled}
        />{' '}
        开启新增图片审核
      </label>
      <label>
        <input
          type="checkbox"
          name="before_publish"
          defaultChecked={config.before_publish}
        />{' '}
        先审后发（不勾选为先发后审）
      </label>
      <label>
        普通用户每日图片额度（UTC）
        <Input
          type="number"
          name="daily_limit"
          required
          min={1}
          max={10000}
          defaultValue={config.daily_limit}
        />
      </label>
      <label>
        每用户同时生成任务数
        <Input
          type="number"
          name="concurrent_limit"
          required
          min={1}
          max={4}
          defaultValue={config.concurrent_limit}
        />
      </label>
      <label>
        累计违规自动封禁阈值
        <Input
          type="number"
          name="ban_threshold"
          required
          min={1}
          max={10000}
          defaultValue={config.ban_threshold}
        />
      </label>
      <p>
        色情、暴力、血腥、中国政治人物敏感均计次，AI
        生成结果也计次。疑似结果限制访问但不计次。管理员默认免审。
      </p>
      <Button type="submit" disabled={action.busy}>
        保存 AI 设置
      </Button>
    </form>
  );
}
export function AiSettings() {
  const query = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => api<Config>('/admin/ai'),
  });
  return (
    <Card id="settings-ai" className="cove-settings-card">
      <CardContent>
        <h2>AI 生图与审核</h2>
        {query.isPending ? (
          <p role="status">正在加载…</p>
        ) : query.isError ? (
          <p role="alert">{errorText(query.error)}</p>
        ) : (
          <ConfigForm config={query.data} />
        )}
      </CardContent>
    </Card>
  );
}
export function UserModerationControls({ user }: { user: User }) {
  const action = useSave();
  const update = (exempt: boolean | undefined, command?: string) =>
    void action.save(() =>
      api(`/admin/users/${user.id}/moderation`, 'PATCH', {
        exempt,
        action: command,
      }),
    );
  return (
    <div className="space-y-2">
      <p>
        违规 {user.violation_count} 次 ·{' '}
        {user.content_ban === 'auto'
          ? '自动封禁'
          : user.content_ban === 'manual'
            ? '手动封禁'
            : '未封禁'}
      </p>
      <label>
        <input
          type="checkbox"
          checked={user.is_admin || user.moderation_exempt}
          disabled={action.busy || user.is_admin}
          onChange={(e) => update(e.target.checked)}
        />{' '}
        审核白名单
      </label>
      {!user.is_admin && (
        <Button
          type="button"
          variant="outline"
          disabled={action.busy}
          onClick={() =>
            update(undefined, user.content_ban ? 'unban' : 'ban')
          }
        >
          {user.content_ban ? '解除内容封禁' : '手动内容封禁'}
        </Button>
      )}
    </div>
  );
}
type Review = {
  id: string;
  username: string;
  status: string;
  reason: string;
  categories: string[];
  counted: boolean;
  attempts: number;
  image_id: string | null;
  created_at: string;
};
export function ReviewManagement() {
  const [page, setPage] = useState(1);
  const action = useSave();
  const query = useQuery({
    queryKey: ['reviews', page],
    queryFn: () => api<Page<Review>>(`/admin/reviews?page=${page}`),
    refetchInterval: 5000,
  });
  return (
    <section className="space-y-4">
      <h1>图片审核</h1>
      <p>自动审核为主。撤销误判会扣回对应次数；手动封禁不会随之解除。</p>
      {query.isError && <p role="alert">{errorText(query.error)}</p>}
      {query.isPending && <p role="status">加载中…</p>}
      {query.data?.items.map((r) => (
        <Card key={r.id}>
          <CardContent className="space-y-3">
            <p>
              {r.username} · {reviewLabels[r.status]} ·{' '}
              {r.counted ? '已计违规次数' : '未计次数'} · 尝试 {r.attempts} 次
            </p>
            <p>
              {r.reason || '等待处理'} {r.categories.join(' / ')}
            </p>
            {r.image_id ? (
              <a href={`/i/${r.image_id}`} target="_blank" rel="noreferrer">
                <img
                  src={`/api/v1/images/${r.image_id}/thumbnail`}
                  alt="审核图片"
                  className="max-h-48 max-w-full"
                />
              </a>
            ) : (
              <p>原图已删除，保留审核记录</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.save(() =>
                    api(`/admin/reviews/${r.id}`, 'PATCH', {
                      decision: 'passed',
                    }),
                  )
                }
              >
                通过／撤销误判
              </Button>
              <Button
                variant="outline"
                disabled={action.busy}
                onClick={() =>
                  void action.save(() =>
                    api(`/admin/reviews/${r.id}`, 'PATCH', {
                      decision: 'blocked',
                    }),
                  )
                }
              >
                确认违规
              </Button>
              {r.status === 'failed' && (
                <Button
                  variant="outline"
                  disabled={action.busy}
                  onClick={() =>
                    void action.save(() =>
                      api(`/admin/reviews/${r.id}/retry`, 'POST'),
                    )
                  }
                >
                  重试审核
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
      {query.data && !query.data.items.length && <p>暂无审核记录</p>}
      <div className="flex gap-3">
        <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page} 页</span>
        <Button
          disabled={!query.data?.has_more}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </div>
    </section>
  );
}
type Conversation = { id: string; title: string };
type Message = {
  id: string;
  prompt: string;
  text: string;
  reference_id: string | null;
  image_id: string | null;
  image_status: string | null;
  image_reason: string | null;
  reference_status: string | null;
  status: string;
  error: string;
};
type AiStatus = {
  enabled: boolean;
  used: number;
  daily_limit: number;
  unlimited: boolean;
};
function ChatImage({
  id,
  status,
  reason,
}: {
  id: string;
  status: string | null;
  reason?: string | null;
}) {
  const me = useMe();
  if (['blocked', 'review'].includes(status || '') && !me.data?.user.is_admin)
    return (
      <p role="status">
        图片已限制访问：{reason || reviewLabels[status || '']}
      </p>
    );
  return (
    <div>
      <a href={`/i/${id}`} target="_blank" rel="noreferrer">
        <img
          className="max-h-96 max-w-full rounded-lg"
          src={`/i/${id}`}
          alt="对话图片"
        />
      </a>
      <small>{reviewLabels[status || 'unreviewed']}</small>
    </div>
  );
}
export function AiChat() {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [reference, setReference] = useState<Pick<
    Picture,
    'id' | 'original_name'
  > | null>(null);
  const action = useSave();
  const client = useQueryClient();
  const me = useMe();
  const list = useQuery({
    queryKey: ['ai-conversations', page],
    queryFn: () => api<Page<Conversation>>(`/ai/conversations?page=${page}`),
  });
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<AiStatus>('/ai/status'),
    refetchInterval: 5000,
  });
  const messages = useQuery({
    queryKey: ['ai-messages', selected],
    queryFn: () => api<Message[]>(`/ai/conversations/${selected}`),
    enabled: !!selected,
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (
      messages.data?.some((m) => ['completed', 'failed'].includes(m.status))
    ) {
      void client.invalidateQueries({ queryKey: ['me'] });
      void client.invalidateQueries({ queryKey: ['ai-status'] });
    }
  }, [messages.data, client]);
  const active = messages.data?.some((m) =>
    ['queued', 'running'].includes(m.status),
  );
  const banned = !!me.data?.user.content_ban;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await action.save(async () => {
      let id = selected;
      if (!id) {
        id = (await api<{ id: string }>('/ai/conversations', 'POST')).id;
        setSelected(id);
      }
      await api(`/ai/conversations/${id}`, 'POST', {
        prompt,
        reference_id: reference?.id || null,
      });
    });
    if (ok) {
      setPrompt('');
      setReference(null);
    }
  }
  return (
    <section className="space-y-4">
      <h1>AI 图片对话</h1>
      <p>
        描述你想要的图片，也可以上传参考图后连续修改。图片保存在图库中，默认私有。
      </p>
      {status.data && (
        <p>
          {status.data.unlimited
            ? '管理员不限生图额度'
            : `今日已用／预占 ${status.data.used} / ${status.data.daily_limit} 张（UTC）`}
        </p>
      )}
      {status.isError && (
        <p role="alert">
          {errorText(status.error)}{' '}
          <Button variant="outline" onClick={() => void status.refetch()}>
            重试 AI 状态
          </Button>
        </p>
      )}
      {status.data && !status.data.enabled && (
        <p role="status">管理员尚未配置生图 API。</p>
      )}
      {banned && (
        <p role="alert">
          账号已被内容封禁，违规 {me.data?.user.violation_count}{' '}
          次；请联系管理员。
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-2" aria-label="历史对话">
          <Button
            disabled={action.busy || banned}
            onClick={() => {
              setSelected(null);
              setPrompt('');
              setReference(null);
            }}
          >
            新对话
          </Button>
          {list.isError && <p role="alert">{errorText(list.error)}</p>}
          {list.data?.items.map((c) => (
            <Button
              key={c.id}
              disabled={action.busy}
              className="w-full justify-start truncate"
              variant={selected === c.id ? 'primary' : 'outline'}
              onClick={() => {
                setSelected(c.id);
                setReference(null);
                setPrompt('');
              }}
            >
              {c.title}
            </Button>
          ))}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              上页
            </Button>
            <Button
              variant="outline"
              disabled={!list.data?.has_more}
              onClick={() => setPage(page + 1)}
            >
              下页
            </Button>
          </div>
        </aside>
        <div className="min-w-0 space-y-4">
          {messages.isError && <p role="alert">{errorText(messages.error)}</p>}
          {messages.data?.map((m) => (
            <Card key={m.id}>
              <CardContent className="space-y-3">
                <p className="whitespace-pre-wrap break-words">
                  <strong>你：</strong>
                  {m.prompt}
                </p>
                {m.reference_id && (
                  <ChatImage id={m.reference_id} status={m.reference_status} />
                )}
                {m.text && (
                  <p className="whitespace-pre-wrap break-words">
                    <strong>AI：</strong>
                    {m.text}
                  </p>
                )}
                {m.image_id && (
                  <ChatImage
                    id={m.image_id}
                    status={m.image_status}
                    reason={m.image_reason}
                  />
                )}
                {['queued', 'running'].includes(m.status) && (
                  <p role="status">
                    {m.status === 'queued' ? '等待生成…' : '正在生成…'}
                  </p>
                )}
                {m.status === 'failed' && (
                  <div>
                    <p role="alert">{m.error}</p>
                    <Button
                      variant="outline"
                      disabled={action.busy}
                      onClick={() => {
                        setPrompt(m.prompt);
                        setReference(
                          m.reference_id
                            ? {
                                id: m.reference_id,
                                original_name: '上次参考图',
                              }
                            : null,
                        );
                      }}
                    >
                      重新填写提示词
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          <form className="cove-form" onSubmit={(event) => void submit(event)}>
            <label>
              参考图片
              <Input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                disabled={action.busy || banned || !!active}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  const form = new FormData();
                  form.append('file', file);
                  void action.save(async () => {
                    const image = await api<Picture>(
                      '/images?private=true',
                      'POST',
                      form,
                    );
                    setReference(image);
                    await client.invalidateQueries({ queryKey: ['images'] });
                  });
                }}
              />
            </label>
            {reference && (
              <p>
                参考图：{reference.original_name}（审核通过后可用于生成）{' '}
                <Button
                  type="button"
                  variant="outline"
                  disabled={action.busy}
                  onClick={() => setReference(null)}
                >
                  移除
                </Button>
              </p>
            )}
            <label>
              消息
              <Textarea
                disabled={action.busy}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
                maxLength={4000}
                rows={4}
                placeholder="生成一张图片，或描述要怎样修改上一张图片…"
              />
            </label>
            <Button
              type="submit"
              disabled={
                action.busy ||
                banned ||
                !!active ||
                !status.data?.enabled ||
                !prompt.trim()
              }
            >
              发送
            </Button>
          </form>
        </div>
      </div>
    </section>
  );
}
