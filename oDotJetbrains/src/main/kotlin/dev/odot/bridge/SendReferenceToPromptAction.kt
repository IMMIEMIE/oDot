package dev.odot.bridge

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager

/** oDot: Send Selection/File to Prompt. Selection -> explicit resource -> active file,
 *  mirroring sendReferenceToPrompt() in the VS Code extension. */
class SendReferenceToPromptAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val hasEditor = e.getData(CommonDataKeys.EDITOR) != null
        val hasFile = e.getData(CommonDataKeys.VIRTUAL_FILE) != null
        val hasFiles = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.isNotEmpty() == true
        e.presentation.isEnabledAndVisible = e.project != null && (hasEditor || hasFile || hasFiles)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)

        if (editor == null) {
            // No editor: treat like an explorer resource selection.
            val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList().orEmpty()
            if (files.isNotEmpty()) {
                val items = files.map { ReferenceItems.fromFile(project, it) }
                PromptReferenceSender.send(project, items, ReferenceItems.workspaceRootForItems(project, items), "resource")
                return
            }
            OdotNotifications.error(project, "No selected code, file, or folder was found.")
            return
        }

        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
            ?: FileDocumentManager.getInstance().getFile(editor.document)
        if (file == null) {
            OdotNotifications.error(project, "Only files on disk can be sent as oDot references.")
            return
        }

        val selectionItems = ReferenceItems.fromSelections(project, editor, file)
        if (selectionItems.isNotEmpty()) {
            PromptReferenceSender.send(project, selectionItems, ReferenceItems.workspaceRootForItems(project, selectionItems), "selection")
            return
        }

        val fileItem = ReferenceItems.fromFile(project, file)
        PromptReferenceSender.send(project, listOf(fileItem), ReferenceItems.workspaceRootForItems(project, listOf(fileItem)), "file")
    }
}
