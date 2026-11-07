/** 麦克风 PCM 块：expo-audio useAudioStream 回调给出的原始数据。 */
export type PcmChunk = {
  data: ArrayBuffer;
  /** 麦克风实际输出的采样率，可能与请求值不一致。 */
  sampleRate: number;
  channels: number;
};

/** 多声道 int16 PCM 下混为单声道。 */
export function chunkToMono(chunk: PcmChunk): Int16Array {
  const sampleCount = Math.floor(chunk.data.byteLength / 2);
  const interleaved = new Int16Array(chunk.data, 0, sampleCount);
  const channels = Math.max(1, chunk.channels);
  if (channels === 1) {
    return interleaved;
  }

  const frames = Math.floor(sampleCount / channels);
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += interleaved[frame * channels + channel];
    }
    mono[frame] = Math.round(sum / channels);
  }
  return mono;
}

/** 线性插值重采样，语音/识别场景足够。 */
export function resampleLinear(
  samples: Int16Array,
  sourceRate: number,
  targetRate: number
): Int16Array {
  if (sourceRate === targetRate || !samples.length) {
    return samples;
  }

  const targetLength = Math.max(1, Math.floor((samples.length * targetRate) / sourceRate));
  const output = new Int16Array(targetLength);
  const step = (samples.length - 1) / Math.max(1, targetLength - 1);
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * step;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const ratio = position - left;
    output[index] = Math.round(samples[left] * (1 - ratio) + samples[right] * ratio);
  }
  return output;
}
