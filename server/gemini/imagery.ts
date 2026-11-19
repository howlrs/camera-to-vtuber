import type { AvatarStyle, ImageResponse } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { firstImage, generate, imagePart, parseImage, str } from './common.ts';
import { jsonPost } from '../http.ts';
import type { GenerateContentResponse, Part } from '@google/genai';
import type { ModelRole } from '../../shared/protocol.ts';

async function imageCall(role: ModelRole, parts: Part[], aspectRatio?: string): Promise<ImageResponse> {
  const { response, model } = await generate(role, parts, {
    responseModalities: ['IMAGE', 'TEXT'],
    ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
  });
  const image = firstImage(response);
  if (!image) throw new HttpError(502, `Image model returned no image: ${describeNoImage(response)}`);
  return { image, model };
}

function describeNoImage(r: GenerateContentResponse): string {
  return (r.text ?? r.candidates?.[0]?.finishReason ?? r.promptFeedback?.blockReason ?? 'unknown').toString().slice(0, 200);
}

export function texturePrompt(materialName: string, instruction: string): string {
  return `This image is a UV TEXTURE ATLAS for the "${materialName}" material of a 3D avatar, NOT an illustration.
Apply this edit to it: ${instruction}

STRICT REQUIREMENTS:
- Keep the EXACT UV layout: every island/panel stays at the same position, scale, rotation and silhouette. Do not move, resize, add, remove or redraw island shapes.
- Keep transparent / empty regions transparent / empty and keep the background outside the islands unchanged.
- Keep seams and island borders aligned so colors continue across edges.
- Keep the same resolution and aspect ratio as the input image.
- Do not add text, logos, borders, shadows, 3D rendering, perspective or a scene. Output flat texture art only.
- Change only colors, patterns, materials and painted details within the existing islands.`;
}

export function backgroundPrompt(prompt: string): string {
  return `Create a 16:9 background image for a live-streaming VTuber stage: ${prompt}
No people, no characters, no text, no logos, no watermark. Keep the center area calm and uncluttered since an avatar will be placed in front. Soft depth of field, cohesive color palette.`;
}

export function conceptPrompt(style: AvatarStyle, hasReference: boolean): string {
  const p = style.persona;
  const acc = style.accessories.map((a) => `${a.type} (${a.color})`).join(', ') || 'none';
  const cols = style.materials.map((m) => `${m.name}: ${m.color}`).join('; ');
  return `Character design sheet of an original anime-style VTuber avatar: front view, side view and a few facial expression close-ups on a clean light background, with a small color palette strip. No text labels.
Name: ${p.name}. Concept: ${p.tagline}. Personality: ${p.personality}.
Accessories: ${acc}. Colors by part: ${cols || 'unspecified'}.
Stage mood: ${style.stage.backgroundPrompt}.${hasReference ? '\nUse the attached reference render as the base for the character\'s proportions, outfit and colors; keep the same character.' : ''}`;
}

export const textureHandler = jsonPost(async (body) => {
  const image = parseImage(body.image)!;
  const prompt = str(body.prompt, 2000).trim();
  if (!prompt) throw new HttpError(400, 'prompt is required');
  const material = str(body.materialName, 200);
  // Image first, instructions after: some image models weight the trailing text more.
  return imageCall('image', [imagePart(image), { text: texturePrompt(material, prompt) }]);
});

export const backgroundHandler = jsonPost(async (body) => {
  const prompt = str(body.prompt, 2000).trim();
  if (!prompt) throw new HttpError(400, 'prompt is required');
  return imageCall('imageFast', [{ text: backgroundPrompt(prompt) }], '16:9');
});

export const conceptHandler = jsonPost(async (body) => {
  const style = body.style as AvatarStyle | undefined;
  if (!style?.persona || typeof style.persona !== 'object') throw new HttpError(400, 'style is required');
  const safe: AvatarStyle = {
    ...style,
    materials: Array.isArray(style.materials) ? style.materials.slice(0, 40) : [],
    accessories: Array.isArray(style.accessories) ? style.accessories.slice(0, 8) : [],
    stage: style.stage ?? { backgroundPrompt: '', lightColor: '#ffffff', ambientColor: '#888888' },
  };
  const reference = parseImage(body.reference, 'reference', false);
  const parts: Part[] = [{ text: conceptPrompt(safe, !!reference) }, ...(reference ? [imagePart(reference)] : [])];
  return imageCall('image', parts, '16:9');
});
