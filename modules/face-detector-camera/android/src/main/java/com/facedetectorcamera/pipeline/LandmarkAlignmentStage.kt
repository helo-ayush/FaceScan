package com.facedetectorcamera.pipeline

import android.graphics.Matrix
import com.google.mlkit.vision.face.FaceLandmark
import kotlin.math.atan2
import kotlin.math.hypot

class LandmarkAlignmentStage : FacePipelineStage<FacePipelineFrame, FaceAlignment> {
    override fun process(input: FacePipelineFrame): FaceAlignment {
        val leftEye = input.face.getLandmark(FaceLandmark.LEFT_EYE)?.position
        val rightEye = input.face.getLandmark(FaceLandmark.RIGHT_EYE)?.position

        if (leftEye == null || rightEye == null) return FaceAlignment(isReady = false)

        val (imageLeftEye, imageRightEye) = if (leftEye.x <= rightEye.x) {
            leftEye to rightEye
        } else {
            rightEye to leftEye
        }
        val dx = imageRightEye.x - imageLeftEye.x
        val dy = imageRightEye.y - imageLeftEye.y
        val eyeDistance = hypot(dx.toDouble(), dy.toDouble()).toFloat()
        if (eyeDistance < MIN_EYE_DISTANCE_PX) {
            return FaceAlignment(isReady = false, eyeDistance = eyeDistance)
        }
        if (kotlin.math.abs(dx) < 1f && kotlin.math.abs(dy) < 1f) {
            return FaceAlignment(isReady = false, eyeDistance = eyeDistance)
        }

        val eyeAngle = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
        val transform = Matrix()
        transform.setPolyToPoly(
            floatArrayOf(imageLeftEye.x, imageLeftEye.y, imageRightEye.x, imageRightEye.y),
            0,
            floatArrayOf(TARGET_LEFT_EYE_X, TARGET_EYE_Y, TARGET_RIGHT_EYE_X, TARGET_EYE_Y),
            0,
            2
        )

        return FaceAlignment(
            isReady = true,
            rotationDegrees = -eyeAngle,
            scale = TARGET_EYE_DISTANCE / eyeDistance,
            eyeDistance = eyeDistance,
            sourceToCanonical = transform
        )
    }

    private companion object {
        const val MIN_EYE_DISTANCE_PX = 12f
        const val TARGET_LEFT_EYE_X = 38.2946f
        const val TARGET_RIGHT_EYE_X = 73.5318f
        const val TARGET_EYE_DISTANCE = TARGET_RIGHT_EYE_X - TARGET_LEFT_EYE_X
        const val TARGET_EYE_Y = 51.6f
    }
}
