import React from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

type IconProps = {
  name: string;
  size?: number;
  color?: string;
  className?: string;
};

// Map web Material Symbols icon names to Expo MaterialIcons names
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
};

export function Icon({ name, size = 24, color = "#424656", className }: IconProps) {
  const iconName = ICON_MAP[name] || (name.replace(/_/g, "-") as keyof typeof MaterialIcons.glyphMap);
  return <MaterialIcons name={iconName} size={size} color={color} className={className} />;
}
