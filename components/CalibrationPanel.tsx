/**
 * Development-only calibration panel.
 *
 * The thresholds in MATCH_TUNING are placeholders until they are measured on
 * real faces. This panel is the control surface for that measurement: turn
 * recording on, declare who is actually in front of the camera, scan for a
 * while, then read the separation between the genuine and impostor score
 * distributions and export the raw rows.
 *
 * Render it behind an `__DEV__` guard — it is a testing instrument, not a
 * product feature.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { Calibration } from "@/utils/calibration";
import { MATCH_TUNING } from "@/utils/faceMatching";

type Props = {
  /** Distance from the top of the screen, so the panel clears the header row. */
  topOffset: number;
  /**
   * Enrolled roster, used only to warn when the typed ground truth matches
   * nobody — in that case every recorded row would be counted as an impostor
   * and the summary would be silently meaningless.
   */
  students: { name: string; enrollmentNumber: string }[];
};

function formatStats(
  label: string,
  stats: { n: number; min: number; p05: number; median: number; p95: number; max: number; mean: number } | null,
) {
  if (!stats) return `${label}: no samples yet`;
  return (
    `${label} (n=${stats.n})\n` +
    `  min ${stats.min.toFixed(3)}  p05 ${stats.p05.toFixed(3)}  ` +
    `med ${stats.median.toFixed(3)}  p95 ${stats.p95.toFixed(3)}  max ${stats.max.toFixed(3)}`
  );
}

export function CalibrationPanel({ topOffset, students }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [truthDraft, setTruthDraft] = useState(Calibration.currentTruth);
  const [enabled, setEnabled] = useState(Calibration.isEnabled);
  const [rowCount, setRowCount] = useState(Calibration.rowCount);
  const [summaryText, setSummaryText] = useState<string | null>(null);

  // The recorder fires a notification on every frame. Sampling it at 2 Hz keeps
  // the panel live without re-rendering the scanner screen ten times a second.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = Calibration.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setEnabled(Calibration.isEnabled);
        setRowCount(Calibration.rowCount);
      }, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const truthMatchesRoster = useMemo(() => {
    const truth = truthDraft.trim().toLowerCase();
    if (!truth) return null;
    return students.some(
      (s) =>
        s.name.trim().toLowerCase() === truth ||
        s.enrollmentNumber.trim().toLowerCase() === truth,
    );
  }, [truthDraft, students]);

  const handleToggle = () => {
    const next = !Calibration.isEnabled;
    Calibration.setEnabled(next);
    setEnabled(next);
    if (next) setExpanded(true);
  };

  const handleSummary = () => {
    Calibration.logSummary();
    const s = Calibration.summary();
    const lines = [
      `frames ${Calibration.frameCount} · rows ${Calibration.rowCount}`,
      formatStats("genuine ", s.genuine),
      formatStats("impostor", s.impostor),
    ];
    if (s.separation === null) {
      lines.push("separation: need both a genuine and an impostor sample");
    } else {
      lines.push(`separation: ${s.separation.toFixed(3)}`);
      if (s.separation > 0 && s.suggestedAccept !== null) {
        lines.push(
          `→ set acceptSimilarity ≈ ${s.suggestedAccept} ` +
            `(currently ${MATCH_TUNING.acceptSimilarity})`,
        );
      } else {
        lines.push("→ OVERLAP: no safe threshold. Improve alignment or swap the model.");
      }
    }
    setSummaryText(lines.join("\n"));
  };

  if (!expanded) {
    return (
      <View style={{ position: "absolute", top: topOffset, right: 16 }}>
        <Pressable
          onPress={() => setExpanded(true)}
          style={{
            backgroundColor: enabled ? "#dc2626" : "rgba(15,23,42,0.75)",
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 999,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>
            {enabled ? `● REC ${rowCount}` : "CALIBRATE"}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={{
        position: "absolute",
        top: topOffset,
        left: 16,
        right: 16,
        maxHeight: 340,
        backgroundColor: "rgba(15,23,42,0.94)",
        borderRadius: 20,
        borderWidth: 1,
        borderColor: "rgba(148,163,184,0.35)",
        padding: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: "#fff", fontSize: 13, fontWeight: "900" }}>
          Threshold calibration
        </Text>
        <Pressable onPress={() => setExpanded(false)} hitSlop={10}>
          <Text style={{ color: "#94a3b8", fontSize: 12, fontWeight: "800" }}>HIDE</Text>
        </Pressable>
      </View>

      <ScrollView style={{ marginTop: 10 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: "#94a3b8", fontSize: 10, fontWeight: "700", marginBottom: 4 }}>
          WHO IS IN FRONT OF THE CAMERA (name or enrollment no.)
        </Text>
        <TextInput
          value={truthDraft}
          onChangeText={(text) => {
            setTruthDraft(text);
            Calibration.setTruth(text);
          }}
          placeholder="e.g. Ayush Kumar"
          placeholderTextColor="#64748b"
          autoCapitalize="words"
          autoCorrect={false}
          style={{
            backgroundColor: "rgba(255,255,255,0.08)",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: truthMatchesRoster === false ? "#f59e0b" : "rgba(148,163,184,0.3)",
            color: "#fff",
            fontSize: 13,
            fontWeight: "700",
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
        />
        {truthMatchesRoster === false && (
          <Text style={{ color: "#fbbf24", fontSize: 10, fontWeight: "700", marginTop: 4 }}>
            No enrolled student with that name — every row will count as an impostor.
            Use this only when scanning someone who is deliberately NOT enrolled.
          </Text>
        )}
        {truthMatchesRoster === true && (
          <Text style={{ color: "#34d399", fontSize: 10, fontWeight: "700", marginTop: 4 }}>
            Matched to an enrolled student.
          </Text>
        )}

        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Pressable
            onPress={handleToggle}
            style={{
              flex: 1,
              alignItems: "center",
              backgroundColor: enabled ? "#dc2626" : "#22c55e",
              borderRadius: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "900" }}>
              {enabled ? "STOP" : "RECORD"}
            </Text>
          </Pressable>
          <Pressable
            onPress={handleSummary}
            style={{
              flex: 1,
              alignItems: "center",
              backgroundColor: "rgba(255,255,255,0.12)",
              borderRadius: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "900" }}>SUMMARY</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          <Pressable
            onPress={() => Calibration.export()}
            style={{
              flex: 1,
              alignItems: "center",
              backgroundColor: "rgba(255,255,255,0.12)",
              borderRadius: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "900" }}>EXPORT CSV</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Calibration.clear();
              setRowCount(0);
              setSummaryText(null);
            }}
            style={{
              flex: 1,
              alignItems: "center",
              backgroundColor: "rgba(255,255,255,0.12)",
              borderRadius: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "900" }}>CLEAR</Text>
          </Pressable>
        </View>

        <Text style={{ color: "#e2e8f0", fontSize: 11, fontWeight: "700", marginTop: 12 }}>
          {enabled
            ? `Recording · ${rowCount} rows`
            : rowCount > 0
              ? `Paused · ${rowCount} rows kept`
              : "Idle · enter a name, then press RECORD"}
        </Text>

        {summaryText && (
          <Text
            style={{
              color: "#cbd5e1",
              fontFamily: "monospace",
              fontSize: 10,
              lineHeight: 15,
              marginTop: 8,
            }}
          >
            {summaryText}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
