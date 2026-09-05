package com.facedetectorcamera.pipeline

import android.graphics.Rect
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceLandmark
import kotlin.math.hypot

enum class CueId(
    /** Which verdict a larger score supports. Fusion weights carry the sign. */
    val higherMeans: String
) {
    /** MiniFASNet ensemble attack probability, max(print, replay). */
    ANTI_SPOOF("attack"),

    /** Landmark non-planarity per degree of out-of-plane rotation. */
    PARALLAX("live"),

    /** Height of a periodic bump above the 1/f falloff in the mid-face spectrum. */
    MOIRE("attack"),

    /** Compactness x coverage of near-clipped highlights over the face. */
    SPECULAR("attack"),

    /** Chroma spread across skin pixels. */
    CHROMA("live"),

    /** Fraction of ring gradient energy in two near-perpendicular directions. */
    BEZEL("attack")
}

data class CueScore(
    val id: CueId,
    val abstained: Boolean,
    val score: Float,
    /** Human-readable diagnostics; goes into the calibration log, not decisions. */
    val detail: String = ""
) {
    companion object {
        fun abstain(id: CueId, why: String): CueScore = CueScore(id, true, 0f, why)
    }
}

/**
 * Pre-scoring frame quality. Gating on this ensures dim, blurry or distant
 * frames are not falsely scored as attacks.
 */
data class FrameQuality(
    /** True interpupillary distance in pixels, or NaN if ML Kit reported no eyes. */
    val eyeDistance: Float,
    /** Face box width. Always present, so the gate has a size measure regardless. */
    val faceWidth: Int,
    val faceLuma: Float,
    /** Laplacian variance over the mid-face patch, normalised by local contrast. */
    val sharpness: Float,
    val yaw: Float,
    val pitch: Float,
    val roll: Float
)

/** Landmarks in oriented image pixels, NaN where ML Kit did not report one. */
class FaceGeometry(
    val points: FloatArray,
    val eyeDistance: Float,
    val yaw: Float,
    val pitch: Float,
    val roll: Float
) {
    companion object {
        private val TYPES = intArrayOf(
            FaceLandmark.LEFT_EYE, FaceLandmark.RIGHT_EYE, FaceLandmark.NOSE_BASE,
            FaceLandmark.LEFT_CHEEK, FaceLandmark.RIGHT_CHEEK,
            FaceLandmark.MOUTH_LEFT, FaceLandmark.MOUTH_RIGHT, FaceLandmark.MOUTH_BOTTOM,
            FaceLandmark.LEFT_EAR, FaceLandmark.RIGHT_EAR
        )
        const val COUNT = 10

        fun from(face: Face): FaceGeometry {
            val points = FloatArray(COUNT * 2) { Float.NaN }
            for ((index, type) in TYPES.withIndex()) {
                val position = face.getLandmark(type)?.position ?: continue
                points[index * 2] = position.x
                points[index * 2 + 1] = position.y
            }
            val eyeDistance = if (points[0].isNaN() || points[2].isNaN()) {
                Float.NaN
            } else {
                hypot((points[2] - points[0]).toDouble(), (points[3] - points[1]).toDouble()).toFloat()
            }
            return FaceGeometry(
                points = points,
                eyeDistance = eyeDistance,
                yaw = face.headEulerAngleY,
                pitch = face.headEulerAngleX,
                roll = face.headEulerAngleZ
            )
        }
    }
}

data class CueContext(
    val frame: YuvFrame,
    val faceBounds: Rect,
    val geometry: FaceGeometry,
    val timestampMs: Long
)

data class ImageCueResult(val quality: FrameQuality, val scores: List<CueScore>)
