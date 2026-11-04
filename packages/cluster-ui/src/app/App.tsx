import { BrowserRouter } from 'react-router';
import { useSession } from '../auth/session';
import { TokenGate } from '../auth/TokenGate';
import { ClusterDataProvider } from './ClusterData';
import { Shell } from './Shell';

export function App() {
  const session = useSession();
  if (!session.token) {
    return <TokenGate rejected={session.rejected} />;
  }
  return (
    <ClusterDataProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </ClusterDataProvider>
  );
}
