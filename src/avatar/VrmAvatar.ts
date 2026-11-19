import {
  Box3,
  CanvasTexture,
  Color,
  Material,
  Mesh,
  Object3D,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MToonMaterial, VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { MaterialInfo, MaterialStyle } from '../../shared/protocol.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';
import { idleBones, restPose } from '../solver/idlePose.ts';
import { type AvatarMeta, type AvatarRig, categorizeMaterial } from './AvatarRig.ts';

interface OriginalLook {
  color: Color;
  shade: Color | null;
  rim: Color | null;
  emissive: Color | null;
  map: Texture | null;
  shadeMap: Texture | null;
}

/**
 * VRM 0.x / 1.0 avatar via @pixiv/three-vrm. Motion is written to normalized humanoid bones,
 * which three-vrm maps onto the model's raw skeleton (so any VRoid / VRM model works as-is).
 */
export class VrmAvatar implements AvatarRig {
  readonly object: Object3D;
  readonly meta: AvatarMeta;
  readonly headHeight: number;
  readonly headSize: number;
  readonly hasUpperChest: boolean;
  private materials = new Map<string, Material>();
  private original = new Map<string, OriginalLook>();
  private readonly hipsRest = new Vector3();
  readonly vrm: VRM;

  private constructor(vrm: VRM) {
    this.vrm = vrm;
    this.object = vrm.scene;
    this.meta = readMeta(vrm);
    this.hasUpperChest = !!vrm.humanoid.getNormalizedBoneNode('upperChest');

    vrm.scene.traverse((o) => {
      o.frustumCulled = false;
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        // three-vrm may clone materials per mesh for outlines; group by base name.
        const name = m.name.replace(/ \(Outline\)$/, '');
        if (!this.materials.has(name)) this.materials.set(name, m);
      }
    });
    for (const [name, m] of this.materials) this.original.set(name, snapshotLook(m));

    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) this.hipsRest.copy(hips.position);
    for (const bone of idleBones()) {
      vrm.humanoid.getNormalizedBoneNode(bone)?.quaternion.copy(restPose(bone));
    }
    vrm.update(0);
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const pos = new Vector3();
    head?.getWorldPosition(pos);
    // Bind-pose bounds (T-pose, so arms are not above the head): max Y is the top of the hair.
    const top = new Box3().setFromObject(vrm.scene).max.y;
    this.headHeight = pos.y || top * 0.9;
    this.headSize = Math.min(0.35, Math.max(0.12, top - this.headHeight));
  }

  static async load(url: string, onProgress?: (ratio: number) => void): Promise<VrmAvatar> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url, (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error('VRMとして読み込めませんでした（VRMC_vrm / VRM 拡張がありません）');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; normalize to +Z like VRM 1.0
    return new VrmAvatar(vrm);
  }

  hasBone(name: HumanBoneName): boolean {
    return !!this.vrm.humanoid.getNormalizedBoneNode(name);
  }

  getBoneNode(name: HumanBoneName): Object3D | null {
    return this.vrm.humanoid.getNormalizedBoneNode(name);
  }

  apply(motion: MotionFrame): void {
    const humanoid = this.vrm.humanoid;
    for (const [bone, q] of motion.bones) {
      humanoid.getNormalizedBoneNode(bone)?.quaternion.copy(q);
    }
    const hips = humanoid.getNormalizedBoneNode('hips');
    if (hips) hips.position.copy(this.hipsRest).add(motion.hipsOffset ?? ZERO);

    const em = this.vrm.expressionManager;
    if (em) {
      for (const [name, w] of motion.expressions) {
        if (em.getExpression(name)) em.setValue(name, w);
      }
    }
    if (this.vrm.lookAt && motion.eye) {
      this.vrm.lookAt.yaw = motion.eye.yaw;
      this.vrm.lookAt.pitch = motion.eye.pitch;
    }
  }

  update(dt: number): void {
    this.vrm.update(dt);
  }

  // ------------------------------------------------------------------ styling (Gemini designer)

  describeMaterials(): MaterialInfo[] {
    return [...this.materials].map(([name, m]) => {
      const c = (m as MToonMaterial).color ?? new Color(1, 1, 1);
      return {
        name,
        category: categorizeMaterial(name),
        baseColor: `#${c.getHexString()}`,
        hasTexture: !!(m as MToonMaterial).map,
      };
    });
  }

  applyMaterialStyle(style: MaterialStyle): boolean {
    const targets = this.allMaterialsNamed(style.name);
    if (!targets.length) return false;
    for (const m of targets) {
      const mt = m as MToonMaterial;
      if (mt.color) mt.color.set(style.color);
      if (style.shadeColor && mt.isMToonMaterial) mt.shadeColorFactor.set(style.shadeColor);
      if (style.rimColor && mt.isMToonMaterial) mt.parametricRimColorFactor.set(style.rimColor);
      if (style.emissive && mt.emissive) mt.emissive.set(style.emissive);
      m.needsUpdate = true;
    }
    return true;
  }

  getMaterialTexture(name: string): HTMLImageElement | HTMLCanvasElement | ImageBitmap | null {
    const m = this.materials.get(name) as MToonMaterial | undefined;
    const img = m?.map?.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
    return img ?? null;
  }

  replaceMaterialTexture(name: string, image: HTMLCanvasElement): boolean {
    const targets = this.allMaterialsNamed(name);
    if (!targets.length) return false;
    for (const m of targets) {
      const mt = m as MToonMaterial;
      const old = mt.map;
      if (!old) continue;
      const tex = new CanvasTexture(image);
      tex.colorSpace = SRGBColorSpace;
      tex.flipY = old.flipY;
      tex.wrapS = old.wrapS;
      tex.wrapT = old.wrapT;
      tex.magFilter = old.magFilter;
      tex.minFilter = old.minFilter;
      tex.offset.copy(old.offset);
      tex.repeat.copy(old.repeat);
      tex.needsUpdate = true;
      // VRoid exports usually reuse the lit texture as the shade texture; keep them in sync.
      if (mt.isMToonMaterial && mt.shadeMultiplyTexture && mt.shadeMultiplyTexture.image === old.image) {
        mt.shadeMultiplyTexture = tex;
      }
      mt.map = tex;
      m.needsUpdate = true;
    }
    return true;
  }

  resetStyle(): void {
    for (const [name, look] of this.original) {
      for (const m of this.allMaterialsNamed(name)) {
        const mt = m as MToonMaterial;
        mt.color?.copy(look.color);
        if (mt.isMToonMaterial) {
          if (look.shade) mt.shadeColorFactor.copy(look.shade);
          if (look.rim) mt.parametricRimColorFactor.copy(look.rim);
          mt.shadeMultiplyTexture = look.shadeMap;
        }
        if (look.emissive) mt.emissive?.copy(look.emissive);
        if (mt.map !== look.map) mt.map = look.map;
        m.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    VRMUtils.deepDispose(this.vrm.scene);
  }

  private allMaterialsNamed(name: string): Material[] {
    const out: Material[] = [];
    this.vrm.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m.name.replace(/ \(Outline\)$/, '') === name && !out.includes(m)) out.push(m);
      }
    });
    return out;
  }
}

const ZERO = new Vector3();

function snapshotLook(m: Material): OriginalLook {
  const mt = m as MToonMaterial;
  return {
    color: mt.color?.clone() ?? new Color(1, 1, 1),
    shade: mt.isMToonMaterial ? mt.shadeColorFactor.clone() : null,
    rim: mt.isMToonMaterial ? mt.parametricRimColorFactor.clone() : null,
    emissive: mt.emissive?.clone() ?? null,
    map: mt.map ?? null,
    shadeMap: mt.isMToonMaterial ? mt.shadeMultiplyTexture : null,
  };
}

function readMeta(vrm: VRM): AvatarMeta {
  const m = vrm.meta as unknown as Record<string, unknown>;
  if (m.metaVersion === '1') {
    const authors = (m.authors as string[]) ?? [];
    const credit =
      m.creditNotation === 'required'
        ? `${m.name} by ${(m.copyrightInformation as string) || authors.join(', ')}`
        : null;
    return {
      name: String(m.name ?? 'VRM'),
      authors,
      licenseUrl: String(m.licenseUrl ?? ''),
      credit,
      permissions: `avatar:${m.avatarPermission} / commercial:${m.commercialUsage} / modification:${m.modification}`,
    };
  }
  // VRM 0.x
  return {
    name: String(m.title ?? 'VRM'),
    authors: m.author ? [String(m.author)] : [],
    licenseUrl: String(m.otherLicenseUrl ?? m.licenseName ?? ''),
    credit: m.author ? `${m.title} by ${m.author}` : null,
    permissions: `allowedUser:${m.allowedUserName} / commercial:${m.commercialUssageName}`,
  };
}

