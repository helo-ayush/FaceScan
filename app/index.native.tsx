import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCameraPermissions } from "react-native-face-detector-camera";
import Svg, { Path } from "react-native-svg";
import Animated, {
  Easing,
  FadeInDown,
  FadeInUp,
  FadeOutUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { LiveFaceCamera, RealtimeFace, RealtimeLighting } from "@/components/LiveFaceCamera";
import { AppSettings, PERFORMANCE_PRESETS, useAppSettings } from "@/utils/settings";
import { mapFaceToPreview, PreviewLayout } from "@/utils/faceBoxUtils";
import {
  checkFrameQuality,
  ConsensusTracker,
  decideFrame,
  MatchableStudent,
  MATCH_TUNING,
  scoreFrame,
  similarityToDisplayPercent,
  type ScoredFrame,
} from "@/utils/faceMatching";
import { Calibration } from "@/utils/calibration";
import { CalibrationPanel } from "@/components/CalibrationPanel";

type PreviewFace = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function SmoothFaceBox({
  previewFace,
  smooth,
  intervalMs,
}: {
  previewFace: PreviewFace;
  smooth: boolean;
  intervalMs: number;
}) {
  const left = useSharedValue(previewFace.left);
  const top = useSharedValue(previewFace.top);
  const width = useSharedValue(previewFace.width);
  const height = useSharedValue(previewFace.height);
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 150 });
  }, []);

  useEffect(() => {
    if (smooth) {
      // High-stiffness, low-mass spring for instant 60 FPS face box response without trailing lag
      const springConfig = {
        stiffness: 240,
        damping: 20,
        mass: 0.3,
      };
      left.value = withSpring(previewFace.left, springConfig);
      top.value = withSpring(previewFace.top, springConfig);
      width.value = withSpring(previewFace.width, springConfig);
      height.value = withSpring(previewFace.height, springConfig);
    } else {
      left.value = previewFace.left;
      top.value = previewFace.top;
      width.value = previewFace.width;
      height.value = previewFace.height;
    }
  }, [previewFace.left, previewFace.top, previewFace.width, previewFace.height, smooth]);

  const animatedStyle = useAnimatedStyle(() => ({
    left: left.value,
    top: top.value,
    width: width.value,
    height: height.value,
    opacity: opacity.value,
  }));

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      <Animated.View style={[styles.faceFrame, animatedStyle]}>
        <View style={styles.faceLabel}>
          <Text style={styles.faceLabelText}>FACE DETECTED</Text>
        </View>
      </Animated.View>
    </View>
  );
}

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

type LightingWarning = {
  title: string;
  message: string;
};

function getLightingWarning(
  face: RealtimeFace | null,
  lighting: RealtimeLighting,
): LightingWarning | null {
  const frame = face?.frameBrightness ?? lighting.frameBrightness;
  const brightPixelRatio = lighting.brightPixelRatio ?? 0;
  const faceBrightness = face?.faceBrightness ?? null;
  const background = face?.backgroundBrightness ?? null;

  if (faceBrightness !== null && background !== null && faceBrightness < background - 32 && faceBrightness < 128) {
    return { title: "Backlit face", message: "Turn toward the light" };
  }
  if (faceBrightness !== null && faceBrightness < 66) {
    return { title: "Face too dim", message: "Move closer to light" };
  }
  if (frame !== null && frame < 58) {
    return { title: "Scene too dim", message: "Increase room light" };
  }
  if (brightPixelRatio >= 0.04) {
    return { title: "Harsh glare", message: "Move away from bright light" };
  }
  if (faceBrightness !== null && background !== null && faceBrightness > background + 36 && faceBrightness > 185) {
    return { title: "Direct light on face", message: "Avoid direct light" };
  }
  if (faceBrightness !== null && faceBrightness > 222) {
    return { title: "Face overexposed", message: "Reduce face light" };
  }
  if (frame !== null && frame > 226) {
    return { title: "Scene overexposed", message: "Reduce room light" };
  }
  return null;
}

function probabilityText(value: number | null) {
  return value === null ? null : `${Math.round(value * 100)}%`;
}

type StudentRecord = MatchableStudent & {
  _id: string;
};

export default function CameraLandingScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const { settings, updateSetting, triggerHaptic } = useAppSettings();
  const [face, setFace] = useState<RealtimeFace | null>(null);
  const [lighting, setLighting] = useState<RealtimeLighting>({
    frameBrightness: null,
    brightPixelRatio: null,
  });
  const [displayedLightingWarning, setDisplayedLightingWarning] = useState<LightingWarning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout | null>(null);

  // Student Roster & Real-time Matching state
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [matchedStudent, setMatchedStudent] = useState<{
    name: string;
    enrollmentNumber: string;
    classId: string;
    similarity: number;
    initials: string;
  } | null>(null);
  const [isMatchLocked, setIsMatchLocked] = useState(false);

  // Sliding-window consensus: the same student must win several of the most
  // recent frames before attendance is marked.
  const consensusRef = useRef(new ConsensusTracker());

  // Why the current frame was rejected, surfaced in the UI so a student can see
  // whether to hold still, move into better light, or face the camera.
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  // Most recent scored frame, reused for the live readout so the roster is not
  // scanned twice per frame.
  const [lastScored, setLastScored] = useState<{ scored: ScoredFrame; yaw: number } | null>(null);

  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://192.168.0.103:5000";

  // Fetch enrolled students roster on mount
  useEffect(() => {
    let isMounted = true;
    fetch(`${apiUrl}/api/students`)
      .then((res) => res.json())
      .then((data) => {
        if (isMounted && data.success && Array.isArray(data.students)) {
          setStudents(data.students);
        }
      })
      .catch((err) => {
        console.log("Unable to fetch student roster for local matching:", err);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Pose-aware cosine search, gated on frame quality, an absolute similarity
  // floor, a margin over the closest *other* student, and temporal consensus.
  useEffect(() => {
    if (isMatchLocked || !face) return;

    const quality = checkFrameQuality(face);
    if (!quality.ok) {
      // A poor frame is not evidence either way — drop it without letting it
      // break an otherwise good consensus run.
      setRejectReason(quality.reason);
      setLastScored(null);
      return;
    }

    const liveEmbedding = face.embedding as number[];
    const yaw = face.yawAngle ?? 0;
    const scored = scoreFrame(liveEmbedding, students, yaw);
    setLastScored({ scored, yaw });
    Calibration.record(scored, yaw);

    // While calibrating, this screen is a measurement instrument rather than an
    // attendance terminal: keep scoring and recording every frame, but never
    // lock the UI or mark attendance. Otherwise a capture run would be
    // interrupted for 3.5 seconds each time the current (unproven) thresholds
    // happen to fire, and the recorded distribution would be full of gaps.
    if (Calibration.isEnabled) {
      setRejectReason(null);
      return;
    }

    const decision = decideFrame(scored);
    if (!decision.accept) {
      setRejectReason(decision.reason);
      consensusRef.current.push(null);
      return;
    }

    setRejectReason(null);
    const { candidate } = decision;
    const confirmedId = consensusRef.current.push(candidate.studentId);
    if (!confirmedId) return;

    // Confirmed: lock the UI, mark attendance, then resume scanning.
    const student = candidate.student;
    setIsMatchLocked(true);
    AppSettings.haptic("success");
    consensusRef.current.reset();

    setMatchedStudent({
      name: student.name,
      enrollmentNumber: student.enrollmentNumber,
      classId: student.classId,
      similarity: similarityToDisplayPercent(candidate.similarity),
      initials: student.name.split(" ").map((n) => n[0]).join(""),
    });

    // The device has already decided; the server only records the result.
    fetch(`${apiUrl}/api/attendance/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enrollmentNumber: student.enrollmentNumber,
        classId: student.classId,
        similarity: candidate.similarity,
        margin: scored.margin,
        pose: candidate.pose,
      }),
    }).catch((err) => console.error("Error logging attendance:", err));

    setTimeout(() => {
      setMatchedStudent(null);
      setIsMatchLocked(false);
    }, 3500);
  }, [face, students, isMatchLocked]);

  const previewFace = useMemo(
    () =>
      face && previewLayout
        ? mapFaceToPreview(face, previewLayout, false)
        : null,
    [face, previewLayout],
  );

  const handleCameraLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPreviewLayout({ width, height });
  };

  const lightingWarning = getLightingWarning(face, lighting);
  const lightingWarningKey = lightingWarning?.title ?? "none";

  useEffect(() => {
    const timer = setTimeout(
      () => setDisplayedLightingWarning(lightingWarning),
      lightingWarning ? 500 : 800,
    );
    return () => clearTimeout(timer);
  }, [lightingWarningKey]);

  const statusTitle = error
    ? "Detector unavailable"
    : matchedStudent
      ? matchedStudent.name
      : previewFace
        ? "Face detected — Matching..."
        : "Looking for a face";

  // Live readout derived from the frame the matcher already scored, so the
  // roster is not searched a second time per frame.
  const liveSimilarity = useMemo(() => {
    if (!lastScored) return null;
    const { scored, yaw } = lastScored;
    if (!scored.best) return null;
    return {
      name: scored.best.student.name,
      score: similarityToDisplayPercent(scored.best.similarity),
      cosine: scored.best.similarity,
      margin: scored.margin,
      activePose: scored.pose,
      yaw: Math.round(yaw),
      /** True when the winner cleared the floor but not the runner-up margin. */
      ambiguous:
        scored.best.similarity >= MATCH_TUNING.acceptSimilarity &&
        scored.margin < MATCH_TUNING.marginOverRunnerUp,
    };
  }, [lastScored]);

  const statusDescription = error
    ? "Restart the development build and check camera permission."
    : matchedStudent
      ? `${matchedStudent.enrollmentNumber} • ${matchedStudent.classId}`
      : previewFace && liveSimilarity
        ? liveSimilarity.ambiguous
          ? `Too close to call — ${liveSimilarity.name} vs others (margin ${liveSimilarity.margin.toFixed(2)})`
          : `Best: ${liveSimilarity.name} (${liveSimilarity.activePose} • ${liveSimilarity.yaw}°) → cos ${liveSimilarity.cosine.toFixed(3)} · margin ${liveSimilarity.margin.toFixed(2)}`
        : previewFace
          ? rejectReason
            ? `Hold on — ${rejectReason}`
            : "Searching enrolled student embeddings database..."
          : "Point camera at an enrolled student's face.";

  if (!permission) {
    return (
      <View className="flex-1 bg-black justify-center items-center">
        <Text className="text-white font-medium mb-4 text-sm">Loading camera...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View className="flex-1 bg-black justify-center items-center px-6">
        <Text className="text-white text-center font-bold text-base mb-6">
          We need camera permission to detect a face and show its position.
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

  return (
    <View className="flex-1 bg-black">
      <LiveFaceCamera
        performanceMode={settings.performance}
        scanningPerformance={settings.scanningPerformance}
        cameraFacing={settings.cameraFacing}
        showNativeOverlay={true}
        smoothNativeOverlay={settings.smoothFaceBox}
        onFaceChange={setFace}
        onLightingChange={setLighting}
        onCameraReady={() => setCameraReady(true)}
        onError={setError}
        onPreviewLayout={handleCameraLayout}
      />

      <View className="absolute inset-0 justify-between">
        <Animated.View
          entering={FadeInUp.delay(200).duration(500)}
          style={{ paddingTop: insets.top + 16, paddingHorizontal: 24 }}
          className="flex-row justify-between items-center w-full"
        >
          <View
            className="w-12 h-12 rounded-full bg-white"
            style={{
              borderWidth: 1,
              borderColor: "rgba(241,245,249,0.5)",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.08,
              shadowRadius: 8,
              elevation: 3,
            }}
          >
            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                router.push("/login");
              }}
              className="w-full h-full items-center justify-center rounded-full"
            >
              <LoginIcon color="#0f172a" />
            </Pressable>
          </View>

          <View
            className="w-12 h-12 rounded-full"
            style={{
              backgroundColor: "rgba(255,255,255,0.9)",
              borderWidth: 1,
              borderColor: "rgba(241,245,249,0.5)",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.08,
              shadowRadius: 8,
              elevation: 3,
            }}
          >
            <Pressable
              accessibilityLabel="Switch camera"
              accessibilityRole="button"
              onPress={() => {
                triggerHaptic("light");
                updateSetting("cameraFacing", settings.cameraFacing === "front" ? "back" : "front");
                setFace(null);
              }}
              className="w-full h-full items-center justify-center rounded-full"
            >
              <FlipIcon color="#0f172a" />
            </Pressable>
          </View>

          {displayedLightingWarning && (
            <Animated.View
              pointerEvents="none"
              entering={FadeInDown.duration(220)}
              exiting={FadeOutUp.duration(180)}
              style={{
                position: "absolute",
                left: 80,
                right: 80,
                top: insets.top + 16,
                backgroundColor: "rgba(255,255,255,0.95)",
                borderWidth: 1,
                borderColor: "#fde68a",
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.08,
                shadowRadius: 8,
                elevation: 3,
              }}
              className="h-12 flex-row items-center gap-2 rounded-full px-3"
            >
              <View className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              <View className="flex-1 flex-row items-center gap-1.5">
                <Text className="text-xs font-black text-amber-800" numberOfLines={1}>
                  {displayedLightingWarning.title}
                </Text>
                <Text className="flex-1 text-[10px] font-semibold text-amber-700" numberOfLines={1}>
                  {displayedLightingWarning.message}
                </Text>
              </View>
            </Animated.View>
          )}
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(100).duration(600)}
          style={{
            paddingBottom: insets.bottom + 20,
            paddingTop: 24,
            paddingHorizontal: 24,
            backgroundColor: "rgba(255,255,255,0.9)",
            borderTopWidth: 1,
            borderTopColor: "rgba(226,232,240,0.4)",
            borderTopLeftRadius: 40,
            borderTopRightRadius: 40,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.12,
            shadowRadius: 20,
            elevation: 10,
          }}
          className="w-full gap-4"
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3.5 flex-1 pr-3">
              <View
                style={
                  matchedStudent
                    ? {
                        width: 48, height: 48, borderRadius: 16,
                        backgroundColor: "#10b981",
                        alignItems: "center", justifyContent: "center",
                        borderWidth: 1, borderColor: "#34d399",
                        shadowColor: "#10b981", shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.3, shadowRadius: 6, elevation: 4,
                      }
                    : previewFace
                      ? {
                          width: 44, height: 44, borderRadius: 16,
                          backgroundColor: "rgba(34,197,94,0.1)",
                          alignItems: "center", justifyContent: "center",
                          borderWidth: 1, borderColor: "rgba(34,197,94,0.2)",
                        }
                      : {
                          width: 44, height: 44, borderRadius: 16,
                          backgroundColor: "rgba(93,95,239,0.1)",
                          alignItems: "center", justifyContent: "center",
                          borderWidth: 1, borderColor: "rgba(93,95,239,0.1)",
                        }
                }
              >
                {matchedStudent ? (
                  <Text className="text-white font-black text-base">
                    {matchedStudent.initials}
                  </Text>
                ) : (
                  <View
                    style={{
                      width: 16, height: 16, borderRadius: 8,
                      backgroundColor: previewFace ? "#22c55e" : "#5d5fef",
                    }}
                  >
                    <View className="w-2 h-2 rounded-full bg-white m-auto" />
                  </View>
                )}
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-black text-base tracking-tight">
                  {statusTitle}
                </Text>
                <Text
                  className="text-xs text-on-surface-variant font-bold mt-0.5"
                  numberOfLines={2}
                >
                  {statusDescription}
                </Text>
              </View>
            </View>
            <View
              style={
                matchedStudent
                  ? {
                      backgroundColor: "#d1fae5", paddingHorizontal: 14, paddingVertical: 8,
                      borderRadius: 16, borderWidth: 1, borderColor: "#6ee7b7",
                    }
                  : previewFace
                    ? {
                        backgroundColor: "rgba(34,197,94,0.15)", paddingHorizontal: 12, paddingVertical: 6,
                        borderRadius: 12, borderWidth: 1, borderColor: "rgba(34,197,94,0.2)",
                      }
                    : {
                        backgroundColor: "rgba(93,95,239,0.1)", paddingHorizontal: 12, paddingVertical: 6,
                        borderRadius: 12, borderWidth: 1, borderColor: "rgba(93,95,239,0.2)",
                      }
              }
            >
              <Text
                className={
                  matchedStudent
                    ? "text-xs font-black text-emerald-800 uppercase tracking-wider"
                    : previewFace
                      ? "text-[10px] font-black text-success uppercase tracking-wider"
                      : "text-[10px] font-black text-primary uppercase tracking-wider"
                }
              >
                {matchedStudent ? `✓ ${matchedStudent.similarity}% MATCH` : previewFace ? "Scanning" : "Searching"}
              </Text>
            </View>
          </View>
        </Animated.View>

        {__DEV__ && (
          <CalibrationPanel topOffset={insets.top + 76} students={students} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  faceFrame: {
    position: "absolute",
    borderColor: "#5d5fef",
    borderRadius: 20,
    borderWidth: 3,
    shadowColor: "#5d5fef",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  faceLabel: {
    alignSelf: "flex-start",
    backgroundColor: "#5d5fef",
    borderRadius: 8,
    marginLeft: -3,
    marginTop: -29,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  faceLabelText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
});
