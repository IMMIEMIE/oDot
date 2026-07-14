package dev.odot.bridge

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.openapi.options.ShowSettingsUtil
import java.util.function.Predicate

/** Opens Settings ▸ Keymap so the user can bind, rebind, or clear the send shortcut with the
 *  IDE's native (multi-key capable) keymap editor. Search "oDot" there to find the actions. */
class ConfigureShortcutAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        ShowSettingsUtil.getInstance().showSettingsDialog(
            event.project,
            Predicate<Configurable> { it is SearchableConfigurable && it.id == KEYMAP_CONFIGURABLE_ID },
            null,
        )
    }

    private companion object {
        const val KEYMAP_CONFIGURABLE_ID = "preferences.keymap"
    }
}
