use crate::types::{LoadedSkill, SkillRecord};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
};

const SKILL_FILE: &str = "SKILL.md";
const MAX_SKILL_BYTES: u64 = 256 * 1024;

pub fn list_project_skills_with_sources(
    project_root: &str,
    extra_sources: &[String],
) -> Result<Vec<SkillRecord>, String> {
    let root = PathBuf::from(project_root);
    let mut records = Vec::new();
    for skills_root in skill_source_dirs(&root, extra_sources) {
        if skills_root.exists() {
            scan_skill_dir(&root, &skills_root, &mut records)?;
        }
    }
    disambiguate_skill_names(records)
}

pub fn read_project_skill_with_sources(
    project_root: &str,
    name_or_path: &str,
    extra_sources: &[String],
) -> Result<(SkillRecord, String), String> {
    let skills = list_project_skills_with_sources(project_root, extra_sources)?;
    let query = normalize_slashes(name_or_path.trim());
    let skill = skills
        .iter()
        .find(|skill| {
            skill.name == name_or_path
                || skill.path == query
                || skill.path.trim_end_matches("/SKILL.md") == query
        })
        .cloned()
        .ok_or_else(|| format!("鏈壘鍒?Skill: {name_or_path}"))?;
    let path = ensure_skill_path(project_root, &skill.path, extra_sources)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok((skill, content))
}

pub fn skill_list_result_with_sources(project_root: &str, extra_sources: &[String]) -> Value {
    match list_project_skills_with_sources(project_root, extra_sources) {
        Ok(skills) => json!({ "skills": skills }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn skill_read_result_with_sources(
    project_root: &str,
    name_or_path: &str,
    extra_sources: &[String],
) -> Value {
    match read_project_skill_with_sources(project_root, name_or_path, extra_sources) {
        Ok((skill, content)) => json!({
            "name": skill.name,
            "description": skill.description,
            "path": skill.path,
            "content": content
        }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn import_skill_to_dir(
    project_root: &str,
    skills_root: &Path,
    source_path: &str,
) -> Result<SkillRecord, String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err(format!("Source file does not exist: {source_path}"));
    }

    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_SKILL_BYTES {
        return Err(format!(
            "Skill file is too large (max {}KB).",
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
    let target_dir = skills_root.join(&dir_name);
    let target_file = target_dir.join(SKILL_FILE);

    fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    fs::write(&target_file, &content).map_err(|error| error.to_string())?;

    let root = PathBuf::from(project_root);
    let rel = skill_record_path(&root, &target_file)?;

    Ok(SkillRecord {
        name: skill_name,
        description: metadata.get("description").cloned().unwrap_or_default(),
        path: rel,
    })
}

pub fn delete_skill_from_dir(skills_root: &Path, skill_path: &str) -> Result<(), String> {
    let normalized = normalize_slashes(skill_path.trim());
    if normalized.contains("..") {
        return Err("Skill path cannot contain '..'.".to_string());
    }
    let root = fs::canonicalize(skills_root).map_err(|error| error.to_string())?;
    let raw_path = PathBuf::from(&normalized);
    let full_path = if raw_path.is_absolute() {
        raw_path
    } else {
        root.join(&normalized)
    };
    if !full_path.exists() {
        return Err(format!("Skill file does not exist: {skill_path}"));
    }
    let canonical = fs::canonicalize(&full_path).map_err(|error| error.to_string())?;
    if canonical.file_name().and_then(|value| value.to_str()) != Some(SKILL_FILE) {
        return Err("Skill file must be named SKILL.md.".to_string());
    }
    if !canonical.starts_with(&root) {
        return Err("Skill path is outside the global skills directory.".to_string());
    }
    let skill_dir = canonical
        .parent()
        .ok_or_else(|| "Unable to resolve Skill directory.".to_string())?;
    fs::remove_dir_all(skill_dir).map_err(|error| error.to_string())
}

pub fn resolve_loaded_skills(
    project_root: &str,
    refs: &[String],
    extra_sources: &[String],
) -> Result<Vec<LoadedSkill>, String> {
    let skills = list_project_skills_with_sources(project_root, extra_sources)?;
    let mut loaded = Vec::new();
    let mut seen = HashSet::new();
    for item in refs {
        let query = normalize_slashes(item.trim());
        let Some(skill) = skills.iter().find(|skill| {
            skill.name == item.trim()
                || skill.path == query
                || skill.path.trim_end_matches("/SKILL.md") == query
        }) else {
            continue;
        };
        if seen.insert(skill.path.clone()) {
            loaded.push(LoadedSkill {
                name: skill.name.clone(),
                path: skill.path.clone(),
            });
        }
    }
    Ok(loaded)
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

pub fn loaded_skills_context_with_sources(
    project_root: &str,
    loaded: &[LoadedSkill],
    extra_sources: &[String],
) -> String {
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
        match read_project_skill_with_sources(project_root, key, extra_sources) {
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

pub fn skill_catalog_prompt_with_sources(project_root: &str, extra_sources: &[String]) -> String {
    match list_project_skills_with_sources(project_root, extra_sources) {
        Ok(skills) if !skills.is_empty() => {
            let lines = skills
                .iter()
                .map(|skill| format!("- {}: {} ({})", skill.name, skill.description, skill.path))
                .collect::<Vec<_>>()
                .join("\n");
            format!("Project skills available via skill_list/skill_read:\n{lines}")
        }
        _ => "Project skills: none found.".to_string(),
    }
}

fn skill_source_dirs(root: &Path, extra_sources: &[String]) -> Vec<PathBuf> {
    let mut dirs = vec![
        root.join(".odot").join("skills"),
        root.join(".opencode").join("skills"),
        root.join(".claude").join("skills"),
        root.join(".agents").join("skills"),
    ];
    if let Some(home) = home_dir() {
        dirs.push(home.join(".config").join("opencode").join("skills"));
        dirs.push(home.join(".claude").join("skills"));
        dirs.push(home.join(".agents").join("skills"));
    }
    dirs.extend(extra_sources.iter().filter_map(|source| {
        if source.starts_with("http://") || source.starts_with("https://") {
            return None;
        }
        let expanded = expand_home(source)?;
        let path = PathBuf::from(expanded);
        Some(if path.is_absolute() {
            path
        } else {
            root.join(path)
        })
    }));
    dedupe_paths(dirs)
}

fn home_dir() -> Option<PathBuf> {
    env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn expand_home(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "~" {
        return home_dir().map(|path| path.to_string_lossy().to_string());
    }
    trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
        .and_then(|rest| home_dir().map(|home| home.join(rest).to_string_lossy().to_string()))
        .or_else(|| Some(trimmed.to_string()))
}

fn dedupe_paths(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for dir in dirs {
        let key = normalize_slashes(&dir.to_string_lossy()).to_ascii_lowercase();
        if seen.insert(key) {
            result.push(dir);
        }
    }
    result
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
        let rel = skill_record_path(root, &path)?;
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
        result.insert(
            current_key.clone(),
            value.trim().trim_matches('"').to_string(),
        );
    }
    result
}

fn ensure_skill_path(
    project_root: &str,
    relative: &str,
    extra_sources: &[String],
) -> Result<PathBuf, String> {
    let normalized = normalize_slashes(relative);
    if normalized.contains("..") {
        return Err("Skill path cannot contain '..'.".to_string());
    }
    let root = fs::canonicalize(project_root).map_err(|error| error.to_string())?;
    let raw_path = PathBuf::from(&normalized);
    let candidate = if raw_path.is_absolute() {
        raw_path
    } else {
        root.join(&normalized)
    };
    let path = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if path.file_name().and_then(|value| value.to_str()) != Some(SKILL_FILE) {
        return Err("Skill file must be named SKILL.md.".to_string());
    }
    let allowed = skill_source_dirs(&root, extra_sources)
        .into_iter()
        .filter_map(|dir| fs::canonicalize(dir).ok())
        .any(|dir| path.starts_with(dir));
    if !allowed {
        return Err("Skill path is outside allowed skill sources.".to_string());
    }
    Ok(path)
}

fn skill_record_path(root: &Path, path: &Path) -> Result<String, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if path.starts_with(&root) {
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        return Ok(normalize_slashes(&relative.to_string_lossy()));
    }
    Ok(normalize_slashes(&path.to_string_lossy()))
}

fn normalize_slashes(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
