import { NextResponse } from 'next/server';
import { getDashboardStats, getSettings, getLogs, getActiveYouTubeAccount, getActiveDriveSources } from '@/lib/db/operations';
import { getNextUploadTime } from '@/lib/scheduler';

/**
 * GET /api/health
 * Returns full dashboard stats and system health.
 */
export async function GET() {
  try {
    const settings = await getSettings();

    const dailyLimit = settings?.daily_upload_limit || 2;
    const timezone = settings?.timezone || 'Asia/Kolkata';

    const [stats, recentLogs, account, driveSources] = await Promise.all([
      getDashboardStats(timezone, dailyLimit, settings?.upload_count_reset_at),
      getLogs(20),
      getActiveYouTubeAccount(),
      getActiveDriveSources(),
    ]);

    // Calculate next upload time
    let nextUploadTime: string | null = null;
    if (settings) {
      const nextDate = getNextUploadTime(settings);
      nextUploadTime = nextDate ? nextDate.toISOString() : null;
    }

    // Detect health issues
    const healthIssues: string[] = [];

    if (!account) {
      healthIssues.push('No YouTube account connected');
    } else if (account.token_expiry && new Date(account.token_expiry) < new Date()) {
      healthIssues.push('YouTube token may be expired');
    }

    if (driveSources.length === 0) {
      healthIssues.push('No Google Drive folder configured');
    }

    if (!settings?.is_enabled) {
      healthIssues.push('Automation is disabled');
    }

    const errorLogs = recentLogs.filter((l) => l.level === 'ERROR').slice(0, 5);

    return NextResponse.json({
      success: true,
      data: {
        stats,
        settings,
        nextUploadTime,
        healthIssues,
        recentErrors: errorLogs,
        systemHealthy: healthIssues.length === 0,
      },
    });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
