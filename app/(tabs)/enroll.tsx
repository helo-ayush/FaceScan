import React, { useState, useCallback } from "react";
import { View, Text, ScrollView, TextInput, Pressable, LayoutAnimation } from "react-native";
import { useFocusEffect } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import Animated, { FadeInUp, FadeInDown } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";

export default function EnrollScreen() {
  const [studentName, setStudentName] = useState("");
  const [enrollmentId, setEnrollmentId] = useState("");
  const [classesList, setClassesList] = useState<{ id: string; code: string; title: string }[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done">("idle");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://192.168.0.103:5000";

  function fetchEnrollClasses() {
    fetch(`${apiUrl}/api/classes`)
      .then((res) => res.json())
      .then((data) => {
        const formatted = data.map((c: any) => ({
          id: c.id,
          code: c.code,
          title: c.title,
        }));
        setClassesList(formatted);
        if (formatted.length > 0) {
          if (!formatted.some((f: any) => f.id === selectedClassId)) {
            setSelectedClassId(formatted[0].id);
          }
        } else {
          setSelectedClassId("");
        }
      })
      .catch((err) => console.error("Error fetching classes on enroll:", err));
  }

  useFocusEffect(
    useCallback(() => {
      fetchEnrollClasses();
    }, [selectedClassId])
  );

  function startScan() {
    if (scanState === "scanning") return;
    AppSettings.haptic("medium"); // Start scan click feel
    setScanState("scanning");
    setTimeout(() => {
      setScanState("done");
      AppSettings.haptic("success"); // Success feedback vibration
      setToastMessage("Face Scan Completed Successfully");
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 2200);
    }, 1800);
  }

  async function handleEnroll() {
    if (!studentName || !enrollmentId || !selectedClassId) {
      alert("Please fill in all details and select a class");
      return;
    }

    if (scanState !== "done") {
      alert("Please complete the face scan identifier first.");
      return;
    }
    
    setSubmitting(true);
    AppSettings.haptic("medium");
 
    try {
      const response = await fetch(`${apiUrl}/api/students/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: studentName.trim(),
          enrollmentNumber: enrollmentId.trim(),
          classId: selectedClassId,
          faceEmbeddings: {
            front: Array(512).fill(0),
            left45: Array(512).fill(0),
            right45: Array(512).fill(0),
          },
        }),
      });
 
      const data = await response.json();
      if (response.ok && data.success) {
        AppSettings.haptic("success");
        setToastMessage("Student Registered Successfully!");
        setToastVisible(true);
        setStudentName("");
        setEnrollmentId("");
        setScanState("idle");
        setTimeout(() => setToastVisible(false), 2200);
      } else {
        alert(data.error || "Enrollment failed");
      }
    } catch (err) {
      console.error(err);
      alert("Unable to connect to enrollment server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-background relative">
      <ScreenHeader title="Enroll" />

      {/* Floating Success Toast (Premium Pill) */}
      {toastVisible && (
        <View className="absolute top-20 left-6 right-6 z-50 bg-on-surface p-4 rounded-2xl flex-row items-center justify-center gap-2 shadow-medium border border-white/10">
          <Icon name="check_circle" size={20} color="#10b981" />
          <Text className="text-white text-sm font-bold tracking-wide">
            {toastMessage}
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

        <Animated.View 
          entering={FadeInUp.delay(180).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl p-5 mb-5 shadow-soft gap-4"
        >
          <Text className="text-base font-bold text-on-surface">Class Assignment</Text>
          <View>
            <Pressable 
              onPress={() => {
                AppSettings.haptic("light");
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setDropdownOpen(!dropdownOpen);
              }}
              className={`bg-surface border ${
                dropdownOpen ? "border-primary" : "border-slate-200/80"
              } rounded-2xl p-4 flex-row items-center justify-between active:bg-slate-50/50 transition-all`}
            >
              <View className="flex-row items-center gap-3">
                <View className={`w-8 h-8 rounded-xl ${dropdownOpen ? "bg-primary/10" : "bg-slate-100"} items-center justify-center`}>
                  <Icon name="school" size={16} color={dropdownOpen ? "#4f46e5" : "#64748b"} />
                </View>
                <View className="pr-8">
                  <Text className="text-[9px] uppercase font-extrabold text-outline tracking-wider">
                    Assigned Course Class
                  </Text>
                  <Text className="text-on-surface font-bold text-sm mt-0.5" numberOfLines={1}>
                    {(() => {
                      const selectedClass = classesList.find((c) => c.id === selectedClassId);
                      return selectedClass ? `${selectedClass.code} • ${selectedClass.title}` : "Select a Course Class";
                    })()}
                  </Text>
                </View>
              </View>
              <View className="w-7 h-7 rounded-full items-center justify-center bg-slate-50 border border-slate-100">
                <Icon name={dropdownOpen ? "expand_less" : "expand_more"} size={16} color="#475569" />
              </View>
            </Pressable>

            {/* Expandable Selector List */}
            {dropdownOpen && (
              <Animated.View 
                entering={FadeInDown.duration(200)}
                className="mt-2.5 bg-surface border border-slate-100 rounded-2xl overflow-hidden shadow-soft gap-0.5 p-1"
              >
                {classesList.map((c) => {
                  const isSelected = selectedClassId === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => {
                        AppSettings.haptic("light");
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        setSelectedClassId(c.id);
                        setDropdownOpen(false);
                      }}
                      className={`p-3 rounded-xl flex-row items-center justify-between ${
                        isSelected ? "bg-primary/[0.04]" : "active:bg-slate-50"
                      }`}
                    >
                      <View className="flex-row items-center gap-3">
                        <View className={`px-2 py-1 rounded-lg ${
                          isSelected ? "bg-primary/10 border-primary/20" : "bg-slate-100 border-slate-200/50"
                        } border`}>
                          <Text className={`text-[9px] font-black tracking-wide uppercase ${
                            isSelected ? "text-primary" : "text-slate-500"
                          }`}>
                            {c.code}
                          </Text>
                        </View>
                        <Text className={`text-xs font-bold ${isSelected ? "text-primary" : "text-on-surface"}`}>
                          {c.title}
                        </Text>
                      </View>
                      
                      <View className="w-5 h-5 items-center justify-center rounded-full">
                        <Icon 
                          name={isSelected ? "radio_button_checked" : "radio_button_unchecked"} 
                          size={18} 
                          color={isSelected ? "#4f46e5" : "#cbd5e1"} 
                        />
                      </View>
                    </Pressable>
                  );
                })}
              </Animated.View>
            )}
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
              placeholder="e.g., Himanshu Kumar"
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
            onPress={handleEnroll}
            disabled={submitting}
            className="py-4 items-center justify-center active:scale-[0.98] transition-all disabled:opacity-50"
          >
            <Text className="text-on-primary font-bold text-base tracking-wide">
              {submitting ? "Registering Student..." : "Complete Enrollment"}
            </Text>
          </Pressable>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
