import React, { useCallback, useEffect, useRef, useState } from "react";
import { LayoutChangeEvent, StyleSheet } from "react-native";
import { PERFORMANCE_PRESETS, PerformanceMode } from "@/utils/settings";
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
};

export type RealtimeLighting = {
  frameBrightness: number | null;
  brightPixelRatio: number | null;
};

type Props = {
  onFaceChange: (face: RealtimeFace | null) => void;
  onLightingChange: (lighting: RealtimeLighting) => void;
  performanceMode: PerformanceMode;
  cameraFacing: "front" | "back";
  onCameraReady: () => void;
  onError: (message: string) => void;
  onPreviewLayout: (event: LayoutChangeEvent) => void;
};

/**
 * Native ML Kit receives preview frames directly. No photos are captured, so
 * this component has neither shutter feedback nor snapshot processing latency.
 */
export function LiveFaceCamera({
  onFaceChange,
  onLightingChange,
  performanceMode,
  cameraFacing,
  onCameraReady,
  onError,
  onPreviewLayout,
}: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
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
    const gracePeriodMs = Math.max(650, PERFORMANCE_PRESETS[performanceMode].intervalMs * 3);
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
      });
    },
    [onFaceChange, onLightingChange, performanceMode, scheduleFaceClear, size.height, size.width],
  );

  return (
    <CameraView
      style={StyleSheet.absoluteFillObject}
      facing={cameraFacing}
      onLayout={handleLayout}
      onCameraReady={onCameraReady}
      onMountError={(cameraError) => onError(cameraError.message)}
      onFacesDetected={handleFacesDetected}
      faceDetectorSettings={{
        mode: FaceDetectorMode.fast,
        detectLandmarks: FaceDetectorLandmarks.none,
        runClassifications: FaceDetectorClassifications.all,
        tracking: true,
        minDetectionInterval: PERFORMANCE_PRESETS[performanceMode].intervalMs,
      }}
    />
  );
}
