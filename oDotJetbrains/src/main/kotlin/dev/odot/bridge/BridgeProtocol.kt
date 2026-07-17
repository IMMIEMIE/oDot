package dev.odot.bridge

/** Constants and payload shapes for the oDot bridge (protocol v2). Mirrors the
 *  Rust server in src-tauri/src/external_bridge.rs and the VS Code extension. */
object BridgeProtocol {
    const val PROTOCOL_VERSION = 2
    const val SOURCE = "jetbrains"
    const val HOST = "127.0.0.1"

    const val STATUS = "/v2/status"
    const val HEARTBEAT = "/v2/client/heartbeat"
    const val DISCONNECT = "/v2/client/disconnect"
    const val ACTIVATE = "/v2/workspace/activate"
    const val PROMPT_REFERENCES = "/v2/prompt-references"

    const val WAKE_URI = "odot://bridge/wake"
}

/** Shape of ~/.odot/bridge.json. */
data class BridgeDiscoveryFile(
    val protocolVersion: Int = 0,
    val host: String? = null,
    val port: Int = 0,
    val token: String? = null,
    val executablePath: String? = null,
    val pid: Long = 0,
    val startedAt: Long = 0,
)

/** Body of /v2/client/heartbeat, /v2/workspace/activate, /v2/client/disconnect. */
data class WorkspaceClientRequest(
    val protocolVersion: Int,
    val clientId: String,
    val sequence: Long,
    val focused: Boolean,
    val workspaceRoot: String?,
    val source: String? = null,
    val displayName: String? = null,
    val installationId: String? = null,
    val instanceId: String? = null,
    val reason: String? = null,
    val sentAt: Long,
)

data class PromptReferenceItem(
    val itemType: String?,
    val path: String?,
    val absolutePath: String?,
    val startLine: Int? = null,
    val endLine: Int? = null,
    val language: String? = null,
    val content: String? = null,
)

data class PromptReferencePayload(
    val workspaceRoot: String?,
    val source: String,
    val mode: String,
    val items: List<PromptReferenceItem>,
)
