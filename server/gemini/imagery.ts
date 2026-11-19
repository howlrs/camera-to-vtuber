import { FACE_PARTS, MAX_REFERENCES, type AvatarStyle, type FacePart, type ImagePayload, type ImageResponse } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { firstImage, generate, imagePart, parseImage, pickEnum, str } from './common.ts';
import { jsonPost } from '../http.ts';
import type { GenerateContentResponse, Part } from '@google/genai';
import type { ModelRole } from '../../shared/protocol.ts';

async function imageCall(role: ModelRole, parts: Part[], aspectRatio?: string, imageSize?: string): Promise<ImageResponse> {
  const imageConfig = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
  const { response, model } = await generate(role, parts, {
    responseModalities: ['IMAGE', 'TEXT'],
    ...(aspectRatio || imageSize ? { imageConfig } : {}),
  });
  const image = firstImage(response);
  if (!image) throw new HttpError(502, `Image model returned no image: ${describeNoImage(response)}`);
  return { image, model };
}

function describeNoImage(r: GenerateContentResponse): string {
  return (r.text ?? r.candidates?.[0]?.finishReason ?? r.promptFeedback?.blockReason ?? 'unknown').toString().slice(0, 200);
}

/** The client paints texels no mesh samples in this key color; the model must leave them alone. */
const UNUSED_KEY =
  'Solid magenta (#ff00ff) marks unused space. Keep every magenta pixel exactly magenta and never paint into it. Every other pixel is sampled by the 3D model, so never draw a transparent or checkerboard background anywhere.';

export function texturePrompt(materialName: string, instruction: string): string {
  return `This image is a UV TEXTURE ATLAS for the "${materialName}" material of a 3D avatar, NOT an illustration.
Apply this edit to it: ${instruction}

STRICT REQUIREMENTS:
- Keep the EXACT UV layout: every island/panel stays at the same position, scale, rotation and silhouette. Do not move, resize, add, remove or redraw island shapes.
- ${UNUSED_KEY}
- Keep seams and island borders aligned so colors continue across edges.
- Keep the same resolution and aspect ratio as the input image.
- Do not add text, logos, borders, shadows, 3D rendering, perspective or a scene. Output flat texture art only.
- Change only colors, patterns, materials and painted details within the existing islands.`;
}

/** Atlas repaint that matches a reference character (transcription). Image 1 is the atlas. */
export function referenceTexturePrompt(materialName: string, instruction: string, references: number): string {
  return `Image 1 is a UV TEXTURE ATLAS for the "${materialName}" material of a VRoid-style 3D avatar, NOT an illustration.
${references > 1 ? `Images 2-${references + 1} show` : 'Image 2 shows'} the character this avatar must look like.
Repaint the atlas so that, once wrapped on the 3D model, this part matches that character: ${instruction}

STRICT REQUIREMENTS:
- Keep the EXACT UV layout: every island/panel stays at the same position, scale, rotation and silhouette. Do not move, resize, add, remove or redraw island shapes.
- ${UNUSED_KEY}
- Keep seams and island borders aligned so colors continue across edges.
- Keep the same resolution and aspect ratio as Image 1.
- If the character's garment has a different cut than the islands (e.g. a skirt drawn on shorts), keep the islands' shape and only carry over its colors and patterns.
- Use the reference images only for colors, patterns, lines and painted details. Never paste the reference drawing, a face, a character, text or a logo into the atlas.
- Keep the shading, folds and strand detail already painted in the atlas; recolor and repattern them instead of replacing them with flat fills.
- Output flat texture art only: no 3D rendering, perspective, borders, shadows or a scene.`;
}

const refsLine = (references: number) =>
  references > 0
    ? `${references > 1 ? `Images 2-${references + 1} show` : 'Image 2 shows'} the character this avatar must look like; use them only as a reference for this part.\n`
    : '';

/** Extra guidance for an iris atlas: which island is which eye. */
export function irisNote(leftEye?: 'left' | 'right'): string {
  const layout = leftEye
    ? `\nThe island on the ${leftEye} side of the atlas is the character's own LEFT eye; the other island is the character's own RIGHT eye (in a front view the character's left eye appears on the image's right).`
    : '';
  return `\nThis atlas holds the IRISES. Paint the iris design inside the existing circles: iris colors and vertical gradient, ring, pupil shape and color, and highlights painted in the iris. Keep each circle's position and size.${layout}`;
}

const SHAPE_NAMES: Partial<Record<FacePart, string>> = { brow: 'EYEBROWS', lash: 'EYELASHES', line: 'EYELINER (upper eyelid line)' };

/**
 * Brows / lashes / eyeliner whose shape is drawn in the texture: redraw the line art on the
 * magenta key; the client turns magenta back into transparency, so the new strokes are the shape.
 */
export function shapeTexturePrompt(materialName: string, part: FacePart, instruction: string, references: number): string {
  return `Image 1 is a texture atlas for the "${materialName}" material of a VRoid-style 3D avatar. It holds the line art of the ${SHAPE_NAMES[part] ?? 'face lines'} on solid magenta (#ff00ff), which is transparent space.
${refsLine(references)}Redraw that line art so it matches the character: ${instruction}

STRICT REQUIREMENTS:
- The atlas is mapped onto fixed face geometry: keep each stroke centred where it is now, with about the same length and direction. You may change thickness, taper, the shape of the ends and the colors.
- Draw the strokes in GRAYSCALE only (black to white, keeping the existing light/dark detail); their color is applied afterwards.
- Everything that is not line art must be exactly solid magenta (#ff00ff). No background, no shading, no glow outside the strokes.
- Crisp strokes with clean anti-aliased edges. No text, no face, no other features.
- Keep the same resolution and aspect ratio as Image 1.`;
}

/** Face skin atlas: add marks only; the client keeps only the texels that changed. */
export function overlayTexturePrompt(materialName: string, instruction: string, references: number): string {
  return `Image 1 is the FACE SKIN texture atlas ("${materialName}") of a VRoid-style 3D avatar, unwrapped flat, NOT a portrait.
${refsLine(references)}Add only this to it: ${instruction}

STRICT REQUIREMENTS:
- Every other pixel must stay exactly as in Image 1: the same skin tone and shading, and the existing features (eye sockets, nose, mouth, ears) at the same positions. Do not redraw, move, sharpen, smooth or recolor anything else.
- ${UNUSED_KEY}
- Paint the additions softly into the skin, at the positions where they belong on this unwrapped face. Keep them as small and as subtle as described; marks on the two cheeks stay separate unless the description joins them.
- Keep the same resolution and aspect ratio as Image 1. No text, no logos.`;
}

/** Closest aspect ratio the image models accept, for an atlas of width / height = aspect. */
export function atlasAspectRatio(aspect: number): string {
  const options: [string, number][] = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['2:3', 2 / 3], ['3:2', 3 / 2]];
  return options.reduce((best, o) => (Math.abs(Math.log(o[1] / aspect)) < Math.abs(Math.log(best[1] / aspect)) ? o : best))[0];
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
  const refs = Array.isArray(body.references) ? body.references : [];
  if (refs.length > MAX_REFERENCES) throw new HttpError(400, `references accepts at most ${MAX_REFERENCES} images`);
  const references: ImagePayload[] = refs.map((r, i) => parseImage(r, `references[${i}]`)!);
  const aspect = typeof body.aspect === 'number' && body.aspect > 0 && Number.isFinite(body.aspect) ? body.aspect : 0;
  const size = typeof body.size === 'number' ? body.size : 0;
  const part = pickEnum(body.part, FACE_PARTS, '' as never) || undefined;
  const leftEye = body.leftEye === 'left' || body.leftEye === 'right' ? body.leftEye : undefined;
  // Image first, instructions after: some image models weight the trailing text more.
  let text: string;
  if (part === 'brow' || part === 'lash' || part === 'line') text = shapeTexturePrompt(material, part, prompt, references.length);
  else if (part === 'face') text = overlayTexturePrompt(material, prompt, references.length);
  else {
    text = references.length ? referenceTexturePrompt(material, prompt, references.length) : texturePrompt(material, prompt);
    if (part === 'iris') text += irisNote(leftEye);
  }
  return imageCall(
    'image',
    [imagePart(image), ...references.map(imagePart), { text }],
    aspect ? atlasAspectRatio(aspect) : undefined,
    size > 1536 ? '2K' : undefined,
  );
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
