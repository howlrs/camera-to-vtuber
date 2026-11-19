#!/usr/bin/env node
// Downloads/copies runtime assets so the app works from localhost without CDNs:
//  - MediaPipe Tasks Vision WASM runtime (copied from node_modules)
//  - MediaPipe landmarker models (.task) for face / pose / hands
//  - Sample VRM 1.0 avatars from the VRM Consortium specification repo
// Re-running is safe: existing files are kept unless --force is passed.
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const MP = 'https://storage.googleapis.com/mediapipe-models';
const VRM = 'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples';

const downloads = [
  { url: `${MP}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`, to: 'public/models/face_landmarker.task' },
  { url: `${MP}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`, to: 'public/models/pose_landmarker_full.task' },
  { url: `${MP}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`, to: 'public/models/pose_landmarker_lite.task' },
  { url: `${MP}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`, to: 'public/models/hand_landmarker.task' },
  { url: `${VRM}/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm`, to: 'public/avatars/VRM1_Constraint_Twist_Sample.vrm' },
  { url: `${VRM}/Seed-san/vrm/Seed-san.vrm`, to: 'public/avatars/Seed-san.vrm' },
];

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download({ url, to }) {
  const dest = join(root, to);
  if (!force && (await exists(dest))) {
    console.log(`skip  ${to}`);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`fetch ${to} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function copyWasm() {
  const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  const dest = join(root, 'public/mediapipe/wasm');
  await mkdir(dest, { recursive: true });
  for (const file of await readdir(src)) {
    await copyFile(join(src, file), join(dest, file));
  }
  console.log('copy  public/mediapipe/wasm');
}

await copyWasm();
for (const d of downloads) await download(d);
console.log('assets ready');
