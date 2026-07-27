import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import Svg, { Path } from "react-native-svg";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import { useAppSettings, AppSettings } from "@/utils/settings";

function FlipIcon({ size = 20, color = "#0f172a" }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l.57.81"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function LoginIcon({ size = 20, color = "#0f172a" }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 3H7a2 2 0 00-2 2v14a2 2 0 002 2h8m4-9l-4-4m4 4l-4 4m4-4H9"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const SIMULATED_STUDENTS = [
  { name: "Sarah Jenkins", id: "ENR-8492", course: "CS101 - Advanced Logic", initials: "SJ" },
  { name: "Marcus Chen", id: "ENR-3104", course: "PHY301 - Quantum Mechanics", initials: "MC" },
  { name: "Elena Rodriguez", id: "ENR-9921", course: "ENG204 - Modern Literature", initials: "ER" },
  { name: "David Kim", id: "ENR-3310", course: "MATH202 - Calculus II", initials: "DK" },
];

export default function CameraLandingScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const isFocused = pathname === "/";
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraFacing, setCameraFacing] = useState<"front" | "back">("front");
  
  // Scanning state states
  const [scanState, setScanState] = useState<"scanning" | "matched">("scanning");
  const [studentIndex, setStudentIndex] = useState(0);

  // Simulate scanning loop
  useEffect(() => {
    if (!isFocused) return;

    let timer: NodeJS.Timeout;

    if (scanState === "scanning") {
      timer = setTimeout(() => {
        setScanState("matched");
        AppSettings.haptic("success"); // Trigger success haptic confirmation
      }, 4000); // Scan for 4 seconds, then match
    } else {
      timer = setTimeout(() => {
        setScanState("scanning");
        setStudentIndex((prevIndex) => (prevIndex + 1) % SIMULATED_STUDENTS.length);
      }, 3500); // Stay on matched result for 3.5 seconds
    }

    return () => clearTimeout(timer);
  }, [scanState, isFocused]);

  if (!permission) {
    return (
      <View className="flex-1 bg-black justify-center items-center">
        <Text className="text-white font-medium mb-4 text-sm">Loading Camera...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View className="flex-1 bg-black justify-center items-center px-6">
        <Text className="text-white text-center font-bold text-base mb-6">
          We need your permission to show the camera feed for student face scanning.
        </Text>
        <View className="shadow-premium rounded-2xl bg-primary">
          <Pressable
            onPress={requestPermission}
            className="px-6 py-4 rounded-2xl active:scale-95 transition-all"
          >
            <Text className="text-white font-extrabold text-sm tracking-wider">
              Grant Camera Permission
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const currentStudent = SIMULATED_STUDENTS[studentIndex];

  return (
    <View className="flex-1 bg-black">
      {/* Actual Live Camera Viewfinder */}
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing={cameraFacing}
      />

      {/* Floating Layout Layer */}
      <View className="absolute inset-0 justify-between">
        {/* Top Controls Row */}
        <Animated.View
          entering={FadeInUp.delay(200).duration(500)}
          style={{ paddingTop: insets.top + 16, paddingHorizontal: 24 }}
          className="flex-row justify-between items-center w-full"
        >
          {/* Admin panel navigation button - White Circle with Login SVG */}
          <View className="w-12 h-12 rounded-full bg-white border border-slate-100/50 shadow-medium">
            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                router.push("/login");
              }}
              className="w-full h-full items-center justify-center rounded-full active:scale-95 transition-all"
            >
              <LoginIcon color="#0f172a" />
            </Pressable>
          </View>

          {/* Flip camera switch action - White Circle with Svg */}
          <View className="w-12 h-12 rounded-full bg-white border border-slate-100/50 shadow-medium">
            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                setCameraFacing(cameraFacing === "front" ? "back" : "front");
              }}
              className="w-full h-full items-center justify-center rounded-full active:scale-95 transition-all"
            >
              <FlipIcon color="#0f172a" />
            </Pressable>
          </View>
        </Animated.View>

        {/* Bottom Rounded Status Sheet (Occupies bottom area, leaving center camera open) */}
        <Animated.View
          entering={FadeInDown.delay(100).duration(600)}
          style={{ paddingBottom: insets.bottom + 20, paddingTop: 20, paddingHorizontal: 24 }}
          className="w-full bg-white/95 border-t border-slate-100 rounded-t-[40px] shadow-medium gap-4"
        >
            
            {scanState === "scanning" ? (
              /* SCANNING STATE VIEW */
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-3">
                  <View className="w-10 h-10 rounded-2xl bg-primary/10 items-center justify-center">
                    {/* Pulsing blue dot */}
                    <View className="w-3.5 h-3.5 rounded-full bg-primary animate-pulse" />
                  </View>
                  <View>
                    <Text className="text-on-surface font-extrabold text-base tracking-tight">
                      Face Scanner Active
                    </Text>
                    <Text className="text-xs text-on-surface-variant font-medium mt-0.5">
                      Waiting for student to align face...
                    </Text>
                  </View>
                </View>
                <View className="bg-slate-100 px-3 py-1.5 rounded-xl border border-slate-200/50">
                  <Text className="text-[10px] font-black text-on-surface-variant uppercase tracking-wider">
                    Scanning
                  </Text>
                </View>
              </View>
            ) : (
              /* MATCHED / MARKED STATE VIEW */
              <View className="gap-3.5">
                {/* Status Bar */}
                <View className="flex-row justify-between items-center">
                  <View className="flex-row items-center gap-2">
                    <View className="w-2.5 h-2.5 rounded-full bg-success" />
                    <Text className="text-success font-extrabold text-sm uppercase tracking-wide">
                      Attendance Marked
                    </Text>
                  </View>
                  <View className="bg-success-light px-3 py-1 rounded-xl border border-success/15">
                    <Text className="text-[9px] font-black text-success uppercase tracking-wider">
                      Success
                    </Text>
                  </View>
                </View>

                {/* Divider */}
                <View className="h-[1px] bg-slate-100 w-full" />

                {/* Student Profile Identity Details Card */}
                <View className="flex-row items-center gap-3">
                  <View className="w-11 h-11 rounded-full bg-primary/15 items-center justify-center border border-primary/10">
                    <Text className="font-extrabold text-primary text-sm">
                      {currentStudent.initials}
                    </Text>
                  </View>
                  <View className="flex-1">
                    <Text className="text-on-surface font-bold text-base leading-tight">
                      {currentStudent.name}
                    </Text>
                    <Text className="text-xs text-on-surface-variant font-semibold mt-1" numberOfLines={1}>
                      ID: {currentStudent.id} • {currentStudent.course}
                    </Text>
                  </View>
                </View>
              </View>
            )}

        </Animated.View>
      </View>
    </View>
  );
}
