package com.facedetectorcamera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Surface
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.facedetectorcamera.facedetector.FaceDetector
import com.facedetectorcamera.facedetector.FaceDetectorSettings
import com.facedetectorcamera.facedetector.toByteArray
import com.facedetectorcamera.records.CameraType
import com.facedetectorcamera.tasks.ResolveTakenPicture
import expo.modules.core.errors.ModuleDestroyedException
import expo.modules.interfaces.camera.CameraViewInterface
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream

class CameraView(
    context: Context,
    appContext: AppContext
) : ExpoView(context, appContext),
    CameraViewInterface {
    private val currentActivity
        get() = appContext.currentActivity as? AppCompatActivity
            ?: throw Exceptions.MissingActivity()

    private var camera: Camera? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private val providerFuture = ProcessCameraProvider.getInstance(context)
    private var imageCaptureUseCase: ImageCapture? = null
    private var imageAnalysisUseCase: ImageAnalysis? = null
    private var previewView = PreviewView(context)
    private var faceOverlayView = FaceOverlayView(context)
    private var targetRotation = Surface.ROTATION_0
    private val scope = CoroutineScope(Dispatchers.Main)

    var lenFacing = CameraType.FRONT
        set(value) {
            field = value
            createCamera()
        }

    private val onCameraReady by EventDispatcher<Unit>()
    private val onMountError by EventDispatcher<CameraMountErrorEvent>()
    private val onFacesDetected by EventDispatcher<FacesDetectedEvent>(
        /**
         * Should events about detected faces coalesce, the best strategy will be
         * to ensure that events with different faces count are always being transmitted.
         */
        coalescingKey = { event -> (event.faces.size % Short.MAX_VALUE).toShort() }
    )
    private val onPictureSaved by EventDispatcher<PictureSavedEvent>(
        coalescingKey = { event ->
            val uriHash = event.data.getString("uri")?.hashCode() ?: -1
            (uriHash % Short.MAX_VALUE).toShort()
        }
    )

    // Scanning-related properties
    private var faceDetectorSettings = FaceDetectorSettings()
    private var shouldDetectFaces = false
    /**
     * Worker thread that runs the ML Kit analyzer. A `var`, not a `val`, because
     * [onDetachedFromWindow] shuts it down and [onAttachedToWindow] has to build a
     * fresh one — an `ExecutorService`, once shut down, can never be restarted.
     */
    private var cameraExecutor = newCameraExecutor()

    private fun newCameraExecutor(): java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable).apply {
                uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, throwable ->
                    if (throwable is com.google.android.gms.tasks.DuplicateTaskCompletionException ||
                        throwable.cause is com.google.android.gms.tasks.DuplicateTaskCompletionException ||
                        throwable.message?.contains("DuplicateTaskCompletionException") == true
                    ) {
                        Log.w("CameraView", "Handled in-flight task completion during tear-down safely")
                    } else {
                        Log.e("CameraView", "Uncaught exception in camera execution thread", throwable)
                    }
                }
            }
        }

    private fun updateTargetRotation(): Boolean {
        val newRotation = previewView.display?.rotation ?: return false
        if (newRotation == targetRotation) {
            return false
        }

        targetRotation = newRotation
        return true
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)

        // CameraX use cases keep their original target rotation after the device turns.
        // Rebinding makes both the preview and ML Kit receive the same orientation.
        if (cameraProvider != null && updateTargetRotation()) {
            post { createCamera() }
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()

        // React Navigation detaches a screen's views whenever it loses focus, and
        // [onDetachedFromWindow] shuts the executor down for good. Every frame after
        // that was submitted to a dead executor; CameraX swallows the resulting
        // RejectedExecutionException, so the preview kept streaming while
        // `onFacesDetected` never fired again and the native overlay froze on its
        // last boxes — recoverable only by restarting the app. Rebuild the executor,
        // then rebuild the analyzer that captured the old one.
        if (cameraExecutor.isShutdown) {
            cameraExecutor = newCameraExecutor()
        }
        // Rebind on every reattach, not only after an executor rebuild. A bind that
        // failed transiently while the executor was alive (activity briefly
        // unavailable, another camera instance still mid-release) left this view
        // with no camera and nothing ever retried — the preview froze and face
        // events stopped until the app was restarted. createCamera() is an
        // unbind-then-bind, so an extra call on a healthy camera is harmless.
        if (cameraProvider != null || shouldDetectFaces) {
            post { createCamera() }
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        cameraExecutor.shutdown()
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int
    ) {
        val width = right - left
        val height = bottom - top

        previewView.layout(0, 0, width, height)
        faceOverlayView.layout(0, 0, width, height)
        postInvalidate(left, top, right, bottom)
    }

    override fun onViewAdded(child: View) {
        if (previewView === child) {
            return
        }

        removeView(previewView)
        addView(previewView, 0)
    }

    fun takePicture(options: PictureOptions, promise: Promise, cacheDirectory: File) {
        imageCaptureUseCase?.takePicture(
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    val data = image.planes.toByteArray()

                    if (options.fastMode) {
                        promise.resolve(null)
                    }
                    cacheDirectory.let {
                        scope.launch {
                            ResolveTakenPicture(data, promise, options, it) { response: Bundle ->
                                onPictureSaved(response)
                            }.resolve()
                        }
                    }
                    image.close()
                }

                override fun onError(exception: ImageCaptureException) {
                    promise.reject(CameraExceptions.ImageCaptureFailed())
                }
            }
        )
    }

    /**
     * Freezes exactly what PreviewView is displaying. Unlike ImageCapture this
     * does not wait for a new sensor frame or JPEG pipeline, so review UI can
     * replace the live preview immediately.
     */
    fun freezePreview(promise: Promise, cacheDirectory: File) {
        val bitmap = previewView.bitmap
        if (bitmap == null) {
            promise.reject("E_PREVIEW_FRAME_UNAVAILABLE", "The camera preview is not ready yet.", null)
            return
        }

        scope.launch(Dispatchers.IO) {
            try {
                val directory = File(cacheDirectory, "PreviewFrames").apply { mkdirs() }
                val file = File.createTempFile("enroll-freeze-", ".jpg", directory)
                FileOutputStream(file).use { output ->
                    check(bitmap.compress(Bitmap.CompressFormat.JPEG, 94, output)) {
                        "Unable to encode the camera preview."
                    }
                }
                promise.resolve(Bundle().apply {
                    putString("uri", Uri.fromFile(file).toString())
                    putInt("width", bitmap.width)
                    putInt("height", bitmap.height)
                })
            } catch (error: Exception) {
                promise.reject("E_PREVIEW_FREEZE_FAILED", "Unable to freeze the camera preview.", error)
            } finally {
                bitmap.recycle()
            }
        }
    }
    @SuppressLint("UnsafeOptInUsageError")
    private fun createCamera() {
        Log.d("FaceDetector", "creating camera")
        providerFuture.addListener(
            {
                val cameraProvider: ProcessCameraProvider = providerFuture.get()
                updateTargetRotation()

                Log.d("FaceDetector", "building preview")
                val preview = Preview.Builder()
                    .setTargetRotation(targetRotation)
                    .build()
                    .also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }
                Log.d("FaceDetector", "selecting camera")
                val cameraSelector = CameraSelector.Builder()
                    .requireLensFacing(lenFacing.mapToCharacteristic())
                    .build()

                imageCaptureUseCase = ImageCapture.Builder()
                    .setTargetRotation(targetRotation)
                    .build()
                imageAnalysisUseCase = createImageAnalyzer(lenFacing == CameraType.FRONT, targetRotation)

                Log.d("FaceDetector", "applying useCases")
                val useCases = UseCaseGroup.Builder().apply {
                    addUseCase(preview)
                    imageCaptureUseCase?.let { addUseCase(it) }
                    imageAnalysisUseCase?.let { addUseCase(it) }
                }.build()

                try {
                    cameraProvider.unbindAll()
                    camera = cameraProvider.bindToLifecycle(
                        currentActivity,
                        cameraSelector,
                        useCases
                    )
                    camera?.let {
                        observeCameraState(it.cameraInfo)
                    }
                    this.cameraProvider = cameraProvider
                } catch (e: Exception) {
                    onMountError(
                        CameraMountErrorEvent("Camera component could not be rendered - is there any other instance running?")
                    )
                }
            },
            ContextCompat.getMainExecutor(context)
        )
    }

    private fun createImageAnalyzer(mirrorFaces: Boolean, targetRotation: Int): ImageAnalysis =
        ImageAnalysis.Builder()
            .setTargetRotation(targetRotation)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            android.util.Size(640, 480),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                        )
                    )
                    .build()
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
            .also { analyzer ->
                Log.d("FaceDetector", "analyzer creating")
                analyzer.setAnalyzer(
                    cameraExecutor,
                    FaceDetector(faceDetectorSettings, mirrorFaces, context, cameraExecutor, faceOverlayView) { faces, frameBrightness, brightPixelRatio ->
                        post {
                            onFacesDetected(faces, frameBrightness, brightPixelRatio)
                        }
                    }
                )
            }

    private fun observeCameraState(cameraInfo: CameraInfo) {
        cameraInfo.cameraState.observe(currentActivity) {
            when (it.type) {
                CameraState.Type.OPEN -> {
                    onCameraReady(Unit)
                }

                else -> {}
            }
        }
    }

    fun setShouldDetectFaces(shouldDetectFaces: Boolean) {
        if (this.shouldDetectFaces == shouldDetectFaces) {
            return
        }

        this.shouldDetectFaces = shouldDetectFaces
        if (shouldDetectFaces) {
            createCamera()
        }
    }

    fun setFaceDetectorSettings(settings: Map<String, Any>) {
        faceDetectorSettings.setSettings(settings)
        faceOverlayView.isOverlayEnabled = faceDetectorSettings.showNativeOverlay
        faceOverlayView.isSmooth = faceDetectorSettings.smoothNativeOverlay
    }

    fun releaseCamera() {
        appContext.mainQueue.launch {
            cameraProvider?.unbindAll()
        }
    }

    private fun onFacesDetected(
        faces: List<Bundle>,
        frameBrightness: Double,
        brightPixelRatio: Double
    ) {
        Log.d("FaceDetector", "onFacesDetected private fun call")
        if (shouldDetectFaces) {
            Log.d("FaceDetector", "onFacesDetected event dispatcher call")
            onFacesDetected(
                FacesDetectedEvent(
                    faces,
                    id,
                    frameBrightness,
                    brightPixelRatio
                )
            )
        }
    }

    override fun setPreviewTexture(
        surfaceTexture: SurfaceTexture?
    ) = Unit

    override fun getPreviewSizeAsArray() = intArrayOf(
        previewView.width,
        previewView.height
    )

    init {
        // Install a global safety handler to catch DuplicateTaskCompletionException
        // thrown on ML Kit's own internal MlKitThreadPool threads (not our executor).
        installMlKitSafetyHandler()

        previewView.setOnHierarchyChangeListener(object : OnHierarchyChangeListener {
            override fun onChildViewRemoved(parent: View?, child: View?) = Unit
            override fun onChildViewAdded(parent: View?, child: View?) {
                parent?.measure(
                    MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY)
                )
                parent?.layout(0, 0, parent.measuredWidth, parent.measuredHeight)
            }
        })
        addView(previewView)
        addView(faceOverlayView)
    }

    companion object {
        @Volatile
        private var safetyHandlerInstalled = false

        @Synchronized
        private fun installMlKitSafetyHandler() {
            if (safetyHandlerInstalled) return
            safetyHandlerInstalled = true

            val original = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                // Check if this is the known ML Kit race condition crash
                val isDuplicateTask = throwable is com.google.android.gms.tasks.DuplicateTaskCompletionException ||
                    throwable.cause is com.google.android.gms.tasks.DuplicateTaskCompletionException ||
                    throwable.message?.contains("DuplicateTaskCompletion") == true

                if (isDuplicateTask) {
                    // Safely suppress — this is a benign ML Kit internal race condition
                    // when a FaceDetector instance is garbage collected while its
                    // MlKitThreadPool worker is completing a task.
                    Log.w("CameraView", "Suppressed ML Kit DuplicateTaskCompletionException on thread: ${thread.name}")
                } else {
                    // Delegate everything else to the original handler (React Native crash reporter)
                    original?.uncaughtException(thread, throwable)
                }
            }
        }
    }

    fun onPictureSaved(response: Bundle) {
        onPictureSaved(
            PictureSavedEvent(
                response.getInt("id"),
                response.getBundle("data")!!
            )
        )
    }

    fun cancelCoroutineScope() {
        try {
            scope.cancel(ModuleDestroyedException())
        } catch (e: Exception) {
            Log.e(CameraModule.TAG, "The scope does not have a job in it")
        }
    }
}
