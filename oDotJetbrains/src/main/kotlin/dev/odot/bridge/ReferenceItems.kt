package dev.odot.bridge

import com.google.gson.Gson
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

/** Builds prompt-reference items from editor selections and Project View files.
 *  Read-action / EDT only (touches VFS + ProjectFileIndex). Mirrors the collect*/
object ReferenceItems {
    private val gson = Gson()

    fun fromSelections(project: Project, editor: Editor, file: VirtualFile): List<PromptReferenceItem> {
        val document = editor.document
        val carets = editor.caretModel.allCarets.filter { it.hasSelection() }
        if (carets.isEmpty()) return emptyList()
        val path = relativePath(project, file)
        val language = LanguageMapping.forFileName(file.name)
        val multi = carets.size > 1
        return carets.mapIndexed { index, caret ->
            val startLine = document.getLineNumber(caret.selectionStart) + 1
            val endOffset = caret.selectionEnd
            val endLineRaw = document.getLineNumber(endOffset)
            // Mirror VS Code: a selection ending at column 0 of a later line stops at the
            // previous line, so trailing whole-line selections don't over-count.
            val endLineStartOffset = document.getLineStartOffset(endLineRaw)
            val endLine =
                if (endOffset == endLineStartOffset && endLineRaw > startLine - 1) endLineRaw
                else endLineRaw + 1
            PromptReferenceItem(
                itemType = if (multi) "selection-${index + 1}" else "selection",
                path = path,
                absolutePath = osPath(file),
                startLine = startLine,
                endLine = endLine,
                language = language,
            )
        }
    }

    fun fromFile(project: Project, file: VirtualFile): PromptReferenceItem = PromptReferenceItem(
        itemType = if (file.isDirectory) "directory" else "file",
        path = relativePath(project, file),
        absolutePath = osPath(file),
        language = if (file.isDirectory) null else LanguageMapping.forFileName(file.name),
    )

    /** Project-relative, forward-slash path (matches the VS Code extension's relativePath). */
    fun relativePath(project: Project, file: VirtualFile): String {
        val root = ProjectFileIndex.getInstance(project).getContentRootForFile(file) ?: return file.name
        val rootPath = root.path.trimEnd('/')
        val filePath = file.path
        return if (filePath.startsWith("$rootPath/")) filePath.substring(rootPath.length + 1) else file.name
    }

    /** OS-native absolute path (backslashes on Windows), matching VS Code's uri.fsPath. */
    private fun osPath(file: VirtualFile): String = File(file.path).path

    fun workspaceRootForItems(project: Project, items: List<PromptReferenceItem>): String? {
        val fileIndex = ProjectFileIndex.getInstance(project)
        for (item in items) {
            val abs = item.absolutePath ?: continue
            val vf = LocalFileSystem.getInstance().findFileByPath(abs.replace('\\', '/')) ?: continue
            val root = fileIndex.getContentRootForFile(vf)
            if (root != null) return root.path
        }
        return WorkspaceModel.currentWorkspaceRoot(project)
    }

    fun fitToLimit(payload: PromptReferencePayload, limitBytes: Int): PromptReferencePayload {
        val items = payload.items.toMutableList()
        var current = payload.copy(items = items.toList())
        while (items.isNotEmpty() && byteSize(current) > limitBytes) {
            items.removeAt(items.size - 1)
            current = payload.copy(items = items.toList())
        }
        return current
    }

    private fun byteSize(payload: PromptReferencePayload): Int =
        gson.toJson(payload).toByteArray(Charsets.UTF_8).size
}
