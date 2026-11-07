export type VoiceAgentStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type ToolCallDetail = {
  name: string;
  args?: unknown;
  status: 'completed' | 'failed' | 'unsupported';
  output?: unknown;
  error?: { code: string; message: string };
};

export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  final: boolean;
  /** 仅 role==='tool' 时存在：完整的入参与返回结果，供对话界面点击展开核对。 */
  tool?: ToolCallDetail;
};

// GCP 7.0 上行事件（docs/gateway-protocol.zh.md）
export type GcpClientEvent =
  | {
      type: 'session.hello';
      event_id: string;
      protocol: { min: string; max: string };
      client: { type: string; version: string; instance_id: string };
      capabilities: string[];
      locale?: string;
      time_zone?: string;
      connection: {
        voice_enabled: boolean;
        input_enabled: boolean;
        output_enabled: boolean;
        text_only: boolean;
      };
    }
  | { type: 'input_audio_buffer.append'; event_id: string; audio: string }
  | { type: 'response.cancel'; event_id: string; responseId?: string }
  | { type: 'session.pong'; event_id?: string };

// GCP 下行事件（线事件名见 shared/protocol/realtime-events.mjs）
export type GcpServerEvent = {
  type: string;
  event_id?: string;
  // session.ready
  protocol_version?: string;
  session_id?: string;
  capabilities?: string[];
  // audio.delta
  audio?: string;
  sampleRate?: number;
  responseId?: string;
  turnId?: string;
  // transcript.delta / transcript.final / transcript.discard
  // user 侧 content 为累计全文（replace），assistant 侧 delta 为增量、final 为全文
  content?: string;
  replace?: boolean;
  text?: string;
  transcript?: string;
  role?: string;
  // error：Gateway 把详情放在 event.error.{code,message}，部分路径也可能给顶层 message
  message?: string;
  code?: string;
  error?: { code?: string; message?: string };
  // voice.state（state: listening/thinking/speaking…）/ playback.clear（reason）
  state?: string;
  reason?: string;
  // client.action.request：name 形如 `client.tool.player_control`，arguments 为模型给出的参数
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
};
