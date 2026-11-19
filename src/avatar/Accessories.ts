import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshToonMaterial,
  type Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { AccessorySpec, AccessoryType } from '../../shared/protocol.ts';
import type { AvatarRig } from './AvatarRig.ts';

/**
 * Procedural head accessories attached to the avatar's head bone. Sizes scale with the model so
 * they fit any VRM. New accessory types: add a builder to BUILDERS.
 */

type Builder = (color: Color, s: number) => Object3D;

function toon(color: Color, emissive = 0): MeshToonMaterial {
  const m = new MeshToonMaterial({ color });
  if (emissive) m.emissive = color.clone().multiplyScalar(emissive);
  return m;
}

function pairOf(make: (side: 1 | -1) => Object3D): Group {
  const g = new Group();
  g.add(make(1), make(-1));
  return g;
}

const BUILDERS: Record<AccessoryType, Builder> = {
  catEars: (c, s) =>
    pairOf((side) => {
      const ear = new Mesh(new ConeGeometry(0.035 * s, 0.07 * s, 4), toon(c));
      ear.position.set(side * 0.055 * s, 0.03 * s, -0.01 * s);
      ear.rotation.set(0, Math.PI / 4, side * -0.35);
      return ear;
    }),
  foxEars: (c, s) =>
    pairOf((side) => {
      const ear = new Mesh(new ConeGeometry(0.03 * s, 0.11 * s, 8), toon(c));
      ear.position.set(side * 0.06 * s, 0.05 * s, -0.015 * s);
      ear.rotation.set(-0.1, 0, side * -0.3);
      return ear;
    }),
  horns: (c, s) =>
    pairOf((side) => {
      const horn = new Mesh(new ConeGeometry(0.014 * s, 0.07 * s, 12), toon(c));
      horn.position.set(side * 0.045 * s, 0.025 * s, 0.03 * s);
      horn.rotation.set(-0.5, 0, side * -0.5);
      return horn;
    }),
  halo: (c, s) => {
    const halo = new Mesh(new TorusGeometry(0.075 * s, 0.007 * s, 8, 48), toon(c, 0.9));
    halo.position.set(0, 0.07 * s, -0.01 * s);
    halo.rotation.x = Math.PI / 2 - 0.25;
    return halo;
  },
  ribbon: (c, s) => {
    const g = new Group();
    for (const side of [1, -1]) {
      const wing = new Mesh(new ConeGeometry(0.03 * s, 0.06 * s, 4), toon(c));
      wing.rotation.z = (side * Math.PI) / 2;
      wing.position.set(side * 0.03 * s, 0, 0);
      g.add(wing);
    }
    g.add(new Mesh(new SphereGeometry(0.012 * s, 12, 8), toon(c)));
    g.position.set(0.06 * s, 0.02 * s, -0.02 * s);
    g.rotation.z = -0.4;
    return g;
  },
  crown: (c, s) => {
    const g = new Group();
    const band = new Mesh(new CylinderGeometry(0.045 * s, 0.05 * s, 0.025 * s, 24, 1, true), toon(c, 0.3));
    g.add(band);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new Mesh(new ConeGeometry(0.008 * s, 0.03 * s, 6), toon(c, 0.3));
      spike.position.set(Math.sin(a) * 0.047 * s, 0.027 * s, Math.cos(a) * 0.047 * s);
      g.add(spike);
    }
    g.position.set(0, 0.03 * s, 0);
    g.rotation.x = -0.15;
    return g;
  },
  glasses: (c, s) => {
    const g = new Group();
    for (const side of [1, -1]) {
      const lens = new Mesh(new TorusGeometry(0.018 * s, 0.0025 * s, 8, 24), toon(c));
      lens.position.set(side * 0.028 * s, 0, 0);
      g.add(lens);
    }
    const bridge = new Mesh(new BoxGeometry(0.02 * s, 0.003 * s, 0.003 * s), toon(c));
    g.add(bridge);
    g.position.set(0, -0.075 * s, 0.085 * s);
    return g;
  },
  headphones: (c, s) => {
    const g = new Group();
    // Sized to sit outside typical VRoid hair volume (≈0.1 m half-width at s = 1).
    const band = new Mesh(new TorusGeometry(0.105 * s, 0.009 * s, 8, 32, Math.PI), toon(c));
    g.add(band);
    for (const side of [1, -1]) {
      const cup = new Mesh(new CylinderGeometry(0.038 * s, 0.038 * s, 0.03 * s, 20), toon(c));
      cup.rotation.z = Math.PI / 2;
      cup.position.set(side * 0.105 * s, 0, 0);
      g.add(cup);
    }
    g.position.set(0, -0.08 * s, -0.005 * s);
    return g;
  },
};

export class AccessoryManager {
  private group = new Group();
  private attachedTo: Object3D | null = null;

  constructor() {
    this.group.name = 'accessories';
  }

  apply(avatar: AvatarRig, specs: AccessorySpec[]): void {
    this.clear();
    const head = avatar.getBoneNode('head');
    if (!head) return;
    // Scale relative to a typical VRoid head (head bone -> top of hair ≈ 0.2 m). Builders place
    // parts relative to an anchor at 75% of that height, i.e. around the crown of the skull.
    const s = avatar.headSize / 0.2;
    this.group.position.copy(new Vector3(0, avatar.headSize * 0.75, 0));
    for (const spec of specs) {
      const build = BUILDERS[spec.type];
      if (build) this.group.add(build(new Color(spec.color), s));
    }
    head.add(this.group);
    this.attachedTo = head;
  }

  /** Hide or show the accessories (e.g. for a thumbnail of what an export contains). */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  clear(): void {
    this.attachedTo?.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as MeshToonMaterial).dispose();
      }
    });
    this.group.clear();
    this.attachedTo = null;
  }
}
