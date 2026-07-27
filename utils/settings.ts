import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

const SETTINGS_KEY = "@face_scanner_settings";

export interface SettingsConfig {
  autoCapture: boolean;
  showGrid: boolean;
  soundFeedback: boolean;
  hapticsEnabled: boolean;
  cameraFacing: "front" | "back";
  sensitivity: "low" | "standard" | "high";
}

export const defaultSettings: SettingsConfig = {
  autoCapture: true,
  showGrid: true,
  soundFeedback: true,
  hapticsEnabled: true,
  cameraFacing: "front",
  sensitivity: "standard",
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
        memorySettings = { ...defaultSettings, ...JSON.parse(stored) };
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
