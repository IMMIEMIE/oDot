import { Check, Maximize2, MessageSquare, Save, Settings2, Terminal, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { EventRecord, QuestionAnswer, QuestionSet } from "./api";
import {
  approvalCommandIsLong,
  parsePendingInteraction,
  questionItemIsAnswered
} from "./pendingInteractions";

type QuestionDraft = Record<string, { selectedOptions: string[]; customText: string }>;

type Props = {
  event: EventRecord;
  sourceLabel?: string;
  disabled: boolean;
  command: string;
  canAllowlist: boolean;
  onApprove: (event: EventRecord) => Promise<void>;
  onApproveAndAllow: (event: EventRecord) => Promise<void>;
  onReject: (event: EventRecord) => Promise<void>;
  onAnswer: (event: EventRecord, answers: QuestionAnswer[]) => Promise<void>;
  onResolveMode: (event: EventRecord, approved: boolean) => Promise<void>;
};

export function PendingInteractionCard(props: Props) {
  const { t } = useTranslation();
  const interaction = useMemo(() => parsePendingInteraction(props.event), [props.event]);
  const [isCommandDetailOpen, setIsCommandDetailOpen] = useState(false);
  const [isResolvingDetail, setIsResolvingDetail] = useState(false);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailDialogRef = useRef<HTMLElement | null>(null);
  const detailTitleId = useId();
  const longCommand = approvalCommandIsLong(props.command);

  useEffect(() => {
    setIsCommandDetailOpen(false);
    setIsResolvingDetail(false);
  }, [props.event.id]);

  useEffect(() => {
    if (!isCommandDetailOpen) return;
    detailDialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isResolvingDetail) closeCommandDetail();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isCommandDetailOpen, isResolvingDetail]);

  function closeCommandDetail() {
    if (isResolvingDetail) return;
    setIsCommandDetailOpen(false);
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }

  async function resolveFromDetail(action: "approve" | "allow" | "reject") {
    if (isResolvingDetail || props.disabled) return;
    setIsResolvingDetail(true);
    try {
      if (action === "approve") await props.onApprove(props.event);
      else if (action === "allow") await props.onApproveAndAllow(props.event);
      else await props.onReject(props.event);
      setIsCommandDetailOpen(false);
    } catch {
      // The parent surfaces the error. Keep the dialog open so the user can retry.
    } finally {
      setIsResolvingDetail(false);
    }
  }

  if (interaction.kind === "question") {
    return (
      <QuestionCard
        {...props}
        questionSet={interaction.questionSet}
      />
    );
  }
  if (interaction.kind === "mode_change") {
    const request = interaction.modeChange;
    return (
      <div className="inlineApprovalCard modeChangeCard">
        <header className="inlineApprovalHeader">
          <Settings2 size={14} />
          <strong>{t("interaction.modeChangeTitle")}</strong>
          <SourceTag label={props.sourceLabel} />
        </header>
        <div className="inlineApprovalBody">
          <div className="modeChangeRoute" aria-label={t("interaction.modeChangeRoute")}>
            <span>{t(`mode.${request.fromMode}`)}</span>
            <span aria-hidden="true">→</span>
            <strong>{t(`mode.${request.targetMode}`)}</strong>
          </div>
          <p className="interactionReason">
            {request.reason || t("interaction.modeChangeFallbackReason")}
          </p>
          <p className="interactionCapabilityHint">
            {t(`interaction.modeCapability.${request.targetMode}`)}
          </p>
          <div className="inlineApprovalActions">
            <button
              type="button"
              className="inlineApprovalButton primary"
              disabled={props.disabled}
              onClick={() => void props.onResolveMode(props.event, true).catch(() => undefined)}
            >
              <Check size={14} />
              {t("interaction.confirmModeChange")}
            </button>
            <button
              type="button"
              className="inlineApprovalButton danger"
              disabled={props.disabled}
              onClick={() => void props.onResolveMode(props.event, false).catch(() => undefined)}
            >
              <X size={14} />
              {t("common.reject")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="inlineApprovalCard commandApprovalCard">
        <header className="inlineApprovalHeader">
          <Terminal size={14} />
          <strong>{t("approval.commandTitle")}</strong>
          <SourceTag label={props.sourceLabel} />
        </header>
        <div className="inlineApprovalBody">
          <div className="approvalCommandPreviewFrame">
            <div className={`approvalCommandClip${longCommand ? " isLong" : ""}`}>
              <code className="approvalCommandPreview">{props.command}</code>
            </div>
            {longCommand && (
              <button
                ref={detailTriggerRef}
                type="button"
                className="approvalCommandDetailButton"
                onClick={() => setIsCommandDetailOpen(true)}
              >
                <Maximize2 size={13} />
                {t("approval.viewFullCommand")}
              </button>
            )}
          </div>
          <CommandApprovalActions
            disabled={props.disabled}
            canAllowlist={props.canAllowlist}
            onApprove={() => void props.onApprove(props.event).catch(() => undefined)}
            onAllow={() => void props.onApproveAndAllow(props.event).catch(() => undefined)}
            onReject={() => void props.onReject(props.event).catch(() => undefined)}
          />
        </div>
      </div>
      {isCommandDetailOpen &&
        createPortal(
          <div
            className="modalBackdrop approvalCommandModalBackdrop"
            role="presentation"
            onClick={closeCommandDetail}
          >
            <section
              ref={detailDialogRef}
              className="settingsModal approvalCommandModal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={detailTitleId}
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="modalHeader">
                <div>
                  <strong id={detailTitleId}>{t("approval.fullCommandTitle")}</strong>
                  <small>{t("approval.fullCommandDescription")}</small>
                </div>
                <button
                  type="button"
                  className="iconButton ghost"
                  aria-label={t("common.close")}
                  disabled={isResolvingDetail}
                  onClick={closeCommandDetail}
                >
                  <X size={16} />
                </button>
              </header>
              <div className="approvalCommandModalBody">
                <pre><code>{props.command}</code></pre>
              </div>
              <footer className="modalFooter approvalCommandModalFooter">
                <CommandApprovalActions
                  disabled={props.disabled || isResolvingDetail}
                  canAllowlist={props.canAllowlist}
                  onApprove={() => void resolveFromDetail("approve")}
                  onAllow={() => void resolveFromDetail("allow")}
                  onReject={() => void resolveFromDetail("reject")}
                />
              </footer>
            </section>
          </div>,
          document.body
        )}
    </>
  );
}

function CommandApprovalActions({
  disabled,
  canAllowlist,
  onApprove,
  onAllow,
  onReject
}: {
  disabled: boolean;
  canAllowlist: boolean;
  onApprove: () => void;
  onAllow: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="inlineApprovalActions">
      <button
        type="button"
        className="inlineApprovalButton primary"
        disabled={disabled}
        onClick={onApprove}
      >
        <Check size={14} />
        {t("common.approve")}
      </button>
      {canAllowlist && (
        <button
          type="button"
          className="inlineApprovalButton"
          disabled={disabled}
          onClick={onAllow}
        >
          <Save size={14} />
          {t("common.acceptAndAllowlist")}
        </button>
      )}
      <button
        type="button"
        className="inlineApprovalButton danger"
        disabled={disabled}
        onClick={onReject}
      >
        <X size={14} />
        {t("common.reject")}
      </button>
    </div>
  );
}

function QuestionCard(props: Props & { questionSet: QuestionSet }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<QuestionDraft>(() => initialDraft(props.event.id, props.questionSet));

  useEffect(() => {
    setDraft(initialDraft(props.event.id, props.questionSet));
  }, [props.event.id, props.questionSet]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(props.event.id), JSON.stringify(draft));
    } catch {
      // Draft persistence is best effort; the pending event itself remains durable.
    }
  }, [draft, props.event.id]);

  const valid = props.questionSet.questions.every((question) => {
    const answer = draft[question.id] ?? { selectedOptions: [], customText: "" };
    return questionItemIsAnswered(question, answer.selectedOptions, answer.customText);
  });

  async function submit() {
    if (!valid || props.disabled) return;
    const answers = props.questionSet.questions.map((question) => ({
      id: question.id,
      selectedOptions: draft[question.id]?.selectedOptions ?? [],
      customText: draft[question.id]?.customText.trim() || null
    }));
    try {
      await props.onAnswer(props.event, answers);
      localStorage.removeItem(draftKey(props.event.id));
    } catch {
      // The parent reports the error and keeps the durable local draft for retry.
    }
  }

  return (
    <div className="inlineApprovalCard questionInteractionCard">
      <header className="inlineApprovalHeader">
        <MessageSquare size={14} />
        <strong>{t("interaction.questionTitle")}</strong>
        <SourceTag label={props.sourceLabel} />
      </header>
      <div className="questionSet">
        {props.questionSet.questions.map((question, index) => {
          const answer = draft[question.id] ?? { selectedOptions: [], customText: "" };
          return (
            <fieldset className="questionItem" key={question.id} disabled={props.disabled}>
              <legend>
                {question.header && <span>{question.header}</span>}
                <strong>{question.question}</strong>
                <small>{index + 1}/{props.questionSet.questions.length}</small>
              </legend>
              {question.options.length > 0 && (
                <div className="questionOptions">
                  {question.options.map((option) => {
                    const checked = answer.selectedOptions.includes(option.label);
                    return (
                      <label className={`questionOption${checked ? " selected" : ""}`} key={option.label}>
                        <input
                          type={question.multiple ? "checkbox" : "radio"}
                          name={`${props.event.id}-${question.id}`}
                          checked={checked}
                          onChange={() =>
                            setDraft((current) => ({
                              ...current,
                              [question.id]: {
                                ...answer,
                                selectedOptions: question.multiple
                                  ? checked
                                    ? answer.selectedOptions.filter((item) => item !== option.label)
                                    : [...answer.selectedOptions, option.label]
                                  : [option.label]
                              }
                            }))
                          }
                        />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <textarea
                className="questionCustomInput"
                value={answer.customText}
                rows={2}
                placeholder={t("interaction.customAnswerPlaceholder")}
                aria-label={t("interaction.customAnswerLabel", { question: question.question })}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [question.id]: { ...answer, customText: event.target.value }
                  }))
                }
              />
            </fieldset>
          );
        })}
      </div>
      <div className="inlineApprovalActions questionActions">
        <button
          type="button"
          className="inlineApprovalButton primary"
          disabled={props.disabled || !valid}
          onClick={() => void submit()}
        >
          <Check size={14} />
          {t("interaction.submitAnswers")}
        </button>
        <button
          type="button"
          className="inlineApprovalButton danger"
          disabled={props.disabled}
          onClick={() => void props.onReject(props.event)}
        >
          <X size={14} />
          {t("interaction.declineAnswer")}
        </button>
      </div>
    </div>
  );
}

function SourceTag({ label }: { label?: string }) {
  if (!label) return null;
  return <span className="inlineApprovalSubAgentTag">{label}</span>;
}

function initialDraft(eventId: string, questionSet: QuestionSet): QuestionDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(eventId)) ?? "null") as QuestionDraft | null;
    if (saved && typeof saved === "object") return saved;
  } catch {
    // Ignore malformed local drafts.
  }
  return Object.fromEntries(
    questionSet.questions.map((question) => [question.id, { selectedOptions: [], customText: "" }])
  );
}

function draftKey(eventId: string) {
  return `odot.pendingInteraction.${eventId}`;
}
