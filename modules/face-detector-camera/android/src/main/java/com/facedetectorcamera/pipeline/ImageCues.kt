package com.facedetectorcamera.pipeline

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Owns every passive liveness cue that needs pixels:
 * - 2D FFT Moiré grid analysis
 * - Specular reflection compactness
 * - Chroma spread
 * - Device bezel edge energy
 */
class ImageCues {
    private val patchRe = FloatArray(PATCH * PATCH)
    private val patchIm = FloatArray(PATCH * PATCH)
    private val patch = FloatArray(PATCH * PATCH)
    private val ring = FloatArray(RING * RING)
    private val radialPower = DoubleArray(PATCH)
    private val radialPeak = DoubleArray(PATCH)
    private val radialCount = IntArray(PATCH)
    private val orientation = FloatArray(ORIENTATION_BINS)

    /**
     * Samples the shared mid-face patch and derives frame quality from it, without scoring anything.
     */
    fun sampleQuality(context: CueContext): FrameQuality = samplePatchAndQuality(context)

    /** Must be called only after [sampleQuality] on the same context. */
    fun evaluateCues(context: CueContext, quality: FrameQuality): List<CueScore> {
        val scores = ArrayList<CueScore>(4)
        scores.add(moire(context, quality))
        scores.addAll(surface(context))
        scores.add(bezel(context))
        return scores
    }

    fun evaluate(context: CueContext): ImageCueResult {
        val quality = sampleQuality(context)
        return ImageCueResult(quality, evaluateCues(context, quality))
    }

    private fun samplePatchAndQuality(context: CueContext): FrameQuality {
        val bounds = context.faceBounds
        val geometry = context.geometry
        val centreX = bounds.exactCenterX()
        val centreY = bounds.exactCenterY() + bounds.height() * 0.06f
        val half = PATCH / 2f
        val startX = (centreX - half).coerceIn(0f, (context.frame.orientedWidth - PATCH).coerceAtLeast(0).toFloat())
        val startY = (centreY - half).coerceIn(0f, (context.frame.orientedHeight - PATCH).coerceAtLeast(0).toFloat())

        var sum = 0f
        for (row in 0 until PATCH) {
            val y = startY + row + 0.5f
            for (column in 0 until PATCH) {
                val value = context.frame.lumaAt(startX + column + 0.5f, y)
                patch[row * PATCH + column] = value
                sum += value
            }
        }
        val meanLuma = sum / (PATCH * PATCH)

        var lapSum = 0.0
        var lapSquared = 0.0
        var contrast = 0.0
        var samples = 0
        for (row in 1 until PATCH - 1) {
            for (column in 1 until PATCH - 1) {
                val index = row * PATCH + column
                val laplacian = 4f * patch[index] - patch[index - 1] - patch[index + 1] -
                    patch[index - PATCH] - patch[index + PATCH]
                lapSum += laplacian
                lapSquared += laplacian.toDouble() * laplacian
                contrast += abs(patch[index] - meanLuma).toDouble()
                samples++
            }
        }
        val mean = lapSum / samples
        val variance = lapSquared / samples - mean * mean
        val contrastMean = (contrast / samples).coerceAtLeast(1.0)
        val sharpness = (sqrt(variance.coerceAtLeast(0.0)) / contrastMean).toFloat()

        return FrameQuality(
            eyeDistance = geometry.eyeDistance,
            faceWidth = bounds.width(),
            faceLuma = meanLuma,
            sharpness = sharpness,
            yaw = geometry.yaw,
            pitch = geometry.pitch,
            roll = geometry.roll
        )
    }

    private fun moire(context: CueContext, quality: FrameQuality): CueScore {
        if (context.faceBounds.width() < MIN_FACE_PX_FOR_PATCH) {
            return CueScore.abstain(
                CueId.MOIRE, "faceWidth=${context.faceBounds.width()} need=$MIN_FACE_PX_FOR_PATCH"
            )
        }
        if (quality.faceLuma < MIN_PATCH_LUMA || quality.faceLuma > MAX_PATCH_LUMA) {
            return CueScore.abstain(CueId.MOIRE, "luma=${"%.1f".format(quality.faceLuma)}")
        }
        if (quality.sharpness < MIN_PATCH_SHARPNESS) {
            return CueScore.abstain(CueId.MOIRE, "sharpness=${"%.3f".format(quality.sharpness)}")
        }

        var mean = 0f
        for (value in patch) mean += value
        mean /= patch.size
        for (row in 0 until PATCH) {
            val wy = HANN[row]
            for (column in 0 until PATCH) {
                val index = row * PATCH + column
                patchRe[index] = (patch[index] - mean) * wy * HANN[column]
                patchIm[index] = 0f
            }
        }

        for (row in 0 until PATCH) Fft64.transform(patchRe, patchIm, row * PATCH, 1)
        for (column in 0 until PATCH) Fft64.transform(patchRe, patchIm, column, PATCH)

        java.util.Arrays.fill(radialPower, 0.0)
        java.util.Arrays.fill(radialPeak, 0.0)
        java.util.Arrays.fill(radialCount, 0)
        for (row in 0 until PATCH) {
            val ky = if (row <= PATCH / 2) row else row - PATCH
            for (column in 0 until PATCH) {
                val kx = if (column <= PATCH / 2) column else column - PATCH
                val radius = hypot(kx.toDouble(), ky.toDouble()).toInt()
                if (radius >= PATCH / 2) continue
                val index = row * PATCH + column
                val power = patchRe[index].toDouble() * patchRe[index] +
                    patchIm[index].toDouble() * patchIm[index]
                radialPower[radius] += power
                if (power > radialPeak[radius]) radialPeak[radius] = power
                radialCount[radius]++
            }
        }

        var wSum = 0.0; var wx = 0.0; var wy = 0.0; var wxx = 0.0; var wxy = 0.0
        for (radius in FIT_R_MIN until FIT_R_MAX) {
            val count = radialCount[radius]
            if (count == 0) continue
            val power = radialPower[radius] / count
            if (power <= 0.0) continue
            val lx = ln(radius.toDouble())
            val ly = ln(power)
            val weight = count.toDouble()
            wSum += weight; wx += weight * lx; wy += weight * ly
            wxx += weight * lx * lx; wxy += weight * lx * ly
        }
        if (wSum <= 0.0) return CueScore.abstain(CueId.MOIRE, "empty spectrum")
        val denominator = wSum * wxx - wx * wx
        if (abs(denominator) < 1e-9) return CueScore.abstain(CueId.MOIRE, "degenerate fit")
        val slope = (wSum * wxy - wx * wy) / denominator
        val intercept = (wy - slope * wx) / wSum

        var bump = 0.0
        var bumpRadius = 0
        for (radius in BUMP_R_MIN until BUMP_R_MAX) {
            val count = radialCount[radius]
            if (count == 0) continue
            val peak = radialPeak[radius]
            if (peak <= 0.0) continue
            val noiseMaximum = ln(ln(count.toDouble()) + EULER_GAMMA)
            val residual = ln(peak) - (slope * ln(radius.toDouble()) + intercept) - noiseMaximum
            if (residual > bump) {
                bump = residual
                bumpRadius = radius
            }
        }

        return CueScore(
            CueId.MOIRE, false, bump.toFloat(),
            "bumpAt=${bumpRadius}cyc slope=${"%.2f".format(slope)}"
        )
    }

    private fun surface(context: CueContext): List<CueScore> {
        val bounds = context.faceBounds
        if (bounds.width() < MIN_FACE_PX_FOR_GRID || bounds.height() < MIN_FACE_PX_FOR_GRID) {
            val why = "faceBox=${bounds.width()}x${bounds.height()}"
            return listOf(
                CueScore.abstain(CueId.SPECULAR, why),
                CueScore.abstain(CueId.CHROMA, why)
            )
        }

        val stepX = bounds.width() / GRID.toFloat()
        val stepY = bounds.height() / GRID.toFloat()
        var brightCount = 0
        var brightX = 0f
        var brightY = 0f
        var skinCount = 0
        var cbSum = 0.0; var crSum = 0.0; var cbSquared = 0.0; var crSquared = 0.0
        val brightXs = FloatArray(GRID * GRID)
        val brightYs = FloatArray(GRID * GRID)

        for (row in 0 until GRID) {
            val y = bounds.top + (row + 0.5f) * stepY
            for (column in 0 until GRID) {
                val x = bounds.left + (column + 0.5f) * stepX
                if (x < 0f || x >= context.frame.orientedWidth ||
                    y < 0f || y >= context.frame.orientedHeight
                ) continue
                val argb = context.frame.argbAt(x, y)
                val r = (argb shr 16) and 0xFF
                val g = (argb shr 8) and 0xFF
                val b = argb and 0xFF
                val luma = 0.299f * r + 0.587f * g + 0.114f * b
                if (luma >= SPECULAR_LUMA) {
                    brightXs[brightCount] = column.toFloat()
                    brightYs[brightCount] = row.toFloat()
                    brightX += column
                    brightY += row
                    brightCount++
                }
                if (luma in SKIN_LUMA_MIN..SKIN_LUMA_MAX) {
                    val cb = -0.168736f * r - 0.331264f * g + 0.5f * b
                    val cr = 0.5f * r - 0.418688f * g - 0.081312f * b
                    cbSum += cb; crSum += cr
                    cbSquared += cb.toDouble() * cb; crSquared += cr.toDouble() * cr
                    skinCount++
                }
            }
        }

        val total = GRID * GRID
        val specular = if (brightCount < MIN_BRIGHT_SAMPLES) {
            CueScore(CueId.SPECULAR, false, 0f, "bright=$brightCount (below blob size)")
        } else {
            val centroidX = brightX / brightCount
            val centroidY = brightY / brightCount
            var spread = 0f
            for (index in 0 until brightCount) {
                spread += (brightXs[index] - centroidX) * (brightXs[index] - centroidX) +
                    (brightYs[index] - centroidY) * (brightYs[index] - centroidY)
            }
            spread = sqrt(spread / brightCount)
            val ideal = sqrt(brightCount / Math.PI).toFloat().coerceAtLeast(0.5f)
            val compactness = (ideal / spread.coerceAtLeast(1e-3f)).coerceIn(0f, 1f)
            val coverage = brightCount.toFloat() / total
            CueScore(
                CueId.SPECULAR, false, coverage * compactness,
                "coverage=${"%.4f".format(coverage)} compactness=${"%.2f".format(compactness)}"
            )
        }

        val chroma = if (skinCount < MIN_SKIN_SAMPLES) {
            CueScore.abstain(CueId.CHROMA, "skinSamples=$skinCount")
        } else {
            val n = skinCount.toDouble()
            val cbVariance = (cbSquared / n - (cbSum / n) * (cbSum / n)).coerceAtLeast(0.0)
            val crVariance = (crSquared / n - (crSum / n) * (crSum / n)).coerceAtLeast(0.0)
            CueScore(
                CueId.CHROMA, false, sqrt(cbVariance + crVariance).toFloat(),
                "skinSamples=$skinCount"
            )
        }

        return listOf(specular, chroma)
    }

    private fun bezel(context: CueContext): CueScore {
        val bounds = context.faceBounds
        val span = max(bounds.width(), bounds.height()) * RING_OUTER
        if (span < MIN_RING_SPAN) {
            return CueScore.abstain(CueId.BEZEL, "span=${"%.0f".format(span)}")
        }
        val centreX = bounds.exactCenterX()
        val centreY = bounds.exactCenterY()
        val step = span / RING
        val startX = centreX - span / 2f
        val startY = centreY - span / 2f

        for (row in 0 until RING) {
            val y = startY + (row + 0.5f) * step
            for (column in 0 until RING) {
                ring[row * RING + column] =
                    context.frame.lumaAt(startX + (column + 0.5f) * step, y)
            }
        }

        java.util.Arrays.fill(orientation, 0f)
        val innerHalf = max(bounds.width(), bounds.height()) * RING_INNER / 2f
        var totalEnergy = 0f
        for (row in 1 until RING - 1) {
            val y = startY + (row + 0.5f) * step
            for (column in 1 until RING - 1) {
                val x = startX + (column + 0.5f) * step
                if (abs(x - centreX) < innerHalf && abs(y - centreY) < innerHalf) continue
                val index = row * RING + column
                val gx = (ring[index + 1] - ring[index - 1]) +
                    0.5f * (ring[index + 1 - RING] - ring[index - 1 - RING]) +
                    0.5f * (ring[index + 1 + RING] - ring[index - 1 + RING])
                val gy = (ring[index + RING] - ring[index - RING]) +
                    0.5f * (ring[index + RING + 1] - ring[index - RING + 1]) +
                    0.5f * (ring[index + RING - 1] - ring[index - RING - 1])
                val magnitude = hypot(gx.toDouble(), gy.toDouble()).toFloat()
                if (magnitude < MIN_GRADIENT) continue
                var angle = Math.toDegrees(kotlin.math.atan2(gy.toDouble(), gx.toDouble())).toFloat()
                if (angle < 0f) angle += 180f
                if (angle >= 180f) angle -= 180f
                val bin = (angle / (180f / ORIENTATION_BINS)).toInt().coerceIn(0, ORIENTATION_BINS - 1)
                orientation[bin] += magnitude
                totalEnergy += magnitude
            }
        }

        if (totalEnergy < MIN_RING_ENERGY) {
            return CueScore.abstain(CueId.BEZEL, "ringEnergy=${"%.0f".format(totalEnergy)}")
        }

        var firstBin = 0
        for (bin in 1 until ORIENTATION_BINS) {
            if (orientation[bin] > orientation[firstBin]) firstBin = bin
        }
        var secondBin = -1
        for (bin in 0 until ORIENTATION_BINS) {
            val separation = circularBinDistance(bin, firstBin)
            if (separation < MIN_MODE_SEPARATION_BINS) continue
            if (secondBin < 0 || orientation[bin] > orientation[secondBin]) secondBin = bin
        }
        if (secondBin < 0) return CueScore(CueId.BEZEL, false, 0f, "single mode")

        val degreesPerBin = 180f / ORIENTATION_BINS
        val separationDeg = circularBinDistance(firstBin, secondBin) * degreesPerBin
        if (abs(separationDeg - 90f) > PERPENDICULAR_TOLERANCE_DEG) {
            return CueScore(
                CueId.BEZEL, false, 0f,
                "modes ${"%.0f".format(separationDeg)}deg apart, not perpendicular"
            )
        }

        val energy = modeEnergy(firstBin) + modeEnergy(secondBin)
        return CueScore(
            CueId.BEZEL, false, energy / totalEnergy,
            "modes=${(firstBin * degreesPerBin).toInt()}/${(secondBin * degreesPerBin).toInt()}deg"
        )
    }

    private fun modeEnergy(centreBin: Int): Float {
        var energy = 0f
        for (offset in -MODE_HALF_WIDTH..MODE_HALF_WIDTH) {
            val bin = ((centreBin + offset) % ORIENTATION_BINS + ORIENTATION_BINS) % ORIENTATION_BINS
            energy += orientation[bin]
        }
        return energy
    }

    private fun circularBinDistance(a: Int, b: Int): Int {
        val raw = abs(a - b)
        return min(raw, ORIENTATION_BINS - raw)
    }

    private companion object {
        const val PATCH = 64
        const val GRID = 32
        const val RING = 80
        const val ORIENTATION_BINS = 36

        const val MIN_FACE_PX_FOR_PATCH = 96
        const val MIN_FACE_PX_FOR_GRID = 48
        const val MIN_PATCH_LUMA = 32f
        const val MAX_PATCH_LUMA = 226f
        const val MIN_PATCH_SHARPNESS = 0.14f
        const val FIT_R_MIN = 3
        const val FIT_R_MAX = 31
        const val BUMP_R_MIN = 7
        const val BUMP_R_MAX = 30

        const val EULER_GAMMA = 0.5772156649015329

        const val SPECULAR_LUMA = 244f
        const val SKIN_LUMA_MIN = 40f
        const val SKIN_LUMA_MAX = 242f
        const val MIN_BRIGHT_SAMPLES = 4
        const val MIN_SKIN_SAMPLES = 120

        const val RING_INNER = 1.15f
        const val RING_OUTER = 2.4f
        const val MIN_RING_SPAN = 120f
        const val MIN_GRADIENT = 12f
        const val MIN_RING_ENERGY = 2000f
        const val MIN_MODE_SEPARATION_BINS = 8
        const val MODE_HALF_WIDTH = 2
        const val PERPENDICULAR_TOLERANCE_DEG = 22f

        val HANN = FloatArray(PATCH) { index ->
            (0.5 - 0.5 * cos(2.0 * Math.PI * index / (PATCH - 1))).toFloat()
        }
    }
}
