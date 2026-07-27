import React, { useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import Animated, { FadeInUp, FadeInDown } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";

export default function EnrollScreen() {
  const [studentName, setStudentName] = useState("");
  const [enrollmentId, setEnrollmentId] = useState("");
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done">("idle");
  const [toastVisible, setToastVisible] = useState(false);

  function startScan() {
    if (scanState === "scanning") return;
    AppSettings.haptic("medium"); // Start scan click feel
    setScanState("scanning");
    setTimeout(() => {
      setScanState("done");
      setToastVisible(true);
      AppSettings.haptic("success"); // Success feedback vibration
      setTimeout(() => setToastVisible(false), 2200);
      setTimeout(() => setScanState("idle"), 2800);
    }, 1800);
  }

  return (
    <View className="flex-1 bg-background relative">
      <ScreenHeader title="Enroll" />

      {/* Floating Success Toast (Premium Pill) */}
      {toastVisible && (
        <View className="absolute top-20 left-6 right-6 z-50 bg-on-surface p-4 rounded-2xl flex-row items-center justify-center gap-2 shadow-medium border border-white/10">
          <Icon name="check_circle" size={20} color="#10b981" />
          <Text className="text-white text-sm font-bold tracking-wide">
            Face Scan Completed Successfully
          </Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View 
          entering={FadeInUp.delay(100).duration(500)}
          className="mb-6"
        >
          <Text className="text-3xl font-bold text-on-surface tracking-tight">
            New Enrollment
          </Text>
          <Text className="text-sm text-on-surface-variant mt-1 font-medium">
            Register a new student and assign them to a course.
          </Text>
        </Animated.View>

        {/* Class Assignment Selector */}
        <Animated.View 
          entering={FadeInUp.delay(180).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl p-5 mb-5 shadow-soft gap-4"
        >
          <Text className="text-base font-bold text-on-surface">Class Assignment</Text>
          <View>
            <Text className="text-[10px] font-bold text-on-surface-variant mb-2 uppercase tracking-wider">
              Select Class
            </Text>
            <Pressable 
              onPress={() => AppSettings.haptic("light")}
              className="bg-surface-muted border border-slate-100 rounded-2xl p-4 flex-row items-center justify-between active:bg-surface-container transition-all"
            >
              <Text className="text-on-surface font-semibold text-sm">Advanced Mathematics 101</Text>
              <Icon name="expand_more" size={20} color="#475569" />
            </Pressable>
          </View>
        </Animated.View>

        {/* Student Details Card */}
        <Animated.View 
          entering={FadeInUp.delay(260).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl p-5 mb-5 shadow-soft gap-5"
        >
          <Text className="text-base font-bold text-on-surface">Student Details</Text>
          
          <View>
            <Text className="text-[10px] font-bold text-on-surface-variant mb-2 uppercase tracking-wider">
              Student Name
            </Text>
            <TextInput
              value={studentName}
              onChangeText={setStudentName}
              placeholder="e.g., John Doe"
              placeholderTextColor="#94a3b8"
              className="bg-surface-muted border border-slate-100 text-on-surface rounded-2xl p-4 text-sm font-semibold focus:border-primary transition-all"
            />
          </View>

          <View>
            <Text className="text-[10px] font-bold text-on-surface-variant mb-2 uppercase tracking-wider">
              Enrollment Number
            </Text>
            <TextInput
              value={enrollmentId}
              onChangeText={setEnrollmentId}
              placeholder="e.g., ENR-2023-001"
              placeholderTextColor="#94a3b8"
              className="bg-surface-muted border border-slate-100 text-on-surface rounded-2xl p-4 text-sm font-semibold focus:border-primary transition-all"
            />
          </View>
        </Animated.View>

        {/* Face Scanner Card Overhaul */}
        <Animated.View 
          entering={FadeInUp.delay(340).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl p-6 mb-6 items-center shadow-soft"
        >
          <View className="w-24 h-24 rounded-full bg-primary-light border-2 border-primary/20 items-center justify-center mb-4 relative overflow-hidden">
            <Icon
              name={scanState === "done" ? "check" : "face"}
              size={44}
              color="#4f46e5"
            />
            {scanState === "scanning" && (
              <View className="absolute inset-x-0 bottom-0 bg-primary/25 h-1/2 items-center justify-center animate-bounce" />
            )}
          </View>

          <Text className="font-extrabold text-on-surface text-base">Face Identifier Setup</Text>
          <Text className="text-xs text-on-surface-variant mt-1.5 text-center px-4 leading-normal font-medium">
            Align student face in the scanner area and click start scan below.
          </Text>

          {/* Trigger Scan Option Button */}
          <Pressable
            onPress={startScan}
            className={`flex-row items-center border rounded-2xl mt-5 px-5 py-3 ${
              scanState === "scanning"
                ? "bg-slate-50 border-slate-200"
                : scanState === "done"
                ? "bg-success-light border-success/15"
                : "bg-surface-muted border-slate-100 active:bg-slate-200"
            } transition-all active:scale-95`}
          >
            <Icon
              name={
                scanState === "scanning"
                  ? "hourglass_top"
                  : scanState === "done"
                  ? "check_circle"
                  : "center_focus_strong"
              }
              size={18}
              color="#4f46e5"
            />
            <Text className="text-primary font-bold text-sm tracking-wide ml-1">
              {scanState === "scanning"
                ? "Scanning..."
                : scanState === "done"
                ? "Scan Completed"
                : "Start Face Scan"}
            </Text>
          </Pressable>
        </Animated.View>

        {/* Submit Button */}
        <Animated.View 
          entering={FadeInUp.delay(420).duration(500)}
          className="shadow-premium rounded-2xl bg-primary"
        >
          <Pressable 
            onPress={() => AppSettings.haptic("success")}
            className="py-4 items-center justify-center active:scale-[0.98] transition-all"
          >
            <Text className="text-on-primary font-bold text-base tracking-wide">
              Complete Enrollment
            </Text>
          </Pressable>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
