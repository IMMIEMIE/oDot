use crate::types::{McpServerConfig, McpToolDefinition};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{timeout, Duration},
};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

pub async fn list_server_tools(
    project_root: &str,
    server: &McpServerConfig,
) -> Result<Vec<McpToolDefinition>, String> {
    if !server.enabled {
        return Ok(Vec::new());
    }
    let mut client = StdioMcpClient::start(project_root, server).await?;
    client.initialize().await?;
    let payload = client.request("tools/list", json!({})).await?;
    client.shutdown().await;
    let tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(tools
        .into_iter()
        .filter_map(|tool| tool_definition(server, &tool))
        .collect())
}

pub async fn call_tool(
    project_root: &str,
    server: &McpServerConfig,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let mut client = StdioMcpClient::start(project_root, server).await?;
    client.initialize().await?;
    let result = client
        .request(
            "tools/call",
            json!({
                "name": tool_name,
                "arguments": arguments
            }),
        )
        .await;
    client.shutdown().await;
    result
}

pub fn exposed_tool_name(server_id: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        sanitize_name(server_id),
        sanitize_name(tool_name)
    )
}

fn tool_definition(server: &McpServerConfig, tool: &Value) -> Option<McpToolDefinition> {
    let name = tool.get("name")?.as_str()?.to_string();
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let input_schema = tool
        .get("inputSchema")
        .or_else(|| tool.get("input_schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    Some(McpToolDefinition {
        server_id: server.id.clone(),
        display_name: exposed_tool_name(&server.id, &name),
        name,
        description,
        input_schema,
        require_approval: server.require_approval,
        read_only: server.read_only,
    })
}

struct StdioMcpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    timeout: Duration,
}

impl StdioMcpClient {
    async fn start(project_root: &str, server: &McpServerConfig) -> Result<Self, String> {
        let mut command = Command::new(&server.command);
        command.args(&server.args);
        command.current_dir(resolve_cwd(project_root, server.cwd.as_deref())?);
        command.envs(&server.env);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 MCP server '{}': {error}", server.id))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP server '{}' stdin 不可用", server.id))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP server '{}' stdout 不可用", server.id))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
            timeout: Duration::from_secs(server.timeout_seconds.max(1)),
        })
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "oDot", "version": "0.1.0" }
            }),
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        loop {
            let line = timeout(self.timeout, self.stdout.next_line())
                .await
                .map_err(|_| format!("MCP request '{method}' 超时"))?
                .map_err(|error| format!("读取 MCP 响应失败: {error}"))?
                .ok_or_else(|| "MCP server 已退出。".to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&line)
                .map_err(|error| format!("MCP server 返回无效 JSON: {error}: {line}"))?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(format!("MCP request '{method}' 失败: {error}"));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn write(&mut self, value: Value) -> Result<(), String> {
        let text = serde_json::to_string(&value).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|error| format!("写入 MCP stdin 失败: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("写入 MCP stdin 失败: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 MCP stdin 失败: {error}"))
    }

    async fn shutdown(&mut self) {
        let _ = self.child.kill().await;
    }
}

fn resolve_cwd(project_root: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_root);
    let cwd = cwd.unwrap_or(".");
    let path = PathBuf::from(cwd);
    let resolved = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    ensure_within_project(&root, &resolved)
}

fn ensure_within_project(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("MCP cwd 必须位于项目目录内。".to_string());
    }
    Ok(path)
}

fn sanitize_name(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            result.push(ch);
        } else {
            result.push('_');
        }
    }
    result.trim_matches('_').to_string()
}
