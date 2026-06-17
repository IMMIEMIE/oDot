use crate::{
    types::ProjectFile,
    util::{
        detect_language, ensure_directory, ignored_directories, is_likely_text_file,
        to_project_path, MAX_FILES, MAX_FILE_SIZE_BYTES,
    },
};
use std::{fs, path::PathBuf, time::UNIX_EPOCH};

pub fn list_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
    let root = ensure_directory(&root)?;
    let ignored = ignored_directories();
    let mut files = Vec::new();
    let mut stack = vec![root.clone()];

    while let Some(current) = stack.pop() {
        if files.len() >= MAX_FILES {
            break;
        }

        for entry in fs::read_dir(&current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|error| error.to_string())?;

            if metadata.is_dir() {
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    if !ignored.contains(name) {
                        stack.push(path);
                    }
                }
                continue;
            }

            push_project_file(&root, &path, metadata.len(), &mut files)?;
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn push_project_file(
    root: &PathBuf,
    path: &PathBuf,
    size: u64,
    files: &mut Vec<ProjectFile>,
) -> Result<(), String> {
    if size > MAX_FILE_SIZE_BYTES || !is_likely_text_file(path)? {
        return Ok(());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|| "0".to_string());

    files.push(ProjectFile {
        path: to_project_path(
            path.strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .as_ref(),
        ),
        size,
        modified_at,
        language: detect_language(path),
    });
    Ok(())
}
