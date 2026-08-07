import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, ScrollView, Pressable, Modal, LayoutAnimation, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import Animated, { FadeInUp, FadeInDown, SlideInDown, SlideOutDown } from "react-native-reanimated";
import { AppSettings } from "@/utils/settings";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type LogEntry = {
  name: string;
  id: string;
  course: string;
  time: string;
  /** Raw DB instant, ISO string. When present, `time` (server-UTC-formatted)
   *  is ignored and the time is formatted on THIS device instead — the server
   *  runs in UTC on Render, which made every log read 5.5h behind for IST. */
  timestamp?: string;
  status: "present" | "absent";
  date?: string;
};

const STATUS_CONFIG = {
  present: { bg: "bg-success-light border-success/15", text: "text-success" },
  absent: { bg: "bg-error-light border-error/15", text: "text-error" },
} as const;

/**
 * Formats a log's time in the PHONE's timezone.
 *
 * The server used to format this string itself, but Node's
 * `toLocaleTimeString` uses the *server's* zone — UTC on Render — so a scan at
 * 6:30 PM IST displayed as 01:00 PM. The API now also returns the raw
 * `timestamp`; prefer it and fall back to the legacy string only for rows
 * served by an older backend.
 */
function formatLogTime(log: LogEntry): string {
  if (!log.timestamp) return log.time;
  const at = new Date(log.timestamp);
  if (Number.isNaN(at.getTime())) return log.time;
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function LogsScreen() {
  const [logsList, setLogsList] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState({ present: 0, absent: 0 });
  const [selectedDate, setSelectedDate] = useState(new Date());
  
  // Date Range states
  const [filterMode, setFilterMode] = useState<"day" | "range">("day");
  const [selectedStartDate, setSelectedStartDate] = useState(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  const [selectedEndDate, setSelectedEndDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState<"start" | "end" | "day" | null>(null);
  const [viewDate, setViewDate] = useState(new Date());
  const [pickerStep, setPickerStep] = useState<"year" | "month" | "day">("day");
  
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://192.168.0.103:5000";

  /** YYYY-MM-DD from the phone's local calendar, never UTC. */
  function localDateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function fetchLogs(dateObj: Date, mode: "day" | "range", start: Date, end: Date) {
    setLoadingLogs(true);
    let url = "";
    if (mode === "day") {
      url = `${apiUrl}/api/attendance/logs?date=${localDateStr(dateObj)}`;
    } else {
      url = `${apiUrl}/api/attendance/logs?startDate=${localDateStr(start)}&endDate=${localDateStr(end)}`;
    }

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data.logs) {
          setLogsList(data.logs);
        }
        if (data.stats) {
          setStats(data.stats);
        }
      })
      .catch((err) => console.error("Error fetching logs:", err))
      .finally(() => setLoadingLogs(false));
  }

  useFocusEffect(
    useCallback(() => {
      fetchLogs(selectedDate, filterMode, selectedStartDate, selectedEndDate);
    }, [selectedDate, filterMode, selectedStartDate, selectedEndDate])
  );

  function selectDate(d: Date) {
    AppSettings.haptic("success");
    if (showDatePicker === "start") {
      setSelectedStartDate(d);
      if (d > selectedEndDate) {
        setSelectedEndDate(d);
      }
    } else {
      setSelectedEndDate(d);
      if (d < selectedStartDate) {
        setSelectedStartDate(d);
      }
    }
    setShowDatePicker(null);
  }

  function handlePrevDay() {
    AppSettings.haptic("light");
    const prev = new Date(selectedDate);
    prev.setDate(prev.getDate() - 1);
    setSelectedDate(prev);
  }

  function handleNextDay() {
    if (isTodayOrFuture) return;
    AppSettings.haptic("light");
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 1);
    setSelectedDate(next);
  }

  const isTodayOrFuture = selectedDate.toDateString() === new Date().toDateString() || selectedDate > new Date();
  const isToday = selectedDate.toDateString() === new Date().toDateString();
  const formattedTitle = filterMode === "day" ? (isToday ? "Today's Logs" : "Logs Overview") : "Range Logs Report";
  const formattedDate = selectedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const last30Days = Array.from({ length: 30 }, (_, index) => {
    const d = new Date();
    d.setDate(d.getDate() - index);
    return d;
  });

  const handleScroll = (event: any) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setShowScrollTop(offsetY > 200);
  };

  return (
    <View className="flex-1 bg-background relative">
      <ScreenHeader title="Logs" />
      <ScrollView
        ref={scrollViewRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Filter Mode Segmented Tabs */}
        <Animated.View 
          entering={FadeInUp.delay(50).duration(500)}
          className="flex-row bg-slate-100 p-1 rounded-2xl mb-6 border border-slate-200/20"
        >
          <Pressable
            onPress={() => {
              AppSettings.haptic("light");
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setFilterMode("day");
            }}
            className={`flex-1 py-2.5 rounded-xl items-center justify-center ${
              filterMode === "day" ? "bg-white border border-slate-200/60" : "active:bg-slate-200/50"
            }`}
          >
            <Text className={`text-xs font-extrabold ${filterMode === "day" ? "text-primary" : "text-slate-500"}`}>
              Single Day
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              AppSettings.haptic("light");
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setFilterMode("range");
            }}
            className={`flex-1 py-2.5 rounded-xl items-center justify-center ${
              filterMode === "range" ? "bg-white border border-slate-200/60" : "active:bg-slate-200/50"
            }`}
          >
            <Text className={`text-xs font-extrabold ${filterMode === "range" ? "text-primary" : "text-slate-500"}`}>
              Date Range
            </Text>
          </Pressable>
        </Animated.View>

        {/* Header & Pagination Bubbles (Only in Single Day Mode) */}
        {filterMode === "day" ? (
          <Animated.View 
            entering={FadeInUp.delay(100).duration(500)}
            className="flex-row justify-between items-center mb-6"
          >
            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                setViewDate(new Date(selectedDate));
                setPickerStep("year");
                setShowDatePicker("day");
              }}
              className="active:opacity-75"
            >
              <Text className="text-2xl font-bold text-on-surface tracking-tight">{formattedTitle}</Text>
              <View className="flex-row items-center gap-1 mt-0.5">
                <Text className="text-sm font-semibold text-primary">{formattedDate}</Text>
                <Icon name="edit" size={12} color="#4f46e5" />
              </View>
            </Pressable>
            <View className="flex-row items-center gap-3">
              <Pressable 
                onPress={handlePrevDay}
                className="w-10 h-10 rounded-2xl items-center justify-center bg-surface border border-slate-100 active:scale-95 active:bg-surface-container transition-all"
              >
                <Icon name="chevron_left" size={18} color="#0f172a" />
              </Pressable>
              <Pressable 
                onPress={handleNextDay}
                disabled={isTodayOrFuture}
                className={`w-10 h-10 rounded-2xl items-center justify-center bg-surface border border-slate-100 active:scale-95 active:bg-surface-container transition-all ${
                  isTodayOrFuture ? "opacity-35" : ""
                }`}
              >
                <Icon name="chevron_right" size={18} color={isTodayOrFuture ? "#94a3b8" : "#0f172a"} />
              </Pressable>
            </View>
          </Animated.View>
        ) : (
          /* Date Range Dual Card Selectors */
          <Animated.View 
            entering={FadeInUp.delay(100).duration(500)}
            className="flex-row items-center gap-3 mb-6 bg-surface border border-slate-100 rounded-3xl p-4"
          >
            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                setViewDate(new Date(selectedStartDate));
                setPickerStep("year");
                setShowDatePicker("start");
              }}
              className="flex-1 bg-slate-50/50 border border-slate-200/50 rounded-2xl p-3 items-center justify-center active:bg-slate-100"
            >
              <Text className="text-[9px] uppercase font-extrabold text-outline tracking-wider">Start Date</Text>
              <Text className="text-xs font-extrabold text-on-surface mt-1">
                {selectedStartDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </Text>
            </Pressable>

            <Icon name="arrow_forward" size={16} color="#64748b" />

            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                setViewDate(new Date(selectedEndDate));
                setPickerStep("year");
                setShowDatePicker("end");
              }}
              className="flex-1 bg-slate-50/50 border border-slate-200/50 rounded-2xl p-3 items-center justify-center active:bg-slate-100"
            >
              <Text className="text-[9px] uppercase font-extrabold text-outline tracking-wider">End Date</Text>
              <Text className="text-xs font-extrabold text-on-surface mt-1">
                {selectedEndDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </Text>
            </Pressable>
          </Animated.View>
        )}

        {/* Overview Stats Cards */}
        <Animated.View 
          entering={FadeInUp.delay(180).duration(500)}
          className="flex-row gap-3.5 mb-6"
        >
          <StatCard label="Present" value={stats.present.toString()} icon="check_circle" iconColor="#10b981" />
          <StatCard label="Absent" value={stats.absent.toString()} icon="cancel" iconColor="#ef4444" />
        </Animated.View>

        {/* Log Entries Container */}
        <Animated.View 
          entering={FadeInUp.delay(260).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl overflow-hidden"
        >
          {loadingLogs ? (
            <View>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : logsList.length === 0 ? (
            <View className="p-8 items-center justify-center">
              <Text className="text-on-surface-variant font-bold text-sm">
                {isToday ? "No attendance records logged today." : "No attendance records logged for this day."}
              </Text>
            </View>
          ) : (
            logsList.map((l, i) => (
              <View
                key={`${l.id}-${i}`}
                className={`p-4 flex-row items-center justify-between ${
                  i < logsList.length - 1 ? "border-b border-slate-100" : ""
                }`}
              >
                <View className="flex-1 pr-3">
                  <Text className="font-bold text-on-surface text-base tracking-tight">{l.name}</Text>
                  <Text className="text-xs font-semibold text-on-surface-variant mt-0.5" numberOfLines={2}>
                    ID: {l.id} • {l.course} {filterMode === "range" && `• ${l.date}`}
                  </Text>
                </View>
                <View className="items-end gap-1.5">
                  <Text className="text-xs font-bold text-on-surface-variant">{formatLogTime(l)}</Text>
                  <View className={`px-2.5 py-0.5 rounded-full border ${STATUS_CONFIG[l.status]?.bg || "bg-slate-100"}`}>
                    <Text className={`text-[9px] font-extrabold uppercase tracking-wide ${STATUS_CONFIG[l.status]?.text || "text-slate-500"}`}>
                      {l.status}
                    </Text>
                  </View>
                </View>
              </View>
            ))
          )}
        </Animated.View>
      </ScrollView>

      {/* Floating Scroll-to-Top Action Button (FAB) */}
      {showScrollTop && (
        <Animated.View 
          entering={FadeInDown.duration(200)}
          className="absolute bottom-6 right-6 z-50 shadow-premium rounded-full"
        >
          <Pressable
            onPress={() => {
              AppSettings.haptic("light");
              scrollViewRef.current?.scrollTo({ y: 0, animated: true });
            }}
            className="w-12 h-12 rounded-full bg-primary items-center justify-center active:scale-90 active:bg-indigo-700 transition-all"
          >
            <Icon name="arrow_upward" size={22} color="#ffffff" />
          </Pressable>
        </Animated.View>
      )}

      {/* Traditional Calendar Modal Picker Overlay */}
      {showDatePicker !== null && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              zIndex: 9999,
              backgroundColor: "rgba(15, 23, 42, 0.6)",
              justifyContent: "flex-end",
            },
          ]}
        >
          <Pressable 
            style={StyleSheet.absoluteFillObject}
            onPress={() => {
              AppSettings.haptic("light");
              setShowDatePicker(null);
            }}
          />
          <AnimatedPressable 
            entering={SlideInDown.duration(280)}
            exiting={SlideOutDown.duration(220)}
            onPress={() => {}} // Intercept clicks inside calendar card
            style={{
              backgroundColor: "#ffffff",
              borderTopLeftRadius: 32,
              borderTopRightRadius: 32,
              padding: 24,
              height: 460,
              width: "100%",
              borderTopWidth: 1,
              borderTopColor: "#f1f5f9",
              elevation: 10,
              shadowColor: "#000",
              shadowOpacity: 0.15,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: -10 },
            }}
          >
            {/* Header controls inside modal */}
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-base font-extrabold text-on-surface">
                {showDatePicker === "start" ? "Select Start Date" : showDatePicker === "end" ? "Select End Date" : "Select Single Date"}
              </Text>
              <Pressable
                onPress={() => {
                  AppSettings.haptic("light");
                  setShowDatePicker(null);
                }}
                className="w-8 h-8 rounded-full bg-slate-50 items-center justify-center border border-slate-100"
              >
                <Icon name="close" size={16} color="#64748b" />
              </Pressable>
            </View>

            {/* Step Selection Header (Year • Month • Day) */}
            <View className="flex-row items-center justify-between mb-4 bg-slate-50 border border-slate-200/50 rounded-2xl p-1">
              <Pressable 
                onPress={() => {
                  AppSettings.haptic("light");
                  setPickerStep("year");
                }}
                className={`flex-1 py-1.5 rounded-xl items-center justify-center ${pickerStep === "year" ? "bg-white border border-slate-200/60" : "active:bg-slate-200/20"}`}
              >
                <Text className={`text-xs font-extrabold ${pickerStep === "year" ? "text-primary" : "text-slate-500"}`}>
                  {viewDate.getFullYear()}
                </Text>
              </Pressable>

              <Pressable 
                onPress={() => {
                  AppSettings.haptic("light");
                  setPickerStep("month");
                }}
                className={`flex-1 py-1.5 rounded-xl items-center justify-center ${pickerStep === "month" ? "bg-white border border-slate-200/60" : "active:bg-slate-200/20"}`}
              >
                <Text className={`text-xs font-extrabold ${pickerStep === "month" ? "text-primary" : "text-slate-500"}`}>
                  {viewDate.toLocaleDateString(undefined, { month: "short" })}
                </Text>
              </Pressable>

              <Pressable 
                onPress={() => {
                  AppSettings.haptic("light");
                  setPickerStep("day");
                }}
                className={`flex-1 py-1.5 rounded-xl items-center justify-center ${pickerStep === "day" ? "bg-white border border-slate-200/60" : "active:bg-slate-200/20"}`}
              >
                <Text className={`text-xs font-extrabold ${pickerStep === "day" ? "text-primary" : "text-slate-500"}`}>
                  Day Grid
                </Text>
              </Pressable>
            </View>

            {/* 1. Year Selector Grid */}
            {pickerStep === "year" && (
              <ScrollView showsVerticalScrollIndicator={false} className="flex-1">
                <View className="flex-row flex-wrap justify-between gap-y-3 gap-x-2 py-2">
                  {Array.from({ length: new Date().getFullYear() - 2000 + 1 }, (_, index) => new Date().getFullYear() - index).map((yr) => {
                    const isSelected = viewDate.getFullYear() === yr;
                    return (
                      <Pressable
                        key={yr}
                        onPress={() => {
                          AppSettings.haptic("light");
                          const next = new Date(viewDate);
                          next.setFullYear(yr);
                          setViewDate(next);
                          setPickerStep("month");
                        }}
                        className={`w-[30%] py-3.5 rounded-2xl items-center justify-center border ${
                          isSelected ? "bg-primary/10 border-primary" : "bg-slate-50 border-slate-100 active:bg-slate-100"
                        }`}
                      >
                        <Text className={`text-xs font-bold ${isSelected ? "text-primary font-black" : "text-on-surface"}`}>
                          {yr}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            )}

            {/* 2. Month Selector Grid */}
            {pickerStep === "month" && (
              <ScrollView showsVerticalScrollIndicator={false} className="flex-1">
                <View className="flex-row flex-wrap justify-between gap-y-3 gap-x-2 py-2">
                  {Array.from({ length: 12 }, (_, index) => index).map((mIdx) => {
                    const name = new Date(2020, mIdx, 1).toLocaleDateString(undefined, { month: "short" });
                    const isSelected = viewDate.getMonth() === mIdx;
                    return (
                      <Pressable
                        key={mIdx}
                        onPress={() => {
                          AppSettings.haptic("light");
                          const next = new Date(viewDate);
                          next.setMonth(mIdx);
                          setViewDate(next);
                          setPickerStep("day");
                        }}
                        className={`w-[30%] py-3.5 rounded-2xl items-center justify-center border ${
                          isSelected ? "bg-primary/10 border-primary" : "bg-slate-50 border-slate-100 active:bg-slate-100"
                        }`}
                      >
                        <Text className={`text-xs font-bold ${isSelected ? "text-primary font-black" : "text-on-surface"}`}>
                          {name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            )}

            {/* 3. Day Selector Grid */}
            {pickerStep === "day" && (
              <View className="flex-1">
                {/* Month/Year shifting controls */}
                <View className="flex-row justify-between items-center mb-3 px-1">
                  <Pressable
                    onPress={() => {
                      AppSettings.haptic("light");
                      const target = new Date(viewDate);
                      target.setMonth(viewDate.getMonth() - 1);
                      setViewDate(target);
                    }}
                    className="w-8 h-8 rounded-full items-center justify-center bg-slate-50 border border-slate-100 active:bg-slate-100"
                  >
                    <Icon name="chevron_left" size={16} color="#475569" />
                  </Pressable>
                  
                  <Text className="text-xs font-bold text-on-surface-variant">
                    {viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                  </Text>

                  <Pressable
                    onPress={() => {
                      AppSettings.haptic("light");
                      const target = new Date(viewDate);
                      target.setMonth(viewDate.getMonth() + 1);
                      setViewDate(target);
                    }}
                    className="w-8 h-8 rounded-full items-center justify-center bg-slate-50 border border-slate-100 active:bg-slate-100"
                  >
                    <Icon name="chevron_right" size={16} color="#475569" />
                  </Pressable>
                </View>

                {/* Weekday Labels Header */}
                <View className="flex-row justify-between mb-2">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((dayName, idx) => (
                    <View key={idx} className="w-[12%] items-center">
                      <Text className="text-[9px] font-extrabold uppercase text-slate-400 tracking-wider">
                        {dayName}
                      </Text>
                    </View>
                  ))}
                </View>

                {/* Days Cells Grid */}
                <ScrollView showsVerticalScrollIndicator={false}>
                  <View className="flex-row flex-wrap justify-between gap-y-1.5 py-1">
                    {(() => {
                      const yr = viewDate.getFullYear();
                      const mn = viewDate.getMonth();
                      const firstDayIdx = new Date(yr, mn, 1).getDay();
                      const totalMthDays = new Date(yr, mn + 1, 0).getDate();
                      const prevMthTotalDays = new Date(yr, mn, 0).getDate();

                      const cellsListObj = [];
                      for (let i = firstDayIdx - 1; i >= 0; i--) {
                        const prevD = new Date(yr, mn - 1, prevMthTotalDays - i);
                        cellsListObj.push({ day: prevMthTotalDays - i, isCurrentMonth: false, date: prevD });
                      }
                      for (let i = 1; i <= totalMthDays; i++) {
                        const currD = new Date(yr, mn, i);
                        cellsListObj.push({ day: i, isCurrentMonth: true, date: currD });
                      }
                      const rem = cellsListObj.length % 7;
                      if (rem > 0) {
                        for (let i = 1; i <= 7 - rem; i++) {
                          const nextD = new Date(yr, mn + 1, i);
                          cellsListObj.push({ day: i, isCurrentMonth: false, date: nextD });
                        }
                      }

                      return cellsListObj.map((cell, idx) => {
                        let isSelected = false;
                        if (showDatePicker === "start") {
                          isSelected = selectedStartDate.toDateString() === cell.date.toDateString();
                        } else if (showDatePicker === "end") {
                          isSelected = selectedEndDate.toDateString() === cell.date.toDateString();
                        } else if (showDatePicker === "day") {
                          isSelected = selectedDate.toDateString() === cell.date.toDateString();
                        }

                        const isTodayDate = cell.date.toDateString() === new Date().toDateString();

                        return (
                          <Pressable
                            key={idx}
                            disabled={!cell.isCurrentMonth}
                            onPress={() => {
                              if (showDatePicker === "day") {
                                AppSettings.haptic("success");
                                setSelectedDate(cell.date);
                                setShowDatePicker(null);
                              } else {
                                selectDate(cell.date);
                              }
                            }}
                            className={`w-[12%] aspect-square rounded-full items-center justify-center ${
                              isSelected 
                                ? "bg-primary" 
                                : isTodayDate 
                                  ? "bg-slate-100 border border-slate-200" 
                                  : "active:bg-slate-100"
                            } ${!cell.isCurrentMonth ? "opacity-25" : ""}`}
                          >
                            <Text className={`text-[10px] font-bold ${
                              isSelected 
                                ? "text-white font-black" 
                                : isTodayDate 
                                  ? "text-primary font-extrabold" 
                                  : "text-on-surface"
                            }`}>
                              {cell.day}
                            </Text>
                          </Pressable>
                        );
                      });
                    })()}
                  </View>
                </ScrollView>
              </View>
            )}
          </AnimatedPressable>
        </View>
      )}
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
    <View className="flex-1 bg-surface border border-slate-100 rounded-3xl p-4 justify-between">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{label}</Text>
        <Icon name={icon} size={16} color={iconColor} />
      </View>
      <Text className="text-2xl font-black text-on-surface tracking-tight">{value}</Text>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View className="p-4 flex-row items-center justify-between border-b border-slate-100/60 opacity-60">
      <View className="flex-1 pr-3 gap-2">
        <View className="w-28 h-3.5 bg-slate-200/80 rounded-md animate-pulse" />
        <View className="w-40 h-2.5 bg-slate-100 rounded-md mt-1.5 animate-pulse" />
      </View>
      <View className="items-end gap-1.5">
        <View className="w-10 h-3 bg-slate-100 rounded-md animate-pulse" />
        <View className="w-16 h-5 bg-slate-200/80 rounded-full animate-pulse" />
      </View>
    </View>
  );
}
