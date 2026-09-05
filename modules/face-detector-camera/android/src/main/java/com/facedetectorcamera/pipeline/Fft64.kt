package com.facedetectorcamera.pipeline

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** Iterative radix-2 FFT specialised to length 64, the only size used here. */
internal object Fft64 {
    private const val N = 64
    private const val LOG_N = 6
    private val cosTable = FloatArray(N / 2) { cos(2.0 * Math.PI * it / N).toFloat() }
    private val sinTable = FloatArray(N / 2) { sin(2.0 * Math.PI * it / N).toFloat() }
    private val reversed = IntArray(N) { index ->
        var result = 0
        var value = index
        for (bit in 0 until LOG_N) {
            result = (result shl 1) or (value and 1)
            value = value shr 1
        }
        result
    }

    /** Forward transform of the length-64 sequence at [offset] with [stride]. */
    fun transform(re: FloatArray, im: FloatArray, offset: Int, stride: Int) {
        for (i in 0 until N) {
            val j = reversed[i]
            if (j <= i) continue
            val a = offset + i * stride
            val b = offset + j * stride
            var swap = re[a]; re[a] = re[b]; re[b] = swap
            swap = im[a]; im[a] = im[b]; im[b] = swap
        }
        var size = 2
        while (size <= N) {
            val half = size / 2
            val twiddleStep = N / size
            var base = 0
            while (base < N) {
                var index = base
                var twiddle = 0
                while (index < base + half) {
                    val a = offset + index * stride
                    val b = offset + (index + half) * stride
                    val wr = cosTable[twiddle]
                    val wi = -sinTable[twiddle]
                    val tr = re[b] * wr - im[b] * wi
                    val ti = re[b] * wi + im[b] * wr
                    re[b] = re[a] - tr
                    im[b] = im[a] - ti
                    re[a] += tr
                    im[a] += ti
                    index++
                    twiddle += twiddleStep
                }
                base += size
            }
            size *= 2
        }
    }
}

/**
 * Solves `a x = b` by Gaussian elimination with partial pivoting, in place.
 * Returns null when the matrix is effectively singular (degenerate landmarks).
 */
internal fun solveLinear(a: Array<DoubleArray>, b: DoubleArray): DoubleArray? {
    val n = b.size
    for (column in 0 until n) {
        var pivot = column
        for (candidate in column + 1 until n) {
            if (abs(a[candidate][column]) > abs(a[pivot][column])) pivot = candidate
        }
        if (abs(a[pivot][column]) < 1e-12) return null
        if (pivot != column) {
            val swapRow = a[pivot]; a[pivot] = a[column]; a[column] = swapRow
            val swapValue = b[pivot]; b[pivot] = b[column]; b[column] = swapValue
        }
        for (target in column + 1 until n) {
            val factor = a[target][column] / a[column][column]
            if (factor == 0.0) continue
            for (inner in column until n) a[target][inner] -= factor * a[column][inner]
            b[target] -= factor * b[column]
        }
    }
    val x = DoubleArray(n)
    for (rowIndex in n - 1 downTo 0) {
        var sum = b[rowIndex]
        for (inner in rowIndex + 1 until n) sum -= a[rowIndex][inner] * x[inner]
        x[rowIndex] = sum / a[rowIndex][rowIndex]
    }
    return x
}
