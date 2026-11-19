import {
  Box3,
  type BufferAttribute,
  CanvasTexture,
  Color,
  Material,
  Mesh,
  Object3D,
  Quaternion,
  type SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MToonMaterial, VRMLoaderPlugin, VRMUtils, type VRM, type VRMSpringBoneManager } from '@pixiv/three-vrm';
import type { MaterialInfo, MaterialStyle } from '../../shared/protocol.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';
import { idleBones, restPose } from '../solver/idlePose.ts';
import { type AvatarMeta, type AvatarRig, type ExportOptions, categorizeMaterial, facePart } from './AvatarRig.ts';
import { HairPhysics } from './HairPhysics.ts';
import { canvasToBytes, neutralShade, sourceSize, toCanvas, type TextureSource } from './TextureOps.ts';
import { type MaterialPatch, patchVrm, type Rgb } from './VrmExport.ts';

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
  private readonly hidden = new Set<string>();
  private readonly hipsRest = new Vector3();
  private readonly isVrm0: boolean;
  private readonly anchors = new Map<HumanBoneName, Object3D>();
  readonly vrm: VRM;
  /** The file as loaded, patched by exportVrm(). */
  private readonly source: ArrayBuffer;
  /** glTF material index -> its (first, non-outline) three.js material. */
  private readonly gltfMaterials: Map<number, Material>;

  private constructor(vrm: VRM, source: ArrayBuffer, gltfMaterials: Map<number, Material>) {
    this.vrm = vrm;
    this.source = source;
    this.gltfMaterials = gltfMaterials;
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
    const source = await fetchBytes(url, onProgress);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(source, '');
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error('VRMとして読み込めませんでした（VRMC_vrm / VRM 拡張がありません）');
    const gltfMaterials = new Map<number, Material>();
    gltf.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const index = gltf.parser.associations.get(m)?.materials;
        if (index != null && !gltfMaterials.has(index) && !/ \(Outline\)$/.test(m.name)) gltfMaterials.set(index, m);
      }
    });
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; normalize to +Z like VRM 1.0
    return new VrmAvatar(vrm, source, gltfMaterials);
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
      const category = categorizeMaterial(name);
      const info: MaterialInfo = { name, category, baseColor: `#${c.getHexString()}`, hasTexture: !!(m as MToonMaterial).map };
      const part = facePart(name, category);
      if (part) info.part = part;
      if (part === 'brow' || part === 'lash' || part === 'line') info.drawnShape = this.drawnShape(name);
      if (part === 'iris') {
        const side = this.leftEyeSide(name);
        if (side) info.leftEye = side;
      }
      return info;
    });
  }

  /**
   * True when the material cuts its shape out of the texture: it blends or alpha-tests, and a good
   * share of the texels its meshes sample is transparent (a brow stroke on a quad). A flat strip
   * whose outline comes from the mesh is fully opaque.
   */
  private drawnShape(name: string): boolean {
    const mt = this.materials.get(name) as MToonMaterial | undefined;
    const src = this.getMaterialTexture(name);
    if (!mt || !src || !(mt.transparent || mt.alphaTest > 0)) return false;
    const small = toCanvas(src, 256);
    const mask = this.uvMask(name, small.width, small.height, { pad: 0 });
    const px = small.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, small.width, small.height).data;
    const m = mask?.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, small.width, small.height).data;
    let used = 0;
    let clear = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (m && m[i + 3]! < 128) continue;
      used++;
      if (px[i + 3]! < 128) clear++;
    }
    return used > 0 && clear / used >= 0.15;
  }

  leftEyeSide(name: string): 'left' | 'right' | 'shared' | undefined {
    const names = new Set(this.sharingAtlas(name));
    const head = new Vector3();
    this.vrm.humanoid.getRawBoneNode('head')?.getWorldPosition(head);
    const v = new Vector3();
    const sum = { left: 0, right: 0 };
    const count = { left: 0, right: 0 };
    const lo = { left: Infinity, right: Infinity };
    const hi = { left: -Infinity, right: -Infinity };
    this.vrm.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const uv = mesh.geometry.getAttribute('uv');
      const pos = mesh.geometry.getAttribute('position');
      if (!uv || !pos) return;
      const index = mesh.geometry.getIndex();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: index ? index.count : uv.count, materialIndex: 0 }];
      for (const group of groups) {
        const m = mats[group.materialIndex ?? 0];
        if (!m || m.name.endsWith(' (Outline)') || !names.has(m.name)) continue;
        const end = Math.min(group.start + group.count, index ? index.count : uv.count);
        for (let i = group.start; i < end; i++) {
          const k = index ? index.getX(i) : i;
          mesh.localToWorld(v.fromBufferAttribute(pos, k));
          // Avatars face +Z (VRM 0.x is turned to match), so the avatar's own left is +X.
          const side = v.x > head.x ? 'left' : 'right';
          const u = uv.getX(k);
          sum[side] += u;
          count[side]++;
          lo[side] = Math.min(lo[side], u);
          hi[side] = Math.max(hi[side], u);
        }
      }
    });
    if (!count.left || !count.right) return undefined;
    // Mirrored eyes often share one island (e.g. VRM1 Twist Sample): then the u ranges overlap.
    const overlap = Math.min(hi.left, hi.right) - Math.max(lo.left, lo.right);
    if (overlap > 0.5 * Math.min(hi.left - lo.left, hi.right - lo.right)) return 'shared';
    return sum.left / count.left < sum.right / count.right ? 'left' : 'right';
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

  getMaterialTexture(name: string): TextureSource | null {
    const m = this.materials.get(name) as MToonMaterial | undefined;
    const img = m?.map?.image as TextureSource | undefined;
    return img ?? null;
  }

  /** Materials whose base color texture is the same atlas as `name`'s (e.g. Seed-san's "wear"). */
  private sharingAtlas(name: string): string[] {
    const shared = this.getMaterialTexture(name);
    const names = shared ? [...this.materials].filter(([, m]) => (m as MToonMaterial).map?.image === shared).map(([n]) => n) : [];
    if (!names.includes(name)) names.push(name);
    return names;
  }

  /**
   * `side` keeps only triangles on the avatar's own left or right (e.g. one iris of two), judged
   * from their bind-pose position relative to the head.
   */
  uvMask(name: string, width: number, height: number, opts: { pad?: number; side?: 'left' | 'right' } = {}): HTMLCanvasElement | null {
    if (!opts.side) return this.rasterize(name, width, height, opts.pad ?? 3);
    const head = new Vector3();
    this.vrm.humanoid.getRawBoneNode('head')?.getWorldPosition(head);
    const pos3 = new Vector3();
    return this.rasterize(name, width, height, opts.pad ?? 3, (mesh, index, i) => {
      const position = mesh.geometry.getAttribute('position');
      if (!position) return true;
      let x = 0;
      for (let k = 0; k < 3; k++) x += mesh.localToWorld(pos3.fromBufferAttribute(position, index ? index.getX(i + k) : i + k)).x;
      // Avatars face +Z (VRM 0.x is turned to match), so the avatar's own left is +X.
      return (x / 3 > head.x ? 'left' : 'right') === opts.side;
    });
  }

  limbMask(kind: 'arms' | 'legs'): { material: string; mask: HTMLCanvasElement } | null {
    const bones: HumanBoneName[] =
      kind === 'arms'
        ? ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm']
        : ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
    // The limb bones and their helpers (VRoid's J_Sec_* twist bones), down to the next humanoid
    // bone of another part (hand, foot), whose subtree is not the sleeve or trouser leg.
    const humanoid = new Set(Object.values(this.vrm.humanoid.rawHumanBones).map((b) => b?.node).filter((n): n is Object3D => !!n));
    const limb = bones.map((b) => this.vrm.humanoid.getRawBoneNode(b)).filter((n): n is Object3D => !!n);
    const nodes = new Set<Object3D>();
    const collect = (n: Object3D) => {
      nodes.add(n);
      for (const c of n.children) if (!humanoid.has(c) || limb.includes(c)) collect(c);
    };
    limb.forEach(collect);
    if (!nodes.size) return null;
    // Body skin: SKIN materials other than the face.
    const skins = [...this.materials.keys()].filter((n) => categorizeMaterial(n) === 'SKIN' && facePart(n, 'SKIN') !== 'face');
    let best: { material: string; mask: HTMLCanvasElement; count: number } | null = null;
    for (const material of skins) {
      const src = this.getMaterialTexture(material);
      if (!src) continue;
      const { width, height } = sourceSize(src);
      let count = 0;
      const mask = this.rasterize(material, width, height, 2, (mesh, index, i) => {
        const skinned = mesh as SkinnedMesh;
        const si = mesh.geometry.getAttribute('skinIndex');
        const sw = mesh.geometry.getAttribute('skinWeight');
        if (!skinned.isSkinnedMesh || !si || !sw) return false;
        let weight = 0;
        for (let k = 0; k < 3; k++) {
          const v = index ? index.getX(i + k) : i + k;
          for (let c = 0; c < si.itemSize; c++) {
            if (nodes.has(skinned.skeleton.bones[si.getComponent(v, c)]!)) weight += sw.getComponent(v, c);
          }
        }
        // Mostly driven by the limb bones: the sleeve ends where the hand (or foot) takes over.
        const keep = weight / 3 >= 0.5;
        if (keep) count++;
        return keep;
      });
      if (mask && count && (!best || count > best.count)) best = { material, mask, count };
    }
    return best && { material: best.material, mask: best.mask };
  }

  /**
   * Paint the UV triangles of a material's atlas (and of materials sharing it) white, optionally
   * only the triangles `keep` accepts. Null when nothing was drawn or the UVs wrap/transform.
   */
  private rasterize(
    name: string,
    width: number,
    height: number,
    pad: number,
    keep?: (mesh: Mesh, index: BufferAttribute | null, i: number) => boolean,
  ): HTMLCanvasElement | null {
    const names = new Set(this.sharingAtlas(name));
    const map = (this.materials.get(name) as MToonMaterial | undefined)?.map;
    // Texture transforms would move the islands; without a plain mapping the mask is unknown.
    if (!map || map.offset.x || map.offset.y || map.repeat.x !== 1 || map.repeat.y !== 1) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d')!;
    g.fillStyle = g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1, pad * 2); // grow islands a little so filtering at their borders reads repainted texels
    g.lineJoin = 'round';
    let triangles = 0;
    let outside = false;
    this.vrm.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || outside) return;
      const uv = mesh.geometry.getAttribute('uv');
      if (!uv) return;
      const index = mesh.geometry.getIndex();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: index ? index.count : uv.count, materialIndex: 0 }];
      for (const group of groups) {
        const m = mats[group.materialIndex ?? 0];
        if (!m || m.name.endsWith(' (Outline)') || !names.has(m.name)) continue;
        g.beginPath();
        const end = Math.min(group.start + group.count, index ? index.count : uv.count);
        const p = [0, 0, 0, 0, 0, 0];
        for (let i = group.start; i + 2 < end; i += 3) {
          if (keep && !keep(mesh, index, i)) continue;
          for (let k = 0; k < 3; k++) {
            const v = index ? index.getX(i + k) : i + k;
            const u = uv.getX(v);
            const w = uv.getY(v);
            if (u < -0.01 || u > 1.01 || w < -0.01 || w > 1.01) outside = true;
            p[k * 2] = u * width;
            p[k * 2 + 1] = (map.flipY ? 1 - w : w) * height;
          }
          // One winding for all triangles: mirrored islands overlap, and opposite windings would
          // cancel out under the nonzero fill rule.
          const ccw = (p[2]! - p[0]!) * (p[5]! - p[1]!) - (p[3]! - p[1]!) * (p[4]! - p[0]!) >= 0;
          g.moveTo(p[0]!, p[1]!);
          g.lineTo(ccw ? p[2]! : p[4]!, ccw ? p[3]! : p[5]!);
          g.lineTo(ccw ? p[4]! : p[2]!, ccw ? p[5]! : p[3]!);
          g.closePath();
          triangles++;
        }
        g.fill();
        if (pad > 0) g.stroke();
      }
    });
    // UVs that wrap around the atlas cannot be masked by a single pass; fall back to no mask.
    return triangles && !outside ? canvas : null;
  }


  replaceMaterialTexture(name: string, image: HTMLCanvasElement): string[] {
    // The atlas is replaced for every material that samples it (e.g. Seed-san's shared "wear").
    const names = this.sharingAtlas(name);
    const targets = names.flatMap((n) => this.allMaterialsNamed(n));
    const changed = new Set<string>();
    for (const m of targets) {
      const mt = m as MToonMaterial;
      const old = mt.map;
      if (!old) continue;
      changed.add(m.name.replace(/ \(Outline\)$/, ''));
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
    return [...changed];
  }

  useTextureColors(name: string, tint?: string): void {
    const look = this.original.get(name);
    if (!look) return;
    const c = look.color;
    const s = look.shade;
    const gray = s ? neutralShade([c.r, c.g, c.b], [s.r, s.g, s.b]) : 1;
    // Glow tuned for the old color (e.g. an orange sheen on pink hair) keeps its strength but
    // takes the new color's hue, or turns neutral when the new color is not known.
    const glow = look.emissive ? retintGlow(look.emissive, tint) : null;
    for (const m of this.allMaterialsNamed(name)) {
      const mt = m as MToonMaterial;
      mt.color?.setRGB(1, 1, 1);
      if (mt.isMToonMaterial && s) mt.shadeColorFactor.setRGB(gray, gray, gray);
      if (glow && mt.emissive) mt.emissive.copy(glow);
      m.needsUpdate = true;
    }
  }

  async exportVrm(options: ExportOptions = {}): Promise<Blob> {
    const pngs = new Map<unknown, { key: string; png: Uint8Array }>();
    const patches: MaterialPatch[] = [];
    for (const [index, m] of this.gltfMaterials) {
      const name = m.name.replace(/ \(Outline\)$/, '');
      const look = this.original.get(name);
      if (!look) continue;
      const mt = m as MToonMaterial;
      const p: MaterialPatch = { index };
      const rgb = (c: Color): Rgb => [c.r, c.g, c.b];
      if (mt.color && !mt.color.equals(look.color)) p.color = rgb(mt.color);
      if (mt.isMToonMaterial && look.shade && !mt.shadeColorFactor.equals(look.shade)) p.shade = rgb(mt.shadeColorFactor);
      if (mt.isMToonMaterial && look.rim && !mt.parametricRimColorFactor.equals(look.rim)) p.rim = rgb(mt.parametricRimColorFactor);
      if (look.emissive && mt.emissive && !mt.emissive.equals(look.emissive)) p.emissive = rgb(mt.emissive);
      if (mt.map && mt.map !== look.map && mt.map.image) {
        const img = mt.map.image as TextureSource;
        if (!pngs.has(img)) {
          const canvas = img instanceof HTMLCanvasElement ? img : toCanvas(img);
          pngs.set(img, { key: `t${pngs.size}`, png: await canvasToBytes(canvas) });
        }
        p.image = pngs.get(img);
      }
      if (this.hidden.has(name)) p.hidden = true;
      if (p.color || p.shade || p.rim || p.emissive || p.image || p.hidden) patches.push(p);
    }
    const out = patchVrm(this.source, { materials: patches, name: options.name, thumbnail: options.thumbnail });
    return new Blob([out], { type: 'model/gltf-binary' });
  }

  setHidden(name: string, hidden: boolean): boolean {
    const targets = this.allMaterialsNamed(name);
    for (const m of targets) m.visible = !hidden;
    if (hidden && targets.length) this.hidden.add(name);
    else this.hidden.delete(name);
    return targets.length > 0;
  }

  resetStyle(): void {
    for (const name of [...this.hidden]) this.setHidden(name, false);
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

const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** `glow` (linear) at the same luminance with the hue of `tint` (#rrggbb), or gray without one. */
export function retintGlow(glow: Color, tint?: string): Color | null {
  const target = lum(glow);
  if (target < 1e-4) return null;
  const t = tint ? new Color(tint) : null;
  const tl = t ? lum(t) : 0;
  if (!t || tl < 1e-4) return new Color(target, target, target);
  const k = target / tl;
  return new Color(Math.min(1, t.r * k), Math.min(1, t.g * k), Math.min(1, t.b * k));
}

/** Read a URL into memory (the original bytes are kept for export), reporting progress. */
async function fetchBytes(url: string, onProgress?: (ratio: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // content-length is the encoded size, so it only drives the progress bar.
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(Math.min(1, loaded / total));
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
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

