import { NextRequest, NextResponse } from 'next/server';
import { runScheduler } from '@/lib/scheduler';
import { log } from '@/lib/db/operations';

/**
 * POST /api/test
 * Triggers a manual scheduler run with dry_run forced.
 * Also used for testing Drive sync, AI generation, etc.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || !authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { mode = 'dry_run' } = body;

    await log('INFO', 'CRON', `Test run triggered: mode=${mode}`);

    if (mode === 'dry_run') {
      // Force dry run by temporarily setting env
      process.env.DRY_RUN = 'true';
      const result = await runScheduler('manual');
      process.env.DRY_RUN = 'false';
      return NextResponse.json({ success: true, data: result });
    }

    if (mode === 'full') {
      const result = await runScheduler('manual');
      return NextResponse.json({ success: true, data: result });
    }

    return NextResponse.json({ success: false, error: 'Unknown mode' }, { status: 400 });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
