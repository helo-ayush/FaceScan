package com.facedetectorcamera.pipeline

import android.content.Context
import android.util.Log
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

class FaceEmbeddingStage(context: Context) : FacePipelineStage<NormalizedFaceCrop, FloatArray?> {
    private var interpreter: org.tensorflow.lite.Interpreter? = null
    private val inputBuffer = ByteBuffer.allocateDirect(1 * 112 * 112 * 3 * 4)
        .apply { order(ByteOrder.nativeOrder()) }
    private val outputBuffer = Array(1) { FloatArray(512) }

    init {
        try {
            val fileDescriptor = context.assets.openFd("w600k_mbf.tflite")
            val inputStream = FileInputStream(fileDescriptor.fileDescriptor)
            val fileChannel = inputStream.channel
            val startOffset = fileDescriptor.startOffset
            val declaredLength = fileDescriptor.declaredLength
            val modelBuffer = fileChannel.map(FileChannel.MapMode.READ_ONLY, startOffset, declaredLength)

            val options = org.tensorflow.lite.Interpreter.Options()
            options.setNumThreads(4)
            interpreter = org.tensorflow.lite.Interpreter(modelBuffer, options)
            Log.d("FaceEmbedding", "MobileFaceNet loaded successfully.")
        } catch (e: Exception) {
            Log.e("FaceEmbedding", "Failed to load TFLite embedding model: ${e.message}")
        }
    }

    override fun process(input: NormalizedFaceCrop): FloatArray? {
        val tflite = interpreter ?: return null
        val pixels = input.pixels ?: return null
        if (!input.isReady || pixels.size != 112 * 112) return null

        inputBuffer.rewind()

        for (pixel in pixels) {
            val r = ((pixel shr 16) and 0xFF)
            val g = ((pixel shr 8) and 0xFF)
            val b = (pixel and 0xFF)

            inputBuffer.putFloat((r - 127.5f) / 127.5f)
            inputBuffer.putFloat((g - 127.5f) / 127.5f)
            inputBuffer.putFloat((b - 127.5f) / 127.5f)
        }

        tflite.run(inputBuffer, outputBuffer)

        val embedding = outputBuffer[0]
        var sum = 0f
        for (val1 in embedding) {
            sum += val1 * val1
        }
        val norm = kotlin.math.sqrt(sum)
        if (norm > 0f) {
            for (i in embedding.indices) {
                embedding[i] /= norm
            }
        }

        return embedding.copyOf()
    }
}
