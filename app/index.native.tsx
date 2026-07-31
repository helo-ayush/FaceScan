import React, { useEffect, useMemo, useState } from "react";
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCameraPermissions } from "react-native-face-detector-camera";
import Svg, { Path } from "react-native-svg";
import Animated, { FadeInDown, FadeInUp, FadeOutUp } from "react-native-reanimated";

import { LiveFaceCamera, RealtimeFace, RealtimeLighting } from "@/components/LiveFaceCamera";
import { AppSettings, useAppSettings } from "@/utils/settings";

type PreviewLayout = {
  width: number;
  height: number;
};

type PreviewFace = {
  left: number;
  top: number;
  width: number;
  height: number;
};

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
        d="M15 3H7a2 2 0 00-2 2v14a2 2 0 00-2 2h8m4-9l-4-4m4 4l-4 4m4-4H9"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Camera previews use "cover" behaviour. Apply the same crop and front-camera
 * mirror to ML Kit's image-space coordinates before drawing the React Native box.
 */
function mapFaceToPreview(
  face: RealtimeFace,
  preview: PreviewLayout,
  mirrored: boolean,
): PreviewFace | null {
  if (!face.imageWidth || !face.imageHeight || !preview.width || !preview.height) {
    return null;
  }

  const scale = Math.max(
    preview.width / face.imageWidth,
    preview.height / face.imageHeight,
  );
  const renderedWidth = face.imageWidth * scale;
  const renderedHeight = face.imageHeight * scale;
  const offsetX = (preview.width - renderedWidth) / 2;
  const offsetY = (preview.height - renderedHeight) / 2;
  const width = face.width * scale;
  const height = face.height * scale;
  const sourceLeft = face.x * scale + offsetX;

  return {
    left: mirrored ? preview.width - sourceLeft - width : sourceLeft,
    top: face.y * scale + offsetY,
    width,
    height,
  };
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

export default function CameraLandingScreen() {
  const router = useRouter();
  const pathname = usePathname();
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

  const isFocused = pathname === "/";
  const previewFace = useMemo(
    () =>
      face && previewLayout
        ? mapFaceToPreview(face, previewLayout, false)
        : null,
    [face, previewLayout],
  );

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
  const smile = probabilityText(face?.smilingProbability ?? null);
  const leftEye = probabilityText(face?.leftEyeOpenProbability ?? null);
  const rightEye = probabilityText(face?.rightEyeOpenProbability ?? null);
  const statusTitle = error
    ? "Detector unavailable"
    : previewFace
      ? "Face detected"
      : "Looking for a face";
  const statusDescription = error
    ? "Restart the development build and check camera permission."
    : previewFace
      ? `Tracking live position${face?.trackingId !== null && face?.trackingId !== undefined ? ` ? Track ${face.trackingId}` : ""}`
      : "Point the camera at one clear, forward-facing face.";

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
        cameraFacing={settings.cameraFacing}
        onFaceChange={setFace}
        onLightingChange={setLighting}
        onCameraReady={() => setCameraReady(true)}
        onError={setError}
        onPreviewLayout={handleCameraLayout}
      />

      {previewFace && (
        <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
          <View
            style={[
              styles.faceFrame,
              {
                left: previewFace.left,
                top: previewFace.top,
                width: previewFace.width,
                height: previewFace.height,
              },
            ]}
          >
            <View style={styles.faceLabel}>
              <Text style={styles.faceLabelText}>FACE DETECTED</Text>
            </View>
          </View>
        </View>
      )}

      <View className="absolute inset-0 justify-between">
        <Animated.View
          entering={FadeInUp.delay(200).duration(500)}
          style={{ paddingTop: insets.top + 16, paddingHorizontal: 24 }}
          className="flex-row justify-between items-center w-full"
        >
          <View className="w-12 h-12 rounded-full bg-white border border-slate-100/50 shadow-medium">
            <Pressable
              onPress={() => {
                AppSettings.haptic("light");
                router.push("/login");
              }}
              className="w-full h-full items-center justify-center rounded-full active:scale-95 transition-all"
            >
              <LoginIcon color="#0f172a" />
            </Pressable>
          </View>

          <View className="w-12 h-12 rounded-full bg-white/90 border border-slate-100/50 shadow-medium">
            <Pressable
              accessibilityLabel="Switch camera"
              accessibilityRole="button"
              onPress={() => {
                triggerHaptic("light");
                updateSetting("cameraFacing", settings.cameraFacing === "front" ? "back" : "front");
                setFace(null);
              }}
              className="w-full h-full items-center justify-center rounded-full active:scale-95 transition-all"
            >
              <FlipIcon color="#0f172a" />
            </Pressable>
          </View>

          {displayedLightingWarning && (
            <Animated.View
              pointerEvents="none"
              entering={FadeInDown.duration(220)}
              exiting={FadeOutUp.duration(180)}
              style={{ position: "absolute", left: 80, right: 80, top: insets.top + 16 }}
              className="h-12 flex-row items-center gap-2 rounded-full border border-amber-200 bg-white/95 px-3 shadow-medium"
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

        <Animated.View
          entering={FadeInDown.delay(100).duration(600)}
          style={{
            paddingBottom: insets.bottom + 20,
            paddingTop: 24,
            paddingHorizontal: 24,
          }}
          className="w-full bg-white/90 border-t border-slate-200/40 rounded-t-[40px] shadow-premium gap-4"
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3.5 flex-1 pr-3">
              <View
                className={
                  previewFace
                    ? "w-11 h-11 rounded-2xl bg-success/10 items-center justify-center border border-success/20"
                    : "w-11 h-11 rounded-2xl bg-primary/10 items-center justify-center border border-primary/10"
                }
              >
                <View
                  className={
                    previewFace
                      ? "w-4 h-4 rounded-full bg-success"
                      : "w-4 h-4 rounded-full bg-primary"
                  }
                >
                  <View className="w-2 h-2 rounded-full bg-white m-auto" />
                </View>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-black text-base tracking-tight">
                  {statusTitle}
                </Text>
                <Text
                  className="text-xs text-on-surface-variant font-bold mt-0.5"
                  numberOfLines={2}
                >
                  {statusDescription}
                </Text>
              </View>
            </View>
            <View
              className={
                previewFace
                  ? "bg-success/15 px-3 py-1.5 rounded-xl border border-success/20"
                  : "bg-primary/10 px-3 py-1.5 rounded-xl border border-primary/20"
              }
            >
              <Text
                className={
                  previewFace
                    ? "text-[10px] font-black text-success uppercase tracking-wider"
                    : "text-[10px] font-black text-primary uppercase tracking-wider"
                }
              >
                {previewFace ? "Tracking" : "Searching"}
              </Text>
            </View>
          </View>

          {previewFace && (smile || leftEye || rightEye) && (
            <View className="flex-row gap-2 pt-1">
              {smile && (
                <View className="bg-slate-100 px-3 py-2 rounded-xl">
                  <Text className="text-[10px] font-black text-on-surface-variant uppercase">
                    Smile {smile}
                  </Text>
                </View>
              )}
              {leftEye && rightEye && (
                <View className="bg-slate-100 px-3 py-2 rounded-xl">
                  <Text className="text-[10px] font-black text-on-surface-variant uppercase">
                    Eyes {leftEye} / {rightEye}
                  </Text>
                </View>
              )}
            </View>
          )}
        </Animated.View>
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
