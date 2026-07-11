package dev.odot.bridge

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

/** oDot: Send File/Folder to Prompt (Project View context). Mirrors sendResourceToPrompt(). */
class SendResourceToPromptAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val hasFiles = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.isNotEmpty() == true
        e.presentation.isEnabledAndVisible = e.project != null && hasFiles
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList().orEmpty()
        if (files.isEmpty()) {
            OdotNotifications.error(project, "No selected file or folder was found.")
            return
        }
        val items = files.map { ReferenceItems.fromFile(project, it) }
        PromptReferenceSender.send(project, items, ReferenceItems.workspaceRootForItems(project, items), "resource")
    }
}
