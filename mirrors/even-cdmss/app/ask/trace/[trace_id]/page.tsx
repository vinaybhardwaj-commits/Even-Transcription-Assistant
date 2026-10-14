import { UserTraceClient } from './user-trace-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trace · Ask' };

export default async function Page({ params }: { params: Promise<{ trace_id: string }> }) {
  const { trace_id } = await params;
  return (
    <div>
      <UserTraceClient traceId={trace_id} />
    </div>
  );
}
