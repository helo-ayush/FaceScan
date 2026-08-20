import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
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
import { router, useFocusEffect } from "expo-router";
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
  withRepeat,
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
import { useSyncEngine } from "@/utils/SyncProvider";
import { insertPendingAttendance } from "@/utils/localDb";
import { API_URL } from "@/utils/apiConfig";
import {
  getDownloadedClasses,
  getAvailableClasses,
  loadClassPackage,
  getUnifiedClassRoster,
  type DownloadedClassInfo,
  type ClassPackageManifest,
} from "@/utils/classPackageStore";

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

/**
 * Human text for the guidance keys the native quality gate emits
 * (`LivenessFusion.gate`). These are frames the pipeline *refused to score*, which
 * is a different thing from a spoof verdict, so every one of them must read as an
 * instruction rather than an accusation — telling a genuine user in a dim room that
 * their face isn't real is the failure this rebuild exists to remove.
 */
const LIVENESS_GUIDANCE: Record<string, string> = {
  MOVE_CLOSER: "Move a little closer",
  MOVE_BACK: "Move back slightly",
  MORE_LIGHT: "Need more light",
  LESS_GLARE: "Too much glare",
  HOLD_STILL: "Hold steady",
  FACE_CAMERA: "Look at the camera",
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

function getClassInitials(name?: string | null): string {
  if (!name) return "CL";
  const cleaned = name.trim();
  const parts = cleaned.split(/[\s-_]+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
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
    cosine: number;
    initials: string;
    sync: "pending" | "saved" | "duplicate" | "failed";
    syncDetail?: string;
  } | null>(null);
  const [isMatchLocked, setIsMatchLocked] = useState(false);

  // --- Sync engine & class package state ---
  const { status: syncStatus, triggerSync, scanSessionStart, scanSessionEnd } = useSyncEngine();
  const [downloadedClasses, setDownloadedClasses] = useState<DownloadedClassInfo[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [activePackage, setActivePackage] = useState<ClassPackageManifest | null>(null);
  const [showClassPicker, setShowClassPicker] = useState(false);
  /**
   * Which class the currently-loaded roster belongs to. `undefined` means no load
   * has finished yet. Comparing this against `selectedClassId` — rather than a
   * plain "loaded" boolean — is what keeps the blocker card from flashing a stale
   * verdict for a frame while a newly-selected class is still being read.
   */
  const [loadedRosterClassId, setLoadedRosterClassId] = useState<string | null | undefined>(undefined);
  /**
   * False until the class list has been read once. Without this the blocker
   * briefly claimed "no class on this device" on every cold start, because the
   * first roster load runs against a still-null `selectedClassId` and completes
   * before `getAvailableClasses()` returns.
   */
  const [classesLoaded, setClassesLoaded] = useState(false);

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
  const { height: screenH, width: screenW } = useWindowDimensions();
  const SHELF_COLLAPSED_HEIGHT = 128 + insets.bottom;
  const SHELF_EXPANDED_EXTRA = Math.max(0, screenH * 0.75 - SHELF_COLLAPSED_HEIGHT);
  const SHELF_SNAP_DURATION = 240;
  const livenessPillWidth = Math.min(screenW - 48, 336);
  const livenessSpinnerRotation = useSharedValue(0);

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
      const next = shelfDragStart.value - e.translationY;
      shelfTranslateY.value = Math.max(0, Math.min(SHELF_EXPANDED_EXTRA, next));
    })
    .onEnd((e) => {
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

  const shelfAnimatedStyle = useAnimatedStyle(() => ({
    height: SHELF_COLLAPSED_HEIGHT + shelfTranslateY.value,
  }));
  const livenessPillAnimatedStyle = useAnimatedStyle(() => ({
    bottom: SHELF_COLLAPSED_HEIGHT + shelfTranslateY.value + 8,
  }));
  const livenessSpinnerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${livenessSpinnerRotation.value}deg` }],
  }));

  useEffect(() => {
    livenessSpinnerRotation.value = 0;
    livenessSpinnerRotation.value = withRepeat(
      withTiming(360, { duration: 820, easing: Easing.linear }),
      -1,
      false,
    );
  }, [livenessSpinnerRotation]);

  // Sliding-window consensus: the same student must win several of the most
  // recent frames before attendance is marked.
  const consensusRef = useRef(new ConsensusTracker());
  const lockedCandidateRef = useRef<{
    student: MatchableStudent;
    similarity: number;
    lockedAt: number;
  } | null>(null);

  // Why the current frame was rejected, surfaced in the UI so a student can see
  // whether to hold still, move into better light, or face the camera.
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  // Most recent scored frame, reused for the live readout so the roster is not
  // scanned twice per frame.
  const [lastScored, setLastScored] = useState<{ scored: ScoredFrame; yaw: number } | null>(null);

  const apiUrl = API_URL;

  // Load available class list (downloaded packages + cached classes + pending enrollments).
  const refreshDownloadedClasses = useCallback(async () => {
    try {
      const classes = await getAvailableClasses();
      setDownloadedClasses(classes);
      // Auto-select on first load. Prefer a class that actually has a package on
      // disk — the list also contains classes we only know the *name* of, and
      // landing on one of those means staring at a camera that can never match.
      if (classes.length > 0 && !selectedClassId) {
        const scannable = classes.find((c) => c.hasPackage);
        setSelectedClassId((scannable ?? classes[0]).classId);
      }
    } catch (err) {
      console.warn('Failed to load available classes:', err);
    } finally {
      setClassesLoaded(true);
    }
  }, [selectedClassId]);

  const loadRosterForClass = useCallback(async (classId: string | null) => {
    if (!classId) {
      setStudents([]);
      setActivePackage(null);
      setLoadedRosterClassId(null);
      return;
    }

    try {
      const result = await getUnifiedClassRoster(classId);
      if (result.manifest) {
        setActivePackage(result.manifest);
        // Convert package students + offline pending students to Matchable StudentRecord shape
        const roster: StudentRecord[] = result.students.map((s) => ({
          _id: s.enrollmentNumber,
          name: s.name,
          enrollmentNumber: s.enrollmentNumber,
          classId: classId,
          faceEmbeddings: s.faceEmbeddings,
          embeddingModel: result.manifest?.embeddingModel || 'w600k_mbf',
          updatedAt: s.updatedAt,
        }));
        setStudents(roster);
      } else {
        setStudents([]);
        setActivePackage(null);
      }
    } catch (err) {
      console.warn('Failed to load roster for class:', err);
      setStudents([]);
      setActivePackage(null);
    } finally {
      setLoadedRosterClassId(classId);
    }
  }, []);

  useEffect(() => {
    refreshDownloadedClasses();
  }, []);

  // Load the selected class package's students into the matching roster.
  useEffect(() => {
    loadRosterForClass(selectedClassId);
  }, [selectedClassId, loadRosterForClass]);

  // Notify sync engine about scanning session lifecycle (§7.4)
  // and reload available classes + roster on screen focus (e.g. after enrolling a student offline).
  useFocusEffect(
    useCallback(() => {
      scanSessionStart();
      refreshDownloadedClasses();
      if (selectedClassId) {
        loadRosterForClass(selectedClassId);
      }
      return () => scanSessionEnd();
    }, [scanSessionStart, scanSessionEnd, refreshDownloadedClasses, selectedClassId, loadRosterForClass])
  );

  /** Classes that can actually be scanned — a verified package exists on disk. */
  const scannableClasses = useMemo(
    () => downloadedClasses.filter((c) => c.hasPackage),
    [downloadedClasses],
  );

  // Why scanning cannot work right now, or null when it can. The class list
  // deliberately includes classes this device only knows the *name* of — either
  // synced from `/api/classes` or created by an offline enrollment still waiting
  // to upload — so "a class is selected" is not the same thing as "there are
  // face templates to match against". Previously those cases fell through to the
  // normal scanning UI and the camera simply never matched anyone.
  const scanBlocker = useMemo(() => {
    // Say nothing until both the class list and the roster for the *currently
    // selected* class have actually been read.
    if (!classesLoaded) return null;
    if (loadedRosterClassId === undefined || loadedRosterClassId !== selectedClassId) return null;

    if (downloadedClasses.length === 0) {
      return {
        title: "Can't scan — no class on this device",
        message:
          'Face scan needs a downloaded class package. Ask your admin to sign in and download one from the admin panel.',
        cta: 'Open admin panel',
        action: 'admin' as const,
      };
    }

    const selected = downloadedClasses.find((c) => c.classId === selectedClassId);

    if (!selected) {
      return {
        title: "Can't scan — no class selected",
        message: 'Tap the class button at the top right and pick the class you are taking attendance for.',
        cta: 'Choose a class',
        action: 'picker' as const,
      };
    }

    if (!selected.hasPackage) {
      return {
        title: "Can't scan — package not downloaded",
        message: `${selected.className} has no face data on this device. Ask your admin to download this class package from the admin panel.`,
        cta: 'Open admin panel',
        action: 'admin' as const,
      };
    }

    if (students.length === 0) {
      return {
        title: "Can't scan — no students in this class",
        message: `${selected.className} was downloaded but contains no enrolled students. Enroll students, or download the package again after your admin adds them.`,
        cta: 'Open admin panel',
        action: 'admin' as const,
      };
    }

    return null;
  }, [classesLoaded, loadedRosterClassId, downloadedClasses, selectedClassId, students.length]);

  // Pose-aware cosine search, gated on frame quality, an absolute similarity
  // floor, a margin over the closest *other* student, and temporal consensus.
  useEffect(() => {
    // Pause matching while the shelf is open — a face in the background should
    // not trigger attendance when the user is scrolling through the log.
    if (scanningPaused || isMatchLocked || !face) return;
    // Nothing to match against. Without this the screen happily reported
    // "Searching enrolled student embeddings database..." over an empty roster.
    if (scanBlocker) return;

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

    const decision = decideFrame(scored);
    if (!decision.accept) {
      setRejectReason(decision.reason);
      consensusRef.current.push(null);
      return;
    }

    setRejectReason(null);
    const { candidate } = decision;
    const confirmedId = consensusRef.current.push(candidate.studentId);
    if (confirmedId && !lockedCandidateRef.current) {
      lockedCandidateRef.current = {
        student: candidate.student,
        similarity: candidate.similarity,
        lockedAt: Date.now(),
      };
    }

    if (lockedCandidateRef.current) {
      if (!settings.antiSpoofingEnabled || face.isLive === true) {
        const student = lockedCandidateRef.current.student;
        const similarity = lockedCandidateRef.current.similarity;
        lockedCandidateRef.current = null;
        consensusRef.current.reset();

        setIsMatchLocked(true);
        AppSettings.haptic("success");

        setMatchedStudent({
          name: student.name,
          enrollmentNumber: student.enrollmentNumber,
          classId: student.classId,
          cosine: similarity,
          initials: student.name.split(" ").map((n) => n[0]).join(""),
          sync: "pending",
        });

        // ——— Offline-first: write to local queue, then trigger sync ———
        const now = new Date();
        const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

        insertPendingAttendance({
          enrollmentNumber: student.enrollmentNumber,
          classId: student.classId,
          capturedAt: now.toISOString(),
          localDate,
          similarity: similarity,
          margin: scored.margin,
          pose: candidate.pose,
        }).then((inserted) => {
          if (inserted) {
            // New record queued — add to session log and trigger sync.
            setMatchedStudent((prev) =>
              prev ? { ...prev, sync: "saved" } : null
            );
            setSessionLog((prev) => [
              { name: student.name, enrollmentNumber: student.enrollmentNumber, classId: student.classId, cosine: similarity, at: Date.now() },
              ...prev,
            ]);
          } else {
            // Local dedupe caught it — same student already queued today.
            setMatchedStudent((prev) =>
              prev ? { ...prev, sync: "duplicate" } : null
            );
          }
          triggerSync();
        }).catch((err) => {
          console.error("Failed to queue attendance locally:", err);
          setMatchedStudent((prev) =>
            prev ? { ...prev, sync: "failed", syncDetail: "Local DB error" } : null
          );
        });

        setTimeout(() => {
          setMatchedStudent(null);
          setIsMatchLocked(false);
        }, 3500);
      } else if (
        face.livenessStatus === "SPOOF_CONFIRMED" ||
        Date.now() - lockedCandidateRef.current.lockedAt > 2000
      ) {
        // unlock: discard this candidate, resume active scanning
        lockedCandidateRef.current = null;
        consensusRef.current.reset();
      }
      // else: still waiting on liveness — do nothing further this tick
    }
  }, [face, lighting, students, isMatchLocked, scanBlocker, settings.antiSpoofingEnabled, triggerSync]);

  const previewFace = useMemo(
    () =>
      face && previewLayout
        ? mapFaceToPreview(face, previewLayout, false)
        : null,
    [face, previewLayout],
  );

  const livenessPill = useMemo(() => {
    if (!settings.antiSpoofingEnabled || !previewFace || !face) return null;
    // The blocker card already owns the screen; a "verifying you're real" pill
    // underneath it would promise a scan that cannot happen.
    if (scanBlocker) return null;

    const lightingWarning = getLightingWarning(face, lighting);
    const spoofConfirmed = face.livenessStatus === "SPOOF_CONFIRMED";

    if (face.isLive === false || spoofConfirmed) {
      return {
        title: lightingWarning ? "Improve lighting — retrying" : "Face not real — retrying",
        loading: true,
        color: "#ef4444",
        tint: "rgba(239,68,68,0.08)",
        surface: "rgba(255,255,255,0.98)",
      };
    }
    if (face.isLive === true) {
      return {
        title: "Face verified",
        loading: false,
        color: "#10b981",
        tint: "rgba(16,185,129,0.10)",
        surface: "rgba(255,255,255,0.98)",
      };
    }

    // Checked *after* the two verdicts and before the generic spinners: a refused
    // frame is still undecided, so it must not look like a rejection, but it is the
    // one undecided case where the user can actually do something about it. Amber
    // rather than red for exactly that reason.
    const guidance = face.livenessGuidance
      ? LIVENESS_GUIDANCE[face.livenessGuidance]
      : face.livenessStatus === "INCONCLUSIVE"
        ? "Move slightly, keep looking at the camera"
        : null;
    if (guidance) {
      return {
        title: guidance,
        loading: true,
        color: "#f59e0b",
        tint: "rgba(245,158,11,0.10)",
        surface: "rgba(255,255,255,0.98)",
      };
    }

    if (lockedCandidateRef.current != null && face.isLive !== true) {
      return {
        title: "Verifying it's really you…",
        loading: true,
        color: "#5d5fef",
        tint: "rgba(93,95,239,0.10)",
        surface: "rgba(255,255,255,0.98)",
      };
    }
    return {
      title: "Verifying face",
      loading: true,
      color: "#5d5fef",
      tint: "rgba(93,95,239,0.10)",
      surface: "rgba(255,255,255,0.98)",
    };
  }, [face, lighting, previewFace, scanBlocker, settings.antiSpoofingEnabled]);

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
    : scanBlocker
      ? scanBlocker.title
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
    : scanBlocker
      ? scanBlocker.message
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

  // Staleness display for the active package. Only meaningful for a real
  // download — cached-only entries carry a synthetic `downloadedAt` of "now",
  // which would render as "Downloaded just now" for a class that was never
  // downloaded at all.
  const packageStaleness = useMemo(() => {
    if (!selectedClassId || downloadedClasses.length === 0) return null;
    const info = downloadedClasses.find((c) => c.classId === selectedClassId);
    if (!info || !info.hasPackage) return null;
    const downloadedMs = Date.now() - new Date(info.downloadedAt).getTime();
    const mins = Math.floor(downloadedMs / 60000);
    if (mins < 1) return 'Downloaded just now';
    if (mins < 60) return `Downloaded ${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Downloaded ${hours}h ago`;
    return `Downloaded ${Math.floor(hours / 24)}d ago`;
  }, [selectedClassId, downloadedClasses]);

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
        livenessStrictness={settings.livenessStrictness}
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
          className="flex-row justify-between items-start w-full"
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
            {/* Sync pending badge */}
            {syncStatus.pendingCount > 0 && (
              <View
                style={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  backgroundColor: '#f59e0b',
                  borderRadius: 10,
                  minWidth: 20,
                  height: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 4,
                  borderWidth: 2,
                  borderColor: '#fff',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '900' }}>
                  {syncStatus.pendingCount}
                </Text>
              </View>
            )}
          </View>

          {/* Right side buttons column: Camera Flip + Circular Class Switcher below */}
          <View className="items-center gap-3">
            {/* 1. Camera Flip Button */}
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

            {/* 2. Circular Class Selector Button (directly below Camera Switch button) */}
            <View
              className="w-12 h-12 rounded-full"
              style={{
                backgroundColor: activePackage ? "#5d5fef" : "rgba(255,255,255,0.95)",
                borderWidth: 1.5,
                borderColor: activePackage ? "#4338ca" : "rgba(241,245,249,0.6)",
                shadowColor: "#5d5fef",
                shadowOffset: { width: 0, height: 3 },
                shadowOpacity: activePackage ? 0.35 : 0.08,
                shadowRadius: 8,
                elevation: 4,
              }}
            >
              <Pressable
                accessibilityLabel="Select class overview"
                accessibilityRole="button"
                onPress={() => {
                  AppSettings.haptic("light");
                  setShowClassPicker(true);
                }}
                className="w-full h-full items-center justify-center rounded-full"
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: "900",
                    color: activePackage ? "#ffffff" : "#0f172a",
                    letterSpacing: 0.5,
                  }}
                >
                  {activePackage ? getClassInitials(activePackage.className) : "??"}
                </Text>
              </Pressable>
              {scannableClasses.length > 0 && (
                <View
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -2,
                    backgroundColor: activePackage ? "#10b981" : "#5d5fef",
                    borderRadius: 8,
                    minWidth: 18,
                    height: 18,
                    alignItems: "center",
                    justifyContent: "center",
                    paddingHorizontal: 3,
                    borderWidth: 2,
                    borderColor: "#fff",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 9, fontWeight: "900" }}>
                    {scannableClasses.length}
                  </Text>
                </View>
              )}
            </View>
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

        {/* Scan blocker. Shown whenever there is no roster to match against, so a
            teacher is told why nothing is happening instead of holding a phone up
            to a camera that can never recognise anyone. Not `pointerEvents="none"`
            — the CTA has to be tappable. */}
        {scanBlocker && !sheetExpanded && (
          <Animated.View
            entering={FadeInDown.duration(260)}
            exiting={FadeOutUp.duration(180)}
            style={{
              position: "absolute",
              left: 24,
              right: 24,
              top: insets.top + 96,
              backgroundColor: "rgba(255,255,255,0.98)",
              borderRadius: 28,
              borderWidth: 1.5,
              borderColor: "#fbbf24",
              paddingHorizontal: 22,
              paddingVertical: 24,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 14,
              zIndex: 25,
            }}
          >
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 18,
                backgroundColor: "#fef3c7",
                borderWidth: 1,
                borderColor: "#fde68a",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Text style={{ fontSize: 26, fontWeight: "900", color: "#b45309" }}>!</Text>
            </View>

            <Text style={{ fontSize: 17, fontWeight: "900", color: "#0f172a", marginBottom: 6 }}>
              {scanBlocker.title}
            </Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: "#475569", lineHeight: 20 }}>
              {scanBlocker.message}
            </Text>

            <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
              <Pressable
                onPress={() => {
                  AppSettings.haptic("light");
                  if (scanBlocker.action === "picker") {
                    setShowClassPicker(true);
                  } else {
                    router.push("/login");
                  }
                }}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 16,
                  backgroundColor: "#5d5fef",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "900" }}>
                  {scanBlocker.cta}
                </Text>
              </Pressable>

              <Pressable
                accessibilityLabel="Check again for class packages"
                onPress={() => {
                  AppSettings.haptic("light");
                  void refreshDownloadedClasses();
                  void loadRosterForClass(selectedClassId);
                }}
                style={{
                  minHeight: 48,
                  paddingHorizontal: 18,
                  borderRadius: 16,
                  backgroundColor: "#f1f5f9",
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "#475569", fontSize: 13, fontWeight: "900" }}>
                  Retry
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        )}

        {livenessPill && (
          <Animated.View
            pointerEvents="none"
            entering={FadeInDown.duration(220)}
            exiting={FadeOutUp.duration(180)}
            style={[
              {
                position: "absolute",
                left: (screenW - livenessPillWidth) / 2,
                width: livenessPillWidth,
                minHeight: 48,
                paddingLeft: 18,
                paddingRight: 12,
                paddingVertical: 8,
                borderRadius: 999,
                backgroundColor: livenessPill.surface,
                borderWidth: 1,
                borderColor: `${livenessPill.color}1A`,
                shadowColor: "#0f172a",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.08,
                shadowRadius: 14,
                elevation: 8,
                zIndex: 30,
              },
              livenessPillAnimatedStyle,
            ]}
          >
            <View className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-sm font-black text-on-surface" numberOfLines={1} style={{ letterSpacing: 0 }}>
                {livenessPill.title}
              </Text>
              {livenessPill.loading ? (
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: livenessPill.tint,
                  }}
                >
                  <Animated.View
                    style={[
                      {
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        borderWidth: 2,
                        borderColor: `${livenessPill.color}30`,
                        borderTopColor: livenessPill.color,
                        borderRightColor: livenessPill.color,
                      },
                      livenessSpinnerAnimatedStyle,
                    ]}
                  />
                </View>
              ) : (
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: livenessPill.tint,
                  }}
                >
                  <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
                    <Path
                      d="M20 6 9 17l-5-5"
                      stroke={livenessPill.color}
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </Svg>
                </View>
              )}
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
      </View>

      {/* Class Overview & Selection Popup Modal Overlay */}
      {showClassPicker && (
        <Pressable
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, zIndex: 100 },
          ]}
          onPress={() => setShowClassPicker(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              backgroundColor: '#ffffff',
              borderRadius: 28,
              paddingVertical: 22,
              paddingHorizontal: 22,
              maxHeight: screenH * 0.78,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 12 },
              shadowOpacity: 0.25,
              shadowRadius: 32,
              elevation: 16,
            }}
          >
            {/* Header Title & Close Button */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(93,95,239,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 14, fontWeight: '900', color: '#5d5fef' }}>
                    {activePackage ? getClassInitials(activePackage.className) : "CL"}
                  </Text>
                </View>
                <View>
                  <Text style={{ fontSize: 16, fontWeight: '900', color: '#0f172a' }}>
                    Class Overview
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: '#64748b' }}>
                    Active scanning roster & packages
                  </Text>
                </View>
              </View>

              <Pressable
                onPress={() => {
                  AppSettings.haptic('light');
                  setShowClassPicker(false);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: '#f1f5f9',
                  alignItems: 'center',
                  justifyContent: 'center',
                  alignSelf: 'flex-start',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '900', color: '#64748b' }}>✕</Text>
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ flexGrow: 0 }}>
              {/* Active Selected Class Detailed Card */}
              {activePackage ? (
                <View
                  style={{
                    backgroundColor: '#ffffff',
                    borderWidth: 1.5,
                    borderColor: 'rgba(93,95,239,0.2)',
                    borderRadius: 22,
                    padding: 16,
                    marginBottom: 20,
                    shadowColor: '#5d5fef',
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.06,
                    shadowRadius: 12,
                    elevation: 3,
                  }}
                >
                  {/* Top Row: Avatar Initials + Class Name + Active Pill */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                      <View
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: 16,
                          backgroundColor: '#5d5fef',
                          alignItems: 'center',
                          justifyContent: 'center',
                          shadowColor: '#5d5fef',
                          shadowOffset: { width: 0, height: 3 },
                          shadowOpacity: 0.25,
                          shadowRadius: 6,
                          elevation: 4,
                        }}
                      >
                        <Text style={{ fontSize: 18, fontWeight: '900', color: '#ffffff' }}>
                          {getClassInitials(activePackage.className)}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 16, fontWeight: '900', color: '#0f172a' }} numberOfLines={1}>
                          {activePackage.className}
                        </Text>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748b', marginTop: 1 }}>
                          Selected Roster
                        </Text>
                      </View>
                    </View>
                    <View style={{ backgroundColor: '#dcfce7', borderWidth: 1, borderColor: '#86efac', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                      <Text style={{ fontSize: 10, fontWeight: '900', color: '#166534' }}>
                        ACTIVE
                      </Text>
                    </View>
                  </View>

                  {/* Minimal 3-Metric Stats Row */}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {/* 1. Students Enrolled */}
                    <View style={{ flex: 1, backgroundColor: '#f8fafc', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 6, borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center' }}>
                      <Text style={{ fontSize: 18, fontWeight: '900', color: '#0f172a' }}>
                        {activePackage.students.length}
                      </Text>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#64748b', marginTop: 2, textAlign: 'center' }}>
                        Enrolled
                      </Text>
                    </View>

                    {/* 2. Today's Attended */}
                    <View style={{ flex: 1, backgroundColor: 'rgba(16,185,129,0.06)', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 6, borderWidth: 1, borderColor: 'rgba(16,185,129,0.2)', alignItems: 'center' }}>
                      <Text style={{ fontSize: 18, fontWeight: '900', color: '#10b981' }}>
                        {sessionLog.filter((m) => m.classId === activePackage.classId).length}
                      </Text>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#047857', marginTop: 2, textAlign: 'center' }}>
                        Attended
                      </Text>
                    </View>

                    {/* 3. Last Synced */}
                    <View style={{ flex: 1, backgroundColor: '#f8fafc', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 6, borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '900', color: '#0f172a' }} numberOfLines={1}>
                        {packageStaleness ? packageStaleness.replace('Downloaded ', '') : "Never"}
                      </Text>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#64748b', marginTop: 2, textAlign: 'center' }}>
                        Last Synced
                      </Text>
                    </View>
                  </View>
                </View>
              ) : null}

              {/* Downloaded Classes Picker Section */}
              <View style={{ marginBottom: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '900', color: '#475569', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>
                  Available Class Packages ({scannableClasses.length} of {downloadedClasses.length} downloaded)
                </Text>

                {downloadedClasses.length === 0 ? (
                  <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: '#f8fafc', borderRadius: 16, borderWidth: 1, borderColor: '#e2e8f0' }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#64748b', textAlign: 'center', lineHeight: 20 }}>
                      No class packages downloaded yet.{'\n'}
                      Go to Admin Panel → Classes to download embeddings for offline scanning.
                    </Text>
                  </View>
                ) : (
                  downloadedClasses.map((cls) => {
                    const isSelected = cls.classId === selectedClassId;
                    const dlMs = Date.now() - new Date(cls.downloadedAt).getTime();
                    const dlMins = Math.floor(dlMs / 60000);
                    let staleTxt = 'Just now';
                    if (dlMins >= 60 * 24) staleTxt = `${Math.floor(dlMins / (60 * 24))}d ago`;
                    else if (dlMins >= 60) staleTxt = `${Math.floor(dlMins / 60)}h ago`;
                    else if (dlMins >= 1) staleTxt = `${dlMins}m ago`;

                    const initials = getClassInitials(cls.className);

                    return (
                      <Pressable
                        key={cls.classId}
                        onPress={() => {
                          AppSettings.haptic('light');
                          setSelectedClassId(cls.classId);
                          setShowClassPicker(false);
                        }}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          backgroundColor: isSelected ? 'rgba(93,95,239,0.08)' : '#ffffff',
                          borderWidth: isSelected ? 1.5 : 1,
                          borderColor: isSelected ? '#5d5fef' : '#e2e8f0',
                          borderRadius: 16,
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          marginBottom: 8,
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                          <View
                            style={{
                              width: 38,
                              height: 38,
                              borderRadius: 12,
                              backgroundColor: isSelected ? '#5d5fef' : '#f1f5f9',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text style={{ fontSize: 14, fontWeight: '900', color: isSelected ? '#ffffff' : '#475569' }}>
                              {initials}
                            </Text>
                          </View>

                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 14, fontWeight: '800', color: '#0f172a' }}>
                              {cls.className}
                            </Text>
                            {cls.hasPackage ? (
                              <Text style={{ fontSize: 11, fontWeight: '600', color: '#64748b', marginTop: 2 }}>
                                {cls.studentCount} students • Downloaded {staleTxt}
                              </Text>
                            ) : (
                              <Text style={{ fontSize: 11, fontWeight: '800', color: '#b45309', marginTop: 2 }}>
                                {cls.studentCount > 0
                                  ? `${cls.studentCount} waiting to upload • package not downloaded`
                                  : 'Package not downloaded — cannot scan'}
                              </Text>
                            )}
                          </View>
                        </View>

                        {isSelected ? (
                          <View style={{
                            width: 24, height: 24, borderRadius: 12,
                            backgroundColor: '#5d5fef', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
                              <Path d="M20 6 9 17l-5-5" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
                            </Svg>
                          </View>
                        ) : (
                          <View style={{
                            width: 24, height: 24, borderRadius: 12,
                            borderWidth: 1.5, borderColor: '#cbd5e1',
                          }} />
                        )}
                      </Pressable>
                    );
                  })
                )}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      )}
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
