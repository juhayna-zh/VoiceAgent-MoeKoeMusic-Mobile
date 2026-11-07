import Constants from 'expo-constants';

import type { GcpServerEvent } from './types';

export type GcpClientOptions = {
  url: string;
  token?: string;
  onEvent: (event: GcpServerEvent) => void;
  onClose: (reason: string) => void;
};

const PROTOCOL_VERSION = '7.0.0';
const HELLO_TIMEOUT_MS = 8000;
// 固定前缀 + 随机后缀：同一 instance_id 重连时 Gateway 自动替换旧 socket（GCP 租约规则），
// 避免 App 内快速重进页面触发 client_occupied。
const INSTANCE_ID = `moekoe_${Math.random().toString(36).slice(2, 8)}`;

let eventSeq = 0;
const nextEventId = () => `evt_moekoe_${++eventSeq}`;

// RN 原生 WebSocket 支持第三个参数传 headers（标准 DOM 类型没有该重载）
const RnWebSocket = WebSocket as unknown as new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export class GcpClient {
  private ws: WebSocket | null = null;
  private options: GcpClientOptions;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(options: GcpClientOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    const sessionId = `moekoe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const base = this.options.url.replace(/\/+$/, '');
    const url = `${base}/api/realtime?sessionId=${encodeURIComponent(sessionId)}`;

    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.helloTimer = setTimeout(() => {
        this.failHandshake(new Error('连接超时：未收到 session.ready'));
      }, HELLO_TIMEOUT_MS);

      try {
        this.ws = this.options.token
          ? new RnWebSocket(url, null, {
              headers: { Authorization: `Bearer ${this.options.token}` },
            })
          : new WebSocket(url);
      } catch (error) {
        this.failHandshake(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.ws.onopen = () => {
        this.send({
          type: 'session.hello',
          event_id: nextEventId(),
          protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
          client: {
            type: 'mobile',
            version: String(Constants.expoConfig?.version ?? '0.0.0'),
            instance_id: INSTANCE_ID,
          },
          capabilities: ['input.audio', 'input.text', 'session.heartbeat'],
          locale: 'zh-CN',
          time_zone: 'Asia/Shanghai',
          connection: {
            voice_enabled: true,
            input_enabled: true,
            output_enabled: true,
            text_only: false,
          },
        });
      };

      this.ws.onmessage = (messageEvent) => {
        let event: GcpServerEvent;
        try {
          event = JSON.parse(String(messageEvent.data)) as GcpServerEvent;
        } catch {
          return;
        }

        if (event.type === 'session.ping') {
          // Gateway 要求 pong 用 request_event_id 回指本次 ping 的 event_id，
          // 否则 schema 校验失败并被当作 unsupported 事件拒绝。
          this.send({
            type: 'session.pong',
            event_id: nextEventId(),
            request_event_id: event.event_id ?? '',
          });
          return;
        }
        if (event.type === 'session.ready') {
          this.completeHandshake();
        }
        this.options.onEvent(event);
      };

      this.ws.onerror = () => {
        // 具体原因由 onclose 统一上报
      };

      this.ws.onclose = (closeEvent: CloseEvent) => {
        const reason =
          closeEvent.code === 1000
            ? '连接已关闭'
            : `连接断开（code=${closeEvent.code}${closeEvent.reason ? ` reason=${closeEvent.reason}` : ''}）`;
        if (!this.completeHandshakeIfPending(new Error(this.describeClose(closeEvent)))) {
          if (!this.closedByUser) this.options.onClose(reason);
        }
      };
    });
  }

  sendAudio(pcm16Base64: string): void {
    // Gateway 对每个入站事件校验 event_id（必填 string），缺失会被 bad_event 拒绝。
    this.send({ type: 'input_audio_buffer.append', event_id: nextEventId(), audio: pcm16Base64 });
  }

  cancelResponse(responseId?: string): void {
    this.send({ type: 'response.cancel', event_id: nextEventId(), responseId });
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.readyResolve = null;
    this.readyReject = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // Socket already gone.
    }
  }

  private describeClose(closeEvent: CloseEvent): string {
    if (closeEvent.reason?.includes('client_occupied')) {
      return '该账号已有其他活动连接（client_occupied），请先断开另一台设备';
    }
    return `无法连接语音服务（code=${closeEvent.code}${closeEvent.reason ? ` ${closeEvent.reason}` : ''}）`;
  }

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  private completeHandshake(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyReject = null;
    resolve?.();
  }

  /** 握手未完成时以错误结束；返回是否消费了该事件 */
  private completeHandshakeIfPending(error: Error): boolean {
    if (!this.readyReject) return false;
    this.failHandshake(error);
    return true;
  }

  private failHandshake(error: Error): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(error);
    this.disconnect();
  }
}
