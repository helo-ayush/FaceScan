package com.facedetectorcamera.facedetector

import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.facedetectorcamera.facedetector.FaceDetectorUtils.rotateFaceX
import com.facedetectorcamera.facedetector.FaceDetectorUtils.serializeFace
import com.facedetectorcamera.pipeline.FacePipeline
import com.google.mlkit.vision.common.InputImage
import kotlin.math.ceil
import kotlin.math.sqrt

private data class LuminanceMetrics(
    val frame: Double,
    val face: Double,
    val background: Double,
    val brightPixelRatio: Double
)

class FaceDetector(
    private val settings: FaceDetectorSettings,
    private val mirrorFaces: Boolean,
    private val context: android.content.Context,
    private val executor: java.util.concurrent.ExecutorService,
    private val faceOverlayView: com.facedetectorcamera.FaceOverlayView? = null,
    val onComplete: (ArrayList<Bundle>, Double, Double) -> Unit
) : ImageAnalysis.Analyzer {
    private var faceDetector = settings.getFaceDetector()
    private val facePipeline = FacePipeline(context)
    private var lastDetectionMillis: Long = 0
    private var lastDebugPreviewMillis: Long = 0
    private var lastLuminanceMillis: Long = 0
    private var cachedLuminance: LuminanceMetrics? = null
    private var yBufferReuse: ByteArray? = null

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(imageProxy: ImageProxy) {
        if (settings.faceDetectorTaskLock) {
            try { imageProxy.close() } catch (e: Exception) {}
            return
        }

        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            try { imageProxy.close() } catch (e: Exception) {}
            return
        }

        if (settings.minDetectionInterval > 0 && !minIntervalPassed()) {
            try { imageProxy.close() } catch (e: Exception) {}
            return
        }

        val rotation = imageProxy.imageInfo.rotationDegrees
        val image = InputImage.fromMediaImage(mediaImage, rotation)
        // Keep ML Kit results in image pixels. The React Native layer maps them once to the current preview.
        val scaleX = 1.0
        val scaleY = 1.0

        settings.lockFaceDetectorTask()
        lastDetectionMillis = System.currentTimeMillis()
        try {
            val detector = settings.getFaceDetector()
            detector.process(image)
                .addOnSuccessListener(executor) { faces ->
                    try {
                        val facesArray = ArrayList<Bundle>()
                        val primaryFace = faces.maxByOrNull {
                            it.boundingBox.width() * it.boundingBox.height()
                        }
                        val orientedWidth = if (rotation == 90 || rotation == 270) image.height else image.width
                        val orientedHeight = if (rotation == 90 || rotation == 270) image.width else image.height

                        faceOverlayView?.let { overlay ->
                            val primaryBounds = primaryFace?.boundingBox?.let { android.graphics.RectF(it) }
                            overlay.post {
                                overlay.isOverlayEnabled = settings.showNativeOverlay
                                overlay.isSmooth = settings.smoothNativeOverlay
                                overlay.updateFace(primaryBounds, orientedWidth, orientedHeight, mirrorFaces)
                            }
                        }

                        val luminance = calculateLuminance(
                            imageProxy,
                            primaryFace?.boundingBox,
                            rotation
                        )

                        faces.forEach { face ->
                            val alignment = facePipeline.process(face, orientedWidth, orientedHeight)
                            var result = serializeFace(face, scaleX, scaleY)
                            result.putBundle("alignment", alignment.toBundle())
                            if (face === primaryFace) {
                                val normalizedCrop = facePipeline.cropIfNeeded(
                                    imageProxy,
                                    rotation,
                                    alignment,
                                    face,
                                    settings.scanningIntervalMs,
                                    settings.livenessStrictness,
                                    luminance.frame,
                                    luminance.face,
                                    luminance.background,
                                    luminance.brightPixelRatio
                                )
                                val now = System.currentTimeMillis()
                                val previewBase64 = if (
                                    normalizedCrop != null &&
                                    settings.emitNormalizedCropPreview &&
                                    normalizedCrop.isReady &&
                                    now - lastDebugPreviewMillis >= DEBUG_PREVIEW_INTERVAL_MS
                                ) {
                                    lastDebugPreviewMillis = now
                                    normalizedCrop.toJpegBase64()
                                } else {
                                    null
                                }
                                if (normalizedCrop != null) {
                                    result.putBundle("normalization", normalizedCrop.toBundle(previewBase64))
                                } else {
                                    result.putBundle("normalization", facePipeline.cachedNormalizationBundle())
                                }
                            }
                            if (mirrorFaces) {
                                result = rotateFaceX(
                                    result,
                                    if (rotation == 270 || rotation == 90) image.height else image.width,
                                    scaleX
                                )
                            }
                            result.putInt("imageWidth", orientedWidth)
                            result.putInt("imageHeight", orientedHeight)
                            if (face === primaryFace) {
                                result.putDouble("frameBrightness", luminance.frame)
                                result.putDouble("faceBrightness", luminance.face)
                                result.putDouble("backgroundBrightness", luminance.background)
                            }
                            facesArray.add(result)
                        }

                        onComplete(facesArray, luminance.frame, luminance.brightPixelRatio)
                    } catch (e: Exception) {
                        Log.e("FaceDetector", "Error handling face detection results: ${e.message}", e)
                    }
                }
                .addOnFailureListener(executor) { error ->
                    Log.d("FaceDetector", error.cause?.message ?: error.message ?: "Face detection failed")
                }
                .addOnCompleteListener(executor) { finishFaceDetection(imageProxy) }
        } catch (e: Exception) {
            Log.e("FaceDetector", "Failed to start ML Kit process: ${e.message}", e)
            finishFaceDetection(imageProxy)
        }
    }

    private fun calculateLuminance(
        imageProxy: ImageProxy,
        faceBounds: Rect?,
        rotation: Int
    ): LuminanceMetrics {
        val now = System.currentTimeMillis()
        cachedLuminance?.let { cached ->
            if (now - lastLuminanceMillis < 300L) {
                return cached
            }
        }

        val rawWidth = imageProxy.width
        val rawHeight = imageProxy.height
        val faceRect = faceBounds?.let {
            uprightRectToRaw(it, rotation, rawWidth, rawHeight)
        }
        val plane = imageProxy.planes[0]
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        
        val buffer = plane.buffer.duplicate().apply { position(0) }
        val rem = buffer.remaining()
        val yBytes = yBufferReuse?.takeIf { it.size == rem } ?: ByteArray(rem).also { yBufferReuse = it }
        buffer.get(yBytes)

        val sampleStep = maxOf(1, ceil(sqrt(rawWidth.toDouble() * rawHeight / 8000.0)).toInt())
        var frameSum = 0L
        var frameCount = 0L
        var faceSum = 0L
        var faceCount = 0L
        var brightCount = 0L

        for (y in 0 until rawHeight step sampleStep) {
            for (x in 0 until rawWidth step sampleStep) {
                val index = y * rowStride + x * pixelStride
                val luminance = yBytes[index].toInt() and 0xFF
                frameSum += luminance.toLong()
                frameCount++
                if (luminance >= 245) brightCount++
                if (faceRect != null && x >= faceRect.left && x < faceRect.right && y >= faceRect.top && y < faceRect.bottom) {
                    faceSum += luminance.toLong()
                    faceCount++
                }
            }
        }

        val frameAverage = frameSum.toDouble() / frameCount.coerceAtLeast(1)
        val faceAverage = if (faceCount > 0) faceSum.toDouble() / faceCount else frameAverage
        val backgroundCount = frameCount - faceCount
        val backgroundAverage = if (backgroundCount > 0) {
            (frameSum - faceSum).toDouble() / backgroundCount
        } else {
            frameAverage
        }

        val brightPixelRatio = brightCount.toDouble() / frameCount.coerceAtLeast(1)
        val result = LuminanceMetrics(frameAverage, faceAverage, backgroundAverage, brightPixelRatio)
        lastLuminanceMillis = now
        cachedLuminance = result
        return result
    }

    private fun uprightRectToRaw(
        bounds: Rect,
        rotation: Int,
        rawWidth: Int,
        rawHeight: Int
    ): Rect {
        val corners = listOf(
            bounds.left to bounds.top,
            bounds.right to bounds.top,
            bounds.left to bounds.bottom,
            bounds.right to bounds.bottom
        ).map { (x, y) ->
            when (rotation) {
                90 -> y to (rawHeight - x)
                180 -> (rawWidth - x) to (rawHeight - y)
                270 -> (rawWidth - y) to x
                else -> x to y
            }
        }

        val left = corners.minOf { it.first }.coerceIn(0, rawWidth)
        val right = corners.maxOf { it.first }.coerceIn(0, rawWidth)
        val top = corners.minOf { it.second }.coerceIn(0, rawHeight)
        val bottom = corners.maxOf { it.second }.coerceIn(0, rawHeight)
        return Rect(left, top, right.coerceAtLeast(left + 1), bottom.coerceAtLeast(top + 1))
    }

    private fun finishFaceDetection(imageProxy: ImageProxy) {
        try {
            imageProxy.close()
        } catch (e: Exception) {
            // Already closed or freed by CameraX
        }
        settings.releaseFaceDetectorTask()
    }

    private companion object {
        const val DEBUG_PREVIEW_INTERVAL_MS = 900L
    }

    private fun minIntervalPassed() = (
        lastDetectionMillis + settings.minDetectionInterval
    ) < System.currentTimeMillis()
}
