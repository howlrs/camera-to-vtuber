import type { Object3D } from 'three';
import type { FacePart, MaterialCategory, MaterialInfo, MaterialStyle } from '../../shared/protocol.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';
import type { HairSettings } from './HairPhysics.ts';

export interface AvatarMeta {
  name: string;
  authors: string[];
  licenseUrl: string;
  /** Text that must be displayed when creditNotation is "required". */
  credit: string | null;
  /** Permissions summary (avatarPermission / commercialUsage / modification). */
  permissions: string;
}

export interface ExportOptions {
  /** Avatar name written to the file's meta. */
  name?: string;
  /** PNG thumbnail written to the file's meta. */
  thumbnail?: Uint8Array;
}

/** Hair sway controls (spring-bone hair). See HairPhysics. */
export interface HairControl {
  /** Spring joints treated as hair (0 when the model has springs but no hair). */
  readonly jointCount: number;
  readonly settings: HairSettings;
  configure(settings: Partial<HairSettings>): void;
  /** Current hair bend from rest, in degrees. */
  deflection(): { mean: number; max: number };
}

/**
 * Anything that can be driven by a MotionFrame. VrmAvatar is the default implementation; other
 * formats (e.g. Live2D, glTF with a custom bone map) plug in by implementing this interface.
 */
export interface AvatarRig {
  readonly object: Object3D;
  readonly meta: AvatarMeta;
  /** Height of the head bone above the feet (meters), for camera framing. */
  readonly headHeight: number;
  /** Distance from the head bone up to the top of the head/hair (meters), for accessories. */
  readonly headSize: number;
  readonly hasUpperChest: boolean;
  /** Hair physics, or null when the model has no spring bones. */
  readonly hair: HairControl | null;
  hasBone(name: HumanBoneName): boolean;
  /**
   * Node that follows a bone with the avatar-convention axes (+Z forward, +X = avatar's left),
   * for attaching accessories and props.
   */
  getBoneNode(name: HumanBoneName): Object3D | null;
  apply(motion: MotionFrame): void;
  update(dt: number): void;
  /** Materials grouped for the Gemini designer (follows the sample's own structure). */
  describeMaterials(): MaterialInfo[];
  applyMaterialStyle(style: MaterialStyle): boolean;
  /** Current texture of a material as an image source (for restyling), or null. */
  getMaterialTexture(name: string): HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
  /**
   * Replace a material's texture atlas, and the same atlas in every material sharing it.
   * Returns the names of the materials that changed.
   */
  replaceMaterialTexture(name: string, image: HTMLCanvasElement): string[];
  /**
   * White where the meshes using this material's atlas sample it (islands, slightly grown), at the
   * given size; null when that cannot be known (wrapping UVs, texture transforms).
   */
  uvMask(name: string, width: number, height: number, opts?: { pad?: number; side?: 'left' | 'right' }): HTMLCanvasElement | null;
  /**
   * The body skin atlas region (at the atlas size) that a limb's triangles sample (bones:
   * upper/lower arm or leg), for painting clothes onto bare arms or legs. Null when the model has
   * no skinned body skin.
   */
  limbMask(kind: 'arms' | 'legs'): { material: string; mask: HTMLCanvasElement } | null;
  /** Hide or show every mesh drawn with this material (kept in the export as an invisible material). */
  setHidden(name: string, hidden: boolean): boolean;
  /**
   * For an iris atlas: the atlas side holding the avatar's own left eye, 'shared' when both eyes
   * sample the same island, undefined when unknown.
   */
  leftEyeSide(name: string): 'left' | 'right' | 'shared' | undefined;
  /**
   * After a repaint/recolor the texture carries the colors: drop the old tint, keep the shade
   * depth, and move any glow to the hue of `tint` (the new main color, when known).
   */
  useTextureColors(name: string, tint?: string): void;
  resetStyle(): void;
  /** The current look written into a copy of the loaded .vrm file. */
  exportVrm(options?: ExportOptions): Promise<Blob>;
  dispose(): void;
}

/** Category from VRoid-style material names ("Hair_00_HAIR") or common keywords. */
export function categorizeMaterial(name: string): MaterialCategory {
  const n = name.toUpperCase();
  const suffix = n.match(/_(SKIN|HAIR|CLOTH|EYE|FACE)(?:\b|_|$)/)?.[1];
  if (suffix) return suffix as MaterialCategory;
  if (/HAIR|KAMI/.test(n)) return 'HAIR';
  if (/EYE|IRIS|HIGHLIGHT/.test(n)) return 'EYE';
  if (/FACE|MOUTH|BROW|LASH/.test(n)) return 'FACE';
  if (/BODY|SKIN|HADA/.test(n)) return 'SKIN';
  if (/CLOTH|WEAR|HUKU|FUKU|TOPS|BOTTOM|SHOE|DRESS|SKIRT|SHIRT|COAT/.test(n)) return 'CLOTH';
  return 'OTHER';
}

/** Face part from VRoid-style names (EyeIris, FaceBrow, FaceEyelash, FaceEyeline, Face_00_SKIN). */
export function facePart(name: string, category: MaterialCategory): FacePart | undefined {
  if (category === 'HAIR' || category === 'CLOTH') return undefined;
  const n = name.toLowerCase();
  if (/iris|hitomi|瞳|黒目|pupil/.test(n)) return 'iris';
  if (/highlight|hilight|ハイライト/.test(n)) return 'highlight';
  if (/eyewhite|eye_white|白目|sclera/.test(n)) return 'eyeWhite';
  if (/brow|mayu|眉/.test(n)) return 'brow';
  if (/lash|matsuge|まつげ|まつ毛|睫/.test(n)) return 'lash';
  if (/eyeline|eye_line|アイライン/.test(n)) return 'line';
  if (/mouth|kuchi|口/.test(n)) return 'mouth';
  if (category === 'SKIN' && /face|kao|顔/.test(n)) return 'face';
  return undefined;
}
