import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
} from 'react-router-dom';
import { AdminOnly, AppLayout } from '@/components/layout/app-layout';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AccountPage } from '@/features/account/account-page';
import { AllImagesPage } from '@/features/admin/all-images-page';
import { AdminOverviewPage } from '@/features/admin/overview-page';
import { ReviewsPage } from '@/features/admin/reviews-page';
import { AdminSettingsPage } from '@/features/admin/settings-page';
import { UsersPage } from '@/features/admin/users-page';
import { AiStudioPage } from '@/features/ai/ai-studio-page';
import { AlbumsPage } from '@/features/albums/albums-page';
import { AuthPage, HomePage } from '@/features/auth/public-pages';
import { GalleryPage } from '@/features/gallery/gallery-page';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<AuthPage />} />
      <Route path="/register" element={<AuthPage register />} />
      <Route path="/app" element={<AppLayout />}>
        <Route index element={<GalleryPage />} />
        <Route path="albums" element={<AlbumsPage />} />
        <Route path="ai" element={<AiStudioPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route
          path="admin"
          element={
            <AdminOnly>
              <AdminOverviewPage />
            </AdminOnly>
          }
        />
        <Route
          path="admin/reviews"
          element={
            <AdminOnly>
              <ReviewsPage />
            </AdminOnly>
          }
        />
        <Route
          path="admin/images"
          element={
            <AdminOnly>
              <AllImagesPage />
            </AdminOnly>
          }
        />
        <Route
          path="admin/users"
          element={
            <AdminOnly>
              <UsersPage />
            </AdminOnly>
          }
        />
        <Route
          path="admin/settings"
          element={
            <AdminOnly>
              <AdminSettingsPage />
            </AdminOnly>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </>,
  ),
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        enableSystem
        disableTransitionOnChange
      >
        <TooltipProvider delayDuration={200}>
          <Toaster position="top-right" />
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
