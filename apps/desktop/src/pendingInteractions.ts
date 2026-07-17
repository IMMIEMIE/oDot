import type {
  AgentMode,
  EventRecord,
  PendingInteraction,
  QuestionItem,
  QuestionSet
} from "./api";

export function parsePendingInteraction(event: EventRecord): PendingInteraction {
  const pending = asRecord(event.data.pending);
  const name = normalizeToolName(valueAsString(event.data.name));
  const kind = valueAsString(pending.kind);

  if (kind === "question" || name === "question") {
    return { kind: "question", questionSet: parseQuestionSet(pending) };
  }
  if (kind === "mode_change" || name === "request_mode" || name === "plan_exit") {
    return {
      kind: "mode_change",
      modeChange: {
        version: 1,
        kind: "mode_change",
        fromMode: agentMode(pending.fromMode, name === "plan_exit" ? "plan" : "ask"),
        targetMode: agentMode(pending.targetMode, "agent"),
        reason: valueAsString(pending.reason),
        planPath: valueAsString(pending.planPath) || null
      }
    };
  }
  return { kind: "approval" };
}

export function questionItemIsAnswered(
  question: QuestionItem,
  selectedOptions: string[],
  customText: string
) {
  const selected = selectedOptions.filter((option) =>
    question.options.some((candidate) => candidate.label === option)
  );
  return (question.multiple || selected.length <= 1) &&
    (selected.length > 0 || customText.trim().length > 0);
}

export function approvalCommandIsLong(command: string) {
  return command.length > 600 || command.split(/\r\n|\r|\n/).length > 8;
}

function parseQuestionSet(pending: Record<string, unknown>): QuestionSet {
  const parsed = Array.isArray(pending.questions)
    ? pending.questions.map(parseQuestionItem).filter((item): item is QuestionItem => Boolean(item))
    : [];
  if (parsed.length) {
    return {
      version: 1,
      kind: "question",
      questions: parsed.slice(0, 3),
      legacy: pending.legacy === true
    };
  }
  const legacyQuestion = valueAsString(pending.question) || valueAsString(pending.command);
  return {
    version: 1,
    kind: "question",
    legacy: true,
    questions: [{
      id: "question_1",
      header: "",
      question: legacyQuestion,
      multiple: false,
      options: [],
      allowCustom: true
    }]
  };
}

function parseQuestionItem(value: unknown): QuestionItem | null {
  const item = asRecord(value);
  const id = valueAsString(item.id);
  const question = valueAsString(item.question);
  if (!id || !question) {
    return null;
  }
  const options = Array.isArray(item.options)
    ? item.options
        .map((option) => {
          const record = asRecord(option);
          const label = valueAsString(record.label);
          return label ? { label, description: valueAsString(record.description) } : null;
        })
        .filter((option): option is { label: string; description: string } => Boolean(option))
    : [];
  return {
    id,
    header: valueAsString(item.header),
    question,
    multiple: item.multiple === true,
    options,
    allowCustom: true
  };
}

function normalizeToolName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "planexit") return "plan_exit";
  if (normalized === "requestmode") return "request_mode";
  return normalized;
}

function agentMode(value: unknown, fallback: AgentMode): AgentMode {
  return value === "ask" || value === "plan" || value === "agent" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown) {
  return typeof value === "string" ? value : "";
}
