/**
 * Admin Authentication Screen.
 *
 * Implements dual-mode credentials authentication:
 * 1. Online: Authenticates with backend `/api/login` and updates the offline
 *    salted SHA-256 verifier in device SecureStore.
 * 2. Offline Fallback: If network/server is unreachable, verifies credentials
 *    locally against the device's encrypted verifier.
 *
 * On success, unlocks the admin session in `AdminAuthProvider` and redirects
 * to `/(tabs)/dashboard`.
 */

import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import Animated, { FadeInUp, FadeInDown } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";
import { useAdminAuth } from "@/utils/AdminAuthProvider";
import { rememberOfflineAdminCredentials, verifyOfflineAdminCredentials } from "@/utils/adminAuth";

import { API_URL } from "@/utils/apiConfig";
export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [offlineAccess, setOfflineAccess] = useState(false);
  const { unlockAdmin } = useAdminAuth();

  const apiUrl = API_URL;

  async function handleLogin() {
    if (!username || !password) {
      setErrorMsg("Please fill in all fields");
      return;
    }

    setLoading(true);
    setErrorMsg("");

    try {
      const response = await fetch(`${apiUrl}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        await rememberOfflineAdminCredentials(username, password);
        AppSettings.haptic("success");
        unlockAdmin();
        // Auth success, push to admin dashboard tabs
        router.replace("/(tabs)/dashboard");
      } else {
        AppSettings.haptic("error");
        setErrorMsg(data.message || "Invalid credentials");
      }
    } catch (err) {
      const acceptedOffline = await verifyOfflineAdminCredentials(username, password);
      if (acceptedOffline) {
        AppSettings.haptic("success");
        setOfflineAccess(true);
        unlockAdmin();
        router.replace("/(tabs)/dashboard");
      } else {
        AppSettings.haptic("error");
        console.error(err);
        setErrorMsg("Offline access is available only after a successful online login on this device.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <View className="flex-1 bg-background justify-center px-6">
      {/* Header back button */}
      <Animated.View 
        entering={FadeInDown.duration(400)}
        style={{ paddingTop: Math.max(insets.top, 16) }} 
        className="absolute top-0 left-0 right-0 z-50"
      >
        <View className="h-16 px-6 flex-row items-center">
          <Pressable
            onPress={() => {
              AppSettings.haptic("light");
              router.back();
            }}
            className="w-10 h-10 items-center justify-center rounded-full bg-surface border border-slate-100 active:scale-95 transition-all"
          >
            <Icon name="arrow_back" size={20} color="#0f172a" />
          </Pressable>
        </View>
      </Animated.View>

      {/* Main card */}
      <Animated.View 
        entering={FadeInUp.duration(550)}
        className="bg-surface border border-slate-100 p-6 rounded-3xl gap-6"
      >
        <View className="items-center mb-2">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mb-3">
            <Icon name="admin_panel_settings" size={32} color="#4f46e5" />
          </View>
          <Text className="text-2xl font-bold text-on-surface tracking-tight">Admin Login</Text>
          <Text className="text-xs text-on-surface-variant mt-1 font-medium text-center">
            Enter your credentials every time you open the administration panel
          </Text>
        </View>

        {errorMsg ? (
          <View className="bg-error-light border border-error/15 p-3.5 rounded-2xl flex-row items-center gap-3">
            <Icon name="error" size={18} color="#ef4444" />
            <Text className="text-error font-bold text-xs flex-1">{errorMsg}</Text>
          </View>
        ) : null}

        {offlineAccess ? (
          <View className="bg-amber-50 border border-amber-200 p-3.5 rounded-2xl flex-row items-center gap-3">
            <Icon name="cloud_off" size={18} color="#b45309" />
            <Text className="text-amber-800 font-bold text-xs flex-1">Offline Admin access verified on this device. New changes will sync automatically.</Text>
          </View>
        ) : null}

        <View className="gap-4">
          <View>
            <Text className="text-[10px] font-bold text-on-surface-variant mb-2 uppercase tracking-wider">
              Username
            </Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder="Enter admin username"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
              className="bg-surface-muted border border-slate-100 text-on-surface rounded-2xl p-4 text-sm font-semibold focus:border-primary transition-all"
            />
          </View>

          <View>
            <Text className="text-[10px] font-bold text-on-surface-variant mb-2 uppercase tracking-wider">
              Password
            </Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Enter admin password"
              placeholderTextColor="#94a3b8"
              secureTextEntry
              autoCapitalize="none"
              className="bg-surface-muted border border-slate-100 text-on-surface rounded-2xl p-4 text-sm font-semibold focus:border-primary transition-all"
            />
          </View>
        </View>

        <View className="shadow-medium rounded-2xl bg-primary">
          <Pressable
            onPress={() => {
              AppSettings.haptic("light");
              handleLogin();
            }}
            disabled={loading}
            className="py-4 items-center justify-center active:scale-[0.98] transition-all disabled:opacity-75"
          >
            {loading ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <Text className="text-on-primary font-bold text-base tracking-wide">
                Sign In
              </Text>
            )}
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
