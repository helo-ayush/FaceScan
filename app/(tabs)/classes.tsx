import React, { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Modal, TextInput, LayoutAnimation, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
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

export default function ClassesScreen() {
  const [classesList, setClassesList] = useState<ClassItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openStudentId, setOpenStudentId] = useState<string | null>(null);
  const [studentStats, setStudentStats] = useState<{
    [id: string]: { todayStatus: string; totalDaysPresent: number; averageAttendance: number };
  }>({});
  const [loadingStudentStats, setLoadingStudentStats] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    type: "class" | "student";
    id: string;
    name: string;
  } | null>(null);
  const [modalData, setModalData] = useState<{
    type: "class" | "student";
    id: string;
    name: string;
  } | null>(null);
  const [confirmTextInput, setConfirmTextInput] = useState("");

  // Class Creation states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [classNameInput, setClassNameInput] = useState("");
  const [classCodeInput, setClassCodeInput] = useState("");
  const [classIdInput, setClassIdInput] = useState("");
  const [isCreatingClass, setIsCreatingClass] = useState(false);

  useEffect(() => {
    if (confirmDelete) {
      setModalData(confirmDelete);
    }
  }, [confirmDelete]);

  async function handleCreateClass() {
    if (!classNameInput.trim() || !classCodeInput.trim()) return;
    AppSettings.haptic("medium");
    setIsCreatingClass(true);
    try {
      const response = await fetch(`${apiUrl}/api/classes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: classNameInput.trim(),
          code: classCodeInput.trim(),
          classId: classIdInput.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        AppSettings.haptic("success");
        setClassNameInput("");
        setClassCodeInput("");
        setClassIdInput("");
        setShowCreateModal(false);
        fetchClasses();
      } else {
        alert(data.error || "Failed to create class");
      }
    } catch (err) {
      console.error("Connection error creating class:", err);
      alert("Error connecting to backend server");
    } finally {
      setIsCreatingClass(false);
    }
  }
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://192.168.0.103:5000";

  async function toggleStudentExpand(studentId: string) {
    AppSettings.haptic("light");
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (openStudentId === studentId) {
      setOpenStudentId(null);
      return;
    }

    setOpenStudentId(studentId);

    if (studentStats[studentId]) return;

    setLoadingStudentStats(studentId);
    try {
      const response = await fetch(`${apiUrl}/api/students/${studentId}/stats`);
      const data = await response.json();
      if (response.ok && data.success) {
        setStudentStats((prev) => ({
          ...prev,
          [studentId]: data.stats,
        }));
      }
    } catch (err) {
      console.error("Error fetching student stats:", err);
    } finally {
      setLoadingStudentStats(null);
    }
  }

  async function fetchClasses() {
    try {
      const response = await fetch(`${apiUrl}/api/classes`);
      const data = await response.json();
      setClassesList(data);
      if (data.length > 0 && !openId) {
        setOpenId(data[0].id);
      }
    } catch (err) {
      console.error("Error fetching classes:", err);
    }
  }

  useFocusEffect(
    useCallback(() => {
      fetchClasses();
    }, [])
  );

  async function handleDeleteClass(classId: string) {
    AppSettings.haptic("heavy");
    try {
      const response = await fetch(`${apiUrl}/api/classes/${classId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (response.ok && data.success) {
        AppSettings.haptic("success");
        setOpenId(null);
        fetchClasses();
      } else {
        alert(data.message || "Failed to delete class");
      }
    } catch (err) {
      console.error(err);
      alert("Error connecting to server");
    }
  }

  async function handleDeleteStudent(enrollmentNumber: string) {
    AppSettings.haptic("heavy");
    try {
      const response = await fetch(`${apiUrl}/api/students/${enrollmentNumber}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (response.ok && data.success) {
        AppSettings.haptic("success");
        fetchClasses();
      } else {
        alert(data.message || "Failed to delete student");
      }
    } catch (err) {
      console.error(err);
      alert("Error connecting to server");
    }
  }

  function requestDeleteClass(classId: string, className: string) {
    setConfirmTextInput("");
    setConfirmDelete({ type: "class", id: classId, name: className });
  }

  function requestDeleteStudent(enrollmentNumber: string, name: string) {
    setConfirmTextInput("");
    setConfirmDelete({ type: "student", id: enrollmentNumber, name });
  }

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
            onPress={() => {
              AppSettings.haptic("light");
              setShowCreateModal(true);
            }}
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
          {classesList.map((c) => {
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
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
                     <View className="mb-3">
                       <Text className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                         Roster Overview
                       </Text>
                     </View>
                    <View className="gap-2.5">
                      {c.roster.map((r) => {
                        const isOpenStudent = openStudentId === r.id;
                        const stats = studentStats[r.id];
                        const isLoadingStats = loadingStudentStats === r.id;
                        return (
                          <View
                            key={r.id}
                            className={`bg-surface border ${
                              isOpenStudent ? "border-primary/20 bg-primary/[0.01]" : "border-slate-100"
                            } rounded-2xl overflow-hidden`}
                          >
                            {/* Student Row Click Header */}
                            <Pressable
                              onPress={() => toggleStudentExpand(r.id)}
                              className="p-4 flex-row items-center justify-between active:bg-slate-50/50"
                            >
                              <View className="flex-row items-center gap-3">
                                <View className={`w-9 h-9 rounded-full ${
                                  isOpenStudent ? "bg-primary/10 border-primary/20" : "bg-slate-100 border-slate-200/40"
                                } items-center justify-center border`}>
                                  <Text className={`font-bold text-xs ${isOpenStudent ? "text-primary" : "text-slate-600"}`}>
                                    {r.initials}
                                  </Text>
                                </View>
                                <View>
                                  <Text className="font-bold text-on-surface text-sm">
                                    {r.name}
                                  </Text>
                                  <Text className="text-[10px] font-semibold text-outline mt-0.5">
                                    ID: {r.id}
                                  </Text>
                                </View>
                              </View>
                              <View className={`w-7 h-7 items-center justify-center rounded-full border ${
                                isOpenStudent ? "bg-primary/10 border-primary/20" : "bg-slate-50 border-slate-100"
                              }`}>
                                <Icon
                                  name={isOpenStudent ? "expand_less" : "expand_more"}
                                  size={16}
                                  color={isOpenStudent ? "#4f46e5" : "#64748b"}
                                />
                              </View>
                            </Pressable>

                            {/* Dropdown Roster Statistics & Actions */}
                            {isOpenStudent && (
                              <View className="px-4 pb-4 pt-3 border-t border-slate-100/50 bg-slate-50/10">
                                {isLoadingStats && !stats ? (
                                  <View className="py-2 items-center">
                                    <Text className="text-[10px] text-on-surface-variant italic font-semibold">
                                      Fetching statistics...
                                    </Text>
                                  </View>
                                ) : (
                                  <View className="gap-4">
                                    {/* 3-Column Stats Grid */}
                                    <View className="flex-row justify-between items-center bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                                      {/* Today Status Column */}
                                      <View className="items-center flex-1">
                                        <Text className="text-[9px] font-extrabold text-outline uppercase tracking-wider mb-1">
                                          Today
                                        </Text>
                                        <View className={`px-2 py-0.5 rounded-full border ${
                                          stats?.todayStatus === "present"
                                            ? "bg-success-light border-success/15"
                                            : "bg-error-light border-error/15"
                                        }`}>
                                          <Text className={`text-[8px] font-black uppercase tracking-wide ${
                                            stats?.todayStatus === "present" ? "text-success" : "text-error"
                                          }`}>
                                            {stats?.todayStatus || "absent"}
                                          </Text>
                                        </View>
                                      </View>

                                      {/* Divider */}
                                      <View className="w-[1px] h-6 bg-slate-200" />

                                      {/* Present Column */}
                                      <View className="items-center flex-1">
                                        <Text className="text-[9px] font-extrabold text-outline uppercase tracking-wider mb-1">
                                          Present
                                        </Text>
                                        <Text className="text-xs font-black text-on-surface">
                                          {stats?.totalDaysPresent ?? 0} Days
                                        </Text>
                                      </View>

                                      {/* Divider */}
                                      <View className="w-[1px] h-6 bg-slate-200" />

                                      {/* Attendance Rate Column */}
                                      <View className="items-center flex-1">
                                        <Text className="text-[9px] font-extrabold text-outline uppercase tracking-wider mb-1">
                                          Rate
                                        </Text>
                                        <Text className="text-xs font-black text-primary">
                                          {stats?.averageAttendance ?? 0}%
                                        </Text>
                                      </View>
                                    </View>

                                    {/* Action Row */}
                                    <View className="flex-row justify-end border-t border-slate-100/60 pt-3">
                                      <Pressable
                                        onPress={() => requestDeleteStudent(r.id, r.name)}
                                        className="py-2 px-4 rounded-xl bg-error-light border border-error/10 items-center justify-center flex-row gap-1.5 active:scale-95 active:bg-error/10 transition-all"
                                      >
                                        <Icon name="delete" size={13} color="#ef4444" />
                                        <Text className="text-error font-extrabold text-[9px] tracking-wider uppercase">
                                          Remove Student
                                        </Text>
                                      </Pressable>
                                    </View>
                                  </View>
                                )}
                              </View>
                            )}
                          </View>
                        );
                      })}
                    </View>

                    {/* Delete Class Action Button */}
                    <Pressable
                      onPress={() => requestDeleteClass(c.id, c.title)}
                      className="mt-4 w-full py-3.5 rounded-2xl bg-error-light border border-error/15 items-center justify-center flex-row gap-2 active:scale-98 transition-all animate-fade-in"
                    >
                      <Icon name="delete" size={16} color="#ef4444" />
                      <Text className="text-error font-extrabold text-xs tracking-wide">
                        Delete Course Class
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
        </Animated.View>
      </ScrollView>

      {/* Premium Custom Deletion Confirmation Modal Overlay */}
      {confirmDelete !== null && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              zIndex: 9999,
              backgroundColor: "rgba(15, 23, 42, 0.6)",
              justifyContent: "center",
              alignItems: "center",
              paddingHorizontal: 24,
            },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => {
              AppSettings.haptic("light");
              setConfirmDelete(null);
              setConfirmTextInput("");
            }}
          />
          <Animated.View 
            entering={FadeInUp.duration(250)}
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 24,
              padding: 24,
              maxWidth: 340,
              width: "100%",
              borderWidth: 1,
              borderColor: "#f1f5f9",
              alignItems: "center",
              gap: 20,
              elevation: 10,
              shadowColor: "#000",
              shadowOpacity: 0.15,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 10 },
            }}
          >
            {/* Warning Circle Icon */}
            <View className="w-14 h-14 rounded-full bg-error-light border border-error/10 items-center justify-center">
              <Icon name="warning" size={28} color="#ef4444" />
            </View>
 
            {/* Warning Content */}
            <View className="items-center gap-2">
              <Text className="text-xl font-bold text-on-surface text-center">
                Confirm Delete
              </Text>
              <Text className="text-xs text-on-surface-variant font-semibold text-center leading-normal px-2">
                Are you sure you want to delete{" "}
                <Text className="font-extrabold text-on-surface">
                  "{modalData?.name}"
                </Text>
                ? This action is permanent and will clear all related records.
              </Text>
            </View>
 
            {/* Confirmation Selection Buttons */}
            {modalData?.type === "class" && (
              <View className="w-full gap-1.5">
                <Text className="text-[10px] font-extrabold text-on-surface-variant uppercase tracking-widest text-left pl-1">
                  Type "DELETE" to confirm:
                </Text>
                <TextInput
                  value={confirmTextInput}
                  onChangeText={setConfirmTextInput}
                  placeholder='Type "DELETE"'
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="characters"
                  className="w-full bg-slate-50 border border-slate-200 text-on-surface rounded-2xl p-4 text-xs font-bold text-center tracking-widest focus:border-error transition-all"
                />
              </View>
            )}
 
            <View className="flex-row gap-3 w-full mt-2">
              <Pressable
                onPress={() => {
                  AppSettings.haptic("light");
                  setConfirmDelete(null);
                  setConfirmTextInput("");
                }}
                className="flex-1 py-3.5 rounded-2xl bg-surface-muted border border-slate-100 items-center justify-center active:scale-95 transition-all"
              >
                <Text className="text-on-surface-variant font-bold text-sm">
                  Cancel
                </Text>
              </Pressable>
 
              {(() => {
                const isDeleteDisabled = modalData?.type === "class" && confirmTextInput !== "DELETE";
                return (
                  <Pressable
                    onPress={async () => {
                      if (!confirmDelete) return;
                      const { type, id } = confirmDelete;
                      setConfirmDelete(null);
                      setConfirmTextInput("");
                      if (type === "class") {
                        await handleDeleteClass(id);
                      } else {
                        await handleDeleteStudent(id);
                      }
                    }}
                    disabled={isDeleteDisabled}
                    className={`flex-1 py-3.5 rounded-2xl items-center justify-center active:scale-95 transition-all ${
                      isDeleteDisabled ? "bg-slate-100 opacity-60" : "bg-error"
                    }`}
                  >
                    <Text className={`font-bold text-sm ${isDeleteDisabled ? "text-slate-400" : "text-white"}`}>
                      Delete
                    </Text>
                  </Pressable>
                );
              })()}
            </View>
          </Animated.View>
        </View>
      )}

      {/* Create Class Modal Overlay Form */}
      {showCreateModal && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              zIndex: 9999,
              backgroundColor: "rgba(15, 23, 42, 0.6)",
              justifyContent: "center",
              alignItems: "center",
              paddingHorizontal: 24,
            },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => {
              AppSettings.haptic("light");
              setShowCreateModal(false);
            }}
          />
          <Animated.View 
            entering={FadeInUp.duration(250)}
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 24,
              padding: 24,
              maxWidth: 350,
              width: "100%",
              borderWidth: 1,
              borderColor: "#f1f5f9",
              gap: 16,
              elevation: 10,
              shadowColor: "#000",
              shadowOpacity: 0.15,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 10 },
            }}
          >
            {/* Header */}
            <View className="flex-row justify-between items-center mb-1">
              <Text className="text-xl font-bold text-on-surface">
                Create New Class
              </Text>
              <Pressable
                onPress={() => {
                  AppSettings.haptic("light");
                  setShowCreateModal(false);
                }}
                className="w-8 h-8 rounded-full bg-slate-50 items-center justify-center border border-slate-100"
              >
                <Icon name="close" size={16} color="#64748b" />
              </Pressable>
            </View>

            {/* Inputs */}
            <View className="gap-3.5">
              <View className="gap-1.5">
                <Text className="text-[10px] font-bold text-outline uppercase tracking-wider pl-1">
                  Class Title / Name *
                </Text>
                <TextInput
                  value={classNameInput}
                  onChangeText={setClassNameInput}
                  placeholder="e.g. Advanced Mathematics 101"
                  placeholderTextColor="#94a3b8"
                  className="w-full bg-slate-50 border border-slate-200 text-on-surface rounded-2xl p-4 text-xs font-semibold focus:border-primary transition-all"
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-[10px] font-bold text-outline uppercase tracking-wider pl-1">
                  Class Code / Tag *
                </Text>
                <TextInput
                  value={classCodeInput}
                  onChangeText={setClassCodeInput}
                  placeholder="e.g. MATH101"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="characters"
                  className="w-full bg-slate-50 border border-slate-200 text-on-surface rounded-2xl p-4 text-xs font-semibold focus:border-primary transition-all"
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-[10px] font-bold text-outline uppercase tracking-wider pl-1">
                  Custom Class ID (Optional)
                </Text>
                <TextInput
                  value={classIdInput}
                  onChangeText={setClassIdInput}
                  placeholder="e.g. math-spring-26 (auto-gen)"
                  placeholderTextColor="#94a3b8"
                  className="w-full bg-slate-50 border border-slate-200 text-on-surface rounded-2xl p-4 text-xs font-semibold focus:border-primary transition-all"
                />
              </View>
            </View>

            {/* Submit Button */}
            <Pressable
              onPress={handleCreateClass}
              disabled={!classNameInput.trim() || !classCodeInput.trim() || isCreatingClass}
              className={`w-full py-4 rounded-2xl items-center justify-center active:scale-[0.98] transition-all mt-2 ${
                (!classNameInput.trim() || !classCodeInput.trim() || isCreatingClass)
                  ? "bg-slate-100 opacity-60"
                  : "bg-primary"
              }`}
            >
              <Text className={`font-bold text-sm ${
                (!classNameInput.trim() || !classCodeInput.trim() || isCreatingClass)
                  ? "text-slate-400"
                  : "text-white"
              }`}>
                {isCreatingClass ? "Creating Class..." : "Create Course Class"}
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      )}
    </View>
  );
}
