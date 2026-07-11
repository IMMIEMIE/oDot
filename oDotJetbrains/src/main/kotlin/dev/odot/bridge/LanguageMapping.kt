package dev.odot.bridge

/** Extension -> language id, roughly matching the ids VS Code reports so oDot renders
 *  references consistently regardless of which IDE sent them. */
object LanguageMapping {
    private val byExt = mapOf(
        "ts" to "typescript", "tsx" to "typescriptreact",
        "js" to "javascript", "jsx" to "javascriptreact",
        "mjs" to "javascript", "cjs" to "javascript",
        "json" to "json", "css" to "css", "scss" to "scss", "less" to "less",
        "html" to "html", "htm" to "html", "md" to "markdown",
        "rs" to "rust", "go" to "go", "py" to "python",
        "java" to "java", "kt" to "kotlin", "kts" to "kotlin",
        "swift" to "swift", "cs" to "csharp",
        "cpp" to "cpp", "cc" to "cpp", "cxx" to "cpp",
        "c" to "c", "h" to "cpp", "hpp" to "cpp",
        "yaml" to "yaml", "yml" to "yaml", "toml" to "toml",
        "xml" to "xml", "sql" to "sql", "sh" to "shellscript",
        "ps1" to "powershell", "vue" to "vue", "rb" to "ruby", "php" to "php",
    )

    fun forFileName(name: String): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        return byExt[ext]
    }
}
