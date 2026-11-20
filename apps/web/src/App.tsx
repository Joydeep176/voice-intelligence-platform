import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from '@/components/app-shell';
import { LoadingRows } from '@/components/states';
import { ToastProvider } from '@/components/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MotionProvider, PageTransition } from '@/lib/motion';
import { useRoute } from '@/lib/router';
import { ThemeProvider } from '@/lib/theme';

// Route-level code splitting (performance.md).
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const RecordingsPage = lazy(() => import('@/pages/recordings'));
const PipelinePage = lazy(() => import('@/pages/pipeline'));
const UploadPage = lazy(() => import('@/pages/upload'));
const RecordingDetailPage = lazy(() => import('@/pages/recording-detail'));
const NotFoundPage = lazy(() => import('@/pages/not-found'));

const TITLES = {
  dashboard: 'Overview',
  recordings: 'Recordings',
  pipeline: 'Pipeline',
  upload: 'Upload recording',
  recording: 'Recording',
  'not-found': 'Not found',
} as const;

function CurrentPage() {
  const route = useRoute();
  useEffect(() => {
    document.title = `${TITLES[route.name]} · Voice Intelligence Platform`;
  }, [route.name]);
  const page = (() => {
    switch (route.name) {
      case 'dashboard':
        return <DashboardPage />;
      case 'recordings':
        return <RecordingsPage />;
      case 'pipeline':
        return <PipelinePage />;
      case 'upload':
        return <UploadPage />;
      case 'recording':
        return <RecordingDetailPage key={route.id} id={route.id} />;
      default:
        return <NotFoundPage />;
    }
  })();
  return (
    <PageTransition routeKey={route.name === 'recording' ? `recording:${route.id}` : route.name}>
      {page}
    </PageTransition>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <MotionProvider>
        <TooltipProvider delayDuration={300}>
          <ToastProvider>
            <AppShell>
              <Suspense fallback={<LoadingRows label="Loading page" />}>
                <CurrentPage />
              </Suspense>
            </AppShell>
          </ToastProvider>
        </TooltipProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}
