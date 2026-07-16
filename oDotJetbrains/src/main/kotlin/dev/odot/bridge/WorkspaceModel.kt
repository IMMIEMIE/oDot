package dev.odot.bridge

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.roots.ProjectRootManager

/** Pure gating helpers ported from oDotVscode/src/workspaceSync.ts, plus workspace-root resolution. */
object WorkspaceModel {
    fun normalizeWorkspaceRoot(value: String): String =
        value.trim().replace('\\', '/').trimEnd('/').lowercase()

    fun shouldPublish(focused: Boolean, force: Boolean, workspaceRoot: String?, lastPublished: String): Boolean {
        if (!focused || workspaceRoot.isNullOrBlank()) return false
        return force || normalizeWorkspaceRoot(workspaceRoot) != lastPublished
    }

    fun canRestartAfterManualShutdown(reason: String): Boolean =
        reason == "explicit"

    fun shouldWake(error: Throwable): Boolean = when (error) {
        is BridgeUnreachableException -> error.wakeable
        is java.nio.file.NoSuchFileException -> true
        is java.io.FileNotFoundException -> true
        else -> false
    }

    /** Content root of the active file, else the first content root, else the project base path.
     *  Must be invoked under a read action (or on the EDT). */
    fun currentWorkspaceRoot(project: Project): String? {
        if (project.isDisposed) return null
        val editorFile = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
        if (editorFile != null) {
            val root = ProjectFileIndex.getInstance(project).getContentRootForFile(editorFile)
            if (root != null) return root.path
        }
        val firstRoot = ProjectRootManager.getInstance(project).contentRoots.firstOrNull()
        return firstRoot?.path ?: project.basePath
    }
}
