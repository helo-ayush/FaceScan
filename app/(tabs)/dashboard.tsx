import React, { useState, useCallback, useRef } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { SkeletonBlock } from "@/components/ScreenSkeleton";
import Animated, { FadeInUp, FadeInDown } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";
import { useSyncEngine } from "@/utils/SyncProvider";

export default function DashboardScreen() {
  const router = useRouter();
  const { apiUrl, status: syncStatus } = useSyncEngine();
  const [stats, setStats] = useState({ present: 0, absent: 0 });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const hasLoadedOverview = useRef(false);

  const fetchStats = useCallback(async (showSkeleton = !hasLoadedOverview.current) => {
    if (showSkeleton) setLoadingOverview(true);
    if (syncStatus.isOnline === false) {
      if (showSkeleton) setLoadingOverview(false);
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/api/attendance/logs`);
      const data = await res.json();
      if (res.ok && data.stats) {
        setStats(data.stats);
        setLastUpdatedAt(new Date().toISOString());
      }
    } catch (err) {
      console.warn("Dashboard data is unavailable; showing the last known values.", err);
    } finally {
      hasLoadedOverview.current = true;
      if (showSkeleton) setLoadingOverview(false);
    }
  }, [apiUrl, syncStatus.isOnline]);

  useFocusEffect(
    useCallback(() => {
      void fetchStats();
      // Refresh only while this screen is visible. One minute keeps the
      // overview current without competing with camera inference or battery.
      const interval = setInterval(() => void fetchStats(false), 60_000);
      return () => clearInterval(interval);
    }, [fetchStats, syncStatus.lastSyncAt])
  );

  const formattedDate = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Dashboard" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hello Banner Card */}
        <Animated.View 
          entering={FadeInUp.delay(100).duration(500)}
          className="mb-6 bg-surface border border-slate-100 rounded-3xl p-6 shadow-soft"
        >
          <Text className="text-sm font-semibold uppercase tracking-wider text-primary">
            Welcome Back
          </Text>
          <Text className="text-3xl font-bold text-on-surface tracking-tight mt-1">
            Hello, Admin
          </Text>
          <Text className="text-sm text-on-surface-variant mt-2 font-medium">
            {formattedDate}
          </Text>
          <Text className="text-xs text-on-surface-variant mt-1 font-semibold">
            {syncStatus.isOnline === false
              ? `Offline${lastUpdatedAt ? ` · Last server update ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
              : lastUpdatedAt
              ? `Updated ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'Updating overview…'}
          </Text>
        </Animated.View>

        {/* Overview Section */}
        <Animated.View 
          entering={FadeInUp.delay(200).duration(500)}
          className="mb-8"
        >
          <Text className="text-[11px] font-bold tracking-widest uppercase text-on-surface-variant mb-4">
            Today's Overview
          </Text>
          <View className="flex-row gap-4">
            {/* Present Card */}
            <View className="flex-1 bg-surface border border-slate-100 rounded-3xl p-5 min-h-[150px] justify-between shadow-soft">
              <View className="flex-row justify-between items-start">
                <View className="w-10 h-10 rounded-2xl bg-primary/10 items-center justify-center">
                  <Icon name="how_to_reg" size={22} color="#4f46e5" />
                </View>
              </View>
              <View className="mt-4">
                {loadingOverview ? <SkeletonBlock width={48} height={32} radius={8} /> : <Text className="text-3xl font-black text-on-surface tracking-tight">{stats.present}</Text>}
                <Text className="text-xs font-bold text-on-surface-variant mt-1">Present</Text>
              </View>
            </View>

            {/* Absent Card */}
            <View className="flex-1 bg-surface border border-slate-100 rounded-3xl p-5 min-h-[150px] justify-between shadow-soft">
              <View className="flex-row justify-between items-start">
                <View className="w-10 h-10 rounded-2xl bg-error/10 items-center justify-center">
                  <Icon name="person_off" size={22} color="#ef4444" />
                </View>
              </View>
              <View className="mt-4">
                {loadingOverview ? <SkeletonBlock width={48} height={32} radius={8} /> : <Text className="text-3xl font-black text-on-surface tracking-tight">{stats.absent}</Text>}
                <Text className="text-xs font-bold text-on-surface-variant mt-1">Absent</Text>
              </View>
            </View>
          </View>
        </Animated.View>

        {/* Quick Actions */}
        <Animated.View 
          entering={FadeInUp.delay(300).duration(500)}
          className="mb-6"
        >
          <Text className="text-[11px] font-bold tracking-widest uppercase text-on-surface-variant mb-4">
            Quick Actions
          </Text>

          {/* Launch Scanner Primary Button */}
          <View className="shadow-premium rounded-3xl mb-4 bg-primary">
            <Pressable 
              onPress={() => {
                AppSettings.haptic("light");
                // `dismissTo` rather than `replace`: replacing left the `/login`
                // screen we signed in through sitting underneath the scan screen,
                // so the next back press reopened the password form. This pops
                // everything above `/` instead.
                router.dismissTo("/");
              }}
              className="p-6 flex-row items-center gap-5 active:scale-[0.98] transition-all"
            >
              <View className="w-14 h-14 rounded-2xl bg-white/20 items-center justify-center border border-white/10">
                <Icon name="document_scanner" size={28} color="#ffffff" />
              </View>
              <View className="flex-1">
                <Text className="text-xl font-bold text-on-primary tracking-tight">
                  Launch Scanner
                </Text>
                <Text className="text-xs text-on-primary/80 mt-1 font-medium">
                  Start instant face scan to mark attendance
                </Text>
              </View>
            </Pressable>
          </View>

          {/* Secondary Action Grid */}
          <View className="flex-row gap-4">
            {/* New Student Action */}
            <View className="flex-1 bg-surface border border-slate-100 rounded-3xl shadow-soft">
              <Pressable
                onPress={() => {
                  AppSettings.haptic("light");
                  // `navigate`, not `push` — these are sibling tabs, and pushing a
                  // tab route builds up history the tab bar itself cannot show.
                  router.navigate("/enroll");
                }}
                className="p-5 rounded-3xl gap-3 active:scale-[0.97] transition-all"
              >
                <View className="w-10 h-10 rounded-2xl bg-accent/10 items-center justify-center">
                  <Icon name="person_add" size={20} color="#7c3aed" />
                </View>
                <View>
                  <Text className="font-bold text-on-surface text-base">New Student</Text>
                  <Text className="text-xs font-medium text-on-surface-variant mt-0.5">Enroll now</Text>
                </View>
              </Pressable>
            </View>

            {/* View Logs Action */}
            <View className="flex-1 bg-surface border border-slate-100 rounded-3xl shadow-soft">
              <Pressable
                onPress={() => {
                  AppSettings.haptic("light");
                  router.navigate("/logs");
                }}
                className="p-5 rounded-3xl gap-3 active:scale-[0.97] transition-all"
              >
                <View className="w-10 h-10 rounded-2xl bg-secondary/10 items-center justify-center">
                  <Icon name="history" size={20} color="#6366f1" />
                </View>
                <View>
                  <Text className="font-bold text-on-surface text-base">View Logs</Text>
                  <Text className="text-xs font-medium text-on-surface-variant mt-0.5">Today's records</Text>
                </View>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
