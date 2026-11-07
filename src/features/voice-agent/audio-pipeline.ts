import { Buffer } from 'buffer';

import {
  AudioContext,
  AudioBufferQueueSourceNode,
  AudioRecorder,
  AudioManager,
  decodePCMInBase64,
} from 'react-native-audio-api';

import { resampleLinear } from '@/lib/pcm';

/** Gateway 语音输入要求：16kHz / 单声道 / 16 位小端 PCM，base64 上行。 */
export const VOICE_INPUT_SAMPLE_RATE = 16000;

/** 每条 input_audio_buffer.append 发送 100ms 音频（1600 采样 = 3200 字节）。 */
const APPEND_CHUNK_SAMPLES = VOICE_INPUT_SAMPLE_RATE / 10;

/** Float32 [-1,1] → Int16 PCM。 */
function floatTo16BitPCM(float: Float32Array): Int16Array {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * 麦克风采集：用 react-native-audio-api 的 AudioRecorder（与播放共用同一音频引擎/会话，
 * 避免和 expo-audio 抢 AVAudioSession）。
 *
 * 走「游戏式」路线：不启用 VPIO 回声消除。iOS 一旦开启 iosVoiceProcessing，会把整个会话
 * 的所有输出（含 expo-audio 音乐）塞进语音处理管线——限带、AGC、闪避，导致音乐明显发闷，
 * 且语音处理会话在音乐占用播放时可能起不了录音引擎。关掉 VPIO 后会话回到普通
 * playAndRecord，音乐保持原质、采集也不再冲突。代价是没有 AEC：助手外放会被麦克风回采
 * 造成自打断，因此本模式要求佩戴耳机（UI 已提示）。
 *
 * onAudioReady 回调给出 Float32 AudioBuffer；下混/重采样到 16kHz 后按 100ms 切块转 base64。
 */
export class MicCapture {
  private recorder: AudioRecorder | null = null;
  private pending = new Int16Array(0);

  async start(onChunk: (base64: string) => void): Promise<void> {
    // rn-audio-api 默认会话 category 是 playback，不允许录音输入，直接 start 会
    // 报「Failed to start audio engine for recording」。语音会话需要 playAndRecord。
    //
    // 蓝牙路由关键：用 allowBluetoothA2DP 而非 allowBluetoothHFP。
    //   - HFP 是通话音质（单声道窄带），一旦允许，iOS 开麦时会把整条路由（含音乐）
    //     切到 HFP，音乐立刻发糊——这就是之前的现象。
    //   - A2DP 是高音质立体声但只能输出。allowBluetoothA2DP 让音乐/助手语音继续走
    //     A2DP 保持原质，麦克风输入自动回落到 iPhone 内置麦克风。
    // mode=default + 不开 VPIO，避免语音处理再对输出做限带/AGC。
    AudioManager.setSystemOptions({
      ios: {
        category: 'playAndRecord',
        mode: 'default',
        options: ['defaultToSpeaker', 'allowBluetoothA2DP'],
      },
      android: { mode: 'inCommunication' },
    });

    const recorder = new AudioRecorder({
      iosVoiceProcessing: false,
      androidInputPreset: 'generic',
    });
    this.recorder = recorder;

    const registered = recorder.onAudioReady(
      {
        sampleRate: VOICE_INPUT_SAMPLE_RATE,
        bufferLength: APPEND_CHUNK_SAMPLES,
        channelCount: 1,
      },
      (event) => {
        const int16 = floatTo16BitPCM(event.buffer.getChannelData(0));
        const sourceRate =
          event.buffer.sampleRate > 0 ? event.buffer.sampleRate : VOICE_INPUT_SAMPLE_RATE;
        const samples = resampleLinear(int16, sourceRate, VOICE_INPUT_SAMPLE_RATE);

        const merged = new Int16Array(this.pending.length + samples.length);
        merged.set(this.pending, 0);
        merged.set(samples, this.pending.length);
        this.pending = merged;

        let offset = 0;
        while (this.pending.length - offset >= APPEND_CHUNK_SAMPLES) {
          const slice = this.pending.subarray(offset, offset + APPEND_CHUNK_SAMPLES);
          onChunk(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64'));
          offset += APPEND_CHUNK_SAMPLES;
        }
        this.pending = this.pending.slice(offset);
      },
    );
    if (registered?.status === 'error') {
      throw new Error(registered.message);
    }

    const result = await recorder.start();
    if (result.status === 'error') {
      throw new Error(result.message);
    }
  }

  stop(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.pending = new Int16Array(0);
    if (!recorder) return;
    try {
      recorder.clearOnAudioReady();
    } catch {
      // 忽略
    }
    void recorder.stop().catch(() => undefined);
  }
}

/** Gateway 语音输出采样率：24kHz PCM16 单声道。 */
export const VOICE_OUTPUT_SAMPLE_RATE = 24000;

/** 首包预缓冲：攒够再开播，吸收网络抖动。 */
const PREBUFFER_MS = 180;

/**
 * 24kHz PCM 流式播放器：base64 解码成 AudioBuffer 后送入原生队列源无缝连播。
 * 队列播空后自动回到预缓冲状态；clear() 用于打断。
 */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferQueueSourceNode | null = null;
  private pendingMs = 0;
  private playing = false;
  private generation = 0;
  private readonly onSpeakingChange?: (speaking: boolean) => void;

  /** onSpeakingChange 在助手音频真正开始/停止出声时回调，用于音乐闪避（duck）。 */
  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
  }

  private setSpeaking(value: boolean): void {
    if (this.playing === value) return;
    this.playing = value;
    this.onSpeakingChange?.(value);
  }

  enqueue(base64: string, sampleRate: number): void {
    if (!this.ctx || !this.source) {
      this.ctx = new AudioContext({
        sampleRate: VOICE_OUTPUT_SAMPLE_RATE,
        latencyHint: 'interactive',
      });
      this.source = this.createSource();
      // 新建 context 可能处于 suspended，需 resume 才会真正出声（已 running 时无害）。
      void this.ctx.resume().catch(() => undefined);
    }
    const generation = this.generation;
    const source = this.source;
    void decodePCMInBase64(base64, sampleRate || VOICE_OUTPUT_SAMPLE_RATE, 1)
      .then((buffer) => {
        if (generation !== this.generation || this.source !== source) return;
        source.enqueueBuffer(buffer);
        if (!this.playing) {
          this.pendingMs += buffer.duration * 1000;
          if (this.pendingMs >= PREBUFFER_MS) {
            source.start();
            this.setSpeaking(true);
            this.pendingMs = 0;
          }
        }
      })
      .catch(() => undefined);
  }

  /** 打断：丢弃已排队音频并重建队列源。 */
  clear(): void {
    this.generation += 1;
    this.setSpeaking(false);
    this.pendingMs = 0;
    if (this.ctx) {
      const old = this.source;
      try {
        old?.stop();
      } catch {
        // 未 start 时 stop 会抛错，忽略
      }
      try {
        old?.disconnect();
      } catch {
        // 忽略
      }
      this.source = this.createSource();
    }
  }

  dispose(): void {
    this.generation += 1;
    this.setSpeaking(false);
    this.pendingMs = 0;
    const ctx = this.ctx;
    this.ctx = null;
    this.source = null;
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
  }

  private createSource(): AudioBufferQueueSourceNode {
    const ctx = this.ctx;
    if (!ctx) throw new Error('AudioContext not initialized');
    const source = ctx.createBufferQueueSource();
    // 源节点必须连到 destination 才会出声；漏掉这步助手音频会全程静音。
    source.connect(ctx.destination);
    source.onbufferended = (event) => {
      // 队列播空：下一批音频重新走预缓冲
      if (event.isLastBufferInQueue) {
        this.setSpeaking(false);
        this.pendingMs = 0;
      }
    };
    return source;
  }
}
