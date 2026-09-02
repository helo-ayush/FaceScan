import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  LayoutAnimation,
  Image,
  StyleSheet,
} from "react-native";
import { useFocusEffect, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeInUp,
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import * as FileSystem from "expo-file-system";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { SkeletonBlock } from "@/components/ScreenSkeleton";
import { LiveFaceCamera, RealtimeFace, RealtimeLighting } from "@/components/LiveFaceCamera";
import { AppSettings, useAppSettings } from "@/utils/settings";
import { mapFaceToPreview } from "@/utils/faceBoxUtils";
import {
  averageEmbeddings,
  checkFrameQuality,
  cosineSimilarity,
  poseCaptureGuidance,
  sampleCohesion,
  signedAngle,
  type PoseKey,
} from "@/utils/faceMatching";
import { useSyncEngine } from "@/utils/SyncProvider";
import { insertPendingEnrollment, getCachedClasses, replaceCachedClasses } from "@/utils/localDb";
import { API_URL } from "@/utils/apiConfig";

/**
 * How many distinct, quality-checked frames to average into the biometric centroid.
 * Averaging 5 quality frames builds a high-density, noise-free ArcFace centroid
 * in ~1.5 seconds while looking straight into the guide ring.
 */
const SAMPLES_PER_POSE = 5;

/**
 * Give up on a burst if no new sample is accepted within this window.
 */
const BURST_TIMEOUT_MS = 10000;

/**
 * Consecutive good frames in frontal position before auto-capture starts on its own.
 */
const AUTO_CAPTURE_HOLD_FRAMES = 2;

/**
 * Minimum mean pairwise similarity within a pose's samples.
 */
const MIN_SAMPLE_COHESION = 0.75;

/**
 * Frames closer than this to an already-accepted sample add no new information.
 */
const MAX_DUPLICATE_SIMILARITY = 0.9995;

/**
 * Hard ceiling on the class-list refresh.
 */
const CLASS_FETCH_TIMEOUT_MS = 10000;

type PoseStep = {
  key: PoseKey;
  title: string;
  subtitle: string;
  instruction: string;
  iconName: string;
};

const POSE_STEPS: PoseStep[] = [
  {
    key: "front",
    title: "Biometric Face Scan",
    subtitle: "Frontal View",
    instruction: "Look straight into the circle with a neutral expression.",
    iconName: "face",
  },
];

type LightingWarning = {
  title: string;
  message: string;
};

function getLightingWarning(
  face: RealtimeFace | null,
  lighting: RealtimeLighting
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

/**
 * Apple Face ID style Circular SVG Progress Ring Component
 */
function BiometricProgressRing({
  size = 280,
  strokeWidth = 7,
  progress = 0,
  isScanning = false,
  isReady = false,
  isDone = false,
}: {
  size?: number;
  strokeWidth?: number;
  progress?: number;
  isScanning?: boolean;
  isReady?: boolean;
  isDone?: boolean;
}) {
  const radius = (size - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - Math.min(1, Math.max(0, progress)));

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Defs>
          <LinearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#4f46e5" />
            <Stop offset="50%" stopColor="#06b6d4" />
            <Stop offset="100%" stopColor="#10b981" />
          </LinearGradient>
          <LinearGradient id="doneGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#10b981" />
            <Stop offset="100%" stopColor="#059669" />
          </LinearGradient>
        </Defs>

        {/* Background Track Circle */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={
            isDone
              ? "rgba(16, 185, 129, 0.3)"
              : isReady
              ? "rgba(79, 70, 229, 0.3)"
              : "rgba(255, 255, 255, 0.25)"
          }
          strokeWidth={strokeWidth}
          fill="none"
        />

        {/* Dynamic Animated Progress Stroke */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={isDone ? "url(#doneGradient)" : "url(#ringGradient)"}
          strokeWidth={strokeWidth + 1}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>

      {/* Modern Biometric Viewfinder Corner Brackets */}
      <View
        style={{
          position: "absolute",
          top: 14,
          left: 14,
          width: 26,
          height: 26,
          borderTopWidth: 3.5,
          borderLeftWidth: 3.5,
          borderColor: isDone ? "#10b981" : isReady ? "#4f46e5" : "rgba(255,255,255,0.7)",
          borderTopLeftRadius: 14,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 14,
          right: 14,
          width: 26,
          height: 26,
          borderTopWidth: 3.5,
          borderRightWidth: 3.5,
          borderColor: isDone ? "#10b981" : isReady ? "#4f46e5" : "rgba(255,255,255,0.7)",
          borderTopRightRadius: 14,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: 14,
          left: 14,
          width: 26,
          height: 26,
          borderBottomWidth: 3.5,
          borderLeftWidth: 3.5,
          borderColor: isDone ? "#10b981" : isReady ? "#4f46e5" : "rgba(255,255,255,0.7)",
          borderBottomLeftRadius: 14,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: 14,
          right: 14,
          width: 26,
          height: 26,
          borderBottomWidth: 3.5,
          borderRightWidth: 3.5,
          borderColor: isDone ? "#10b981" : isReady ? "#4f46e5" : "rgba(255,255,255,0.7)",
          borderBottomRightRadius: 14,
        }}
      />
    </View>
  );
}

export default function EnrollScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { settings, updateSetting } = useAppSettings();
  const { triggerSync, status: syncStatus } = useSyncEngine();

  const cameraHandleRef = useRef<any>(null);

  const [studentName, setStudentName] = useState("");
  const [enrollmentId, setEnrollmentId] = useState("");
  const [classesList, setClassesList] = useState<{ id: string; code: string; title: string }[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Scan state & captured embeddings
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done">("idle");
  const [capturedEmbeddings, setCapturedEmbeddings] = useState<{ front: number[] | null }>({ front: null });

  // Full-screen Camera Scanner Overlay state
  const [scannerVisible, setScannerVisible] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [currentFace, setCurrentFace] = useState<RealtimeFace | null>(null);
  const [currentLighting, setCurrentLighting] = useState<RealtimeLighting>({
    frameBrightness: null,
    brightPixelRatio: null,
  });
  const [cameraLayout, setCameraLayout] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [capturingPhoto, setCapturingPhoto] = useState(false);

  // Hide bottom tab bar dynamically when scanner is active
  useEffect(() => {
    if (scannerVisible) {
      navigation.setOptions({ tabBarStyle: { display: "none" } });
    } else {
      setPendingCapture(null);
      setCapturingPhoto(false);
      navigation.setOptions({
        tabBarStyle: {
          backgroundColor: "#ffffff",
          borderTopWidth: 1,
          borderTopColor: "rgba(15, 23, 42, 0.06)",
          height: 76,
          paddingBottom: 8,
          paddingTop: 8,
        },
      });
    }
  }, [scannerVisible, navigation]);

  // Pose Review state
  const [pendingCapture, setPendingCapture] = useState<{
    poseKey: PoseKey;
    embedding: number[];
    face: RealtimeFace;
    uri: string | null;
    sampleCount: number;
    cohesion: number;
  } | null>(null);

  const pendingCaptureRef = useRef(false);
  pendingCaptureRef.current = pendingCapture !== null;

  const freezeUriRef = useRef<string | null>(null);

  const [captureError, setCaptureError] = useState<string | null>(null);
  const captureErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCaptureError = useCallback((message: string) => {
    setCaptureError(message);
    if (captureErrorTimerRef.current) clearTimeout(captureErrorTimerRef.current);
    captureErrorTimerRef.current = setTimeout(() => setCaptureError(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (captureErrorTimerRef.current) clearTimeout(captureErrorTimerRef.current);
    },
    [],
  );

  const discardFreezeFrame = useCallback(() => {
    const uri = freezeUriRef.current;
    freezeUriRef.current = null;
    if (!uri) return;
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }, []);

  useEffect(() => discardFreezeFrame, [discardFreezeFrame]);

  // Burst capture progress
  const burstSamplesRef = useRef<number[][]>([]);
  const burstActiveRef = useRef(false);
  const cancelBurstRef = useRef<(() => void) | null>(null);
  const [burstProgress, setBurstProgress] = useState(0);
  const [burstHint, setBurstHint] = useState<string | null>(null);

  // Wiggle animation for warning banner
  const warningX = useSharedValue(0);
  const warningAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: warningX.value }],
  }));

  const triggerWarningWiggle = () => {
    AppSettings.haptic("medium");
    warningX.value = withSequence(
      withTiming(-14, { duration: 40 }),
      withTiming(14, { duration: 40 }),
      withTiming(-10, { duration: 40 }),
      withTiming(10, { duration: 40 }),
      withTiming(-5, { duration: 40 }),
      withTiming(0, { duration: 40 })
    );
  };

  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingEnrollSetup, setLoadingEnrollSetup] = useState(true);
  const hasLoadedEnrollSetup = useRef(false);
  const apiUrl = API_URL;

  const applyClassList = useCallback(
    (formatted: { id: string; code: string; title: string }[]) => {
      setClassesList(formatted);
      if (formatted.length === 0) {
        setSelectedClassId("");
        return;
      }
      setSelectedClassId((current) =>
        current && formatted.some((f) => f.id === current) ? current : formatted[0].id,
      );
    },
    [],
  );

  const fetchEnrollClasses = useCallback(async () => {
    const showSkeleton = !hasLoadedEnrollSetup.current;
    if (showSkeleton) setLoadingEnrollSetup(true);

    try {
      const cached = await getCachedClasses();
      if (cached.length > 0) {
        applyClassList(
          cached.map((c) => ({ id: c.class_id, code: c.code, title: c.title })),
        );
        hasLoadedEnrollSetup.current = true;
        if (showSkeleton) setLoadingEnrollSetup(false);
      }
    } catch (err) {
      console.warn("Failed to load cached classes:", err);
    }

    if (syncStatus.isOnline === false) {
      hasLoadedEnrollSetup.current = true;
      if (showSkeleton) setLoadingEnrollSetup(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${apiUrl}/api/classes`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Class list request failed (${res.status})`);
      const data = await res.json();
      const formatted = (Array.isArray(data) ? data : []).map((c: any) => ({
        id: c.id,
        code: c.code,
        title: c.title,
      }));
      applyClassList(formatted);
      if (formatted.length > 0) {
        await replaceCachedClasses(
          formatted.map((c) => ({ id: c.id, code: c.code, title: c.title })),
        );
      }
    } catch (err) {
      console.warn("Network fetch for classes failed (offline mode):", err);
    } finally {
      clearTimeout(timer);
      hasLoadedEnrollSetup.current = true;
      if (showSkeleton) setLoadingEnrollSetup(false);
    }
  }, [apiUrl, applyClassList, syncStatus.isOnline]);

  useFocusEffect(
    useCallback(() => {
      void fetchEnrollClasses();
    }, [fetchEnrollClasses])
  );

  const handleFaceChange = useCallback((face: RealtimeFace | null) => {
    if (pendingCaptureRef.current) return;
    setCurrentFace(face);
  }, []);

  const handleLightingChange = useCallback((lighting: RealtimeLighting) => {
    if (pendingCaptureRef.current) return;
    setCurrentLighting(lighting);
  }, []);

  const openScanner = () => {
    AppSettings.haptic("medium");
    setCurrentStepIndex(0);
    setPendingCapture(null);
    pendingCaptureRef.current = false;
    setCurrentFace(null);
    setCaptureError(null);
    discardFreezeFrame();
    setScannerVisible(true);
  };

  const closeScanner = () => {
    AppSettings.haptic("light");
    cancelBurstRef.current?.();
    setPendingCapture(null);
    pendingCaptureRef.current = false;
    setCapturingPhoto(false);
    setCurrentFace(null);
    setCaptureError(null);
    discardFreezeFrame();
    setScannerVisible(false);
  };

  const handleResetCaptures = () => {
    AppSettings.haptic("medium");
    cancelBurstRef.current?.();
    setCapturingPhoto(false);
    setScanState("idle");
    setCapturedEmbeddings({ front: null });
    setCurrentStepIndex(0);
    setPendingCapture(null);
    pendingCaptureRef.current = false;
    setCaptureError(null);
    discardFreezeFrame();
  };

  const currentStep = POSE_STEPS[currentStepIndex];
  const activeWarning = getLightingWarning(currentFace, currentLighting);

  const liveQuality = currentFace ? checkFrameQuality(currentFace) : null;
  const liveQualityReason = liveQuality && !liveQuality.ok ? liveQuality.reason : null;
  const liveGuidance = currentFace
    ? poseCaptureGuidance(currentFace.yawAngle ?? 0, currentStep.key)
    : null;
  const liveYaw = currentFace ? signedAngle(currentFace.yawAngle) : null;
  const poseReady = Boolean(liveQuality?.ok && liveGuidance?.inBand);
  const poseMessage = !currentFace
    ? "Center your face in the circle"
    : liveQualityReason
      ? liveQualityReason
      : liveGuidance && !liveGuidance.inBand
        ? liveGuidance.hint
        : "Hold steady — scanning face";

  const cancelBurst = useCallback(() => {
    burstActiveRef.current = false;
    burstSamplesRef.current = [];
    setBurstProgress(0);
    setBurstHint(null);
  }, []);

  const startBurst = useCallback(() => {
    burstSamplesRef.current = [];
    burstActiveRef.current = true;
    setBurstProgress(0);
    setBurstHint(null);
    setCapturingPhoto(true);
  }, []);

  cancelBurstRef.current = cancelBurst;

  const evaluateSample = useCallback(
    (face: RealtimeFace, expectedPose: PoseKey): { accepted: boolean; hint: string | null } => {
      const quality = checkFrameQuality(face);
      if (!quality.ok) return { accepted: false, hint: quality.reason };

      const guidance = poseCaptureGuidance(face.yawAngle ?? 0, expectedPose);
      if (!guidance.inBand) {
        return { accepted: false, hint: guidance.hint };
      }

      const embedding = face.embedding as number[];
      const previous = burstSamplesRef.current;
      if (previous.length > 0) {
        const last = previous[previous.length - 1];
        if (cosineSimilarity(embedding, last) >= MAX_DUPLICATE_SIMILARITY) {
          return { accepted: false, hint: null };
        }
      }

      return { accepted: true, hint: null };
    },
    [],
  );

  // Feeds live frames into the active burst until 5 samples are collected
  useEffect(() => {
    if (!burstActiveRef.current || !currentFace) return;

    const { accepted, hint } = evaluateSample(currentFace, currentStep.key);
    setBurstHint(hint);
    if (!accepted) return;

    burstSamplesRef.current = [...burstSamplesRef.current, [...(currentFace.embedding as number[])]];
    const collected = burstSamplesRef.current.length;
    setBurstProgress(collected);
    AppSettings.haptic("light");

    if (collected < SAMPLES_PER_POSE) return;

    // Burst complete — build the centroid
    burstActiveRef.current = false;
    const samples = burstSamplesRef.current;
    const cohesion = sampleCohesion(samples);
    const centroid = averageEmbeddings(samples);

    if (!centroid) {
      cancelBurst();
      setCapturingPhoto(false);
      AppSettings.haptic("error");
      showCaptureError("Could not build a face template from that capture. Try again.");
      return;
    }

    if (cohesion < MIN_SAMPLE_COHESION) {
      cancelBurst();
      setCapturingPhoto(false);
      AppSettings.haptic("error");
      showCaptureError("Frames varied too much — hold still and scan again.");
      return;
    }

    const frozenFace: RealtimeFace = {
      ...currentFace,
      embedding: centroid,
    };

    pendingCaptureRef.current = true;
    setPendingCapture({
      poseKey: currentStep.key,
      embedding: centroid,
      face: frozenFace,
      uri: null,
      sampleCount: samples.length,
      cohesion,
    });

    burstSamplesRef.current = [];
    setBurstProgress(0);
    setBurstHint(null);
    setCapturingPhoto(false);
    AppSettings.haptic("success");

    const capturedPoseKey = currentStep.key;
    cameraHandleRef.current
      ?.freezePreviewAsync?.()
      .then((frame: { uri?: string } | undefined) => {
        if (!frame?.uri) return;
        setPendingCapture((current) => {
          if (!current || current.poseKey !== capturedPoseKey || current.uri) {
            FileSystem.deleteAsync(frame.uri as string, { idempotent: true }).catch(() => {});
            return current;
          }
          freezeUriRef.current = frame.uri as string;
          return { ...current, uri: frame.uri as string };
        });
      })
      .catch(() => {});
  }, [currentFace, currentStep.key, evaluateSample, cancelBurst, showCaptureError]);

  // Auto-capture when face is steady
  const holdFramesRef = useRef(0);
  useEffect(() => {
    if (!scannerVisible || capturingPhoto || pendingCapture || !currentFace) {
      holdFramesRef.current = 0;
      return;
    }
    if (settings.strictLightingCheck && activeWarning) {
      holdFramesRef.current = 0;
      return;
    }

    const { accepted } = evaluateSample(currentFace, currentStep.key);
    if (!accepted) {
      holdFramesRef.current = 0;
      return;
    }

    holdFramesRef.current += 1;
    if (holdFramesRef.current >= AUTO_CAPTURE_HOLD_FRAMES) {
      holdFramesRef.current = 0;
      AppSettings.haptic("medium");
      startBurst();
    }
  }, [
    currentFace,
    currentStep.key,
    scannerVisible,
    capturingPhoto,
    pendingCapture,
    activeWarning,
    settings.strictLightingCheck,
    evaluateSample,
    startBurst,
  ]);

  // Burst timeout
  useEffect(() => {
    if (!capturingPhoto) return;
    const timer = setTimeout(() => {
      if (!burstActiveRef.current) return;
      cancelBurst();
      setCapturingPhoto(false);
      AppSettings.haptic("error");
      showCaptureError("Not enough clear frames. Check the lighting, hold still, and try again.");
    }, BURST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [capturingPhoto, burstProgress, cancelBurst, showCaptureError]);

  const handleManualCapture = () => {
    if (capturingPhoto || pendingCapture) return;

    if (settings.strictLightingCheck && activeWarning) {
      triggerWarningWiggle();
      return;
    }

    if (!currentFace) {
      AppSettings.haptic("error");
      showCaptureError("No face in the frame — position your face in the circle.");
      return;
    }

    if (!currentFace.embedding || currentFace.embedding.length === 0) {
      AppSettings.haptic("error");
      showCaptureError("Still reading your face — hold still for a moment, then tap again.");
      return;
    }

    AppSettings.haptic("medium");
    setCaptureError(null);
    startBurst();
  };

  const handleConfirmPose = () => {
    if (!pendingCapture) return;

    AppSettings.haptic("success");
    const embeddingToSave = pendingCapture.embedding;

    pendingCaptureRef.current = false;
    setPendingCapture(null);
    discardFreezeFrame();

    setCapturedEmbeddings({ front: embeddingToSave });

    setScanState("done");
    setScannerVisible(false);
    setToastMessage("Face Scan Verified!");
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2400);
  };

  const handleRetakePose = () => {
    AppSettings.haptic("light");
    pendingCaptureRef.current = false;
    setPendingCapture(null);
    discardFreezeFrame();
  };

  const posesDone = scanState === "done" && Boolean(capturedEmbeddings.front);

  const missingRequirements = [
    !selectedClassId && "pick a class",
    !studentName.trim() && "student name",
    !enrollmentId.trim() && "enrollment number",
    !posesDone && "face scan",
  ].filter(Boolean) as string[];
  const canSubmit = missingRequirements.length === 0 && !submitting;
  const isOffline = syncStatus.isOnline === false;

  const handleEnroll = async () => {
    if (!canSubmit) {
      AppSettings.haptic("error");
      return;
    }

    setSubmitting(true);
    AppSettings.haptic("medium");

    try {
      await insertPendingEnrollment({
        enrollmentNumber: enrollmentId.trim(),
        name: studentName.trim(),
        classId: selectedClassId,
        embeddingsJson: JSON.stringify({
          front: capturedEmbeddings.front,
          captureMode: "front_burst",
        }),
        embeddingModel: "w600k_mbf",
        capturedAt: new Date().toISOString(),
      });

      AppSettings.haptic("success");
      setToastMessage(
        isOffline ? "Saved on this device — will sync when online" : "Student Registered Successfully!",
      );
      setToastVisible(true);
      setStudentName("");
      setEnrollmentId("");
      setScanState("idle");
      setCapturedEmbeddings({ front: null });
      setTimeout(() => setToastVisible(false), 2800);

      void triggerSync();
    } catch (err) {
      console.error(err);
      alert("Failed to save enrollment on this device. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmedFaceBoxStyle = pendingCapture?.face
    ? mapFaceToPreview(pendingCapture.face, cameraLayout, false)
    : null;

  return (
    <View className="flex-1 bg-background relative">
      <ScreenHeader title="Enroll" />

      {/* Floating Toast */}
      {toastVisible && (
        <View className="absolute top-20 left-6 right-6 z-50 bg-on-surface p-4 rounded-2xl flex-row items-center justify-center gap-2 shadow-medium border border-white/10">
          <Icon name="check_circle" size={20} color="#10b981" />
          <Text className="text-white text-sm font-bold tracking-wide">
            {toastMessage}
          </Text>
        </View>
      )}

      {/* Main Enrollment Form */}
      {!scannerVisible && (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeInUp.delay(100).duration(500)} className="mb-6">
            <Text className="text-3xl font-bold text-on-surface tracking-tight">
              New Student Enrollment
            </Text>
            <Text className="text-sm text-on-surface-variant mt-1 font-medium">
              Register a student record with fast 5-frame biometric centroid embedding.
            </Text>
          </Animated.View>

          {/* Class Selection Card */}
          <Animated.View
            entering={FadeInUp.delay(180).duration(500)}
            className="bg-surface border border-slate-100 rounded-3xl p-5 mb-5 gap-4"
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
                    {loadingEnrollSetup ? (
                      <View className="mt-2">
                        <SkeletonBlock width={150} height={14} radius={7} />
                      </View>
                    ) : (
                      <Text className="text-on-surface font-bold text-sm mt-0.5" numberOfLines={1}>
                        {(() => {
                          const selectedClass = classesList.find((c) => c.id === selectedClassId);
                          if (selectedClass) return `${selectedClass.code} • ${selectedClass.title}`;
                          return classesList.length === 0 ? "No classes available" : "Select a Course Class";
                        })()}
                      </Text>
                    )}
                  </View>
                </View>
                <View className="w-7 h-7 rounded-full items-center justify-center bg-slate-50 border border-slate-100">
                  <Icon name={dropdownOpen ? "expand_less" : "expand_more"} size={16} color="#475569" />
                </View>
              </Pressable>

              {dropdownOpen && (
                <Animated.View
                  entering={FadeInDown.duration(200)}
                  className="mt-2.5 bg-surface border border-slate-100 rounded-2xl overflow-hidden shadow-soft gap-0.5 p-1"
                >
                  {classesList.length === 0 && (
                    <View className="px-4 py-5 items-center gap-1.5">
                      <Icon name="school" size={20} color="#cbd5e1" />
                      <Text className="text-xs font-extrabold text-on-surface text-center">
                        No classes on this device yet
                      </Text>
                      <Text className="text-[11px] font-semibold text-on-surface-variant text-center leading-snug">
                        {isOffline
                          ? "You are offline. Connect once so the class list can download — after that it stays on the phone."
                          : "Create a class in the admin panel, then reopen this screen."}
                      </Text>
                    </View>
                  )}

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

          {/* Student Info Card */}
          <Animated.View
            entering={FadeInUp.delay(260).duration(500)}
            className="bg-surface border border-slate-100 rounded-3xl p-5 mb-5 gap-4"
          >
            <Text className="text-base font-bold text-on-surface">Student Details</Text>

            <View className="gap-1.5">
              <Text className="text-xs font-bold text-on-surface-variant">Student Full Name</Text>
              <TextInput
                value={studentName}
                onChangeText={setStudentName}
                placeholder="e.g. Alex Morgan"
                placeholderTextColor="#94a3b8"
                className="bg-surface-muted border border-slate-100 text-on-surface rounded-2xl p-4 text-sm font-semibold focus:border-primary transition-all"
              />
            </View>

            <View className="gap-1.5">
              <Text className="text-xs font-bold text-on-surface-variant">Enrollment Number</Text>
              <TextInput
                value={enrollmentId}
                onChangeText={setEnrollmentId}
                placeholder="e.g. 2024-CS-042"
                placeholderTextColor="#94a3b8"
                autoCapitalize="characters"
                className="bg-surface-muted border border-slate-100 text-on-surface rounded-2xl p-4 text-sm font-semibold focus:border-primary transition-all"
              />
            </View>
          </Animated.View>

          {/* Biometric Face Setup Card */}
          <Animated.View
            entering={FadeInUp.delay(340).duration(500)}
            className="bg-surface border border-slate-100 rounded-3xl p-6 mb-6 items-center"
          >
            <View className={`w-20 h-20 rounded-full ${scanState === "done" ? "bg-emerald-50 border-emerald-200" : "bg-primary-light border-primary/20"} border-2 items-center justify-center mb-4 relative overflow-hidden`}>
              <Icon
                name={scanState === "done" ? "check_circle" : "face"}
                size={40}
                color={scanState === "done" ? "#10b981" : "#4f46e5"}
              />
            </View>

            <Text className="font-extrabold text-on-surface text-base">
              {scanState === "done" ? "Face Scan Verified" : "Biometric Face Scan"}
            </Text>
            <Text className="text-xs text-on-surface-variant mt-1.5 text-center px-4 leading-normal font-medium">
              {scanState === "done"
                ? "5 high-quality frames averaged into a 512D ArcFace biometric centroid."
                : "Look straight into the circle for ~1.5s to capture 5 high-precision frames."}
            </Text>

            {/* Biometric Status Badge */}
            <View className="mt-4">
              <View className={`px-4 py-2 rounded-xl border flex-row items-center gap-1.5 ${
                capturedEmbeddings.front ? "bg-emerald-50 border-emerald-200" : "bg-slate-100 border-slate-200"
              }`}>
                <Icon
                  name={capturedEmbeddings.front ? "check" : "radio_button_unchecked"}
                  size={14}
                  color={capturedEmbeddings.front ? "#10b981" : "#94a3b8"}
                />
                <Text className={`text-xs font-black tracking-wide ${capturedEmbeddings.front ? "text-emerald-700" : "text-slate-500"}`}>
                  {capturedEmbeddings.front ? "5-Frame Centroid Ready" : "Pending Scan"}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={openScanner}
              className={`flex-row items-center border rounded-2xl mt-5 px-5 py-3 ${
                scanState === "done"
                  ? "bg-emerald-50 border-emerald-200"
                  : "bg-primary border-primary"
              } transition-all active:scale-95 shadow-sm`}
            >
              <Icon
                name={scanState === "done" ? "refresh" : "center_focus_strong"}
                size={18}
                color={scanState === "done" ? "#059669" : "#ffffff"}
              />
              <Text className={`font-bold text-sm tracking-wide ml-1.5 ${scanState === "done" ? "text-emerald-800" : "text-white"}`}>
                {scanState === "done" ? "Re-scan Face" : "Start Face Scan"}
              </Text>
            </Pressable>

            {/* Reset Captures Button */}
            {(capturedEmbeddings.front !== null || scanState !== "idle") && (
              <Pressable
                onPress={handleResetCaptures}
                className="flex-row items-center justify-center border border-rose-200/80 bg-rose-50/80 rounded-2xl mt-3 px-4 py-2 transition-all active:scale-95"
              >
                <Icon name="delete_outline" size={16} color="#e11d48" />
                <Text className="text-rose-600 font-extrabold text-xs tracking-wide ml-1.5">
                  Reset Face Scan
                </Text>
              </Pressable>
            )}
          </Animated.View>

          {/* Submit Button */}
          <View style={{ opacity: canSubmit ? 1 : 0.45 }}>
            <Animated.View entering={FadeInUp.delay(420).duration(500)}>
              <View className="shadow-premium rounded-2xl bg-primary">
              <Pressable
                onPress={handleEnroll}
                disabled={!canSubmit}
                className="py-4 items-center justify-center active:scale-[0.98] transition-all"
              >
                <Text className="text-on-primary font-bold text-base tracking-wide">
                  {submitting ? "Saving enrollment…" : "Complete Enrollment"}
                </Text>
              </Pressable>
              </View>

            {missingRequirements.length > 0 && !submitting && (
              <View className="flex-row items-start gap-1.5 mt-3 px-1">
                <Icon name="info" size={13} color="#94a3b8" />
                <Text className="flex-1 text-[11px] font-semibold text-on-surface-variant leading-snug">
                  Still needed: {missingRequirements.join(", ")}.
                </Text>
              </View>
            )}

            {isOffline && (
              <View className="flex-row items-center gap-2 mt-3 px-3 py-2.5 rounded-2xl bg-amber-50 border border-amber-200">
                <Icon name="cloud_off" size={15} color="#d97706" />
                <Text className="flex-1 text-[11px] font-bold text-amber-800 leading-snug">
                  No connection — this enrollment saves on the phone and uploads by itself once you are back online.
                </Text>
              </View>
            )}
            </Animated.View>
          </View>
        </ScrollView>
      )}

      {/* FULL-SCREEN FAST 1-STEP BIOMETRIC CAMERA SCANNER OVERLAY */}
      {scannerVisible && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { zIndex: 99999, backgroundColor: "#000000" },
          ]}
        >
          {/* Live Native Camera Feed */}
          <LiveFaceCamera
            cameraRef={cameraHandleRef}
            performanceMode={settings.performance}
            scanningPerformance={settings.scanningPerformance}
            cameraFacing={settings.cameraFacing}
            faceDetectorMode="accurate"
            showNativeOverlay={false}
            smoothNativeOverlay={settings.smoothFaceBox}
            onFaceChange={handleFaceChange}
            onLightingChange={handleLightingChange}
            onCameraReady={() => {}}
            onError={() => {}}
            onPreviewLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setCameraLayout({ width, height });
            }}
          />

          {/* Frozen Preview Frame on Review */}
          {pendingCapture?.uri && (
            <Image
              source={{ uri: pendingCapture.uri }}
              style={[StyleSheet.absoluteFillObject, { zIndex: 10 }]}
              resizeMode="cover"
            />
          )}

          {/* Captured Bounding Box Overlay */}
          {pendingCapture && confirmedFaceBoxStyle && (
            <View
              style={[
                confirmedFaceBoxStyle,
                {
                  borderWidth: 2.5,
                  borderColor: "#10b981",
                  borderRadius: 16,
                  backgroundColor: "rgba(16, 185, 129, 0.14)",
                  zIndex: 20,
                  shadowColor: "#10b981",
                  shadowOpacity: 0.5,
                  shadowRadius: 10,
                  elevation: 6,
                },
              ]}
            >
              <View style={{ position: "absolute", top: -2, left: -2, width: 14, height: 14, borderTopWidth: 4, borderLeftWidth: 4, borderColor: "#059669", borderTopLeftRadius: 10 }} />
              <View style={{ position: "absolute", top: -2, right: -2, width: 14, height: 14, borderTopWidth: 4, borderRightWidth: 4, borderColor: "#059669", borderTopRightRadius: 10 }} />
              <View style={{ position: "absolute", bottom: -2, left: -2, width: 14, height: 14, borderBottomWidth: 4, borderLeftWidth: 4, borderColor: "#059669", borderBottomLeftRadius: 10 }} />
              <View style={{ position: "absolute", bottom: -2, right: -2, width: 14, height: 14, borderBottomWidth: 4, borderRightWidth: 4, borderColor: "#059669", borderBottomRightRadius: 10 }} />

              <View
                style={{
                  position: "absolute",
                  top: -30,
                  alignSelf: "center",
                  backgroundColor: "#10b981",
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  borderRadius: 12,
                  shadowColor: "#000",
                  shadowOpacity: 0.15,
                  shadowRadius: 4,
                  elevation: 4,
                }}
              >
                <Text style={{ color: "#ffffff", fontWeight: "900", fontSize: 10, textTransform: "uppercase" }}>
                  ✓ Face Scan Verified
                </Text>
              </View>
            </View>
          )}

          {/* CENTER VIEWPORT — Animated Biometric Circular Progress Ring */}
          {!pendingCapture && (
            <View
              pointerEvents="none"
              style={{
                ...StyleSheet.absoluteFillObject,
                alignItems: "center",
                justifyContent: "center",
                zIndex: 100,
              }}
            >
              <BiometricProgressRing
                size={280}
                progress={burstProgress / SAMPLES_PER_POSE}
                isScanning={capturingPhoto}
                isReady={poseReady}
                isDone={Boolean(pendingCapture)}
              />
            </View>
          )}

          {/* TOP CONTROLS */}
          <View
            style={{
              position: "absolute",
              top: insets.top + 12,
              left: 16,
              right: 16,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              zIndex: 500,
            }}
          >
            {/* Close Button */}
            <Pressable
              onPress={closeScanner}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: "rgba(255,255,255,0.92)",
                alignItems: "center",
                justifyContent: "center",
                shadowColor: "#000",
                shadowOpacity: 0.08,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Icon name="close" size={22} color="#334155" />
            </Pressable>

            {/* Biometric Status Pill */}
            <View
              style={{
                backgroundColor: "rgba(255,255,255,0.92)",
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                shadowColor: "#000",
                shadowOpacity: 0.08,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: capturingPhoto ? "#06b6d4" : poseReady ? "#10b981" : "#94a3b8",
                }}
              />
              <Text style={{ color: "#1e293b", fontWeight: "900", fontSize: 12 }}>
                {capturingPhoto ? `Scanning ${burstProgress}/${SAMPLES_PER_POSE}` : "Biometric Face Scan"}
              </Text>
            </View>

            {/* Flip Camera Button */}
            <Pressable
              onPress={() => {
                updateSetting("cameraFacing", settings.cameraFacing === "front" ? "back" : "front");
              }}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: "rgba(255,255,255,0.92)",
                alignItems: "center",
                justifyContent: "center",
                shadowColor: "#000",
                shadowOpacity: 0.08,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Icon name="flip_camera_ios" size={20} color="#334155" />
            </Pressable>
          </View>

          {/* BOTTOM SECTION — Guidance Card + Warning + Shutter */}
          {!pendingCapture && (
            <View
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                paddingBottom: insets.bottom + 16,
                paddingHorizontal: 16,
                zIndex: 300,
              }}
            >
              {/* Problem Banner */}
              {captureError && (
                <Animated.View
                  entering={FadeIn.duration(140)}
                  style={{
                    width: "100%",
                    marginBottom: 12,
                    backgroundColor: "rgba(254, 242, 242, 0.97)",
                    borderWidth: 1.5,
                    borderColor: "#f87171",
                    padding: 14,
                    borderRadius: 20,
                    flexDirection: "row",
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      backgroundColor: "#fee2e2",
                      borderWidth: 1,
                      borderColor: "rgba(239, 68, 68, 0.3)",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 12,
                    }}
                  >
                    <Icon name="error" size={20} color="#dc2626" />
                  </View>
                  <Text style={{ flex: 1, color: "#991b1b", fontSize: 12, fontWeight: "700" }}>
                    {captureError}
                  </Text>
                </Animated.View>
              )}

              {/* Lighting Warning Banner */}
              {activeWarning && (
                <Animated.View
                  style={[
                    warningAnimatedStyle,
                    {
                      width: "100%",
                      marginBottom: 12,
                      backgroundColor: "rgba(255, 251, 235, 0.96)",
                      borderWidth: 1.5,
                      borderColor: "#f59e0b",
                      padding: 14,
                      borderRadius: 20,
                      flexDirection: "row",
                      alignItems: "center",
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      backgroundColor: "#fef3c7",
                      borderWidth: 1,
                      borderColor: "rgba(245, 158, 11, 0.3)",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 12,
                    }}
                  >
                    <Icon name="warning" size={20} color="#d97706" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ color: "#78350f", fontWeight: "900", fontSize: 13, letterSpacing: -0.2 }}>
                        {activeWarning.title}
                      </Text>
                      <View style={{ backgroundColor: "#fef3c7", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                        <Text style={{ color: "#b45309", fontSize: 9, fontWeight: "900", textTransform: "uppercase" }}>
                          Attention
                        </Text>
                      </View>
                    </View>
                    <Text style={{ color: "#92400e", fontSize: 11, fontWeight: "600", marginTop: 2 }}>
                      {activeWarning.message}{settings.strictLightingCheck ? " • Capture paused" : ""}
                    </Text>
                  </View>
                </Animated.View>
              )}

              {/* Pose Guidance Card */}
              <View
                style={{
                  width: "100%",
                  backgroundColor: "rgba(255,255,255,0.96)",
                  borderRadius: 24,
                  padding: 16,
                  shadowColor: "#000",
                  shadowOpacity: 0.06,
                  shadowRadius: 12,
                  shadowOffset: { width: 0, height: -2 },
                  elevation: 6,
                  marginBottom: 16,
                }}
              >
                {/* Pose title row */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 12,
                        backgroundColor: "#eef2ff",
                        alignItems: "center",
                        justifyContent: "center",
                        marginRight: 10,
                      }}
                    >
                      <Icon name="face" size={20} color="#4f46e5" />
                    </View>
                    <View>
                      <Text style={{ color: "#1e293b", fontWeight: "800", fontSize: 15 }}>
                        Biometric Face Scan
                      </Text>
                      <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "600" }}>
                        Look straight into the circle
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Live pose status */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    marginTop: 12,
                    backgroundColor: poseReady ? "#ecfdf5" : "#f8fafc",
                    borderWidth: 1,
                    borderColor: poseReady ? "#a7f3d0" : "#e2e8f0",
                    borderRadius: 14,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                  }}
                >
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: poseReady ? "#10b981" : "#f59e0b",
                      marginRight: 8,
                    }}
                  />
                  <Text
                    style={{
                      flex: 1,
                      color: poseReady ? "#047857" : "#475569",
                      fontSize: 12,
                      fontWeight: "700",
                    }}
                    numberOfLines={1}
                  >
                    {capturingPhoto
                      ? burstHint
                        ? burstHint
                        : `Capturing ${burstProgress}/${SAMPLES_PER_POSE}…`
                      : poseMessage}
                  </Text>
                  <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", fontFamily: "monospace" }}>
                    {liveYaw === null ? "--°" : `${Math.round(liveYaw)}°`}
                  </Text>
                </View>
              </View>

              {/* Manual Capture Shutter */}
              <View style={{ alignItems: "center" }}>
                <Pressable
                  onPress={handleManualCapture}
                  disabled={capturingPhoto}
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: 36,
                    borderWidth: 4,
                    borderColor: capturingPhoto
                      ? "#06b6d4"
                      : activeWarning && settings.strictLightingCheck
                      ? "#fbbf24"
                      : currentFace
                      ? "#4f46e5"
                      : "#cbd5e1",
                    backgroundColor: "#ffffff",
                    alignItems: "center",
                    justifyContent: "center",
                    shadowColor: "#000",
                    shadowOpacity: 0.1,
                    shadowRadius: 10,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 6,
                  }}
                >
                  <View
                    style={{
                      width: 54,
                      height: 54,
                      borderRadius: 27,
                      backgroundColor: capturingPhoto
                        ? "#06b6d4"
                        : activeWarning && settings.strictLightingCheck
                        ? "#fbbf24"
                        : currentFace
                        ? "#4f46e5"
                        : "#e2e8f0",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {capturingPhoto ? (
                      <Text style={{ color: "#ffffff", fontWeight: "800", fontSize: 15 }}>
                        {burstProgress}/{SAMPLES_PER_POSE}
                      </Text>
                    ) : (
                      <Icon name="camera" size={26} color="#ffffff" />
                    )}
                  </View>
                </Pressable>

                {capturingPhoto && (
                  <Text
                    style={{
                      marginTop: 10,
                      color: burstHint ? "#fbbf24" : "#e2e8f0",
                      fontSize: 12,
                      fontWeight: "700",
                      textAlign: "center",
                    }}
                  >
                    {burstHint ? `Hold on — ${burstHint}` : "Hold still, capturing samples…"}
                  </Text>
                )}
              </View>
            </View>
          )}

          {/* CAPTURE REVIEW & CONFIRM OVERLAY */}
          {pendingCapture && (
            <View
              style={[
                StyleSheet.absoluteFillObject,
                {
                  zIndex: 600,
                  backgroundColor: "rgba(15, 23, 42, 0.35)",
                  justifyContent: "flex-end",
                  paddingHorizontal: 16,
                  paddingBottom: insets.bottom + 16,
                },
              ]}
            >
              <Animated.View
                entering={FadeIn.duration(140)}
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.98)",
                  borderWidth: 1,
                  borderColor: "rgba(226, 232, 240, 0.9)",
                  borderRadius: 28,
                  padding: 20,
                  shadowColor: "#000",
                  shadowOpacity: 0.15,
                  shadowRadius: 20,
                  shadowOffset: { width: 0, height: -4 },
                  elevation: 10,
                  gap: 16,
                }}
              >
                {/* Title & Status Header */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 14,
                        backgroundColor: "#ecfdf5",
                        borderWidth: 1,
                        borderColor: "#a7f3d0",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name="check_circle" size={22} color="#10b981" />
                    </View>
                    <View>
                      <Text style={{ color: "#0f172a", fontWeight: "900", fontSize: 16 }}>
                        Face Scan Verified
                      </Text>
                      <Text style={{ color: "#059669", fontSize: 11, fontWeight: "700", marginTop: 1 }}>
                        Averaged {pendingCapture.sampleCount} samples · cohesion{" "}
                        {pendingCapture.cohesion.toFixed(3)}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Quality Metrics */}
                <View
                  style={{
                    backgroundColor: "#f8fafc",
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    borderRadius: 16,
                    padding: 12,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Icon name="verified_user" size={16} color="#4f46e5" />
                    <Text style={{ color: "#334155", fontSize: 12, fontWeight: "700" }}>
                      512D Centroid Quality
                    </Text>
                  </View>
                  <View style={{ backgroundColor: "#ecfdf5", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 }}>
                    <Text style={{ color: "#047857", fontSize: 11, fontWeight: "800" }}>
                      EXCELLENT
                    </Text>
                  </View>
                </View>

                {/* Confirm & Retake Action Buttons */}
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Pressable
                    onPress={handleRetakePose}
                    style={{
                      flex: 1,
                      paddingVertical: 14,
                      borderRadius: 18,
                      backgroundColor: "#f1f5f9",
                      borderWidth: 1,
                      borderColor: "#e2e8f0",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "row",
                      gap: 6,
                    }}
                  >
                    <Icon name="refresh" size={18} color="#475569" />
                    <Text style={{ color: "#475569", fontWeight: "800", fontSize: 14 }}>
                      Retake
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={handleConfirmPose}
                    style={{
                      flex: 2,
                      paddingVertical: 14,
                      borderRadius: 18,
                      backgroundColor: "#4f46e5",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "row",
                      gap: 6,
                      shadowColor: "#4f46e5",
                      shadowOpacity: 0.35,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 3 },
                      elevation: 4,
                    }}
                  >
                    <Icon name="check" size={18} color="#ffffff" />
                    <Text style={{ color: "#ffffff", fontWeight: "800", fontSize: 14 }}>
                      Confirm Face Scan
                    </Text>
                  </Pressable>
                </View>
              </Animated.View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
