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
    { href: '/', label: 'Servers', key: 'servers' },
    { href: '/dashboard', label: 'Dashboard', key: 'dashboard' },
    { href: '/activity', label: 'Activity', key: 'activity' },
    ...(canOperate(me.role) ? [{ href: '/catalog', label: 'Add server', key: 'catalog' }] : []),
    ...(me.role === 'owner'
      ? [
          { href: '/users', label: 'Users', key: 'users' },
          { href: '/settings', label: 'Settings', key: 'settings' },
        ]
      : []),
  ];

  return (
    <div className="shell">
      <nav className="nav">
        <a {...linkProps('/')} className="brand">
          <img className="mark" src="/logo.png" alt="" width={26} height={26} />
          Gamekeep
        </a>

        <div className="navlinks">
          {tabs.map((tab) => (
            <a
              key={tab.key}
              {...linkProps(tab.href)}
              // The detail page belongs to the Servers tab.
              aria-current={
                tab.key === current || (tab.key === 'servers' && current === 'server')
                  ? 'page'
                  : undefined
              }
            >
              {tab.label}
            </a>
          ))}
        </div>

        <span className="spacer" />
        <span className="who">
          {me.username}
          {me.role !== 'member' ? <span className="pill ok plain">{me.role}</span> : null}
        </span>
        <button type="button" className="btn-ghost small" onClick={() => void api.logout().finally(onSignedOut)}>
          Sign out
        </button>
      </nav>

      {children}
    </div>
  );
}
