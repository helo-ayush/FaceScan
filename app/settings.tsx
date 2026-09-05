/**
 * Application Settings Screen.
 *
 * Configures active operational parameters:
 * - Face Box Tracking Rate: Sets ML Kit detection intervals (10 FPS, 20 FPS, 30 FPS).
 * - Embedding Extraction Frequency: Balances matching speed against CPU/battery drain.
 * - Smooth Box Motion: Fluid interpolation between face bounding boxes.
 * - Anti-Spoofing & Strictness: Configures native dual-scale SPRT anti-spoof pipeline.
 * - Strict Lighting Check: Pauses enrollment photo capture during glare/dim warnings.
 * - Camera Source: Default front vs back camera selection.
 * - Haptic Feedback: Tactile feedback on attendance capture and UI interactions.
 * - Audio Chime: Positive sound acknowledgment on attendance confirmation (off by default).
 * - Storage Management: View and clear downloaded class embedding packages.
 */

import React, { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import {
  LIVENESS_STRICTNESS_PRESETS,
  LivenessStrictnessMode,
  PERFORMANCE_PRESETS,
  PerformanceMode,
  SCANNING_PERFORMANCE_PRESETS,
  ScanningPerformanceMode,
  useAppSettings,
} from "@/utils/settings";
import { clearAllClassPackages, getClassPackagesStorageInfo } from "@/utils/classPackageStore";

const DETECTION_OPTIONS: Array<{ key: PerformanceMode; label: string; fps: string }> = [
  { key: "low", label: "Low", fps: "10 FPS" },
  { key: "balanced", label: "Balanced", fps: "20 FPS" },
  { key: "high", label: "High", fps: "30 FPS" },
];

const SCANNING_OPTIONS: Array<{ key: ScanningPerformanceMode; label: string; speed: string }> = [
  { key: "low", label: "Low", speed: "1 sec" },
  { key: "standard", label: "Standard", speed: "500 ms" },
  { key: "high", label: "High", speed: "200 ms" },
];

const STRICTNESS_OPTIONS: Array<{ key: LivenessStrictnessMode; hint: string }> = [
  { key: "lenient", hint: "Fewer retries" },
  { key: "balanced", hint: "Recommended" },
  { key: "strict", hint: "Fewer misses" },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { settings, updateSetting, triggerHaptic, triggerChime } = useAppSettings();
  const insets = useSafeAreaInsets();

  const [storageInfo, setStorageInfo] = useState({ count: 0, totalBytes: 0, formattedSize: "0 KB" });
  const [storageLoading, setStorageLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [clearSuccess, setClearSuccess] = useState(false);

  const loadStorage = useCallback(async () => {
    try {
      const info = await getClassPackagesStorageInfo();
      setStorageInfo(info);
    } catch {
      // ignore
    } finally {
      setStorageLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStorage();
  }, [loadStorage]);

  function confirmClearPackages() {
    triggerHaptic("medium");
    Alert.alert(
      "Clear Downloaded Packages?",
      "This will remove locally cached face embedding files from this device. You can download updated class packages anytime from the Classes tab.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Packages",
          style: "destructive",
          onPress: async () => {
            setClearing(true);
            try {
              await clearAllClassPackages();
              await loadStorage();
              triggerHaptic("success");
              setClearSuccess(true);
              setTimeout(() => setClearSuccess(false), 3000);
            } catch (e) {
              console.warn("Failed to clear packages", e);
            } finally {
              setClearing(false);
            }
          },
        },
      ]
    );
  }

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
            accessibilityRole="button"
            accessibilityLabel="Go back"
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
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Performance & Tracking */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Performance & Tracking
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft">
            {/* Detection Rate (Face Box FPS) */}
            <View className="p-5 border-b border-slate-100">
              <View className="flex-row items-start justify-between mb-1">
                <View className="flex-1 pr-3">
                  <Text className="font-bold text-on-surface text-base">Face Box Tracking Rate</Text>
                  <Text className="text-xs text-on-surface-variant mt-1">
                    Controls camera frame analysis frequency for the bounding box.
                  </Text>
                </View>
                <Text className="text-xs font-black text-primary uppercase">
                  {settings.performance}
                </Text>
              </View>
              <View className="flex-row gap-2 mt-4">
                {DETECTION_OPTIONS.map((option) => (
                  <Pressable
                    key={option.key}
                    onPress={() => {
                      triggerHaptic("light");
                      updateSetting("performance", option.key);
                    }}
                    className={`flex-1 rounded-2xl border p-3 ${
                      settings.performance === option.key
                        ? "bg-primary/10 border-primary"
                        : "bg-surface-muted border-slate-100"
                    } active:scale-95`}
                  >
                    <Text
                      className={`font-black text-sm ${
                        settings.performance === option.key
                          ? "text-primary"
                          : "text-on-surface-variant"
                      }`}
                    >
                      {option.label}
                    </Text>
                    <Text
                      className={`text-xs font-bold mt-1 ${
                        settings.performance === option.key
                          ? "text-primary"
                          : "text-on-surface-variant"
                      }`}
                    >
                      {option.fps}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text className="text-[11px] text-on-surface-variant mt-3 font-medium">
                {(PERFORMANCE_PRESETS[settings.performance] || PERFORMANCE_PRESETS.balanced).description}
              </Text>
            </View>

            {/* Scanning Recognition Performance (Interval) */}
            <View className="p-5 border-b border-slate-100">
              <View className="flex-row items-start justify-between mb-1">
                <View className="flex-1 pr-3">
                  <Text className="font-bold text-on-surface text-base">Recognition Scan Interval</Text>
                  <Text className="text-xs text-on-surface-variant mt-1">
                    How frequently face embeddings are extracted to match against class rosters.
                  </Text>
                </View>
                <Text className="text-xs font-black text-primary uppercase">
                  {settings.scanningPerformance || "standard"}
                </Text>
              </View>
              <View className="flex-row gap-2 mt-4">
                {SCANNING_OPTIONS.map((option) => (
                  <Pressable
                    key={option.key}
                    onPress={() => {
                      triggerHaptic("light");
                      updateSetting("scanningPerformance", option.key);
                    }}
                    className={`flex-1 rounded-2xl border p-3 ${
                      settings.scanningPerformance === option.key
                        ? "bg-primary/10 border-primary"
                        : "bg-surface-muted border-slate-100"
                    } active:scale-95`}
                  >
                    <Text
                      className={`font-black text-sm ${
                        settings.scanningPerformance === option.key
                          ? "text-primary"
                          : "text-on-surface-variant"
                      }`}
                    >
                      {option.label}
                    </Text>
                    <Text
                      className={`text-xs font-bold mt-1 ${
                        settings.scanningPerformance === option.key
                          ? "text-primary"
                          : "text-on-surface-variant"
                      }`}
                    >
                      {option.speed}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text className="text-[11px] font-medium text-on-surface-variant mt-3">
                {(SCANNING_PERFORMANCE_PRESETS[settings.scanningPerformance] || SCANNING_PERFORMANCE_PRESETS.standard).description}
              </Text>
              {(SCANNING_PERFORMANCE_PRESETS[settings.scanningPerformance] || SCANNING_PERFORMANCE_PRESETS.standard).warning && (
                <View className="mt-3 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex-row items-center gap-2">
                  <Text className="text-xs font-bold text-amber-700 leading-tight">
                    {(SCANNING_PERFORMANCE_PRESETS[settings.scanningPerformance] || SCANNING_PERFORMANCE_PRESETS.standard).warning}
                  </Text>
                </View>
              )}
            </View>

            {/* Smooth Face Box Motion Toggle */}
            <Pressable
              onPress={() => {
                triggerHaptic("light");
                updateSetting("smoothFaceBox", !settings.smoothFaceBox);
              }}
              className="p-5 flex-row items-center justify-between active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Smooth Box Motion</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Smoothly interpolate the tracking box between frames for a fluid viewfinder preview.
                </Text>
              </View>
              <View
                className={`w-12 h-7 rounded-full p-1 transition-all ${
                  settings.smoothFaceBox ? "bg-primary items-end" : "bg-slate-200 items-start"
                }`}
              >
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>
          </View>
        </View>

        {/* Section 2: Security & Quality Checks */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Security & Quality Gates
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft">
            {/* Strict Enrollment Lighting Check Toggle */}
            <Pressable
              onPress={() => {
                triggerHaptic("light");
                updateSetting("strictLightingCheck", !settings.strictLightingCheck);
              }}
              className="p-5 flex-row items-center justify-between border-b border-slate-100 active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Strict Enrollment Lighting Check</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Block capturing face photos during enrollment when dim light, glare, or backlighting warnings occur.
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.strictLightingCheck ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>

            {/* Passive Anti-Spoofing Toggle */}
            <Pressable
              onPress={() => {
                triggerHaptic("light");
                updateSetting("antiSpoofingEnabled", !settings.antiSpoofingEnabled);
              }}
              className="p-5 flex-row items-center justify-between border-b border-slate-100 active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Passive Anti-Spoofing</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Require passive multi-cue liveness verification before enrollment and attendance recognition.
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.antiSpoofingEnabled ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>

            {/* Anti-spoofing strictness (only when antiSpoofingEnabled is active) */}
            {settings.antiSpoofingEnabled && (
              <View className="p-5">
                <Text className="font-bold text-on-surface text-base mb-1">Liveness Strictness</Text>
                <Text className="text-xs text-on-surface-variant mb-3">
                  Configures the SPRT evidence threshold. All levels require two independent cues to agree.
                </Text>
                <View className="flex-row gap-2">
                  {STRICTNESS_OPTIONS.map((option) => (
                    <Pressable
                      key={option.key}
                      onPress={() => {
                        triggerHaptic("light");
                        updateSetting("livenessStrictness", option.key);
                      }}
                      className={`flex-1 rounded-2xl border p-3 ${
                        settings.livenessStrictness === option.key
                          ? "bg-primary/10 border-primary"
                          : "bg-surface-muted border-slate-100"
                      } active:scale-95`}
                    >
                      <Text
                        className={`font-black text-sm ${
                          settings.livenessStrictness === option.key ? "text-primary" : "text-on-surface-variant"
                        }`}
                      >
                        {LIVENESS_STRICTNESS_PRESETS[option.key].label}
                      </Text>
                      <Text
                        className={`text-xs font-bold mt-1 ${
                          settings.livenessStrictness === option.key ? "text-primary" : "text-on-surface-variant"
                        }`}
                      >
                        {option.hint}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text className="text-[11px] font-medium text-on-surface-variant mt-3">
                  {(LIVENESS_STRICTNESS_PRESETS[settings.livenessStrictness] || LIVENESS_STRICTNESS_PRESETS.balanced).description}
                </Text>
                {(LIVENESS_STRICTNESS_PRESETS[settings.livenessStrictness] || LIVENESS_STRICTNESS_PRESETS.balanced).warning && (
                  <View className="mt-3 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex-row items-center gap-2">
                    <Text className="text-xs font-bold text-amber-700 leading-tight">
                      {(LIVENESS_STRICTNESS_PRESETS[settings.livenessStrictness] || LIVENESS_STRICTNESS_PRESETS.balanced).warning}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        </View>

        {/* Section 3: Hardware & Device Preferences */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Hardware & Device Preferences
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft">
            {/* Camera Selector */}
            <View className="p-5 border-b border-slate-100">
              <Text className="font-bold text-on-surface text-base mb-1">Default Camera</Text>
              <Text className="text-xs text-on-surface-variant mb-3">
                Select which camera lens starts by default on launch.
              </Text>
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

            {/* Haptic Feedback Toggle */}
            <Pressable
              onPress={() => {
                const nextVal = !settings.hapticsEnabled;
                updateSetting("hapticsEnabled", nextVal);
                if (nextVal) {
                  setTimeout(() => triggerHaptic("light"), 100);
                }
              }}
              className="p-5 flex-row items-center justify-between border-b border-slate-100 active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Haptic Feedback</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Vibrate the device on successful scan match, mode toggle, and button presses.
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.hapticsEnabled ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>

            {/* Audio Confirmation Chime Toggle (Off by default) */}
            <Pressable
              onPress={() => {
                const nextVal = !settings.audioChimeEnabled;
                updateSetting("audioChimeEnabled", nextVal);
                if (nextVal) {
                  triggerChime(true);
                }
              }}
              className="p-5 flex-row items-center justify-between active:bg-surface-muted/50"
            >
              <View className="flex-1 pr-4">
                <Text className="font-bold text-on-surface text-base">Attendance Audio Chime</Text>
                <Text className="text-xs text-on-surface-variant mt-1">
                  Play an audio confirmation chime when a student's face is matched and attendance is recorded.
                </Text>
              </View>
              <View className={`w-12 h-7 rounded-full p-1 transition-all ${settings.audioChimeEnabled ? "bg-primary items-end" : "bg-slate-200 items-start"}`}>
                <View className="w-5 h-5 rounded-full bg-white shadow-sm" />
              </View>
            </Pressable>
          </View>
        </View>

        {/* Section 4: Storage & Data (Minimal) */}
        <View className="mb-6">
          <Text className="text-[10px] font-bold text-on-surface-variant mb-3 uppercase tracking-widest pl-1">
            Storage & Data
          </Text>

          <View className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft p-5 gap-4">
            <View>
              <Text className="font-bold text-on-surface text-base">Downloaded Class Packages</Text>
              <Text className="text-xs text-on-surface-variant mt-1">
                {storageLoading
                  ? "Calculating storage..."
                  : storageInfo.count === 0
                  ? "No class packages currently stored on this device."
                  : `${storageInfo.count} class package${storageInfo.count > 1 ? "s" : ""} on device (${storageInfo.formattedSize})`}
              </Text>
            </View>

            <Pressable
              onPress={confirmClearPackages}
              disabled={clearing || storageInfo.count === 0}
              className={`w-full py-3.5 rounded-2xl items-center justify-center flex-row gap-2 border ${
                storageInfo.count === 0
                  ? "bg-surface-muted border-slate-100 opacity-60"
                  : "bg-surface-muted border-slate-200 active:scale-[0.98]"
              } transition-all`}
            >
              <Icon name="delete_sweep" size={18} color={storageInfo.count === 0 ? "#94a3b8" : "#ef4444"} />
              <Text className={`font-bold text-sm ${storageInfo.count === 0 ? "text-on-surface-variant" : "text-error"}`}>
                {clearing ? "Clearing Packages..." : "Clear Downloaded Class Packages"}
              </Text>
            </Pressable>

            {clearSuccess ? (
              <View className="bg-emerald-50 border border-emerald-200 p-3 rounded-2xl flex-row items-center gap-2">
                <Icon name="check_circle" size={16} color="#059669" />
                <Text className="text-emerald-800 font-bold text-xs flex-1">
                  Cached packages cleared. Fresh packages can be downloaded from the Classes tab.
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
