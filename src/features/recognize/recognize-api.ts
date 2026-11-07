import { Buffer } from 'buffer';

import type { PlayerTrack } from '@/features/player/types';
import { pickNumber, pickStringLike, pickText, toRecord, toRecords } from '@/lib/api-parse';
import { normalizeDurationMs, sizedImage } from '@/lib/format';
import { bootstrapMobileApi, mobileApi } from '@/lib/kugou-api';
import { chunkToMono, resampleLinear, type PcmChunk } from '@/lib/pcm';

export type { PcmChunk } from '@/lib/pcm';

/** 酷狗指纹服务要求的采样格式：8kHz / 单声道 / 16 位小端 PCM。 */
export const RECOGNIZE_SAMPLE_RATE = 8000;
export const RECOGNIZE_MAX_SECONDS = 10;

export type RecognizeMatch = {
  /** 0-1，由接口的 dist(距离)换算，越大越可信。 */
  confidence: number;
  track: PlayerTrack;
};

/** 把采集到的 PCM 块合并、下混为单声道并重采样到 8kHz，输出识别接口需要的字节流。 */
export function buildRecognizePcm(chunks: PcmChunk[]): Uint8Array {
  const usable = chunks.filter((chunk) => chunk.data.byteLength >= 2);
  if (!usable.length) {
    return new Uint8Array(0);
  }

  const monoChunks = usable.map(chunkToMono);
  const totalFrames = monoChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(totalFrames);
  let offset = 0;
  for (const chunk of monoChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const sourceRate = usable[0].sampleRate > 0 ? usable[0].sampleRate : RECOGNIZE_SAMPLE_RATE;
  const resampled = resampleLinear(merged, sourceRate, RECOGNIZE_SAMPLE_RATE);
  return new Uint8Array(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

function mapMatch(item: Record<string, unknown>): RecognizeMatch | null {
  const album = toRecords(item.album)[0] ?? {};
  const hash = pickText(item.hash, item.hash_128, item.FileHash, item.hash_320, item.hash_flac);
  if (!hash) {
    return null;
  }

  const dist = Number(item.dist);
  const quality = pickText(item.hash_flac, item.hash_high)
    ? ('sq' as const)
    : pickText(item.hash_320)
      ? ('hq' as const)
      : undefined;

  return {
    confidence: Number.isFinite(dist) ? Math.max(0, Math.min(1, 1 - dist)) : 0,
    track: {
      hash,
      title: pickText(item.songname, item.filename, item.name) || '未知歌曲',
      artist: pickText(item.singername, item.author_name, item.singer) || '未知歌手',
      album: pickText(album.albumname, item.album_name, item.albumname) || undefined,
      coverUrl: sizedImage(
        pickText(item.union_cover, album.sizable_cover, item.album_sizable_cover, item.cover),
        480
      ),
      durationMs:
        normalizeDurationMs(
          pickNumber(item.timelength, item.timelength_128, item.timelength_320, item.duration)
        ) || undefined,
      albumAudioId: pickStringLike(item.album_audio_id) || undefined,
      quality,
    },
  };
}

function isApiResultLike(value: unknown): value is { status: number; body: unknown } {
  return Boolean(value) && typeof value === 'object' && 'status' in (value as object) && 'body' in (value as object);
}

/** 上传 PCM 指纹并返回按可信度排序的匹配结果；接口无匹配时返回空数组。 */
export async function recognizeAudio(pcm: Uint8Array): Promise<RecognizeMatch[]> {
  await bootstrapMobileApi();

  let body: unknown;
  try {
    const response = await mobileApi.audio_match({
      data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    });
    body = response.body;
  } catch (error) {
    // 无匹配时服务端返回 status=0，请求层会把它当失败抛出，这里视作"没有识别到"
    if (isApiResultLike(error)) {
      return [];
    }
    throw error;
  }

  const record = toRecord(body);
  if (pickNumber(record.status) !== 1) {
    return [];
  }

  return toRecords(record.data)
    .map(mapMatch)
    .filter((match): match is RecognizeMatch => Boolean(match))
    .sort((a, b) => b.confidence - a.confidence);
}
