package dev.odot.bridge

import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.wm.IdeFrame

/** Feeds IDE window focus in/out into the focused project's sync service, so oDot's monitor
 *  shows the focused badge and republishes the workspace on focus. */
class AppFocusListener : ApplicationActivationListener {
    override fun applicationActivated(ideFrame: IdeFrame) = update(ideFrame, focused = true)

    override fun applicationDeactivated(ideFrame: IdeFrame) = update(ideFrame, focused = false)

    private fun update(ideFrame: IdeFrame, focused: Boolean) {
        val project = ideFrame.project ?: return
        if (project.isDisposed) return
        BridgeSyncService.getInstance(project).setFocused(focused)
    }
}
