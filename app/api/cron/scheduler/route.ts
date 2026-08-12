import { NextRequest, NextResponse } from 'next/server';
import { runScheduler } from '@/lib/scheduler';
import { log } from '@/lib/db/operations';

/**
 * GET /api/cron/scheduler
 * Triggered by Vercel Cron Jobs every hour (or as configured).
 * Protected by CRON_SECRET to prevent unauthorized triggering.
 *
 * Vercel Cron: vercel.json schedule triggers this endpoint.
 * The Authorization header contains: "Bearer <CRON_SECRET>"
 */
export async function GET(request: NextRequest) {
  // ---- SECURITY: Validate cron secret ----
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error('[CRON] CRON_SECRET is not configured!');
    return NextResponse.json(
      { success: false, error: 'Cron secret not configured' },
      { status: 500 }
    );
  }

  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    await log('WARN', 'CRON', 'Unauthorized cron trigger attempt', {
      ip: request.headers.get('x-forwarded-for') || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
    });
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // ---- Run scheduler ----
  await log('INFO', 'CRON', 'Cron job triggered by Vercel');

  try {
    const result = await runScheduler('cron');

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err: unknown) {
    const error = err as Error;
    await log('ERROR', 'CRON', `Cron job crashed: ${error.message}`, {
      stack: error.stack,
    });

    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/cron/scheduler
 * Manual trigger for testing (also requires CRON_SECRET).
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  await log('INFO', 'CRON', 'Manual scheduler trigger via API');

  try {
    const result = await runScheduler('manual');
    return NextResponse.json({ success: true, data: result });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
