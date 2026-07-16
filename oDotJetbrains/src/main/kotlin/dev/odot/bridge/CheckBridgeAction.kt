package dev.odot.bridge

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager

/** oDot: Check Bridge. GET /v2/status and report reachability. Mirrors checkBridge(). */
class CheckBridgeAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val settings = BridgeSettings.getInstance().state
                val config = BridgeDiscovery.read()
                val response = BridgeHttp.get(config, BridgeProtocol.STATUS, settings.timeoutMs.toLong())
                if (response.statusCode in 200..299) {
                    OdotNotifications.info(project, "oDot Bridge is reachable on ${config.host}:${config.port}.")
                } else {
                    OdotNotifications.error(project, "Bridge responded with HTTP ${response.statusCode}: ${response.body}")
                }
            } catch (ex: Exception) {
                if (WorkspaceModel.shouldWake(ex)) {
                    WakeService.wake("explicit")
                    OdotNotifications.info(project, "oDot is starting. Check the Bridge again when it opens.")
                } else {
                    OdotNotifications.error(project, "oDot: ${ex.message ?: ex.toString()}")
                }
            }
        }
    }
}
