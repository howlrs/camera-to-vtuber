import {
  Box3,
  CanvasTexture,
  Color,
  Material,
  Mesh,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MToonMaterial, VRMLoaderPlugin, VRMUtils, type VRM, type VRMSpringBoneManager } from '@pixiv/three-vrm';
import type { MaterialInfo, MaterialStyle } from '../../shared/protocol.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';
import { idleBones, restPose } from '../solver/idlePose.ts';
import { type AvatarMeta, type AvatarRig, categorizeMaterial } from './AvatarRig.ts';
import { HairPhysics } from './HairPhysics.ts';

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
 *
 * MotionFrame uses the VRM 1.0 convention (avatar faces +Z, +X = avatar's left). A VRM 0.x
 * model faces -Z in its own space and is turned 180° by rotateVRM0, so its normalized bones'
 * axes are turned too: rotations and offsets are converted with toVrm0Rotation/-Offset, and
 * objects attached via getBoneNode() go into a holder turned back to the 1.0 convention.
 */
export class VrmAvatar implements AvatarRig {
  readonly object: Object3D;
  readonly meta: AvatarMeta;
  readonly headHeight: number;
  readonly headSize: number;
  readonly hasUpperChest: boolean;
  readonly hair: HairPhysics | null;
  private materials = new Map<string, Material>();
  private original = new Map<string, OriginalLook>();
  private readonly hipsRest = new Vector3();
  private readonly isVrm0: boolean;
  private readonly anchors = new Map<HumanBoneName, Object3D>();
  readonly vrm: VRM;

  private constructor(vrm: VRM) {
    this.vrm = vrm;
    this.object = vrm.scene;
    this.meta = readMeta(vrm);
    this.isVrm0 = (vrm.meta as { metaVersion?: string }).metaVersion === '0';
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
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) this.setRotation(node, restPose(bone));
    }
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);

    // HairPhysics steps the springs at a fixed rate, so vrm.update() must not step them too.
    const springs = vrm.springBoneManager;
    (vrm as { springBoneManager?: VRMSpringBoneManager }).springBoneManager = undefined;
    // VRM 0.x files without secondary animation still yield an empty manager.
    this.hair = springs?.joints.size ? new HairPhysics(springs, vrm.humanoid.getRawBoneNode('head')) : null;
    // Springs were initialised in the bind (T) pose; restart them from the rest pose so sleeves
    // and hair don't swing in from the T-pose on the first frames.
    this.hair?.reset();

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
    const node = this.vrm.humanoid.getNormalizedBoneNode(name);
    if (!node || !this.isVrm0) return node;
    let anchor = this.anchors.get(name);
    if (!anchor) {
      anchor = new Object3D();
      anchor.name = `${name}_anchor`;
      anchor.rotation.y = Math.PI; // back to the VRM 1.0 axes
      node.add(anchor);
      this.anchors.set(name, anchor);
    }
    return anchor;
  }

  apply(motion: MotionFrame): void {
    const humanoid = this.vrm.humanoid;
    for (const [bone, q] of motion.bones) {
      const node = humanoid.getNormalizedBoneNode(bone);
      if (node) this.setRotation(node, q);
    }
    const hips = humanoid.getNormalizedBoneNode('hips');
    if (hips) {
      const offset = motion.hipsOffset ?? ZERO;
      hips.position.copy(this.hipsRest).add(this.isVrm0 ? toVrm0Offset(offset, _offset) : offset);
    }

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
    this.hair?.update(dt);
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

  private setRotation(node: Object3D, q: Quaternion): void {
    if (this.isVrm0) toVrm0Rotation(q, node.quaternion);
    else node.quaternion.copy(q);
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
const _offset = new Vector3();

/** A rotation in the VRM 1.0 convention expressed in VRM 0.x axes (turned 180° about Y). */
export function toVrm0Rotation(q: Quaternion, out = new Quaternion()): Quaternion {
  return out.set(-q.x, q.y, -q.z, q.w);
}

/** An offset in the VRM 1.0 convention expressed in VRM 0.x axes (turned 180° about Y). */
export function toVrm0Offset(v: Vector3, out = new Vector3()): Vector3 {
  return out.set(-v.x, v.y, -v.z);
}

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
  // VRM 0.x has no credit flag; VRoid Hub license URLs carry it as `credit=unnecessary`.
  const licenseUrl = String(m.otherLicenseUrl ?? m.licenseName ?? '');
  return {
    name: String(m.title ?? 'VRM'),
    authors: m.author ? [String(m.author)] : [],
    licenseUrl,
    credit: m.author && !/[?&]credit=unnecessary\b/.test(licenseUrl) ? `${m.title} by ${m.author}` : null,
    permissions: `allowedUser:${m.allowedUserName} / commercial:${m.commercialUssageName}`,
  };
}

