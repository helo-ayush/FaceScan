package com.facedetectorcamera.pipeline

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import kotlin.math.exp

class AntiSpoofStage(context: Context, assetName: String) {
    private var interpreter: org.tensorflow.lite.Interpreter? = null
    private val inputBuffer = ByteBuffer.allocateDirect(1 * 80 * 80 * 3 * 4)
        .apply { order(ByteOrder.nativeOrder()) }
    private val outputBuffer = Array(1) { FloatArray(3) }

    init {
        Log.d("FaceAntiSpoof", "BUILD_MARKER=antispoof-byte-scale-v4 asset=$assetName")
        try {
            val fd = context.assets.openFd(assetName)
            val model = FileInputStream(fd.fileDescriptor).channel.map(
                FileChannel.MapMode.READ_ONLY,
                fd.startOffset,
                fd.declaredLength
            )
            interpreter = org.tensorflow.lite.Interpreter(
                model,
                org.tensorflow.lite.Interpreter.Options().apply { setNumThreads(2) }
            )
            val inTensor = interpreter!!.getInputTensor(0)
            val outTensor = interpreter!!.getOutputTensor(0)
            Log.d(
                "FaceAntiSpoof",
                "STARTUP DIAGNOSTIC | Device: ${Build.MANUFACTURER} ${Build.MODEL} (Android ${Build.VERSION.RELEASE}) | Model: $assetName | Input Tensor: name=${inTensor.name()}, shape=${inTensor.shape().toList()}, type=${inTensor.dataType()} | Output Tensor: name=${outTensor.name()}, shape=${outTensor.shape().toList()}, type=${outTensor.dataType()}"
            )
        } catch (error: Exception) {
            Log.e("FaceAntiSpoof", "Failed to load anti-spoof model $assetName: ${error.message}", error)
        }
    }

    fun process(pixels: IntArray): AntiSpoofResult? {
        val tflite = interpreter ?: return null
        if (pixels.size != 80 * 80) return null
        inputBuffer.rewind()

        // BGR channel order, values in [0, 255] — upstream contract.
        for (pixel in pixels) {
            val b = (pixel and 0xFF).toFloat()
            val g = ((pixel shr 8) and 0xFF).toFloat()
            val r = ((pixel shr 16) and 0xFF).toFloat()
            inputBuffer.putFloat(b)
            inputBuffer.putFloat(g)
            inputBuffer.putFloat(r)
        }

        var sumR = 0L
        var sumG = 0L
        var sumB = 0L
        var minR = 255
        var minG = 255
        var minB = 255
        var maxR = 0
        var maxG = 0
        var maxB = 0
        var signature = 1
        for ((index, pixel) in pixels.withIndex()) {
            val r = (pixel shr 16) and 0xFF
            val g = (pixel shr 8) and 0xFF
            val b = pixel and 0xFF
            sumR += r; sumG += g; sumB += b
            minR = minOf(minR, r); minG = minOf(minG, g); minB = minOf(minB, b)
            maxR = maxOf(maxR, r); maxG = maxOf(maxG, g); maxB = maxOf(maxB, b)
            if (index % 97 == 0) signature = 31 * signature + pixel
        }
        val count = pixels.size.toDouble()
        Log.d(
            "FaceAntiSpoof",
            "INPUT_STATS | mean=[${String.format("%.1f", sumR / count)},${String.format("%.1f", sumG / count)},${String.format("%.1f", sumB / count)}] " +
                "range=[$minR..$maxR,$minG..$maxG,$minB..$maxB] signature=$signature"
        )

        tflite.run(inputBuffer, outputBuffer)
        val logits = outputBuffer[0]

        if (logits[0].isNaN() || logits[1].isNaN() || logits[2].isNaN() ||
            logits[0].isInfinite() || logits[1].isInfinite() || logits[2].isInfinite()) {
            Log.e("FaceAntiSpoof", "Inference produced invalid logits: [${logits[0]}, ${logits[1]}, ${logits[2]}]")
            return null
        }

        val max = maxOf(logits[0], maxOf(logits[1], logits[2]))
        val e0 = exp((logits[0] - max).toDouble())
        val e1 = exp((logits[1] - max).toDouble())
        val e2 = exp((logits[2] - max).toDouble())
        val sum = e0 + e1 + e2
        val p0 = (e0 / sum).toFloat()
        val p1 = (e1 / sum).toFloat()
        val p2 = (e2 / sum).toFloat()

        val selectedClass = when {
            p0 >= p1 && p0 >= p2 -> 0
            p1 >= p0 && p1 >= p2 -> 1
            else -> 2
        }

        val probs = floatArrayOf(p0, p1, p2)

        Log.d(
            "FaceAntiSpoof",
            "LOGITS: [${String.format("%.2f", logits[0])}, ${String.format("%.2f", logits[1])}, ${String.format("%.2f", logits[2])}] | PROBS: [c0=${String.format("%.4f", p0)}, c1(live)=${String.format("%.4f", p1)}, c2=${String.format("%.4f", p2)}] | argmax=$selectedClass"
        )

        return AntiSpoofResult(
            logits = logits.copyOf(),
            probs = probs,
            probPrint = p0,
            probLive = p1,
            probReplay = p2,
            selectedClass = selectedClass
        )
    }
}
