use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_FILES: usize = 1_000;
pub const MAX_FILE_SIZE_BYTES: u64 = 300_000;
const DIFF_CONTEXT_LINES: usize = 3;

pub fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub fn ensure_directory(root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err(format!("{} 不是目录。", root.display()));
    }
    Ok(root)
}

pub fn normalize_project_path(value: &str) -> String {
    value.replace('\\', "/").trim_start_matches('/').to_string()
}

pub fn to_project_path(value: &str) -> String {
    value.replace('\\', "/")
}

pub fn resolve_writable_inside(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_project_path(relative_path);
    if normalized.is_empty() {
        return Err("路径不能为空。".to_string());
    }

    let mut target = root.to_path_buf();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::CurDir => {}
            _ => return Err(format!("路径越过了项目根目录: {relative_path}")),
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("路径没有父目录: {relative_path}"))?;
    let parent = if parent.exists() {
        fs::canonicalize(parent).map_err(|error| error.to_string())?
    } else {
        root.to_path_buf()
    };

    if !parent.starts_with(root) {
        return Err(format!("路径越过了项目根目录: {relative_path}"));
    }

    Ok(target)
}

pub fn is_likely_text_file(path: &Path) -> Result<bool, String> {
    let content = fs::read(path).map_err(|error| error.to_string())?;
    Ok(!content.iter().take(512).any(|byte| *byte == 0))
}

pub fn ignored_directories() -> HashSet<&'static str> {
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

pub fn detect_language(path: &Path) -> String {
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
        "cpp" | "cc" | "cxx" => "C++",
        "c" => "C",
        "h" | "hpp" => "C/C++ Header",
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

pub fn create_unified_diff_preview(
    file_path: &str,
    old_content: &str,
    new_content: &str,
) -> String {
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

pub fn extract_json_object(raw_response: &str) -> Result<String, String> {
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
        .ok_or_else(|| "模型响应中没有 JSON 对象。".to_string())?;
    let last_brace = candidate
        .rfind('}')
        .ok_or_else(|| "模型响应中没有 JSON 对象。".to_string())?;

    if last_brace <= first_brace {
        return Err("模型响应中没有 JSON 对象。".to_string());
    }

    Ok(candidate[first_brace..=last_brace].to_string())
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
