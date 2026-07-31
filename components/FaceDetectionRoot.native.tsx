import React, { PropsWithChildren } from "react";
import {
  FaceDetectionProvider,
  RNMLKitFaceDetectorOptions,
} from "@infinitered/react-native-mlkit-face-detection";

const detectorOptions: RNMLKitFaceDetectorOptions = {
  performanceMode: "fast",
  classificationMode: true,
  landmarkMode: false,
  contourMode: false,
  minFaceSize: 0.12,
  isTrackingEnabled: true,
};

/** Provides the on-device ML Kit detector to native screens. */
export function FaceDetectionRoot({ children }: PropsWithChildren) {
  return (
    <FaceDetectionProvider options={detectorOptions}>
      {children}
    </FaceDetectionProvider>
  );
}
