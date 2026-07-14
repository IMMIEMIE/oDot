package dev.odot.bridge

import com.intellij.openapi.options.Configurable
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.SpinnerNumberModel

/** Settings ▸ Tools ▸ oDot Bridge. Mirrors the VS Code extension's configuration block.
 *  The send shortcut is NOT configured here — it lives in the native Settings ▸ Keymap
 *  (search "oDot"), reachable via the "oDot: Configure Send Shortcut" action. */
class BridgeConfigurable : Configurable {
    private var timeoutSpinner: JSpinner? = null
    private var payloadSpinner: JSpinner? = null

    override fun getDisplayName(): String = "oDot Bridge"

    override fun createComponent(): JComponent {
        val state = BridgeSettings.getInstance().state
        val timeout = JSpinner(SpinnerNumberModel(state.timeoutMs, 500, 60_000, 500)).also { timeoutSpinner = it }
        val payload = JSpinner(SpinnerNumberModel(state.maxPayloadBytes, 16_384, 1_200_000, 1_000)).also { payloadSpinner = it }
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Bridge HTTP timeout (ms):", timeout)
            .addLabeledComponent("Max reference payload (bytes):", payload)
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean {
        val state = BridgeSettings.getInstance().state
        return spinnerInt(timeoutSpinner) != state.timeoutMs ||
            spinnerInt(payloadSpinner) != state.maxPayloadBytes
    }

    override fun apply() {
        val state = BridgeSettings.getInstance().state
        state.timeoutMs = spinnerInt(timeoutSpinner)
        state.maxPayloadBytes = spinnerInt(payloadSpinner)
    }

    override fun reset() {
        val state = BridgeSettings.getInstance().state
        timeoutSpinner?.value = state.timeoutMs
        payloadSpinner?.value = state.maxPayloadBytes
    }

    override fun disposeUIResources() {
        timeoutSpinner = null
        payloadSpinner = null
    }

    private fun spinnerInt(spinner: JSpinner?): Int = (spinner?.value as? Number)?.toInt() ?: 0
}
