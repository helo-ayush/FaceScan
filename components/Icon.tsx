import React from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

export type IconProps = {
  /** Icon glyph name (accepts snake_case Material Symbols or MaterialIcons keys). */
  name: string;
  /** Size in density-independent pixels (defaults to 24). */
  size?: number;
  /** Tint color (defaults to '#424656'). */
  color?: string;
  /** Tailwind / NativeWind utility class string. */
  className?: string;
};

/**
 * Maps common web Material Symbols icon identifiers to Expo's MaterialIcons glyph keys.
 */
const ICON_MAP: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  dashboard: "dashboard",
  school: "school",
  person_add: "person-add",
  history: "history",
  how_to_reg: "how-to-reg",
  trending_up: "trending-up",
  schedule: "schedule",
  person_off: "person-off",
  document_scanner: "document-scanner",
  add_circle: "add-circle",
  arrow_forward: "arrow-forward",
  expand_more: "expand-more",
  settings: "settings",
  check_circle: "check-circle",
  check: "check",
  face: "face",
  hourglass_empty: "hourglass-empty",
  camera_alt: "camera-alt",
  chevron_left: "chevron-left",
  chevron_right: "chevron-right",
  cancel: "cancel",
  sync: "sync",
  cloud_sync: "cloud-sync",
  cloud_done: "cloud-done",
  cloud_off: "cloud-off",
  sync_problem: "sync-problem",
  refresh: "refresh",
};

/**
 * Universal vector icon component wrapping Expo's `@expo/vector-icons/MaterialIcons`.
 * Automatically translates web snake_case names (e.g. `person_add`) to native kebab-case glyphs (`person-add`).
 */
export function Icon({ name, size = 24, color = "#424656", className }: IconProps) {
  const iconName = ICON_MAP[name] || (name.replace(/_/g, "-") as keyof typeof MaterialIcons.glyphMap);
  return <MaterialIcons name={iconName} size={size} color={color} className={className} />;
}
