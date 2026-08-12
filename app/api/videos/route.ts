import { NextRequest, NextResponse } from 'next/server';
import { getAllVideos, getVideosByStatus, supabase } from '@/lib/db/operations';
import type { VideoStatus } from '@/types';

/**
 * GET /api/videos?status=QUEUED&limit=50&offset=0
 * Returns videos with optional status filter.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as VideoStatus | null;
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    let videos;
    if (status && status !== 'ALL' as VideoStatus) {
      videos = await getVideosByStatus(status);
    } else {
      videos = await getAllVideos(limit, offset);
    }

    // Join AI metadata
    const videoIds = videos.map((v) => v.id);
    let aiMetaMap: Record<string, unknown> = {};

    if (videoIds.length > 0) {
      const { data: aiData } = await supabase
        .from('ai_metadata')
        .select('*')
        .in('video_id', videoIds);

      if (aiData) {
        for (const meta of aiData) {
          aiMetaMap[meta.video_id] = meta;
        }
      }
    }

    const enrichedVideos = videos.map((v) => ({
      ...v,
      ai_metadata: aiMetaMap[v.id] || null,
    }));

    return NextResponse.json({ success: true, data: enrichedVideos });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
