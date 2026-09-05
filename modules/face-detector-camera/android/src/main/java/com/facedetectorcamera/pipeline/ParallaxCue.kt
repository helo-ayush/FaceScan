package com.facedetectorcamera.pipeline

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Micro-parallax / non-planarity cue.
 * Fits least-squares homography between temporal landmarks and measures 3D residual.
 */
class ParallaxCue {
    private class Snapshot(
        val points: FloatArray,
        val eyeDistance: Float,
        val yaw: Float,
        val pitch: Float,
        val timeMs: Long
    )

    private val history = ArrayDeque<Snapshot>()

    fun reset() = history.clear()

    fun observe(geometry: FaceGeometry, timestampMs: Long): CueScore {
        if (geometry.eyeDistance.isNaN() || geometry.eyeDistance < MIN_EYE_DISTANCE) {
            return CueScore.abstain(CueId.PARALLAX, "eyeDistance=${geometry.eyeDistance}")
        }

        while (history.isNotEmpty() && timestampMs - history.first().timeMs > HISTORY_MS) {
            history.removeFirst()
        }

        val current = Snapshot(
            geometry.points.copyOf(), geometry.eyeDistance,
            geometry.yaw, geometry.pitch, timestampMs
        )

        var pairs = 0
        var residualSum = 0f
        var rotationSum = 0f
        var maxRotation = 0f
        for (previous in history) {
            val rotation = hypot(
                (current.yaw - previous.yaw).toDouble(),
                (current.pitch - previous.pitch).toDouble()
            ).toFloat()
            if (rotation < MIN_ROTATION_DEG) continue
            val residual = homographyResidual(previous.points, current.points) ?: continue
            residualSum += residual / current.eyeDistance
            rotationSum += rotation
            pairs++
            maxRotation = max(maxRotation, rotation)
        }

        history.addLast(current)
        if (history.size > MAX_HISTORY) history.removeFirst()

        if (pairs < MIN_PAIRS) {
            return CueScore.abstain(
                CueId.PARALLAX,
                "pairs=$pairs need=$MIN_PAIRS (rotation below ${MIN_ROTATION_DEG}deg)"
            )
        }
        return CueScore(
            CueId.PARALLAX, false, residualSum / rotationSum,
            "pairs=$pairs maxRot=${"%.2f".format(maxRotation)}deg"
        )
    }

    private fun homographyResidual(from: FloatArray, to: FloatArray): Float? {
        var count = 0
        for (index in 0 until FaceGeometry.COUNT) {
            if (!from[index * 2].isNaN() && !to[index * 2].isNaN()) count++
        }
        if (count < MIN_SHARED_POINTS) return null

        val fromNorm = normalize(from, to, count) ?: return null
        val toNorm = normalize(to, from, count) ?: return null

        val ata = Array(8) { DoubleArray(8) }
        val atb = DoubleArray(8)
        val row = DoubleArray(8)
        var cursor = 0
        for (index in 0 until FaceGeometry.COUNT) {
            if (from[index * 2].isNaN() || to[index * 2].isNaN()) continue
            val u = fromNorm.x[cursor]
            val v = fromNorm.y[cursor]
            val p = toNorm.x[cursor]
            val q = toNorm.y[cursor]
            cursor++

            java.util.Arrays.fill(row, 0.0)
            row[0] = u; row[1] = v; row[2] = 1.0; row[6] = -u * p; row[7] = -v * p
            accumulate(ata, atb, row, p)

            java.util.Arrays.fill(row, 0.0)
            row[3] = u; row[4] = v; row[5] = 1.0; row[6] = -u * q; row[7] = -v * q
            accumulate(ata, atb, row, q)
        }

        val h = solveLinear(ata, atb) ?: return null

        var squared = 0.0
        for (index in 0 until count) {
            val u = fromNorm.x[index]
            val v = fromNorm.y[index]
            val denominator = h[6] * u + h[7] * v + 1.0
            if (abs(denominator) < 1e-6) return null
            val dx = (h[0] * u + h[1] * v + h[2]) / denominator - toNorm.x[index]
            val dy = (h[3] * u + h[4] * v + h[5]) / denominator - toNorm.y[index]
            squared += dx * dx + dy * dy
        }
        return (sqrt(squared / count) * toNorm.radius).toFloat()
    }

    private class Normalized(val x: DoubleArray, val y: DoubleArray, val radius: Double)

    private fun normalize(points: FloatArray, paired: FloatArray, count: Int): Normalized? {
        val x = DoubleArray(count)
        val y = DoubleArray(count)
        var cursor = 0
        var meanX = 0.0
        var meanY = 0.0
        for (index in 0 until FaceGeometry.COUNT) {
            if (points[index * 2].isNaN() || paired[index * 2].isNaN()) continue
            x[cursor] = points[index * 2].toDouble()
            y[cursor] = points[index * 2 + 1].toDouble()
            meanX += x[cursor]
            meanY += y[cursor]
            cursor++
        }
        meanX /= count
        meanY /= count
        var radius = 0.0
        for (index in 0 until count) {
            x[index] -= meanX
            y[index] -= meanY
            radius += x[index] * x[index] + y[index] * y[index]
        }
        radius = sqrt(radius / count)
        if (radius < 1e-3) return null
        for (index in 0 until count) {
            x[index] /= radius
            y[index] /= radius
        }
        return Normalized(x, y, radius)
    }

    private fun accumulate(
        ata: Array<DoubleArray>,
        atb: DoubleArray,
        row: DoubleArray,
        target: Double
    ) {
        for (i in 0 until 8) {
            if (row[i] == 0.0) continue
            atb[i] += row[i] * target
            for (j in 0 until 8) ata[i][j] += row[i] * row[j]
        }
    }

    private companion object {
        const val HISTORY_MS = 1200L
        const val MAX_HISTORY = 40
        const val MIN_PAIRS = 3
        const val MIN_SHARED_POINTS = 6
        const val MIN_ROTATION_DEG = 1.5f
        const val MIN_EYE_DISTANCE = 24f
    }
}
