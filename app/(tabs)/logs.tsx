import React from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import Animated, { FadeInUp } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";

type LogEntry = {
  name: string;
  id: string;
  course: string;
  time: string;
  status: "present" | "late" | "absent";
};

const LOGS: LogEntry[] = [
  {
    name: "Sarah Jenkins",
    id: "ENR-8492",
    course: "CS101 - Advanced Logic",
    time: "08:52 AM",
    status: "present",
  },
  {
    name: "Marcus Chen",
    id: "ENR-3104",
    course: "PHY301 - Quantum Mech",
    time: "08:55 AM",
    status: "present",
  },
  {
    name: "Elena Rodriguez",
    id: "ENR-9921",
    course: "ENG204 - Literature",
    time: "09:14 AM",
    status: "late",
  },
  {
    name: "David Kim",
    id: "ENR-3310",
    course: "MATH202 - Calculus",
    time: "08:48 AM",
    status: "present",
  },
  {
    name: "Priya Patel",
    id: "ENR-7734",
    course: "CS101 - Advanced Logic",
    time: "—",
    status: "absent",
  },
];

const STATUS_CONFIG = {
  present: { bg: "bg-success-light border-success/15", text: "text-success" },
  late: { bg: "bg-warning-light border-warning/15", text: "text-warning" },
  absent: { bg: "bg-error-light border-error/15", text: "text-error" },
} as const;

export default function LogsScreen() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Logs" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header & Pagination Bubbles */}
        <Animated.View 
          entering={FadeInUp.delay(100).duration(500)}
          className="flex-row justify-between items-center mb-6"
        >
          <View>
            <Text className="text-2xl font-bold text-on-surface tracking-tight">Today's Logs</Text>
            <Text className="text-sm font-semibold text-on-surface-variant mt-0.5">Oct 24, 2023</Text>
          </View>
          <View className="flex-row items-center gap-3">
            <Pressable 
              onPress={() => AppSettings.haptic("light")}
              className="w-10 h-10 rounded-2xl items-center justify-center bg-surface border border-slate-100 active:scale-95 active:bg-surface-container transition-all"
            >
              <Icon name="chevron_left" size={18} color="#0f172a" />
            </Pressable>
            <Pressable 
              onPress={() => AppSettings.haptic("light")}
              className="w-10 h-10 rounded-2xl items-center justify-center bg-surface border border-slate-100 active:scale-95 active:bg-surface-container transition-all"
            >
              <Icon name="chevron_right" size={18} color="#0f172a" />
            </Pressable>
          </View>
        </Animated.View>

        {/* Overview Stats Cards */}
        <Animated.View 
          entering={FadeInUp.delay(180).duration(500)}
          className="flex-row gap-3.5 mb-6"
        >
          <StatCard label="Present" value="248" icon="check_circle" iconColor="#10b981" />
          <StatCard label="Late" value="12" icon="schedule" iconColor="#f59e0b" />
          <StatCard label="Absent" value="4" icon="cancel" iconColor="#ef4444" />
        </Animated.View>

        {/* Log Entries Container */}
        <Animated.View 
          entering={FadeInUp.delay(260).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft"
        >
          {LOGS.map((l, i) => (
            <View
              key={l.id}
              className={`p-4 flex-row items-center justify-between ${
                i < LOGS.length - 1 ? "border-b border-slate-100" : ""
              }`}
            >
              <View className="flex-1 pr-3">
                <Text className="font-bold text-on-surface text-base tracking-tight">{l.name}</Text>
                <Text className="text-xs font-medium text-on-surface-variant mt-0.5" numberOfLines={1}>
                  ID: {l.id} • {l.course}
                </Text>
              </View>
              <View className="items-end gap-1.5">
                <Text className="text-xs font-bold text-on-surface-variant">{l.time}</Text>
                <View className={`px-2.5 py-0.5 rounded-full border ${STATUS_CONFIG[l.status].bg}`}>
                  <Text className={`text-[9px] font-extrabold uppercase tracking-wide ${STATUS_CONFIG[l.status].text}`}>
                    {l.status}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

function StatCard({
  label,
  value,
  icon,
  iconColor,
}: {
  label: string;
  value: string;
  icon: string;
  iconColor: string;
}) {
  return (
    <View className="flex-1 bg-surface border border-slate-100 rounded-3xl p-4 justify-between shadow-sm">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{label}</Text>
        <Icon name={icon} size={16} color={iconColor} />
      </View>
      <Text className="text-2xl font-black text-on-surface tracking-tight">{value}</Text>
    </View>
  );
}
