import { google } from 'googleapis';
import { log } from '@/lib/db/operations';

// ============================================================
// Google OAuth Configuration
// ============================================================

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export function createOAuthClient() {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    requireEnv('GOOGLE_REDIRECT_URI')
  );
}

export function getAuthorizationUrl(state?: string): string {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',   // Always get refresh_token
    state: state || 'youtube-shorts-auth',
    include_granted_scopes: true,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiryDate: Date;
}> {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token) {
    throw new Error('No access token received from Google');
  }
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token received. Make sure you passed prompt=consent and access_type=offline.'
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: new Date(tokens.expiry_date || Date.now() + 3600_000),
  };
}

/**
 * Creates an authenticated OAuth2 client using a stored refresh token.
 * Automatically refreshes the access token when expired.
 */
export async function getAuthenticatedClient(
  refreshToken: string,
  currentAccessToken?: string,
  currentExpiry?: string,
  onTokenRefresh?: (accessToken: string, expiry: Date) => Promise<void>
) {
  const oauth2Client = createOAuthClient();

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: currentAccessToken || undefined,
    expiry_date: currentExpiry ? new Date(currentExpiry).getTime() : undefined,
  });

  // Listen for token refresh events to persist new tokens
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token && onTokenRefresh) {
      await log('INFO', 'AUTH', 'Access token refreshed automatically');
      await onTokenRefresh(
        tokens.access_token,
        new Date(tokens.expiry_date || Date.now() + 3600_000)
      );
    }
  });

  return oauth2Client;
}

/**
 * Gets the authenticated YouTube channel info for a given refresh token.
 */
export async function getChannelInfo(refreshToken: string): Promise<{
  channelId: string;
  channelName: string;
  channelThumbnail?: string;
}> {
  const auth = await getAuthenticatedClient(refreshToken);
  const youtube = google.youtube({ version: 'v3', auth });

  const res = await youtube.channels.list({
    part: ['snippet', 'id'],
    mine: true,
  });

  const channel = res.data.items?.[0];
  if (!channel) {
    throw new Error('No YouTube channel found for this account');
  }

  return {
    channelId: channel.id!,
    channelName: channel.snippet?.title || 'Unknown Channel',
    channelThumbnail: channel.snippet?.thumbnails?.default?.url ?? undefined,
  };
}

// ============================================================
// Simple encryption for stored tokens
// (Uses AES-256-GCM via Node.js crypto)
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    // If no key set, return tokens unencrypted (not recommended for production)
    return Buffer.alloc(32, 0);
  }
  // Key must be 32 bytes for AES-256
  return Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf-8');
}

export function encryptToken(token: string): string {
  try {
    const key = getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  } catch {
    // If encryption fails, store as-is (still protected by env vars + Supabase RLS)
    return token;
  }
}

export function decryptToken(encryptedToken: string): string {
  try {
    const key = getEncryptionKey();
    const data = Buffer.from(encryptedToken, 'base64');
    const iv = data.slice(0, 12);
    const tag = data.slice(12, 28);
    const encrypted = data.slice(28);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // If decryption fails, try using as plaintext (handles migration)
    return encryptedToken;
  }
}
