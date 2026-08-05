import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, StyleSheet } from "react-native";
import { PERFORMANCE_PRESETS, PerformanceMode, SCANNING_PERFORMANCE_PRESETS, ScanningPerformanceMode } from "@/utils/settings";
import { signedAngle } from "@/utils/faceMatching";
import {
  CameraView,
  FaceDetectionResult,
  FaceDetectorClassifications,
  FaceDetectorLandmarks,
  FaceDetectorMode,
} from "react-native-face-detector-camera";

export type RealtimeFace = {
  imageWidth: number;
  imageHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  trackingId: number | null;
  smilingProbability: number | null;
  leftEyeOpenProbability: number | null;
  rightEyeOpenProbability: number | null;
  frameBrightness: number | null;
  faceBrightness: number | null;
  backgroundBrightness: number | null;
  alignmentReady: boolean;
  alignmentRotationDegrees: number | null;
  alignmentScale: number | null;
  normalizationReady: boolean;
  normalizationCoverage: number | null;
  previewBase64: string | null;
  embedding: number[] | null;
  processDurationMs: number | null;
  yawAngle: number | null;
  rollAngle: number | null;
};

export type RealtimeLighting = {
  frameBrightness: number | null;
  brightPixelRatio: number | null;
};

export type LiveFaceCameraProps = {
  cameraRef?: React.RefObject<any>;
  onFaceChange: (face: RealtimeFace | null) => void;
  onLightingChange: (lighting: RealtimeLighting) => void;
  performanceMode: PerformanceMode;
  scanningPerformance: ScanningPerformanceMode;
  cameraFacing: "front" | "back";
  showNativeOverlay?: boolean;
  smoothNativeOverlay?: boolean;
  onCameraReady: () => void;
  onError: (message: string) => void;
  onPreviewLayout: (event: LayoutChangeEvent) => void;
};

/**
 * Native ML Kit receives preview frames directly.
 */
export function LiveFaceCamera({
  cameraRef,
  onFaceChange,
  onLightingChange,
  performanceMode,
  scanningPerformance,
  cameraFacing,
  showNativeOverlay = true,
  smoothNativeOverlay = true,
  onCameraReady,
  onError,
  onPreviewLayout,
}: LiveFaceCameraProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const faceDetectorSettings = useMemo(
    () => ({
      mode: FaceDetectorMode.fast,
      // Native step 2 uses ML Kit eye landmarks to build the alignment transform.
      detectLandmarks: FaceDetectorLandmarks.all,
      runClassifications: FaceDetectorClassifications.all,
      tracking: true,
      showNativeOverlay,
      smoothNativeOverlay,
      minDetectionInterval: (PERFORMANCE_PRESETS[performanceMode] || PERFORMANCE_PRESETS.balanced).intervalMs,
      scanningIntervalMs: (SCANNING_PERFORMANCE_PRESETS[scanningPerformance] || SCANNING_PERFORMANCE_PRESETS.standard).intervalMs,
    }),
    [performanceMode, scanningPerformance, showNativeOverlay, smoothNativeOverlay],
  );
  const brightnessRef = useRef<Record<"frame" | "face" | "background" | "highlights", number | null>>({
    frame: null,
    face: null,
    background: null,
    highlights: null,
  });
  const clearFaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFaceClear = useCallback(() => {
    if (clearFaceTimerRef.current !== null) return;

    // A single ML Kit miss is normal in a live stream. Keep the last valid box
    // through a few scan windows, then clear it only when loss is sustained.
    const gracePeriodMs = Math.max(650, (PERFORMANCE_PRESETS[performanceMode] || PERFORMANCE_PRESETS.balanced).intervalMs * 3);
    clearFaceTimerRef.current = setTimeout(() => {
      clearFaceTimerRef.current = null;
      onFaceChange(null);
    }, gracePeriodMs);
  }, [onFaceChange, performanceMode]);

  useEffect(() => () => {
    if (clearFaceTimerRef.current !== null) {
      clearTimeout(clearFaceTimerRef.current);
    }
  }, []);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
    onPreviewLayout(event);
  };

  const handleFacesDetected = useCallback(
    ({ faces, frameBrightness, brightPixelRatio }: FaceDetectionResult & {
      frameBrightness?: number;
      brightPixelRatio?: number;
    }) => {
      const smoothBrightness = (
        key: "frame" | "face" | "background" | "highlights",
        value: number | undefined,
      ) => {
        if (value === undefined) return null;
        const previous = brightnessRef.current[key];
        const next = previous === null ? value : previous * 0.72 + value * 0.28;
        brightnessRef.current[key] = next;
        return next;
      };
      const smoothedFrame = smoothBrightness("frame", frameBrightness);
      onLightingChange({
        frameBrightness: smoothedFrame,
        brightPixelRatio: smoothBrightness("highlights", brightPixelRatio),
      });

      const largest = faces.reduce<(typeof faces)[number] | null>(
        (current, candidate) => {
          const candidateArea =
            candidate.bounds.size.width * candidate.bounds.size.height;
          const currentArea = current
            ? current.bounds.size.width * current.bounds.size.height
            : 0;
          return candidateArea > currentArea ? candidate : current;
        },
        null,
      );

      if (!largest || !size.width || !size.height) {
        scheduleFaceClear();
        return;
      }

      if (clearFaceTimerRef.current !== null) {
        clearTimeout(clearFaceTimerRef.current);
        clearFaceTimerRef.current = null;
      }

      const lightingFace = largest as (typeof faces)[number] & {
        frameBrightness?: number;
        faceBrightness?: number;
        backgroundBrightness?: number;
        imageWidth?: number;
        imageHeight?: number;
        alignment?: {
          isReady?: boolean;
          rotationDegrees?: number;
          scale?: number;
        };
        normalization?: {
          isReady?: boolean;
          coverage?: number;
          previewBase64?: string;
          embedding?: number[];
          processDurationMs?: number;
        };
      };
      onFaceChange({
        imageWidth: lightingFace.imageWidth ?? size.width,
        imageHeight: lightingFace.imageHeight ?? size.height,
        x: largest.bounds.origin.x,
        y: largest.bounds.origin.y,
        width: largest.bounds.size.width,
        height: largest.bounds.size.height,
        trackingId: largest.faceID ?? null,
        smilingProbability: largest.smilingProbability ?? null,
        leftEyeOpenProbability: largest.leftEyeOpenProbability ?? null,
        rightEyeOpenProbability: largest.rightEyeOpenProbability ?? null,
        frameBrightness: smoothedFrame,
        faceBrightness: smoothBrightness("face", lightingFace.faceBrightness),
        backgroundBrightness: smoothBrightness("background", lightingFace.backgroundBrightness),
        alignmentReady: lightingFace.alignment?.isReady === true,
        alignmentRotationDegrees: lightingFace.alignment?.rotationDegrees ?? null,
        alignmentScale: lightingFace.alignment?.scale ?? null,
        normalizationReady: lightingFace.normalization?.isReady === true,
        normalizationCoverage: lightingFace.normalization?.coverage ?? null,
        previewBase64: lightingFace.normalization?.previewBase64 ?? null,
        embedding: lightingFace.normalization?.embedding ?? null,
        processDurationMs: lightingFace.normalization?.processDurationMs ?? null,
        // The native detector mirrors front-camera angles into a 0..360 range,
        // so a left turn arrives as 335 rather than -25. Normalize to signed
        // degrees here, once, so every consumer sees a sane value.
        yawAngle: signedAngle((largest as any).yawAngle ?? (largest as any).headEulerAngleY),
        rollAngle: signedAngle((largest as any).rollAngle ?? (largest as any).headEulerAngleZ),
      });
    },
    [onFaceChange, onLightingChange, performanceMode, scheduleFaceClear, size.height, size.width],
  );

  return (
    <CameraView
      ref={cameraRef}
      style={StyleSheet.absoluteFillObject}
      facing={cameraFacing}
      onLayout={handleLayout}
      onCameraReady={onCameraReady}
      onMountError={(cameraError) => onError(cameraError.message)}
      onFacesDetected={handleFacesDetected}
      faceDetectorSettings={faceDetectorSettings}
    />
  );
}
