package dev.odot.bridge

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@Service(Service.Level.APP)
@State(name = "OdotBridgeSettings", storages = [Storage("odotBridge.xml")])
class BridgeSettings : SimplePersistentStateComponent<BridgeSettings.State>(State()) {
    class State : BaseState() {
        var timeoutMs by property(5000)
        var maxPayloadBytes by property(900_000)
    }

    companion object {
        fun getInstance(): BridgeSettings = service()
    }
}
