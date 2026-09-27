import type { Me } from '../api.ts';
import { UsersPanel } from '../components/UsersPanel.tsx';

export function UsersPage({ me }: { me: Me }) {
  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <p>Everyone who can sign in. New accounts get a one-time password they must replace.</p>
      </div>
      <UsersPanel me={me} />
    </>
  );
}
