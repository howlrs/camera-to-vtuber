import { VOICES, type TtsResponse } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { generate, pickEnum, str } from './common.ts';
import { jsonPost } from '../http.ts';

/** Parse sample rate from e.g. `audio/L16;codec=pcm;rate=24000` (default 24000). */
export function parseSampleRate(mimeType: string | undefined): number {
  const m = /rate=(\d+)/i.exec(mimeType ?? '');
  const n = m ? Number(m[1]) : 24000;
  return n >= 8000 && n <= 96000 ? n : 24000;
}

/** Some TTS models return a WAV container (audio/wav). Extract mono PCM16 + rate from it. */
export function extractPcm(data: Buffer, mimeType: string | undefined): { pcm: Buffer; sampleRate: number } {
  if (data.length > 44 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12;
    let rate = 24000;
    let channels = 1;
    while (off + 8 <= data.length) {
      const id = data.toString('ascii', off, off + 4);
      const size = data.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        channels = data.readUInt16LE(off + 10);
        rate = data.readUInt32LE(off + 12);
      } else if (id === 'data') {
        let pcm = data.subarray(off + 8, Math.min(data.length, off + 8 + size));
        if (channels === 2) {
          const mono = Buffer.alloc(pcm.length / 2);
          for (let i = 0; i + 3 < pcm.length; i += 4) mono.writeInt16LE((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) >> 1, i / 2);
          pcm = mono;
        }
        return { pcm, sampleRate: rate };
      }
      off += 8 + size + (size & 1);
    }
  }
  return { pcm: data, sampleRate: parseSampleRate(mimeType) };
}

export const ttsHandler = jsonPost(async (body) => {
  const text = str(body.text, 2000).trim();
  if (!text) throw new HttpError(400, 'text is required');
  const voice = pickEnum(body.voice, VOICES, 'Kore');
  const style = str(body.style, 300).trim();
  const prompt = style ? `Say the following in this style (${style}): ${text}` : text;
  const { response, model } = await generate('tts', [{ text: prompt }], {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
  });
  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new HttpError(502, 'TTS model returned no audio');
  const { pcm, sampleRate } = extractPcm(Buffer.from(part.inlineData.data, 'base64'), part.inlineData.mimeType);
  return { audio: pcm.toString('base64'), sampleRate, model } satisfies TtsResponse;
});
