import React from 'react';
import { View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

export type SkeletonBlockProps = {
  /** Width of the block (defaults to '100%'). Accepts pixel number or percentage string. */
  width?: number | `${number}%`;
  /** Height of the skeleton block in density-independent pixels. */
  height: number;
  /** Corner border radius (defaults to 16). */
  radius?: number;
};

/**
 * Animated pulse placeholder block for loading states.
 * Uses Reanimated shared values to oscillate opacity between 0.35 and 0.8 smoothly.
 */
export function SkeletonBlock({ width = '100%', height, radius = 16 }: SkeletonBlockProps) {
  const opacity = useSharedValue(0.45);

  React.useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.8, { duration: 650 }),
        withTiming(0.35, { duration: 650 })
      ),
      -1,
      true
    );
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(120)}
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: '#e2e8f0',
        },
        animatedStyle,
      ]}
    />
  );
}

export type ScreenSkeletonVariant = 'dashboard' | 'list' | 'form' | 'sync';

export type ScreenSkeletonProps = {
  /** Layout template matching the target screen's geometry. */
  variant?: ScreenSkeletonVariant;
};

/**
 * Screen-level placeholder layout rendered while remote or database queries resolve.
 * Matches the spatial distribution and card geometries of target screens.
 */
export function ScreenSkeleton({ variant = 'list' }: ScreenSkeletonProps) {
  const cards = variant === 'list' ? 4 : 3;

  return (
    <View className="flex-1 bg-[#f8fafc] px-4 pt-5">
      {variant === 'dashboard' ? (
        // Dashboard variant: Hero header card, dual metric blocks, and recent activity card
        <>
          <SkeletonBlock height={136} radius={24} />
          <View className="flex-row gap-3 mt-6">
            <SkeletonBlock width="50%" height={144} radius={24} />
            <SkeletonBlock width="50%" height={144} radius={24} />
          </View>
          <View className="mt-6">
            <SkeletonBlock height={116} radius={24} />
          </View>
        </>
      ) : variant === 'form' ? (
        // Form variant: Label bar, multiple input fields, and action buttons
        <>
          <SkeletonBlock width="45%" height={20} radius={8} />
          <View className="mt-4 gap-3">
            <SkeletonBlock height={54} radius={16} />
            <SkeletonBlock height={54} radius={16} />
            <SkeletonBlock height={54} radius={16} />
          </View>
          <View className="mt-6">
            <SkeletonBlock height={160} radius={24} />
          </View>
        </>
      ) : (
        // List / Sync variant: Filter pill tabs followed by card skeletons
        <>
          <View className="flex-row gap-3">
            <SkeletonBlock width="32%" height={48} radius={14} />
            <SkeletonBlock width="32%" height={48} radius={14} />
            <SkeletonBlock width="32%" height={48} radius={14} />
          </View>

          {Array.from({ length: cards }).map((_, index) => (
            <View
              key={index}
              className="rounded-3xl bg-white border border-slate-100 p-4 mt-4"
            >
              <SkeletonBlock width="45%" height={16} radius={8} />
              <View className="mt-3">
                <SkeletonBlock height={12} radius={6} />
              </View>
              <View className="mt-2">
                <SkeletonBlock width="70%" height={12} radius={6} />
              </View>
              <View className="mt-4">
                <SkeletonBlock width="30%" height={28} radius={10} />
              </View>
            </View>
          ))}
        </>
      )}
    </View>
  );
}
