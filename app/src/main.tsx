import { BrowserRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from './theme';
import { createQueryClient } from '@lib/queryClient';
import { loadThemeFonts } from '@design/fonts';
import { themeTokens } from '@design/tokens';

import AppRoutes from './AppRoutes';
import { AppStoreProvider } from '@state/appStore.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import { GlobalStyles } from '@mui/material';

const queryClient = createQueryClient();

const App = () => {
  return (

    <QueryClientProvider client={ queryClient }>
      <ThemeProvider theme={ theme }>

        <AppStoreProvider>
          <CssBaseline enableColorScheme/>
          <GlobalStyles
            styles={ {
              // Split html / body styles deliberately. Applying
              // overscroll-behavior:none to BOTH made Android Chrome create
              // two nested scroll containers: single-finger drag would
              // scroll one and require two fingers for the other. body is
              // the single scroll container that gets the rubber-banding
              // fix; html stays untouched.
              'body': {
                overscrollBehavior: 'none',
              },
            } }
          />
          { /* BASE_URL is '/' in normal builds; the hosted demo is served
               from a subpath (GitHub Pages), where Vite sets it via --base. */ }
          <BrowserRouter basename={ import.meta.env.BASE_URL }>
            <AppRoutes />
          </BrowserRouter>
        </AppStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};


async function enableMocking() {
  if (import.meta.env.VITE_ENV !== 'demo') {
    return;
  }
  // eslint-disable-next-line no-console
  console.info('Enabling MSW worker!');

  const { worker } = await import('./mocks/browser');

  // `worker.start()` returns a Promise that resolves
  // once the Service Worker is up and ready to intercept requests.
  // The worker script lives at the app's base path, which is only '/'
  // when the demo isn't hosted under a subpath.
  return worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}

// A failed boot step still renders the app, in the fallback font if need be.
Promise.all([enableMocking(), loadThemeFonts(themeTokens.type.font)]).catch((error: unknown) => {
  console.error('Rendering after a failed boot step', error);
}).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary componentName='App'>
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
});
