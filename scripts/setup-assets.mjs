#!/usr/bin/env node
// Downloads/copies runtime assets so the app works from localhost without CDNs:
//  - MediaPipe Tasks Vision WASM runtime (copied from node_modules)
//  - MediaPipe landmarker models (.task) for face / pose / hands
//  - Sample VRM 1.0 avatars from the VRM Consortium specification repo
//  - A male short-haired VRoid sample (VRM 0.x, CC0) from OpenGameArt
// Re-running is safe: existing files are kept unless --force is passed.
import { copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const MP = 'https://storage.googleapis.com/mediapipe-models';
const VRM = 'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples';
const OGA = 'https://opengameart.org/sites/default/files';

const downloads = [
  { url: `${MP}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`, to: 'public/models/face_landmarker.task' },
  { url: `${MP}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`, to: 'public/models/pose_landmarker_full.task' },
  { url: `${MP}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`, to: 'public/models/pose_landmarker_lite.task' },
  { url: `${MP}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`, to: 'public/models/hand_landmarker.task' },
  { url: `${VRM}/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm`, to: 'public/avatars/VRM1_Constraint_Twist_Sample.vrm' },
  { url: `${VRM}/Seed-san/vrm/Seed-san.vrm`, to: 'public/avatars/Seed-san.vrm' },
  // VRoid Studio alpha sample "桜田 史利矢" (published as CC0; see public/avatars/LICENSES.md).
  { url: `${OGA}/sakurada_fumiriya.zip`, entry: 'Sakurada Fumiriya.vrm', to: 'public/avatars/Sakurada_Fumiriya.vrm' },
  // More bases for transcription (other hair styles, long sleeves); CC0 in their own VRM meta.
  { url: `${OGA}/hairsample_male.zip`, entry: 'HairSample_Male.vrm', to: 'public/avatars/HairSample_Male.vrm' },
  { url: `${OGA}/hairsample_female.zip`, entry: 'HairSample_Female.vrm', to: 'public/avatars/HairSample_Female.vrm' },
  { url: `${OGA}/avatarsample_d_darkness.zip`, entry: 'AvatarSample_D_Darkness.vrm', to: 'public/avatars/AvatarSample_D_Darkness.vrm' },
];

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** One file out of a zip archive (stored or deflated entry; no ZIP64). */
function unzipEntry(zip, name) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = zip.readUInt16LE(eocd + 10); i > 0; i--) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const packed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString('utf8', p + 46, p + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + packed);
      const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
      if (!out || out.length !== size) throw new Error(`cannot extract ${name} (method ${method})`);
      return out;
    }
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  throw new Error(`${name} is not in the archive`);
}

async function download({ url, to, entry }) {
  const dest = join(root, to);
  if (!force && (await exists(dest))) {
    console.log(`skip  ${to}`);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (entry) buf = unzipEntry(buf, entry);
  if (to.endsWith('.vrm') && buf.toString('latin1', 0, 4) !== 'glTF') throw new Error(`${url} did not yield a VRM (glTF binary)`);
  await writeFile(dest, buf);
  console.log(`fetch ${to} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function copyWasm() {
  const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  const dest = join(root, 'public/mediapipe/wasm');
  await mkdir(dest, { recursive: true });
  for (const file of await readdir(src)) {
    // Copy then rename: a page loading while setup runs must never read a half-written .wasm.
    const tmp = join(dest, `.${file}.tmp`);
    await copyFile(join(src, file), tmp);
    await rename(tmp, join(dest, file));
  }
  console.log('copy  public/mediapipe/wasm');
}

await copyWasm();
for (const d of downloads) await download(d);
console.log('assets ready');
