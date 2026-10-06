import type { ReactNode } from 'react';
import { api, canOperate, type Me } from '../api.ts';
import { linkProps, type Route } from '../router.ts';

interface Props {
  me: Me;
  // Taken from the router rather than repeated here, so adding a page cannot
  // leave the shell and the routes disagreeing about what exists.
  current: Route['page'];
  onSignedOut: () => void;
  children: ReactNode;
}

export function AppShell({ me, current, onSignedOut, children }: Props) {
  const tabs = [
    { href: '/', label: 'Dashboard', key: 'dashboard' },
    { href: '/servers', label: 'Servers', key: 'servers' },
    // Beta until it has been tested and validated end to end; the tag says so.
    { href: '/tournaments', label: 'Tournaments', key: 'tournaments', beta: true },
    { href: '/activity', label: 'Activity', key: 'activity' },
    ...(canOperate(me.role) ? [{ href: '/catalog', label: 'Add server', key: 'catalog' }] : []),
    ...(me.role === 'owner'
      ? [
          { href: '/users', label: 'Users', key: 'users' },
          { href: '/validation', label: 'Validation', key: 'validation' },
          { href: '/settings', label: 'Settings', key: 'settings' },
        ]
      : []),
    // Last on purpose: the manual is the thing you reach for, not live in.
    { href: '/wiki', label: 'Wiki', key: 'wiki' },
  ];

  return (
    <div className="shell">
      <nav className="nav">
        <a {...linkProps('/')} className="brand">
          <img className="mark" src="/logo.png" alt="" width={26} height={26} />
          GameKeepr
        </a>

        <div className="navlinks">
          {tabs.map((tab) => (
            <a
              key={tab.key}
              {...linkProps(tab.href)}
              // The detail page belongs to the Servers tab.
              aria-current={
                tab.key === current ||
                (tab.key === 'servers' && current === 'server') ||
                (tab.key === 'tournaments' && current === 'tournament')
                  ? 'page'
                  : undefined
              }
            >
              {tab.label}
              {'beta' in tab && tab.beta ? <sup className="beta-tag">beta</sup> : null}
            </a>
          ))}
        </div>

        <span className="spacer" />
        <span className="who">
          {me.username}
          {me.role !== 'member' ? <span className="pill ok plain">{me.role}</span> : null}
        </span>
        <button
          type="button"
          className="btn-ghost small"
          // One line, always: the nav just learned that lesson with "Add server".
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          onClick={() => void api.logout().finally(onSignedOut)}
        >
          Sign out
        </button>
      </nav>

      {children}
    </div>
  );
}
