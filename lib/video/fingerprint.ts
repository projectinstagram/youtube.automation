import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

const execFileAsync = promisify(execFile);
const FFMPEG_BIN = ffmpegPath.path;

/**
 * SHA-256 of the video bytes. Catches exact-duplicate re-uploads (same file added
 * to the Drive folder again under a new file ID). Note: for very large files the
 * scheduler only downloads a truncated sample for AI analysis, so this hashes
 * whatever buffer is actually available - still catches exact re-uploads since a
 * byte-identical file produces an identical prefix.
 */
export function computeFileHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Perceptual difference-hash (dHash) of the first frame, so re-encoded/
 * re-compressed copies of the same footage (different bytes, same visual
 * content) can still be recognized as duplicates, not just byte-identical
 * files. Built on the ffmpeg binary already bundled for frame extraction
 * rather than adding an image-processing dependency (sharp/jimp) for this
 * alone. Uses the first frame specifically (not a probed middle timestamp)
 * to avoid needing a duration lookup just for this cheap check.
 *
 * Returns a 16-char hex string (64 bits). Compare with hammingDistance() - small
 * distances (roughly <= 8 of 64 bits) indicate visually similar/duplicate content.
 */
export async function computeFrameHash(videoBuffer: Buffer): Promise<string | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yts-fingerprint-'));
  const inputPath = path.join(dir, 'input.mp4');
  const rawPath = path.join(dir, 'frame.raw');

  try {
    await writeFile(inputPath, videoBuffer);

    // First frame, scaled to 9x8 grayscale, raw headerless pixel bytes
    await execFileAsync(FFMPEG_BIN, [
      '-i', inputPath,
      '-vf', 'scale=9:8:flags=lanczos,format=gray',
      '-vframes', '1',
      '-f', 'rawvideo',
      '-y', rawPath,
    ]);

    const pixels = await readFile(rawPath);
    if (pixels.length < 72) return null;

    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = pixels[row * 9 + col];
        const right = pixels[row * 9 + col + 1];
        bits += left < right ? '1' : '0';
      }
    }

    // Pack the 64 bits into a 16-char hex string
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) return 64;
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    distance += xor.toString(2).split('1').length - 1;
  }
  return distance;
}
