import React, { useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import Animated, { FadeInUp } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";

type ClassItem = {
  id: string;
  code: string;
  title: string;
  students: number;
  attendance: number;
  roster: { initials: string; name: string; id: string }[];
};

const CLASSES: ClassItem[] = [
  {
    id: "cs101",
    code: "CS-101",
    title: "Intro to Computer Science",
    students: 32,
    attendance: 94,
    roster: [
      { initials: "AJ", name: "Alice Johnson", id: "98234" },
      { initials: "BS", name: "Bob Smith", id: "98235" },
    ],
  },
  {
    id: "math202",
    code: "MATH-202",
    title: "Advanced Calculus",
    students: 24,
    attendance: 82,
    roster: [{ initials: "DP", name: "Diana Prince", id: "44321" }],
  },
  {
    id: "phy301",
    code: "PHY-301",
    title: "Quantum Mechanics",
    students: 18,
    attendance: 98,
    roster: [{ initials: "FG", name: "Fiona Gallagher", id: "77654" }],
  },
];

export default function ClassesScreen() {
  const [openId, setOpenId] = useState<string | null>("math202");

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Classes" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Create New Class Primary Card */}
        <Animated.View 
          entering={FadeInUp.delay(100).duration(500)}
          className="shadow-premium rounded-3xl mb-6 bg-primary"
        >
          <Pressable 
            onPress={() => AppSettings.haptic("light")}
            className="p-6 flex-row items-center justify-between active:scale-[0.98] transition-all"
          >
            <View>
              <View className="w-12 h-12 rounded-2xl bg-white/20 items-center justify-center border border-white/10 mb-4">
                <Icon name="add_circle" size={24} color="#ffffff" />
              </View>
              <Text className="text-xl font-bold text-on-primary tracking-tight">
                Create New Class
              </Text>
              <Text className="text-xs text-on-primary/80 mt-1 font-medium">
                Setup a new course and enroll students
              </Text>
            </View>
            <Icon name="arrow_forward" size={20} color="rgba(255, 255, 255, 0.8)" />
          </Pressable>
        </Animated.View>

        {/* Classes Accordion List */}
        <Animated.View 
          entering={FadeInUp.delay(200).duration(500)}
          className="gap-5"
        >
          {CLASSES.map((c) => {
            const open = openId === c.id;
            const attColor =
              c.attendance >= 90
                ? "text-primary"
                : c.attendance >= 85
                ? "text-warning"
                : "text-error";

            const attBg =
              c.attendance >= 90
                ? "bg-primary/10"
                : c.attendance >= 85
                ? "bg-warning/10"
                : "bg-error/10";

            return (
              <View
                key={c.id}
                className="bg-surface border border-slate-100 rounded-3xl overflow-hidden shadow-soft"
              >
                <Pressable
                  className="p-5 flex-row items-start justify-between active:bg-slate-50/50"
                  onPress={() => {
                    AppSettings.haptic("light");
                    setOpenId(open ? null : c.id);
                  }}
                >
                  <View className="flex-1 pr-4">
                    <View className="self-start px-2.5 py-1 rounded-xl bg-surface-container mb-2">
                      <Text className="text-on-surface-variant text-[10px] font-extrabold uppercase tracking-widest">
                        {c.code}
                      </Text>
                    </View>
                    <Text className="text-lg font-bold text-on-surface leading-snug">
                      {c.title}
                    </Text>
                  </View>

                  <View className="items-end gap-3">
                    <View className="flex-row items-center gap-4">
                      {/* Students count */}
                      <View className="items-center">
                        <Text className="text-lg font-black text-on-surface">
                          {c.students}
                        </Text>
                        <Text className="text-[9px] uppercase font-bold text-outline tracking-wider">
                          Students
                        </Text>
                      </View>
                      {/* Attendance percent */}
                      <View className="items-center">
                        <Text className={`text-lg font-black ${attColor}`}>
                          {c.attendance}%
                        </Text>
                        <Text className="text-[9px] uppercase font-bold text-outline tracking-wider">
                          Attend
                        </Text>
                      </View>
                    </View>

                    {/* Chevron Indicator */}
                    <View className="w-8 h-8 rounded-full bg-surface-container items-center justify-center border border-slate-100/50">
                      <Icon
                        name={open ? "expand_less" : "expand_more"}
                        size={18}
                        color="#475569"
                      />
                    </View>
                  </View>
                </Pressable>

                {open && (
                  <View className="px-5 pb-5 pt-3 border-t border-slate-100 bg-surface-muted">
                    <View className="flex-row justify-between items-center mb-3">
                      <Text className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                        Roster Overview
                      </Text>
                      <Pressable>
                        <Text className="text-xs text-primary font-bold">
                          View Full Roster
                        </Text>
                      </Pressable>
                    </View>
                    <View className="gap-2.5">
                      {c.roster.map((r) => (
                        <View
                          key={r.id}
                          className="flex-row items-center justify-between p-3.5 rounded-2xl bg-surface border border-slate-100 shadow-sm"
                        >
                          <View className="flex-row items-center gap-3">
                            <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center border border-primary/10">
                              <Text className="font-bold text-primary text-xs">
                                {r.initials}
                              </Text>
                            </View>
                            <Text className="font-bold text-on-surface text-sm">
                              {r.name}
                            </Text>
                          </View>
                          <Text className="text-xs font-semibold text-outline">
                            ID: {r.id}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </Animated.View>
      </ScrollView>
    </View>
  );
}
