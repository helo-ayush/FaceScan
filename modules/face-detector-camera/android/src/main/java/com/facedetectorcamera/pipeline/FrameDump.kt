package com.facedetectorcamera.pipeline

import android.graphics.Bitmap
import android.graphics.Rect
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Writes the frames the anti-spoof ensemble actually scored to disk, losslessly,
 * alongside the geometry and scores needed to reproduce every crop offline.
 *
 * ## Why this exists
 *
 * Calibration so far has only ever seen *scalars*: `scripts/calibrate_anti_spoof.py`
 * replays the accumulator from logged cue scores, which is enough to fit the fusion
 * table and nothing more. The second on-device capture showed that fitting the table
 * is not the problem. Held out by condition, the best table the search can find is
 * 7.4% false accepts at 41.3% false rejects, and it buys that by calling 24 of 40
 * genuine dim-light attempts spoofs. Every hand-crafted cue measured near chance
 * (MOIRE 0.530, CHROMA 0.554, BEZEL 0.481, SPECULAR 0.431, PARALLAX 0.596 pooled AUC)
 * and the MiniFASNet ensemble itself reached only 0.680 on this device - against 0.986
 * on the first capture, which used a single phone screen and was therefore measuring
 * that screen rather than the cue.
 *
 * A weak per-frame signal cannot be rescued by accumulating it: every aggregate of
 * ANTI_SPOOF over an attempt (min, p10, median, mean, p90, max) yields the same ~0.72
 * AUC, because frames inside an attempt are correlated. So the model has to improve,
 * and improving or even *evaluating* a model needs pixels, which no log line carries.
 *
 * ## Why full oriented frames, losslessly
 *
 * Storing the 80x80 network inputs would be smaller and would exactly pin what the
 * model saw, but it forecloses every question worth asking next - a different crop
 * scale, a different input size, a model that wants more context. The clamp in
 * `NativeFaceCropStage.processAntiSpoof` means the widest crop available on this
 * device is already ~2.4x the face box (~470px of a 480px frame), so the full frame
 * *is* the widest useful patch, and anything narrower is derivable from it.
 *
 * Lossless matters more than it looks. The artifacts that distinguish a display from
 * a face are high-frequency luma texture and chroma structure; Android's JPEG encoder
 * subsamples chroma 4:2:0, which halves the resolution of the exact signal the CHROMA
 * and MOIRE cues measure. A dataset compressed that way would answer a different
 * question than the deployed pipeline asks.
 *
 * ## Arming
 *
 * Dumping is off unless a marker file exists, so a calibration build is safe to run
 * normally and needs no rebuild to toggle:
 *
 * ```
 * adb shell mkdir -p /sdcard/Android/data/com.anonymous.facewmobile/files/facec_capture
 * adb shell touch /sdcard/Android/data/com.anonymous.facewmobile/files/facec_capture/ARMED
 * ```
 *
 * Remove the marker (or hit [MAX_FRAMES]) to stop. The marker is re-checked at most
 * once per [ARM_RECHECK_MS] so arming mid-session works without a stat per frame.
 */
class FrameDump(private val context: android.content.Context) {

    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "facec-framedump").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }
    private val written = AtomicInteger(0)

    private var root: File? = null
    private var session: File? = null
    private var meta: File? = null
    private var armed = false
    private var lastArmCheck = 0L
    private var announced = false

    /** Reusable so a 300k-int allocation does not land on the camera thread every tick. */
    private var scratch = IntArray(0)

    private fun refreshArmed(now: Long) {
        if (now - lastArmCheck < ARM_RECHECK_MS) return
        lastArmCheck = now
        val base = root ?: context.getExternalFilesDir(null)?.let { File(it, DIR_NAME) }?.also {
            root = it
        } ?: return
        val nowArmed = File(base, MARKER_NAME).exists()
        if (nowArmed && session == null) {
            val dir = File(base, "session_$now")
            if (!dir.mkdirs() && !dir.isDirectory) {
                Log.e(TAG, "DUMP | cannot create $dir")
                return
            }
            session = dir
            meta = File(dir, "meta.jsonl")
        }
        if (nowArmed != armed) {
            armed = nowArmed
            Log.d(TAG, "DUMP | armed=$armed dir=${session?.absolutePath}")
            // Dropping the session on disarm means each arm cycle lands in its own
            // folder, so one condition per cycle needs no app restart to stay separable.
            // The frame counter deliberately does *not* reset: filenames stay unique
            // across cycles, and [MAX_FRAMES] stays a real cap on device storage rather
            // than a per-folder one.
            if (!nowArmed) {
                session = null
                meta = null
            }
        }
    }

    /**
     * Captures one scored frame. Called with the frame still bound, so the pixel copy
     * has to happen here; PNG encoding and the write are handed to [io].
     *
     * @param note free-form fields appended to the metadata line - pass the same text
     *   the `CUES` log carries so nothing has to be re-derived offline.
     */
    fun capture(frame: YuvFrame, bounds: Rect, note: String) {
        val now = System.currentTimeMillis()
        refreshArmed(now)
        if (!armed || !frame.isValid) return

        val index = written.getAndIncrement()
        if (index >= MAX_FRAMES) {
            if (!announced) {
                announced = true
                Log.d(TAG, "DUMP | stopping at $MAX_FRAMES frames; pull and clear to continue")
            }
            return
        }

        val width = frame.orientedWidth
        val height = frame.orientedHeight
        if (scratch.size != width * height) scratch = IntArray(width * height)
        val pixels = scratch
        // Half-integer centres land exactly on source samples once argbAt maps back to
        // raw space, so this copy is a straight read and not a resample.
        var offset = 0
        for (y in 0 until height) {
            val sourceY = y + 0.5f
            for (x in 0 until width) {
                pixels[offset++] = frame.argbAt(x + 0.5f, sourceY)
            }
        }
        val copy = pixels.copyOf()
        val dir = session ?: return
        val metaFile = meta ?: return

        io.execute {
            val name = String.format("frame_%05d.png", index)
            try {
                val bitmap = Bitmap.createBitmap(copy, width, height, Bitmap.Config.ARGB_8888)
                FileOutputStream(File(dir, name)).use { out ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                }
                bitmap.recycle()
                FileOutputStream(metaFile, true).use { out ->
                    out.write(
                        ("{\"file\":\"$name\",\"t\":$now," +
                            "\"frame\":[$width,$height]," +
                            "\"box\":[${bounds.left},${bounds.top}," +
                            "${bounds.width()},${bounds.height()}]," +
                            "\"note\":\"${note.replace("\\", "\\\\").replace("\"", "\\\"")}\"}\n")
                            .toByteArray()
                    )
                }
            } catch (error: Exception) {
                Log.e(TAG, "DUMP | failed to write $name: ${error.message}")
            }
        }
    }

    private companion object {
        const val TAG = "FaceAntiSpoof"
        const val DIR_NAME = "facec_capture"
        const val MARKER_NAME = "ARMED"
        const val ARM_RECHECK_MS = 1000L

        /**
         * ~700MB of 480x640 PNG. High enough that a full capture session never hits it,
         * low enough that leaving the marker in place cannot fill the device.
         */
        const val MAX_FRAMES = 1500
    }
}
