import { NextRequest, NextResponse } from 'next/server';
import { getSettings, updateSettings } from '@/lib/db/operations';
import { z } from 'zod';

const SettingsSchema = z.object({
  is_enabled: z.boolean().optional(),
  daily_upload_limit: z.number().int().min(1).max(10).optional(),
  timezone: z.string().optional(),
  upload_times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).max(6).optional(),
  privacy_status: z.enum(['public', 'unlisted', 'private']).optional(),
  category_id: z.string().optional(),
  selection_strategy: z.enum(['FIFO', 'RANDOM', 'MANUAL_PRIORITY']).optional(),
  default_hashtags: z.array(z.string()).optional(),
  default_keywords: z.array(z.string()).optional(),
  niche_description: z.string().max(500).optional(),
  made_for_kids: z.boolean().optional(),
  max_retry_attempts: z.number().int().min(1).max(10).optional(),
  dry_run_mode: z.boolean().optional(),
  ai_model: z.string().optional(),
  ai_creativity: z.number().min(0).max(1).optional(),
  notify_email: z.string().email().optional().or(z.literal('')),
  notify_on_success: z.boolean().optional(),
  notify_on_failure: z.boolean().optional(),
  notify_on_auth_expired: z.boolean().optional(),
  notify_on_no_videos: z.boolean().optional(),
});

export async function GET() {
  try {
    const settings = await getSettings();
    if (!settings) {
      return NextResponse.json({ success: false, error: 'Settings not found' }, { status: 404 });
    }
    // Never expose sensitive IDs or internal fields unnecessarily
    return NextResponse.json({ success: true, data: settings });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = SettingsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await updateSettings(parsed.data);
    return NextResponse.json({ success: true, data: updated });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
