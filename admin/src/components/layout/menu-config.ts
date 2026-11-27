import {
  FolderHeart,
  GalleryVerticalEnd,
  Images,
  LayoutDashboard,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  UserCog,
  Users,
} from 'lucide-react';
import type { MenuConfig } from '@/config/types';

export function buildSidebarMenu(
  isAdmin: boolean,
  pendingReviews?: number,
): MenuConfig {
  const menu: MenuConfig = [
    { heading: '我的空间' },
    {
      title: '图片库',
      path: '/app',
      icon: Images,
    },
    {
      title: '我的相册',
      path: '/app/albums',
      icon: FolderHeart,
    },
    {
      title: 'AI 创作台',
      path: '/app/ai',
      icon: Sparkles,
    },
    {
      title: '账号设置',
      path: '/app/account',
      icon: UserCog,
    },
  ];

  if (isAdmin) {
    menu.push(
      { heading: '管理控制台' },
      {
        title: '全局概览',
        path: '/app/admin',
        icon: LayoutDashboard,
      },
      {
        title: '图片审核',
        path: '/app/admin/reviews',
        icon: ShieldAlert,
        badge:
          pendingReviews && pendingReviews > 0
            ? String(pendingReviews)
            : undefined,
      },
      {
        title: '全部图片',
        path: '/app/admin/images',
        icon: GalleryVerticalEnd,
      },
      {
        title: '用户与配额',
        path: '/app/admin/users',
        icon: Users,
      },
      {
        title: '系统设置',
        path: '/app/admin/settings',
        icon: SlidersHorizontal,
      },
    );
  }

  return menu;
}
