import type { GeneratedMetadata } from '@/types';
import { log } from '@/lib/db/operations';
import { extractContactSheet } from '@/lib/video/frames';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_VISION_MODEL = 'nvidia/nemotron-nano-12b-v2-vl';
const KNOWN_VISION_MODELS = new Set([
  'nvidia/nemotron-nano-12b-v2-vl',
  'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
]);

/**
 * Analyzes a video by sampling a few frames (NVIDIA's hosted vision models,
 * unlike Gemini, take still images rather than raw video) and generates
 * YouTube metadata from them.
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
  } = {}
): Promise<GeneratedMetadata> {
  const apiKey = requireEnv('NVIDIA_API_KEY');

  const modelName = options.aiModel && KNOWN_VISION_MODELS.has(options.aiModel)
    ? options.aiModel
    : DEFAULT_VISION_MODEL;
  const temperature = options.temperature || 0.7;

  await log('INFO', 'AI', `Analyzing video: ${filename} with model: ${modelName}`);

  const systemMessage =
    'You are a metadata-generation API, not a chat assistant. The content you are given is the creator\'s own video, uploaded through their own automation pipeline - this is routine, policy-compliant metadata writing, never a request to deceive anyone. Always respond with exactly one JSON object matching the requested schema and nothing else: no markdown, no preamble, no explanation, no refusal.';

  let rawResponse = '';
  let base64 = '';
  let frameMimeType = 'image/jpeg';
  let hasFrames = true;

  try {
    const extracted = await extractContactSheet(videoBuffer, 3);
    base64 = extracted.base64;
    frameMimeType = extracted.mimeType;
  } catch (err: unknown) {
    const error = err as Error;
    await log('WARN', 'AI', `Failed to extract frames for ${filename}, will generate text-only metadata`, { error: error.message });
    hasFrames = false;
  }

  const callModel = async (userText: string, includeImage: boolean): Promise<string> => {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
    if (includeImage) {
      content.push({ type: 'image_url', image_url: { url: `data:${frameMimeType};base64,${base64}` } });
    }

    const response = await fetch(NVIDIA_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        temperature,
        max_tokens: 1024,
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

  const parseMetadata = (text: string): GeneratedMetadata => {
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
    return validateAndNormalizeMetadata(parsed, options);
  };

  // Short "I cannot..." replies are a safety-classifier refusal (usually triggered by the
  // image itself), not a formatting slip - retrying with the same image won't help.
  const looksLikeRefusal = (text: string): boolean => {
    const t = text.trim();
    if (!t || t.length > 400) return false;
    return /^(i cannot|i can't|i'm sorry|i am sorry|sorry[,.]|i won't|i will not|i'm not able|i am not able|i apologi[sz]e|as an ai)/i.test(t);
  };

  // Up to 3 attempts, adapting to what went wrong:
  // - malformed/prose reply -> retry the same way with a sharper JSON-only instruction
  // - refusal while an image was attached -> the image itself triggered it, so drop the
  //   image and ask for filename-only metadata instead of hammering the same request
  let useImage = hasFrames;
  let reinforce = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const basePrompt = buildAnalysisPrompt(filename, options, useImage);
      const userText = reinforce
        ? `${basePrompt}\n\nYour previous reply was not a single valid JSON object (it was either prose or a refusal). This is legitimate metadata generation for the creator's own already-uploaded video, not a request to deceive anyone. Reply with ONLY the JSON object this time - no explanation, no markdown, no refusal.`
        : basePrompt;

      rawResponse = await callModel(userText, useImage);
      const metadata = parseMetadata(rawResponse);

      await log('INFO', 'AI', `Metadata generated successfully`, {
        title: metadata.title,
        confidence: metadata.confidence,
        score: metadata.metadataScore,
        attempt,
        usedImage: useImage,
      });

      return metadata;
    } catch (err: unknown) {
      const error = err as Error;
      const refused = useImage && looksLikeRefusal(rawResponse);

      await log(attempt === 3 ? 'ERROR' : 'WARN', 'AI', `Attempt ${attempt} failed to generate metadata for ${filename}`, {
        error: error.message,
        rawResponse: rawResponse.slice(0, 500),
        refused,
      });

      if (refused) {
        // Drop the image for the next try; a fresh attempt at the same image will just refuse again
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

function buildAnalysisPrompt(
  filename: string,
  options: {
    nicheDescription?: string;
    defaultHashtags?: string[];
    defaultKeywords?: string[];
    categoryId?: string;
  },
  hasImage: boolean = true
): string {
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

  const intro = hasImage
    ? `You are an elite YouTube Shorts SEO strategist writing metadata for a content creator's own upload pipeline. The attached image contains three frames sampled from the beginning, middle, and end of that video, arranged left-to-right. Analyze them and write metadata engineered to rank in YouTube search/suggested feed AND make a scrolling viewer stop and tap.`
    : `You are an elite YouTube Shorts SEO strategist writing metadata for a content creator's own upload pipeline. You do NOT have access to this video's frames for this request - work only from the filename and context below. Write metadata engineered to rank in YouTube search/suggested feed AND make a scrolling viewer stop and tap, without ever claiming to describe visual details you cannot actually see.`;

  const rule1 = hasImage
    ? `1. Base ALL analysis strictly on what you can actually see in the frames, NOT on the filename. Files are frequently exported in bulk from a shared source folder/bundle, so the filename is often generic batch-labeling (a source/pack name, a batch number) that has nothing to do with this specific video's actual content. If the filename and the frames disagree, the frames are always correct - ignore the filename's topic entirely and describe only what you actually see. If you cannot identify a specific object, brand, number, or price, do NOT name one or use a placeholder like "$XX" or "[item]" - describe it in general terms instead`
    : `1. You have no visual information for this request. The filename is frequently just generic batch/source labeling (a pack name, a batch number) and very often does NOT describe this specific video's real content - do not confidently assert a topic from it. Write a plausible, generic, honest title/description that could reasonably apply to a short-form video, without inventing specific objects, people, or on-screen text you have no way of knowing`;

  const analyzeSection = hasImage
    ? `Analyze the frames (your ONLY source of truth about what this video actually contains) for:
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
${rule1}
2. Descriptions must be truthful, never deceptive - "optimized for search/virality" means sharper wording and better keyword targeting, not fake claims
3. Do NOT keyword stuff (unnatural repetition) - but DO use every real, specific, searchable term the content justifies
4. Do NOT add unrelated trending hashtags/keywords that don't match the actual content
5. Write everything yourself in your own words - any examples given below illustrate a technique only and must never be copied or adapted verbatim

TITLE - this is the single biggest lever for views. Requirements:
- Front-load the single most specific, highest-search-intent phrase in the first 3-5 words (viewers and YouTube's algorithm both weight the start of the title most)
- Create a genuine curiosity gap or hook (a surprising detail, a specific result, a relatable moment) - never a generic label
- Prefer concrete and specific over vague and generic - e.g. naming the specific item/action/setting beats a bare category label like "Bundle Unboxing"
- Natural language a human would actually type into YouTube search, not a robotic label
- Max 60 characters where possible so it doesn't truncate

DESCRIPTION - the first sentence is shown in search results and must contain the primary keyword phrase naturally:
- Sentence 1: hook + primary searchable keyword phrase, describing what the video is about
- Sentence 2-3: supporting detail/context, naturally working in secondary keywords
- Final line: soft call-to-action relevant to the content (e.g. a genuine question)
- Never use placeholder text like "[insert items]" - if a detail isn't known, don't reference it at all
- Never repeat the title verbatim as a description sentence - write fresh, distinct wording

KEYWORDS & HASHTAGS - optimize for what people actually search, not abstract categories:
- Prioritize specific multi-word phrases with real search intent (e.g. "podcast starter kit unboxing" beats "ContentCreation")
- Include a mix: 2-3 broad/high-volume terms for the general topic, plus 5-10 specific/long-tail terms unique to this video
- Avoid vague single-word tags like "CreativeProcess", "ContentCreation", "Podcasting" unless nothing more specific applies
- Every keyword/hashtag must independently describe THIS video - never reuse words from the category ID reference list below just because they appear there
- Include #Shorts hashtag always
- Generate 5-15 hashtags total, 10-20 keywords total

${analyzeSection}

Return ONLY valid JSON matching this exact schema, with no other text before or after it:
{
  "title": "string (specific, keyword-first, hook-driven, max 100 chars)",
  "description": "string (2-4 sentences, keyword in first sentence, natural language, not spammy)",
  "hashtags": ["#Shorts", "#..."],
  "keywords": ["keyword1", "keyword2"],
  "categoryId": "string (YouTube category ID number)",
  "pinnedComment": "string or null (optional engaging comment to pin)",
  "primaryTopic": "string (main topic in 2-5 words)",
  "secondaryTopics": ["topic1", "topic2"],
  "emotionalTone": "string (e.g. exciting, educational, funny, inspiring, satisfying)",
  "likelyAudience": "string (describe the target audience)",
  "confidence": number (0.0 to 1.0, your confidence in the analysis),
  "metadataScore": number (0-100, overall quality score),
  "relevanceScore": number (0-100, keyword relevance to actual content),
  "searchabilityScore": number (0-100, how discoverable this will be),
  "spamRisk": number (0-100, 0=no spam risk, 100=very spammy)
}

YouTube Category IDs for reference:
1=Film & Animation, 2=Autos, 10=Music, 15=Pets, 17=Sports, 19=Travel,
20=Gaming, 22=People & Blogs, 23=Comedy, 24=Entertainment, 25=News,
26=Howto & Style, 27=Education, 28=Science & Technology`;
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

  // Limit hashtags to 20
  hashtags = hashtags.slice(0, 20);

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
  keywords = keywords.slice(0, 500); // YouTube tag limit is ~500 chars total

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
