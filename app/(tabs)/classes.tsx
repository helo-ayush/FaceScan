import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, ScrollView, Pressable, Modal, TextInput, LayoutAnimation, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { SkeletonBlock } from "@/components/ScreenSkeleton";
import Animated, { FadeInUp } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";
import {
  downloadClassPackage,
  getDownloadedClasses,
  removeStudentFromClassPackage,
  type DownloadedClassInfo,
} from "@/utils/classPackageStore";
import {
  getCachedClasses,
  recordOfflineStudentDeletion,
  getDeletedEnrollmentNumbers,
  markStudentDeletionSynced,
} from "@/utils/localDb";
import { useSyncEngine } from "@/utils/SyncProvider";

import { API_URL } from "@/utils/apiConfig";
type ClassItem = {
  id: string;
  code: string;
  title: string;
  students: number;
  attendance: number;
  roster: { initials: string; name: string; id: string }[];
};

export default function ClassesScreen() {
  const { triggerSync } = useSyncEngine();
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
  const [downloadingClassId, setDownloadingClassId] = useState<string | null>(null);
  const [downloadedClasses, setDownloadedClasses] = useState<DownloadedClassInfo[]>([]);
  const [downloadResult, setDownloadResult] = useState<{ classId: string; message: string; success: boolean } | null>(null);
  const [isCreatingClass, setIsCreatingClass] = useState(false);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const hasLoadedClasses = useRef(false);
  const apiUrl = API_URL;

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
    const showSkeleton = !hasLoadedClasses.current;
    if (showSkeleton) setLoadingClasses(true);

    const deleted = await getDeletedEnrollmentNumbers();

    // 1. Load from local cache first (instant, works offline)
    try {
      const cached = await getCachedClasses();
      if (cached.length > 0) {
        setClassesList((prev) =>
          prev.length === 0
            ? cached.map((c) => ({
                id: c.class_id,
                code: c.code,
                title: c.title,
                students: 0,
                attendance: 0,
                roster: [],
              }))
            : prev
        );
        if (!openId) {
          setOpenId(cached[0].class_id);
        }
        hasLoadedClasses.current = true;
        if (showSkeleton) setLoadingClasses(false);
      }
    } catch {
      // Ignore local cache error
    }

    // 2. Try network fetch from server
    try {
      const response = await fetch(`${apiUrl}/api/classes`);
      const data = await response.json();
      if (response.ok && Array.isArray(data)) {
        const filteredData = data.map((c: any) => ({
          ...c,
          students: c.roster ? c.roster.filter((r: any) => !deleted.has(r.id)).length : 0,
          roster: c.roster ? c.roster.filter((r: any) => !deleted.has(r.id)) : [],
        }));
        setClassesList(filteredData);
        if (filteredData.length > 0 && !openId) {
          setOpenId(filteredData[0].id);
        }
      }
    } catch (err) {
      console.warn("Network fetch for classes failed (offline mode):", err);
    } finally {
      hasLoadedClasses.current = true;
      if (showSkeleton) setLoadingClasses(false);
    }
  }

  async function loadDownloadedClasses() {
    try {
      const classes = await getDownloadedClasses();
      setDownloadedClasses(classes);
    } catch (err) {
      console.warn('Failed to load downloaded classes:', err);
    }
  }

  useFocusEffect(
    useCallback(() => {
      fetchClasses();
      loadDownloadedClasses();
    }, [])
  );

  async function handleDownloadPackage(classId: string) {
    AppSettings.haptic('medium');
    setDownloadingClassId(classId);
    setDownloadResult(null);
    try {
      const manifest = await downloadClassPackage(apiUrl, classId);
      setDownloadResult({
        classId,
        message: `Downloaded ${manifest.students.length} students`,
        success: true,
      });
      AppSettings.haptic('success');
      await loadDownloadedClasses();
    } catch (err: any) {
      setDownloadResult({
        classId,
        message: err?.message || 'Download failed',
        success: false,
      });
      AppSettings.haptic('heavy');
    } finally {
      setDownloadingClassId(null);
      setTimeout(() => setDownloadResult(null), 4000);
    }
  }

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

    // Find classId for this student
    const parentClass = classesList.find((c) =>
      c.roster.some((r) => r.id === enrollmentNumber)
    );
    const classId = parentClass?.id || "";

    // 1. Immediately record offline deletion and purge local pending records
    await recordOfflineStudentDeletion(enrollmentNumber, classId);

    // 2. Immediately remove from downloaded on-disk package if present
    if (classId) {
      await removeStudentFromClassPackage(classId, enrollmentNumber);
    }

    // 3. Immediately update UI state
    setClassesList((prev) =>
      prev.map((c) => ({
        ...c,
        students: c.roster.filter((r) => r.id !== enrollmentNumber).length,
        roster: c.roster.filter((r) => r.id !== enrollmentNumber),
      }))
    );
    AppSettings.haptic("success");

    // 4. Trigger sync engine to push to server if online
    triggerSync();

    // 5. Also attempt direct API delete in the background
    try {
      const response = await fetch(`${apiUrl}/api/students/${encodeURIComponent(enrollmentNumber)}`, {
        method: "DELETE",
      });
      if (response.ok || response.status === 404) {
        await markStudentDeletionSynced(enrollmentNumber);
      }
    } catch (err) {
      // Offline: deletion is safely queued in SQLite pending_student_deletions
      console.log("Offline student deletion queued locally:", enrollmentNumber);
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
          {loadingClasses ? (
            <View className="gap-5">
              {[0, 1, 2].map((item) => (
                <View key={item} className="bg-surface border border-slate-100 rounded-3xl p-5">
                  <View className="flex-row justify-between"><SkeletonBlock width="48%" height={18} radius={8} /><SkeletonBlock width={56} height={24} radius={12} /></View>
                  <View className="mt-4"><SkeletonBlock height={12} radius={6} /></View>
                  <View className="mt-2"><SkeletonBlock width="68%" height={12} radius={6} /></View>
                </View>
              ))}
            </View>
          ) : classesList.map((c) => {
            const open = openId === c.id;
            const attColor =
              c.attendance >= 90
                ? "text-primary"
                : c.attendance >= 85
                ? "text-warning"
                : "text-error";

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

                    {/* Download Embeddings Button */}
                    <Pressable
                      onPress={() => handleDownloadPackage(c.id)}
                      disabled={downloadingClassId === c.id}
                      className="mt-4 w-full py-3.5 rounded-2xl bg-indigo-50 border border-indigo-200 items-center justify-center flex-row gap-2 active:scale-98 transition-all"
                      style={{ opacity: downloadingClassId === c.id ? 0.6 : 1 }}
                    >
                      <Icon name="download" size={16} color="#5d5fef" />
                      <Text className="text-primary font-extrabold text-xs tracking-wide">
                        {downloadingClassId === c.id
                          ? 'Downloading...'
                          : (() => {
                              const info = downloadedClasses.find((d) => d.classId === c.id);
                              if (info) {
                                const mins = Math.floor((Date.now() - new Date(info.downloadedAt).getTime()) / 60000);
                                if (mins < 1) return `Re-download (just now)`;
                                if (mins < 60) return `Re-download (${mins}m ago)`;
                                const hrs = Math.floor(mins / 60);
                                if (hrs < 24) return `Re-download (${hrs}h ago)`;
                                return `Re-download (${Math.floor(hrs / 24)}d ago)`;
                              }
                              return 'Download Embeddings for Offline';
                            })()}
                      </Text>
                    </Pressable>
                    {downloadResult && downloadResult.classId === c.id && (
                      <View className={`mt-2 px-4 py-2 rounded-xl ${downloadResult.success ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
                        <Text className={`text-xs font-bold ${downloadResult.success ? 'text-emerald-700' : 'text-red-700'}`}>
                          {downloadResult.message}
                        </Text>
                      </View>
                    )}

                    {/* Delete Class Action Button */}
                    <Pressable
                      onPress={() => requestDeleteClass(c.id, c.title)}
                      className="mt-3 w-full py-3.5 rounded-2xl bg-error-light border border-error/15 items-center justify-center flex-row gap-2 active:scale-98 transition-all animate-fade-in"
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
