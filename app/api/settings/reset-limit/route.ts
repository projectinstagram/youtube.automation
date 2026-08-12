import { NextResponse } from 'next/server';
import { resetDailyUploadCount, log } from '@/lib/db/operations';

/**
 * POST /api/settings/reset-limit
 * Resets today's upload count back to zero so the scheduler can upload again,
 * without touching real upload_history records.
 */
export async function POST() {
  try {
    const updated = await resetDailyUploadCount();
    await log('INFO', 'SCHEDULER', 'Daily upload limit manually reset');
    return NextResponse.json({ success: true, data: updated });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
