package com.facedetectorcamera.pipeline

import android.graphics.Matrix

class NativeFaceCropStage : FacePipelineStage<FaceCropInput, NormalizedFaceCrop> {
    private val pixels = IntArray(TARGET_SIZE * TARGET_SIZE)
    private val allPoints = FloatArray(TARGET_SIZE * TARGET_SIZE * 2)

    override fun process(input: FaceCropInput): NormalizedFaceCrop {
        if (!input.alignment.isReady) return NormalizedFaceCrop(isReady = false)
        val frame = input.frame
        if (!frame.isValid) return NormalizedFaceCrop(isReady = false)

        val canonicalToSource = Matrix()
        if (!input.alignment.sourceToCanonical.invert(canonicalToSource)) {
            return NormalizedFaceCrop(isReady = false)
        }

        for (outputY in 0 until TARGET_SIZE) {
            for (outputX in 0 until TARGET_SIZE) {
                val idx = (outputY * TARGET_SIZE + outputX) * 2
                allPoints[idx] = outputX + 0.5f
                allPoints[idx + 1] = outputY + 0.5f
            }
        }
        canonicalToSource.mapPoints(allPoints)

        val orientedWidth = frame.orientedWidth
        val orientedHeight = frame.orientedHeight
        var sampledPixels = 0
        for (index in 0 until TARGET_SIZE * TARGET_SIZE) {
            val orientedX = allPoints[index * 2]
            val orientedY = allPoints[index * 2 + 1]
            if (orientedX >= 0f && orientedX < orientedWidth &&
                orientedY >= 0f && orientedY < orientedHeight
            ) {
                pixels[index] = frame.argbAt(orientedX, orientedY)
                sampledPixels++
            } else {
                pixels[index] = 0xFF000000.toInt()
            }
        }

        return NormalizedFaceCrop(
            isReady = sampledPixels > 0,
            coverage = sampledPixels.toFloat() / pixels.size,
            pixels = pixels.copyOf()
        )
    }

    /**
     * Cuts the `scale`x-widened anti-spoof patch.
     */
    fun processAntiSpoof(
        input: FaceCropInput,
        scale: Float,
        luma: Float? = null,
        isTrulyDim: Boolean = false,
        hasSpecularGlare: Boolean = false
    ): IntArray? {
        val bounds = input.faceBounds ?: return null
        if (bounds.width() <= 0 || bounds.height() <= 0) return null
        val frame = input.frame
        if (!frame.isValid) return null

        val orientedWidth = frame.orientedWidth
        val orientedHeight = frame.orientedHeight

        val effectiveScale = minOf(
            scale,
            (orientedWidth - 1f) / bounds.width(),
            (orientedHeight - 1f) / bounds.height()
        )
        val cropWidth = bounds.width() * effectiveScale
        val cropHeight = bounds.height() * effectiveScale
        var left = bounds.exactCenterX() - cropWidth / 2f
        var top = bounds.exactCenterY() - cropHeight / 2f
        left = left.coerceIn(0f, (orientedWidth - cropWidth).coerceAtLeast(0f))
        top = top.coerceIn(0f, (orientedHeight - cropHeight).coerceAtLeast(0f))

        val originX = left.toInt()
        val originY = top.toInt()
        val cropW = cropWidth.toInt().coerceAtMost(orientedWidth - originX).coerceAtLeast(1)
        val cropH = cropHeight.toInt().coerceAtMost(orientedHeight - originY).coerceAtLeast(1)

        val stepX = cropW / ANTI_SPOOF_SIZE.toFloat()
        val stepY = cropH / ANTI_SPOOF_SIZE.toFloat()
        val output = IntArray(ANTI_SPOOF_SIZE * ANTI_SPOOF_SIZE)
        for (outputY in 0 until ANTI_SPOOF_SIZE) {
            val sourceY = originY + (outputY + 0.5f) * stepY
            val rowBase = outputY * ANTI_SPOOF_SIZE
            for (outputX in 0 until ANTI_SPOOF_SIZE) {
                output[rowBase + outputX] =
                    frame.argbAt(originX + (outputX + 0.5f) * stepX, sourceY)
            }
        }

        // Low-light sensor shot noise suppression:
        // Only run when the scene is genuinely dim and NOT suffering from specular glare.
        if ((isTrulyDim || (luma != null && luma < 75f)) && !hasSpecularGlare) {
            var hasHighlight = false
            for (pixel in output) {
                val r = (pixel shr 16) and 0xFF
                val g = (pixel shr 8) and 0xFF
                val b = pixel and 0xFF
                val y = (r * 77 + g * 150 + b * 29) shr 8
                if (y >= 200) {
                    hasHighlight = true
                    break
                }
            }

            if (!hasHighlight) {
                val denoised = IntArray(output.size)
                val threshold = 5
                for (y in 0 until ANTI_SPOOF_SIZE) {
                    val row = y * ANTI_SPOOF_SIZE
                    for (x in 0 until ANTI_SPOOF_SIZE) {
                        val centerPixel = output[row + x]
                        val cR = (centerPixel shr 16) and 0xFF
                        val cG = (centerPixel shr 8) and 0xFF
                        val cB = centerPixel and 0xFF
                        val cY = (cR * 77 + cG * 150 + cB * 29) shr 8

                        var sumR = cR * 4
                        var sumG = cG * 4
                        var sumB = cB * 4
                        var sumW = 4

                        val yMin = maxOf(0, y - 1)
                        val yMax = minOf(ANTI_SPOOF_SIZE - 1, y + 1)
                        val xMin = maxOf(0, x - 1)
                        val xMax = minOf(ANTI_SPOOF_SIZE - 1, x + 1)

                        for (ny in yMin..yMax) {
                            val nRow = ny * ANTI_SPOOF_SIZE
                            for (nx in xMin..xMax) {
                                if (nx == x && ny == y) continue
                                val nPixel = output[nRow + nx]
                                val nR = (nPixel shr 16) and 0xFF
                                val nG = (nPixel shr 8) and 0xFF
                                val nB = nPixel and 0xFF
                                val nY = (nR * 77 + nG * 150 + nB * 29) shr 8
                                val diff = if (nY >= cY) nY - cY else cY - nY
                                if (diff < threshold) {
                                    val w = threshold - diff
                                    sumR += nR * w
                                    sumG += nG * w
                                    sumB += nB * w
                                    sumW += w
                                }
                            }
                        }
                        val finalR = (sumR / sumW).coerceIn(0, 255)
                        val finalG = (sumG / sumW).coerceIn(0, 255)
                        val finalB = (sumB / sumW).coerceIn(0, 255)
                        denoised[row + x] = (0xFF shl 24) or (finalR shl 16) or (finalG shl 8) or finalB
                    }
                }
                return denoised
            }
        }

        return output
    }

    private companion object {
        const val TARGET_SIZE = 112
        const val ANTI_SPOOF_SIZE = 80
    }
}
