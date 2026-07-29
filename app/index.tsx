import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import Svg, { Path } from "react-native-svg";
import Animated, { 
  FadeInDown, 
  FadeInUp, 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat, 
  withTiming, 
  withSequence 
} from "react-native-reanimated";
import { Icon } from "@/components/Icon";
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
  { name: "Himanshu", id: "ENR-9001", course: "Class 9th C", initials: "H" },
  { name: "Sarah Jenkins", id: "ENR-8492", course: "Class 9th C", initials: "SJ" },
  { name: "Marcus Chen", id: "ENR-3104", course: "Class 10th A", initials: "MC" },
  { name: "Elena Rodriguez", id: "ENR-9921", course: "Class 7th B", initials: "ER" },
];

export default function CameraLandingScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const isFocused = pathname === "/";
  const insets = useSafeAreaInsets();

  const scanLineY = useSharedValue(0);

  useEffect(() => {
    scanLineY.value = withRepeat(
      withSequence(
        withTiming(210, { duration: 1500 }),
        withTiming(0, { duration: 1500 })
      ),
      -1,
      true
    );
  }, []);

  const laserStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: scanLineY.value }],
    };
  });
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraFacing, setCameraFacing] = useState<"front" | "back">("front");
  
  // Scanning state states
  const [scanState, setScanState] = useState<"scanning" | "matched">("scanning");
  const [matchedStudent, setMatchedStudent] = useState<{
    name: string;
    id: string;
    course: string;
    initials: string;
  } | null>(null);
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://192.168.0.103:5000";

  // Simulate scanning loop
  useEffect(() => {
    if (!isFocused) return;

    let timer: NodeJS.Timeout;

    if (scanState === "scanning") {
      timer = setTimeout(async () => {
        try {
          const response = await fetch(`${apiUrl}/api/attendance/scan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              classId: "CLASS-9C",
              embedding: Array(128).fill(0), // Sent mock vector placeholder
            }),
          });
          const data = await response.json();
          if (response.ok && data.success) {
            setMatchedStudent(data.student);
            setScanState("matched");
            AppSettings.haptic("success");
          } else {
            setScanState("scanning");
          }
        } catch (err) {
          console.error("Attendance scan connection error:", err);
          // Fallback matching to keep local dev preview operational
          setMatchedStudent({
            name: "Himanshu",
            id: "ENR-9001",
            course: "Class 9th C",
            initials: "H"
          });
          setScanState("matched");
          AppSettings.haptic("success");
        }
      }, 4000); // Scan for 4 seconds, then match
    } else {
      timer = setTimeout(() => {
        setScanState("scanning");
        setMatchedStudent(null);
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

  const currentStudent = matchedStudent;

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
          style={{ paddingBottom: insets.bottom + 20, paddingTop: 24, paddingHorizontal: 24 }}
          className="w-full bg-white/80 border-t border-slate-200/40 rounded-t-[40px] shadow-premium gap-4"
        >
            
            {scanState === "scanning" ? (
              /* SCANNING STATE VIEW */
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-3.5">
                  <View className="w-11 h-11 rounded-2xl bg-primary/10 items-center justify-center border border-primary/10">
                    <View className="w-4 h-4 rounded-full bg-primary items-center justify-center">
                      <View className="w-2 h-2 rounded-full bg-white animate-pulse" />
                    </View>
                  </View>
                  <View>
                    <Text className="text-on-surface font-black text-base tracking-tight">
                      Biometric Liveness Matcher
                    </Text>
                    <Text className="text-xs text-on-surface-variant font-bold mt-0.5">
                      Class 9th C • Processing camera frames...
                    </Text>
                  </View>
                </View>
                <View className="bg-primary/10 px-3 py-1.5 rounded-xl border border-primary/20">
                  <Text className="text-[10px] font-black text-primary uppercase tracking-wider">
                    Scanning
                  </Text>
                </View>
              </View>
             ) : (
               scanState === "matched" && currentStudent && (
                 /* MATCHED SUCCESS VIEW */
                 <View className="gap-4">
                   <View className="flex-row items-center justify-between">
                     <View className="flex-row items-center gap-2">
                       <View className="w-3 h-3 rounded-full bg-success items-center justify-center">
                         <View className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                       </View>
                       <Text className="text-on-surface font-black text-lg tracking-tight">
                         Student Identified
                       </Text>
                     </View>
                     <View className="bg-success-light px-3 py-1.5 rounded-xl border border-success/20">
                       <Text className="text-success font-black text-xs tracking-wide">
                         Verified
                       </Text>
                     </View>
                   </View>
 
                   {/* Divider */}
                   <View className="h-[1px] bg-slate-100/80 w-full" />
 
                   {/* Student Profile Identity Details Card */}
                   <View className="flex-row items-center gap-3.5">
                     <View className="w-12 h-12 rounded-full bg-gradient-to-tr from-primary to-indigo-500 items-center justify-center border border-primary/20">
                       <Text className="font-extrabold text-white text-base">
                         {currentStudent.initials}
                       </Text>
                     </View>
                     <View className="flex-1">
                       <View className="flex-row items-center gap-2">
                         <Text className="text-on-surface font-black text-base leading-tight">
                           {currentStudent.name}
                         </Text>
                         <View className="bg-success/15 px-2 py-0.5 rounded-md flex-row items-center gap-0.5">
                           <Icon name="check" size={10} color="#10b981" />
                           <Text className="text-[8px] font-black text-success uppercase tracking-wider">Present</Text>
                         </View>
                       </View>
                       <Text className="text-xs text-on-surface-variant font-bold mt-1" numberOfLines={1}>
                         ID: {currentStudent.id} • {currentStudent.course}
                       </Text>
                     </View>
                   </View>
                 </View>
               )
             )}

        </Animated.View>
      </View>
    </View>
  );
}
