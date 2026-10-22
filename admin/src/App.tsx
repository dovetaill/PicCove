import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { Home, Auth } from '@/piccove/public';
import {
  Workspace,
  Gallery,
  Albums,
  AccountSettings,
  UserManagement,
  RegistrationSettings,
  AdminOnly,
} from '@/piccove/workspace';
import '@/piccove/style.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
export function App() {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" forcedTheme="light">
        <BrowserRouter>
          <Toaster />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Auth />} />
            <Route path="/register" element={<Auth register />} />
            <Route path="/app" element={<Workspace />}>
              <Route index element={<Gallery key="own" />} />
              <Route path="albums" element={<Albums />} />
              <Route path="account" element={<AccountSettings />} />
              <Route
                path="admin/users"
                element={
                  <AdminOnly>
                    <UserManagement />
                  </AdminOnly>
                }
              />
              <Route
                path="admin/images"
                element={
                  <AdminOnly>
                    <Gallery key="all" all />
                  </AdminOnly>
                }
              />
              <Route
                path="admin/settings"
                element={
                  <AdminOnly>
                    <RegistrationSettings />
                  </AdminOnly>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
