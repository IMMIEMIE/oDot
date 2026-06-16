import {
  Bot,
  Check,
  Code2,
  FileCode2,
  FolderOpen,
  KeyRound,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Wand2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  applyChanges,
  fetchProjectFiles,
  pickProjectDirectory,
  proposeChange,
  type ChangePlan,
  type ProjectFile,
  type ProviderConfig
} from "./api";

const DEFAULT_PROVIDER: ProviderConfig = {
  name: "OpenAI-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.2
};

type Notice = {
  tone: "info" | "success" | "error";
  text: string;
};

export function App() {
  const [provider, setProvider] = useState<ProviderConfig>(() => {
    const stored = localStorage.getItem("odot.provider");
    return stored ? { ...DEFAULT_PROVIDER, ...JSON.parse(stored) } : DEFAULT_PROVIDER;
  });
  const [projectRoot, setProjectRoot] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<ChangePlan | null>(null);
  const [notice, setNotice] = useState<Notice>({
    tone: "info",
    text: "准备连接本地项目"
  });
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isProposing, setIsProposing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    localStorage.setItem("odot.provider", JSON.stringify(provider));
  }, [provider]);

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) {
      return files;
    }
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, filter]);

  const selectedList = useMemo(
    () => Array.from(selectedPaths).sort((a, b) => a.localeCompare(b)),
    [selectedPaths]
  );

  async function chooseProjectDirectory() {
    try {
      const selected = await pickProjectDirectory();
      if (!selected) {
        return;
      }

      setProjectRoot(selected);
      await loadProjectFiles(selected);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "选择项目失败"
      });
    }
  }

  async function loadProjectFiles(rootOverride?: string) {
    const root = rootOverride ?? projectRoot;
    setIsLoadingFiles(true);
    setPlan(null);
    setSelectedPaths(new Set());

    try {
      const nextFiles = await fetchProjectFiles(root);
      setFiles(nextFiles);
      setNotice({
        tone: "success",
        text: `已读取 ${nextFiles.length} 个可编辑文件`
      });
    } catch (error) {
      setFiles([]);
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "项目读取失败"
      });
    } finally {
      setIsLoadingFiles(false);
    }
  }

  async function requestProposal() {
    setIsProposing(true);
    setPlan(null);

    try {
      const nextPlan = await proposeChange({
        root: projectRoot,
        paths: selectedList,
        instruction,
        provider
      });
      setPlan(nextPlan);
      setNotice({
        tone: "success",
        text: `生成 ${nextPlan.changes.length} 个文件修改`
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成修改失败"
      });
    } finally {
      setIsProposing(false);
    }
  }

  async function applyPlan() {
    if (!plan) {
      return;
    }

    setIsApplying(true);

    try {
      const result = await applyChanges({
        root: projectRoot,
        changes: plan.changes
      });
      setNotice({
        tone: "success",
        text: `已写入 ${result.applied.length} 个文件，备份在 ${result.backupDir}`
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "写入修改失败"
      });
    } finally {
      setIsApplying(false);
    }
  }

  function toggleSelected(path: string) {
    const next = new Set(selectedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setSelectedPaths(next);
    setPlan(null);
  }

  function resetWorkspace() {
    setFiles([]);
    setSelectedPaths(new Set());
    setFilter("");
    setPlan(null);
    setNotice({ tone: "info", text: "工作区已清空" });
  }

  const canGenerate =
    provider.baseUrl.trim() &&
    provider.model.trim() &&
    projectRoot.trim() &&
    selectedPaths.size > 0 &&
    instruction.trim() &&
    !isProposing;

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brandMark">
          <Bot size={26} />
        </div>
        <div className="brandText">
          <strong>oDot</strong>
          <span>local agent</span>
        </div>

        <div className="statusStack">
          <StatusPill
            active={Boolean(provider.model)}
            icon={<KeyRound size={15} />}
            label="模型"
          />
          <StatusPill
            active={files.length > 0}
            icon={<FolderOpen size={15} />}
            label="项目"
          />
          <StatusPill
            active={Boolean(plan)}
            icon={<Code2 size={15} />}
            label="修改"
          />
        </div>
      </aside>

      <main className="mainGrid">
        <section className="topBar">
          <div>
            <h1>代码修改工作台</h1>
            <p>{notice.text}</p>
          </div>
          <span className={`notice ${notice.tone}`}>{notice.tone}</span>
        </section>

        <section className="panel providerPanel">
          <PanelHeader icon={<KeyRound size={18} />} title="AI 服务" />
          <div className="formGrid">
            <label>
              服务名
              <input
                value={provider.name}
                onChange={(event) =>
                  setProvider({ ...provider, name: event.target.value })
                }
              />
            </label>
            <label>
              Base URL
              <input
                value={provider.baseUrl}
                onChange={(event) =>
                  setProvider({ ...provider, baseUrl: event.target.value })
                }
              />
            </label>
            <label>
              Model
              <input
                value={provider.model}
                onChange={(event) =>
                  setProvider({ ...provider, model: event.target.value })
                }
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                value={provider.apiKey}
                onChange={(event) =>
                  setProvider({ ...provider, apiKey: event.target.value })
                }
              />
            </label>
          </div>
        </section>

        <section className="panel workspacePanel">
          <PanelHeader icon={<FolderOpen size={18} />} title="项目与文件" />
          <div className="pathRow">
            <input
              value={projectRoot}
              onChange={(event) => setProjectRoot(event.target.value)}
              placeholder="E:\\your-project"
            />
            <button
              className="iconButton"
              onClick={chooseProjectDirectory}
              title="选择项目"
            >
              <FolderOpen size={18} />
            </button>
            <button
              className="iconButton"
              onClick={() => loadProjectFiles()}
              disabled={!projectRoot.trim() || isLoadingFiles}
              title="读取项目"
            >
              {isLoadingFiles ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <Search size={18} />
              )}
            </button>
            <button
              className="iconButton ghost"
              onClick={resetWorkspace}
              title="清空"
            >
              <RotateCcw size={18} />
            </button>
          </div>

          <div className="searchRow">
            <Search size={17} />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选文件"
            />
          </div>

          <div className="fileList" aria-label="Project files">
            {filteredFiles.map((file) => (
              <button
                key={file.path}
                className={`fileRow ${
                  selectedPaths.has(file.path) ? "selected" : ""
                }`}
                onClick={() => toggleSelected(file.path)}
              >
                <FileCode2 size={16} />
                <span className="filePath">{file.path}</span>
                <span className="fileMeta">{formatBytes(file.size)}</span>
              </button>
            ))}
            {files.length === 0 && (
              <div className="emptyState">等待项目路径</div>
            )}
          </div>
        </section>

        <section className="panel taskPanel">
          <PanelHeader icon={<Wand2 size={18} />} title="修改任务" />
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：把登录按钮 loading 状态补齐，并修复失败时没有恢复的问题"
          />

          <div className="taskFooter">
            <div className="selectedCount">
              <Sparkles size={16} />
              <span>{selectedPaths.size} 个文件</span>
            </div>
            <button
              className="primaryButton"
              disabled={!canGenerate}
              onClick={requestProposal}
            >
              {isProposing ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              生成修改
            </button>
          </div>

          {selectedList.length > 0 && (
            <div className="selectedFiles">
              {selectedList.map((path) => (
                <span key={path}>{path}</span>
              ))}
            </div>
          )}
        </section>

        <section className="panel diffPanel">
          <PanelHeader icon={<Code2 size={18} />} title="Diff 预览" />
          {!plan && <div className="emptyState">等待生成修改</div>}

          {plan && (
            <>
              <div className="planSummary">
                <strong>{plan.summary}</strong>
                <span>
                  {plan.provider} / {plan.model}
                </span>
              </div>

              <div className="patchStack">
                {plan.changes.map((change) => (
                  <article key={change.path} className="patchBlock">
                    <header>
                      <FileCode2 size={16} />
                      <strong>{change.path}</strong>
                    </header>
                    <pre>{change.patch}</pre>
                  </article>
                ))}
              </div>

              <button
                className="applyButton"
                onClick={applyPlan}
                disabled={isApplying}
              >
                {isApplying ? (
                  <Loader2 className="spin" size={18} />
                ) : (
                  <Check size={18} />
                )}
                写入修改
              </button>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function PanelHeader({
  icon,
  title
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="panelHeader">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function StatusPill({
  active,
  icon,
  label
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className={`statusPill ${active ? "active" : ""}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
