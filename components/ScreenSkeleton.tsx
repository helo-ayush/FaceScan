import React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

export function SkeletonBlock({ width = '100%', height, radius = 16 }: { width?: number | `${number}%`; height: number; radius?: number }) {
  const opacity = useSharedValue(0.45);
  React.useEffect(() => {
    opacity.value = withRepeat(withSequence(withTiming(0.8, { duration: 650 }), withTiming(0.35, { duration: 650 })), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View entering={FadeIn.duration(120)} style={[{ width, height, borderRadius: radius, backgroundColor: '#e2e8f0' }, style]} />;
}

type Variant = 'dashboard' | 'list' | 'form' | 'sync';

export function ScreenSkeleton({ variant = 'list' }: { variant?: Variant }) {
  const cards = variant === 'list' ? 4 : 3;
  return (
    <View className="flex-1 bg-[#f8fafc] px-4 pt-5">
      {variant === 'dashboard' ? <>
        <SkeletonBlock height={136} radius={24} />
        <View className="flex-row gap-3 mt-6"><SkeletonBlock width="50%" height={144} radius={24} /><SkeletonBlock width="50%" height={144} radius={24} /></View>
        <SkeletonBlock height={116} radius={24} />
      </> : variant === 'form' ? <>
        <SkeletonBlock width="45%" height={20} radius={8} />
        <SkeletonBlock height={54} radius={16} />
        <SkeletonBlock height={54} radius={16} />
        <SkeletonBlock height={54} radius={16} />
        <SkeletonBlock height={160} radius={24} />
      </> : <>
        <View className="flex-row gap-3"><SkeletonBlock width="32%" height={48} radius={14} /><SkeletonBlock width="32%" height={48} radius={14} /><SkeletonBlock width="32%" height={48} radius={14} /></View>
        {Array.from({ length: cards }).map((_, index) => <View key={index} className="rounded-3xl bg-white border border-slate-100 p-4 mt-4"><SkeletonBlock width="45%" height={16} radius={8} /><View className="mt-3"><SkeletonBlock height={12} radius={6} /></View><View className="mt-2"><SkeletonBlock width="70%" height={12} radius={6} /></View><View className="mt-4"><SkeletonBlock width="30%" height={28} radius={10} /></View></View>)}
      </>}
    </View>
  );
}
