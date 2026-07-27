import React from "react";
import { View, Text, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Icon } from "./Icon";

export function ScreenHeader({ title }: { title: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View 
      style={{ paddingTop: Math.max(insets.top, 16) }} 
      className="bg-surface border-b border-slate-100 z-40"
    >
      <View className="h-16 px-6 flex-row items-center justify-between">
        <Text className="text-2xl font-bold text-on-surface tracking-tight">
          {title}
        </Text>
        <Pressable 
          onPress={() => router.push("/settings")}
          className="w-10 h-10 items-center justify-center rounded-full bg-surface-muted border border-slate-100 active:scale-95 active:bg-surface-container transition-all"
        >
          <Icon name="settings" size={20} color="#475569" />
        </Pressable>
      </View>
    </View>
  );
}
