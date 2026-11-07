import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { useSyncExternalStore } from 'react';

import { playerActions } from '@/features/player/store';

import { MicCapture, PcmPlayer } from './audio-pipeline';
import { GcpClient } from './gcp-client';
import { readVoiceAgentConfig } from './settings-storage';
import type { GcpServerEvent, TranscriptEntry, VoiceAgentStatus } from './types';

/** 暂停语音后把 iOS 音频会话交还 expo-audio 的播放配置（与 player/store 一致）。 */
const PLAYBACK_AUDIO_MODE = {
  allowsRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'doNotMix',
} as const;

/** 视为「语音助手运行中」的状态：用于 tab 小红点与悬浮条显隐。 */
const ACTIVE_STATUSES: VoiceAgentStatus[] = [
  'connecting',
  'ready',
  'listening',
  'thinking',
  'speaking',
];

export function isVoiceActive(status: VoiceAgentStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export type VoiceAgentState = {
  status: VoiceAgentStatus;
  error: string;
  micError: string;
  transcripts: TranscriptEntry[];
};

const INITIAL_STATE: VoiceAgentState = {
  status: 'idle',
  error: '',
  micError: '',
  transcripts: [],
};

function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(partial: Partial<T>) {
      let changed = false;
      for (const key of Object.keys(partial) as (keyof T)[]) {
        if (!Object.is(state[key], partial[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const voiceAgentStore = createStore(INITIAL_STATE);

let client: GcpClient | null = null;
let player: PcmPlayer | null = null;
let mic: MicCapture | null = null;
let startSeq = 0;

/** 权限检查 + 麦克风采集启动；seq 用于在启动过程中被 stop() 打断时安全退出。 */
async function startMic(seq: number): Promise<void> {
  try {
    let permission = await getRecordingPermissionsAsync();
    if (!permission.granted) {
      permission = await requestRecordingPermissionsAsync();
    }
    if (seq !== startSeq) return;
    if (!permission.granted) {
      voiceAgentStore.setState({ micError: '需要麦克风权限才能对话，请在系统设置中允许' });
      return;
    }
    const capture = new MicCapture();
    mic = capture;
    await capture.start((base64) => voiceAgentActions.sendAudio(base64));
    // 启动期间被暂停：立刻回收刚建的采集器
    if (seq !== startSeq) {
      capture.stop();
      if (mic === capture) mic = null;
    }
  } catch (error) {
    if (seq !== startSeq) return;
    voiceAgentStore.setState({
      micError: error instanceof Error ? error.message : '无法启动麦克风',
    });
  }
}

function upsertTranscript(
  id: string,
  role: TranscriptEntry['role'],
  nextText: string,
  final: boolean,
  appendDelta: boolean,
) {
  const transcripts = [...voiceAgentStore.getState().transcripts];
  const index = transcripts.findIndex((entry) => entry.id === id);
  if (index < 0) {
    transcripts.push({ id, role, text: nextText, final });
  } else {
    const existing = transcripts[index];
    // 已定稿的条目不再被后续 delta 覆盖
    if (existing.final) return;
    const text = appendDelta ? existing.text + nextText : nextText;
    transcripts[index] = { ...existing, text: final ? nextText || existing.text : text, final };
  }
  voiceAgentStore.setState({ transcripts });
}

function discardTranscript(id: string) {
  const transcripts = voiceAgentStore.getState().transcripts;
  const index = transcripts.findIndex((entry) => entry.id === id);
  if (index < 0 || transcripts[index].final) return;
  voiceAgentStore.setState({ transcripts: transcripts.filter((entry) => entry.id !== id) });
}

function clearPlayback() {
  player?.clear();
}

function handleEvent(event: GcpServerEvent) {
  switch (event.type) {
    case 'voice.ready':
      voiceAgentStore.setState({ status: 'listening' });
      break;
    case 'turn.started':
      // 用户开口进入新轮次；实际停播以 Gateway 权威的 playback.clear 为准
      voiceAgentStore.setState({ status: 'listening' });
      break;
    case 'voice.state':
      // 与 web 参考实现一致：服务端判定回到 listening（用户打断）时清空本地播放
      if (event.state === 'listening') {
        clearPlayback();
        voiceAgentStore.setState({ status: 'listening' });
      }
      break;
    case 'playback.clear':
      // Gateway 权威打断信号：丢弃已排队音频，避免助手盖过用户
      clearPlayback();
      break;
    case 'response.interrupted':
      clearPlayback();
      break;
    case 'response.started':
      voiceAgentStore.setState({ status: 'thinking' });
      break;
    case 'audio.delta':
      voiceAgentStore.setState({ status: 'speaking' });
      if (event.audio) {
        if (!player) {
          // 助手出声时压低音乐、说完恢复（音乐闪避）
          player = new PcmPlayer((speaking) => playerActions.setMusicDucked(speaking));
        }
        player.enqueue(event.audio, event.sampleRate ?? 24000);
      }
      break;
    case 'transcript.delta':
    case 'transcript.final': {
      const isFinal = event.type === 'transcript.final';
      const content = String(event.content ?? event.text ?? event.transcript ?? '');
      if (event.role === 'user') {
        // 用户侧 content 为累计全文（replace 语义）
        if (!content) break;
        const turnId = String(event.turnId ?? `user-${Date.now()}`);
        upsertTranscript(`user:${turnId}`, 'user', content, isFinal, false);
      } else {
        // 助手侧 delta 为增量、final 为全文
        const responseId = String(event.responseId ?? 'assistant');
        if (!isFinal && !content) break;
        upsertTranscript(`voice:${responseId}`, 'assistant', content, isFinal, !isFinal);
      }
      break;
    }
    case 'transcript.discard': {
      if (event.role === 'user' && event.turnId) {
        discardTranscript(`user:${String(event.turnId)}`);
      }
      break;
    }
    case 'error': {
      // Gateway error 详情在 event.error.{code,message}；兼容顶层 message。
      const detail = event.error?.message ?? event.message ?? '语音服务返回错误';
      const code = event.error?.code ?? event.code;
      voiceAgentStore.setState({
        status: 'error',
        error: code ? `${detail}（${code}）` : String(detail),
      });
      break;
    }
    default:
      break;
  }
}

export const voiceAgentActions = {
  async start(): Promise<void> {
    if (client) return;
    const seq = ++startSeq;
    voiceAgentStore.setState({ status: 'connecting', error: '', micError: '', transcripts: [] });

    const config = await readVoiceAgentConfig();
    if (seq !== startSeq) return;

    const gcp = new GcpClient({
      url: config.gatewayUrl,
      token: config.token,
      onEvent: handleEvent,
      onClose: (reason) => {
        if (client === gcp) {
          client = null;
          voiceAgentStore.setState({ status: 'error', error: reason });
        }
      },
    });
    client = gcp;

    try {
      await gcp.connect();
      if (seq !== startSeq || client !== gcp) {
        gcp.disconnect();
        return;
      }
      voiceAgentStore.setState({ status: 'ready' });
      // 唤醒后麦克风常驻：生命周期由本全局控制器持有，与任何屏幕 mount/unmount 无关
      await startMic(seq);
    } catch (error) {
      if (client === gcp) client = null;
      voiceAgentStore.setState({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  stop(): void {
    startSeq += 1;
    const gcp = client;
    client = null;
    gcp?.disconnect();
    player?.dispose();
    player = null;
    mic?.stop();
    mic = null;
    // 确保暂停后音乐音量恢复（dispose 已回调，这里兜底）
    playerActions.setMusicDucked(false);
    // 把音频会话交还 expo-audio，恢复正常音乐播放
    void setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
    voiceAgentStore.setState({ status: 'idle', error: '', micError: '', transcripts: [] });
  },

  /** 唤醒/暂停切换。 */
  toggle(): void {
    if (isVoiceActive(voiceAgentStore.getState().status)) {
      voiceAgentActions.stop();
    } else {
      void voiceAgentActions.start();
    }
  },

  /** 上行一段 16kHz PCM16 base64；未连接时静默丢弃。 */
  sendAudio(base64: string): void {
    client?.sendAudio(base64);
  },

  /** 当前是否已建立会话（用于麦克风采集门控）。 */
  isConnected(): boolean {
    return client !== null;
  },
};

export function useVoiceAgentState(): VoiceAgentState {
  return useSyncExternalStore(
    voiceAgentStore.subscribe,
    voiceAgentStore.getState,
    voiceAgentStore.getState,
  );
}
