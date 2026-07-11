package dev.odot.bridge

import com.google.gson.Gson
import java.net.ConnectException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Duration

/** Thrown when the bridge cannot be reached. [wakeable] mirrors the VS Code
 *  shouldWakeODot() rule: only connection-refused / host-unreachable style
 *  failures should trigger a wake, not plain timeouts. */
class BridgeUnreachableException(val wakeable: Boolean, cause: Throwable) : RuntimeException(cause)

data class BridgeResponse(val statusCode: Int, val body: String)

object BridgeHttp {
    private val gson = Gson()

    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .version(HttpClient.Version.HTTP_1_1)
        .build()

    fun get(config: BridgeConfig, path: String, timeoutMs: Long): BridgeResponse =
        send(config, "GET", path, null, timeoutMs)

    fun post(config: BridgeConfig, path: String, body: Any, timeoutMs: Long): BridgeResponse =
        send(config, "POST", path, gson.toJson(body), timeoutMs)

    private fun send(
        config: BridgeConfig,
        method: String,
        path: String,
        json: String?,
        timeoutMs: Long,
    ): BridgeResponse {
        val builder = HttpRequest.newBuilder()
            .uri(URI.create("http://${config.host}:${config.port}$path"))
            .timeout(Duration.ofMillis(timeoutMs.coerceAtLeast(500)))
            .header("Accept", "application/json")
            .header("Authorization", "Bearer ${config.token}")
        if (json != null) {
            builder.header("Content-Type", "application/json; charset=utf-8")
                .method(method, HttpRequest.BodyPublishers.ofString(json))
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody())
        }
        try {
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            return BridgeResponse(response.statusCode(), response.body())
        } catch (e: HttpTimeoutException) {
            throw BridgeUnreachableException(wakeable = false, cause = e)
        } catch (e: ConnectException) {
            throw BridgeUnreachableException(wakeable = true, cause = e)
        } catch (e: java.io.IOException) {
            throw BridgeUnreachableException(wakeable = true, cause = e)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw BridgeUnreachableException(wakeable = false, cause = e)
        }
    }
}
