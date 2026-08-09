import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
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
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

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
    /**
     * Raw cosine, NOT a percentage. The model outputs an embedding; cosine is
     * the measured angle between two of them. The percentage scale that used
     * to be shown here was a rescaling with hand-picked endpoints, and because
     * 96% of genuine frames sat above the top anchor they all displayed as
     * exactly 100% — a number no real pair of face images produces.
     * Measured genuine range on this pipeline: 0.717-0.891.
     */
    cosine: number;
    initials: string;
    /**
     * Whether the server accepted the attendance row. Recognition happens
     * on-device, so a match can succeed while the POST fails — showing only
     * the match made a network outage look like a successful mark, which is
     * how "everyone still absent after a lot of scans" happens with no error
     * anywhere on screen.
     */
    sync: "pending" | "saved" | "duplicate" | "failed";
    syncDetail?: string;
  } | null>(null);
  const [isMatchLocked, setIsMatchLocked] = useState(false);

  // --- Session log: in-memory only, lost when the app closes ---
  type SessionMark = {
    name: string;
    enrollmentNumber: string;
    classId: string;
    cosine: number;
    at: number; // Date.now()
  };
  const [sessionLog, setSessionLog] = useState<SessionMark[]>([]);

  // Draggable shelf: starts at a comfortable collapsed height showing status,
  // expands to screen-height * 0.75 to reveal the session log.
  const shelfTranslateY = useSharedValue(0);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const { height: screenH } = useWindowDimensions();
  const SHELF_COLLAPSED_HEIGHT = 128 + insets.bottom;
  const SHELF_EXPANDED_EXTRA = Math.max(0, screenH * 0.75 - SHELF_COLLAPSED_HEIGHT);
  const SHELF_SNAP_DURATION = 240;

  // Pause scanning while the shelf is expanded so faces are not matched into
  // an obstructed view.
  const scanningPaused = sheetExpanded;

  /** Where the shelf was when the current drag began. */
  const shelfDragStart = useSharedValue(0);

  const openShelf = () => {
    AppSettings.haptic("light");
    shelfTranslateY.value = withTiming(SHELF_EXPANDED_EXTRA, {
      duration: SHELF_SNAP_DURATION,
      easing: Easing.out(Easing.cubic),
    });
    setSheetExpanded(true);
  };

  const closeShelf = () => {
    AppSettings.haptic("light");
    shelfTranslateY.value = withTiming(0, {
      duration: SHELF_SNAP_DURATION,
      easing: Easing.out(Easing.cubic),
    });
    setSheetExpanded(false);
  };

  const shelfPanGesture = Gesture.Pan()
    .minDistance(2)
    .onStart(() => {
      shelfDragStart.value = shelfTranslateY.value;
    })
    .onUpdate((e) => {
      // `translationY` is cumulative from the gesture start, so it must be
      // applied to the position at start — not added to the live value, which
      // would compound every frame. Dragging UP is negative, and up means
      // "open", hence the subtraction.
      const next = shelfDragStart.value - e.translationY;
      shelfTranslateY.value = Math.max(0, Math.min(SHELF_EXPANDED_EXTRA, next));
    })
    .onEnd((e) => {
      // A fast flick should win over position, so a short decisive swipe opens
      // or closes without requiring a long drag. Slow upward drags use a low
      // opening threshold, while an open shelf resists accidental collapse.
      const flickUp = e.velocityY < -500;
      const flickDown = e.velocityY > 500;
      const startedExpanded = shelfDragStart.value > SHELF_EXPANDED_EXTRA / 2;
      const snapThreshold = SHELF_EXPANDED_EXTRA * (startedExpanded ? 0.72 : 0.18);
      const shouldOpen = flickUp || (!flickDown && shelfTranslateY.value > snapThreshold);

      shelfTranslateY.value = withTiming(shouldOpen ? SHELF_EXPANDED_EXTRA : 0, {
        duration: SHELF_SNAP_DURATION,
        easing: Easing.out(Easing.cubic),
      });
      runOnJS(setSheetExpanded)(shouldOpen);
    });

  // The shelf grows upward: it is anchored to the bottom, and `height` is what
  // animates. Translating it instead would slide the card off the top of the
  // screen rather than revealing the log underneath it.
  const shelfAnimatedStyle = useAnimatedStyle(() => ({
    height: SHELF_COLLAPSED_HEIGHT + shelfTranslateY.value,
  }));
  // The liveness pill is tethered to the shelf's top edge, so it rises with
  // the expandable status bar instead of floating over its content.
  const livenessPillAnimatedStyle = useAnimatedStyle(() => ({
    bottom: SHELF_COLLAPSED_HEIGHT + shelfTranslateY.value + 12,
  }));

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
    // Pause matching while the shelf is open — a face in the background should
    // not trigger attendance when the user is scrolling through the log.
    if (scanningPaused || isMatchLocked || !face) return;

    // Passive liveness is shown in its own floating progress pill. Keep this
    // gate separate from the matching status bar so the scan UI stays calm.
    if (settings.antiSpoofingEnabled && face.isLive !== true) {
      setRejectReason(null);
      setLastScored(null);
      if (face.isLive === false) consensusRef.current.reset();
      return;
    }

    // Lighting is still surfaced as guidance, but it must not block an
    // otherwise verified student from attendance matching. Enrollment keeps
    // the default strict brightness check.
    const quality = checkFrameQuality(face, { requireGoodLighting: false });
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
      cosine: candidate.similarity,
      initials: student.name.split(" ").map((n) => n[0]).join(""),
      sync: "pending",
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
        // Send the phone's real local date so the server does not file this
        // under tomorrow (the server's `toISOString()` is UTC).
        // `toISOString()` would be UTC too — wrong for the same reason.
        // Build it from local calendar components.
        localDate: (() => {
          const now = new Date();
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        })(),
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setMatchedStudent((prev) =>
            prev ? { ...prev, sync: data.alreadyMarked ? "duplicate" : "saved" } : null
          );
          // Only push to the session log when the server accepted the row.
          if (!data.alreadyMarked) {
            setSessionLog((prev) => [
              { name: student.name, enrollmentNumber: student.enrollmentNumber, classId: student.classId, cosine: candidate.similarity, at: Date.now() },
              ...prev,
            ]);
          }
        } else {
          console.error("Server rejected attendance:", data);
          setMatchedStudent((prev) =>
            prev ? { ...prev, sync: "failed", syncDetail: data.message || "Server rejected" } : null
          );
        }
      })
      .catch((err) => {
        console.error("Attendance POST failed:", err);
        setMatchedStudent((prev) =>
          prev ? { ...prev, sync: "failed", syncDetail: "Network error" } : null
        );
      });

    setTimeout(() => {
      setMatchedStudent(null);
      setIsMatchLocked(false);
    }, 3500);
  }, [face, lighting, students, isMatchLocked, settings.antiSpoofingEnabled]);

  const previewFace = useMemo(
    () =>
      face && previewLayout
        ? mapFaceToPreview(face, previewLayout, false)
        : null,
    [face, previewLayout],
  );

  const livenessPill = useMemo(() => {
    if (!settings.antiSpoofingEnabled || !previewFace || !face) return null;

    const progress = Math.min(Math.max(face.livenessSamples, 0) / 3, 1);
    const lightingWarning = getLightingWarning(face, lighting);
    if (face.isLive === false) {
      return {
        title: lightingWarning ? "Lighting may affect verification" : "Face is not real",
        detail: lightingWarning
          ? `${lightingWarning.message}. Improve lighting and retry.`
          : "Verification failed",
        frames: null,
        progress: 1,
        color: "#ef4444",
        track: "rgba(254,226,226,0.92)",
        surface: "rgba(255,255,255,0.97)",
      };
    }
    if (face.isLive === true) {
      return {
        title: "Face verified",
        detail: null,
        frames: null,
        progress: 1,
        color: "#10b981",
        track: "rgba(209,250,229,0.92)",
        surface: "rgba(255,255,255,0.97)",
      };
    }
    return {
      title: "Verifying face",
      detail: null,
      frames: `${Math.min(face.livenessSamples, 3)}/3`,
      progress,
      color: "#5d5fef",
      track: "rgba(224,231,255,0.94)",
      surface: "rgba(255,255,255,0.97)",
    };
  }, [face, lighting, previewFace, settings.antiSpoofingEnabled]);

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
      ? matchedStudent.sync === "failed"
        ? `${matchedStudent.enrollmentNumber} • ${matchedStudent.classId} • cos ${matchedStudent.cosine.toFixed(3)}\nAttendance NOT saved — ${matchedStudent.syncDetail || "check server"}`
        : matchedStudent.sync === "pending"
          ? `${matchedStudent.enrollmentNumber} • ${matchedStudent.classId} • cos ${matchedStudent.cosine.toFixed(3)}\nSaving attendance...`
          : `${matchedStudent.enrollmentNumber} • ${matchedStudent.classId} • cos ${matchedStudent.cosine.toFixed(3)}`
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

      {/* Tap-outside-to-collapse. Only mounted while the shelf is open so it
          never intercepts taps on the header buttons during normal scanning. */}
      {sheetExpanded && (
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={closeShelf}
          accessibilityLabel="Collapse attendance log"
        />
      )}

      <View className="absolute inset-0 justify-between" pointerEvents="box-none">
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

        {livenessPill && (
          <Animated.View
            pointerEvents="none"
            entering={FadeInDown.duration(220)}
            exiting={FadeOutUp.duration(180)}
            style={[
              {
                position: "absolute",
                left: 20,
                right: 20,
                minHeight: 60,
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderRadius: 24,
                backgroundColor: livenessPill.surface,
                borderWidth: 1,
                borderColor: `${livenessPill.color}33`,
                shadowColor: livenessPill.color,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.16,
                shadowRadius: 12,
                elevation: 8,
              },
              livenessPillAnimatedStyle,
            ]}
          >
            <View className="flex-row items-center gap-3">
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: livenessPill.track,
                }}
              >
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: livenessPill.color }} />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-black text-on-surface" numberOfLines={1}>
                  {livenessPill.title}
                </Text>
                {livenessPill.detail && (
                  <Text className="text-[11px] font-semibold text-on-surface-variant mt-0.5" numberOfLines={1}>
                    {livenessPill.detail}
                  </Text>
                )}
              </View>
              {livenessPill.frames && (
                <Text className="text-xs font-black" style={{ color: livenessPill.color }}>
                  {livenessPill.frames}
                </Text>
              )}
            </View>
            <View style={{ height: 6, marginTop: 10, borderRadius: 999, overflow: "hidden", backgroundColor: livenessPill.track }}>
              <View
                style={{
                  height: "100%",
                  width: `${Math.max(livenessPill.progress * 100, 4)}%`,
                  borderRadius: 999,
                  backgroundColor: livenessPill.color,
                }}
              />
            </View>
          </Animated.View>
        )}

        <GestureDetector gesture={shelfPanGesture}>
          <Animated.View
            entering={FadeInDown.delay(100).duration(600)}
            style={[
              {
                paddingBottom: insets.bottom + 20,
                paddingTop: 8,
                paddingHorizontal: 20,
                backgroundColor: "rgba(248,250,252,0.98)",
                borderTopWidth: 1,
                borderTopColor: "rgba(226,232,240,0.4)",
                borderTopLeftRadius: 32,
                borderTopRightRadius: 32,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: -4 },
                shadowOpacity: 0.12,
                shadowRadius: 20,
                elevation: 10,
                overflow: "hidden",
              },
              shelfAnimatedStyle,
            ]}
            className="w-full gap-4"
          >
            {/* Drag handle — the visual affordance for the whole gesture. */}
            <Pressable
              onPress={() => (sheetExpanded ? closeShelf() : openShelf())}
              hitSlop={12}
              className="items-center justify-center"
              style={{ height: 32, marginTop: -6, marginHorizontal: -20 }}
            >
              <View
                style={{
                  width: 44, height: 5, borderRadius: 999,
                  backgroundColor: sheetExpanded ? "#818cf8" : "#cbd5e1",
                }}
              />
            </Pressable>
          <View className="flex-row items-center justify-between" style={{ minHeight: 56, paddingTop: 2, paddingBottom: 2 }}>
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
                          width: 48, height: 48, borderRadius: 16,
                          backgroundColor: "rgba(34,197,94,0.1)",
                          alignItems: "center", justifyContent: "center",
                          borderWidth: 1, borderColor: "rgba(34,197,94,0.2)",
                        }
                      : {
                          width: 48, height: 48, borderRadius: 16,
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
              <View className="flex-1" style={{ minHeight: 54, justifyContent: "center" }}>
                <Text className="text-on-surface font-black text-base tracking-tight" numberOfLines={1}>
                  {statusTitle}
                </Text>
                <Text
                  className="text-xs text-on-surface-variant font-bold mt-0.5"
                  numberOfLines={2}
                  style={{ minHeight: 32, lineHeight: 16 }}
                >
                  {statusDescription}
                </Text>
              </View>
            </View>
            <View
              style={
                matchedStudent
                  ? matchedStudent.sync === "failed"
                    ? {
                        backgroundColor: "#fee2e2", minWidth: 92, maxWidth: 124, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 16, borderWidth: 1, borderColor: "#fca5a5",
                      }
                    : {
                        backgroundColor: "#d1fae5", minWidth: 92, maxWidth: 124, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 16, borderWidth: 1, borderColor: "#6ee7b7",
                      }
                  : previewFace
                    ? {
                        backgroundColor: "rgba(34,197,94,0.12)", minWidth: 92, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 12, borderWidth: 1, borderColor: "rgba(34,197,94,0.2)",
                      }
                    : {
                        backgroundColor: "rgba(93,95,239,0.08)", minWidth: 92, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 12, borderWidth: 1, borderColor: "rgba(93,95,239,0.2)",
                      }
              }
            >
              <Text
                className={
                  matchedStudent
                    ? matchedStudent.sync === "failed"
                      ? "text-xs font-black text-red-700 uppercase tracking-wider"
                      : "text-xs font-black text-emerald-800 uppercase tracking-wider"
                    : previewFace
                      ? "text-[10px] font-black text-success uppercase tracking-wider"
                      : "text-[10px] font-black text-primary uppercase tracking-wider"
                }
              >
                {matchedStudent
                  ? matchedStudent.sync === "pending"
                    ? "Saving"
                    : matchedStudent.sync === "saved"
                      ? "Marked"
                      : matchedStudent.sync === "duplicate"
                        ? "Already marked"
                        : "Not saved"
                  : previewFace
                    ? "Scanning"
                    : "Searching"}
              </Text>
            </View>
          </View>

            {/* Session log — appears when the shelf is dragged up. In-memory
                only: cleared every time the app restarts. */}
            <View style={{ maxHeight: SHELF_EXPANDED_EXTRA, borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 16 }}>
              <View className="flex-row items-center justify-between mb-2">
                <Text className="text-base font-black text-on-surface tracking-tight">
                  Today's attendance
                </Text>
                <View className="px-3 py-1 rounded-full bg-indigo-50 border border-indigo-100">
                  <Text className="text-[10px] font-extrabold text-primary">
                    {sessionLog.length} marked
                  </Text>
                </View>
              </View>
              {sessionLog.length === 0 ? (
                <View className="items-center rounded-3xl border border-indigo-100 bg-indigo-50 px-5 py-6 mt-2">
                  <View className="h-11 w-11 items-center justify-center rounded-2xl bg-white border border-indigo-100 mb-3">
                    <View className="h-4 w-4 rounded-full border-[5px] border-primary" />
                  </View>
                  <Text className="text-sm font-black text-on-surface tracking-tight">Ready for the first scan</Text>
                  <Text className="text-xs font-semibold text-on-surface-variant text-center leading-4 mt-1">
                    Keep a face inside the frame. Successful attendance marks will appear here.
                  </Text>
                </View>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false}>
                  {sessionLog.map((m) => (
                    <View
                      key={`${m.enrollmentNumber}-${m.at}`}
                      className="flex-row items-center justify-between rounded-2xl bg-white border border-slate-100 px-4 py-3 mb-2"
                    >
                      <View className="flex-1 pr-3">
                        <Text className="font-bold text-on-surface text-sm tracking-tight">
                          {m.name}
                        </Text>
                        <Text className="text-[11px] font-semibold text-on-surface-variant mt-0.5">
                          {m.enrollmentNumber} • {m.classId}
                        </Text>
                      </View>
                      <View className="items-end gap-0.5">
                        <Text className="text-xs font-bold text-on-surface-variant">
                          {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                        <Text className="text-[10px] font-bold text-emerald-700">
                          {m.cosine.toFixed(3)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
        </Animated.View>
        </GestureDetector>

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
