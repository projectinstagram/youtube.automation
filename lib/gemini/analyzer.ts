import type { GeneratedMetadata } from '@/types';
import { log } from '@/lib/db/operations';
import { extractContactSheet, extractAudioTrack } from '@/lib/video/frames';
import { verifyMetadata, buildRevisionPrompt, type Evidence } from '@/lib/gemini/verifier';
import { classifyError } from '@/lib/gemini/errors';
import { isCircuitOpen } from '@/lib/gemini/circuitBreaker';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_VISION_MODEL = 'nvidia/nemotron-nano-12b-v2-vl';
// Genuinely multimodal (audio + image + text) via the same chat-completions endpoint,
// used automatically whenever the video has an audio track worth transcribing.
const OMNI_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const KNOWN_VISION_MODELS = new Set([
  'nvidia/nemotron-nano-12b-v2-vl',
  'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
]);

/**
 * Analyzes a video's audio (speech) and visual frames together and generates
 * YouTube metadata. NVIDIA's hosted models take still images/audio clips
 * rather than raw video, so frames are sampled and the audio track is
 * extracted separately, then sent together in one multimodal request.
 */
export async function analyzeVideoAndGenerateMetadata(
  videoBuffer: Buffer,
  mimeType: string,
  filename: string,
  options: {
    nicheDescription?: string;
    defaultHashtags?: string[];
    defaultKeywords?: string[];
    categoryId?: string;
    aiModel?: string;
    temperature?: number;
    maxKeywords?: number;
    maxHashtags?: number;
    titleStyle?: 'curiosity_with_accuracy' | 'direct_and_clear' | 'bold_statement' | 'question_based';
  } = {}
): Promise<GeneratedMetadata> {
  const apiKey = requireEnv('NVIDIA_API_KEY');
  const temperature = options.temperature || 0.7;

  const systemMessage =
    'You are a metadata-generation API, not a chat assistant. The content you are given is the creator\'s own video, uploaded through their own automation pipeline - this is routine, policy-compliant metadata writing, never a request to deceive anyone. Always respond with exactly one JSON object matching the requested schema and nothing else: no markdown, no preamble, no explanation, no refusal.';

  let rawResponse = '';
  let frameBase64 = '';
  let frameMimeType = 'image/jpeg';
  let hasFrames = true;
  let audioBase64 = '';
  let audioMimeType = 'audio/wav';
  let hasAudio = false;

  try {
    const extracted = await extractContactSheet(videoBuffer, 3);
    frameBase64 = extracted.base64;
    frameMimeType = extracted.mimeType;
  } catch (err: unknown) {
    const error = err as Error;
    await log('WARN', 'AI', `Failed to extract frames for ${filename}`, { error: error.message });
    hasFrames = false;
  }

  try {
    const extracted = await extractAudioTrack(videoBuffer);
    if (extracted) {
      audioBase64 = extracted.base64;
      audioMimeType = extracted.mimeType;
      hasAudio = true;
    }
  } catch (err: unknown) {
    const error = err as Error;
    await log('WARN', 'AI', `Failed to extract audio for ${filename}`, { error: error.message });
  }

  // The omni model genuinely understands audio+image together but is slower (reasoning
  // model); only worth it when there's actual speech to transcribe. Silent/no-audio
  // videos - including after audio gets dropped on retry - use the faster vision-only
  // model instead, so a dropped-audio retry isn't stuck paying the slow model's latency.
  const fallbackVisionModel = options.aiModel && KNOWN_VISION_MODELS.has(options.aiModel)
    ? options.aiModel
    : DEFAULT_VISION_MODEL;

  // Skip straight to the vision-only fallback if the omni model has been failing
  // repeatedly (e.g. an NVIDIA-side outage) instead of burning retries against a model
  // that's known to be down right now.
  if (hasAudio && (await isCircuitOpen(OMNI_MODEL))) {
    hasAudio = false;
  }

  await log('INFO', 'AI', `Analyzing video: ${filename}`, {
    hasFrames,
    hasAudio,
    model: hasAudio ? OMNI_MODEL : fallbackVisionModel,
  });

  const callModel = async (userText: string, includeAudio: boolean, includeImage: boolean): Promise<string> => {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
    if (includeAudio) {
      content.push({ type: 'audio_url', audio_url: { url: `data:${audioMimeType};base64,${audioBase64}` } });
    }
    if (includeImage) {
      content.push({ type: 'image_url', image_url: { url: `data:${frameMimeType};base64,${frameBase64}` } });
    }

    const response = await fetch(NVIDIA_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: includeAudio ? OMNI_MODEL : fallbackVisionModel,
        temperature,
        max_tokens: 1536,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`NVIDIA API error ${response.status}: ${errText.slice(0, 300)}`);
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content ?? '';
  };

  const parseMetadata = (text: string): { metadata: GeneratedMetadata; evidence: Evidence } => {
    // Strip markdown code blocks and any leading/trailing chatter around the JSON object
    let cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(cleaned);
    const metadata = validateAndNormalizeMetadata(parsed, options);
    const evidence: Evidence = {
      transcript: typeof parsed._transcript === 'string' ? parsed._transcript : undefined,
      visualSummary: typeof parsed._visualSummary === 'string' ? parsed._visualSummary : undefined,
    };
    return { metadata, evidence };
  };

  // Fast text-only model call, used for the revision pass - no need to re-send
  // audio/image, the evidence text captured from the generator is enough.
  const callRevisionModel = async (userText: string): Promise<string> => {
    const response = await fetch(NVIDIA_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta/llama-3.1-8b-instruct',
        temperature: 0.5,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userText },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`NVIDIA API error ${response.status}: ${errText.slice(0, 300)}`);
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content ?? '';
  };

  const parseRevision = (text: string): GeneratedMetadata => {
    let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    return validateAndNormalizeMetadata(JSON.parse(cleaned), options);
  };

  // Independently verifies metadata against the actual evidence (different model than
  // the generator), and gives it one revision attempt if rejected. Never returns metadata
  // that failed verification - callers must fall back to safe filename-based metadata
  // instead of uploading something the auditor flagged as unsupported/hallucinated.
  const verifyAndRevise = async (
    evidence: Evidence,
    initialMetadata: GeneratedMetadata
  ): Promise<GeneratedMetadata | null> => {
    let current = initialMetadata;
    let revised = false;

    for (let round = 1; round <= 2; round++) {
      let verification;
      try {
        verification = await verifyMetadata(evidence, current, filename);
      } catch (err: unknown) {
        // Verifier infrastructure itself failed (not a rejection) - don't let a transient
        // verifier outage force every video into filename-fallback mode, but make the
        // skip clearly visible in logs rather than silently treating it as approved. No
        // verification result is attached, so the dashboard can tell "unverified" apart
        // from "verified and passed".
        await log('WARN', 'AI', `Verifier unavailable for ${filename}, proceeding without verification for this run`, {
          error: (err as Error).message,
        });
        return current;
      }

      if (verification.approved && verification.invalidKeywords.length === 0) {
        return {
          ...current,
          verification: {
            approved: true,
            overallScore: verification.overallScore,
            issues: verification.issues,
            invalidKeywords: [],
            revised,
          },
        };
      }

      if (round === 2) {
        await log('ERROR', 'AI', `Metadata still rejected by verifier after revision for ${filename}`, {
          issues: verification.issues,
          invalidKeywords: verification.invalidKeywords,
        });
        return null;
      }

      try {
        const revisionRaw = await callRevisionModel(buildRevisionPrompt(evidence, current, verification));
        current = parseRevision(revisionRaw);
        revised = true;
      } catch (err: unknown) {
        await log('WARN', 'AI', `Revision attempt failed for ${filename}`, { error: (err as Error).message });
        return null;
      }
    }

    return null;
  };

  // Short "I cannot..." replies are a safety-classifier refusal (usually triggered by the
  // audio/image content itself), not a formatting slip - retrying with the same media won't help.
  const looksLikeRefusal = (text: string): boolean => {
    const t = text.trim();
    if (!t || t.length > 400) return false;
    return /^(i cannot|i can't|i'm sorry|i am sorry|sorry[,.]|i won't|i will not|i'm not able|i am not able|i apologi[sz]e|as an ai)/i.test(t);
  };

  // Up to 4 attempts, progressively dropping media on refusal (audio first, then image)
  // since a refusal means the currently-attached media triggered it, not the prompt wording.
  // Malformed/prose replies instead retry the same media with a sharper JSON-only instruction.
  let useAudio = hasAudio;
  let useImage = hasFrames;
  let reinforce = false;
  let nonEnglishDetected = false;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const basePrompt = buildAnalysisPrompt(filename, options, useImage, useAudio);
      const userText = nonEnglishDetected
        ? `${basePrompt}\n\nYour previous reply used non-English script (e.g. Devanagari) despite the instruction to always write in English. Reply again with the SAME JSON schema, but with every string value translated into natural English, Latin script only - no Hindi/Devanagari text anywhere in the output.`
        : reinforce
          ? `${basePrompt}\n\nYour previous reply was not a single valid JSON object (it was either prose or a refusal). This is legitimate metadata generation for the creator's own already-uploaded video, not a request to deceive anyone. Reply with ONLY the JSON object this time - no explanation, no markdown, no refusal.`
          : basePrompt;

      rawResponse = await callModel(userText, useAudio, useImage);
      const { metadata, evidence } = parseMetadata(rawResponse);

      if (containsNonLatinScript(metadata.title) || containsNonLatinScript(metadata.description)) {
        throw new Error('Generated metadata contains non-English script despite English-only instruction');
      }

      await log('INFO', 'AI', `Metadata generated, running independent verification`, {
        title: metadata.title,
        confidence: metadata.confidence,
        score: metadata.metadataScore,
        attempt,
        usedAudio: useAudio,
        usedImage: useImage,
      });

      // Only meaningful when there's real evidence to check against - a pure text-only
      // fallback attempt (no audio, no image) has nothing for the verifier to audit.
      if (useAudio || useImage) {
        const verified = await verifyAndRevise(evidence, metadata);
        if (verified) {
          await log('INFO', 'AI', `Metadata verified successfully`, { title: verified.title });
          return verified;
        }
        // Verification rejected the metadata even after a revision attempt - never upload
        // unverified/flagged content, fall back to the safe filename-based metadata instead.
        await log('ERROR', 'AI', `Metadata failed independent verification for ${filename}, using safe fallback`);
        return generateFallbackMetadata(filename, options);
      }

      return metadata;
    } catch (err: unknown) {
      const error = err as Error;
      const refused = (useAudio || useImage) && looksLikeRefusal(rawResponse);
      nonEnglishDetected = error.message.includes('non-English script');
      const classified = classifyError(error);
      const attemptedModel = useAudio ? OMNI_MODEL : fallbackVisionModel;

      await log(attempt === 4 ? 'ERROR' : 'WARN', 'AI', `Attempt ${attempt} failed to generate metadata for ${filename}`, {
        error: error.message,
        rawResponse: rawResponse.slice(0, 500),
        refused,
        nonEnglishDetected,
        errorCode: classified.code,
        retryable: classified.retryable,
        model: attemptedModel,
      });

      // No retry strategy here (dropping media, reinforcing JSON-only) can ever fix a
      // bad API key or a malformed request - stop burning attempts against it immediately.
      if (classified.code === 'AUTHENTICATION_FAILED' || classified.code === 'MALFORMED_REQUEST') {
        break;
      }

      if (nonEnglishDetected) {
        reinforce = false;
      } else if ((refused || classified.code === 'MODEL_UNAVAILABLE') && useAudio) {
        // Drop audio first - it's the more likely refusal trigger (speech content), the
        // omni model is also the slowest option, and a MODEL_UNAVAILABLE/DEGRADED model
        // will never succeed no matter how the prompt is reworded - so this also covers
        // that case, falling back to the (separate) vision-only model instead of retrying
        // a model that's confirmed down.
        useAudio = false;
        reinforce = false;
      } else if ((refused || classified.code === 'MODEL_UNAVAILABLE') && useImage) {
        useImage = false;
        reinforce = false;
      } else {
        reinforce = true;
      }
    }
  }

  // All attempts failed - return fallback metadata based on filename
  return generateFallbackMetadata(filename, options);
}

const TITLE_STYLE_GUIDANCE: Record<string, string> = {
  curiosity_with_accuracy: 'Create a genuine curiosity gap or hook grounded in the strongest actual moment (a surprising statement, a specific result, a relatable moment) - never a generic label.',
  direct_and_clear: 'State plainly and specifically what the video is about - clarity over cleverness, no curiosity-gap withholding.',
  bold_statement: 'Lead with the single boldest, most attention-grabbing true statement the content actually supports - confident, declarative tone.',
  question_based: 'Frame the title as a genuine question the video actually answers, phrased the way someone would search it.',
};

function buildAnalysisPrompt(
  filename: string,
  options: {
    nicheDescription?: string;
    defaultHashtags?: string[];
    defaultKeywords?: string[];
    categoryId?: string;
    maxKeywords?: number;
    maxHashtags?: number;
    titleStyle?: string;
  },
  hasImage: boolean,
  hasAudio: boolean
): string {
  const maxKeywords = options.maxKeywords || 20;
  const maxHashtags = options.maxHashtags || 15;
  const titleStyleGuidance = TITLE_STYLE_GUIDANCE[options.titleStyle || 'curiosity_with_accuracy'];
  const nicheContext = options.nicheDescription
    ? `\n\nChannel niche/topic: ${options.nicheDescription}`
    : '';

  const defaultHashtagsContext =
    options.defaultHashtags && options.defaultHashtags.length > 0
      ? `\nDefault hashtags to consider including: ${options.defaultHashtags.join(', ')}`
      : '';

  const defaultKeywordsContext =
    options.defaultKeywords && options.defaultKeywords.length > 0
      ? `\nDefault keywords to consider: ${options.defaultKeywords.join(', ')}`
      : '';

  const mediaDescription = hasAudio && hasImage
    ? "You are given this video's audio track (the full spoken content/soundtrack) AND an image containing three frames sampled from the beginning, middle, and end of the video, arranged left-to-right."
    : hasAudio
      ? "You are given this video's audio track (the full spoken content/soundtrack). No visual frames are available for this request."
      : hasImage
        ? "You are given an image containing three frames sampled from the beginning, middle, and end of the video, arranged left-to-right. No audio is available for this request."
        : "You have no audio or visual access to this video for this request - work only from the filename and context below.";

  const intro = `You are an elite YouTube Shorts SEO strategist for the Indian market, writing metadata for a content creator's own upload pipeline. This video may be an Indian podcast clip, interview, motivational clip, business/educational discussion, comedy clip, or general entertainment content, in English, Hindi, Hinglish, or another Indian language. ${mediaDescription} Analyze whatever is provided and write metadata engineered to rank in YouTube search/suggested feed AND make a scrolling Indian viewer stop and tap.`;

  const groundingRule = hasAudio && hasImage
    ? `1. The audio is ground truth for anything spoken (names, topics, claims, numbers, quotes) and the image is ground truth for anything visual (setting, on-screen text, people, objects). If they conflict, trust whichever medium actually shows/says it. Never use the filename as a source of fact - it is frequently generic batch/source labeling shared across many unrelated videos. If you cannot identify a specific person, brand, number, or claim, do NOT invent one - describe it in general terms instead`
    : hasAudio
      ? `1. Base ALL analysis strictly on what is actually said in the audio. Never use the filename as a source of fact - it is frequently generic batch/source labeling shared across many unrelated videos. If you cannot identify a specific person, brand, number, or claim, do NOT invent one - describe it in general terms instead`
      : hasImage
        ? `1. Base ALL analysis strictly on what you can actually see in the image. Never use the filename as a source of fact - it is frequently generic batch/source labeling shared across many unrelated videos. If you cannot identify a specific object, brand, number, or price, do NOT name one - describe it in general terms instead`
        : `1. You have no audio or visual information for this request. The filename is frequently just generic batch/source labeling and very often does NOT describe this specific video's real content - do not confidently assert a topic from it. Write a plausible, generic, honest title/description that could reasonably apply to a short-form video, without inventing specifics`;

  const languageRule = hasAudio
    ? `\n6. The audio may be in English, Hindi, Hinglish, or another Indian language, but ALWAYS write the title, description, keywords, and hashtags in English, in Latin script only - never Devanagari or other non-Latin script, and never Hindi vocabulary. Translate/summarize the actual meaning of what was said into natural English a broad audience would search for - do not transliterate or leave Hindi words in place, even if that's the language actually spoken`
    : '';

  const ocrCautionRule = hasImage
    ? `\n7. Reading small/exact on-screen text (precise prices, exact brand spelling, verbatim captions) from a still frame is unreliable - only report specific on-screen text if it is large, clear, and you are genuinely confident, and never invent plausible-sounding text to fill in something you can't actually read clearly. When uncertain, describe the general presence of text/graphics without quoting invented specifics`
    : '';

  const analyzeSection = hasAudio && hasImage
    ? `Analyze the combined audio + visuals for:
- What is actually said: key statements, questions, answers, stories, numbers, names, claims, tone, emotion
- What is actually shown: setting, people, on-screen text, objects, reactions
- The single most compelling/unique moment (spoken or visual) worth hooking a title around
- Main topic and target audience
- Exact phrases Indian viewers would type into YouTube search to find this`
    : hasAudio
      ? `Analyze the audio for:
- What is actually said: key statements, questions, answers, stories, numbers, names, claims, tone, emotion
- The single most compelling/unique spoken moment worth hooking a title around
- Main topic and target audience
- Exact phrases Indian viewers would type into YouTube search to find this`
      : hasImage
        ? `Analyze the frames for:
- Visual content (scenes, objects, activities, people, text/numbers on screen)
- The single most compelling/unique/specific moment worth hooking a title around
- Main topic and context
- Emotional tone and energy
- Target audience
- Exact phrases people would type into YouTube search to find this`
        : `Base your metadata on:
- Any niche/context given above (not the filename - it's unreliable, see rule 1)
- A plausible, generic description of short-form video content, honest about not knowing specifics
- Exact phrases people would type into YouTube search for content like this`;

  return `${intro}

Video filename (unreliable - see rule 1 below): ${filename}${nicheContext}${defaultHashtagsContext}${defaultKeywordsContext}

IMPORTANT RULES:
${groundingRule}
2. Descriptions must be truthful, never deceptive - "optimized for search/virality" means sharper wording and better keyword targeting, not fake claims
3. Do NOT keyword stuff (unnatural repetition) - but DO use every real, specific, searchable term the content justifies
4. Do NOT add unrelated trending hashtags/keywords that don't match the actual content
5. Write everything yourself in your own words - any examples given below illustrate a technique only and must never be copied or adapted verbatim${languageRule}${ocrCautionRule}

TITLE - this is the single biggest lever for views. Requirements:
- Front-load the single most specific, highest-search-intent phrase in the first 3-5 words (viewers and YouTube's algorithm both weight the start of the title most)
- ${titleStyleGuidance}
- Prefer concrete and specific over vague and generic
- Natural language a human would actually type into YouTube search, not a robotic label
- Max 60 characters where possible so it doesn't truncate

DESCRIPTION - the first sentence is shown in search results and must contain the primary keyword phrase naturally:
- Sentence 1: hook + primary searchable keyword phrase, describing what the video is actually about
- Sentence 2-3: supporting detail/context, naturally working in secondary keywords
- Final line: soft call-to-action relevant to the content (e.g. a genuine question)
- Never use placeholder text like "[insert items]" - if a detail isn't known, don't reference it at all
- Never repeat the title verbatim as a description sentence - write fresh, distinct wording

KEYWORDS & HASHTAGS - optimize for what people actually search, not abstract categories:
- Prioritize specific multi-word phrases with real search intent
- Include a mix: 2-3 broad/high-volume terms for the general topic, plus 5-10 specific/long-tail terms unique to this video - all in English, Latin script only
- Avoid vague single-word tags like "Podcast", "Motivation", "Business" unless nothing more specific applies
- Every keyword/hashtag must independently describe THIS video - never reuse words from the category ID reference list below just because they appear there
- Include #Shorts hashtag always
- Generate up to ${maxHashtags} hashtags total, up to ${maxKeywords} keywords total - fewer is fine if the content doesn't justify more, never pad to hit the count

${analyzeSection}

Return ONLY valid JSON matching this exact schema, with no other text before or after it. Every string value must be in English (Latin script) regardless of what language was spoken in the video:
{
  "title": "string, IN ENGLISH (specific, keyword-first, hook-driven, max 100 chars)",
  "description": "string, IN ENGLISH (2-4 sentences, keyword in first sentence, natural language, not spammy)",
  "hashtags": ["#Shorts", "#... (English only)"],
  "keywords": ["keyword1 (English only)", "keyword2"],
  "categoryId": "string (YouTube category ID number)",
  "pinnedComment": "string or null (a genuine discussion-provoking question tied to what was actually said/shown)",
  "primaryTopic": "string (main topic in 2-5 words)",
  "secondaryTopics": ["topic1", "topic2"],
  "emotionalTone": "string (e.g. exciting, educational, funny, inspiring, satisfying)",
  "likelyAudience": "string (describe the target audience)",
  "confidence": number (0.0 to 1.0, your confidence in the analysis),
  "metadataScore": number (0-100, overall quality score),
  "relevanceScore": number (0-100, keyword relevance to actual content),
  "searchabilityScore": number (0-100, how discoverable this will be),
  "spamRisk": number (0-100, 0=no spam risk, 100=very spammy),
  "_transcript": ${hasAudio ? '"string (what was actually said, as close to verbatim as you can - this is used to independently verify your metadata afterward, so be accurate)"' : 'null'},
  "_visualSummary": ${hasImage ? '"string (what is actually visible in the frames - this is used to independently verify your metadata afterward, so be accurate)"' : 'null'}
}

YouTube Category IDs for reference:
1=Film & Animation, 2=Autos, 10=Music, 15=Pets, 17=Sports, 19=Travel,
20=Gaming, 22=People & Blogs, 23=Comedy, 24=Entertainment, 25=News,
26=Howto & Style, 27=Education, 28=Science & Technology`;
}

// Major Indic script Unicode blocks (Devanagari/Hindi, Bengali, Gurmukhi, Gujarati,
// Tamil, Telugu, Kannada, Malayalam). Output must always be English/Latin script -
// this catches cases where the model ignores that instruction despite being told twice.
const NON_LATIN_SCRIPT_PATTERN = /[ऀ-ॿঀ-৿਀-੿઀-૿஀-௿ఀ-౿ಀ-೿ഀ-ൿ]/;

function containsNonLatinScript(text: string): boolean {
  return NON_LATIN_SCRIPT_PATTERN.test(text);
}

// Bare category-reference words the model sometimes echoes from the categoryId
// lookup table in the prompt even when they don't describe the actual video.
const CATEGORY_REFERENCE_WORDS = new Set([
  'film', 'animation', 'autos', 'music', 'pets', 'sports', 'travel', 'gaming',
  'blogs', 'people & blogs', 'comedy', 'entertainment', 'news', 'howto',
  'howto & style', 'education', 'science', 'technology', 'science & technology',
]);

function dedupeCaseInsensitive(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(item.trim());
    }
  }
  return result;
}

function validateAndNormalizeMetadata(
  raw: Record<string, unknown>,
  options: {
    defaultHashtags?: string[];
    defaultKeywords?: string[];
    maxKeywords?: number;
    maxHashtags?: number;
  }
): GeneratedMetadata {
  // Ensure #Shorts is always included, drop leaked category-reference words, dedupe
  let hashtags = dedupeCaseInsensitive(
    (raw.hashtags as string[] || [])
      .filter((h) => typeof h === 'string')
      .filter((h) => !CATEGORY_REFERENCE_WORDS.has(h.replace(/^#/, '').toLowerCase()))
  );
  if (!hashtags.some((h) => h.toLowerCase() === '#shorts')) {
    hashtags = ['#Shorts', ...hashtags];
  }

  // Add default hashtags if not already present
  if (options.defaultHashtags) {
    for (const dh of options.defaultHashtags) {
      if (!hashtags.some((h) => h.toLowerCase() === dh.toLowerCase())) hashtags.push(dh);
    }
  }

  // Limit hashtags to the channel-configured max (default 15)
  hashtags = hashtags.slice(0, options.maxHashtags || 15);

  // Merge keywords with defaults, dropping leaked category-reference words and dupes
  let keywords = dedupeCaseInsensitive(
    (raw.keywords as string[] || [])
      .filter((k) => typeof k === 'string')
      .filter((k) => !CATEGORY_REFERENCE_WORDS.has(k.toLowerCase()))
  );
  if (options.defaultKeywords) {
    for (const dk of options.defaultKeywords) {
      if (!keywords.some((k) => k.toLowerCase() === dk.toLowerCase())) keywords.push(dk);
    }
  }
  // Limit keywords to the channel-configured max (default 20)
  keywords = keywords.slice(0, options.maxKeywords || 20);

  // Sanitize title
  const title = typeof raw.title === 'string'
    ? raw.title.slice(0, 100).trim()
    : 'New Short';

  // Sanitize description
  const description = typeof raw.description === 'string'
    ? raw.description.slice(0, 5000).trim()
    : '';

  // Validate scores
  const clamp = (val: unknown, min: number, max: number): number => {
    const n = typeof val === 'number' ? val : parseFloat(String(val)) || 0;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  const confidence = Math.min(1, Math.max(0, typeof raw.confidence === 'number' ? raw.confidence : 0.5));

  return {
    title,
    description,
    hashtags,
    keywords,
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '22',
    pinnedComment: typeof raw.pinnedComment === 'string' ? raw.pinnedComment : undefined,
    primaryTopic: typeof raw.primaryTopic === 'string' ? raw.primaryTopic : 'Entertainment',
    secondaryTopics: Array.isArray(raw.secondaryTopics) ? raw.secondaryTopics as string[] : [],
    emotionalTone: typeof raw.emotionalTone === 'string' ? raw.emotionalTone : 'neutral',
    likelyAudience: typeof raw.likelyAudience === 'string' ? raw.likelyAudience : 'General audience',
    confidence,
    metadataScore: clamp(raw.metadataScore, 0, 100),
    relevanceScore: clamp(raw.relevanceScore, 0, 100),
    searchabilityScore: clamp(raw.searchabilityScore, 0, 100),
    spamRisk: clamp(raw.spamRisk, 0, 100),
  };
}

function generateFallbackMetadata(
  filename: string,
  options: {
    defaultHashtags?: string[];
    defaultKeywords?: string[];
  }
): GeneratedMetadata {
  // Strip extension and clean up filename for use as title
  const baseName = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const title = baseName.slice(0, 100);

  const hashtags = ['#Shorts', ...(options.defaultHashtags || [])].slice(0, 10);
  const keywords = [...(options.defaultKeywords || [])];

  return {
    title,
    description: `Watch this amazing Short! ${title}`,
    hashtags,
    keywords,
    categoryId: '22',
    primaryTopic: 'Entertainment',
    secondaryTopics: [],
    emotionalTone: 'neutral',
    likelyAudience: 'General audience',
    confidence: 0.2,
    metadataScore: 30,
    relevanceScore: 20,
    searchabilityScore: 25,
    spamRisk: 5,
  };
}
