import type { Object3D } from 'three';
import type { MaterialCategory, MaterialInfo, MaterialStyle } from '../../shared/protocol.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';

export interface AvatarMeta {
  name: string;
  authors: string[];
  licenseUrl: string;
  /** Text that must be displayed when creditNotation is "required". */
  credit: string | null;
  /** Permissions summary (avatarPermission / commercialUsage / modification). */
  permissions: string;
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
  hasBone(name: HumanBoneName): boolean;
  getBoneNode(name: HumanBoneName): Object3D | null;
  apply(motion: MotionFrame): void;
  update(dt: number): void;
  /** Materials grouped for the Gemini designer (follows the sample's own structure). */
  describeMaterials(): MaterialInfo[];
  applyMaterialStyle(style: MaterialStyle): boolean;
  /** Current texture of a material as an image source (for restyling), or null. */
  getMaterialTexture(name: string): HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
  replaceMaterialTexture(name: string, image: HTMLCanvasElement): boolean;
  resetStyle(): void;
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
