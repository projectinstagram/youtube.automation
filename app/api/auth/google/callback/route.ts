import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, getChannelInfo, encryptToken } from '@/lib/google/auth';
import { upsertYouTubeAccount, updateSettings, log } from '@/lib/db/operations';

/**
 * GET /api/auth/google/callback
 * Handles the OAuth callback from Google.
 * Exchanges the code for tokens, fetches channel info, stores securely.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // Handle user-denied access
  if (error) {
    await log('WARN', 'AUTH', `OAuth denied by user: ${error}`);
    return NextResponse.redirect(
      new URL(`/settings?auth_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  // Validate state to prevent CSRF
  if (state !== 'youtube-shorts-auth') {
    await log('ERROR', 'AUTH', 'Invalid OAuth state parameter - possible CSRF attack', {
      receivedState: state,
      url: request.url,
    });
    return NextResponse.redirect(new URL('/settings?auth_error=invalid_state', request.url));
  }

  if (!code) {
    return NextResponse.redirect(new URL('/settings?auth_error=no_code', request.url));
  }

  try {
    await log('INFO', 'AUTH', 'Exchanging authorization code for tokens');

    // Exchange code for tokens
    const { accessToken, refreshToken, expiryDate } = await exchangeCodeForTokens(code);

    // Encrypt tokens before storage
    const encryptedAccess = encryptToken(accessToken);
    const encryptedRefresh = encryptToken(refreshToken);

    // Get channel information
    const channelInfo = await getChannelInfo(refreshToken);

    await log('INFO', 'AUTH', `YouTube channel authorized: ${channelInfo.channelName}`, {
      channelId: channelInfo.channelId,
    });

    // Save account to database
    const account = await upsertYouTubeAccount({
      channel_id: channelInfo.channelId,
      channel_name: channelInfo.channelName,
      channel_thumbnail: channelInfo.channelThumbnail,
      access_token: encryptedAccess,
      refresh_token: encryptedRefresh,
      token_expiry: expiryDate.toISOString(),
      is_active: true,
      authorized_at: new Date().toISOString(),
      revoked_at: undefined,
    });

    // Link account to settings
    await updateSettings({ youtube_account_id: account.id });

    await log('INFO', 'AUTH', 'YouTube account saved and linked to settings');

    // Redirect to settings page with success
    return NextResponse.redirect(
      new URL(`/settings?auth_success=true&channel=${encodeURIComponent(channelInfo.channelName)}`, request.url)
    );
  } catch (err: unknown) {
    const authError = err as Error;
    await log('ERROR', 'AUTH', `OAuth callback failed: ${authError.message}`, {
      stack: authError.stack,
    });

    return NextResponse.redirect(
      new URL(`/settings?auth_error=${encodeURIComponent(authError.message)}`, request.url)
    );
  }
}
