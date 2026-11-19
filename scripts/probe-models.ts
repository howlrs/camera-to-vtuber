// Usage: npm run probe [-- --images]
import { deflateSync } from 'node:zlib';
import { apiKeyConfigured, getAI } from '../server/gemini/client.ts';
import { initRegistry, getAssignments } from '../server/gemini/registry.ts';
import { generate } from '../server/gemini/common.ts';
import { MINIMAL_THINKING } from '../server/gemini/reactor.ts';
import { connectLive } from '../server/gemini/live.ts';
import { parseSampleRate } from '../server/gemini/tts.ts';
import type { LiveServerMessage } from '../shared/protocol.ts';

const withImages = process.argv.includes('--images');
const results: { role: string; model: string; ok: boolean; ms: number; note: string }[] = [];

async function check(role: string, model: string | null, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ role, model: model ?? '-', ok: true, ms: Math.round(performance.now() - t0), note });
  } catch (e) {
    results.push({ role, model: model ?? '-', ok: false, ms: Math.round(performance.now() - t0), note: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
  }
}

// 64x64 solid PNG is enough for vision calls.
function makePng(): string {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const b = Buffer.concat([Buffer.from(t), d]); const o = Buffer.alloc(4); o.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(b)); return Buffer.concat([o, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, 180)]);
  const raw = Buffer.concat(Array.from({ length: 64 }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const PNG = makePng();

if (!apiKeyConfigured()) {
  console.log('GEMINI_API_KEY missing');
  process.exit(1);
}
await initRegistry();
console.log('Role resolution:');
for (const a of getAssignments()) console.log(`  ${a.role.padEnd(11)} -> ${a.model ?? 'NONE'} (${a.source})`);

const m = (role: string) => getAssignments().find((a) => a.role === role)?.model ?? null;

for (const role of ['designer', 'transcriber', 'general'] as const) {
  await check(role, m(role), async () => {
    const { response } = await generate(role, [{ text: 'Reply with the single word: ok' }], { maxOutputTokens: 200 });
    return `"${response.text?.trim().slice(0, 30)}"`;
  });
}
for (const role of ['reactor', 'spatial'] as const) {
  await check(role, m(role), async () => {
    const { response } = await generate(role, [{ text: 'Reply with JSON {"ok":true}' }, { inlineData: { data: PNG, mimeType: 'image/png' } }], { responseMimeType: 'application/json', maxOutputTokens: 200 }, MINIMAL_THINKING);
    return `${response.text?.trim().slice(0, 40)} thoughts=${response.usageMetadata?.thoughtsTokenCount ?? 0}`;
  });
}
await check('tts', m('tts'), async () => {
  const { response } = await generate('tts', [{ text: 'こんにちは' }], {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
  });
  const p = response.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data);
  if (!p?.inlineData?.data) throw new Error('no audio');
  return `${p.inlineData.mimeType} rate=${parseSampleRate(p.inlineData.mimeType)} bytes=${Buffer.from(p.inlineData.data, 'base64').length}`;
});
for (const role of ['imageFast', 'image'] as const) {
  if (!withImages && role === 'image') {
    results.push({ role, model: m(role) ?? '-', ok: true, ms: 0, note: 'skipped (use --images)' });
    continue;
  }
  await check(role, m(role), async () => {
    const { response } = await generate(role, [{ text: 'A flat pastel gradient wallpaper, no text.' }], { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '16:9' } });
    const p = response.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data);
    if (!p?.inlineData?.data) throw new Error('no image');
    return `${p.inlineData.mimeType} ${Math.round(p.inlineData.data.length / 1024)}KB b64`;
  });
}
await check('live', m('live'), async () => {
  const events: string[] = [];
  let audioBytes = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const emit = (msg: LiveServerMessage) => {
    if (msg.type === 'audio') {
      audioBytes += msg.data.length;
      if (!events.includes('audio')) events.push('audio');
    } else if (msg.type === 'tool') events.push(`tool:${msg.call.name}`);
    else if (msg.type === 'transcript') events.push(`tr:${msg.role}`);
    else if (msg.type === 'error') events.push(`error:${msg.message}`);
    else if (msg.type === 'turnComplete') {
      events.push('turnComplete');
      resolveDone();
    }
  };
  const b = await connectLive({ speak: true, voice: 'Kore', language: 'ja-JP' }, emit, (r) => {
    events.push(`closed:${r}`);
    resolveDone();
  });
  b.session.sendRealtimeInput({ text: '自己紹介を一言でお願いします。' });
  await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
  b.session.close();
  if (!events.includes('audio') && !events.includes('turnComplete')) throw new Error(`no audio/turnComplete: ${events.join(',')}`);
  return `${[...new Set(events)].join(',')} audioB64=${audioBytes}`;
});

console.log('\nResults:');
for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.role.padEnd(10)} ${r.model.padEnd(34)} ${String(r.ms).padStart(6)}ms  ${r.note}`);
void getAI;
process.exit(results.some((r) => !r.ok) ? 1 : 0);
