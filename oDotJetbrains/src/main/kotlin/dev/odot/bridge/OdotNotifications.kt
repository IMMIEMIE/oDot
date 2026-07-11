package dev.odot.bridge

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project

object OdotNotifications {
    private const val GROUP = "oDot Bridge"

    fun info(project: Project?, content: String) = notify(project, content, NotificationType.INFORMATION)

    fun error(project: Project?, content: String) = notify(project, content, NotificationType.ERROR)

    private fun notify(project: Project?, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP)
            .createNotification(content, type)
            .notify(project)
    }
}
