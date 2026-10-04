import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, canOperate, type GameServer, type Me } from './api.ts';
import { parseRoute, useRoute } from './router.ts';
import { AppShell } from './components/AppShell.tsx';
import { LoginScreen } from './components/LoginScreen.tsx';
import { SetupScreen } from './components/SetupScreen.tsx';
import { ChangePasswordScreen } from './components/ChangePasswordScreen.tsx';
import { ServersPage } from './pages/ServersPage.tsx';
import { ServerDetailPage } from './pages/ServerDetailPage.tsx';
import { ActivityPage } from './pages/ActivityPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
import { ValidationPage } from './pages/ValidationPage.tsx';
import { CatalogPage } from './pages/CatalogPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { WikiPage } from './pages/WikiPage.tsx';
import { TournamentsPage } from './pages/TournamentsPage.tsx';
import { TournamentDetailPage } from './pages/TournamentDetailPage.tsx';

const POLL_IDLE_MS = 5000;
const POLL_BUSY_MS = 2000;

type Screen = 'loading' | 'setup' | 'login' | 'change-password' | 'app';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [servers, setServers] = useState<GameServer[]>([]);
  const [offline, setOffline] = useState(false);
  const route = parseRoute(useRoute());

  /** Single source of truth for which screen belongs on the page. */
  const decideScreen = useCallback(async () => {
    try {
      const status = await api.authStatus();
      if (status.needsSetup) {
        setMe(null);
        setScreen('setup');
        return;
      }
      if (!status.authenticated) {
        setMe(null);
        setScreen('login');
        return;
      }
      const who = await api.me();
      setMe(who);
      setScreen(who.mustChangePassword ? 'change-password' : 'app');
    } catch {
      setMe(null);
      setScreen('login');
    }
  }, []);

  useEffect(() => {
    void decideScreen();
  }, [decideScreen]);

  // The servers list backs the grid; the detail page polls its own endpoint.
  useEffect(() => {
    if (screen !== 'app' || route.page === 'server') return;
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      if (document.hidden) {
        timer = window.setTimeout(tick, POLL_IDLE_MS);
        return;
      }
      try {
        const list = await api.servers();
        if (cancelled) return;
        setServers(list.servers);
        setOffline(false);
        const busy = list.servers.some(
          (s) => s.activeJob && s.activeJob.phase !== 'done' && s.activeJob.phase !== 'failed',
        );
        timer = window.setTimeout(tick, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          void decideScreen();
          return;
        }
        setOffline(true);
        timer = window.setTimeout(tick, POLL_IDLE_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [screen, route.page, decideScreen]);

  if (screen === 'loading') return null;
  if (screen === 'setup') return <SetupScreen onDone={decideScreen} />;
  if (screen === 'login') return <LoginScreen onSignedIn={decideScreen} />;
  if (screen === 'change-password') return <ChangePasswordScreen onDone={decideScreen} />;
  if (!me) return null;

  return (
    <AppShell me={me} current={route.page} onSignedOut={decideScreen}>
      {offline ? (
        <div className="banner">
          Can’t reach the portal right now. Retrying — this page will catch up on its own.
        </div>
      ) : null}

      {route.page === 'servers' ? <ServersPage servers={servers} /> : null}
      {route.page === 'server' && route.serverId ? (
        <ServerDetailPage
          serverId={route.serverId}
          canOperate={canOperate(me.role)}
          isOwner={me.role === 'owner'}
        />
      ) : null}
      {route.page === 'dashboard' ? <DashboardPage canOperate={canOperate(me.role)} /> : null}
      {route.page === 'activity' ? <ActivityPage /> : null}
      {route.page === 'users' && me.role === 'owner' ? <UsersPage me={me} /> : null}
      {route.page === 'catalog' && canOperate(me.role) ? <CatalogPage /> : null}
      {route.page === 'settings' && me.role === 'owner' ? <SettingsPage /> : null}
      {route.page === 'validation' && me.role === 'owner' ? <ValidationPage /> : null}
      {route.page === 'wiki' ? <WikiPage pageId={route.wikiPage} /> : null}
      {route.page === 'tournaments' ? <TournamentsPage me={me} /> : null}
      {route.page === 'tournament' && route.tournamentId ? (
        <TournamentDetailPage id={route.tournamentId} me={me} />
      ) : null}
    </AppShell>
  );
}
