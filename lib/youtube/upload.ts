import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { YouTubeUploadParams, YouTubeUploadResult } from '@/types';
import { log } from '@/lib/db/operations';

// Max retries for transient errors
const MAX_UPLOAD_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * Uploads a video to YouTube using the resumable upload protocol.
 * This handles large files and supports resuming interrupted uploads.
 */
export async function uploadVideoToYouTube(
  auth: OAuth2Client,
  videoStream: NodeJS.ReadableStream,
  videoSize: number,
  params: YouTubeUploadParams,
  onProgress?: (bytesUploaded: number, totalBytes: number) => void
): Promise<YouTubeUploadResult> {
  const youtube = google.youtube({ version: 'v3', auth });

  await log('INFO', 'YOUTUBE', `Starting upload: "${params.title}" (${formatBytes(videoSize)})`);

  const description = buildDescription(params);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      const res = await youtube.videos.insert(
        {
          part: ['snippet', 'status'],
          requestBody: {
            snippet: {
              title: params.title,
              description,
              tags: params.tags,
              categoryId: params.categoryId,
              defaultLanguage: 'en',
            },
            status: {
              privacyStatus: params.privacyStatus,
              selfDeclaredMadeForKids: params.madeForKids,
              madeForKids: params.madeForKids,
            },
          },
          media: {
            mimeType: 'video/mp4',
            body: videoStream,
          },
        },
        {
          // Enable resumable uploads and track progress
          onUploadProgress: (evt) => {
            if (onProgress) {
              onProgress(evt.bytesRead, videoSize);
            }
          },
        }
      );

      const videoId = res.data.id;
      if (!videoId) {
        throw new Error('YouTube returned success but no video ID');
      }

      const youtubeUrl = `https://www.youtube.com/shorts/${videoId}`;

      await log('INFO', 'YOUTUBE', `Upload successful: ${videoId}`, {
        videoId,
        title: params.title,
        url: youtubeUrl,
      });

      return {
        videoId,
        youtubeUrl,
        title: params.title,
        status: res.data.status?.uploadStatus || 'uploaded',
      };
    } catch (err: unknown) {
      lastError = err as Error;
      const error = err as { code?: number; message?: string; errors?: Array<{ reason: string }> };

      await log('WARN', 'YOUTUBE', `Upload attempt ${attempt} failed`, {
        error: error.message,
        code: error.code,
        attempt,
      });

      // Don't retry on non-retryable errors
      if (isNonRetryableError(error)) {
        throw new Error(`YouTube upload failed (non-retryable): ${error.message}`);
      }

      if (attempt < MAX_UPLOAD_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt - 1] || 60_000;
        await log('INFO', 'YOUTUBE', `Retrying upload in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`YouTube upload failed after ${MAX_UPLOAD_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Updates the title/description/tags/category of an already-published video.
 * Used by the metadata-repair pass to fix videos that went out with weak
 * fallback metadata. YouTube's videos.update requires the full snippet on
 * every call - there's no partial-field-update mode - so all four fields are
 * always sent together rather than merged server-side.
 */
export async function updateYouTubeVideoMetadata(
  auth: OAuth2Client,
  youtubeVideoId: string,
  params: Pick<YouTubeUploadParams, 'title' | 'description' | 'tags' | 'categoryId'>
): Promise<void> {
  const youtube = google.youtube({ version: 'v3', auth });
  const description = buildDescription(params);

  await youtube.videos.update({
    part: ['snippet'],
    requestBody: {
      id: youtubeVideoId,
      snippet: {
        title: params.title,
        description,
        tags: params.tags,
        categoryId: params.categoryId,
        defaultLanguage: 'en',
      },
    },
  });

  await log('INFO', 'YOUTUBE', `Updated metadata for already-published video ${youtubeVideoId}`, {
    youtubeVideoId,
    title: params.title,
  });
}

const VERIFY_RETRY_DELAYS_MS = [3_000, 6_000, 12_000];

/**
 * Verifies a YouTube video exists and is processing. Retries with backoff
 * before concluding a video doesn't exist - videos.list can lag behind a
 * just-completed videos.insert by several seconds (observed in production:
 * an upload that returned a valid video ID came back "not found" on an
 * immediate single check), and a false negative here causes the pipeline to
 * treat a video that's actually live as failed and re-upload it as a
 * duplicate on the next run.
 */
export async function verifyYouTubeVideo(
  auth: OAuth2Client,
  videoId: string
): Promise<{ exists: boolean; status?: string; title?: string }> {
  const youtube = google.youtube({ version: 'v3', auth });

  for (let attempt = 0; attempt <= VERIFY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await youtube.videos.list({
        part: ['snippet', 'status'],
        id: [videoId],
      });

      const video = res.data.items?.[0];
      if (video) {
        return {
          exists: true,
          status: video.status?.uploadStatus ?? undefined,
          title: video.snippet?.title ?? undefined,
        };
      }
    } catch (err) {
      await log('WARN', 'YOUTUBE', `Failed to verify video ${videoId} (attempt ${attempt + 1})`, { error: (err as Error).message });
    }

    if (attempt < VERIFY_RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_DELAYS_MS[attempt]));
    }
  }

  return { exists: false };
}

/**
 * Checks YouTube API quota status (approximate).
 */
export async function checkYouTubeQuota(auth: OAuth2Client): Promise<boolean> {
  const youtube = google.youtube({ version: 'v3', auth });

  try {
    // A cheap list call to verify auth + quota
    await youtube.channels.list({ part: ['id'], mine: true });
    return true;
  } catch (err: unknown) {
    const error = err as { code?: number; errors?: Array<{ reason: string }> };
    if (error.code === 403) {
      const reason = error.errors?.[0]?.reason;
      if (reason === 'quotaExceeded') return false;
    }
    return true; // Assume OK for other errors
  }
}

// ============================================================
// Helpers
// ============================================================

function buildDescription(params: { description: string; tags: string[] }): string {
  const hashtagLine = params.tags
    .filter((t) => t.startsWith('#'))
    .slice(0, 5)
    .join(' ');

  return params.description + (hashtagLine ? `\n\n${hashtagLine}` : '');
}

function isNonRetryableError(error: { code?: number; errors?: Array<{ reason: string }> }): boolean {
  const nonRetryableCodes = [400, 401, 403, 404, 409];
  if (error.code && nonRetryableCodes.includes(error.code)) {
    // 403 quotaExceeded is retryable (next day), but 403 forbidden is not
    if (error.code === 403) {
      const reason = error.errors?.[0]?.reason;
      if (reason === 'quotaExceeded') return true; // Don't retry quota
      return false; // Other 403s might be transient
    }
    return true;
  }
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// YouTube Category IDs (for reference)
// ============================================================
export const YOUTUBE_CATEGORIES: Record<string, string> = {
  '1': 'Film & Animation',
  '2': 'Autos & Vehicles',
  '10': 'Music',
  '15': 'Pets & Animals',
  '17': 'Sports',
  '18': 'Short Movies',
  '19': 'Travel & Events',
  '20': 'Gaming',
  '21': 'Videoblogging',
  '22': 'People & Blogs',
  '23': 'Comedy',
  '24': 'Entertainment',
  '25': 'News & Politics',
  '26': 'Howto & Style',
  '27': 'Education',
  '28': 'Science & Technology',
  '29': 'Nonprofits & Activism',
};
