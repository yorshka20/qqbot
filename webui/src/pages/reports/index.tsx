/**
 * Reports page (route entry) — WeChat report viewing.
 */

import { ReportDetail } from '../../components/ReportDetail';
import { ReportList } from '../../components/ReportList';

interface ReportsPageProps {
  /** If provided, show detail view for this report ID */
  reportId?: string;
  /** Called when navigating to a specific report */
  onSelectReport: (id: string) => void;
  /** Called when navigating back to list */
  onBack: () => void;
}

export function ReportsPage({ reportId, onSelectReport, onBack }: ReportsPageProps) {
  const showDetail = !!reportId;

  return (
    <main className="flex-1 min-h-0 overflow-auto p-6">
      {showDetail ? (
        <ReportDetail reportId={reportId} onBack={onBack} />
      ) : (
        <ReportList onSelectReport={onSelectReport} />
      )}
    </main>
  );
}
