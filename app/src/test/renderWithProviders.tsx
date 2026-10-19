import { ReactElement } from 'react';
import { render, RenderResult } from '@testing-library/react';
import userEvent, { UserEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from '../theme';
import { AppStoreProvider } from '@state/appStore.tsx';
import AppRoutes from '../AppRoutes';

type Options = { initialRoute?: string };

// Mirrors the provider stack in main.tsx so a component under test sees the
// same context it sees in production. A fresh QueryClient per call with retry
// off keeps error path tests fast and stops cache bleed between tests.
export function renderWithProviders(
  ui: ReactElement,
  options: Options = {},
): RenderResult & { user: UserEvent; queryClient: QueryClient } {
  const { initialRoute = '/' } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={ queryClient }>
      <ThemeProvider theme={ theme }>
        <AppStoreProvider>
          <MemoryRouter initialEntries={ [initialRoute] }>
            { ui }
          </MemoryRouter>
        </AppStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...result, user: userEvent.setup(), queryClient };
}

// Renders the real navigable app at a starting route, for cross-page and
// conditional-navigation tests.
export function renderApp(initialRoute = '/') {
  return renderWithProviders(<AppRoutes />, { initialRoute });
}
