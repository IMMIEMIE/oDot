package dev.odot.bridge

import com.intellij.ide.util.PropertiesComponent
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Monotonic request sequence shared across all projects in this IDE instance. */
object BridgeSequence {
    private val counter = AtomicLong(0)
    fun next(): Long = counter.incrementAndGet()
}

/** Stable installation identity plus a distinct id for every live project/window service. */
object ClientIdentity {
    private const val INSTALLATION_KEY = "odot.bridge.installationId"

    fun installationId(): String {
        val props = PropertiesComponent.getInstance()
        var id = props.getValue(INSTALLATION_KEY)
        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString()
            props.setValue(INSTALLATION_KEY, id)
        }
        return id
    }

    fun newInstanceId(): String = UUID.randomUUID().toString()

    fun clientId(instanceId: String): String = "jetbrains:$instanceId"
}
