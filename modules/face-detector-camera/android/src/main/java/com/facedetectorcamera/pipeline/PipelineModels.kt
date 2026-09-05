package com.facedetectorcamera.pipeline

import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Bundle
import android.util.Base64
import com.google.mlkit.vision.face.Face
import java.io.ByteArrayOutputStream

enum class LivenessStatus {
    NO_FACE,
    ACQUIRING,
    LIVE_CONFIRMED,
    SPOOF_CONFIRMED,
    INVALID_CROP,
    MODEL_ERROR,

    /**
     * The frame could not be judged — too far, too dim, blurred or turned away — so
     * nothing was scored. Distinct from `ACQUIRING` because it carries actionable
     * guidance, and distinct from `SPOOF_CONFIRMED` because refusing to answer is not
     * the same as answering "attack".
     */
    LOW_QUALITY,

    /**
     * Enough frames were scored and the evidence never reached either bound. Honest
     * "I don't know" rather than a coin flip; the UI asks for a small reposition.
     */
    INCONCLUSIVE
}

data class FacePipelineFrame(
    val face: Face,
    val imageWidth: Int,
    val imageHeight: Int
)

data class FaceAlignment(
    val isReady: Boolean,
    val rotationDegrees: Float = 0f,
    val scale: Float = 1f,
    val eyeDistance: Float = 0f,
    val sourceToCanonical: Matrix = Matrix()
) {
    fun toBundle(): Bundle {
        val matrixValues = FloatArray(9)
        sourceToCanonical.getValues(matrixValues)
        return Bundle().apply {
            putBoolean("isReady", isReady)
            putDouble("rotationDegrees", rotationDegrees.toDouble())
            putDouble("scale", scale.toDouble())
            putDouble("eyeDistance", eyeDistance.toDouble())
            putDoubleArray("sourceToCanonical", matrixValues.map { it.toDouble() }.toDoubleArray())
        }
    }
}

data class AntiSpoofResult(
    val logits: FloatArray,
    val probs: FloatArray,
    val probPrint: Float,
    val probLive: Float,
    val probReplay: Float,
    val selectedClass: Int
)

data class NormalizedFaceCrop(
    val isReady: Boolean,
    val width: Int = TARGET_SIZE,
    val height: Int = TARGET_SIZE,
    val coverage: Float = 0f,
    val pixels: IntArray? = null,
    val embedding: FloatArray? = null,
    val processDurationMs: Long = 0L,
    val livenessScore: Float? = null,
    val livenessPrintProb: Float? = null,
    val livenessReplayProb: Float? = null,
    val livenessRawLogits: FloatArray? = null,
    val livenessSelectedClass: Int? = null,
    val livenessDurationMs: Long = 0L,
    val livenessSamples: Int = 0,
    val livenessStatus: LivenessStatus = LivenessStatus.NO_FACE,
    val isLive: Boolean? = null,
    /** Per-cue scores for this tick. Null on frames that did not sample. */
    val livenessCues: List<CueScore>? = null,
    val frameQuality: FrameQuality? = null,
    val fusion: LivenessFusion.Verdict? = null,
    /** UI guidance key when the frame was refused by the quality gate. */
    val guidance: String? = null
) {
    fun toBundle(previewBase64: String? = null): Bundle = Bundle().apply {
        putBoolean("isReady", isReady)
        putInt("width", width)
        putInt("height", height)
        putDouble("coverage", coverage.toDouble())
        previewBase64?.let { putString("previewBase64", it) }
        embedding?.let { putDoubleArray("embedding", it.map { e -> e.toDouble() }.toDoubleArray()) }
        putLong("processDurationMs", processDurationMs)
        livenessScore?.let { putDouble("livenessScore", it.toDouble()) }
        livenessPrintProb?.let { putDouble("livenessPrintProb", it.toDouble()) }
        livenessReplayProb?.let { putDouble("livenessReplayProb", it.toDouble()) }
        livenessRawLogits?.let { putDoubleArray("livenessRawLogits", it.map { l -> l.toDouble() }.toDoubleArray()) }
        livenessSelectedClass?.let { putInt("livenessSelectedClass", it) }
        putLong("livenessDurationMs", livenessDurationMs)
        putInt("livenessSamples", livenessSamples)
        putString("livenessStatus", livenessStatus.name)
        isLive?.let { putBoolean("isLive", it) }
        livenessCues?.let { cues ->
            putBundle("livenessCues", Bundle().apply {
                for (cue in cues) {
                    putBoolean("${cue.id.name}_abstained", cue.abstained)
                    if (!cue.abstained) putDouble(cue.id.name, cue.score.toDouble())
                    if (cue.detail.isNotEmpty()) putString("${cue.id.name}_detail", cue.detail)
                }
            })
        }
        frameQuality?.let { quality ->
            putBundle("frameQuality", Bundle().apply {
                if (!quality.eyeDistance.isNaN()) {
                    putDouble("eyeDistance", quality.eyeDistance.toDouble())
                }
                putInt("faceWidth", quality.faceWidth)
                putDouble("faceLuma", quality.faceLuma.toDouble())
                putDouble("sharpness", quality.sharpness.toDouble())
                putDouble("yaw", quality.yaw.toDouble())
                putDouble("pitch", quality.pitch.toDouble())
                putDouble("roll", quality.roll.toDouble())
            })
        }
        fusion?.let { putBundle("fusion", it.toBundle()) }
        guidance?.let { putString("guidance", it) }
    }

    /** Turns the normalized pixels into a JPEG preview base64. */
    fun toJpegBase64(): String? {
        val cropPixels = pixels ?: return null
        val bitmap = Bitmap.createBitmap(cropPixels, width, height, Bitmap.Config.ARGB_8888)
        return ByteArrayOutputStream().use { stream ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, stream)
            Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        }
    }

    private companion object {
        const val TARGET_SIZE = 112
    }
}

interface FacePipelineStage<Input, Output> {
    fun process(input: Input): Output
}

data class FaceCropInput(
    val frame: YuvFrame,
    val alignment: FaceAlignment,
    val faceBounds: android.graphics.Rect? = null
)
