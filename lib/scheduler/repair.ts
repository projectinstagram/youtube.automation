import type { OAuth2Client } from 'google-auth-library';
import {
  getVideosNeedingMetadataRepair,
  markMetadataRepairAttempted,
  updateVideoYoutubeTitle,
  saveAIMetadata,
  log,
} from '@/lib/db/operations';
import { downloadDriveFile, checkDriveFileExists } from '@/lib/google/drive';
import { analyzeVideoAndGenerateMetadata } from '@/lib/gemini/analyzer';
import { updateYouTubeVideoMetadata } from '@/lib/youtube/upload';
import type { AutomationSettings } from '@/types';

const REPAIR_WINDOW_HOURS = 48;
// Fetch a generous pool up front; the deadline check below decides how many of
// them actually get processed in this run, rather than guessing a fixed count.
const REPAIR_CANDIDATE_POOL = 25;
// Don't start a new repair attempt unless at least this much time remains
// before the deadline - a single attempt (AI generation with retries, possibly
// including the backup vision model) has been observed taking up to ~90s.
const PER_VIDEO_SAFETY_MARGIN_MS = 90_000;
// Used when no deadline is given (e.g. a bare manual call without a time
// budget) so the pass still terminates instead of running unbounded.
const DEFAULT_BUDGET_MS = 4 * 60 * 1000;

/**
 * Finds recently-uploaded videos that went out with weak/unverified metadata
 * (see getVideosNeedingMetadataRepair for the exact signal) and re-generates +
 * re-verifies their metadata. Only pushes the fix to the live YouTube video if
 * the NEW metadata actually passes independent verification - if the pipeline
 * still can't produce something verified, the live video is left untouched
 * rather than risk replacing one weak title with another. Respects
 * dry_run_mode like the rest of the pipeline.
 *
 * `force` skips the auto_repair_metadata toggle check - used by the manual
 * "Run Repair" button, which should work even if the automatic pass is off.
 *
 * `deadline` (epoch ms) bounds how long this can run for - processes as many
 * candidates as safely fit instead of a fixed count, so the automatic pass
 * embedded in every scheduled run clears more of the backlog on its own as
 * time budget allows, without needing a human to keep clicking "Run Repair".
 */
export async function repairRecentMetadata(
  auth: OAuth2Client,
  settings: AutomationSettings,
  options: { force?: boolean; deadline?: number } = {}
): Promise<{ attempted: number; repaired: number }> {
  if (!settings.auto_repair_metadata && !options.force) {
    return { attempted: 0, repaired: 0 };
  }

  const deadline = options.deadline ?? Date.now() + DEFAULT_BUDGET_MS;
  const candidates = await getVideosNeedingMetadataRepair(REPAIR_WINDOW_HOURS, REPAIR_CANDIDATE_POOL);
  if (candidates.length === 0) {
    return { attempted: 0, repaired: 0 };
  }

  const dryRun = settings.dry_run_mode || process.env.DRY_RUN === 'true';
  let repaired = 0;
  let attempted = 0;

  for (const video of candidates) {
    if (Date.now() > deadline - PER_VIDEO_SAFETY_MARGIN_MS) {
      await log('INFO', 'SCHEDULER', `Repair pass stopping to preserve remaining time budget (${candidates.length - attempted} more candidate(s) queued for next pass)`);
      break;
    }
    attempted++;

    await log('INFO', 'SCHEDULER', `Attempting metadata repair for ${video.filename} (uploaded ${video.uploaded_at})`, { videoId: video.id });

    try {
      if (!video.youtube_video_id) {
        await log('WARN', 'SCHEDULER', `Skipping repair for ${video.filename} - no YouTube video ID recorded`, { videoId: video.id });
        await markMetadataRepairAttempted(video.id);
        continue;
      }

      const fileExists = await checkDriveFileExists(auth, video.drive_file_id);
      if (!fileExists) {
        await log('WARN', 'SCHEDULER', `Skipping repair for ${video.filename} - source Drive file no longer accessible`, { videoId: video.id });
        await markMetadataRepairAttempted(video.id);
        continue;
      }

      const { buffer, mimeType } = await downloadDriveFile(auth, video.drive_file_id);

      const metadata = await analyzeVideoAndGenerateMetadata(buffer, mimeType, video.filename, {
        nicheDescription: settings.niche_description || undefined,
        defaultHashtags: settings.default_hashtags,
        defaultKeywords: settings.default_keywords,
        categoryId: settings.category_id,
        aiModel: settings.ai_model,
        temperature: settings.ai_creativity,
        maxKeywords: settings.max_keywords,
        maxHashtags: settings.max_hashtags,
        titleStyle: settings.title_style,
      });

      if (!metadata.verification?.approved) {
        // Deliberately NOT marking metadata_repaired_at here - leave this video
        // eligible so the next repair pass retries it (with fresh verification
        // rounds) instead of giving up on it permanently after one failure.
        // It naturally stops being a candidate once it ages out of the 48h window.
        await log('WARN', 'SCHEDULER', `Repair regeneration for ${video.filename} was not independently verified either - leaving the live video unchanged, will retry next pass`, {
          videoId: video.id,
        });
        continue;
      }

      if (dryRun) {
        await log('INFO', 'SCHEDULER', `[DRY RUN] Would update YouTube metadata for ${video.filename}: "${metadata.title}"`, { videoId: video.id });
      } else {
        await updateYouTubeVideoMetadata(auth, video.youtube_video_id, {
          title: metadata.title,
          description: metadata.description,
          tags: [...metadata.keywords, ...metadata.hashtags],
          categoryId: metadata.categoryId || settings.category_id,
        });
        await updateVideoYoutubeTitle(video.id, metadata.title);
        repaired++;
      }

      await saveAIMetadata(video.id, {
        title: metadata.title,
        description: metadata.description,
        hashtags: metadata.hashtags,
        keywords: metadata.keywords,
        category_id: metadata.categoryId,
        pinned_comment: metadata.pinnedComment ?? undefined,
        primary_topic: metadata.primaryTopic,
        secondary_topics: metadata.secondaryTopics,
        emotional_tone: metadata.emotionalTone,
        likely_audience: metadata.likelyAudience,
        confidence: metadata.confidence,
        metadata_score: metadata.metadataScore,
        relevance_score: metadata.relevanceScore,
        searchability_score: metadata.searchabilityScore,
        spam_risk: metadata.spamRisk,
        model_used: settings.ai_model,
        verification_approved: metadata.verification?.approved ?? null,
        verification_score: metadata.verification?.overallScore ?? null,
        verification_issues: metadata.verification?.issues ?? [],
        verification_invalid_keywords: metadata.verification?.invalidKeywords ?? [],
        verification_revised: metadata.verification?.revised ?? false,
      });

      await markMetadataRepairAttempted(video.id);

      await log('INFO', 'SCHEDULER', `Metadata repair ${dryRun ? '(dry run) ' : ''}complete for ${video.filename}: "${metadata.title}"`, {
        videoId: video.id,
      });
    } catch (err: unknown) {
      const error = err as Error;
      // Not marking metadata_repaired_at - these are transient failures (download,
      // AI call, YouTube API), so let the next pass retry rather than giving up
      // on the video permanently because of a one-off error.
      await log('ERROR', 'SCHEDULER', `Metadata repair failed for ${video.filename}, will retry next pass: ${error.message}`, { videoId: video.id });
    }
  }

  return { attempted, repaired };
}
