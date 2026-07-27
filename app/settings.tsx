import React, { useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import { useAppSettings } from "@/utils/settings";

export default function SettingsScreen() {
  const router = useRouter();
  const { settings, updateSetting, triggerHaptic } = useAppSettings();

  const [cacheCleared, setCacheCleared] = useState(false);

  function handleClearCache() {
    triggerHaptic("success");
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2000);
  }

  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-background">
      {/* Settings Navigation Header */}
      <View 
        style={{ paddingTop: Math.max(insets.top, 16) }} 
        className="bg-surface border-b border-slate-100 z-40"
      >
        <View className="h-16 px-6 flex-row items-center gap-4">
          <Pressable
            onPress={() => {
              triggerHaptic("light");
              router.back();
            }}
            className="w-10 h-10 items-center justify-center rounded-full bg-surface-muted border border-slate-100 active:scale-95 transition-all"
          >
            <Icon name="arrow_back" size={20} color="#0f172a" />
          </Pressable>
          <Text className="text-2xl font-bold text-on-surface tracking-tight">
            Scanner Settings
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Capture Behavior */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Capture Configuration
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft">
            {/* Auto Capture Toggle */}
            <Pressable
              onPress={() => {
                triggerHaptic("light");
                updateSetting("autoCapture", !settings.autoCapture);
              }}
              className="p-5 flex-row items-center justify-between border-b border-slate-100 active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Auto-Capture Mode</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Automatically register match when face is centered
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.autoCapture ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>

            {/* Haptic Feedback Toggle */}
            <Pressable
              onPress={() => {
                // Toggle haptics, then trigger micro vibration if turned ON
                const nextVal = !settings.hapticsEnabled;
                updateSetting("hapticsEnabled", nextVal);
                if (nextVal) {
                  setTimeout(() => AppSettings.haptic("light"), 100);
                }
              }}
              className="p-5 flex-row items-center justify-between border-b border-slate-100 active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Haptic Feedback</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Vibrate device on scanning states and button clicks
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.hapticsEnabled ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>

            {/* Sound Feedback Toggle */}
            <Pressable
              onPress={() => {
                triggerHaptic("light");
                updateSetting("soundFeedback", !settings.soundFeedback);
              }}
              className="p-5 flex-row items-center justify-between border-b border-slate-100 active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Audio Confirmation</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Play success sound feedback on scan complete
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.soundFeedback ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>

            {/* Scanner Grid Toggle */}
            <Pressable
              onPress={() => {
                triggerHaptic("light");
                updateSetting("showGrid", !settings.showGrid);
              }}
              className="p-5 flex-row items-center justify-between active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Show Target Grid</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Display target overlay alignment lines
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.showGrid ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>
          </View>
        </View>

        {/* Section 2: Hardware & Security */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Camera & Hardware
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft">
            {/* Camera Selector */}
            <View className="p-5 border-b border-slate-100">
              <Text className="font-bold text-on-surface text-base mb-3">Camera Source</Text>
              <View className="flex-row gap-3">
                <Pressable
                  onPress={() => {
                    triggerHaptic("light");
                    updateSetting("cameraFacing", "front");
                  }}
                  className={`flex-1 py-3 rounded-2xl items-center border font-semibold ${
                    settings.cameraFacing === "front" ? "bg-primary/10 border-primary" : "bg-surface-muted border-slate-100"
                  } active:scale-95 transition-all`}
                >
                  <Text className={`font-bold text-sm ${settings.cameraFacing === "front" ? "text-primary" : "text-on-surface-variant"}`}>
                    Front Camera
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    triggerHaptic("light");
                    updateSetting("cameraFacing", "back");
                  }}
                  className={`flex-1 py-3 rounded-2xl items-center border font-semibold ${
                    settings.cameraFacing === "back" ? "bg-primary/10 border-primary" : "bg-surface-muted border-slate-100"
                  } active:scale-95 transition-all`}
                >
                  <Text className={`font-bold text-sm ${settings.cameraFacing === "back" ? "text-primary" : "text-on-surface-variant"}`}>
                    Back Camera
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Scan Precision / Sensitivity */}
            <View className="p-5">
              <Text className="font-bold text-on-surface text-base mb-3">Scan Precision</Text>
              <View className="flex-row gap-2">
                {(["low", "standard", "high"] as const).map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => {
                      triggerHaptic("light");
                      updateSetting("sensitivity", s);
                    }}
                    className={`flex-1 py-3 rounded-2xl items-center border capitalize ${
                      settings.sensitivity === s ? "bg-primary/10 border-primary" : "bg-surface-muted border-slate-100"
                    } active:scale-95 transition-all`}
                  >
                    <Text className={`font-bold text-xs ${settings.sensitivity === s ? "text-primary" : "text-on-surface-variant"}`}>
                      {s}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </View>

        {/* Section 3: Data Actions */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Data Management
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft p-5 gap-4">
            <View>
              <Text className="font-bold text-on-surface text-base">Storage Management</Text>
              <Text className="text-xs text-on-surface-variant mt-1">
                Clearing scanner template indexes does not affect roster database lists.
              </Text>
            </View>

            <Pressable
              onPress={handleClearCache}
              disabled={cacheCleared}
              className={`w-full py-4 rounded-2xl items-center justify-center flex-row gap-2 border border-slate-100 ${
                cacheCleared ? "bg-success-light border-success/20" : "bg-surface-muted hover:bg-slate-200"
              } active:scale-98 transition-all`}
            >
              <Icon
                name={cacheCleared ? "check" : "delete_sweep"}
                size={18}
                color={cacheCleared ? "#10b981" : "#ef4444"}
              />
              <Text className={`font-bold text-sm ${cacheCleared ? "text-success" : "text-error"}`}>
                {cacheCleared ? "Cache Purged successfully" : "Clear Template Scan Cache"}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
