import { NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/lib/google/auth';

/**
 * GET /api/auth/google
 * Initiates the Google OAuth flow.
 * Redirects the administrator to Google's consent screen.
 * NEVER expose Google secrets to the browser.
 */
export async function GET() {
  try {
    const authUrl = getAuthorizationUrl();
    return NextResponse.redirect(authUrl);
  } catch (err: unknown) {
    const error = err as Error;
    console.error('[AUTH] Failed to generate auth URL:', error.message);
    return NextResponse.json(
      { success: false, error: 'Failed to initiate OAuth flow' },
      { status: 500 }
    );
  }
}
