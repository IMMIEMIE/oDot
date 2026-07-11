package dev.odot.bridge

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.util.Alarm
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Per-project bridge sync: 4s heartbeat, debounced workspace-activate, wake-on-unreachable,
 *  and disconnect on close. Mirrors the background behavior of the VS Code extension. */
@Service(Service.Level.PROJECT)
class BridgeSyncService(private val project: Project) : Disposable {
    private val heartbeatIntervalMs = 4_000L
    private val publishDebounce = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)
    private val started = AtomicBoolean(false)

    @Volatile private var heartbeatTask: ScheduledFuture<*>? = null
    @Volatile private var lastPublishedRoot: String = ""
    @Volatile private var bridgeReachable = false
    @Volatile private var windowFocused = true

    private val clientId: String by lazy { ClientIdentity.clientId(project) }

    fun start() {
        if (!started.compareAndSet(false, true)) return
        heartbeatTask = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
            { pollHeartbeat() }, 0, heartbeatIntervalMs, TimeUnit.MILLISECONDS
        )
        schedulePublish("activation", force = true)
    }

    fun setFocused(focused: Boolean) {
        windowFocused = focused
        sendHeartbeatAsync()
        if (focused) schedulePublish("focus", force = true)
    }

    fun schedulePublish(reason: String, force: Boolean = false) {
        if (project.isDisposed) return
        publishDebounce.cancelAllRequests()
        publishDebounce.addRequest({ publishWorkspace(reason, force) }, 120)
    }

    private fun currentRoot(): String? = ReadAction.compute<String?, RuntimeException> {
        if (project.isDisposed) null else WorkspaceModel.currentWorkspaceRoot(project)
    }

    private fun pollHeartbeat() {
        if (project.isDisposed) return
        try {
            val response = postHeartbeat()
            val reachable = response.statusCode in 200..299
            if (reachable && !bridgeReachable) {
                bridgeReachable = true
                publishWorkspace("activation", force = true)
            } else if (!reachable) {
                bridgeReachable = false
            }
        } catch (e: Exception) {
            bridgeReachable = false
            if (WorkspaceModel.shouldWake(e)) WakeService.wake("heartbeat")
        }
    }

    private fun sendHeartbeatAsync() {
        AppExecutorUtil.getAppExecutorService().execute {
            if (project.isDisposed) return@execute
            try {
                bridgeReachable = postHeartbeat().statusCode in 200..299
            } catch (_: Exception) {
                bridgeReachable = false
            }
        }
    }

    private fun postHeartbeat(): BridgeResponse {
        val settings = BridgeSettings.getInstance().state
        val config = BridgeDiscovery.read()
        return BridgeHttp.post(config, BridgeProtocol.HEARTBEAT, heartbeatBody(), settings.timeoutMs.toLong())
    }

    private fun publishWorkspace(reason: String, force: Boolean) {
        if (project.isDisposed) return
        val root = currentRoot()
        if (!WorkspaceModel.shouldPublish(windowFocused, force, root, lastPublishedRoot)) return
        try {
            val settings = BridgeSettings.getInstance().state
            val config = BridgeDiscovery.read()
            val response = BridgeHttp.post(config, BridgeProtocol.ACTIVATE, activateBody(root, reason), settings.timeoutMs.toLong())
            if (response.statusCode in 200..299) {
                lastPublishedRoot = WorkspaceModel.normalizeWorkspaceRoot(root!!)
                bridgeReachable = true
            }
        } catch (e: Exception) {
            bridgeReachable = false
            if (WorkspaceModel.shouldWake(e)) WakeService.wake(reason)
        }
    }

    private fun heartbeatBody() = WorkspaceClientRequest(
        protocolVersion = BridgeProtocol.PROTOCOL_VERSION,
        clientId = clientId,
        sequence = BridgeSequence.next(),
        focused = windowFocused,
        workspaceRoot = currentRoot(),
        source = BridgeProtocol.SOURCE,
        sentAt = System.currentTimeMillis(),
    )

    private fun activateBody(root: String?, reason: String) = WorkspaceClientRequest(
        protocolVersion = BridgeProtocol.PROTOCOL_VERSION,
        clientId = clientId,
        sequence = BridgeSequence.next(),
        focused = windowFocused,
        workspaceRoot = root,
        source = BridgeProtocol.SOURCE,
        reason = reason,
        sentAt = System.currentTimeMillis(),
    )

    override fun dispose() {
        heartbeatTask?.cancel(false)
        heartbeatTask = null
        // Best-effort disconnect so oDot drops this window's roster row immediately.
        try {
            val config = BridgeDiscovery.read()
            BridgeHttp.post(config, BridgeProtocol.DISCONNECT, disconnectBody(), 1_200)
        } catch (_: Exception) {
            // oDot's reaper prunes us after the heartbeat timeout regardless.
        }
    }

    private fun disconnectBody() = WorkspaceClientRequest(
        protocolVersion = BridgeProtocol.PROTOCOL_VERSION,
        clientId = clientId,
        sequence = BridgeSequence.next(),
        focused = false,
        workspaceRoot = null,
        source = BridgeProtocol.SOURCE,
        sentAt = System.currentTimeMillis(),
    )

    companion object {
        fun getInstance(project: Project): BridgeSyncService = project.service()
    }
}
