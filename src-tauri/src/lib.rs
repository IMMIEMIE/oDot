use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FILES: usize = 1_000;
const MAX_FILE_SIZE_BYTES: u64 = 250_000;
const DIFF_CONTEXT_LINES: usize = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    name: String,
    base_url: String,
    api_key: Option<String>,
    model: String,
    temperature: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    path: String,
    size: u64,
    modified_at: String,
    language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContent {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelFileChange {
    path: String,
    updated_content: String,
}

#[derive(Debug, Deserialize)]
struct ModelChangeResponse {
    summary: String,
    files: Vec<ModelFileChange>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposedFileChange {
    path: String,
    original_content: String,
    updated_content: String,
    patch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangePlan {
    id: String,
    summary: String,
    created_at: String,
    provider: String,
    model: String,
    changes: Vec<ProposedFileChange>,
    raw_response: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    applied: Vec<String>,
    backup_dir: String,
}

#[tauri::command]
fn list_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
    list_files(&root).map_err(to_error)
}

#[tauri::command]
async fn propose_code_change(
    root: String,
    paths: Vec<String>,
    instruction: String,
    provider: ProviderConfig,
) -> Result<ChangePlan, String> {
    let files = read_project_files(&root, &paths).map_err(to_error)?;
    propose_change(provider, instruction, files).await
}

#[tauri::command]
fn apply_file_changes(
    root: String,
    changes: Vec<ProposedFileChange>,
) -> Result<ApplyResult, String> {
    apply_changes(&root, changes).map_err(to_error)
}

fn list_files(root: &str) -> Result<Vec<ProjectFile>, Box<dyn std::error::Error>> {
    let root = ensure_directory(root)?;
    let ignored = ignored_directories();
    let mut files = Vec::new();
    let mut stack = vec![root.clone()];

    while let Some(current) = stack.pop() {
        if files.len() >= MAX_FILES {
            break;
        }

        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = entry.metadata()?;

            if metadata.is_dir() {
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    if !ignored.contains(name) {
                        stack.push(path);
                    }
                }
                continue;
            }

            if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE_BYTES {
                continue;
            }

            if !is_likely_text_file(&path)? {
                continue;
            }

            files.push(ProjectFile {
                path: to_project_path(path.strip_prefix(&root)?.to_string_lossy().as_ref()),
                size: metadata.len(),
                modified_at: system_time_string(metadata.modified()?),
                language: detect_language(&path),
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn read_project_files(
    root: &str,
    relative_paths: &[String],
) -> Result<Vec<FileContent>, Box<dyn std::error::Error>> {
    if relative_paths.is_empty() {
        return Err("Select at least one file before asking for a code change.".into());
    }

    let root = ensure_directory(root)?;
    let mut files = Vec::with_capacity(relative_paths.len());

    for relative_path in relative_paths {
        let target = resolve_inside_project(&root, relative_path)?;
        let content = fs::read_to_string(target)?;
        files.push(FileContent {
            path: normalize_project_path(relative_path),
            content,
        });
    }

    Ok(files)
}

async fn propose_change(
    provider: ProviderConfig,
    instruction: String,
    files: Vec<FileContent>,
) -> Result<ChangePlan, String> {
    if files.is_empty() {
        return Err("Select at least one file before asking for a code change.".to_string());
    }

    let raw_response = call_openai_compatible_provider(&provider, &instruction, &files).await?;
    let parsed = parse_model_response(&raw_response)?;
    let changes = build_proposed_changes(&files, parsed.files)?;

    if changes.is_empty() {
        return Err("The model did not return any file changes.".to_string());
    }

    Ok(ChangePlan {
        id: format!("plan-{}", current_timestamp_millis()),
        summary: parsed.summary,
        created_at: system_time_string(SystemTime::now()),
        provider: provider.name,
        model: provider.model,
        changes,
        raw_response,
    })
}

async fn call_openai_compatible_provider(
    provider: &ProviderConfig,
    instruction: &str,
    files: &[FileContent],
) -> Result<String, String> {
    let endpoint = to_chat_completions_endpoint(&provider.base_url);
    let file_bundle = files
        .iter()
        .map(|file| {
            format!(
                "--- FILE: {}\n{}\n--- END FILE: {}",
                file.path, file.content, file.path
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let system_prompt = [
        "You are oDot, a local code editing engine.",
        "Return strict JSON only. Do not wrap it in Markdown.",
        "The JSON schema is:",
        "{\"summary\":\"short change summary\",\"files\":[{\"path\":\"relative/path\",\"updatedContent\":\"complete updated file contents\"}]}",
        "Only edit files included by the user. Preserve unrelated code and formatting.",
    ]
    .join("\n");

    let body = json!({
        "model": provider.model,
        "temperature": provider.temperature.unwrap_or(0.2),
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": format!("Task:\n{}\n\nEditable files:\n{}", instruction, file_bundle)
            }
        ]
    });

    let client = reqwest::Client::new();
    let mut request = client.post(endpoint).json(&body);

    if let Some(api_key) = provider
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {error}"))?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Provider returned invalid JSON: {error}"))?;

    if status != StatusCode::OK {
        let message = payload
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or_else(|| status.as_str());
        return Err(format!("Provider request failed: {message}"));
    }

    payload
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .map(|content| content.to_string())
        .ok_or_else(|| "Provider returned an empty response.".to_string())
}

fn parse_model_response(raw_response: &str) -> Result<ModelChangeResponse, String> {
    let json_text = extract_json_object(raw_response)?;
    serde_json::from_str(&json_text)
        .map_err(|error| format!("Model response did not match the expected JSON schema: {error}"))
}

fn build_proposed_changes(
    original_files: &[FileContent],
    model_changes: Vec<ModelFileChange>,
) -> Result<Vec<ProposedFileChange>, String> {
    let originals: HashMap<String, &FileContent> = original_files
        .iter()
        .map(|file| (normalize_project_path(&file.path), file))
        .collect();
    let mut changes = Vec::new();

    for model_change in model_changes {
        let normalized_path = normalize_project_path(&model_change.path);
        let original = originals.get(&normalized_path).ok_or_else(|| {
            format!(
                "Model tried to edit an unselected file: {}",
                model_change.path
            )
        })?;

        if original.content == model_change.updated_content {
            continue;
        }

        changes.push(ProposedFileChange {
            path: normalized_path.clone(),
            original_content: original.content.clone(),
            updated_content: model_change.updated_content.clone(),
            patch: create_unified_diff_preview(
                &normalized_path,
                &original.content,
                &model_change.updated_content,
            ),
        });
    }

    Ok(changes)
}

fn apply_changes(
    root: &str,
    changes: Vec<ProposedFileChange>,
) -> Result<ApplyResult, Box<dyn std::error::Error>> {
    if changes.is_empty() {
        return Err("No changes to apply.".into());
    }

    let root = ensure_directory(root)?;
    let backup_dir = root
        .join(".odot")
        .join("backups")
        .join(current_timestamp_millis().to_string());
    let mut pending_writes = Vec::with_capacity(changes.len());

    for change in changes {
        let target = resolve_inside_project(&root, &change.path)?;
        let current_content = fs::read_to_string(&target)?;

        if current_content != change.original_content {
            return Err(format!(
                "File changed after proposal was generated. Refresh and try again: {}",
                change.path
            )
            .into());
        }

        pending_writes.push((change.path, target, current_content, change.updated_content));
    }

    for (relative_path, _, current_content, _) in &pending_writes {
        let backup_path =
            backup_dir.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = backup_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(backup_path, current_content)?;
    }

    for (_, target, _, updated_content) in &pending_writes {
        fs::write(target, updated_content)?;
    }

    Ok(ApplyResult {
        applied: pending_writes
            .into_iter()
            .map(|(relative_path, _, _, _)| relative_path)
            .collect(),
        backup_dir: backup_dir.to_string_lossy().to_string(),
    })
}

fn ensure_directory(root: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory.", root.display()).into());
    }
    Ok(root)
}

fn resolve_inside_project(
    root: &Path,
    relative_path: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let target = root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let target = fs::canonicalize(target)?;

    if !target.starts_with(root) {
        return Err(format!("Path escapes project root: {relative_path}").into());
    }

    Ok(target)
}

fn is_likely_text_file(path: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    let content = fs::read(path)?;
    Ok(!content.iter().take(512).any(|byte| *byte == 0))
}

fn ignored_directories() -> HashSet<&'static str> {
    [
        ".git",
        ".hg",
        ".svn",
        ".idea",
        ".vscode",
        ".odot",
        "node_modules",
        "dist",
        "build",
        "coverage",
        ".next",
        ".nuxt",
        ".svelte-kit",
        "target",
        "out",
        ".turbo",
        ".cache",
    ]
    .into_iter()
    .collect()
}

fn detect_language(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "ts" => "TypeScript",
        "tsx" => "TypeScript React",
        "js" | "mjs" | "cjs" => "JavaScript",
        "jsx" => "JavaScript React",
        "json" => "JSON",
        "css" => "CSS",
        "scss" => "SCSS",
        "html" => "HTML",
        "md" => "Markdown",
        "rs" => "Rust",
        "go" => "Go",
        "py" => "Python",
        "java" => "Java",
        "kt" => "Kotlin",
        "swift" => "Swift",
        "cs" => "C#",
        "cpp" => "C++",
        "c" => "C",
        "h" => "C/C++ Header",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "xml" => "XML",
        "sql" => "SQL",
        "sh" => "Shell",
        "ps1" => "PowerShell",
        _ => "Text",
    }
    .to_string()
}

fn create_unified_diff_preview(file_path: &str, old_content: &str, new_content: &str) -> String {
    let old_lines = split_lines(old_content);
    let new_lines = split_lines(new_content);

    let mut prefix_length = 0;
    while prefix_length < old_lines.len()
        && prefix_length < new_lines.len()
        && old_lines[prefix_length] == new_lines[prefix_length]
    {
        prefix_length += 1;
    }

    let mut suffix_length = 0;
    while suffix_length < old_lines.len().saturating_sub(prefix_length)
        && suffix_length < new_lines.len().saturating_sub(prefix_length)
        && old_lines[old_lines.len() - 1 - suffix_length]
            == new_lines[new_lines.len() - 1 - suffix_length]
    {
        suffix_length += 1;
    }

    let old_change_end = old_lines.len().saturating_sub(suffix_length);
    let new_change_end = new_lines.len().saturating_sub(suffix_length);
    let old_start = prefix_length.saturating_sub(DIFF_CONTEXT_LINES);
    let new_start = prefix_length.saturating_sub(DIFF_CONTEXT_LINES);
    let old_end = old_lines.len().min(old_change_end + DIFF_CONTEXT_LINES);
    let new_end = new_lines.len().min(new_change_end + DIFF_CONTEXT_LINES);
    let mut lines = vec![
        format!("--- a/{file_path}"),
        format!("+++ b/{file_path}"),
        format!(
            "@@ -{},{} +{},{} @@",
            old_start + 1,
            old_end.saturating_sub(old_start),
            new_start + 1,
            new_end.saturating_sub(new_start)
        ),
    ];

    for line in old_lines.iter().take(prefix_length).skip(old_start) {
        lines.push(format!(" {line}"));
    }
    for line in old_lines.iter().take(old_change_end).skip(prefix_length) {
        lines.push(format!("-{line}"));
    }
    for line in new_lines.iter().take(new_change_end).skip(prefix_length) {
        lines.push(format!("+{line}"));
    }

    let shared_suffix_start = old_lines.len().saturating_sub(suffix_length);
    for line in old_lines.iter().take(old_end).skip(shared_suffix_start) {
        lines.push(format!(" {line}"));
    }

    format!("{}\n", lines.join("\n"))
}

fn split_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return vec![String::new()];
    }
    content
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.to_string())
        .collect()
}

fn extract_json_object(raw_response: &str) -> Result<String, String> {
    let trimmed = raw_response.trim();
    let candidate = if trimmed.starts_with("```") && trimmed.ends_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    let first_brace = candidate
        .find('{')
        .ok_or_else(|| "Model response did not contain a JSON object.".to_string())?;
    let last_brace = candidate
        .rfind('}')
        .ok_or_else(|| "Model response did not contain a JSON object.".to_string())?;

    if last_brace <= first_brace {
        return Err("Model response did not contain a JSON object.".to_string());
    }

    Ok(candidate[first_brace..=last_brace].to_string())
}

fn to_chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn normalize_project_path(value: &str) -> String {
    value.replace('\\', "/").trim_start_matches('/').to_string()
}

fn to_project_path(value: &str) -> String {
    value.replace('\\', "/")
}

fn system_time_string(value: SystemTime) -> String {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn current_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn to_error(error: Box<dyn std::error::Error>) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_project_files,
            propose_code_change,
            apply_file_changes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
