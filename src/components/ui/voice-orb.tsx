import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { View, XStack, YStack } from 'tamagui';

import { isVoiceActive, useVoiceAgentState, voiceAgentActions } from '@/features/voice-agent/store';
import { useIsDark, usePalette } from '@/hooks/use-palette';

const ORB_SIZE = 58;

/**
 * 与 ToastHost 相同的「顶层宿主」协调：本组件同时挂在根布局与 player 原生 modal 内，
 * modal 会盖住根布局的宿主，故只让最后挂载（最上层）的宿主渲染，避免两个气泡叠加。
 */
let hostSeq = 0;
const hostStack: number[] = [];
const hostListeners = new Set<() => void>();

function topHost(): number {
  return hostStack[hostStack.length - 1] ?? -1;
}

function useIsTopHost(): boolean {
  const [id] = useState(() => {
    hostSeq += 1;
    return hostSeq;
  });

  useEffect(() => {
    hostStack.push(id);
    for (const listener of hostListeners) listener();
    return () => {
      const index = hostStack.indexOf(id);
      if (index >= 0) hostStack.splice(index, 1);
      for (const listener of hostListeners) listener();
    };
  }, [id]);

  return useSyncExternalStore(
    (listener) => {
      hostListeners.add(listener);
      return () => {
        hostListeners.delete(listener);
      };
    },
    () => topHost() === id,
    () => false,
  );
}

type OrbMode = 'idle' | 'listening' | 'speaking';

/** 三个小点依次闪烁（仅透明度变化，不位移不缩放）。 */
function Dot({ active, delay }: { active: boolean; delay: number }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (active) {
      // withDelay 放在 withRepeat 外层：延迟只作用于启动，之后无限循环依次闪烁。
      progress.value = withDelay(
        delay,
        withRepeat(withTiming(1, { duration: 300, easing: Easing.inOut(Easing.ease) }), -1, true),
      );
    } else {
      cancelAnimation(progress);
      progress.value = 0;
    }
  }, [active, delay, progress]);

  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + progress.value * 0.7,
  }));

  return (
    <Animated.View
      style={[{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#FFFFFF' }, style]}
    />
  );
}

function ListeningDots({ mode }: { mode: OrbMode }) {
  const active = mode !== 'idle';
  return (
    <XStack gap={4} alignItems="center" height={9}>
      <Dot active={active} delay={0} />
      <Dot active={active} delay={160} />
      <Dot active={active} delay={320} />
    </XStack>
  );
}

/**
 * 语音助手常驻圆形悬浮气泡：只要不在语音 tab 内就始终显示（含 app 刚打开、暂停后、
 * player 原生 modal 上）。运行时高亮、机器人下三点依次闪烁；未运行时整体变暗。
 * 点击气泡回到语音 tab；右上角徽标可唤醒（未运行）或暂停（运行中）。
 */
export function VoiceOrb() {
  const palette = usePalette();
  const isDark = useIsDark();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { status } = useVoiceAgentState();
  const isTop = useIsTopHost();
  const active = isVoiceActive(status);

  const mode: OrbMode =
    status === 'speaking' ? 'speaking' : status === 'listening' ? 'listening' : 'idle';

  if (!isTop || pathname === '/voice') return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        right: 16,
        bottom: insets.bottom + 160,
        zIndex: 190000,
        elevation: 190000,
      }}>
      <XStack
        width={ORB_SIZE}
        height={ORB_SIZE}
        borderRadius={ORB_SIZE / 2}
        overflow="hidden"
        alignItems="center"
        justifyContent="center"
        opacity={active ? 1 : 0.5}
        shadowColor={palette.dockShadow}
        shadowOffset={{ width: 0, height: isDark ? 4 : 8 }}
        shadowOpacity={isDark ? 0.4 : 0.24}
        shadowRadius={isDark ? 10 : 16}
        elevation={10}
        transition="quickest"
        pressStyle={{ scale: 0.92 }}
        onPress={() => router.navigate('/(tabs)/voice')}>
        <LinearGradient
          colors={[palette.gradientStart, palette.gradientEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <YStack alignItems="center" justifyContent="center" gap={2}>
          <MaterialCommunityIcons name="robot-happy-outline" size={26} color="#FFFFFF" />
          <ListeningDots mode={mode} />
        </YStack>
      </XStack>

      <XStack
        position="absolute"
        top={-4}
        right={-4}
        width={24}
        height={24}
        borderRadius={12}
        alignItems="center"
        justifyContent="center"
        backgroundColor={palette.barSurface}
        borderWidth={StyleSheet.hairlineWidth}
        borderColor={palette.border}
        shadowColor={palette.dockShadow}
        shadowOffset={{ width: 0, height: 2 }}
        shadowOpacity={isDark ? 0.3 : 0.15}
        shadowRadius={4}
        zIndex={2}
        transition="quickest"
        pressStyle={{ scale: 0.85, opacity: 0.7 }}
        onPress={() => voiceAgentActions.toggle()}>
        <Ionicons name={active ? 'pause' : 'mic'} size={13} color={palette.accent} />
      </XStack>
    </View>
  );
}
