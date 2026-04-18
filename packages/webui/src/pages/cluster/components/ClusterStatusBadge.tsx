import { statusBadgeClass } from '../utils';

export function ClusterStatusBadge({ status }: { status: string }) {
  return <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${statusBadgeClass(status)}`}>{status}</span>;
}
