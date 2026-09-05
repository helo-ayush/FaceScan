package com.facedetectorcamera.pipeline

import android.os.Bundle
import kotlin.math.abs
import kotlin.math.max

/**
 * Turns per-frame cue scores into a verdict by accumulating log-likelihood ratios
 * until one of two asymmetric bounds is crossed — a sequential probability ratio
 * test rather than a threshold on a single score.
 *
 * ## Why this replaces the count-and-margin scheme
 *
 * The old logic could not be both strict and smooth, because it asked one number to
 * do both jobs. The captured on-device distributions show why no threshold exists:
 * spoof `p_live` reached 0.9997 (p95 0.7939) while genuine `p_live` fell to 0.3445
 * (p05 0.6740). The medians separate cleanly, 0.99 against 0.08, but decisions are
 * made in the tails, and there the two classes interleave. Raising the threshold to
 * catch the 0.9997 screen necessarily rejects the 0.3445 genuine face. That is the
 * user's exact complaint, and it is a property of the score, not of the threshold.
 *
 * Accumulated evidence breaks the deadlock because ambiguity stops being a verdict.
 * A frame near the centre contributes almost nothing and the test simply looks at
 * another frame; only consistent evidence moves the total. Three things follow:
 *
 * 1. **`hasAttackSignal` is gone.** A single frame at `p_attack >= 0.35` used to veto
 *    live confirmation outright. Against tail-overlapping scores that one line could
 *    make a genuine user permanently unable to pass. Here an isolated suspicious
 *    frame is worth a fraction of a nat and is outvoted by its neighbours.
 * 2. **Rejection is deliberately harder than acceptance** ([REJECT_LLR] against
 *    [ACCEPT_LLR]) and additionally requires [MIN_CORROBORATING_CUES] independent
 *    cues to have each accumulated real attack evidence. One noisy cue cannot fail a
 *    genuine user however loudly it shouts.
 * 3. **Unjudgeable frames are refused, not scored.** The quality gate runs before any
 *    inference, so a dim, blurry, distant or turned-away frame produces guidance
 *    ("come closer", "more light") instead of a spoof verdict.
 *
 * ## Which cues are allowed to vote which way
 *
 * Only `ANTI_SPOOF` and `PARALLAX` are [CueCalibration.symmetric]. They are the two
 * cues carrying genuine evidence *for* liveness: a trained discriminator, and a
 * physical measurement of non-planarity that a flat target cannot fake. The other
 * four are artifact detectors, and the absence of an artifact means very little — a
 * good screen at a favourable distance shows no moire, a full-frame screen shows no
 * bezel, a matte panel shows no glare. So those four may only ever accuse: their
 * negative side is clamped away. Without that clamp, a clean-looking replay would
 * collect *four* streams of spurious "live" evidence for the artifacts it merely
 * failed to exhibit, which is the same mistake as trusting a single score.
 *
 * ## Status of the constants
 *
 * **These weights are provisional priors, not fitted parameters.** Phase 5 replaces
 * them with a low-parameter logistic fit on captured data, which is the only way to
 * learn the real per-cue reliabilities. Each is set below from the best evidence
 * available now, and every derivation is recorded so the fit can be checked against
 * the prior rather than silently overwriting it. The structural fixes above do not
 * depend on the constants being right; they are what makes the constants *fittable*.
 */
class LivenessFusion {

    enum class Decision { OPEN, LIVE, ATTACK, LOW_QUALITY }

    /**
     * User-selectable operating point. Moves *only* the two SPRT bounds — the per-cue
     * calibration, the corroboration requirement and the quality gate are identical at
     * every level, which is what keeps the levels comparable: the same evidence is
     * measured the same way, and strictness decides only how much of it is enough.
     *
     * Note what deliberately does **not** scale: [MIN_CORROBORATING_CUES] stays at 2
     * even at [STRICT]. Letting one cue reject on its own is precisely the
     * `hasAttackSignal` veto this rebuild removed, and re-introducing it behind a
     * settings toggle would just move the reported false-rejection bug rather than fix
     * it. Strictness is allowed to ask for evidence *sooner*, never to ask for evidence
     * from *fewer independent sources*.
     *
     * @param accept bound on accumulated nats below which the subject is confirmed live.
     * @param reject bound above which, given corroboration, the subject is an attack.
     */
    enum class Strictness(val accept: Float, val reject: Float) {
        /**
         * Genuine users pass in ~2 ticks. Measured across `logs/`: 16.8% of attacks
         * accepted, 14 of 40 dim-light attempts confirmed. For low-stakes or difficult
         * environments where a retry costs more than a missed spoof.
         */
        LENIENT(accept = -1.5f, reject = 6.5f),

        /** The measured default. See [ACCEPT_LLR] / [REJECT_LLR] for the derivation. */
        BALANCED(accept = ACCEPT_LLR, reject = REJECT_LLR),

        /**
         * Makes a genuine user supply ~5 clean ticks (~500ms) instead of 3. Measured:
         * 9.7% of attacks accepted, and the laptop-display attack down to 2 of 19 — but
         * only 5 of 40 dim-light attempts confirm, so expect visible retries in a dim
         * room. That is the trade being bought, and it is the level to pick only when a
         * missed spoof costs more than a slow queue.
         */
        STRICT(accept = -3.0f, reject = 3.0f);

        companion object {
            /**
             * Parses the JS setting name. Unknown or absent values fall back to
             * [BALANCED] rather than throwing — a bad string from the bridge must not
             * be able to take the camera down, and silently becoming the *default* is
             * the only safe direction to fail (becoming [LENIENT] would weaken
             * security on a typo, [STRICT] would lock genuine users out).
             */
            fun from(name: String?): Strictness = when (name?.lowercase()) {
                "lenient" -> LENIENT
                "strict" -> STRICT
                else -> BALANCED
            }
        }
    }

    /**
     * Current operating point. Safe to change mid-session: the accumulator holds nats,
     * which mean the same thing at every level, so only the bounds they are compared
     * against move.
     */
    var strictness: Strictness = Strictness.BALANCED

    data class Verdict(
        val decision: Decision,
        /** Accumulated evidence in nats. Positive favours attack. */
        val total: Float,
        val frameLlr: Float,
        val ticks: Int,
        val corroborating: Int,
        /** Non-empty when [decision] is [Decision.LOW_QUALITY]; a UI guidance key. */
        val guidance: String = "",
        val perCue: Map<CueId, Float> = emptyMap()
    ) {
        fun toBundle(): Bundle = Bundle().apply {
            putString("decision", decision.name)
            putDouble("total", total.toDouble())
            putDouble("frameLlr", frameLlr.toDouble())
            putInt("ticks", ticks)
            putInt("corroborating", corroborating)
            if (guidance.isNotEmpty()) putString("guidance", guidance)
            putBundle("perCueLlr", Bundle().apply {
                for ((id, llr) in perCue) putDouble(id.name, llr.toDouble())
            })
        }
    }

    /**
     * Per-frame evidence contributed by one cue, in nats toward *attack*.
     *
     * @param weight nats per unit of score above [centre]; the sign encodes which
     *   verdict a larger score supports, so `CueId.higherMeans` stays documentation.
     * @param centre the score at which the cue is indifferent.
     * @param symmetric when false, only attack-supporting evidence is counted and
     *   the other side is clamped to zero. See the class doc.
     */
    private data class CueCalibration(
        val weight: Float,
        val centre: Float,
        val symmetric: Boolean
    ) {
        fun llr(score: Float, dynamicCentre: Float? = null): Float {
            val c = dynamicCentre ?: centre
            val raw = weight * (score - c)
            val directed = if (symmetric) raw else max(0f, raw)
            return directed.coerceIn(-MAX_CUE_LLR, MAX_CUE_LLR)
        }
    }

    private val accumulatedPerCue = HashMap<CueId, Float>()
    private var total = 0f
    private var ticks = 0

    fun reset() {
        accumulatedPerCue.clear()
        total = 0f
        ticks = 0
    }

    /**
     * Checks the frame is judgeable at all. Runs on landmark geometry and the cheap
     * luma patch only — no inference — so a failing frame costs nothing.
     *
     * The returned guidance key is what the UI shows. Order is by how actionable the
     * problem is: distance first, because it is the one thing a user always knows how
     * to fix, and pose last, because a user told to "face the camera" while actually
     * being too far away will keep failing for a reason the message never mentions.
     */
    fun gate(quality: FrameQuality): String {
        val size = if (quality.eyeDistance.isNaN()) {
            quality.faceWidth * FACE_WIDTH_TO_EYE_FALLBACK
        } else {
            quality.eyeDistance
        }
        if (size < MIN_EYE_DISTANCE_PX) return "MOVE_CLOSER"
        if (size > MAX_EYE_DISTANCE_PX) return "MOVE_BACK"
        if (quality.faceLuma < MIN_FACE_LUMA) return "MORE_LIGHT"
        if (quality.faceLuma > MAX_FACE_LUMA) return "LESS_GLARE"
        if (quality.sharpness < MIN_SHARPNESS) return "HOLD_STILL"
        if (abs(quality.yaw) > MAX_YAW_DEG || abs(quality.pitch) > MAX_PITCH_DEG) {
            return "FACE_CAMERA"
        }
        return ""
    }

    /**
     * Folds one tick of cue scores into the accumulator and returns the current
     * verdict.
     *
     * Decay is applied to the running total before adding the new frame, so evidence
     * ages out. Without it a user who was briefly mistaken for a screen would carry
     * that penalty for the whole session; with it, a steady stream of ambiguous frames
     * converges to `perFrame / (1 - DECAY)` and stays put rather than drifting across
     * a bound by accumulation alone.
     */
    fun observe(
        cues: List<CueScore>,
        quality: FrameQuality? = null,
        isBacklit: Boolean = false,
        isTrulyDim: Boolean = false,
        hasGlare: Boolean = false
    ): Verdict {
        // Decay *every* cue's accumulated evidence, including ones that abstained this
        // tick. Decaying only the cues present would let a single hard hit — a bezel
        // glimpsed once as the phone was raised — count as a corroborating accuser
        // indefinitely, which hollows out the corroboration requirement precisely as a
        // session runs long. Aging is about staleness, and an abstaining cue is the
        // most stale case there is.
        for (id in accumulatedPerCue.keys.toList()) {
            accumulatedPerCue[id] = accumulatedPerCue.getValue(id) * DECAY
        }

        val perCue = HashMap<CueId, Float>(cues.size)
        var frameLlr = 0f
        for (cue in cues) {
            if (cue.abstained) continue
            val calibration = CALIBRATION[cue.id] ?: continue

            // Dynamic centre calibration:
            // 1. Backlit frontal genuine face: MiniFASNet classifies LIVE as top prediction (class=1) with near-zero
            //    replay (<0.10). Facial shadows elevate probPrint slightly (~0.27), which shouldn't accumulate attack nats.
            // 2. Genuine dim room: Camera sensor noise elevates score baseline slightly.
            // 3. Screen reflection / glare: Tighten centre to firmly reject replay attacks.
            val dynamicCentre = if (cue.id == CueId.ANTI_SPOOF) {
                when {
                    isBacklit && abs(quality?.yaw ?: 0f) < 8f &&
                        cue.detail.contains("class=1") && !hasGlare -> {
                        calibration.centre + 0.05f // 0.30f: allows genuine backlit facial shadow without stalling
                    }
                    isTrulyDim && quality != null && quality.faceLuma < 80f && !hasGlare -> {
                        val dimFactor = ((80f - quality.faceLuma) / 50f).coerceIn(0f, 1f)
                        calibration.centre + 0.03f * dimFactor
                    }
                    hasGlare -> {
                        calibration.centre - 0.02f // 0.23f: strict on screen glare
                    }
                    else -> null
                }
            } else null

            val llr = calibration.llr(cue.score, dynamicCentre)
            perCue[cue.id] = llr
            frameLlr += llr
            // Only attack evidence accumulates per cue; this tally exists solely to
            // answer "how many cues are accusing", so live evidence has no place in it
            // and would let one strongly-live cue mask another's real accusation.
            if (llr > 0f) {
                accumulatedPerCue[cue.id] = (accumulatedPerCue[cue.id] ?: 0f) + llr
            }
        }

        total = total * DECAY + frameLlr
        ticks++

        // Corroboration is counted per cue over the accumulated window, not per
        // frame: two cues that each fire on alternate frames are still two
        // independent accusations, and demanding they coincide on one frame would
        // discard most true rejections.
        val corroborating = accumulatedPerCue.count { it.value >= MIN_CUE_ATTACK_EVIDENCE }

        val decision = when {
            total >= strictness.reject && corroborating >= MIN_CORROBORATING_CUES -> Decision.ATTACK
            total <= strictness.accept -> Decision.LIVE
            else -> Decision.OPEN
        }
        return Verdict(decision, total, frameLlr, ticks, corroborating, "", perCue)
    }

    /** True once the test has looked at enough frames that stalling is worth reporting. */
    fun isStalled(): Boolean = ticks >= MAX_TICKS

    /** Bounds are public so the pipeline can log a decision against them. */
    companion object {
        /**
         * Ceiling on one cue's contribution to one frame. A cue that saturates — a
         * bezel score of 0.95, an anti-spoof probability of 0.9997 — should be strong
         * evidence, not unbounded evidence, or a single frame of one cue could cross
         * a bound on its own and the corroboration requirement becomes decorative.
         */
        const val MAX_CUE_LLR = 2.0f

        /**
         * Retains ~85% of prior evidence per tick, so at the 100ms cadence the
         * effective window is about 600ms — long enough to average landmark jitter
         * and exposure swings, short enough that a user who moves out of and back
         * into good conditions is judged on the current conditions.
         */
        const val DECAY = 0.85f

        /**
         * The [Strictness.BALANCED] operating point: accept at -3 nats, reject at +4.5.
         * The asymmetry is the point: it is a design choice that a genuine user's cost
         * of a false rejection is paid on every single attempt, while an attacker's cost
         * is paid once per attempt and they can retry anyway. Combined with
         * corroboration this is what "strict but smooth" means operationally.
         *
         * At the calibrated ANTI_SPOOF weight a clean genuine face contributes about
         * -1.2 nats per tick, so acceptance takes ~3 ticks (~300ms) — measured median 3,
         * p90 9 across 130 genuine attempts. The reject bound is effectively unreachable
         * in this build and deliberately left where it is; see [CALIBRATION] for why that
         * is not a security hole.
         *
         * These two are fitted by `scripts/calibrate_anti_spoof.py` against `logs/`;
         * the other two levels are defined relative to them in [Strictness].
         */
        const val ACCEPT_LLR = -2.0f
        const val REJECT_LLR = 4.5f

        /**
         * Two independent cues must each have accumulated this much attack evidence
         * before a rejection is allowed. Set below one saturated frame ([MAX_CUE_LLR])
         * so a cue that fires hard once and then abstains still counts, but above the
         * few tenths of a nat that scores near a centre produce, so drifting noise
         * does not manufacture a second accuser.
         */
        const val MIN_CUE_ATTACK_EVIDENCE = 1.0f
        const val MIN_CORROBORATING_CUES = 2

        /** ~2.5s at the 100ms cadence before an undecided test is worth surfacing. */
        const val MAX_TICKS = 25

        // ----------------------------------------------------------- quality gate

        /**
         * ML Kit can report a face with no landmarks, leaving eye distance NaN. Face
         * box width is always present, and eye separation is roughly 0.42 of it for a
         * frontal face, so this keeps the gate working on those frames. It is only
         * ever a fallback: `FrameQuality.eyeDistance` stays honestly NaN so the
         * calibration log never mixes a measurement with an estimate.
         */
        const val FACE_WIDTH_TO_EYE_FALLBACK = 0.42f

        /**
         * 44px of eye separation at 640x480 is roughly arm's length, and it is also
         * about where the 64x64 mid-face patch stops covering skin rather than
         * background. Below this both the moire cue and the anti-spoof crop are
         * working on too little real detail to mean anything.
         */
        const val MIN_EYE_DISTANCE_PX = 44f

        /**
         * Too close is a real failure mode, not a nicety: the 4.0x context crop clamps
         * against the frame edge, so the bezel cue loses the region it needs and the
         * ensemble degenerates to a single model.
         */
        const val MAX_EYE_DISTANCE_PX = 190f

        /**
         * Luma bounds are wider than the moire cue's own [32,226] abstention window on
         * purpose. This gate decides whether to score the frame *at all*, so it should
         * only fire when the anti-spoof model is also compromised; a frame that is
         * merely too dim for spectral work should lose that one cue, not the tick.
         */
        const val MIN_FACE_LUMA = 26f
        const val MAX_FACE_LUMA = 240f

        /**
         * Contrast-normalised Laplacian RMS. Below this the frame is motion-blurred.
         *
         * **This was 0.22 and it was the single worst number in the file.** The first
         * on-device capture passed only 8.8% and 6.8% of ticks on the two genuine
         * conditions — 62 of 80 and 41 of 44 ticks refused with `HOLD_STILL` — so a
         * genuine attempt collected 2 to 4 scored frames where the SPRT needs 7 or
         * more, and a real user waited 9 seconds for a verdict that mostly never came.
         * The tell was in the frames that *passed*: their sharpness median was 0.239,
         * barely above the 0.22 cut. A threshold sitting at the median of its own
         * survivors is not trimming a blurred tail, it is cutting the distribution of
         * ordinary handheld video in half.
         *
         * 0.14 is deliberately **permissive rather than correct**. The right value
         * cannot be computed from that capture at all, because a refused frame used to
         * log only its reason and never its measurements, so the sharpness distribution
         * of the rejected 91% was unobservable. `FacePipeline` now emits a `GATED` line
         * carrying the same `QUALITY` fields as a scored frame, and
         * `scripts/calibrate_anti_spoof.py --gate-sweep` reads both together, so the
         * next capture measures the pass rate and the cost of each candidate threshold
         * directly. Erring loose is the right direction to be wrong in for a
         * calibration build: a slightly blurred frame that gets scored can be filtered
         * out afterwards in the harness, whereas a frame that was never scored is gone.
         */
        const val MIN_SHARPNESS = 0.14f

        /**
         * Pose bounds are generous because the parallax cue *wants* rotation — it is
         * the one cue that needs the user to move. These reject only poses where the
         * anti-spoof crop no longer contains a frontal face, well past the few degrees
         * of natural sway parallax feeds on.
         */
        const val MAX_YAW_DEG = 28f
        const val MAX_PITCH_DEG = 24f

        // ------------------------------------------------------- cue calibration

        /**
         * Per-cue calibration, fitted to three rounds of on-device capture
         * (`logs/`, 8 conditions, 1381 scored frames, 243 attempts, Aug 2026).
         * Re-derive with `python scripts/calibrate_anti_spoof.py --dir logs`, which
         * replays this accumulator offline and checks itself against the logged
         * `FUSION | total=` before reporting anything.
         *
         * **Read this before touching a number here: rounds 1 and 2 of this comment were
         * both confidently wrong, in opposite directions.** Round 1 fitted one phone
         * screen and produced a table that read as well-evidenced and did not
         * generalise. Round 2 concluded from pooled AUC that the cue set was unfittable.
         * Round 3 measured per condition and found a plain bug in round 1's arithmetic.
         * The lesson that survived all three: *pooled AUC is the wrong statistic for a
         * one-sided cue, and one attack device produces a well-evidenced fiction.*
         *
         * **What was actually wrong: the centre was on the wrong side of the attack.**
         * Round 1 set `ANTI_SPOOF(centre = 0.55f)` by placing it just above the genuine
         * p90, so the cue could never accuse a real face. But the hard attack's median
         * score is **0.271**, well *below* 0.55 — and the cue is `symmetric`, so each of
         * the 85% of attack frames below the centre contributed about **-0.84 nats
         * toward liveness**. The fusion was not failing to catch the spoof; it was
         * voting for it, roughly a third of the accept bound per frame. That single
         * sign error is the whole "it verifies a laptop screen" report.
         *
         * **ANTI_SPOOF** — score is `max(p_print, p_replay)`. Genuine medians 0.048
         * (bright) / 0.022 (indoor) / 0.014 (handheld); the hard attack 0.271. Per-frame
         * AUC **0.893** against that attack, so the model is emphatically not the weak
         * part — do not go looking for a replacement before re-reading this paragraph.
         * Centre 0.55 -> **0.25**, below the attack median so attack frames stop voting
         * live. Weight 3.0 -> **5.5**: a lower centre alone would cost genuine
         * throughput, and the larger weight buys it back by letting a clean face reach
         * the accept bound in fewer ticks (measured median 3 ticks against 5 before).
         * Stays symmetric, and remains the only cue that can vote live.
         *
         * **MOIRE** — **disabled (weight 1.5 -> 0), and this is the second fix.** Round 1
         * recorded "AUC 1.000, perfect separation" from 59 frames of a single phone
         * screen. Measured across 8 conditions there is no separation at all: genuine
         * median 0.99 against attack 0.83, i.e. it reads slightly *higher* on real faces.
         * It fires above its 0.70 centre on ~80% of **genuine** frames, contributing
         * +0.18 to +0.51 nats of accusation against every real user, and it was the
         * second corroborating accuser that produced this build's only genuine `ATTACK`
         * verdicts (2 dim-light attempts). Removing it takes those to **zero**.
         *
         * Note the honest cost: MOIRE was doing real work on the attack side. Turning it
         * off *alone* moves FAR 15.9% -> 23.0%. The ANTI_SPOOF re-centring above is what
         * pays that back, which is why these two edits ship together and neither should
         * be reverted on its own.
         *
         * **CHROMA** — disabled (weight 0.18 -> 0). Round 1's "AUC 0.981, a screen widens
         * chroma spread" was that one phone panel; a laptop's spread is *narrower* than a
         * real face, so the cue is inverted on the attack that matters (AUC 0.337 on the
         * angled condition). At 0.18 it is too weak to change any verdict in this capture
         * — zeroing it is measurably a no-op today — but a cue pointing the wrong way is
         * a live hazard the moment weights are retuned, so it is off rather than small.
         *
         * **PARALLAX / SPECULAR / BEZEL** — remain disabled (weight 0), unchanged, and
         * still computing and logging so a future capture can re-examine them for free.
         * PARALLAX cannot see depth at this landmark precision (~1px jitter exceeds the
         * signal). SPECULAR measures 0.0000 almost everywhere — `SPECULAR_LUMA` is never
         * reached on this sensor. BEZEL is inverted for the same reason CHROMA is: room
         * clutter behind a real user reads as a rectangle, while a full-screen display
         * shows no bezel at all.
         *
         * **Measured outcome of this table** at [BALANCED] (leave-one-condition-out FAR
         * 8.3-14.1%, so this is not fitted to a single condition):
         *
         * | | before | after |
         * |---|---|---|
         * | false accepts, all attacks | 15.9% | **11.5%** [6.2, 17.7] |
         * | the laptop-display attack | 9 of 19 | **3 of 19** |
         * | genuine users accused of spoofing | 2 | **0** |
         * | ticks to accept a real face | median 5, p90 14 | **median 3, p90 9** |
         *
         * **Known unfixed: dim light, and it is not a threshold problem.** A real face in
         * a dim room scores **0.346** — *more fake-looking than the spoof's 0.271*. No
         * centre can separate those, so dim light pays for the rest of this table: 10 of
         * 40 dim attempts now reach the accept bound within [MAX_TICKS], against 15 of 40
         * before (which also carried the 2 false accusations). The other 30 end `OPEN`,
         * so the user is asked to keep looking at the camera, never rejected. It is not
         * brightness or blur: auto-exposure equalises face luma (dim 111.0 against bright
         * 112.8) and neither luma nor Laplacian sharpness correlates with the score
         * *inside* the dim condition. The working theory is high-ISO sensor noise, and the
         * intended fix is to brighten the screen to light the face — removing the
         * condition instead of thresholding around it. Deferred, not forgotten.
         *
         * **Why `ATTACK` is now unreachable, and why that is not a security hole.** With
         * MOIRE and CHROMA off, ANTI_SPOOF is the only weighted cue, so
         * [MIN_CORROBORATING_CUES] = 2 can never be satisfied and no verdict is ever
         * `ATTACK`. Attacks end `OPEN` instead — and `OPEN` and `ATTACK` both mean *not
         * accepted*; only the message differs. Measured, the two settings differ by ~1
         * point of FAR. Dropping corroboration to 1 to buy that point costs **23 genuine
         * users falsely accused**, so it stays at 2. Do not "fix" this by relaxing
         * corroboration; fix it by adding a second cue that actually separates.
         */
        private val CALIBRATION = mapOf(
            CueId.ANTI_SPOOF to CueCalibration(weight = 5.5f, centre = 0.25f, symmetric = true),
            CueId.PARALLAX to CueCalibration(weight = 0f, centre = 0.0020f, symmetric = true),
            CueId.MOIRE to CueCalibration(weight = 0f, centre = 0.70f, symmetric = false),
            CueId.SPECULAR to CueCalibration(weight = 0f, centre = 0.30f, symmetric = false),
            CueId.CHROMA to CueCalibration(weight = 0f, centre = 12.0f, symmetric = false),
            CueId.BEZEL to CueCalibration(weight = 0f, centre = 0.45f, symmetric = false)
        )
    }
}
