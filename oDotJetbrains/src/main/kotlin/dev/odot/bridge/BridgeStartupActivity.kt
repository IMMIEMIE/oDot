package dev.odot.bridge

import com.intellij.ProjectTopics
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootEvent
import com.intellij.openapi.roots.ModuleRootListener
import com.intellij.openapi.startup.ProjectActivity

/** Wires per-project listeners (active-editor + roots changes) and starts the sync service. */
class BridgeStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val service = BridgeSyncService.getInstance(project)
        val connection = project.messageBus.connect(service)

        connection.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    service.schedulePublish("editor-change")
                }
            }
        )
        connection.subscribe(
            ProjectTopics.PROJECT_ROOTS,
            object : ModuleRootListener {
                override fun rootsChanged(event: ModuleRootEvent) {
                    service.schedulePublish("folder-change", force = true)
                }
            }
        )

        service.start()
    }
}
