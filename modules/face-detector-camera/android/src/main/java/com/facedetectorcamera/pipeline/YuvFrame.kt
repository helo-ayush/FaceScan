package com.facedetectorcamera.pipeline

import androidx.camera.core.ImageProxy
import kotlin.math.floor

/**
 * One camera frame's YUV_420_888 planes, copied once and then sampled directly
 * at whatever grid points a crop actually needs.
 */
class YuvFrame {
    private var yb = ByteArray(0)
    private var ub = ByteArray(0)
    private var vb = ByteArray(0)
    private var yRowStride = 0
    private var yPixelStride = 1
    private var uRowStride = 0
    private var uPixelStride = 1
    private var vRowStride = 0
    private var vPixelStride = 1

    var rawWidth = 0
        private set
    var rawHeight = 0
        private set
    var rotation = 0
        private set
    var orientedWidth = 0
        private set
    var orientedHeight = 0
        private set
    var isValid = false
        private set

    /** Copies this frame's planes into reusable buffers without conversion overhead. */
    fun bind(image: ImageProxy, rotationDegrees: Int): YuvFrame {
        isValid = false
        if (image.planes.size < 3) return this

        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]

        val yBuffer = yPlane.buffer.duplicate().apply { position(0) }
        val uBuffer = uPlane.buffer.duplicate().apply { position(0) }
        val vBuffer = vPlane.buffer.duplicate().apply { position(0) }

        if (yb.size != yBuffer.remaining()) yb = ByteArray(yBuffer.remaining())
        if (ub.size != uBuffer.remaining()) ub = ByteArray(uBuffer.remaining())
        if (vb.size != vBuffer.remaining()) vb = ByteArray(vBuffer.remaining())
        yBuffer.get(yb)
        uBuffer.get(ub)
        vBuffer.get(vb)

        yRowStride = yPlane.rowStride
        yPixelStride = yPlane.pixelStride
        uRowStride = uPlane.rowStride
        uPixelStride = uPlane.pixelStride
        vRowStride = vPlane.rowStride
        vPixelStride = vPlane.pixelStride

        rawWidth = image.width
        rawHeight = image.height
        rotation = ((rotationDegrees % 360) + 360) % 360
        val swapsAxes = rotation == 90 || rotation == 270
        orientedWidth = if (swapsAxes) rawHeight else rawWidth
        orientedHeight = if (swapsAxes) rawWidth else rawHeight
        isValid = rawWidth > 0 && rawHeight > 0 && yb.isNotEmpty()
        return this
    }

    /**
     * Bilinear ARGB sample at a continuous oriented coordinate.
     */
    fun argbAt(orientedX: Float, orientedY: Float): Int {
        val rawX: Float
        val rawY: Float
        when (rotation) {
            90 -> {
                rawX = orientedY
                rawY = rawHeight - orientedX
            }
            180 -> {
                rawX = rawWidth - orientedX
                rawY = rawHeight - orientedY
            }
            270 -> {
                rawX = rawWidth - orientedY
                rawY = orientedX
            }
            else -> {
                rawX = orientedX
                rawY = orientedY
            }
        }

        val fx = rawX - 0.5f
        val fy = rawY - 0.5f
        val ix = floor(fx).toInt()
        val iy = floor(fy).toInt()
        val wx = fx - ix
        val wy = fy - iy
        val x0 = ix.coerceIn(0, rawWidth - 1)
        val x1 = (ix + 1).coerceIn(0, rawWidth - 1)
        val y0 = iy.coerceIn(0, rawHeight - 1)
        val y1 = (iy + 1).coerceIn(0, rawHeight - 1)

        val luma = bilerp(luma(x0, y0), luma(x1, y0), luma(x0, y1), luma(x1, y1), wx, wy)
        val cb = bilerp(
            chroma(ub, uRowStride, uPixelStride, x0, y0),
            chroma(ub, uRowStride, uPixelStride, x1, y0),
            chroma(ub, uRowStride, uPixelStride, x0, y1),
            chroma(ub, uRowStride, uPixelStride, x1, y1),
            wx, wy
        ) - 128f
        val cr = bilerp(
            chroma(vb, vRowStride, vPixelStride, x0, y0),
            chroma(vb, vRowStride, vPixelStride, x1, y0),
            chroma(vb, vRowStride, vPixelStride, x0, y1),
            chroma(vb, vRowStride, vPixelStride, x1, y1),
            wx, wy
        ) - 128f

        val r = (luma + 1.370705f * cr).toInt().coerceIn(0, 255)
        val g = (luma - 0.337633f * cb - 0.698001f * cr).toInt().coerceIn(0, 255)
        val b = (luma + 1.732446f * cb).toInt().coerceIn(0, 255)
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    /** Luma-only sample; used by cues that only need brightness/texture. */
    fun lumaAt(orientedX: Float, orientedY: Float): Float {
        val rawX: Float
        val rawY: Float
        when (rotation) {
            90 -> {
                rawX = orientedY
                rawY = rawHeight - orientedX
            }
            180 -> {
                rawX = rawWidth - orientedX
                rawY = rawHeight - orientedY
            }
            270 -> {
                rawX = rawWidth - orientedY
                rawY = orientedX
            }
            else -> {
                rawX = orientedX
                rawY = orientedY
            }
        }
        val fx = rawX - 0.5f
        val fy = rawY - 0.5f
        val ix = floor(fx).toInt()
        val iy = floor(fy).toInt()
        val x0 = ix.coerceIn(0, rawWidth - 1)
        val x1 = (ix + 1).coerceIn(0, rawWidth - 1)
        val y0 = iy.coerceIn(0, rawHeight - 1)
        val y1 = (iy + 1).coerceIn(0, rawHeight - 1)
        return bilerp(
            luma(x0, y0), luma(x1, y0), luma(x0, y1), luma(x1, y1),
            fx - ix, fy - iy
        )
    }

    private fun luma(x: Int, y: Int): Int {
        val index = y * yRowStride + x * yPixelStride
        return if (index >= 0 && index < yb.size) yb[index].toInt() and 0xFF else 0
    }

    private fun chroma(buffer: ByteArray, rowStride: Int, pixelStride: Int, x: Int, y: Int): Int {
        val index = (y shr 1) * rowStride + (x shr 1) * pixelStride
        return if (index >= 0 && index < buffer.size) buffer[index].toInt() and 0xFF else 128
    }

    private fun bilerp(v00: Int, v10: Int, v01: Int, v11: Int, wx: Float, wy: Float): Float {
        val top = v00 + (v10 - v00) * wx
        val bottom = v01 + (v11 - v01) * wx
        return top + (bottom - top) * wy
    }
}
