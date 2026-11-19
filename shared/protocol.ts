/**
 * Client <-> server contract for every Gemini-backed feature.
 *
 * Kept dependency-free and erasable-syntax-only so it can be imported both by
 * the browser bundle (Vite) and by the Node server (native TS type stripping).
 * All images/audio travel as base64 strings without a data: prefix.
 */

// ---------------------------------------------------------------- model roles

/** Every Gemini call site is bound to a role; the server resolves role -> model at startup. */
export type ModelRole =
  | 'designer' // Pro: persona + avatar restyle spec from text/photo (structured output)
  | 'transcriber' // Neon: read character references, pick a base model, write the transcription spec
  | 'reactor' // Flash-Lite: 1-2 Hz frame -> emotion/gesture (low latency)
  | 'spatial' // Robotics-ER: 2D pointing / boxes of held objects, framing
  | 'live' // Live API (bidi): streaming mic + camera, tool calls, voice
  | 'image' // Nano Banana Pro: concept art, UV-preserving texture restyle
  | 'imageFast' // Nano Banana 2: stage backgrounds
  | 'tts' // Flash TTS: avatar voice for typed lines
  | 'general'; // Flash: misc text tasks

export interface ModelAssignment {
  role: ModelRole;
  /** Resolved model id (without "models/"), or null when no candidate is available. */
  model: string | null;
  candidates: string[];
  purpose: string;
  /** "env" when overridden with GEMINI_MODEL_<ROLE>. */
  source: 'config' | 'env';
}

/** GET /api/models */
export interface ModelsResponse {
  assignments: ModelAssignment[];
  /** False when GEMINI_API_KEY is missing; the client then runs tracking-only. */
  apiKeyConfigured: boolean;
}

// ---------------------------------------------------------------- shared enums

/** VRM 1.0 emotion presets (plus neutral). */
export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Procedural gestures the client can layer on top of tracking. */
export const GESTURES = ['none', 'nod', 'shake', 'tilt', 'bounce', 'wave', 'thinking'] as const;
export type Gesture = (typeof GESTURES)[number];

/** Material categories, derived from VRoid-style names (e.g. "Hair_00_HAIR"). */
export const MATERIAL_CATEGORIES = ['SKIN', 'HAIR', 'CLOTH', 'EYE', 'FACE', 'OTHER'] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

export const ACCESSORIES = ['catEars', 'foxEars', 'horns', 'halo', 'ribbon', 'crown', 'glasses', 'headphones'] as const;
export type AccessoryType = (typeof ACCESSORIES)[number];

/** Gemini prebuilt voices usable by both TTS and Live. */
export const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Laomedeia', 'Achernar', 'Schedar', 'Gacrux',
  'Pulcherrima', 'Achird', 'Sulafat',
] as const;
export type VoiceName = (typeof VOICES)[number];

export interface ImagePayload {
  data: string; // base64
  mimeType: string; // image/jpeg | image/png | image/webp
}

// ---------------------------------------------------------------- designer (Pro)

/** Face parts recognized from material names (VRoid: EyeIris, FaceBrow, FaceEyelash, ...). */
export const FACE_PARTS = ['iris', 'highlight', 'eyeWhite', 'brow', 'lash', 'line', 'mouth', 'face'] as const;
export type FacePart = (typeof FACE_PARTS)[number];

export interface MaterialInfo {
  name: string;
  category: MaterialCategory;
  /** Current base color as #rrggbb. */
  baseColor: string;
  hasTexture: boolean;
  /** Which face part the material draws, when its name tells. */
  part?: FacePart;
  /**
   * For brows / lashes / eyeliner: the shape is drawn in the texture (cut out by alpha), so
   * redrawing the texture changes the shape. False when the mesh gives the shape (a flat strip).
   */
  drawnShape?: boolean;
  /**
   * For irises: the atlas side holding the avatar's own left eye, or 'shared' when both eyes
   * sample the same island (then the eyes cannot get different colors).
   */
  leftEye?: 'left' | 'right' | 'shared';
}

/**
 * How the image model may change a material's texture, or null when only local recolors are safe.
 * - paint: repaint colors and patterns inside the used islands (outfit, iris design)
 * - shape: redraw line art on a transparent key; the new strokes replace the old (brows, lashes)
 * - overlay: add marks on top (blush, freckles, face paint); only the changed texels are kept
 * The image model redraws hair strand, body skin and eye-white atlases as illustrations, so those
 * are never sent; neither are brows drawn by the mesh, where a texture cannot change the shape.
 */
export type RepaintMode = 'paint' | 'shape' | 'overlay';

export function repaintMode(m: Pick<MaterialInfo, 'category' | 'hasTexture' | 'part' | 'drawnShape'>): RepaintMode | null {
  if (!m.hasTexture || m.category === 'HAIR') return null;
  switch (m.part) {
    case 'iris':
      return 'paint';
    case 'brow':
    case 'lash':
    case 'line':
      return m.drawnShape ? 'shape' : null;
    case 'face':
      return 'overlay';
    case undefined:
      return m.category === 'CLOTH' || m.category === 'OTHER' ? 'paint' : null;
    default:
      return null; // highlight, eye white, mouth: recolor only
  }
}

/** A downscaled texture atlas shown to the designer so it can see what each material paints. */
export interface AtlasPreview {
  /** Materials that sample this atlas (several when the model shares one texture). */
  materials: string[];
  image: ImagePayload;
}

/**
 * "design": free restyle from a brief. "transcribe": reproduce the character drawn in
 * `references` on the loaded model as faithfully as its fixed shape allows.
 */
export type DesignMode = 'design' | 'transcribe';

/** POST /api/design */
export interface DesignRequest {
  prompt: string;
  /** Optional camera snapshot used as inspiration (colors, vibe). */
  snapshot?: ImagePayload;
  /** Materials of the currently loaded sample avatar, so the spec follows its structure. */
  materials: MaterialInfo[];
  /** Name of the sample being restyled, e.g. "VRM1_Constraint_Twist_Sample". */
  baseModel: string;
  /** What the base looks like (sleeve length, tie, ...), when known. */
  baseTraits?: string;
  mode?: DesignMode;
  /** Character reference images (transcribe mode), at most MAX_REFERENCES. */
  references?: ImagePayload[];
  /** Downscaled atlases of the textured materials (transcribe mode). */
  atlases?: AtlasPreview[];
}

export const MAX_REFERENCES = 4;

export interface MaterialStyle {
  /** Must be one of DesignRequest.materials[].name. */
  name: string;
  /** Multiplied onto the texture (#rrggbb). Use #ffffff to keep the original. */
  color: string;
  shadeColor?: string;
  rimColor?: string;
  emissive?: string;
}

export interface TextureEdit {
  /** Must be a material name whose hasTexture === true. */
  material: string;
  /** Instruction for the image model; UV layout is always preserved by the server prompt. */
  prompt: string;
}

/**
 * Recolor a textured material locally (no image model): every pixel keeps its shading
 * relative to the atlas average, and the average becomes `color`.
 */
export interface TextureRecolor {
  /** Must be a material name whose hasTexture === true. */
  material: string;
  /** Main tone of the part as seen in the references (#rrggbb). */
  color: string;
  /** Color toward the bottom of the atlas (hair tips; VRoid hair atlases run root -> tip downward). */
  tipColor?: string;
  /** Where the gradient to tipColor starts: 0 = top of the atlas, 1 = bottom. */
  tipStart?: number;
  /** Irises only: the color of the character's own left eye when it differs (heterochromia). */
  leftEyeColor?: string;
}


export interface AccessorySpec {
  type: AccessoryType;
  color: string;
}

export interface Persona {
  name: string;
  tagline: string;
  personality: string;
  voice: VoiceName;
  /** Short instruction for how the avatar talks (used by TTS + Live system prompt). */
  speakingStyle: string;
}

/**
 * Clothes painted onto the body skin where the base model shows skin: arms as long sleeves down to
 * the wrists, legs as trousers or tights down to the ankles. The body's own shading is kept.
 */
export interface BodyPaint {
  /** Sleeve color (#rrggbb) for bare arms. */
  sleeves?: string;
  /** Trouser / tights color (#rrggbb) for bare legs. */
  legs?: string;
}

/** Response of POST /api/design. Applied on top of the loaded VRM sample. */
export interface AvatarStyle {
  persona: Persona;
  materials: MaterialStyle[];
  /** Local recolors; never overlaps textureEdits. */
  recolors: TextureRecolor[];
  textureEdits: TextureEdit[];
  /** Parts of the base the character does not have (e.g. a necktie): hidden, also in the export. */
  hide?: string[];
  bodyPaint?: BodyPaint;
  accessories: AccessorySpec[];
  /** Personality baseline added to tracked emotions, each 0..0.3. */
  expressionBias: Record<Exclude<Emotion, 'neutral'>, number>;
  stage: {
    backgroundPrompt: string;
    lightColor: string;
    ambientColor: string;
  };
}

// ---------------------------------------------------------------- imagery (Nano Banana)

/** POST /api/texture — restyle an existing texture atlas while keeping its UV layout. */
export interface TextureRequest {
  image: ImagePayload;
  prompt: string;
  materialName: string;
  /** Character references to match (transcribe mode), at most MAX_REFERENCES. */
  references?: ImagePayload[];
  /** Atlas width / height, so the output keeps the atlas shape. */
  aspect?: number;
  /** Long side of the atlas in pixels (picks the output resolution). */
  size?: number;
  /** Face part the atlas draws (picks a part-specific prompt). */
  part?: FacePart;
  /** Iris atlases: which side of the atlas holds the character's own left eye. */
  leftEye?: 'left' | 'right';
}

// ---------------------------------------------------------------- transcription (Pro)

/** A model the transcription may be built on. */
export interface BaseCandidate {
  id: string;
  /** What the model looks like: hair length/style, body, outfit shape. */
  traits: string;
}

/** POST /api/transcribe — read character references and choose the closest base model. */
export interface TranscribeRequest {
  references: ImagePayload[];
  /** Optional notes from the user (name, personality, parts the images don't show). */
  notes: string;
  candidates: BaseCandidate[];
}

export interface TranscribeResponse {
  /** One of TranscribeRequest.candidates[].id. */
  baseModel: string;
  /** Why this base fits (Japanese, one or two sentences). */
  reason: string;
  /** One-line description of the character. */
  summary: string;
  /** Detailed visual spec of the character (colors as #rrggbb), used as the design brief. */
  brief: string;
  model: string;
}

/** POST /api/background */
export interface BackgroundRequest {
  prompt: string;
}

/** POST /api/concept — a character sheet illustrating the current style. */
export interface ConceptRequest {
  style: AvatarStyle;
  /** Render of the current avatar, used as the reference image. */
  reference?: ImagePayload;
}

/** Response of /api/texture, /api/background, /api/concept */
export interface ImageResponse {
  image: ImagePayload;
  model: string;
}

// ---------------------------------------------------------------- reactor (Flash-Lite)

/** POST /api/react */
export interface ReactRequest {
  frame: ImagePayload;
  /** Recent speech transcript, if any. */
  transcript?: string;
}

export interface ReactResponse {
  emotion: Emotion;
  /** 0..1 */
  intensity: number;
  gesture: Gesture;
  /** <= 40 chars, optional caption suggestion ('' when none). */
  caption: string;
  model: string;
  latencyMs: number;
}

// ---------------------------------------------------------------- spatial (Robotics-ER)

/** Normalized point [y, x] in 0..1000 (Gemini convention). */
export type Point2D = [number, number];
/** Normalized box [ymin, xmin, ymax, xmax] in 0..1000. */
export type Box2D = [number, number, number, number];

/** POST /api/spatial */
export interface SpatialRequest {
  frame: ImagePayload;
}

export interface SpatialObject {
  label: string;
  point: Point2D;
  box?: Box2D;
  /** Which hand of the person (anatomical, not image side) holds it. */
  heldBy: 'left' | 'right' | 'none';
}

export interface SpatialResponse {
  framing: 'face' | 'upperBody' | 'fullBody' | 'none';
  objects: SpatialObject[];
  /** Coarse anatomical keypoints (nose, wrists, ...) for calibration/debug overlay. */
  keypoints: { label: string; point: Point2D }[];
  model: string;
  latencyMs: number;
}

// ---------------------------------------------------------------- TTS

/** POST /api/tts */
export interface TtsRequest {
  text: string;
  voice?: VoiceName;
  /** Natural-language style direction, e.g. "cheerful, fast". */
  style?: string;
}

export interface TtsResponse {
  /** base64 PCM signed 16-bit little-endian mono */
  audio: string;
  sampleRate: number;
  model: string;
}

// ---------------------------------------------------------------- transcription log

/** POST /api/log — one record per transcription / design run, appended to logs/transcribe.jsonl. */
export interface RunLog {
  kind: 'transcribe' | 'design';
  base: string;
  ok: boolean;
  seconds: number;
  /** Final state and detail of each progress step. */
  steps: { id: string; state: string; detail: string }[];
  /** The spec that was applied (no images). */
  style?: AvatarStyle;
  /** Problems shown to the user (failed or rejected repaints, errors). */
  problems: string[];
}

/** Error body for any /api/* failure (HTTP status >= 400). */
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------- Live (WebSocket /ws/live)

export interface LiveStartOptions {
  voice?: VoiceName;
  /** Persona/system prompt addition (from the designer). */
  persona?: string;
  /** When false the model is told to stay silent and act only through tools. */
  speak: boolean;
  /** Language hint for speech, e.g. "ja-JP". */
  language?: string;
}

export type LiveClientMessage =
  | { type: 'start'; options: LiveStartOptions }
  | { type: 'audio'; data: string } // base64 PCM16LE mono 16 kHz, ~100 ms chunks
  | { type: 'frame'; data: string; mimeType: string } // jpeg, ~1 fps
  | { type: 'text'; text: string }
  | { type: 'stop' };

/** Tools the Live model may call; the server acks them and forwards to the client. */
export type LiveToolCall =
  | { name: 'set_expression'; args: { emotion: Emotion; intensity: number; durationSec?: number } }
  | { name: 'play_gesture'; args: { gesture: Gesture } }
  | { name: 'set_scene'; args: { prompt: string } }
  | { name: 'show_caption'; args: { text: string } };

export type LiveServerMessage =
  | { type: 'ready'; model: string }
  | { type: 'audio'; data: string; sampleRate: number } // base64 PCM16LE mono (24 kHz)
  | { type: 'transcript'; role: 'user' | 'model'; text: string }
  | { type: 'tool'; call: LiveToolCall }
  | { type: 'interrupted' }
  | { type: 'turnComplete' }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason: string };
