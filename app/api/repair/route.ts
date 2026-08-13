import { NextRequest, NextResponse } from 'next/server';
import {
  getSettings,
  getActiveYouTubeAccount,
  getActiveDriveSource,
  updateYouTubeTokens,
  log,
} from '@/lib/db/operations';
import { getAuthenticatedClient, decryptToken } from '@/lib/google/auth';
import { repairRecentMetadata } from '@/lib/scheduler/repair';

/**
 * POST /api/repair
 * Manually runs the metadata-repair pass on recently-uploaded (last 48h)
 * videos with weak/unverified metadata. Unlike the pass embedded in the
 * scheduler, this ignores the auto_repair_metadata toggle and processes a
 * larger batch per call, so it can be used to clear a backlog on demand
 * even if the automatic cron-driven pass isn't running.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'Cron secret not configured' }, { status: 500 });
  }
  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  await log('INFO', 'SCHEDULER', 'Manual metadata repair triggered via API');

  try {
    const settings = await getSettings();
    if (!settings) {
      return NextResponse.json({ success: false, error: 'No automation settings found' }, { status: 500 });
    }

    const account = await getActiveYouTubeAccount();
    if (!account) {
      return NextResponse.json({ success: false, error: 'No active YouTube account configured' }, { status: 400 });
    }

    const driveSource = await getActiveDriveSource();
    if (!driveSource) {
      return NextResponse.json({ success: false, error: 'No active Google Drive source configured' }, { status: 400 });
    }

    const decryptedRefreshToken = decryptToken(account.refresh_token);
    const auth = await getAuthenticatedClient(
      decryptedRefreshToken,
      account.access_token ? decryptToken(account.access_token) : undefined,
      account.token_expiry || undefined,
      async (newAccessToken, expiry) => {
        await updateYouTubeTokens(account.id, newAccessToken, expiry);
      }
    );

    const result = await repairRecentMetadata(auth, settings, { force: true });

    await log('INFO', 'SCHEDULER', `Manual metadata repair complete: ${result.repaired}/${result.attempted} video(s) updated`);

    return NextResponse.json({ success: true, data: result });
  } catch (err: unknown) {
    const error = err as Error;
    await log('ERROR', 'SCHEDULER', `Manual metadata repair failed: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
