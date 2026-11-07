import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'moekoe.settings.voiceAgent';

export const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:3101';

export type VoiceAgentConfig = {
  gatewayUrl: string;
  token?: string;
};

export async function readVoiceAgentConfig(): Promise<VoiceAgentConfig> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return { gatewayUrl: DEFAULT_GATEWAY_URL };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { gatewayUrl: DEFAULT_GATEWAY_URL };
    const value = parsed as Partial<VoiceAgentConfig>;
    return {
      gatewayUrl: typeof value.gatewayUrl === 'string' && value.gatewayUrl ? value.gatewayUrl : DEFAULT_GATEWAY_URL,
      token: typeof value.token === 'string' && value.token ? value.token : undefined,
    };
  } catch {
    return { gatewayUrl: DEFAULT_GATEWAY_URL };
  }
}

export async function writeVoiceAgentConfig(config: VoiceAgentConfig): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage write failures and keep runtime state usable.
  }
}
