import { useEffect, type ReactNode } from 'react';
import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useAuth } from 'react-oidc-context';
import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Spinner from '@cloudscape-design/components/spinner';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useMe } from '../hooks/useApi';
import { useUnauthorizedRecovery } from '../hooks/useUnauthorizedRecovery';
import { NAV_ITEMS, NAV_LINKS } from '../components/NavItems';
import { CommandPalette } from '../components/CommandPalette';
import { useUiStore } from '../lib/uiStore';

/**
 * Root route — replaces the previous frontend's `App.tsx`. `AppLayout` + `SideNavigation` +
 * `TopNavigation` are Cloudscape's own building blocks for exactly this shape (the same
 * combination the AWS Management Console itself uses), so almost none of this file is
 * hand-rolled layout CSS — that is the point of building on Cloudscape rather than styling divs.
 *
 * Sign-in gating lives here (not in `main.tsx`) so every route under this one automatically
 * requires authentication without each route file re-checking `auth.isAuthenticated`.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

/** True full-screen centering (both axes) wrapper — every other loading/error state in this file
 * still uses `padding={{ top: 'xxxl' }}` (a quick top-anchored placeholder is fine for a state
 * that resolves in under a second), but the sign-in screen is the one state a signed-out user can
 * sit on indefinitely, so it gets a real "centered card on a page" treatment instead of a stack of
 * text pinned to the top of an otherwise empty viewport. */
function CenteredScreen({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '24px',
      }}
    >
      {children}
    </div>
  );
}

function SignInGate() {
  const auth = useAuth();
  return (
    <CenteredScreen>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <Container>
          <Box padding={{ vertical: 'xl', horizontal: 'l' }}>
            <SpaceBetween size="l" alignItems="center">
              <img src="/favicon.svg" alt="ops-dashboard" width={56} height={56} />
              <SpaceBetween size="xxs" alignItems="center">
                <Box variant="h1" textAlign="center">
                  ops-dashboard
                </Box>
                <Box variant="p" color="text-body-secondary" textAlign="center">
                  AWS operations console for abc-prod
                </Box>
              </SpaceBetween>
              <Button variant="primary" fullWidth iconName="user-profile" onClick={() => auth.signinRedirect()}>
                Sign in with Microsoft Entra ID
              </Button>
              <Box variant="small" color="text-body-secondary" textAlign="center">
                Account 123456789012 · ap-southeast-1
              </Box>
            </SpaceBetween>
          </Box>
        </Container>
      </div>
    </CenteredScreen>
  );
}

/** Looks up the human-readable page label for the current pathname from `NAV_LINKS` (the same
 * single source of truth the sidebar and command palette already read from) — used to set both
 * the browser tab title and the breadcrumb's current-page crumb, so the two can never drift out
 * of sync with what the sidebar calls that page. Falls back to the raw path for a page not in
 * `NAV_LINKS` (e.g. the resource detail drill-down, which has no fixed sidebar entry of its own). */
function usePageTitle(pathname: string): string {
  const match = NAV_LINKS.find((link) => link.href === pathname);
  if (match) return match.label;
  if (pathname.startsWith('/resource/')) return 'Resource detail';
  return 'ops-dashboard';
}

function RootLayout() {
  const auth = useAuth();
  // Registers this auth instance for `sessionRecovery.ts` and listens for Entra ID silent-renew
  // failures so an expiring/expired SSO session recovers on its own (signinSilent, falling back
  // to a real sign-out + sign-in) instead of leaving every widget on the page stuck showing
  // "Unauthorized" until someone notices and signs out by hand. Called unconditionally, before any
  // of the loading/error early-returns below, same as every other hook in this component.
  useUnauthorizedRecovery();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const me = useMe();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const currentPath = routerState.location.pathname;
  const pageTitle = usePageTitle(currentPath);

  // Keeps the browser tab title in sync with the current page — without this, every tab reads the
  // static "ops-dashboard" from index.html forever, making it impossible to tell pages apart when
  // several are open, or to find the right tab back from a long browser tab bar.
  useEffect(() => {
    document.title = pageTitle === 'ops-dashboard' ? 'ops-dashboard' : `${pageTitle} · ops-dashboard`;
  }, [pageTitle]);

  if (auth.isLoading) {
    return (
      <CenteredScreen>
        <SpaceBetween size="s" alignItems="center">
          <Spinner size="large" />
          <Box color="text-body-secondary">Initializing…</Box>
        </SpaceBetween>
      </CenteredScreen>
    );
  }
  if (auth.error) {
    return (
      <CenteredScreen>
        <div style={{ width: '100%', maxWidth: 480 }}>
          <Alert type="error" header="Authentication error">
            {auth.error.message}
          </Alert>
        </div>
      </CenteredScreen>
    );
  }
  if (!auth.isAuthenticated) {
    return <SignInGate />;
  }
  if (me.isLoading) {
    return (
      <CenteredScreen>
        <SpaceBetween size="s" alignItems="center">
          <Spinner size="large" />
          <Box color="text-body-secondary">Authenticating…</Box>
        </SpaceBetween>
      </CenteredScreen>
    );
  }
  if (me.isError) {
    return (
      <CenteredScreen>
        <div style={{ width: '100%', maxWidth: 480 }}>
          <Alert type="error" header="Failed to load session">
            {(me.error as Error).message}
          </Alert>
        </div>
      </CenteredScreen>
    );
  }

  const userName = me.data?.name ?? '';
  const initial = (userName || '?').trim().charAt(0).toUpperCase();

  return (
    <>
      <CommandPalette />
      <TopNavigation
        identity={{
          href: '/infra-map',
          title: 'ops-dashboard',
          logo: { src: '/favicon.svg', alt: 'ops-dashboard' },
          onFollow: (e) => {
            e.preventDefault();
            void navigate({ to: '/infra-map' });
          },
        }}
        utilities={[
          {
            type: 'button',
            iconName: 'light-dark',
            text: theme === 'dark' ? 'Dark' : 'Light',
            title: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
            onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
          },
          {
            type: 'menu-dropdown',
            text: userName || 'Account',
            iconName: 'user-profile',
            description: `${initial}`,
            items: [
              {
                id: 'density',
                text: density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density',
              },
              { id: 'signout', text: 'Sign out' },
            ],
            onItemClick: ({ detail }) => {
              if (detail.id === 'signout') void auth.removeUser();
              if (detail.id === 'density') setDensity(density === 'compact' ? 'comfortable' : 'compact');
            },
          },
        ]}
      />
      <AppLayout
        navigationOpen={!sidebarCollapsed}
        onNavigationChange={() => toggleSidebar()}
        toolsHide
        breadcrumbs={
          <BreadcrumbGroup
            items={[
              { text: 'ops-dashboard', href: '/infra-map' },
              ...(currentPath !== '/infra-map' ? [{ text: pageTitle, href: currentPath }] : []),
            ]}
            onFollow={(event) => {
              event.preventDefault();
              void navigate({ to: event.detail.href });
            }}
          />
        }
        navigation={
          <SideNavigation
            activeHref={currentPath}
            header={{ href: '/infra-map', text: 'ops-dashboard' }}
            items={NAV_ITEMS}
            onFollow={(event) => {
              event.preventDefault();
              void navigate({ to: event.detail.href });
            }}
          />
        }
        content={<Outlet />}
      />
    </>
  );
}
