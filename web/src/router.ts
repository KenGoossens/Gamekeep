import { useEffect, useState } from 'react';

/**
 * A ~40-line History API router. The app has four routes, and pulling in a
 * routing library for that would outweigh the whole rest of the bundle.
 */
export function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);

  return path;
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState({}, '', to);
  // pushState does not fire popstate, so nudge the listeners ourselves.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export interface Route {
  page: 'dashboard' | 'servers' | 'server' | 'activity' | 'users' | 'catalog' | 'settings';
  serverId?: string;
}

export function parseRoute(path: string): Route {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'dashboard') return { page: 'dashboard' };
  if (parts[0] === 'activity') return { page: 'activity' };
  if (parts[0] === 'users') return { page: 'users' };
  if (parts[0] === 'catalog') return { page: 'catalog' };
  if (parts[0] === 'settings') return { page: 'settings' };
  if (parts[0] === 'servers' && parts[1]) {
    return { page: 'server', serverId: decodeURIComponent(parts[1]) };
  }
  return { page: 'servers' };
}

/** An anchor that routes client-side but still behaves like a real link. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle new-tab, download and modified clicks.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}
