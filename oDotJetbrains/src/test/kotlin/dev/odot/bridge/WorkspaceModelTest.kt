package dev.odot.bridge

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Ports the gating tests from oDotVscode/src/workspaceSync.test.ts. */
class WorkspaceModelTest {
    @Test
    fun normalizesWorkspaceRoot() {
        assertEquals("c:/work/demo", WorkspaceModel.normalizeWorkspaceRoot("C:\\Work\\Demo\\"))
        assertEquals("/work/demo", WorkspaceModel.normalizeWorkspaceRoot("/work/demo/"))
    }

    @Test
    fun publishGating() {
        assertFalse(WorkspaceModel.shouldPublish(focused = false, force = false, workspaceRoot = "C:/a", lastPublished = ""))
        assertFalse(WorkspaceModel.shouldPublish(focused = true, force = false, workspaceRoot = "", lastPublished = ""))
        assertTrue(WorkspaceModel.shouldPublish(focused = true, force = false, workspaceRoot = "C:/a", lastPublished = "c:/b"))
        assertFalse(WorkspaceModel.shouldPublish(focused = true, force = false, workspaceRoot = "C:/a", lastPublished = "c:/a"))
        assertTrue(WorkspaceModel.shouldPublish(focused = true, force = true, workspaceRoot = "C:/a", lastPublished = "c:/a"))
    }

    @Test
    fun restartReasons() {
        assertTrue(WorkspaceModel.canRestartAfterManualShutdown("activation"))
        assertTrue(WorkspaceModel.canRestartAfterManualShutdown("editor-change"))
        assertTrue(WorkspaceModel.canRestartAfterManualShutdown("folder-change"))
        assertTrue(WorkspaceModel.canRestartAfterManualShutdown("explicit"))
        assertFalse(WorkspaceModel.canRestartAfterManualShutdown("heartbeat"))
        assertFalse(WorkspaceModel.canRestartAfterManualShutdown("focus"))
    }

    @Test
    fun wakeClassification() {
        assertTrue(WorkspaceModel.shouldWake(BridgeUnreachableException(wakeable = true, RuntimeException())))
        assertFalse(WorkspaceModel.shouldWake(BridgeUnreachableException(wakeable = false, RuntimeException())))
        assertTrue(WorkspaceModel.shouldWake(java.io.FileNotFoundException("x")))
        assertFalse(WorkspaceModel.shouldWake(RuntimeException("x")))
    }
}
