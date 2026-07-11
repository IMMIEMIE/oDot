package dev.odot.bridge

import com.google.gson.Gson
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

data class BridgeConfig(
    val host: String,
    val port: Int,
    val token: String,
    val executablePath: String?,
)

/** Reads and validates ~/.odot/bridge.json. Mirrors bridgeConfig() in the VS Code extension. */
object BridgeDiscovery {
    private val gson = Gson()

    private fun homeDir(): Path = Paths.get(System.getProperty("user.home"))

    fun discoveryPath(): Path = homeDir().resolve(".odot").resolve("bridge.json")

    private fun manualShutdownPath(): Path = homeDir().resolve(".odot").resolve("manual-shutdown.json")

    /** @throws java.nio.file.NoSuchFileException when oDot has never run,
     *  IllegalStateException when the file is present but incompatible. */
    fun read(): BridgeConfig {
        val path = discoveryPath()
        val raw = Files.readString(path)
        val file = gson.fromJson(raw, BridgeDiscoveryFile::class.java)
            ?: throw IllegalStateException("Empty oDot bridge discovery file: $path")
        val token = file.token
        if (file.protocolVersion != BridgeProtocol.PROTOCOL_VERSION ||
            file.host != BridgeProtocol.HOST ||
            file.port <= 0 ||
            token.isNullOrBlank()
        ) {
            throw IllegalStateException("Invalid or incompatible oDot bridge discovery file: $path")
        }
        return BridgeConfig(
            host = file.host!!,
            port = file.port,
            token = token,
            executablePath = file.executablePath?.takeIf { it.isNotBlank() },
        )
    }

    fun manualShutdownExists(): Boolean = Files.exists(manualShutdownPath())

    fun clearManualShutdown() {
        try {
            Files.deleteIfExists(manualShutdownPath())
        } catch (_: Exception) {
            // Best effort; oDot recreates/removes this marker itself.
        }
    }
}
