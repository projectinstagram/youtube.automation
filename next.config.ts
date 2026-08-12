import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server-only packages (never bundled into browser)
  serverExternalPackages: [
    'googleapis',
    '@google/generative-ai',
    'nodemailer',
    '@ffmpeg-installer/ffmpeg',
    '@ffprobe-installer/ffprobe',
  ],

  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },

  // Ensure cron/API routes are server-side only
  experimental: {
    // Increase body size limit for large video metadata
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
