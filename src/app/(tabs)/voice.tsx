import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner, Text, View, XStack, YStack } from 'tamagui';

import { MaxContentWidth } from '@/constants/theme';
import { isVoiceActive, useVoiceAgentState, voiceAgentActions } from '@/features/voice-agent/store';
import type { TranscriptEntry, VoiceAgentStatus } from '@/features/voice-agent/types';
import { useDockContentInset } from '@/hooks/use-dock-inset';
import { usePalette } from '@/hooks/use-palette';

const STATUS_TEXT: Record<VoiceAgentStatus, string> = {
  idle: '未唤醒',
  connecting: '连接中…',
  ready: '准备就绪',
  listening: '聆听中，说点什么吧',
  thinking: '思考中…',
  speaking: '回答中…',
  error: '连接失败',
};

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function VoiceTab() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const dockInset = useDockContentInset();
  const { status, error, micError, transcripts } = useVoiceAgentState();
  const listRef = useRef<FlatList<TranscriptEntry>>(null);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  const active = isVoiceActive(status);

  useEffect(() => {
    if (transcripts.length) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [transcripts]);

  const busy = status === 'connecting';
  const statusText = micError || STATUS_TEXT[status] || '';

  return (
    <View flex={1} backgroundColor={palette.background}>
      <LinearGradient colors={[palette.accentSoft, 'transparent']} style={styles.headerGlow} />

      <YStack flex={1} paddingTop={insets.top + 8}>
        <XStack
          alignSelf="center"
          width="100%"
          maxWidth={MaxContentWidth}
          alignItems="center"
          gap={12}
          paddingHorizontal={16}>
          <Text color={palette.text} fontSize={19} fontWeight="800">
            语音助手
          </Text>
          <XStack flex={1} justifyContent="flex-end" alignItems="center" gap={6}>
            <View
              width={8}
              height={8}
              borderRadius={4}
              backgroundColor={
                status === 'error'
                  ? '#e5484d'
                  : active
                    ? '#30a46c'
                    : palette.textTertiary
              }
            />
            <Text color={palette.textTertiary} fontSize={12}>
              {status === 'error' ? '断开' : active ? '已连接' : '未唤醒'}
            </Text>
          </XStack>
        </XStack>

        {status === 'error' ? (
          <YStack flex={1} alignItems="center" justifyContent="center" gap={16} padding={24}>
            <Ionicons name="cloud-offline-outline" size={44} color={palette.textTertiary} />
            <Text color={palette.text} fontSize={15} fontWeight="700" textAlign="center">
              {error || '连接失败'}
            </Text>
            <Text color={palette.textTertiary} fontSize={12.5} textAlign="center">
              请确认语音服务已启动，或在 设置 → 语音助手 中检查地址
            </Text>
            <XStack
              paddingHorizontal={22}
              paddingVertical={10}
              borderRadius={999}
              backgroundColor={palette.accent}
              transition="quickest"
              pressStyle={{ opacity: 0.7, scale: 0.96 }}
              onPress={() => void voiceAgentActions.start()}>
              <Text color="#fff" fontSize={14} fontWeight="700">
                重试
              </Text>
            </XStack>
          </YStack>
        ) : (
          <>
            <FlatList
              ref={listRef}
              data={transcripts}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: transcripts.length ? 'flex-end' : 'center',
                paddingHorizontal: 20,
                paddingVertical: 24,
                paddingBottom: 12,
                gap: 10,
              }}
              ListEmptyComponent={
                <YStack flex={1} alignItems="center" justifyContent="center" gap={14}>
                  {busy ? (
                    <Spinner size="large" color={palette.accent} />
                  ) : (
                    <Ionicons name="chatbubbles-outline" size={44} color={palette.textTertiary} />
                  )}
                  <Text color={palette.textTertiary} fontSize={13} textAlign="center">
                    {busy
                      ? '正在连接语音服务…'
                      : active
                        ? '连接后这里会显示对话内容'
                        : '点下方「唤醒」开始语音对话\n唤醒后切到其他页面也会持续运行'}
                  </Text>
                </YStack>
              }
              renderItem={({ item }) => {
                if (item.role === 'tool') {
                  const expanded = expandedTool === item.id;
                  const detail = item.tool;
                  return (
                    <XStack justifyContent="center">
                      <YStack
                        maxWidth="92%"
                        paddingHorizontal={10}
                        paddingVertical={6}
                        borderRadius={8}
                        backgroundColor={palette.accentSoft}
                        borderWidth={StyleSheet.hairlineWidth}
                        borderColor={palette.border}
                        transition="quickest"
                        pressStyle={{ opacity: 0.7 }}
                        onPress={() => setExpandedTool(expanded ? null : item.id)}>
                        <XStack alignItems="center" gap={6}>
                          <Text flexShrink={1} fontSize={11.5} lineHeight={16} color={palette.textSecondary}>
                            {item.text}
                          </Text>
                          <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={12}
                            color={palette.textTertiary}
                          />
                        </XStack>
                        {expanded && detail ? (
                          <YStack marginTop={8} gap={8}>
                            <YStack gap={2}>
                              <Text fontSize={10.5} fontWeight="700" color={palette.textTertiary}>
                                入参
                              </Text>
                              <Text fontSize={11} lineHeight={16} color={palette.text}>
                                {formatJson(detail.args)}
                              </Text>
                            </YStack>
                            <YStack gap={2}>
                              <Text fontSize={10.5} fontWeight="700" color={palette.textTertiary}>
                                结果 · {detail.status}
                              </Text>
                              <Text fontSize={11} lineHeight={16} color={palette.text}>
                                {detail.status === 'completed'
                                  ? formatJson(detail.output)
                                  : formatJson(detail.error)}
                              </Text>
                            </YStack>
                          </YStack>
                        ) : null}
                      </YStack>
                    </XStack>
                  );
                }
                return (
                  <XStack justifyContent={item.role === 'user' ? 'flex-end' : 'flex-start'}>
                    <YStack
                      maxWidth="80%"
                      paddingHorizontal={14}
                      paddingVertical={9}
                      borderRadius={16}
                      borderBottomRightRadius={item.role === 'user' ? 6 : 16}
                      borderBottomLeftRadius={item.role === 'user' ? 16 : 6}
                      backgroundColor={item.role === 'user' ? palette.accent : palette.card}
                      borderWidth={item.role === 'user' ? 0 : StyleSheet.hairlineWidth}
                      borderColor={palette.border}
                      opacity={item.final ? 1 : 0.65}>
                      <Text
                        fontSize={14.5}
                        lineHeight={21}
                        color={item.role === 'user' ? '#fff' : palette.text}>
                        {item.text}
                      </Text>
                    </YStack>
                  </XStack>
                );
              }}
            />

            <YStack
              alignSelf="center"
              width="100%"
              maxWidth={MaxContentWidth}
              alignItems="center"
              gap={12}
              paddingHorizontal={20}
              paddingBottom={dockInset}>
              <XStack alignItems="center" gap={5} opacity={0.7}>
                <Ionicons name="headset-outline" size={13} color={palette.textTertiary} />
                <Text color={palette.textTertiary} fontSize={11.5} textAlign="center">
                  为不打断音乐，未开启回声消除，建议佩戴耳机使用
                </Text>
              </XStack>
              {active ? (
                <XStack alignItems="center" gap={8}>
                  {status === 'thinking' ? <Spinner size="small" color={palette.accent} /> : null}
                  <Text color={palette.textTertiary} fontSize={13}>
                    {statusText}
                  </Text>
                </XStack>
              ) : (
                <Text color={palette.textTertiary} fontSize={13}>
                  {statusText}
                </Text>
              )}
              <XStack
                alignItems="center"
                gap={8}
                paddingHorizontal={30}
                paddingVertical={13}
                borderRadius={999}
                backgroundColor={active ? palette.card : palette.accent}
                borderWidth={active ? StyleSheet.hairlineWidth : 0}
                borderColor={palette.border}
                transition="quickest"
                pressStyle={{ opacity: 0.7, scale: 0.96 }}
                onPress={() => voiceAgentActions.toggle()}>
                <Ionicons
                  name={active ? 'pause' : 'mic'}
                  size={17}
                  color={active ? palette.text : '#fff'}
                />
                <Text
                  color={active ? palette.text : '#fff'}
                  fontSize={15}
                  fontWeight="700">
                  {active ? '暂停' : '唤醒'}
                </Text>
              </XStack>
            </YStack>
          </>
        )}
      </YStack>
    </View>
  );
}

const styles = StyleSheet.create({
  headerGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 220,
  },
});
