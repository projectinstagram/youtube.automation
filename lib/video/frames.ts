import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffprobePath from '@ffprobe-installer/ffprobe';

const execFileAsync = promisify(execFile);

// Bundled static binaries (rather than relying on a system install) so this
// also works on serverless hosts like Vercel, which don't ship ffmpeg/ffprobe.
const FFMPEG_BIN = ffmpegPath.path;
const FFPROBE_BIN = ffprobePath.path;

/**
 * Extracts evenly-spaced frames from a video and combines them into a single
 * side-by-side JPEG "contact sheet". Used because NVIDIA's hosted vision
 * models take still images, not raw video, unlike Gemini's inline video input.
 */
export async function extractContactSheet(
  videoBuffer: Buffer,
  frameCount = 3
): Promise<{ base64: string; mimeType: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yts-frames-'));
  const inputPath = path.join(dir, 'input.mp4');

  try {
    await writeFile(inputPath, videoBuffer);

    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    const duration = parseFloat(stdout.trim()) || 10;

    const timestamps = Array.from(
      { length: frameCount },
      (_, i) => (duration * (i + 1)) / (frameCount + 1)
    );

    const framePaths: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const framePath = path.join(dir, `frame${i}.jpg`);
      await execFileAsync(FFMPEG_BIN, [
        '-ss', timestamps[i].toFixed(2),
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=480:-1',
        '-q:v', '5',
        '-y', framePath,
      ]);
      framePaths.push(framePath);
    }

    const combinedPath = path.join(dir, 'combined.jpg');
    const inputArgs = framePaths.flatMap((p) => ['-i', p]);
    await execFileAsync('ffmpeg', [
      ...inputArgs,
      '-filter_complex', `hstack=inputs=${framePaths.length}`,
      '-q:v', '5',
      '-y', combinedPath,
    ]);

    const combinedBuffer = await readFile(combinedPath);
    return { base64: combinedBuffer.toString('base64'), mimeType: 'image/jpeg' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
