import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from '@/components/app-shell';
import { LoadingRows } from '@/components/states';
import { ToastProvider } from '@/components/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useRoute } from '@/lib/router';
import { ThemeProvider } from '@/lib/theme';

// Route-level code splitting (performance.md).
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const RecordingsPage = lazy(() => import('@/pages/recordings'));
const UploadPage = lazy(() => import('@/pages/upload'));
const RecordingDetailPage = lazy(() => import('@/pages/recording-detail'));
const NotFoundPage = lazy(() => import('@/pages/not-found'));

const TITLES = {
  dashboard: 'Overview',
  recordings: 'Recordings',
  upload: 'Upload recording',
  recording: 'Recording',
  'not-found': 'Not found',
} as const;

function CurrentPage() {
  const route = useRoute();
  useEffect(() => {
    document.title = `${TITLES[route.name]} · Voice Intelligence Platform`;
  }, [route.name]);
  switch (route.name) {
    case 'dashboard':
      return <DashboardPage />;
    case 'recordings':
      return <RecordingsPage />;
    case 'upload':
      return <UploadPage />;
    case 'recording':
      return <RecordingDetailPage key={route.id} id={route.id} />;
    default:
      return <NotFoundPage />;
  }
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>
          <AppShell>
            <Suspense fallback={<LoadingRows label="Loading page" />}>
              <CurrentPage />
            </Suspense>
          </AppShell>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
