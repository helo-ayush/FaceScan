import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { CameraView } from "expo-camera";
import { useFaceDetection } from "@infinitered/react-native-mlkit-face-detection";

export type DetectedFace = {
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

type FaceTrackingResult = {
  face: DetectedFace | null;
  error: string | null;
};

const DETECTION_INTERVAL_MS = 650;

/**
 * Samples the existing Expo Camera preview at a modest rate. This deliberately
 * keeps only one ML Kit request in flight so the UI remains responsive.
 */
export function useFaceTracking(
  cameraRef: RefObject<CameraView>,
  enabled: boolean,
): FaceTrackingResult {
  const detector = useFaceDetection();
  const [face, setFace] = useState<DetectedFace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const mounted = useRef(true);

  const detectFrame = useCallback(async () => {
    if (!enabled || requestInFlight.current || !cameraRef.current) return;

    requestInFlight.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.35,
        base64: false,
        exif: false,
      });
      if (!photo) {
        if (mounted.current) {
          setFace(null);
        }
        return;
      }

      const result = await detector.detectFaces(photo.uri);
      const faces = result?.faces ?? [];
      const largestFace = faces.reduce<(typeof faces)[number] | null>(
        (largest, candidate) => {
          const candidateArea = candidate.frame.size.x * candidate.frame.size.y;
          const largestArea = largest
            ? largest.frame.size.x * largest.frame.size.y
            : 0;
          return candidateArea > largestArea ? candidate : largest;
        },
        null,
      );

      if (!mounted.current) return;

      if (!largestFace) {
        setFace(null);
        setError(null);
        return;
      }

      setFace({
        imageWidth: photo.width,
        imageHeight: photo.height,
        x: largestFace.frame.origin.x,
        y: largestFace.frame.origin.y,
        width: largestFace.frame.size.x,
        height: largestFace.frame.size.y,
        trackingId: largestFace.trackingID ?? null,
        smilingProbability: largestFace.smilingProbability ?? null,
        leftEyeOpenProbability: largestFace.leftEyeOpenProbability ?? null,
        rightEyeOpenProbability: largestFace.rightEyeOpenProbability ?? null,
      });
      setError(null);
    } catch (captureError) {
      if (mounted.current) {
        setFace(null);
        setError(
          captureError instanceof Error
            ? captureError.message
            : "Face detection is unavailable.",
        );
      }
    } finally {
      requestInFlight.current = false;
    }
  }, [cameraRef, detector, enabled]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setFace(null);
      return () => undefined;
    }

    void detectFrame();
    const interval = setInterval(() => void detectFrame(), DETECTION_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      mounted.current = false;
    };
  }, [detectFrame, enabled]);

  return { face, error };
}
