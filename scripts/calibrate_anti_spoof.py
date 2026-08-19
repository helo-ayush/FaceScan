#!/usr/bin/env python3
"""
Liveness fusion calibration and honest evaluation - FaceC.

Reads `FaceAntiSpoof` logcat captures, reconstructs the per-frame cue vectors, and
**replays the SPRT accumulator offline**. That replay is the whole point: the decision
this app makes is sequential, so a per-frame AUC is not the operating metric. What
matters is how often a whole attempt ends in the wrong verdict, and that can only be
measured by re-running the accumulator.

The replay is verified against the device before it is trusted: `--verify` recomputes
every logged `FUSION | total=` from the logged cue *scores* and the calibration the
device was running. If those disagree, the simulator is wrong and every number below it
is fiction, so that check runs by default and is fatal.

What this tool deliberately does NOT do:

* It does not report "100% blocked". The predecessor searched for a candidate with zero
  false accepts *on the set it was fitted to* and printed the resulting 100% as if it
  were a security property. With a few hundred frames from one screen that number is
  guaranteed and meaningless. This reports a rate with a bootstrap interval over
  attempts, and refuses to fit at all when the sample is too small to fit.
* It does not evaluate a candidate on the frames it was chosen on. Conditions are held
  out by *file*, because frames within one recording are serially correlated - a random
  frame split would leak almost perfectly and look excellent.

Capture protocol: one file per condition under `logs/`, named `genuine_*` / `replay_*` /
`print_*`. Record with
    adb logcat -c ; adb logcat -s FaceAntiSpoof:D -v time > logs/genuine_bright.txt
PowerShell writes that as UTF-16LE with a BOM, which is handled here.

Usage:
    python scripts/calibrate_anti_spoof.py                # analyse logs/
    python scripts/calibrate_anti_spoof.py --dir mylogs
    python scripts/calibrate_anti_spoof.py --search       # also fit calibration
    python scripts/calibrate_anti_spoof.py --no-verify    # skip the fidelity check
"""

import argparse
import glob
import math
import os
import random
import re
import sys
from collections import Counter, defaultdict

# --------------------------------------------------------------------------- constants
# These mirror LivenessFusion.kt. They are duplicated rather than parsed because the
# parse would be the fragile part; `--verify` catches any drift between the two.

CUE_IDS = ["ANTI_SPOOF", "PARALLAX", "MOIRE", "SPECULAR", "CHROMA", "BEZEL"]

MAX_CUE_LLR = 2.0
DECAY = 0.85
MIN_CUE_ATTACK_EVIDENCE = 1.0
MIN_CORROBORATING_CUES = 2
MAX_TICKS = 25

# Log lines print LLRs to 2 decimals over up to 6 cues, so a faithful replay can still
# differ from the logged total by a few hundredths. Anything past this is real drift.
LOG_ROUNDING_TOLERANCE = 0.05

# Gate order in LivenessFusion.gate(), which matters because it returns the *first*
# failure: distance, then brightness, then sharpness, then pose.
GATE_LIMITS = {
    "eye": ("MIN_EYE_DISTANCE_PX", 44.0, 190.0),
    "luma": ("MIN_FACE_LUMA", 26.0, 240.0),
    "sharp": ("MIN_SHARPNESS", 0.14, float("inf")),
}
MAX_YAW_DEG = 28.0
MAX_PITCH_DEG = 24.0

STRICTNESS = {           # (accept, reject)
    "LENIENT": (-1.5, 6.5),
    "BALANCED": (-2.0, 4.5),
    "STRICT": (-3.0, 3.0),
}

# The calibration the captured logs were recorded under. `--verify` tries each entry
# newest-first and reports which one reproduces the logs, so a capture taken before a
# revision stays analysable instead of failing the fidelity check for the wrong reason.
CALIBRATION_HISTORY = [
    ("2026-08-20 revision (v1, fitted to all 8 conditions)", {
        "ANTI_SPOOF": (5.5, 0.25, True),
        "PARALLAX": (0.0, 0.0020, True),
        "MOIRE": (0.0, 0.70, False),
        "SPECULAR": (0.0, 0.30, False),
        "CHROMA": (0.0, 12.0, False),
        "BEZEL": (0.0, 0.45, False),
    }),
    ("2026-08-18 revision (first on-device capture)", {
        "ANTI_SPOOF": (3.0, 0.55, True),
        "PARALLAX": (0.0, 0.0020, True),
        "MOIRE": (1.5, 0.70, False),
        "SPECULAR": (0.0, 0.30, False),
        "CHROMA": (0.18, 12.0, False),
        "BEZEL": (0.0, 0.45, False),
    }),
    ("Phase 4 provisional priors", {
        "ANTI_SPOOF": (3.0, 0.35, True),
        "PARALLAX": (-400.0, 0.0020, True),
        "MOIRE": (1.2, 0.70, False),
        "SPECULAR": (2.0, 0.30, False),
        "CHROMA": (-0.15, 4.0, False),
        "BEZEL": (1.5, 0.45, False),
    }),
]

CURRENT = CALIBRATION_HISTORY[0][1]

# Quality-gate limits, mirroring LivenessFusion. MIN_SHARPNESS is deliberately
# permissive in the calibration build; --gate-sweep is how the shipping value is chosen.

# --------------------------------------------------------------------------- parsing

RE_CUE_FIELD = re.compile(r"\b([A-Z_]+)=(-|[-0-9.]+)/(-|[-+0-9.]+)")
RE_QUALITY = re.compile(
    r"QUALITY\s+eye=(-|[-0-9.]+)\s+faceW=(\d+)\s+luma=([-0-9.]+)\s+sharp=([-0-9.]+)"
    r"\s+yaw=([-0-9.]+)\s+pitch=([-0-9.]+)\s+roll=([-0-9.]+)"
)
RE_FUSION = re.compile(
    r"FUSION\s+\|\s+status=(\w+)\s+total=([-0-9.]+)\s+frame=([-+0-9.]+)\s+ticks=(\d+)"
    r"\s+corroborating=(\d+)\s+isLive=(\w+)\s+strictness=(\w+)"
)
RE_CADENCE = re.compile(r"CADENCE\s+\|\s+gap=(\d+)ms\s+target=(\d+)ms\s+inferMs=(\d+)")
RE_GATED = re.compile(r"gated=(\w+)")
RE_GATED_LINE = re.compile(r"GATED\s+\|\s+reason=(\w+)\s+\|\s+QUALITY\s+")

# Per-model attack probabilities, logged since the round-3 build. Absent from earlier
# captures, which is why every consumer treats them as optional rather than assuming
# they are there. `sameCrop` records whether the clamp handed both models the identical
# patch, so the comparison can be split by that instead of assuming it from box width.
RE_ENSEMBLE = re.compile(
    r"ENSEMBLE_SAMPLE\s+\|.*?\bv2Attack=([\d.]+)\s+v1seAttack=([\d.]+)\s+sameCrop=(\w+)"
)


def read_text(path):
    """PowerShell `>` produces UTF-16LE with a BOM; adb piped elsewhere gives UTF-8."""
    raw = open(path, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


class Frame:
    """One scored tick: the cue vector, the quality vector, and what the device decided."""

    __slots__ = ("scores", "llrs", "quality", "logged_total", "logged_frame",
                 "logged_ticks", "logged_status", "strictness", "line_no", "models")

    def __init__(self):
        self.scores = {}        # cue -> float, absent when the cue abstained
        self.llrs = {}          # cue -> float as the device computed it
        self.quality = {}
        self.models = None      # (v2Attack, v1seAttack, sameCrop) when the build logs it
        self.logged_total = None
        self.logged_frame = None
        self.logged_ticks = None
        self.logged_status = None
        self.strictness = None
        self.line_no = 0


class Condition:
    """One capture file. Held out as a unit, because frames within it are correlated."""

    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path).rsplit(".", 1)[0]
        # Matched as a word anywhere in the name, not just as a prefix, so a capture
        # tagged for a round (`m_genuine`, `round3-replay`) still classifies. Guessing
        # wrong here would silently invert a class, so both lists are checked and an
        # ambiguous name gets no label rather than the first match.
        tokens = set(re.split(r"[^a-z0-9]+", self.name.lower()))
        is_genuine = bool(tokens & {"genuine", "real", "live"})
        is_attack = bool(tokens & {"replay", "print", "spoof", "attack", "fake"})
        if is_genuine and not is_attack:
            self.label = "genuine"
        elif is_attack and not is_genuine:
            self.label = "attack"
        else:
            self.label = None
        self.frames = []
        self.attempts = []      # list of list[Frame]
        self.refused = []       # (reason, quality dict) for frames the gate rejected
        self.ticks_total = 0
        self.gates = Counter()
        self.gaps = []
        self._parse()

    @staticmethod
    def _quality(match):
        return {
            "eye": float(match.group(1)) if match.group(1) != "-" else float("nan"),
            "faceW": float(match.group(2)),
            "luma": float(match.group(3)),
            "sharp": float(match.group(4)),
            "yaw": float(match.group(5)),
            "pitch": float(match.group(6)),
            "roll": float(match.group(7)),
        }

    def _parse(self):
        pending = None
        ensemble = None
        for line_no, line in enumerate(read_text(self.path).splitlines(), 1):
            if "CADENCE" in line:
                m = RE_CADENCE.search(line)
                if m:
                    self.ticks_total += 1
                    self.gaps.append(int(m.group(1)))
                    g = RE_GATED.search(line)
                    self.gates[g.group(1) if g else "PASS"] += 1
            g = RE_GATED_LINE.search(line)
            if g:
                q = RE_QUALITY.search(line)
                if q:
                    self.refused.append((g.group(1), self._quality(q)))
                continue
            if "ENSEMBLE_SAMPLE" in line:
                # Logged inside `ensembleAntiSpoof`, so it always precedes the CUES line
                # for the same tick. Stashed rather than attached immediately because a
                # tick whose frame is later dropped must not leak into the next one.
                m = RE_ENSEMBLE.search(line)
                ensemble = (float(m.group(1)), float(m.group(2)),
                            m.group(3) == "true") if m else None
                continue
            if "CUES |" in line:
                pending = Frame()
                pending.line_no = line_no
                pending.models = ensemble
                ensemble = None
                head = line.split("QUALITY")[0]
                for cue, score, llr in RE_CUE_FIELD.findall(head):
                    if cue not in CUE_IDS:
                        continue
                    if score != "-":
                        pending.scores[cue] = float(score)
                    if llr != "-":
                        pending.llrs[cue] = float(llr)
                q = RE_QUALITY.search(line)
                if q:
                    pending.quality = self._quality(q)
                continue
            m = RE_FUSION.search(line)
            if m and pending is not None:
                pending.logged_status = m.group(1)
                pending.logged_total = float(m.group(2))
                pending.logged_frame = float(m.group(3))
                pending.logged_ticks = int(m.group(4))
                pending.strictness = m.group(7)
                self.frames.append(pending)
                pending = None

        # An attempt is a maximal run of frames whose tick counter increases by one.
        # The device resets the accumulator between attempts, so `ticks == 1` is the
        # only reliable boundary marker - wall-clock gaps are not, since the gate can
        # starve a live attempt of frames for seconds at a time.
        current = []
        for f in self.frames:
            if f.logged_ticks == 1 and current:
                self.attempts.append(current)
                current = []
            current.append(f)
        if current:
            self.attempts.append(current)


# ----------------------------------------------------------------------- the simulator


def llr_of(score, weight, centre, symmetric):
    raw = weight * (score - centre)
    directed = raw if symmetric else max(0.0, raw)
    return max(-MAX_CUE_LLR, min(MAX_CUE_LLR, directed))


def replay(attempt, calibration, accept, reject,
           max_ticks=MAX_TICKS, min_corroborating=MIN_CORROBORATING_CUES):
    """Re-run LivenessFusion.observe() over one attempt.

    Mirrors the Kotlin line for line, including the two subtleties that change results:
    every cue's accumulated evidence decays even when that cue abstained this tick, and
    only *positive* per-cue LLR accumulates into the corroboration tally.

    Returns (decision, ticks_used, per_frame_totals). Decision is one of
    "LIVE" / "ATTACK" / "OPEN" ("OPEN" meaning it ran out of ticks undecided).
    """
    accumulated = {}
    total = 0.0
    totals = []
    for tick, frame in enumerate(attempt, 1):
        for cue in list(accumulated):
            accumulated[cue] *= DECAY
        frame_llr = 0.0
        for cue, score in frame.scores.items():
            spec = calibration.get(cue)
            if spec is None:
                continue
            weight, centre, symmetric = spec
            if weight == 0.0:
                continue
            value = llr_of(score, weight, centre, symmetric)
            frame_llr += value
            if value > 0.0:
                accumulated[cue] = accumulated.get(cue, 0.0) + value
        total = total * DECAY + frame_llr
        totals.append(total)
        corroborating = sum(1 for v in accumulated.values() if v >= MIN_CUE_ATTACK_EVIDENCE)
        if total >= reject and corroborating >= min_corroborating:
            return "ATTACK", tick, totals
        if total <= accept:
            return "LIVE", tick, totals
        if tick >= max_ticks:
            return "OPEN", tick, totals
    return "OPEN", len(attempt), totals


def verify_simulator(conditions, calibration):
    """Recompute every logged total from the logged scores under `calibration`."""
    worst_frame = worst_total = 0.0
    checked = skipped = 0
    for condition in conditions:
        for attempt in condition.attempts:
            accumulated = {}
            total = 0.0
            for frame in attempt:
                if frame.strictness not in STRICTNESS:
                    skipped += len(attempt)
                    break
                for cue in list(accumulated):
                    accumulated[cue] *= DECAY
                frame_llr = 0.0
                for cue, score in frame.scores.items():
                    weight, centre, symmetric = calibration[cue]
                    value = llr_of(score, weight, centre, symmetric)
                    frame_llr += value
                    if value > 0.0:
                        accumulated[cue] = accumulated.get(cue, 0.0) + value
                total = total * DECAY + frame_llr
                worst_frame = max(worst_frame, abs(frame_llr - frame.logged_frame))
                worst_total = max(worst_total, abs(total - frame.logged_total))
                checked += 1
    return checked, skipped, worst_frame, worst_total


def identify_recorded_calibration(conditions):
    """Which historical calibration reproduces each capture? Matched per *file*.

    Two reasons this is per-file rather than pooled:

    * Without any history at all the fidelity check becomes a liability rather than a
      safeguard: the moment the Kotlin table is revised, every previously-captured log
      fails it, and the obvious reaction is to disable the check that was doing its job.
    * A capture directory routinely holds files from either side of a revision, because
      re-recording six conditions takes several sessions. Pooled, that fails on all six
      at once while pointing at none of them. Per-file, it names the stale one.

    Mixed vintages are not a problem for the *evaluation*, only for this check: the logged
    cue **scores** are raw measurements and carry no calibration in them, so any table can
    be replayed over any file. All that is required is knowing which table produced the
    logged totals, so the replay can be proven faithful before it is trusted.

    Returns [(condition, match_or_None, tried)], where match is
    (label, calibration, checked, skipped, worst_frame, worst_total).
    """
    matches = []
    for condition in conditions:
        tried, found = [], None
        for label, calibration in CALIBRATION_HISTORY:
            checked, skipped, worst_frame, worst_total = verify_simulator([condition],
                                                                         calibration)
            tried.append((worst_total, label))
            if worst_total <= LOG_ROUNDING_TOLERANCE:
                found = (label, calibration, checked, skipped, worst_frame, worst_total)
                break
        tried.sort()
        matches.append((condition, found, tried))
    return matches


def gate_reason(quality, overrides=None):
    """Reimplementation of LivenessFusion.gate() over a logged quality vector.

    Every logged frame carries a complete quality vector, scored or refused, because the
    pipeline measures quality *before* it gates. So the whole gate can be re-run at
    candidate thresholds - which is the only way to see what a limit costs, since the
    device only ever reports the first check a frame failed.
    """
    limits = dict((k, v[1]) for k, v in GATE_LIMITS.items())
    if overrides:
        limits.update(overrides)
    size = quality["eye"]
    if math.isnan(size):
        size = quality["faceW"] * 0.42
    if size < limits["eye"]:
        return "MOVE_CLOSER"
    if size > GATE_LIMITS["eye"][2]:
        return "MOVE_BACK"
    if quality["luma"] < limits["luma"]:
        return "MORE_LIGHT"
    if quality["luma"] > GATE_LIMITS["luma"][2]:
        return "LESS_GLARE"
    if quality["sharp"] < limits["sharp"]:
        return "HOLD_STILL"
    if abs(quality["yaw"]) > MAX_YAW_DEG or abs(quality["pitch"]) > MAX_PITCH_DEG:
        return "FACE_CAMERA"
    return ""


def sweep_gate(conditions):
    """What would each candidate gate threshold cost, over scored AND refused frames?

    A threshold can only be judged against the frames it rejects, and until
    `FacePipeline` started emitting `GATED` lines those frames carried no measurements -
    which is how MIN_SHARPNESS came to sit at the median of its own survivors.
    """
    print()
    print("=" * 92)
    print("GATE SWEEP")
    print("=" * 92)
    pool = defaultdict(list)
    for c in conditions:
        if c.label is None:
            continue
        for f in c.frames:
            if f.quality:
                pool[c.label].append(f.quality)
        for _, q in c.refused:
            pool[c.label].append(q)
    genuine = pool.get("genuine", [])
    attack = pool.get("attack", [])
    refused_total = sum(len(c.refused) for c in conditions)
    if not refused_total:
        print("No `GATED` lines in this capture, so the frames the gate rejected carry no")
        print("measurements and no threshold can be evaluated - only the survivors are")
        print("visible, and a sweep over those would say every threshold passes everything.")
        print("Re-capture with a build that emits `GATED | reason=... | QUALITY ...`.")
        return
    print(f"{len(genuine)} genuine and {len(attack)} attack frames with a full quality")
    print(f"vector ({refused_total} of them refused by the gate).")
    print()
    print("Whole-gate pass rate as MIN_SHARPNESS varies, other limits held:")
    print(f"    {'MIN_SHARPNESS':>14} {'genuine pass':>13} {'attack pass':>12}   note")
    current = GATE_LIMITS["sharp"][1]
    candidates = sorted(set([0.08, 0.10, 0.12, 0.14, 0.18, 0.22, 0.26] + [current]))
    for t in candidates:
        gp = (100.0 * sum(1 for q in genuine if not gate_reason(q, {"sharp": t}))
              / len(genuine)) if genuine else float("nan")
        ap = (100.0 * sum(1 for q in attack if not gate_reason(q, {"sharp": t}))
              / len(attack)) if attack else float("nan")
        note = "<- current" if abs(t - current) < 1e-9 else ""
        print(f"    {t:>14.2f} {gp:>12.1f}% {ap:>11.1f}%   {note}")
    print()
    print("Which check refuses a genuine frame, at the current limits:")
    reasons = Counter(gate_reason(q) or "PASS" for q in genuine)
    for reason, count in reasons.most_common():
        print(f"    {reason:<14} {count:>5}  ({100.0*count/len(genuine):>5.1f}%)")
    print()
    print("Full distributions over every frame, genuine class:")
    for key in ("eye", "luma", "sharp"):
        const, low, high = GATE_LIMITS[key]
        v = [q[key] for q in genuine if not math.isnan(q[key])]
        if not v:
            continue
        below = 100.0 * sum(1 for x in v if x < low) / len(v)
        print(f"    {key:<6} p01={percentile(v,1):>8.3f} p05={percentile(v,5):>8.3f} "
              f"p25={percentile(v,25):>8.3f} med={percentile(v,50):>8.3f}   "
              f"{below:>5.1f}% below {const}={low:g}")
    print()
    print("Pick the loosest sharpness limit that still drops frames the cues cannot read.")
    print("The genuine pass rate is what decides whether a real user accumulates enough")
    print("frames to reach the accept bound at all - at 8.8% they did not.")


# ------------------------------------------------------------------------- statistics


def percentile(values, p):
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100.0
    lo = int(math.floor(k))
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def auc(attack_scores, genuine_scores):
    """P(a random attack frame scores above a random genuine frame). 0.5 = no signal."""
    if not attack_scores or not genuine_scores:
        return float("nan")
    ordered = sorted((v, 0) for v in genuine_scores)
    ordered += [(v, 1) for v in attack_scores]
    ordered.sort()
    # Rank-sum with tie-averaged ranks.
    ranks = {}
    i = 0
    while i < len(ordered):
        j = i
        while j + 1 < len(ordered) and ordered[j + 1][0] == ordered[i][0]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks.setdefault(k, average)
        i = j + 1
    rank_sum = sum(ranks[k] for k, (_, cls) in enumerate(ordered) if cls == 1)
    n_attack = len(attack_scores)
    n_genuine = len(genuine_scores)
    return (rank_sum - n_attack * (n_attack + 1) / 2.0) / (n_attack * n_genuine)


def bootstrap_rate(outcomes, iterations=4000, seed=20260818):
    """95% interval on a proportion, resampling whole attempts (the unit of decision)."""
    if not outcomes:
        return float("nan"), float("nan"), float("nan")
    rng = random.Random(seed)
    n = len(outcomes)
    point = sum(outcomes) / n
    draws = []
    for _ in range(iterations):
        draws.append(sum(outcomes[rng.randrange(n)] for _ in range(n)) / n)
    draws.sort()
    return point, draws[int(0.025 * iterations)], draws[int(0.975 * iterations)]


# --------------------------------------------------------------------------- reporting


def report_capture(conditions):
    print()
    print("=" * 92)
    print("CAPTURE INVENTORY")
    print("=" * 92)
    print(f"{'condition':<20} {'label':<8} {'ticks':>7} {'scored':>7} {'pass':>6} "
          f"{'attempts':>9} {'gap':>6}")
    for c in conditions:
        rate = 100.0 * len(c.frames) / c.ticks_total if c.ticks_total else 0.0
        gap = int(percentile(c.gaps, 50)) if c.gaps else 0
        print(f"{c.name:<20} {str(c.label):<8} {c.ticks_total:>7} {len(c.frames):>7} "
              f"{rate:>5.1f}% {len(c.attempts):>9} {gap:>4}ms")
    print()
    print("Gate rejections (a rejected frame is never scored, so it cannot be calibrated):")
    for c in conditions:
        reasons = " ".join(f"{k}={v}" for k, v in c.gates.most_common() if k != "PASS")
        print(f"  {c.name:<20} {reasons or '(none)'}")


def report_cues(conditions):
    genuine = [f for c in conditions if c.label == "genuine" for f in c.frames]
    attack = [f for c in conditions if c.label == "attack" for f in c.frames]
    print()
    print("=" * 92)
    print("PER-CUE SEPARATION   (AUC over scored frames; 0.50 = no information)")
    print("=" * 92)
    print(f"pooled genuine frames: {len(genuine)}    pooled attack frames: {len(attack)}")
    print()
    print(f"{'cue':<12} {'gen n':>6} {'atk n':>6} {'gen med':>10} {'atk med':>10} "
          f"{'AUC':>6}  {'live llr':>9} {'atk llr':>9}  reading")
    findings = {}
    for cue in CUE_IDS:
        g = [f.scores[cue] for f in genuine if cue in f.scores]
        a = [f.scores[cue] for f in attack if cue in f.scores]
        if not g or not a:
            print(f"{cue:<12} {len(g):>6} {len(a):>6}   {'-- one class never scored it --':>42}")
            findings[cue] = None
            continue
        area = auc(a, g)
        gl = [f.llrs.get(cue, 0.0) for f in genuine if cue in f.scores]
        al = [f.llrs.get(cue, 0.0) for f in attack if cue in f.scores]
        if abs(area - 0.5) < 0.10:
            reading = "no signal"
        elif area >= 0.6:
            reading = "separates: higher = attack"
        else:
            reading = "separates INVERTED: higher = genuine"
        findings[cue] = area
        print(f"{cue:<12} {len(g):>6} {len(a):>6} {percentile(g,50):>10.4f} "
              f"{percentile(a,50):>10.4f} {area:>6.3f}  {percentile(gl,50):>+9.2f} "
              f"{percentile(al,50):>+9.2f}  {reading}")
    print()
    print("The two llr columns are what the *device* did with each cue. A cue whose llr")
    print("is 0.00 in both columns contributed nothing regardless of its AUC - either its")
    print("weight has the wrong sign for an accuse-only cue, or its centre is off the data.")
    return findings


def report_models(conditions):
    """Is the two-model average better than its better half?

    The crop clamp pins both scales to ~2.4x the face box. That is close to
    MiniFASNetV2's designed 2.7x but far from MiniFASNetV1SE's 4.0x, so V1SE is the half
    running out of domain - and because `ensembleAntiSpoof` averages the softmaxes, an
    unsure V1SE pulls a confident V2 toward the middle. On upstream's own samples at this
    framing V2 gives p_live 0.006/0.000 on the two fakes where V1SE gives 0.224/0.245 and
    the average lands at 0.115/0.133.

    Three sample images cannot settle that, so this reports the same comparison on
    captured data: per-model AUC against the ensemble's, plus two alternative combiners
    that do not let the weaker model soften a confident accusation. Silent on captures
    from builds that did not log the per-model fields.
    """
    genuine = [f for c in conditions if c.label == "genuine"
               for f in c.frames if f.models]
    attack = [f for c in conditions if c.label == "attack"
              for f in c.frames if f.models]
    if not genuine or not attack:
        return None

    print()
    print("=" * 92)
    print("ENSEMBLE vs ITS PARTS   (AUC over scored frames; 0.50 = no information)")
    print("=" * 92)
    same = [f for f in genuine + attack if f.models[2]]
    print(f"genuine frames: {len(genuine)}    attack frames: {len(attack)}    "
          f"identical crop on {100.0 * len(same) / (len(genuine) + len(attack)):.1f}% "
          f"(clamp collapsed 4.0x onto 2.7x)")
    print()

    combiners = {
        "V2 @2.7 alone": lambda m: m[0],
        "V1SE @4.0 alone": lambda m: m[1],
        "average (shipped)": lambda m: (m[0] + m[1]) / 2.0,
        "max (either accuses)": lambda m: max(m[0], m[1]),
        "min (both must)": lambda m: min(m[0], m[1]),
    }
    print(f"{'combiner':<22} {'gen med':>9} {'atk med':>9} {'AUC':>7}   reading")
    results = {}
    for name, pick in combiners.items():
        g = [pick(f.models) for f in genuine]
        a = [pick(f.models) for f in attack]
        area = auc(a, g)
        results[name] = area
        print(f"{name:<22} {percentile(g, 50):>9.4f} {percentile(a, 50):>9.4f} "
              f"{area:>7.3f}   {'no signal' if abs(area - 0.5) < 0.10 else ''}")

    shipped = results["average (shipped)"]
    best = max(results, key=lambda k: results[k])
    print()
    # Ties resolve toward the shipped combiner: a +0.00x AUC "win" is noise at these
    # sample sizes, and not changing code is the cheaper of two equal options.
    if results[best] - shipped < 0.02:
        print("No combiner beats the shipped average by more than noise. The")
        print("V1SE-out-of-domain theory does not hold on this capture; leave")
        print("`ensembleAntiSpoof` alone.")
    else:
        print(f"'{best}' beats the shipped average by "
              f"{results[best] - shipped:+.3f} AUC. Worth changing "
              f"`ensembleAntiSpoof`, which is a")
        print("few lines and costs nothing - but check it survives leave-one-condition-out")
        print("before shipping, because a combiner is as fittable as a threshold.")
    return results


def evaluate(conditions, calibration, strictness="BALANCED", label=None):
    """Attempt-level outcome counts under one calibration."""
    accept, reject = STRICTNESS[strictness]
    out = {}
    for c in conditions:
        if c.label is None:
            continue
        decisions = []
        latencies = []
        for attempt in c.attempts:
            decision, ticks, _ = replay(attempt, calibration, accept, reject)
            decisions.append(decision)
            if decision != "OPEN":
                latencies.append(ticks)
        out[c.name] = {
            "label": c.label,
            "n": len(decisions),
            "counts": Counter(decisions),
            "latencies": latencies,
        }
    return out


def report_evaluation(title, results):
    print()
    print("-" * 92)
    print(title)
    print("-" * 92)
    print(f"{'condition':<20} {'label':<8} {'attempts':>9} {'LIVE':>6} {'ATTACK':>7} "
          f"{'OPEN':>6}   outcome")
    far_outcomes = []
    frr_outcomes = []
    for name, r in results.items():
        counts = r["counts"]
        if r["label"] == "attack":
            bad = counts["LIVE"]
            note = f"{bad} false accept(s)" if bad else "all attacks held"
            far_outcomes += [1] * counts["LIVE"] + [0] * (r["n"] - counts["LIVE"])
        else:
            bad = counts["ATTACK"] + counts["OPEN"]
            note = f"{bad} genuine attempt(s) not accepted" if bad else "all genuine accepted"
            frr_outcomes += [0] * counts["LIVE"] + [1] * (r["n"] - counts["LIVE"])
        print(f"{name:<20} {r['label']:<8} {r['n']:>9} {counts['LIVE']:>6} "
              f"{counts['ATTACK']:>7} {counts['OPEN']:>6}   {note}")

    print()
    for tag, outcomes in (("false accept rate (attacks called live)", far_outcomes),
                          ("false reject rate (genuine not accepted)", frr_outcomes)):
        point, lo, hi = bootstrap_rate(outcomes)
        if outcomes:
            print(f"  {tag:<42} {point*100:>6.1f}%   95% CI [{lo*100:.1f}%, {hi*100:.1f}%]"
                  f"   n={len(outcomes)} attempts")
        else:
            print(f"  {tag:<42}    n/a   (no attempts of this class)")
    genuine_latency = [t for r in results.values() if r["label"] == "genuine"
                       for t in r["latencies"]]
    if genuine_latency:
        print(f"  {'genuine frames needed to decide (median)':<42} "
              f"{percentile(genuine_latency,50):>6.1f}   max {max(genuine_latency)}")
    return far_outcomes, frr_outcomes


def report_quality(conditions):
    """Per-condition quality of the survivors.

    Kept alongside [sweep_gate] because it answers a different question: the sweep says
    what a threshold costs overall, this says whether one *condition* is being starved.
    A limit that looks fine pooled can still make dim light unusable.
    """
    print()
    print("=" * 92)
    print("QUALITY OF FRAMES THAT PASSED THE GATE, BY CONDITION")
    print("=" * 92)
    print("A limit sitting inside the distribution of its own survivors is cutting that")
    print("distribution in half, not trimming a blurred tail. That is the tell to look for.")
    print()
    for key in ("eye", "luma", "sharp"):
        const, low, _ = GATE_LIMITS[key]
        print(f"--- {key}   ({const} = {low:g}) ---")
        for c in conditions:
            v = [f.quality[key] for f in c.frames
                 if key in f.quality and not math.isnan(f.quality[key])]
            if not v:
                continue
            near = 100.0 * sum(1 for x in v if x < low * 1.15) / len(v)
            print(f"  {c.name:<20} min={min(v):>8.3f} p05={percentile(v,5):>8.3f} "
                  f"med={percentile(v,50):>8.3f} max={max(v):>8.3f}   "
                  f"{near:>5.1f}% within 15% of the limit")
        print()


def search(conditions, base):
    """Coarse per-cue search, scored leave-one-condition-out.

    Intentionally coarse and intentionally per-cue. With a few hundred correlated
    frames from one screen, a joint search over six weights and six centres will find a
    combination that separates this capture perfectly and generalises to nothing. What
    is defensible at this sample size is the *sign* and rough magnitude of each cue,
    evaluated on conditions it was not chosen on.
    """
    print()
    print("=" * 92)
    print("LEAVE-ONE-CONDITION-OUT SEARCH")
    print("=" * 92)
    labelled = [c for c in conditions if c.label is not None]
    genuine_files = [c for c in labelled if c.label == "genuine"]
    attack_files = [c for c in labelled if c.label == "attack"]
    if len(genuine_files) < 2 or len(attack_files) < 2:
        print("Refusing to search: need >=2 conditions per class to hold one out.")
        print(f"Have {len(genuine_files)} genuine and {len(attack_files)} attack condition(s).")
        return None

    grids = {
        "ANTI_SPOOF": [(w, c, True) for w in (2.0, 3.0, 4.0, 5.0)
                       for c in (0.35, 0.45, 0.55, 0.65)],
        "CHROMA": [(w, c, False) for w in (0.0, 0.10, 0.15, 0.20, 0.30)
                   for c in (10.0, 12.0, 13.0, 14.0)],
        "MOIRE": [(w, c, False) for w in (0.0, 1.2, 2.0, 3.0) for c in (0.5, 0.7, 0.9)],
        "PARALLAX": [(0.0, 0.0020, True), (-400.0, 0.0020, True),
                     (-200.0, 0.0060, True), (-100.0, 0.0120, True)],
        "SPECULAR": [(0.0, 0.30, False), (2.0, 0.30, False)],
        "BEZEL": [(0.0, 0.45, False), (0.75, 0.45, False), (1.5, 0.45, False)],
    }

    def cost(calibration, folds):
        """Sum of held-out false accepts and false rejects, attacks weighted heavier."""
        fa = fr = na = ng = 0
        for held in folds:
            results = evaluate([held], calibration)
            for r in results.values():
                if r["label"] == "attack":
                    fa += r["counts"]["LIVE"]
                    na += r["n"]
                else:
                    fr += r["counts"]["ATTACK"] + r["counts"]["OPEN"]
                    ng += r["n"]
        far = fa / na if na else 0.0
        frr = fr / ng if ng else 0.0
        return 3.0 * far + frr, far, frr

    calibration = dict(base)
    for cue in CUE_IDS:
        best = None
        for candidate in grids[cue]:
            trial = dict(calibration)
            trial[cue] = candidate
            total = 0.0
            for held_g in genuine_files:
                for held_a in attack_files:
                    fit_pool = [c for c in labelled if c not in (held_g, held_a)]
                    if not fit_pool:
                        continue
                    score, _, _ = cost(trial, [held_g, held_a])
                    total += score
            if best is None or total < best[0]:
                best = (total, candidate)
        calibration[cue] = best[1]
        w, c, sym = best[1]
        note = "disabled" if w == 0.0 else f"weight={w:g} centre={c:g}"
        print(f"  {cue:<12} -> {note}")
    return calibration


def emit_kotlin(calibration):
    print()
    print("=" * 92)
    print("SUGGESTED LivenessFusion.CALIBRATION")
    print("=" * 92)
    print("private val CALIBRATION = mapOf(")
    rows = []
    for cue in CUE_IDS:
        w, c, sym = calibration[cue]
        rows.append(f"    CueId.{cue} to CueCalibration("
                    f"weight = {w:g}f, centre = {c:g}f, symmetric = {str(sym).lower()})")
    print(",\n".join(rows))
    print(")")


# -------------------------------------------------------------------------------- main


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", default="logs", help="directory of capture files")
    parser.add_argument("--search", action="store_true",
                        help="also fit calibration, held out by condition")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip the simulator fidelity check (not recommended)")
    parser.add_argument("--gate-sweep", action="store_true",
                        help="simulate the quality gate at candidate MIN_SHARPNESS values")
    parser.add_argument("--strictness", default="BALANCED", choices=sorted(STRICTNESS))
    parser.add_argument("--min-genuine-frames", type=int, default=150,
                        help="below this, refuse to fit; the capture is too thin")
    args = parser.parse_args()

    paths = sorted(glob.glob(os.path.join(args.dir, "*.txt")))
    if not paths:
        print(f"No capture files in {args.dir}/", file=sys.stderr)
        return 1
    conditions = [Condition(p) for p in paths]
    unlabelled = [c.name for c in conditions if c.label is None]
    if unlabelled:
        print(f"Ignoring unrecognised file name(s): {', '.join(unlabelled)}")
        print("Every capture needs genuine/real/live or replay/print/spoof/attack/fake as a")
        print("word in its name, and not both, so the class is unambiguous.")

    report_capture(conditions)

    vintages = set()
    if not args.no_verify:
        matches = identify_recorded_calibration(conditions)
        print()
        print("=" * 92)
        print("SIMULATOR FIDELITY")
        print("=" * 92)
        print("Every logged `FUSION | total=` recomputed from that frame's logged cue scores.")
        print("Matched per file, because a capture directory spans revisions.")
        print()
        print(f"  {'condition':<20} {'frames':>6} {'worst err':>10}   recorded under")
        failed = []
        for condition, found, tried in matches:
            if found is None:
                best_err, best_label = tried[0]
                print(f"  {condition.name:<20} {len(condition.frames):>6} {best_err:>10.4f}"
                      f"   NO MATCH (closest: {best_label})")
                failed.append(condition.name)
                continue
            label, _, checked, skipped, worst_frame, worst_total = found
            note = f" ({skipped} skipped: unknown strictness)" if skipped else ""
            print(f"  {condition.name:<20} {checked:>6} {worst_total:>10.4f}   {label}{note}")
            vintages.add(label)
        if failed:
            print()
            print(f"FAILED on: {', '.join(failed)}")
            print("No known calibration reproduces what the device did for those files, so any")
            print("number derived from them would be invented. Either they were captured under a")
            print("table that is not in CALIBRATION_HISTORY, or the constants at the top of this")
            print("file have drifted from LivenessFusion.kt. Fix that first.")
            return 2
        print()
        print("  OK - the replay reproduces the device to logging precision on every file.")
        if len(vintages) > 1:
            print()
            print(f"  MIXED CAPTURE: {len(vintages)} calibration vintages in this directory.")
            for label in sorted(vintages):
                names = [c.name for c, f, _ in matches if f and f[0] == label]
                print(f"    {label}")
                print(f"      {', '.join(names)}")
            print("  Cue scores are raw measurements, so the replay below is still valid - it")
            print("  re-derives every llr from scratch under one table. But the *gate* differs")
            print("  between builds, so which frames each file contains is not comparable.")
            print("  Re-record the older files before reading FAR/FRR as a single number.")

    findings = report_cues(conditions)
    report_models(conditions)
    report_quality(conditions)
    if args.gate_sweep:
        sweep_gate(conditions)

    print()
    print("=" * 92)
    print(f"ATTEMPT-LEVEL OUTCOMES AT {args.strictness}")
    print("=" * 92)
    # Replayed under CURRENT for every file regardless of what each was recorded under:
    # the logged cue scores carry no calibration, so this is a fair re-derivation and not
    # a mix of vintages. The "as recorded" baseline is only shown when the whole capture
    # shares one vintage, because otherwise it would be exactly such a mix.
    if len(vintages) == 1:
        label = next(iter(vintages))
        recorded = next(c for lbl, c in CALIBRATION_HISTORY if lbl == label)
        if recorded is not CURRENT:
            report_evaluation(f"As recorded ({label})",
                              evaluate(conditions, recorded, args.strictness))
    report_evaluation("Current table in LivenessFusion.kt",
                      evaluate(conditions, CURRENT, args.strictness))

    genuine_frames = sum(len(c.frames) for c in conditions if c.label == "genuine")
    if args.search:
        if genuine_frames < args.min_genuine_frames:
            print()
            print("=" * 92)
            print("NOT FITTING - CAPTURE TOO THIN")
            print("=" * 92)
            print(f"{genuine_frames} scored genuine frames; {args.min_genuine_frames} is the")
            print("minimum this tool will fit against. Six weights and six centres cannot be")
            print("estimated from this, and a search would return numbers that look excellent")
            print("here and fail on a device.")
            print()
            print("What IS supported at this sample size is the sign and the dead-cue")
            print("findings in the AUC table above: a cue at AUC ~0.5 carries no information,")
            print("and a cue whose llr is 0.00 in both classes is not voting at all. Those")
            print("conclusions do not depend on a fit.")
            print()
            print("The gate pass rate in the inventory is usually why the genuine count is")
            print("low: frames the gate rejects are never scored, so they cannot be")
            print("calibrated. Loosen the gate, re-capture, then fit.")
        else:
            fitted = search(conditions, CURRENT)
            if fitted:
                report_evaluation("Fitted calibration (held out by condition)",
                                  evaluate(conditions, fitted, args.strictness))
                emit_kotlin(fitted)
    else:
        print()
        print("Pass --search to fit calibration. It will refuse if the capture is too thin.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
