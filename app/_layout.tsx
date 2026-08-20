import "../global.css";
import React, { useEffect } from "react";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { useFonts, Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold } from "@expo-google-fonts/nunito";
import { configureReanimatedLogger, ReanimatedLogLevel } from "react-native-reanimated";

import { AppSettings } from "@/utils/settings";
import { SyncProvider } from "@/utils/SyncProvider";
import { AdminAuthProvider } from "@/utils/AdminAuthProvider";

import { API_URL as CONFIGURED_API_URL } from "@/utils/apiConfig";
const API_URL = CONFIGURED_API_URL;

// Disable Reanimated's strict mode warnings (triggered intentionally by NativeWind v4 styling)
configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Nunito: Nunito_400Regular,
    "Nunito-SemiBold": Nunito_600SemiBold,
    "Nunito-Bold": Nunito_700Bold,
    "Nunito-ExtraBold": Nunito_800ExtraBold,
  });

  useEffect(() => {
    AppSettings.load();
  }, []);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SyncProvider apiUrl={API_URL}>
          <AdminAuthProvider>
            <StatusBar style="dark" />
            <Stack screenOptions={{ headerShown: false }} />
          </AdminAuthProvider>
        </SyncProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
