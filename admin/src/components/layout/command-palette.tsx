import { useQuery } from '@tanstack/react-query';
import {
  FolderHeart,
  GalleryVerticalEnd,
  HardDrive,
  Images,
  LayoutDashboard,
  Moon,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserCog,
  Users,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useNavigate } from 'react-router-dom';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { api, type Account, type Album } from '@/lib/api';
import { useLayout } from './layout-context';

export function CommandPalette({ account }: { account: Account }) {
  const { commandOpen, setCommandOpen } = useLayout();
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api<Album[]>('/albums'),
    enabled: commandOpen,
  });

  const go = (to: string) => {
    setCommandOpen(false);
    navigate(to);
  };

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder="搜索相册、页面或快捷命令…" />
      <CommandList>
        <CommandEmpty>未找到匹配项</CommandEmpty>

        <CommandGroup heading="我的空间">
          <CommandItem onSelect={() => go('/app')}>
            <Images />
            <span>我的图片库</span>
          </CommandItem>
          <CommandItem onSelect={() => go('/app/albums')}>
            <FolderHeart />
            <span>我的相册</span>
          </CommandItem>
          <CommandItem onSelect={() => go('/app/ai')}>
            <Sparkles />
            <span>AI 图片创作台</span>
          </CommandItem>
          <CommandItem onSelect={() => go('/app/account')}>
            <UserCog />
            <span>账号与安全设置</span>
          </CommandItem>
        </CommandGroup>

        {albums.data && albums.data.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="快速打开相册">
              {albums.data.map((album) => (
                <CommandItem
                  key={album.id}
                  onSelect={() => go(`/app?album=${album.id}`)}
                >
                  <FolderHeart />
                  <span>{album.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {account.user.is_admin && (
          <>
            <CommandSeparator />
            <CommandGroup heading="管理控制台">
              <CommandItem onSelect={() => go('/app/admin')}>
                <LayoutDashboard />
                <span>全局概览</span>
              </CommandItem>
              <CommandItem onSelect={() => go('/app/admin/reviews')}>
                <ShieldAlert />
                <span>图片审核</span>
              </CommandItem>
              <CommandItem onSelect={() => go('/app/admin/images')}>
                <GalleryVerticalEnd />
                <span>全部图片</span>
              </CommandItem>
              <CommandItem onSelect={() => go('/app/admin/users')}>
                <Users />
                <span>用户与配额</span>
              </CommandItem>
              <CommandItem onSelect={() => go('/app/admin/settings#settings-ai')}>
                <SlidersHorizontal />
                <span>系统设置 · AI 生图与审核</span>
              </CommandItem>
              <CommandItem
                onSelect={() => go('/app/admin/settings#settings-storage')}
              >
                <HardDrive />
                <span>系统设置 · 存储与迁移导入</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="偏好">
          <CommandItem
            onSelect={() => {
              setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
              setCommandOpen(false);
            }}
          >
            {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
            <span>
              切换为{resolvedTheme === 'dark' ? '浅色' : '深色'}模式
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
