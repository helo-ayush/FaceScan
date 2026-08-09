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
  LayoutChangeEvent,
} from "react-native";
import { useFocusEffect, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeInUp,
  FadeInDown,
  SlideInDown,
  SlideOutDown,
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { LiveFaceCamera, RealtimeFace, RealtimeLighting } from "@/components/LiveFaceCamera";
import { AppSettings, useAppSettings } from "@/utils/settings";
import { useFaceDetection } from "@infinitered/react-native-mlkit-face-detection";
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

/**
 * How many distinct, quality-checked frames to average into each pose template.
 * A single frame carries whatever noise that instant had; averaging several and
 * re-normalizing produces a centroid that sits much closer to the true identity,
 * which is what widens the gap between the right person and a lookalike.
 */
const SAMPLES_PER_POSE = 6;

/**
 * Give up on a burst if no new sample is accepted within this window. The timer
 * restarts on every accepted sample, so a slow-but-progressing capture is never
 * cut off — only a genuinely stuck one.
 */
const BURST_TIMEOUT_MS = 15000;

/**
 * Consecutive good frames in the target pose before capture starts on its own.
 * Holding a 45-degree turn while reaching for a shutter button moves your head,
 * so the capture starts itself once the pose is steady.
 */
const AUTO_CAPTURE_HOLD_FRAMES = 3;

/**
 * Minimum mean pairwise similarity within a pose's samples. If the frames
 * disagree this much with each other, the pose drifted mid-capture or the crops
 * were poor, and averaging them would produce a blurred, less discriminative
 * template.
 */
const MIN_SAMPLE_COHESION = 0.75;

/**
 * Frames closer than this to an already-accepted sample add no new information.
 * The native pipeline re-emits its cached embedding on throttled frames, so
 * without this check a burst could average the same vector several times over.
 */
const MAX_DUPLICATE_SIMILARITY = 0.9995;

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
    title: "1. Front Face",
    subtitle: "Frontal View",
    instruction: "Look straight into the camera lens with a neutral expression.",
    iconName: "face",
  },
  {
    key: "left45",
    title: "2. Left 45° Pose",
    subtitle: "Left Angle",
    instruction: "Slightly turn your head to the left (~45 degrees).",
    iconName: "turn_left",
  },
  {
    key: "right45",
    title: "3. Right 45° Pose",
    subtitle: "Right Angle",
    instruction: "Slightly turn your head to the right (~45 degrees).",
    iconName: "turn_right",
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

export default function EnrollScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { settings, updateSetting } = useAppSettings();
  const faceDetector = useFaceDetection();

  const cameraHandleRef = useRef<any>(null);

  const [studentName, setStudentName] = useState("");
  const [enrollmentId, setEnrollmentId] = useState("");
  const [classesList, setClassesList] = useState<{ id: string; code: string; title: string }[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Scan state & captured embeddings
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done">("idle");
  const [capturedEmbeddings, setCapturedEmbeddings] = useState<Record<PoseKey, number[] | null>>({
    front: null,
    left45: null,
    right45: null,
  });

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

  // Hide bottom tab bar dynamically when scanner is active & clean up stale captures
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
    /** How many frames were averaged into `embedding`. */
    sampleCount: number;
    /** Mean pairwise similarity of those frames — higher is a tighter capture. */
    cohesion: number;
  } | null>(null);

  // Burst capture progress. Samples accumulate in a ref because they are fed by
  // the camera callback and must not trigger a re-render per frame.
  const burstSamplesRef = useRef<number[][]>([]);
  const burstActiveRef = useRef(false);
  // Lets the scanner close/reset handlers (declared above the burst logic) abort
  // an in-flight burst without a forward reference.
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

  const openScanner = () => {
    AppSettings.haptic("medium");
    // Resume on first uncaptured pose if partial progress exists
    const firstUncaptured = POSE_STEPS.findIndex((step) => !capturedEmbeddings[step.key]);
    setCurrentStepIndex(firstUncaptured !== -1 ? firstUncaptured : 0);
    setPendingCapture(null);
    setCurrentFace(null);
    setScannerVisible(true);
  };

  const closeScanner = () => {
    AppSettings.haptic("light");
    cancelBurstRef.current?.();
    setPendingCapture(null);
    setCapturingPhoto(false);
    setScannerVisible(false);
  };

  const handleResetCaptures = () => {
    AppSettings.haptic("medium");
    cancelBurstRef.current?.();
    setCapturingPhoto(false);
    setScanState("idle");
    setCapturedEmbeddings({
      front: null,
      left45: null,
      right45: null,
    });
    setCurrentStepIndex(0);
    setPendingCapture(null);
  };

  const currentStep = POSE_STEPS[currentStepIndex];
  const activeWarning = getLightingWarning(currentFace, currentLighting);

  // Live pose readout, so the person can see what the device thinks their head
  // is doing instead of guessing why capture will not start.
  const liveQuality = currentFace ? checkFrameQuality(currentFace) : null;
  const liveQualityReason = liveQuality && !liveQuality.ok ? liveQuality.reason : null;
  const liveGuidance = currentFace
    ? poseCaptureGuidance(currentFace.yawAngle ?? 0, currentStep.key)
    : null;
  const liveYaw = currentFace ? signedAngle(currentFace.yawAngle) : null;
  const poseReady = Boolean(liveQuality?.ok && liveGuidance?.inBand);
  const poseMessage = !currentFace
    ? "Position your face in the frame"
    : liveQualityReason
      ? liveQualityReason
      : liveGuidance && !liveGuidance.inBand
        ? liveGuidance.hint
        : "Hold still — starting capture";

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

  /**
   * Accepts or rejects a single live frame as a sample for the pose being
   * captured. Returns a hint describing why a frame was skipped, so the student
   * gets told what to fix instead of the burst silently stalling.
   */
  const evaluateSample = useCallback(
    (face: RealtimeFace, expectedPose: PoseKey): { accepted: boolean; hint: string | null } => {
      // Enrollment creates the permanent identity template. Never create one
      // from a presentation that the existing passive liveness pipeline has
      // not confirmed, otherwise a screen/print can be enrolled as a person.
      if (settings.antiSpoofingEnabled && face.isLive !== true) {
        return {
          accepted: false,
          hint: face.isLive === false ? "Possible spoof detected" : "Checking liveness — hold still",
        };
      }
      const quality = checkFrameQuality(face);
      if (!quality.ok) return { accepted: false, hint: quality.reason };

      // The frame must actually be in the pose we are capturing, otherwise a
      // frontal frame could end up inside the left45 template and blur it. The
      // band is wide and the hint says which way to move, so this guides the
      // person into position instead of just refusing frames.
      const guidance = poseCaptureGuidance(face.yawAngle ?? 0, expectedPose);
      if (!guidance.inBand) {
        return { accepted: false, hint: guidance.hint };
      }

      const embedding = face.embedding as number[];
      const previous = burstSamplesRef.current;
      if (previous.length > 0) {
        const last = previous[previous.length - 1];
        if (cosineSimilarity(embedding, last) >= MAX_DUPLICATE_SIMILARITY) {
          // Same cached embedding re-emitted on a throttled frame — not new data.
          return { accepted: false, hint: null };
        }
      }

      return { accepted: true, hint: null };
    },
    [settings.antiSpoofingEnabled],
  );

  // Feeds live frames into the active burst until enough distinct, good samples
  // are collected, then averages them into one centroid template.
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

    // Burst complete — build the centroid.
    burstActiveRef.current = false;
    const samples = burstSamplesRef.current;
    const cohesion = sampleCohesion(samples);
    const centroid = averageEmbeddings(samples);

    if (!centroid) {
      cancelBurst();
      alert("Could not build a face template from this capture. Please try again.");
      return;
    }

    if (cohesion < MIN_SAMPLE_COHESION) {
      // The frames disagreed too much; averaging them would weaken the template.
      cancelBurst();
      AppSettings.haptic("error");
      alert(
        "The captured frames varied too much (likely movement or changing light). " +
          "Please hold still and capture this pose again.",
      );
      return;
    }

    const frozenFace: RealtimeFace = {
      ...currentFace,
      embedding: centroid,
    };

    const previewUri = frozenFace.previewBase64
      ? frozenFace.previewBase64.startsWith("data:")
        ? frozenFace.previewBase64
        : `data:image/jpeg;base64,${frozenFace.previewBase64}`
      : null;

    setPendingCapture({
      poseKey: currentStep.key,
      embedding: centroid,
      face: frozenFace,
      uri: previewUri,
      sampleCount: samples.length,
      cohesion,
    });

    burstSamplesRef.current = [];
    setBurstProgress(0);
    setBurstHint(null);
    setCapturingPhoto(false);
    AppSettings.haptic("success");
  }, [currentFace, currentStep.key, evaluateSample, cancelBurst]);

  // Starts the burst on its own once the pose has been held steady, so nobody
  // has to hold a 45-degree turn while hunting for the shutter button. The
  // shutter still works for anyone who prefers to trigger it manually.
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

  // Abandon a burst that cannot gather a new usable frame in time. Keyed on
  // burstProgress so the clock restarts with every accepted sample — a slow but
  // advancing capture is fine, a stalled one is not.
  useEffect(() => {
    if (!capturingPhoto) return;
    const timer = setTimeout(() => {
      if (!burstActiveRef.current) return;
      cancelBurst();
      setCapturingPhoto(false);
      AppSettings.haptic("error");
      alert("Could not capture enough clear frames. Please check lighting, hold still, and try again.");
    }, BURST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [capturingPhoto, burstProgress, cancelBurst]);

  const handleManualCapture = async () => {
    if (capturingPhoto || pendingCapture) return;

    // If strict lighting check is enabled and there is an active lighting warning:
    if (settings.strictLightingCheck && activeWarning) {
      triggerWarningWiggle();
      return;
    }

    if (!currentFace) {
      alert("No face detected in camera frame. Please position your face inside the frame.");
      return;
    }

    // CRITICAL: Never save a fake embedding. If the native pipeline hasn't
    // produced a real embedding yet, block the capture and ask the user to retry
    // rather than silently saving noise to the database.
    if (!currentFace.embedding || currentFace.embedding.length === 0) {
      alert("Face embedding not ready. Please hold still and try again in a moment.");
      return;
    }

    AppSettings.haptic("medium");

    // Start collecting a burst; the effect above averages it into a template.
    startBurst();
  };

  const handleConfirmPose = () => {
    if (!pendingCapture) return;

    AppSettings.haptic("success");
    const poseKeyToSave = pendingCapture.poseKey;
    const embeddingToSave = pendingCapture.embedding;

    // Instantly clear pending capture state before any navigation
    setPendingCapture(null);

    setCapturedEmbeddings((prev) => ({
      ...prev,
      [poseKeyToSave]: embeddingToSave,
    }));

    // If there are more poses to capture:
    if (currentStepIndex < POSE_STEPS.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      // All 3 poses captured!
      setScanState("done");
      setScannerVisible(false);
      setToastMessage("All 3 Face Poses Verified!");
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 2400);
    }
  };

  const handleRetakePose = () => {
    AppSettings.haptic("light");
    setPendingCapture(null);
  };

  const handleEnroll = async () => {
    if (!studentName.trim() || !enrollmentId.trim() || !selectedClassId) {
      alert("Please fill in Student Name, Enrollment ID, and select a Class.");
      return;
    }

    if (
      scanState !== "done" ||
      !capturedEmbeddings.front ||
      !capturedEmbeddings.left45 ||
      !capturedEmbeddings.right45
    ) {
      alert("Please complete face identifier setup for all 3 poses first.");
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
            front: capturedEmbeddings.front,
            left45: capturedEmbeddings.left45,
            right45: capturedEmbeddings.right45,
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
        setCapturedEmbeddings({ front: null, left45: null, right45: null });
        setTimeout(() => setToastVisible(false), 2400);
      } else {
        alert(data.error || "Enrollment failed");
      }
    } catch (err) {
      console.error(err);
      alert("Unable to connect to enrollment server");
    } finally {
      setSubmitting(false);
    }
  };

  // Calculate face bounding box for the pose review screen.
  // Uses the shared mapFaceToPreview helper with mirrored=false — the native
  // module (CameraView.kt) already flips face.x for the front camera before
  // emitting to JS, so no additional mirror is needed here.
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

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeInUp.delay(100).duration(500)} className="mb-6">
          <Text className="text-3xl font-bold text-on-surface tracking-tight">
            New Student Enrollment
          </Text>
          <Text className="text-sm text-on-surface-variant mt-1 font-medium">
            Register a new student record with 3D multi-pose face embeddings.
          </Text>
        </Animated.View>

        {/* Class Selection Card */}
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

        {/* Face Identifier Setup Card */}
        <Animated.View
          entering={FadeInUp.delay(340).duration(500)}
          className="bg-surface border border-slate-100 rounded-3xl p-6 mb-6 items-center shadow-soft"
        >
          <View className="w-20 h-20 rounded-full bg-primary-light border-2 border-primary/20 items-center justify-center mb-4 relative overflow-hidden">
            <Icon
              name={scanState === "done" ? "check_circle" : "face"}
              size={40}
              color="#4f46e5"
            />
          </View>

          <Text className="font-extrabold text-on-surface text-base">
            {scanState === "done" ? "3/3 Poses Verified" : "Multi-Pose Face Setup"}
          </Text>
          <Text className="text-xs text-on-surface-variant mt-1.5 text-center px-4 leading-normal font-medium">
            {scanState === "done"
              ? "Front, Left 45°, and Right 45° face embedding vectors ready for enrollment."
              : "Capture 3 face angles (Front, Left 45°, Right 45°) to register 512D recognition vectors."}
          </Text>

          {/* Pose Badges */}
          <View className="flex-row gap-2 mt-4">
            <View className={`px-3 py-1.5 rounded-xl border flex-row items-center gap-1 ${
              capturedEmbeddings.front ? "bg-emerald-50 border-emerald-200" : "bg-slate-100 border-slate-200"
            }`}>
              <Icon name={capturedEmbeddings.front ? "check" : "radio_button_unchecked"} size={12} color={capturedEmbeddings.front ? "#10b981" : "#94a3b8"} />
              <Text className={`text-[10px] font-black uppercase ${capturedEmbeddings.front ? "text-emerald-700" : "text-slate-500"}`}>Front</Text>
            </View>
            <View className={`px-3 py-1.5 rounded-xl border flex-row items-center gap-1 ${
              capturedEmbeddings.left45 ? "bg-emerald-50 border-emerald-200" : "bg-slate-100 border-slate-200"
            }`}>
              <Icon name={capturedEmbeddings.left45 ? "check" : "radio_button_unchecked"} size={12} color={capturedEmbeddings.left45 ? "#10b981" : "#94a3b8"} />
              <Text className={`text-[10px] font-black uppercase ${capturedEmbeddings.left45 ? "text-emerald-700" : "text-slate-500"}`}>Left 45°</Text>
            </View>
            <View className={`px-3 py-1.5 rounded-xl border flex-row items-center gap-1 ${
              capturedEmbeddings.right45 ? "bg-emerald-50 border-emerald-200" : "bg-slate-100 border-slate-200"
            }`}>
              <Icon name={capturedEmbeddings.right45 ? "check" : "radio_button_unchecked"} size={12} color={capturedEmbeddings.right45 ? "#10b981" : "#94a3b8"} />
              <Text className={`text-[10px] font-black uppercase ${capturedEmbeddings.right45 ? "text-emerald-700" : "text-slate-500"}`}>Right 45°</Text>
            </View>
          </View>

          <Pressable
            onPress={openScanner}
            className={`flex-row items-center border rounded-2xl mt-5 px-5 py-3 ${
              scanState === "done"
                ? "bg-emerald-50 border-emerald-200"
                : "bg-surface-muted border-slate-100 active:bg-slate-200"
            } transition-all active:scale-95`}
          >
            <Icon
              name={scanState === "done" ? "refresh" : "center_focus_strong"}
              size={18}
              color="#4f46e5"
            />
            <Text className="text-primary font-bold text-sm tracking-wide ml-1.5">
              {scanState === "done" ? "Re-scan Poses" : "Start Multi-Pose Scan"}
            </Text>
          </Pressable>

          {/* Reset Captures Button — Rendered whenever any pose details exist */}
          {(capturedEmbeddings.front !== null ||
            capturedEmbeddings.left45 !== null ||
            capturedEmbeddings.right45 !== null ||
            scanState !== "idle") && (
            <Pressable
              onPress={handleResetCaptures}
              className="flex-row items-center justify-center border border-rose-200/80 bg-rose-50/80 rounded-2xl mt-3 px-4 py-2 transition-all active:scale-95"
            >
              <Icon name="delete_outline" size={16} color="#e11d48" />
              <Text className="text-rose-600 font-extrabold text-xs tracking-wide ml-1.5">
                Reset Face Scans
              </Text>
            </Pressable>
          )}
        </Animated.View>

        {/* Submit Button */}
        <Animated.View entering={FadeInUp.delay(420).duration(500)} className="shadow-premium rounded-2xl bg-primary">
          <Pressable
            onPress={handleEnroll}
            disabled={submitting}
            className="py-4 items-center justify-center active:scale-[0.98] transition-all disabled:opacity-50"
          >
            <Text className="text-on-primary font-bold text-base tracking-wide">
              {submitting ? "Processing Embeddings & Registering..." : "Complete Enrollment"}
            </Text>
          </Pressable>
        </Animated.View>
      </ScrollView>

      {/* FULL-SCREEN LIGHT-THEMED MULTI-POSE CAMERA SCANNER OVERLAY */}
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
            showNativeOverlay={!pendingCapture}
            smoothNativeOverlay={settings.smoothFaceBox}
            onFaceChange={setCurrentFace}
            onLightingChange={setCurrentLighting}
            onCameraReady={() => {}}
            onError={() => {}}
            onPreviewLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setCameraLayout({ width, height });
            }}
          />

          {/* Static Captured Photo Snapshot Image (shows captured photo instead of live camera) */}
          {pendingCapture && pendingCapture.uri && (
            <Image
              source={{ uri: pendingCapture.uri }}
              style={[
                StyleSheet.absoluteFillObject,
                settings.cameraFacing === "front" ? { transform: [{ scaleX: -1 }] } : {},
                { zIndex: 10 },
              ]}
              resizeMode="cover"
            />
          )}

          {/* Captured Bounding Box Overlay (rendered directly on camera preview when reviewing pose) */}
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
              {/* Corner bracket accents */}
              <View style={{ position: "absolute", top: -2, left: -2, width: 14, height: 14, borderTopWidth: 4, borderLeftWidth: 4, borderColor: "#059669", borderTopLeftRadius: 10 }} />
              <View style={{ position: "absolute", top: -2, right: -2, width: 14, height: 14, borderTopWidth: 4, borderRightWidth: 4, borderColor: "#059669", borderTopRightRadius: 10 }} />
              <View style={{ position: "absolute", bottom: -2, left: -2, width: 14, height: 14, borderBottomWidth: 4, borderLeftWidth: 4, borderColor: "#059669", borderBottomLeftRadius: 10 }} />
              <View style={{ position: "absolute", bottom: -2, right: -2, width: 14, height: 14, borderBottomWidth: 4, borderRightWidth: 4, borderColor: "#059669", borderBottomRightRadius: 10 }} />

              {/* Verified Badge above box */}
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
                  ✓ {POSE_STEPS.find((s) => s.key === pendingCapture.poseKey)?.subtitle} Verified
                </Text>
              </View>
            </View>
          )}

          {/* TOP CONTROLS — Minimal pill bar */}
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

            {/* Step Counter Pill */}
            <View
              style={{
                backgroundColor: "rgba(255,255,255,0.92)",
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: 16,
                flexDirection: "row",
                alignItems: "center",
                shadowColor: "#000",
                shadowOpacity: 0.08,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Text style={{ color: "#4f46e5", fontWeight: "900", fontSize: 12 }}>
                {currentStepIndex + 1}
              </Text>
              <Text style={{ color: "#94a3b8", fontWeight: "700", fontSize: 12 }}>
                {" / 3"}
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

          {/* BOTTOM SECTION — Pose Card + Warning + Shutter (Hidden when reviewing pending capture) */}
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
              {/* UPGRADED LIGHTING WARNING BANNER WITH WIGGLE */}
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
                      shadowColor: "#f59e0b",
                      shadowOpacity: 0.25,
                      shadowRadius: 12,
                      shadowOffset: { width: 0, height: 4 },
                      elevation: 6,
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

              {/* Pose Guidance Card — Clean white card */}
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
                      <Icon name={currentStep.iconName} size={20} color="#4f46e5" />
                    </View>
                    <View>
                      <Text style={{ color: "#1e293b", fontWeight: "800", fontSize: 15 }}>
                        {currentStep.title}
                      </Text>
                      <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "600" }}>
                        {currentStep.instruction}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Live pose status — shows whether the head is currently in the
                    band this step needs, and which way to move if not. */}
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

                {/* Step progress dots */}
                <View style={{ flexDirection: "row", marginTop: 14, gap: 6 }}>
                  {POSE_STEPS.map((step, idx) => {
                    const isActive = idx === currentStepIndex;
                    const isDone = capturedEmbeddings[step.key] !== null;
                    return (
                      <View
                        key={step.key}
                        style={{
                          flex: 1,
                          height: 4,
                          borderRadius: 2,
                          backgroundColor: isDone
                            ? "#10b981"
                            : isActive
                            ? "#4f46e5"
                            : "#e2e8f0",
                        }}
                      />
                    );
                  })}
                </View>
              </View>

              {/* Manual Capture Shutter — Converts to circular loading spinner while capturing */}
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
                      ? "#4f46e5"
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
                        ? "#4f46e5"
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

                {/* Burst capture guidance — tells the student what to fix when
                    frames are being rejected instead of stalling silently. */}
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

          {/* CAPTURE REVIEW & CONFIRM OVERLAY — Translucent sheet keeping live/captured camera view & face box visible */}
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
                entering={SlideInDown.duration(300)}
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
                        {POSE_STEPS.find((s) => s.key === pendingCapture.poseKey)?.title}
                      </Text>
                      <Text style={{ color: "#059669", fontSize: 11, fontWeight: "700", marginTop: 1 }}>
                        Averaged {pendingCapture.sampleCount} samples · cohesion{" "}
                        {pendingCapture.cohesion.toFixed(3)}
                      </Text>
                    </View>
                  </View>

                  <View style={{ backgroundColor: "#f1f5f9", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 }}>
                    <Text style={{ color: "#475569", fontSize: 10, fontWeight: "800", fontFamily: "monospace" }}>
                      512-D Ready
                    </Text>
                  </View>
                </View>

                {/* Metrics Row */}
                <View
                  style={{
                    flexDirection: "row",
                    backgroundColor: "#f8fafc",
                    borderWidth: 1,
                    borderColor: "#f1f5f9",
                    borderRadius: 16,
                    padding: 12,
                    justifyContent: "space-around",
                  }}
                >
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ color: "#64748b", fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>Coverage</Text>
                    <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "900", marginTop: 2 }}>
                      {Math.round((pendingCapture.face?.normalizationCoverage ?? 0) * 100)}%
                    </Text>
                  </View>
                  <View style={{ width: 1, height: "100%", backgroundColor: "#e2e8f0" }} />
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ color: "#64748b", fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>Latency</Text>
                    <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "900", marginTop: 2 }}>
                      {pendingCapture.face?.processDurationMs ?? "—"}ms
                    </Text>
                  </View>
                  <View style={{ width: 1, height: "100%", backgroundColor: "#e2e8f0" }} />
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ color: "#64748b", fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>Face Target</Text>
                    <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "900", marginTop: 2 }}>
                      {pendingCapture.face ? `${Math.round(pendingCapture.face.width)}x${Math.round(pendingCapture.face.height)}` : "—"}
                    </Text>
                  </View>
                </View>

                {/* Action Buttons */}
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Pressable
                    onPress={handleRetakePose}
                    style={{
                      flex: 1,
                      paddingVertical: 15,
                      borderRadius: 16,
                      backgroundColor: "#f1f5f9",
                      borderWidth: 1,
                      borderColor: "#cbd5e1",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#334155", fontWeight: "800", fontSize: 14 }}>Retake</Text>
                  </Pressable>

                  <Pressable
                    onPress={handleConfirmPose}
                    disabled={!pendingCapture}
                    style={{
                      flex: 1,
                      paddingVertical: 15,
                      borderRadius: 16,
                      backgroundColor: "#4f46e5",
                      alignItems: "center",
                      shadowColor: "#4f46e5",
                      shadowOpacity: 0.35,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 4 },
                      elevation: 4,
                      opacity: pendingCapture ? 1 : 0.45,
                    }}
                  >
                    <Text style={{ color: "#ffffff", fontWeight: "900", fontSize: 14 }}>Confirm Pose</Text>
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
