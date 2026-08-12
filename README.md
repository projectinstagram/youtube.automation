# YouTube Shorts Automation System

A production-ready, fully automated YouTube Shorts publishing system that uploads videos from Google Drive to YouTube on a configurable schedule — with zero daily human intervention after initial setup.

## Architecture

```
Vercel Cron (hourly)
        ↓
/api/cron/scheduler  [CRON_SECRET protected]
        ↓
Check daily quota + upload window (±35 min)
        ↓
Find eligible Drive videos (FIFO/RANDOM/PRIORITY)
        ↓
Atomic DB reservation (prevents concurrent duplicates)
        ↓
AI Analysis via Gemini Flash
        ↓
Upload to YouTube (resumable, with retry + backoff)
        ↓
Verify + save YouTube video ID
        ↓
Mark UPLOADED, stop when quota reached
```

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 + TypeScript |
| Deployment | Vercel |
| Scheduling | Vercel Cron Jobs |
| Database | Supabase (PostgreSQL) |
| Video Source | Google Drive API |
| Upload | YouTube Data API v3 |
| Auth | Google OAuth 2.0 |
| AI | Gemini 1.5 Flash |
| Validation | Zod |
| Email | Nodemailer |

---

## Setup

### 1. Google Cloud Project

Go to https://console.cloud.google.com and:
- Enable: YouTube Data API v3, Google Drive API
- Create OAuth 2.0 Client ID (Web application)
- Add redirect URI: https://your-domain.vercel.app/api/auth/google/callback

### 2. Gemini API Key

Get from https://aistudio.google.com/app/apikey

### 3. Supabase

- Create project at https://supabase.com
- Run supabase/migrations/001_initial_schema.sql in SQL Editor
- Copy Project URL and service_role key

### 4. Environment Variables

```bash
cp .env.example .env.local
# Fill in all values
```

Required:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REDIRECT_URI
- GEMINI_API_KEY
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- CRON_SECRET
- TOKEN_ENCRYPTION_KEY

### 5. Deploy to Vercel

```bash
npm i -g vercel
vercel --prod
# Add env vars via dashboard or CLI
```

### 6. Authorize YouTube

Visit /settings → Click "Connect / Re-authorize" → Complete OAuth

### 7. Connect Drive

Settings → Google Drive → paste folder URL → Connect & Sync

### 8. Enable Automation

Settings → Automation → Enable Automation toggle ON

---

## Security

- OAuth tokens encrypted AES-256-GCM before storage
- Service role key never exposed to browser
- Cron endpoint requires Authorization: Bearer CRON_SECRET
- Supabase RLS enabled on all tables
- Security headers on all routes
- No secrets in logs

## Duplicate Protection

1. UNIQUE constraint on drive_file_id
2. Atomic status update (acts as database lock)
3. youtube_video_id already set = skip
4. Idempotency key per cron run
5. Status eligibility check before processing

## Failure Recovery

- Upload fails: retry with exponential backoff
- Max retries hit: status FAILED, email alert
- OAuth expired: pause + email notification
- Drive file deleted: mark SKIPPED, continue
- Cron crash: next run picks up automatically
- YouTube quota exceeded: all uploads pause until reset

## Dry Run Mode

Set DRY_RUN=true or toggle in Settings. Discovers and analyzes videos, does NOT upload.

## API Routes

- GET  /api/health                       Dashboard stats
- GET  /api/videos                       Video list
- GET/PATCH /api/settings                Settings
- POST /api/drive/sync                   Sync Drive folder
- GET  /api/auth/google                  Start OAuth
- GET  /api/auth/google/callback         OAuth callback
- GET  /api/cron/scheduler               Cron trigger (protected)
- POST /api/cron/scheduler               Manual trigger (protected)
- GET  /api/logs                         System logs

## Local Development

```bash
npm install
cp .env.example .env.local
npm run dev

# Manual cron trigger
curl -X POST http://localhost:3000/api/cron/scheduler \
  -H "Authorization: Bearer your-cron-secret"
```
