package com.facedetectorcamera

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.CornerPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import kotlin.math.max

class FaceOverlayView(context: Context) : View(context) {
    var isOverlayEnabled: Boolean = true
        set(value) {
            field = value
            if (!value) {
                isFaceDetected = false
                currentRect = null
                targetRect = null
            }
            postInvalidateOnAnimation()
        }

    var isSmooth: Boolean = true
        set(value) {
            field = value
            postInvalidateOnAnimation()
        }

    private var currentRect: RectF? = null
    private var targetRect: RectF? = null
    private var isFaceDetected = false

    private val boxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#4f46e5") // Indigo primary
        style = Paint.Style.STROKE
        strokeWidth = 6f
        pathEffect = CornerPathEffect(24f)
    }

    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#334f46e5")
        style = Paint.Style.STROKE
        strokeWidth = 14f
        pathEffect = CornerPathEffect(28f)
    }

    private val textBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#4f46e5")
        style = Paint.Style.FILL
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 24f
        isFakeBoldText = true
    }

    fun updateFace(
        rect: RectF?,
        imageWidth: Int,
        imageHeight: Int,
        isMirrored: Boolean
    ) {
        if (!isOverlayEnabled || rect == null || imageWidth <= 0 || imageHeight <= 0) {
            if (isFaceDetected) {
                isFaceDetected = false
                targetRect = null
                postInvalidateOnAnimation()
            }
            return
        }

        val viewW = width.toFloat()
        val viewH = height.toFloat()
        if (viewW <= 0 || viewH <= 0) return

        // Scale factors mapping camera image pixels to screen preview view
        val scale = max(viewW / imageWidth, viewH / imageHeight)
        val renderedW = imageWidth * scale
        val renderedH = imageHeight * scale
        val offsetX = (viewW - renderedW) / 2f
        val offsetY = (viewH - renderedH) / 2f

        val mappedLeft = if (isMirrored) {
            viewW - (rect.left * scale + offsetX) - (rect.width() * scale)
        } else {
            rect.left * scale + offsetX
        }
        val mappedTop = rect.top * scale + offsetY
        val mappedRight = mappedLeft + rect.width() * scale
        val mappedBottom = mappedTop + rect.height() * scale

        val newTarget = RectF(mappedLeft, mappedTop, mappedRight, mappedBottom)

        if (!isFaceDetected || currentRect == null) {
            currentRect = RectF(newTarget)
            isFaceDetected = true
        }

        targetRect = newTarget
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!isOverlayEnabled || !isFaceDetected) return

        val target = targetRect ?: return
        val current = currentRect ?: return

        if (isSmooth) {
            // High-frequency exponential low-pass filter directly on frame animation loop (60 FPS native)
            val alpha = 0.35f
            current.left += (target.left - current.left) * alpha
            current.top += (target.top - current.top) * alpha
            current.right += (target.right - current.right) * alpha
            current.bottom += (target.bottom - current.bottom) * alpha
        } else {
            current.set(target)
        }

        // Draw glow aura
        canvas.drawRoundRect(current, 24f, 24f, glowPaint)

        // Draw main bounding box
        canvas.drawRoundRect(current, 24f, 24f, boxPaint)

        // Draw "FACE DETECTED" top label badge
        val labelText = "FACE DETECTED"
        val textWidth = textPaint.measureText(labelText)
        val labelPaddingH = 16f
        val labelHeight = 36f
        val labelRect = RectF(
            current.left,
            maxOf(0f, current.top - labelHeight - 6f),
            current.left + textWidth + (labelPaddingH * 2),
            maxOf(labelHeight, current.top - 6f)
        )

        canvas.drawRoundRect(labelRect, 12f, 12f, textBgPaint)
        canvas.drawText(
            labelText,
            labelRect.left + labelPaddingH,
            labelRect.bottom - 10f,
            textPaint
        )

        // Request continuous smooth frame updates until target position is reached
        if (isSmooth && Math.abs(current.left - target.left) > 0.5f) {
            postInvalidateOnAnimation()
        }
    }
}
