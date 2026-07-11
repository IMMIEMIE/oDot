package dev.odot.bridge

import com.intellij.ide.BrowserUtil
import java.net.URI

/** Best-effort relaunch of the oDot desktop app when the bridge is unreachable.
 *  Mirrors wakeODot() in the VS Code extension: 15s throttle, honors the manual-shutdown
 *  marker, spawns the discovered executable, and falls back to the odot:// URI once. */
object WakeService {
    private const val RETRY_MS = 15_000L

    @Volatile private var lastAttempt = 0L
    @Volatile private var fallbackAttempted = false

    @Synchronized
    fun wake(reason: String) {
        val now = System.currentTimeMillis()
        if (now - lastAttempt < RETRY_MS) return
        lastAttempt = now

        val manuallyStopped = BridgeDiscovery.manualShutdownExists()
        if (manuallyStopped && !WorkspaceModel.canRestartAfterManualShutdown(reason)) return
        if (manuallyStopped) BridgeDiscovery.clearManualShutdown()

        val exe = runCatching { BridgeDiscovery.read().executablePath }.getOrNull()
        if (!exe.isNullOrBlank()) {
            try {
                ProcessBuilder(exe)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start()
                return
            } catch (_: Exception) {
                // Fall through to the URI handler.
            }
        }

        if (fallbackAttempted) return
        fallbackAttempted = true
        try {
            BrowserUtil.browse(URI.create(BridgeProtocol.WAKE_URI))
        } catch (_: Exception) {
            // Nothing else we can do; the reaper on the oDot side will show us offline.
        }
    }
}
