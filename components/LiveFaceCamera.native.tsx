import React, { useCallback, useState } from "react";
import { LayoutChangeEvent, StyleSheet } from "react-native";
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
};

type Props = {
  onFaceChange: (face: RealtimeFace | null) => void;
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
  onCameraReady,
  onError,
  onPreviewLayout,
}: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
    onPreviewLayout(event);
  };

  const handleFacesDetected = useCallback(
    ({ faces }: FaceDetectionResult) => {
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
        onFaceChange(null);
        return;
      }

      onFaceChange({
        imageWidth: size.width,
        imageHeight: size.height,
        x: largest.bounds.origin.x,
        y: largest.bounds.origin.y,
        width: largest.bounds.size.width,
        height: largest.bounds.size.height,
        trackingId: largest.faceID ?? null,
        smilingProbability: largest.smilingProbability ?? null,
        leftEyeOpenProbability: largest.leftEyeOpenProbability ?? null,
        rightEyeOpenProbability: largest.rightEyeOpenProbability ?? null,
      });
    },
    [onFaceChange, size.height, size.width],
  );

  return (
    <CameraView
      style={StyleSheet.absoluteFillObject}
      facing="front"
      onLayout={handleLayout}
      onCameraReady={onCameraReady}
      onMountError={(cameraError) => onError(cameraError.message)}
      onFacesDetected={handleFacesDetected}
      faceDetectorSettings={{
        mode: FaceDetectorMode.fast,
        detectLandmarks: FaceDetectorLandmarks.none,
        runClassifications: FaceDetectorClassifications.all,
        tracking: true,
        minDetectionInterval: 100,
      }}
    />
  );
}
