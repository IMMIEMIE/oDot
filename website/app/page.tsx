"use client";

import { useEffect, useState } from "react";

type Lang = "zh" | "en" | "ja";

const copy = {
  zh: {
    nav: ["为什么是 oDot", "安全边界", "三种模式", "开始使用"],
    github: "在 GitHub 查看",
    eyebrow: "跨 IDE · 开源 · 由你掌控",
    hero: "你的注意力，\n不该被工具切碎。",
    heroBody:
      "oDot 是一个跨 IDE 的 AI 编程助手。它以一枚轻盈的悬浮圆点陪在工作现场，让思路留在代码里，让 Agent 来到你身边。",
    start: "认识 oDot",
    openSource: "MIT 开源",
    provider: "兼容 OpenAI 格式",
    local: "本地优先",
    sceneLabel: "oDot · Agent 模式",
    scenePrompt: "把选中的逻辑拆成可测试的模块",
    sceneThinking: "正在理解上下文",
    sceneDone: "已完成 3 处安全变更",
    sceneUndo: "每一处都可以单独回退",
    whyKicker: "不是另一个需要迁就的窗口",
    whyTitle: "当工具退后一步，\n创造力才能向前一步。",
    whyBody:
      "编码最珍贵的，不是一次回答，而是那条没有被打断的思路。oDot 不占据你的编辑器，也不把你困在某一种 IDE。它安静地悬浮，需要时靠近，完成后退场。",
    featureTitle: "把选择权，留在你手里。",
    features: [
      ["跨越编辑器", "一套 Agent 工作流，连接 VS Code、JetBrains 与你的桌面；环境会变，协作方式不必重来。"],
      ["模型自由", "配置任意兼容 OpenAI 格式的模型服务。能力来自哪里，由你决定。"],
      ["改动有迹可循", "每次编辑都留下完整快照与 diff。接受、检查或一键回退，代码始终可掌控。"],
      ["命令有边界", "低风险命令可以顺畅执行，敏感操作等待你的许可。效率与安全不必二选一。"],
      ["长对话不失忆", "会话会被整理成目标、约束、进度与下一步。即使走得很远，也不会忘记为什么出发。"],
      ["专注也能并行", "把独立问题交给子 Agent。它们各自深入，再把答案带回同一段创作。"],
    ],
    safetyKicker: "SAFE BY DESIGN",
    safetyTitle: "自由探索，\n有边界地改变。",
    safetyBody:
      "Ask 只观察，Plan 只推演，Agent 才执行。oDot 把能力分层，让每一次授权都与当下的意图一致。",
    modes: [
      ["ASK", "先理解", "读取与搜索代码库，不改动任何文件。适合追问陌生项目，或在决定之前看清全貌。"],
      ["PLAN", "再推演", "在只读研究之上运行经过许可的命令，给出具体方案，但仍不触碰源文件。"],
      ["AGENT", "去完成", "在你的边界内读写文件、运行验证，把清晰的意图变成可以工作的代码。"],
    ],
    flowKicker: "ONE FLOW, EVERYWHERE",
    flowTitle: "编辑器会切换。\n你的工作流不会。",
    flowBody:
      "选中代码、唤起 oDot、继续表达。无论正在 VS Code、JetBrains，还是浏览器里追踪问题，圆点都在同一个距离。",
    steps: ["选择上下文", "把问题交给 oDot", "检查每一处改变"],
    quote: "好的工具，不是占据更多视线。\n而是让你更久地看见问题本身。",
    startKicker: "START SMALL",
    startTitle: "从一个项目，\n和一个问题开始。",
    startBody:
      "oDot 仍在成长。现在加入，你的反馈会直接影响它成为怎样的编程伙伴。",
    requirements: "需要 Node.js 18+、Rust 工具链与 Tauri 2.x 前置依赖",
    copy: "复制",
    copied: "已复制",
    join: "前往项目仓库",
    footer: "为不愿打断思路的人而做。",
    license: "MIT License · Open source",
  },
  en: {
    nav: ["Why oDot", "Safety", "Three modes", "Get started"],
    github: "View on GitHub",
    eyebrow: "IDE-agnostic · Open source · Yours to control",
    hero: "Your attention\nwas never meant to fragment.",
    heroBody:
      "oDot is an IDE-agnostic AI coding assistant. A weightless floating dot stays near the work—so your thinking remains in the code, and the agent comes to you.",
    start: "Meet oDot",
    openSource: "MIT licensed",
    provider: "OpenAI-compatible",
    local: "Local-first",
    sceneLabel: "oDot · Agent mode",
    scenePrompt: "Turn the selected logic into testable modules",
    sceneThinking: "Reading the context",
    sceneDone: "3 safe changes completed",
    sceneUndo: "Every change can be rolled back",
    whyKicker: "NOT ANOTHER WINDOW TO WORK AROUND",
    whyTitle: "When the tool steps back,\nyour thinking moves forward.",
    whyBody:
      "The most valuable part of coding is not an answer. It is the thread of thought that survives long enough to become one. oDot does not occupy your editor or lock you into an IDE. It floats close when needed, then quietly leaves the stage.",
    featureTitle: "Keep the choices in your hands.",
    features: [
      ["Across editors", "One agent workflow connects VS Code, JetBrains and your desktop. Environments change; the way you collaborate does not."],
      ["Bring your model", "Configure any OpenAI-compatible model service. You decide where the intelligence comes from."],
      ["Every edit is visible", "Each file change leaves a complete snapshot and diff. Accept it, inspect it or roll it back in one click."],
      ["Commands have boundaries", "Low-risk commands can flow; sensitive actions wait for your approval. Speed and safety stay together."],
      ["Long sessions remember", "Conversations compress into goals, constraints, progress and next steps—without losing why the work began."],
      ["Focus can run in parallel", "Hand independent questions to sub-agents. They go deep on their own, then bring the answer back to the same work."],
    ],
    safetyKicker: "SAFE BY DESIGN",
    safetyTitle: "Explore freely.\nChange deliberately.",
    safetyBody:
      "Ask observes. Plan reasons. Only Agent acts. oDot separates capability into clear layers so every permission matches your intent in the moment.",
    modes: [
      ["ASK", "Understand first", "Read and search the codebase without changing a file. Learn an unfamiliar project before deciding what comes next."],
      ["PLAN", "Think it through", "Run approved research commands and produce a concrete approach—while the source remains untouched."],
      ["AGENT", "Make it real", "Read, write and verify within your boundaries, turning a clear intention into code that works."],
    ],
    flowKicker: "ONE FLOW, EVERYWHERE",
    flowTitle: "Editors may change.\nYour workflow does not.",
    flowBody:
      "Select code, call oDot, keep speaking. Whether you are in VS Code, JetBrains or following a problem through the browser, the dot stays the same distance away.",
    steps: ["Choose the context", "Give it to oDot", "Review every change"],
    quote: "A good tool does not ask for more of your gaze.\nIt helps you keep seeing the problem itself.",
    startKicker: "START SMALL",
    startTitle: "Begin with one project\nand one honest question.",
    startBody:
      "oDot is still becoming. Join now, and your feedback can shape the kind of coding companion it grows into.",
    requirements: "Requires Node.js 18+, the Rust toolchain and Tauri 2.x prerequisites",
    copy: "Copy",
    copied: "Copied",
    join: "Go to the repository",
    footer: "Made for people who would rather not break the thread.",
    license: "MIT License · Open source",
  },
  ja: {
    nav: ["oDot という選択", "安全設計", "3つのモード", "はじめる"],
    github: "GitHub で見る",
    eyebrow: "IDEを選ばない · オープンソース · 主導権はあなたに",
    hero: "思考は、ツールに\n分断されるためにない。",
    heroBody:
      "oDot は IDE を選ばない AI コーディングアシスタント。軽やかなフローティングドットが作業のそばに留まり、思考はコードの中に、Agent はあなたのもとへ。",
    start: "oDot を知る",
    openSource: "MIT ライセンス",
    provider: "OpenAI 互換",
    local: "ローカル優先",
    sceneLabel: "oDot · Agent モード",
    scenePrompt: "選択したロジックをテスト可能なモジュールへ",
    sceneThinking: "コンテキストを理解中",
    sceneDone: "3件の安全な変更が完了",
    sceneUndo: "すべて個別に元へ戻せます",
    whyKicker: "合わせるべきウィンドウを、これ以上増やさない",
    whyTitle: "道具が一歩下がると、\n思考は一歩先へ進める。",
    whyBody:
      "コーディングで最も大切なのは、一度の回答ではありません。答えになるまで途切れずに続く思考です。oDot はエディタを占領せず、ひとつの IDE に閉じ込めません。必要な時だけそばに浮かび、終われば静かに退きます。",
    featureTitle: "選ぶ権利を、あなたの手に。",
    features: [
      ["エディタを越える", "ひとつの Agent ワークフローで VS Code、JetBrains、デスクトップをつなぎます。環境が変わっても、協働は変わりません。"],
      ["モデルを選べる", "OpenAI 互換のモデルサービスを自由に設定。知性をどこから迎えるかは、あなたが決めます。"],
      ["変更が見える", "すべての編集に完全なスナップショットと diff。確認、採用、ワンクリックでの復元ができます。"],
      ["コマンドに境界を", "低リスクな処理は滑らかに。重要な操作は承認を待つ。速さと安全を両立します。"],
      ["長い対話も忘れない", "目標、制約、進捗、次の一手へ整理。長い旅でも、出発した理由を失いません。"],
      ["集中したまま並行する", "独立した問いは子 Agent へ。それぞれが深く探り、答えを同じ仕事へ持ち帰ります。"],
    ],
    safetyKicker: "SAFE BY DESIGN",
    safetyTitle: "探索は自由に。\n変更は意志をもって。",
    safetyBody:
      "Ask は観察し、Plan は考え、Agent だけが実行する。能力を明確に分けることで、権限はいつもその瞬間の意図と一致します。",
    modes: [
      ["ASK", "まず理解する", "ファイルを変えずにコードを読み、検索します。未知のプロジェクトを理解し、次を決めるために。"],
      ["PLAN", "次に考え抜く", "承認された調査コマンドを使い、具体的な方針へ。ソースコードにはまだ触れません。"],
      ["AGENT", "そして形にする", "あなたの境界の中で読み、書き、確かめる。明確な意図を動くコードに変えます。"],
    ],
    flowKicker: "ONE FLOW, EVERYWHERE",
    flowTitle: "エディタが変わっても、\n仕事の流れは変わらない。",
    flowBody:
      "コードを選び、oDot を呼び、話し続ける。VS Code でも JetBrains でも、ブラウザで問題を追う時も、ドットはいつも同じ距離にいます。",
    steps: ["文脈を選ぶ", "oDot に託す", "変更をひとつずつ確認"],
    quote: "良い道具は、視線を奪わない。\n問題そのものを、長く見つめさせてくれる。",
    startKicker: "START SMALL",
    startTitle: "ひとつのプロジェクトと、\nひとつの問いから。",
    startBody:
      "oDot はまだ成長の途中です。今寄せる声が、どんな相棒になるかを直接形づくります。",
    requirements: "Node.js 18+、Rust ツールチェーン、Tauri 2.x の前提環境が必要です",
    copy: "コピー",
    copied: "コピー済み",
    join: "リポジトリへ",
    footer: "思考を途切れさせたくない人のために。",
    license: "MIT License · Open source",
  },
} as const;

const installCommand = "git clone https://github.com/IMMIEMIE/oDot.git\ncd oDot\nnpm install\nnpm run tauri:dev";

export default function Home() {
  const [lang, setLang] = useState<Lang>("zh");
  const [copied, setCopied] = useState(false);
  const t = copy[lang];

  useEffect(() => {
    const saved = window.localStorage.getItem("odot-language") as Lang | null;
    const browserLanguage = window.navigator.language.toLowerCase();
    const next = saved && saved in copy ? saved : browserLanguage.startsWith("ja") ? "ja" : browserLanguage.startsWith("en") ? "en" : "zh";
    setLang(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
    window.localStorage.setItem("odot-language", lang);
  }, [lang]);

  async function copyInstall() {
    await navigator.clipboard.writeText(installCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main>
      <nav className="site-nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="oDot home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>oDot</span>
        </a>
        <div className="nav-links">
          <a href="#why">{t.nav[0]}</a>
          <a href="#safety">{t.nav[1]}</a>
          <a href="#modes">{t.nav[2]}</a>
          <a href="#start">{t.nav[3]}</a>
        </div>
        <div className="nav-actions">
          <div className="language-switch" aria-label="Language">
            {(["zh", "en", "ja"] as Lang[]).map((item) => (
              <button key={item} onClick={() => setLang(item)} aria-pressed={lang === item}>
                {item === "zh" ? "中" : item === "en" ? "EN" : "日"}
              </button>
            ))}
          </div>
          <a className="nav-github" href="https://github.com/IMMIEMIE/oDot" target="_blank" rel="noreferrer">
            {t.github}<span aria-hidden="true">↗</span>
          </a>
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span />{t.eyebrow}</p>
          <h1>{t.hero.split("\n").map((line) => <span key={line}>{line}</span>)}</h1>
          <p className="hero-body">{t.heroBody}</p>
          <div className="hero-actions">
            <a className="primary-button" href="#why">{t.start}<span aria-hidden="true">↓</span></a>
            <a className="text-link" href="https://github.com/IMMIEMIE/oDot" target="_blank" rel="noreferrer">{t.github}<span aria-hidden="true">↗</span></a>
          </div>
          <div className="trust-row" aria-label="Project values">
            <span>{t.openSource}</span><i />
            <span>{t.provider}</span><i />
            <span>{t.local}</span>
          </div>
        </div>

        <div className="signal-stage" aria-label="oDot floating agent interface preview">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="signal-line line-one" />
          <div className="signal-line line-two" />
          <div className="agent-card">
            <div className="agent-card-bar">
              <span className="mini-mark"><span /></span>
              <strong>{t.sceneLabel}</strong>
              <span className="live-dot">LIVE</span>
            </div>
            <div className="prompt-row"><span className="prompt-symbol">›</span><p>{t.scenePrompt}</p></div>
            <div className="thinking-row"><span className="pulse" /><p>{t.sceneThinking}</p><span className="dots">···</span></div>
            <div className="change-preview">
              <div className="code-gutter">18<br />19<br />20<br />21</div>
              <div className="code-lines"><span /><span /><span className="added" /><span className="added short" /></div>
            </div>
            <div className="result-row">
              <span className="check">✓</span>
              <div><strong>{t.sceneDone}</strong><small>{t.sceneUndo}</small></div>
              <button aria-label="View changes">⌘</button>
            </div>
          </div>
          <div className="floating-dot" aria-hidden="true"><span /><b>o</b></div>
          <div className="context-chip chip-one"><span>ASK</span><b>Read only</b></div>
          <div className="context-chip chip-two"><span>DIFF</span><b>+24 −8</b></div>
          <p className="stage-caption">01 — STAY IN THE FLOW</p>
        </div>
      </section>

      <section className="why section-pad" id="why">
        <div className="section-label"><span>01</span><p>{t.whyKicker}</p></div>
        <div className="why-grid">
          <h2>{t.whyTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2>
          <p>{t.whyBody}</p>
        </div>
      </section>

      <section className="features section-pad">
        <div className="features-head">
          <p>CAPABILITIES / 06</p>
          <h2>{t.featureTitle}</h2>
        </div>
        <div className="feature-grid">
          {t.features.map((feature, index) => (
            <article className="feature-card" key={feature[0]}>
              <div className="feature-icon" aria-hidden="true">
                {index === 0 && <><span className="editor-a" /><span className="editor-b" /></>}
                {index === 1 && <><span className="model-ring" /><i /></>}
                {index === 2 && <><span className="diff-a" /><span className="diff-b" /><i /></>}
                {index === 3 && <><span className="shield-line" /><i /></>}
                {index === 4 && <><span className="memory-line" /><i /><b /></>}
                {index === 5 && <><span className="agent-node n1" /><span className="agent-node n2" /><span className="agent-node n3" /></>}
              </div>
              <span className="feature-number">0{index + 1}</span>
              <h3>{feature[0]}</h3>
              <p>{feature[1]}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="safety section-pad" id="safety">
        <div className="safety-intro">
          <div className="section-label light"><span>02</span><p>{t.safetyKicker}</p></div>
          <h2>{t.safetyTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2>
          <p>{t.safetyBody}</p>
        </div>
        <div className="mode-stack" id="modes">
          {t.modes.map((mode, index) => (
            <article className={`mode-card mode-${index + 1}`} key={mode[0]}>
              <div className="mode-top"><span>0{index + 1}</span><b>{mode[0]}</b></div>
              <h3>{mode[1]}</h3>
              <p>{mode[2]}</p>
              <div className="mode-permissions" aria-hidden="true">
                <span className="enabled">READ</span>
                <span className={index > 0 ? "enabled" : ""}>SHELL</span>
                <span className={index > 1 ? "enabled" : ""}>WRITE</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="flow section-pad">
        <div className="flow-copy">
          <p className="kicker">{t.flowKicker}</p>
          <h2>{t.flowTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2>
          <p>{t.flowBody}</p>
        </div>
        <div className="flow-track">
          {t.steps.map((step, index) => (
            <div className="flow-step" key={step}>
              <span>0{index + 1}</span>
              <div className={`flow-visual flow-visual-${index + 1}`} aria-hidden="true"><i /><b /><em /></div>
              <p>{step}</p>
            </div>
          ))}
          <div className="track-line" aria-hidden="true"><span /></div>
        </div>
      </section>

      <section className="manifesto section-pad">
        <div className="quote-dot" aria-hidden="true"><span /></div>
        <blockquote>{t.quote.split("\n").map((line) => <span key={line}>{line}</span>)}</blockquote>
        <p>— oDot manifesto</p>
      </section>

      <section className="get-started section-pad" id="start">
        <div className="start-copy">
          <p className="kicker">{t.startKicker}</p>
          <h2>{t.startTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2>
          <p>{t.startBody}</p>
          <small>{t.requirements}</small>
          <a className="primary-button dark" href="https://github.com/IMMIEMIE/oDot" target="_blank" rel="noreferrer">{t.join}<span aria-hidden="true">↗</span></a>
        </div>
        <div className="terminal-card">
          <div className="terminal-head"><span /><span /><span /><b>terminal</b><button onClick={copyInstall}>{copied ? t.copied : t.copy}</button></div>
          <pre><code><span className="comment"># Clone oDot</span>{"\n"}<span className="prompt">$</span> git clone https://github.com/IMMIEMIE/oDot.git{"\n"}<span className="prompt">$</span> cd oDot{"\n\n"}<span className="comment"># Install & launch</span>{"\n"}<span className="prompt">$</span> npm install{"\n"}<span className="prompt">$</span> npm run tauri:dev</code></pre>
          <div className="terminal-status"><span />oDot is ready to stay in the flow.</div>
        </div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top"><span className="brand-mark" aria-hidden="true"><span /></span><span>oDot</span></a>
        <p>{t.footer}</p>
        <div><a href="https://github.com/IMMIEMIE/oDot" target="_blank" rel="noreferrer">GitHub ↗</a><span>{t.license}</span></div>
      </footer>
    </main>
  );
}
