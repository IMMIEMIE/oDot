package dev.odot.bridge

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Monotonic request sequence shared across all projects in this IDE instance. */
object BridgeSequence {
    private val counter = AtomicLong(0)
    fun next(): Long = counter.incrementAndGet()
}

/** Stable per-window client id (persisted in project-level PropertiesComponent) so oDot's
 *  monitor keeps a single roster row per window across IDE/plugin restarts. Mirrors the
 *  stable clientId used by the VS Code extension. */
object ClientIdentity {
    private const val KEY = "odot.bridge.clientId"

    fun clientId(project: Project): String {
        val props = PropertiesComponent.getInstance(project)
        var id = props.getValue(KEY)
        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString()
            props.setValue(KEY, id)
        }
        return id
    }
}
