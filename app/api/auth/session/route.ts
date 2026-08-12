import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { createSessionToken, isEmailAllowed, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { log } from '@/lib/db/operations';

/**
 * POST /api/auth/session
 * Verifies a Google Identity Services ID token (dashboard login, separate
 * from the YouTube-channel-linking OAuth flow) and, if the email is on the
 * allowlist, issues a signed session cookie gating access to the app.
 */
export async function POST(request: NextRequest) {
  try {
    const { credential } = await request.json();
    if (typeof credential !== 'string' || !credential) {
      return NextResponse.json({ success: false, error: 'Missing credential' }, { status: 400 });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 500 });
    }

    const client = new google.auth.OAuth2(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified) {
      return NextResponse.json({ success: false, error: 'Email not verified' }, { status: 403 });
    }

    if (!isEmailAllowed(payload.email)) {
      await log('WARN', 'AUTH', `Rejected dashboard login from unauthorized email: ${payload.email}`);
      return NextResponse.json({ success: false, error: 'This account is not authorized' }, { status: 403 });
    }

    const token = createSessionToken(payload.email);
    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });

    await log('INFO', 'AUTH', `Dashboard login: ${payload.email}`);
    return response;
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 401 });
  }
}
