package dev.odot.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project

/** Sends prompt-reference items to the bridge off the EDT. The [items] and [workspaceRoot]
 *  must already be built on the EDT / under a read action by the caller. Mirrors sendItems(). */
object PromptReferenceSender {
    fun send(project: Project, items: List<PromptReferenceItem>, workspaceRoot: String?, mode: String) {
        if (items.isEmpty()) {
            OdotNotifications.error(project, "No selected code, file, or folder was found.")
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val settings = BridgeSettings.getInstance().state
                val config = BridgeDiscovery.read()
                val payload = ReferenceItems.fitToLimit(
                    PromptReferencePayload(workspaceRoot, BridgeProtocol.SOURCE, mode, items),
                    settings.maxPayloadBytes,
                )
                if (payload.items.isEmpty()) {
                    OdotNotifications.error(project, "The selected reference is empty or too large to send.")
                    return@executeOnPooledThread
                }
                val response = BridgeHttp.post(
                    config, BridgeProtocol.PROMPT_REFERENCES, payload, settings.timeoutMs.toLong()
                )
                if (response.statusCode in 200..299) {
                    val noun = if (payload.items.size == 1) "reference" else "references"
                    OdotNotifications.info(project, "Sent ${payload.items.size} oDot $noun.")
                } else {
                    OdotNotifications.error(
                        project, "Bridge responded with HTTP ${response.statusCode}: ${response.body}"
                    )
                }
            } catch (e: Exception) {
                if (WorkspaceModel.shouldWake(e)) {
                    WakeService.wake("explicit")
                    OdotNotifications.info(project, "oDot is starting. Run the send command again when it opens.")
                } else {
                    OdotNotifications.error(project, "oDot: ${e.message ?: e.toString()}")
                }
            }
        }
    }
}
