package com.facedetectorcamera.pipeline

import android.os.Bundle
import android.util.Log
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.face.Face
import kotlin.math.hypot

/**
 * Master face processing pipeline coordinator.
 * Orchestrates facial landmark alignment, affine crop normalization, dual-scale
 * MiniFASNet anti-spoof inference, ArcFace embedding extraction, and multi-cue liveness fusion.
 */
class FacePipeline(context: android.content.Context) {
    private val alignmentStage = LandmarkAlignmentStage()
    private val cropStage = NativeFaceCropStage()
    private val yuvFrame = YuvFrame()
    private val antiSpoofStageV2 = AntiSpoofStage(context, "minifasnetv2_80.tflite")
    private val antiSpoofStageV1SE = AntiSpoofStage(context, "minifasnetv1se_80.tflite")
    private val embeddingStage = FaceEmbeddingStage(context)
    private val parallaxCue = ParallaxCue()
    private val imageCues = ImageCues()
    private val fusion = LivenessFusion()
    private val frameDump = FrameDump(context)
    private var lastLivenessMillis = 0L
    private var lastEmbeddingMillis = 0L
    private var lastEmbedding: FloatArray? = null
    private var lastEmbeddingDurationMs = 0L
    private var lastLivenessDurationMs = 0L
    private var lastTrackingId: Int? = null
    private var lastFaceCenter: android.graphics.PointF? = null

    private val livenessResults = ArrayDeque<AntiSpoofResult>(MAX_LIVENESS_SAMPLES)
    private var currentStatus = LivenessStatus.NO_FACE
    private var lastNormalizationBundle: Bundle? = null
    private var inconclusiveCooldown = 0

    fun process(face: Face, imageWidth: Int, imageHeight: Int): FaceAlignment =
        alignmentStage.process(FacePipelineFrame(face, imageWidth, imageHeight))

    /**
     * Runs both crop scales against their respective models and averages the
     * softmax outputs — mirrors `prediction += model.predict(...)` /
     * `value = prediction[label] / 2` in MiniVision's reference test.py.
     * Falls back to a single model's result if one crop is invalid (e.g. face
     * near the frame edge at the wider 4.0x scale).
     */
    private fun ensembleAntiSpoof(
        input: FaceCropInput,
        luma: Float? = null,
        isTrulyDim: Boolean = false,
        hasSpecularGlare: Boolean = false
    ): AntiSpoofResult? {
        val crop27 = cropStage.processAntiSpoof(input, scale = 2.7f, luma = luma, isTrulyDim = isTrulyDim, hasSpecularGlare = hasSpecularGlare)
        val crop40 = cropStage.processAntiSpoof(input, scale = 4.0f, luma = luma, isTrulyDim = isTrulyDim, hasSpecularGlare = hasSpecularGlare)
        val r27 = crop27?.let { antiSpoofStageV2.process(it) }
        val r40 = crop40?.let { antiSpoofStageV1SE.process(it) }

        return when {
            r27 != null && r40 != null -> {
                val avgProbs = FloatArray(3) { i -> (r27.probs[i] + r40.probs[i]) / 2f }
                val selected = avgProbs.indices.maxByOrNull { avgProbs[it] } ?: 1
                val v2Attack = maxOf(r27.probPrint, r27.probReplay)
                val v1seAttack = maxOf(r40.probPrint, r40.probReplay)
                // When an attack is detected by either model (especially MiniFASNet V2 @ 2.7x, which matches
                // the clamped crop domain), do not let out-of-domain V1SE pull the attack probability down.
                val attackProb = if (v2Attack >= 0.25f || v1seAttack >= 0.25f) {
                    maxOf(v2Attack, v1seAttack)
                } else {
                    (v2Attack + v1seAttack) / 2f
                }
                val margin = avgProbs[1] - attackProb
                Log.d(
                    "FaceAntiSpoof",
                    "ENSEMBLE_SAMPLE | live=${String.format("%.4f", avgProbs[1])} print=${String.format("%.4f", avgProbs[0])} replay=${String.format("%.4f", avgProbs[2])} attack=${String.format("%.4f", attackProb)} margin=${String.format("%.4f", margin)} argmax=$selected " +
                        "v2Attack=${String.format("%.4f", v2Attack)} " +
                        "v1seAttack=${String.format("%.4f", v1seAttack)} " +
                        "sameCrop=${crop27.contentEquals(crop40)}"
                )
                AntiSpoofResult(
                    logits = r27.logits,
                    probs = avgProbs,
                    probPrint = avgProbs[0],
                    probLive = avgProbs[1],
                    probReplay = avgProbs[2],
                    selectedClass = selected
                )
            }
            r27 != null -> r27
            r40 != null -> r40
            else -> null
        }
    }

    /**
     * Takes the whole [Face] rather than just `trackingId` + `boundingBox` because
     * the passive cues need its landmarks and Euler angles. Everything else about
     * the call contract is unchanged.
     */
    fun cropIfNeeded(
        imageProxy: ImageProxy,
        imageRotationDegrees: Int,
        alignment: FaceAlignment,
        face: Face,
        scanningIntervalMs: Long = 500L,
        livenessStrictness: String? = null,
        frameLuminance: Double? = null,
        faceLuminance: Double? = null,
        backgroundLuminance: Double? = null,
        brightPixelRatio: Double? = null
    ): NormalizedFaceCrop? {
        val trackingId = face.trackingId
        val faceBounds = face.boundingBox
        val geometry = FaceGeometry.from(face)
        val now = System.currentTimeMillis()
        val currentCenter = android.graphics.PointF(faceBounds.exactCenterX(), faceBounds.exactCenterY())

        // Applied per call rather than on a settings-change callback because the setting
        // arrives with the frame and only the two bounds move.
        fusion.strictness = LivenessFusion.Strictness.from(livenessStrictness)

        // Explicit reset triggers: tracking ID change, spatial distance jump > 100px,
        // or 800ms with no update.
        val idChanged = trackingId != null && trackingId != lastTrackingId
        val distanceJumped = lastFaceCenter?.let {
            hypot((currentCenter.x - it.x).toDouble(), (currentCenter.y - it.y).toDouble()) > 100
        } ?: false
        val timedOut = currentStatus != LivenessStatus.LIVE_CONFIRMED && now - lastLivenessMillis > 800L

        if (idChanged || distanceJumped || timedOut) {
            livenessResults.clear()
            parallaxCue.reset()
            fusion.reset()
            lastEmbedding = null
            lastTrackingId = trackingId
            currentStatus = LivenessStatus.ACQUIRING
        }
        lastFaceCenter = currentCenter

        if (currentStatus == LivenessStatus.LIVE_CONFIRMED) {
            lastLivenessMillis = now
        }

        val isBacklit = faceLuminance != null && backgroundLuminance != null &&
            faceLuminance < backgroundLuminance - 28.0 && faceLuminance < 135.0
        val hasSpecularGlare = brightPixelRatio != null && brightPixelRatio > 0.005
        val isTrulyDim = frameLuminance != null && frameLuminance < 65.0 && !isBacklit && !hasSpecularGlare

        var scoreUpdated = false
        var latestResult: AntiSpoofResult? = null

        val shouldSample = currentStatus != LivenessStatus.LIVE_CONFIRMED &&
            currentStatus != LivenessStatus.SPOOF_CONFIRMED &&
            now - lastLivenessMillis >= LIVENESS_INTERVAL_MS
        val shouldEmbed = now - lastEmbeddingMillis >= scanningIntervalMs

        // Parallax runs on every frame while a verdict is still open.
        val evaluating = currentStatus != LivenessStatus.LIVE_CONFIRMED &&
            currentStatus != LivenessStatus.SPOOF_CONFIRMED
        val parallax = if (evaluating) parallaxCue.observe(geometry, now) else null

        // One plane copy for the whole tick; every crop samples out of it.
        val frame = if (shouldSample || shouldEmbed) {
            yuvFrame.bind(imageProxy, imageRotationDegrees).takeIf { it.isValid }
        } else {
            null
        }

        var cues: List<CueScore>? = null
        var quality: FrameQuality? = null
        var verdict: LivenessFusion.Verdict? = null
        var guidance: String? = null

        if (shouldSample) {
            val sampleGapMs = now - lastLivenessMillis
            lastLivenessMillis = now
            val started = android.os.SystemClock.elapsedRealtimeNanos()

            val context = frame?.let { CueContext(it, faceBounds, geometry, now) }
            quality = context?.let { imageCues.sampleQuality(it) }
            val gateFailure = quality?.let { fusion.gate(it) } ?: ""

            if (context == null) {
                currentStatus = LivenessStatus.INVALID_CROP
            } else if (gateFailure.isNotEmpty()) {
                guidance = gateFailure
                currentStatus = LivenessStatus.LOW_QUALITY
                Log.d(
                    "FaceAntiSpoof",
                    "GATED | reason=$gateFailure | QUALITY ${qualityFields(quality!!)}"
                )
            } else {
                val result = ensembleAntiSpoof(
                    FaceCropInput(context.frame, alignment, faceBounds),
                    quality?.faceLuma,
                    isTrulyDim = isTrulyDim,
                    hasSpecularGlare = hasSpecularGlare
                )
                cues = buildList {
                    result?.let {
                        val v2Attack = maxOf(it.probPrint, it.probReplay)
                        val attackProb = if (it.selectedClass == 1 && it.probLive >= 0.60f && it.probReplay < 0.10f && isBacklit) {
                            it.probReplay.coerceAtLeast(v2Attack * 0.82f)
                        } else {
                            v2Attack
                        }
                        val reason = "live=${String.format("%.4f", it.probLive)} replay=${String.format("%.4f", it.probReplay)} class=${it.selectedClass}"
                        add(
                            CueScore(
                                CueId.ANTI_SPOOF, false,
                                attackProb,
                                reason
                            )
                        )
                    } ?: add(CueScore.abstain(CueId.ANTI_SPOOF, "invalid crop"))
                    parallax?.let { add(it) }
                    addAll(imageCues.evaluateCues(context, quality!!))
                }
                verdict = fusion.observe(cues, quality, isBacklit = isBacklit, isTrulyDim = isTrulyDim, hasGlare = hasSpecularGlare)
                logCues(quality!!, cues, verdict)
                frameDump.capture(
                    context.frame, faceBounds,
                    cues.filter { !it.abstained }
                        .joinToString(" ") { "${it.id.name}=${String.format("%.4f", it.score)}" } +
                        " | " + qualityFields(quality)
                )

                if (result != null) {
                    latestResult = result
                    if (livenessResults.size == MAX_LIVENESS_SAMPLES) livenessResults.removeFirst()
                    livenessResults.addLast(result)
                }
                scoreUpdated = true
            }

            lastLivenessDurationMs = (android.os.SystemClock.elapsedRealtimeNanos() - started) / 1_000_000L
            Log.d(
                "FaceAntiSpoof",
                "CADENCE | gap=${sampleGapMs}ms target=${LIVENESS_INTERVAL_MS}ms " +
                    "inferMs=$lastLivenessDurationMs frame=${frame?.orientedWidth}x${frame?.orientedHeight}" +
                    if (guidance != null) " gated=$guidance" else ""
            )
        }

        val samplesCount = livenessResults.size
        val avgLive = if (samplesCount == 0) 0f else livenessResults.map { it.probLive }.average().toFloat()
        val avgPrint = if (samplesCount == 0) 0f else livenessResults.map { it.probPrint }.average().toFloat()
        val avgReplay = if (samplesCount == 0) 0f else livenessResults.map { it.probReplay }.average().toFloat()

        val isLive: Boolean?
        when {
            currentStatus == LivenessStatus.LIVE_CONFIRMED -> {
                inconclusiveCooldown = 0
                isLive = true
            }
            currentStatus == LivenessStatus.SPOOF_CONFIRMED -> {
                inconclusiveCooldown = 0
                isLive = false
            }
            verdict == null -> {
                isLive = null
            }
            verdict.decision == LivenessFusion.Decision.ATTACK -> {
                currentStatus = LivenessStatus.SPOOF_CONFIRMED
                inconclusiveCooldown = 0
                isLive = false
            }
            verdict.decision == LivenessFusion.Decision.LIVE -> {
                currentStatus = LivenessStatus.LIVE_CONFIRMED
                inconclusiveCooldown = 0
                isLive = true
            }
            fusion.isStalled() -> {
                fusion.reset()
                livenessResults.clear()
                inconclusiveCooldown = 12
                currentStatus = LivenessStatus.INCONCLUSIVE
                isLive = null
            }
            inconclusiveCooldown > 0 -> {
                inconclusiveCooldown--
                currentStatus = LivenessStatus.INCONCLUSIVE
                isLive = null
            }
            else -> {
                currentStatus = LivenessStatus.ACQUIRING
                isLive = null
            }
        }

        if (scoreUpdated && verdict != null) {
            val bounds = fusion.strictness
            Log.d(
                "FaceAntiSpoof",
                "FUSION | status=$currentStatus total=${String.format("%.3f", verdict.total)} " +
                    "frame=${String.format("%+.3f", verdict.frameLlr)} ticks=${verdict.ticks} " +
                    "corroborating=${verdict.corroborating} isLive=$isLive " +
                    "strictness=${bounds.name} accept=${bounds.accept} reject=${bounds.reject}"
            )
        }

        var cropResult: NormalizedFaceCrop? = null
        if (shouldEmbed && frame != null) {
            lastEmbeddingMillis = now
            val identityCrop = cropStage.process(FaceCropInput(frame, alignment, faceBounds))
            if (identityCrop.isReady) {
                val started = android.os.SystemClock.elapsedRealtimeNanos()
                lastEmbedding = embeddingStage.process(identityCrop)
                lastEmbeddingDurationMs = (android.os.SystemClock.elapsedRealtimeNanos() - started) / 1_000_000L
                cropResult = identityCrop
            }
        }

        if (!scoreUpdated && cropResult == null) return null
        val result = (cropResult ?: NormalizedFaceCrop(isReady = alignment.isReady)).copy(
            embedding = lastEmbedding,
            processDurationMs = lastEmbeddingDurationMs,
            livenessScore = latestResult?.probLive ?: (if (livenessResults.isEmpty()) null else avgLive),
            livenessPrintProb = latestResult?.probPrint ?: (if (livenessResults.isEmpty()) null else avgPrint),
            livenessReplayProb = latestResult?.probReplay ?: (if (livenessResults.isEmpty()) null else avgReplay),
            livenessRawLogits = latestResult?.logits,
            livenessSelectedClass = latestResult?.selectedClass,
            livenessDurationMs = lastLivenessDurationMs,
            livenessSamples = samplesCount,
            livenessStatus = currentStatus,
            isLive = isLive,
            livenessCues = cues,
            frameQuality = quality,
            fusion = verdict,
            guidance = guidance
        )
        lastNormalizationBundle = result.toBundle(null)
        return result
    }

    private fun logCues(
        quality: FrameQuality,
        cues: List<CueScore>,
        verdict: LivenessFusion.Verdict
    ) {
        Log.d(
            "FaceAntiSpoof",
            "CUES | " + cues.joinToString(" ") { cue ->
                val score = if (cue.abstained) "-" else String.format("%.4f", cue.score)
                val llr = verdict.perCue[cue.id]?.let { String.format("%+.2f", it) } ?: "-"
                "${cue.id.name}=$score/$llr"
            } + " | QUALITY " + qualityFields(quality)
        )
        for (cue in cues) {
            if (cue.detail.isNotEmpty()) {
                Log.v("FaceAntiSpoof", "CUE_DETAIL | ${cue.id.name}: ${cue.detail}")
            }
        }
    }

    private fun qualityFields(quality: FrameQuality): String {
        val eye = if (quality.eyeDistance.isNaN()) "-" else String.format("%.1f", quality.eyeDistance)
        return "eye=$eye faceW=${quality.faceWidth}" +
            " luma=${String.format("%.1f", quality.faceLuma)}" +
            " sharp=${String.format("%.3f", quality.sharpness)}" +
            " yaw=${String.format("%.1f", quality.yaw)}" +
            " pitch=${String.format("%.1f", quality.pitch)}" +
            " roll=${String.format("%.1f", quality.roll)}"
    }

    fun cachedNormalizationBundle(): Bundle = lastNormalizationBundle ?: Bundle().apply {
        putBoolean("isReady", false)
        putInt("width", 112)
        putInt("height", 112)
        putDouble("coverage", 0.0)
        putLong("processDurationMs", lastEmbeddingDurationMs)
        putLong("livenessDurationMs", lastLivenessDurationMs)
        putInt("livenessSamples", livenessResults.size)
        putString("livenessStatus", currentStatus.name)
    }

    private companion object {
        const val LIVENESS_INTERVAL_MS = 100L
        const val MAX_LIVENESS_SAMPLES = 5
    }
}
