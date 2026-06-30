use crate::types::{LoadedSkill, SkillRecord};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const SKILLS_DIR: &str = ".odot/skills";
const SKILL_FILE: &str = "SKILL.md";
const MAX_SKILL_BYTES: u64 = 256 * 1024;

pub fn list_project_skills(project_root: &str) -> Result<Vec<SkillRecord>, String> {
    let root = PathBuf::from(project_root);
    let skills_root = root.join(SKILLS_DIR);
    let mut records = Vec::new();
    if !skills_root.exists() {
        return Ok(records);
    }
    scan_skill_dir(&root, &skills_root, &mut records)?;
    disambiguate_skill_names(records)
}

pub fn read_project_skill(project_root: &str, name_or_path: &str) -> Result<(SkillRecord, String), String> {
    let skills = list_project_skills(project_root)?;
    let query = normalize_slashes(name_or_path.trim());
    let skill = skills
        .iter()
        .find(|skill| {
            skill.name == name_or_path
                || skill.path == query
                || skill.path.trim_end_matches("/SKILL.md") == query
        })
        .cloned()
        .ok_or_else(|| format!("未找到 Skill: {name_or_path}"))?;
    let path = ensure_skill_path(project_root, &skill.path)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok((skill, content))
}

pub fn skill_list_result(project_root: &str) -> Value {
    match list_project_skills(project_root) {
        Ok(skills) => json!({ "skills": skills }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn skill_read_result(project_root: &str, name_or_path: &str) -> Value {
    match read_project_skill(project_root, name_or_path) {
        Ok((skill, content)) => json!({
            "name": skill.name,
            "description": skill.description,
            "path": skill.path,
            "content": content
        }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn import_skill(project_root: &str, source_path: &str) -> Result<SkillRecord, String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err(format!("源文件不存在: {source_path}"));
    }

    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_SKILL_BYTES {
        return Err(format!(
            "Skill 文件过大（最大 {}KB）。",
            MAX_SKILL_BYTES / 1024
        ));
    }

    let metadata = parse_skill_metadata(&content);
    let fallback_name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("skill")
        .to_string();

    let skill_name = metadata
        .get("name")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or(fallback_name);

    let dir_name = sanitize_dir_name(&skill_name);
    let skills_root = PathBuf::from(project_root).join(SKILLS_DIR);
    let target_dir = skills_root.join(&dir_name);
    let target_file = target_dir.join(SKILL_FILE);

    fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    fs::write(&target_file, &content).map_err(|error| error.to_string())?;

    let root = PathBuf::from(project_root);
    let rel = relative_skill_path(&root, &target_file)?;

    Ok(SkillRecord {
        name: skill_name,
        description: metadata.get("description").cloned().unwrap_or_default(),
        path: rel,
    })
}

pub fn delete_skill(project_root: &str, skill_path: &str) -> Result<(), String> {
    let normalized = normalize_slashes(skill_path.trim());
    if !normalized.starts_with(".odot/skills/") || !normalized.ends_with("/SKILL.md") {
        return Err("Skill 路径必须位于 .odot/skills/**/SKILL.md。".to_string());
    }
    if normalized.contains("..") {
        return Err("Skill 路径不能包含 ..。".to_string());
    }

    let root = fs::canonicalize(project_root).map_err(|error| error.to_string())?;
    let full_path = root.join(&normalized);

    if !full_path.exists() {
        return Err(format!("Skill 文件不存在: {skill_path}"));
    }

    let canonical = fs::canonicalize(&full_path).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("Skill 路径越界。".to_string());
    }

    let skill_dir = full_path
        .parent()
        .ok_or_else(|| "无法获取 Skill 目录。".to_string())?;

    fs::remove_dir_all(skill_dir).map_err(|error| error.to_string())
}

fn sanitize_dir_name(name: &str) -> String {
    let mut result = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            result.push(ch);
        } else if ch == ' ' {
            result.push('-');
        }
    }
    let trimmed = result.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

pub fn loaded_skills_context(project_root: &str, loaded: &[LoadedSkill]) -> String {
    if loaded.is_empty() {
        return String::new();
    }
    let mut blocks = Vec::new();
    for item in loaded {
        let key = if item.path.trim().is_empty() {
            item.name.as_str()
        } else {
            item.path.as_str()
        };
        match read_project_skill(project_root, key) {
            Ok((skill, content)) => blocks.push(format!(
                "<skill name=\"{}\" path=\"{}\">\n{}\n</skill>",
                escape_attr(&skill.name),
                escape_attr(&skill.path),
                content
            )),
            Err(error) => blocks.push(format!(
                "<skill name=\"{}\" path=\"{}\" error=\"{}\" />",
                escape_attr(&item.name),
                escape_attr(&item.path),
                escape_attr(&error)
            )),
        }
    }
    format!("Loaded skills:\n{}", blocks.join("\n\n"))
}

pub fn skill_catalog_prompt(project_root: &str) -> String {
    match list_project_skills(project_root) {
        Ok(skills) if !skills.is_empty() => {
            let lines = skills
                .iter()
                .map(|skill| format!("- {}: {} ({})", skill.name, skill.description, skill.path))
                .collect::<Vec<_>>()
                .join("\n");
            format!("Project skills available via skill_list/skill_read:\n{lines}")
        }
        _ => "Project skills: none found in .odot/skills.".to_string(),
    }
}

fn scan_skill_dir(root: &Path, dir: &Path, records: &mut Vec<SkillRecord>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            scan_skill_dir(root, &path, records)?;
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) != Some(SKILL_FILE) {
            continue;
        }
        if path.metadata().map_err(|error| error.to_string())?.len() > MAX_SKILL_BYTES {
            continue;
        }
        let rel = relative_skill_path(root, &path)?;
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let metadata = parse_skill_metadata(&content);
        let fallback_name = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
            .to_string();
        records.push(SkillRecord {
            name: metadata
                .get("name")
                .filter(|value| !value.trim().is_empty())
                .cloned()
                .unwrap_or(fallback_name),
            description: metadata.get("description").cloned().unwrap_or_default(),
            path: rel,
        });
    }
    Ok(())
}

fn disambiguate_skill_names(mut records: Vec<SkillRecord>) -> Result<Vec<SkillRecord>, String> {
    let mut counts = HashMap::<String, usize>::new();
    for record in &records {
        *counts.entry(record.name.clone()).or_default() += 1;
    }
    for record in &mut records {
        if counts.get(&record.name).copied().unwrap_or(0) > 1 {
            let stem = record.path.trim_end_matches("/SKILL.md");
            record.name = format!("{} ({stem})", record.name);
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}

fn parse_skill_metadata(content: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let Some(rest) = content.strip_prefix("---") else {
        return result;
    };
    let Some(end) = rest.find("\n---") else {
        return result;
    };
    let frontmatter = &rest[..end];
    let mut current_key = String::new();
    for line in frontmatter.lines() {
        if line.starts_with(' ') && !current_key.is_empty() {
            let value = result.entry(current_key.clone()).or_default();
            if !value.is_empty() {
                value.push(' ');
            }
            value.push_str(line.trim().trim_matches('>').trim());
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        current_key = key.trim().to_string();
        result.insert(current_key.clone(), value.trim().trim_matches('"').to_string());
    }
    result
}

fn ensure_skill_path(project_root: &str, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalize_slashes(relative);
    if !normalized.starts_with(".odot/skills/") || !normalized.ends_with("/SKILL.md") {
        return Err("Skill 路径必须位于 .odot/skills/**/SKILL.md。".to_string());
    }
    if normalized.contains("..") {
        return Err("Skill 路径不能包含 ..。".to_string());
    }
    let root = fs::canonicalize(project_root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(root.join(&normalized)).map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("Skill 路径越界。".to_string());
    }
    Ok(path)
}

fn relative_skill_path(root: &Path, path: &Path) -> Result<String, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("Skill 路径越界。".to_string());
    }
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    Ok(normalize_slashes(&relative.to_string_lossy()))
}

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/").trim_start_matches("./").to_string()
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
