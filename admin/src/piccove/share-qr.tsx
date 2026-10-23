import { useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Picture } from './api';

export function ShareQr({
  image,
  onClose,
}: {
  image: Picture | null;
  onClose: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const allowed = !!image?.is_public && !image.deleted_at;
  // Leave room for medium error correction and keep unusually long links out of the encoder.
  const fits = !!image && new TextEncoder().encode(image.url).length <= 1500;
  function download() {
    if (!svg.current || !image || !allowed || !fits) return;
    const data = new XMLSerializer().serializeToString(svg.current);
    const link = document.createElement('a');
    link.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
    link.download = `piccove-${image.id}-qr.svg`;
    link.click();
  }
  return (
    <Dialog
      open={!!image}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="cove-qr-dialog">
        <DialogHeader>
          <DialogTitle>二维码分享</DialogTitle>
          <DialogDescription>
            扫描二维码即可查看原图。任何拿到二维码的人都能打开这张图片。
          </DialogDescription>
        </DialogHeader>
        {!allowed ? (
          <p role="alert">仅可分享未删除的公开图片。</p>
        ) : !fits ? (
          <p role="alert">
            图片链接太长，无法生成二维码。请返回图库复制链接分享。
          </p>
        ) : (
          <>
            <QRCodeSVG
              ref={svg}
              value={image!.url}
              size={256}
              level="M"
              marginSize={4}
              title={`${image!.original_name}的原图链接二维码`}
              style={{ maxWidth: '100%', height: 'auto', margin: '0 auto' }}
            />
            <a
              className="break-all"
              href={image!.url}
              target="_blank"
              rel="noreferrer"
            >
              {image!.url}
            </a>
            <Button onClick={download}>下载二维码 SVG</Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
