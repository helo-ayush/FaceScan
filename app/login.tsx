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

import React, { useState, useEffect, useRef } from "react";
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
  const [connectingStatus, setConnectingStatus] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [offlineAccess, setOfflineAccess] = useState(false);
  const { unlockAdmin } = useAdminAuth();

  const apiUrl = API_URL;
  const abortControllerRef = useRef<AbortController | null>(null);

  // Pre-warm backend when login screen opens so Render starts waking up immediately
  useEffect(() => {
    fetch(`${apiUrl}/`).catch(() => {});
  }, [apiUrl]);

  async function handleLogin() {
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setErrorMsg("Please fill in both username and password");
      return;
    }

    setLoading(true);
    setErrorMsg("");
    setConnectingStatus("Authenticating...");

    // Timer updates to keep user informed during Render cold starts
    const wakeTimer1 = setTimeout(() => {
      setConnectingStatus("Connecting to cloud server...");
    }, 2500);

    const wakeTimer2 = setTimeout(() => {
      setConnectingStatus("Waking up cloud server (Render free tier can take ~30s on cold start)...");
    }, 10000);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutTimer = setTimeout(() => {
      controller.abort();
    }, 50000);

    try {
      const response = await fetch(`${apiUrl}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: trimmedUser, password }),
        signal: controller.signal,
      });

      clearTimeout(wakeTimer1);
      clearTimeout(wakeTimer2);
      clearTimeout(timeoutTimer);

      let data: any = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok && data.success) {
        await rememberOfflineAdminCredentials(trimmedUser, password);
        AppSettings.haptic("success");
        unlockAdmin();
        router.replace("/(tabs)/dashboard");
      } else {
        AppSettings.haptic("error");
        setErrorMsg(data.message || "Invalid credentials. Default: admin / admin123");
      }
    } catch (err: any) {
      clearTimeout(wakeTimer1);
      clearTimeout(wakeTimer2);
      clearTimeout(timeoutTimer);

      // 1. Try offline credentials verifier first if available on this device
      const acceptedOffline = await verifyOfflineAdminCredentials(trimmedUser, password);
      if (acceptedOffline) {
        AppSettings.haptic("success");
        setOfflineAccess(true);
        unlockAdmin();
        router.replace("/(tabs)/dashboard");
        return;
      }

      // 2. Offline verification failed or device hasn't stored credentials yet.
      // Differentiate between device network offline vs cloud server timeout / wake-up
      AppSettings.haptic("error");
      console.warn("[LoginScreen] Network request failed:", err);

      setErrorMsg("No internet. If your internet is working, please wait 30 seconds and try again.");
    } finally {
      clearTimeout(wakeTimer1);
      clearTimeout(wakeTimer2);
      clearTimeout(timeoutTimer);
      setLoading(false);
      setConnectingStatus("");
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
        className="bg-surface border border-slate-100 p-6 rounded-3xl gap-6 shadow-sm"
      >
        <View className="items-center mb-2">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mb-3">
            <Icon name="admin_panel_settings" size={32} color="#4f46e5" />
          </View>
          <Text className="text-2xl font-bold text-on-surface tracking-tight">Admin Login</Text>
          <Text className="text-xs text-on-surface-variant mt-1 font-medium text-center">
            Enter your credentials to access the administration panel
          </Text>
        </View>

        {errorMsg ? (
          <View className="bg-error-light border border-error/15 p-3.5 rounded-2xl flex-row items-center gap-3">
            <Icon name="error" size={18} color="#ef4444" />
            <Text className="text-error font-bold text-xs flex-1 leading-4">{errorMsg}</Text>
          </View>
        ) : null}

        {offlineAccess ? (
          <View className="bg-amber-50 border border-amber-200 p-3.5 rounded-2xl flex-row items-center gap-3">
            <Icon name="cloud_off" size={18} color="#b45309" />
            <Text className="text-amber-800 font-bold text-xs flex-1">
              Offline Admin access verified on this device. New changes will sync automatically.
            </Text>
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
            className="py-4 px-3 items-center justify-center active:scale-[0.98] transition-all disabled:opacity-85"
          >
            {loading ? (
              <View className="items-center py-1">
                <ActivityIndicator color="#ffffff" size="small" />
                {connectingStatus ? (
                  <Text className="text-white text-xs font-semibold mt-2 text-center">
                    {connectingStatus}
                  </Text>
                ) : null}
              </View>
            ) : (
              <Text className="text-on-primary font-bold text-base tracking-wide">
                Sign In
              </Text>
            )}
          </Pressable>
        </View>

        <Text className="text-center text-[11px] text-on-surface-variant/70 font-medium">
          Default credentials: <Text className="font-bold text-on-surface-variant">admin</Text> / <Text className="font-bold text-on-surface-variant">admin123</Text>
        </Text>
      </Animated.View>
    </View>
  );
}
