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
  FadeIn,
  FadeInUp,
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
} from "react-native-reanimated";
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

/**
 * Hard ceiling on the class-list refresh. `fetch` has no default timeout in React
 * Native, so a backend that accepts the connection and then never answers used to
 * leave the dropdown skeleton spinning with no way out. Matches the bound the sync
 * engine already applies to every one of its own requests.
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
  const { triggerSync, status: syncStatus } = useSyncEngine();

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

  /**
   * Mirror of `pendingCapture` for the camera callback. The native detector emits
   * a frame every `PERFORMANCE_PRESETS[...].intervalMs` — 50 ms on the default
   * "balanced" setting, so twenty times a second. Reading the flag from a ref lets
   * `handleFaceChange` stay referentially stable and drop those frames without a
   * state read, which is what stops the whole screen re-rendering while the review
   * sheet is on screen.
   */
  const pendingCaptureRef = useRef(false);
  pendingCaptureRef.current = pendingCapture !== null;

  /**
   * Last frozen preview frame written to the cache directory. Kept so it can be
   * deleted on retake/confirm/close — `freezePreview` writes a temp JPEG per call,
   * and without this every retake would leave one behind for the life of the app.
   */
  const freezeUriRef = useRef<string | null>(null);

  /**
   * In-scanner failure message (cohesion too low, burst stalled, no face yet).
   * These used to be `alert()` calls, which threw a system modal over the camera
   * mid-capture; an inline banner keeps the person in the flow.
   */
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

  /** Throw away a frozen preview frame once the review that used it is over. */
  const discardFreezeFrame = useCallback(() => {
    const uri = freezeUriRef.current;
    freezeUriRef.current = null;
    if (!uri) return;
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {
      // A leftover file in the cache directory is harmless; Android reclaims it.
    });
  }, []);

  // Catch-all for the one path the Retake/Confirm/Close handlers cannot cover:
  // leaving the tab outright while a review is still open.
  useEffect(() => discardFreezeFrame, [discardFreezeFrame]);

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
  const [loadingEnrollSetup, setLoadingEnrollSetup] = useState(true);
  const hasLoadedEnrollSetup = useRef(false);
  const apiUrl = API_URL;

  /**
   * Applies a freshly loaded class list without clobbering a choice the person has
   * already made. Uses a functional update so it never has to read
   * `selectedClassId`, which is what let `fetchEnrollClasses` drop that value from
   * its dependencies — the focus effect used to list `selectedClassId` in its deps
   * while this code set it, re-running the whole load on every dropdown change.
   */
  const applyClassList = useCallback(
    (formatted: { id: string; code: string; title: string }[]) => {
      setClassesList(formatted);
      if (formatted.length === 0) {
        setSelectedClassId("");
        return;
      }
      setSelectedClassId((current) =>
        // Keep the current choice if it still exists in the new list.
        current && formatted.some((f) => f.id === current) ? current : formatted[0].id,
      );
    },
    [],
  );

  const fetchEnrollClasses = useCallback(async () => {
    const showSkeleton = !hasLoadedEnrollSetup.current;
    if (showSkeleton) setLoadingEnrollSetup(true);

    // 1. Load from local cache first (instant, works offline)
    try {
      const cached = await getCachedClasses();
      if (cached.length > 0) {
        applyClassList(
          cached.map((c) => ({ id: c.class_id, code: c.code, title: c.title })),
        );
        // Cache loaded — hide skeleton immediately
        hasLoadedEnrollSetup.current = true;
        if (showSkeleton) setLoadingEnrollSetup(false);
      }
    } catch (err) {
      console.warn("Failed to load cached classes:", err);
    }

    // 2. Try to refresh from server (updates the dropdown if online). Skipped
    //    outright when the sync engine already knows the device is offline, so a
    //    known-offline enroll screen never waits on a request that cannot succeed.
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
      // Persist what we just fetched. Without this, a device that only ever
      // visited this screen while online had an empty cache the moment it went
      // offline, because only the sync engine wrote `cached_classes`.
      if (formatted.length > 0) {
        await replaceCachedClasses(
          formatted.map((c) => ({ id: c.id, code: c.code, title: c.title })),
        );
      }
    } catch (err) {
      // Offline or unreachable — the cache above already populated the dropdown,
      // so enrollment still works and nothing needs to be surfaced here.
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

  /**
   * Camera frame sink. Frames are dropped outright while a capture is under review,
   * because nothing on screen can change until Retake or Confirm is pressed. The
   * native detector emits up to twenty frames a second and each one re-rendered
   * this entire screen, which is what made the Confirm/Retake sheet take a visible
   * moment to appear and then respond sluggishly to the first tap.
   */
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
    // Resume on first uncaptured pose if partial progress exists
    const firstUncaptured = POSE_STEPS.findIndex((step) => !capturedEmbeddings[step.key]);
    setCurrentStepIndex(firstUncaptured !== -1 ? firstUncaptured : 0);
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
    setCapturedEmbeddings({
      front: null,
      left45: null,
      right45: null,
    });
    setCurrentStepIndex(0);
    setPendingCapture(null);
    pendingCaptureRef.current = false;
    setCaptureError(null);
    discardFreezeFrame();
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
    [],
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
      setCapturingPhoto(false);
      AppSettings.haptic("error");
      showCaptureError("Could not build a face template from that capture. Try again.");
      return;
    }

    if (cohesion < MIN_SAMPLE_COHESION) {
      // The frames disagreed too much; averaging them would weaken the template.
      cancelBurst();
      setCapturingPhoto(false);
      AppSettings.haptic("error");
      showCaptureError("Frames varied too much — hold still and capture this pose again.");
      return;
    }

    const frozenFace: RealtimeFace = {
      ...currentFace,
      embedding: centroid,
    };

    // Show the review sheet on this same commit. The still frame is fetched
    // afterwards and patched in when it lands, because `freezePreview` has to copy
    // the preview surface and encode a JPEG — awaiting it here would put that
    // latency in front of the buttons the person is waiting for.
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
        // Land it only if the same review is still open — a fast Retake or Confirm
        // must not have a late still frame appear on top of it.
        setPendingCapture((current) => {
          if (!current || current.poseKey !== capturedPoseKey || current.uri) {
            FileSystem.deleteAsync(frame.uri as string, { idempotent: true }).catch(() => {});
            return current;
          }
          freezeUriRef.current = frame.uri as string;
          return { ...current, uri: frame.uri as string };
        });
      })
      .catch(() => {
        // Preview surface not readable yet. The review sheet stays over the live
        // feed, exactly as it behaved before, so nothing needs saying.
      });
  }, [currentFace, currentStep.key, evaluateSample, cancelBurst, showCaptureError]);

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
      showCaptureError("Not enough clear frames. Check the lighting, hold still, and try again.");
    }, BURST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [capturingPhoto, burstProgress, cancelBurst, showCaptureError]);

  const handleManualCapture = () => {
    if (capturingPhoto || pendingCapture) return;

    // If strict lighting check is enabled and there is an active lighting warning:
    if (settings.strictLightingCheck && activeWarning) {
      triggerWarningWiggle();
      return;
    }

    if (!currentFace) {
      AppSettings.haptic("error");
      showCaptureError("No face in the frame — line your face up inside the guide.");
      return;
    }

    // CRITICAL: Never save a fake embedding. If the native pipeline hasn't
    // produced a real embedding yet, block the capture and ask the user to retry
    // rather than silently saving noise to the database.
    if (!currentFace.embedding || currentFace.embedding.length === 0) {
      AppSettings.haptic("error");
      showCaptureError("Still reading your face — hold still for a moment, then tap again.");
      return;
    }

    AppSettings.haptic("medium");
    setCaptureError(null);

    // Start collecting a burst; the effect above averages it into a template.
    startBurst();
  };

  const handleConfirmPose = () => {
    if (!pendingCapture) return;

    AppSettings.haptic("success");
    const poseKeyToSave = pendingCapture.poseKey;
    const embeddingToSave = pendingCapture.embedding;

    // Instantly clear pending capture state before any navigation. The ref is set
    // in the same breath so the very next camera frame is accepted again rather
    // than waiting for the re-render to publish the new state.
    pendingCaptureRef.current = false;
    setPendingCapture(null);
    discardFreezeFrame();

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
    pendingCaptureRef.current = false;
    setPendingCapture(null);
    discardFreezeFrame();
  };

  const posesDone =
    scanState === "done" &&
    Boolean(capturedEmbeddings.front && capturedEmbeddings.left45 && capturedEmbeddings.right45);

  /**
   * What is still missing before "Complete Enrollment" can do anything. Rendered
   * under the button so the requirement is visible up front, instead of only
   * appearing as a modal after a tap that could not have worked.
   */
  const missingRequirements = [
    !selectedClassId && "pick a class",
    !studentName.trim() && "student name",
    !enrollmentId.trim() && "enrollment number",
    !posesDone && "all 3 face poses",
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
      // ── Offline-first: write to local queue, then trigger sync ──
      await insertPendingEnrollment({
        enrollmentNumber: enrollmentId.trim(),
        name: studentName.trim(),
        classId: selectedClassId,
        embeddingsJson: JSON.stringify({
          front: capturedEmbeddings.front,
          left45: capturedEmbeddings.left45,
          right45: capturedEmbeddings.right45,
        }),
        embeddingModel: 'w600k_mbf',
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
      setCapturedEmbeddings({ front: null, left45: null, right45: null });
      setTimeout(() => setToastVisible(false), 2800);

      // Trigger sync to push the enrollment to the server when online.
      void triggerSync();
    } catch (err) {
      console.error(err);
      alert("Failed to save enrollment on this device. Please try again.");
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

      {/* The form is unmounted while the scanner is up. It is completely hidden
          behind the opaque scanner overlay anyway, and leaving ~250 lines of JSX
          mounted meant every camera frame re-rendered all of it. Its entering
          animations replay when the scanner closes, which reads as intentional. */}
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
                  {loadingEnrollSetup ? <View className="mt-2"><SkeletonBlock width={150} height={14} radius={7} /></View> :
                    <Text className="text-on-surface font-bold text-sm mt-0.5" numberOfLines={1}>
                      {(() => {
                        const selectedClass = classesList.find((c) => c.id === selectedClassId);
                        if (selectedClass) return `${selectedClass.code} • ${selectedClass.title}`;
                        return classesList.length === 0 ? "No classes available" : "Select a Course Class";
                      })()}
                    </Text>}
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
                {/* Empty state. An empty dropdown used to open to nothing at all,
                    which looks like a broken screen rather than a missing class list. */}
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
        <Animated.View entering={FadeInUp.delay(420).duration(500)}>
          <View
            className="shadow-premium rounded-2xl bg-primary"
            style={{ opacity: canSubmit ? 1 : 0.45 }}
          >
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

          {/* Why the button is dimmed. Before this, tapping an incomplete form
              either did nothing or threw an alert, with no standing indication of
              what was still missing. */}
          {missingRequirements.length > 0 && !submitting && (
            <View className="flex-row items-start gap-1.5 mt-3 px-1">
              <Icon name="info" size={13} color="#94a3b8" />
              <Text className="flex-1 text-[11px] font-semibold text-on-surface-variant leading-snug">
                Still needed: {missingRequirements.join(", ")}.
              </Text>
            </View>
          )}

          {/* Offline is a supported state here, not an error — the record is written
              to this device and the sync engine pushes it on the next connection. */}
          {isOffline && (
            <View className="flex-row items-center gap-2 mt-3 px-3 py-2.5 rounded-2xl bg-amber-50 border border-amber-200">
              <Icon name="cloud_off" size={15} color="#d97706" />
              <Text className="flex-1 text-[11px] font-bold text-amber-800 leading-snug">
                No connection — this enrollment saves on the phone and uploads by
                itself once you are back online.
              </Text>
            </View>
          )}
        </Animated.View>
      </ScrollView>
      )}

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
            faceDetectorMode="accurate"
            showNativeOverlay={!pendingCapture}
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

          {/* The frame that was actually captured, frozen over the live feed while
              the person decides. `freezePreview` returns what PreviewView was
              *displaying*, which already includes the front-camera mirror, so no
              further transform belongs here. */}
          {pendingCapture?.uri && (
            <Image
              source={{ uri: pendingCapture.uri }}
              style={[StyleSheet.absoluteFillObject, { zIndex: 10 }]}
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
              {/* CAPTURE PROBLEM BANNER — replaces the system alerts that used to
                  cover the camera whenever a burst failed mid-capture. */}
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
                    shadowColor: "#ef4444",
                    shadowOpacity: 0.22,
                    shadowRadius: 12,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 6,
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

                {/* Burst fill bar. Collecting the accepted frames for one pose takes
                    around three seconds, and a bare "3/6" counter made that wait read
                    as a freeze. The bar steps as each frame is accepted, so there is
                    always visible movement. */}
                {capturingPhoto && (
                  <View
                    style={{
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: "#e2e8f0",
                      marginTop: 10,
                      overflow: "hidden",
                    }}
                  >
                    <View
                      style={{
                        height: "100%",
                        borderRadius: 3,
                        width: `${Math.min(100, (burstProgress / SAMPLES_PER_POSE) * 100)}%`,
                        backgroundColor: "#4f46e5",
                      }}
                    />
                  </View>
                )}

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
              {/* A short fade rather than the old 300 ms slide-up. The slide ran on
                  the same JS thread that was still being handed camera frames, so
                  its first frames landed late and the whole sheet read as a stall
                  before the buttons appeared. */}
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

                {/* What happens after Confirm. Without this the person had no way to
                    know whether they were about to be asked for another pose. */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Icon
                    name={currentStepIndex === POSE_STEPS.length - 1 ? "check_circle" : "arrow_forward"}
                    size={14}
                    color="#64748b"
                  />
                  <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "700" }}>
                    {currentStepIndex === POSE_STEPS.length - 1
                      ? "Last pose — confirming finishes the scan."
                      : `Next up: ${POSE_STEPS[currentStepIndex + 1].title} — ${POSE_STEPS[currentStepIndex + 1].instruction}`}
                  </Text>
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
                    <Text style={{ color: "#ffffff", fontWeight: "900", fontSize: 14 }}>
                      {currentStepIndex === POSE_STEPS.length - 1 ? "Finish Scan" : "Confirm & Next"}
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
