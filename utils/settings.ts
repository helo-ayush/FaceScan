import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

const SETTINGS_KEY = "@face_scanner_settings";

export type PerformanceMode = "low" | "balanced" | "high";
export type ScanningPerformanceMode = "low" | "standard" | "high";

export const PERFORMANCE_PRESETS: Record<
  PerformanceMode,
  { fps: number; intervalMs: number; label: string; description: string }
> = {
  low: { fps: 5, intervalMs: 200, label: "Low", description: "Lowest battery draw for tracking box (5 FPS)." },
  balanced: { fps: 12, intervalMs: 83, label: "Balanced", description: "Recommended everyday tracking rate (12 FPS)." },
  high: { fps: 24, intervalMs: 42, label: "High", description: "Smoothest tracking box rate (24 FPS)." },
};

export const SCANNING_PERFORMANCE_PRESETS: Record<
  ScanningPerformanceMode,
  { intervalMs: number; label: string; modeName: string; description: string; warning?: string }
> = {
  low: {
    intervalMs: 1000,
    label: "Low (1s)",
    modeName: "Eco Mode",
    description: "Extracts embeddings once every 1 second. Lowest battery & CPU usage.",
  },
  standard: {
    intervalMs: 500,
    label: "Standard (500ms)",
    modeName: "Balanced Mode",
    description: "Extracts embeddings twice per second (500ms). Optimal speed & battery.",
  },
  high: {
    intervalMs: 200,
    label: "High (200ms)",
    modeName: "Fast Mode",
    description: "Extracts embeddings 5 times per second (200ms) for rapid matching.",
    warning: "⚠️ High battery consumption! May cause phone heating or frame drops on lower-end devices.",
  },
};

export interface SettingsConfig {
  autoCapture: boolean;
  showGrid: boolean;
  soundFeedback: boolean;
  hapticsEnabled: boolean;
  cameraFacing: "front" | "back";
  sensitivity: "low" | "standard" | "high";
  performance: PerformanceMode;
  scanningPerformance: ScanningPerformanceMode;
  smoothFaceBox: boolean;
}

export const defaultSettings: SettingsConfig = {
  autoCapture: true,
  showGrid: true,
  soundFeedback: true,
  hapticsEnabled: true,
  cameraFacing: "front",
  sensitivity: "standard",
  performance: "balanced",
  scanningPerformance: "standard",
  smoothFaceBox: true,
};

let memorySettings: SettingsConfig = { ...defaultSettings };

// Listeners list for reactive state updates
const listeners = new Set<() => void>();

export const AppSettings = {
  // Get current settings values synchronously
  get current() {
    return memorySettings;
  },

  // Load settings from storage
  async load(): Promise<SettingsConfig> {
    try {
      const stored = await AsyncStorage.getItem(SETTINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        memorySettings = {
          ...defaultSettings,
          ...parsed,
          performance: PERFORMANCE_PRESETS[parsed?.performance as PerformanceMode]
            ? parsed.performance
            : defaultSettings.performance,
          scanningPerformance: SCANNING_PERFORMANCE_PRESETS[parsed?.scanningPerformance as ScanningPerformanceMode]
            ? parsed.scanningPerformance
            : defaultSettings.scanningPerformance,
          smoothFaceBox: typeof parsed?.smoothFaceBox === "boolean" ? parsed.smoothFaceBox : defaultSettings.smoothFaceBox,
        };
      }
    } catch (e) {
      console.warn("Failed to load settings from storage", e);
    }
    this.notify();
    return memorySettings;
  },

  // Save specific setting
  async set<K extends keyof SettingsConfig>(key: K, value: SettingsConfig[K]) {
    memorySettings[key] = value;
    this.notify();
    try {
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(memorySettings));
    } catch (e) {
      console.warn("Failed to save settings to storage", e);
    }
  },

  // Reset to default
  async reset() {
    memorySettings = { ...defaultSettings };
    this.notify();
    try {
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(memorySettings));
    } catch (e) {
      console.warn("Failed to reset settings", e);
    }
  },

  // Subscribing to updates
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  notify() {
    listeners.forEach((l) => l());
  },

  // Safe wrapper for haptic triggers
  haptic(type: "light" | "medium" | "heavy" | "success" | "error" | "warning" = "light") {
    if (!memorySettings.hapticsEnabled) return;
    try {
      if (type === "success") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else if (type === "error") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else if (type === "warning") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } else if (type === "medium") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else if (type === "heavy") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      } else {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch (e) {
      // Haptics fallback or no-op on web
    }
  },
};

// React hook to access reactive settings values inside UI components
import { useState, useEffect } from "react";

export function useAppSettings() {
  const [settings, setSettings] = useState<SettingsConfig>({ ...memorySettings });

  useEffect(() => {
    // Sync initial state
    setSettings({ ...memorySettings });
    
    // Subscribe to modifications
    const unsubscribe = AppSettings.subscribe(() => {
      setSettings({ ...memorySettings });
    });
    
    return unsubscribe;
  }, []);

  return {
    settings,
    updateSetting: <K extends keyof SettingsConfig>(key: K, value: SettingsConfig[K]) => {
      AppSettings.set(key, value);
    },
    triggerHaptic: (type?: "light" | "medium" | "heavy" | "success" | "error" | "warning") => {
      AppSettings.haptic(type);
    },
  };
}
