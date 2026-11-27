import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
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
import { AlbumsPage } from '@/features/albums/albums-page';
import { AuthPage, HomePage } from '@/features/auth/public-pages';
import { GalleryPage } from '@/features/gallery/gallery-page';

const AiStudioPage = lazy(() =>
  import('@/features/ai/ai-studio-page').then((m) => ({
    default: m.AiStudioPage,
  })),
);
const AccountPage = lazy(() =>
  import('@/features/account/account-page').then((m) => ({
    default: m.AccountPage,
  })),
);
const AdminOverviewPage = lazy(() =>
  import('@/features/admin/overview-page').then((m) => ({
    default: m.AdminOverviewPage,
  })),
);
const ReviewsPage = lazy(() =>
  import('@/features/admin/reviews-page').then((m) => ({
    default: m.ReviewsPage,
  })),
);
const AllImagesPage = lazy(() =>
  import('@/features/admin/all-images-page').then((m) => ({
    default: m.AllImagesPage,
  })),
);
const UsersPage = lazy(() =>
  import('@/features/admin/users-page').then((m) => ({
    default: m.UsersPage,
  })),
);
const AdminSettingsPage = lazy(() =>
  import('@/features/admin/settings-page').then((m) => ({
    default: m.AdminSettingsPage,
  })),
);

function RouteFallback() {
  return (
    <div
      role="status"
      className="flex py-20 items-center justify-center text-muted-foreground"
    >
      <LoaderCircle className="size-5 animate-spin text-primary" />
    </div>
  );
}

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
        <Route
          path="ai"
          element={
            <Suspense fallback={<RouteFallback />}>
              <AiStudioPage />
            </Suspense>
          }
        />
        <Route
          path="account"
          element={
            <Suspense fallback={<RouteFallback />}>
              <AccountPage />
            </Suspense>
          }
        />
        <Route
          path="admin"
          element={
            <AdminOnly>
              <Suspense fallback={<RouteFallback />}>
                <AdminOverviewPage />
              </Suspense>
            </AdminOnly>
          }
        />
        <Route
          path="admin/reviews"
          element={
            <AdminOnly>
              <Suspense fallback={<RouteFallback />}>
                <ReviewsPage />
              </Suspense>
            </AdminOnly>
          }
        />
        <Route
          path="admin/images"
          element={
            <AdminOnly>
              <Suspense fallback={<RouteFallback />}>
                <AllImagesPage />
              </Suspense>
            </AdminOnly>
          }
        />
        <Route
          path="admin/users"
          element={
            <AdminOnly>
              <Suspense fallback={<RouteFallback />}>
                <UsersPage />
              </Suspense>
            </AdminOnly>
          }
        />
        <Route
          path="admin/settings"
          element={
            <AdminOnly>
              <Suspense fallback={<RouteFallback />}>
                <AdminSettingsPage />
              </Suspense>
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
