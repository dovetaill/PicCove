import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Globe } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  api,
  errorMessage,
  latestPictures,
  sharingProblem,
  useMe,
  type Picture,
} from '@/lib/api';
import { copyTextToClipboard } from './links-dialog';

export function ShareQrDialog({
  image,
  all = false,
  onClose,
}: {
  image: Picture | null;
  all?: boolean;
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [publishing, setPublishing] = useState(false);
  const me = useMe();
  const client = useQueryClient();

  const latestQuery = useQuery({
    queryKey: ['qr-image', all, image?.id],
    enabled: !!image,
    queryFn: async ({ signal }) => {
      const [item] = await latestPictures([image!], all, signal);
      return item;
    },
  });

  const current = latestQuery.data || image;
  const problem = current ? sharingProblem(current) : null;
  const fits =
    !!current && new TextEncoder().encode(current.url).length <= 1500;
  const canPublish =
    current &&
    !current.is_public &&
    !current.deleted_at &&
    !['blocked', 'review'].includes(current.moderation_status) &&
    current.user_id === me.data?.user.id;

  function downloadSvg() {
    if (!svgRef.current || !current || problem || !fits) return;
    const data = new XMLSerializer().serializeToString(svgRef.current);
    const link = document.createElement('a');
    link.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
    link.download = `piccove-${current.id}-qr.svg`;
    link.click();
  }

  async function makePublic() {
    if (!current) return;
    setPublishing(true);
    try {
      await api(`/images/${current.id}/visibility`, 'PATCH', {
        is_public: true,
      });
      await Promise.all([
        latestQuery.refetch(),
        client.invalidateQueries({ queryKey: ['images'] }),
      ]);
      toast.success('已设为公开');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Dialog
      open={!!image}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[400px] max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>二维码分享</DialogTitle>
          <DialogDescription className="truncate">
            {current?.original_name || '扫码直接打开原图链接'}
          </DialogDescription>
        </DialogHeader>

        {latestQuery.isPending ? (
          <div className="py-10 text-center text-sm text-muted-foreground" role="status">
            正在生成二维码…
          </div>
        ) : latestQuery.isError ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-destructive">
              {errorMessage(latestQuery.error)}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void latestQuery.refetch()}
            >
              重试
            </Button>
          </div>
        ) : problem ? (
          <Alert variant="warning" appearance="light">
            <div className="space-y-3 w-full">
              <AlertTitle>{problem}</AlertTitle>
              {canPublish && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={publishing}
                  onClick={() => void makePublic()}
                >
                  <Globe />
                  {publishing ? '正在公开…' : '设为公开'}
                </Button>
              )}
            </div>
          </Alert>
        ) : !fits ? (
          <Alert variant="destructive" appearance="light">
            <AlertTitle>链接过长，无法编码二维码，请直接复制外链分享。</AlertTitle>
          </Alert>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="rounded-xl border border-border bg-white p-4 shadow-2xs">
              <QRCodeSVG
                ref={svgRef}
                value={current!.url}
                size={220}
                level="M"
                marginSize={2}
                title={`${current!.original_name} 二维码`}
              />
            </div>
            <div className="flex items-center gap-2 w-full">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void copyTextToClipboard(current!.url)}
              >
                <Copy />
                复制直链
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                onClick={downloadSvg}
              >
                <Download />
                下载 SVG
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
