export type PromptInlineReference = {
  id: string;
  source: "selectedPath" | "attachment" | "externalReference";
  sourceId: string;
  label: string;
  detail: string;
  kind: "file" | "directory" | "selection" | "attachment";
};

export function syncPromptInlineReferences(
  editor: HTMLDivElement,
  references: PromptInlineReference[]
) {
  const referenceIds = new Set(references.map((reference) => reference.id));
  editor
    .querySelectorAll<HTMLElement>("[data-inline-reference-id]")
    .forEach((node) => {
      if (!referenceIds.has(node.dataset.inlineReferenceId || "")) {
        node.remove();
      }
    });

  for (const reference of references) {
    const exists = Array.from(
      editor.querySelectorAll<HTMLElement>("[data-inline-reference-id]")
    ).some((node) => node.dataset.inlineReferenceId === reference.id);
    if (exists) {
      continue;
    }
    appendPromptInlineReference(editor, reference);
  }
}

export function appendPromptInlineReference(
  editor: HTMLDivElement,
  reference: PromptInlineReference
) {
  const chip = createPromptInlineReferenceElement(reference);
  const range = promptInlineReferenceInsertionRange(editor);
  if (hasMeaningfulTextBeforeRange(editor, range)) {
    insertNodeAtRange(range, document.createTextNode(" "));
  }
  insertNodeAtRange(range, chip);
  insertNodeAtRange(range, document.createTextNode(" "));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function extractPromptEditorText(
  editor: HTMLDivElement | null,
  options: { includeReferences?: boolean } = {}
) {
  if (!editor) {
    return "";
  }
  const parts: string[] = [];

  function visit(node: ChildNode) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
      return;
    }
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (node.dataset.inlineReferenceId) {
      if (options.includeReferences) {
        parts.push(` ${node.dataset.promptLabel || node.textContent || ""} `);
      } else {
        parts.push(" ");
      }
      return;
    }
    if (node.tagName === "BR") {
      if (!isContentEditablePlaceholderBr(node)) {
        parts.push("\n");
      }
      return;
    }
    node.childNodes.forEach(visit);
    if (node.tagName === "DIV" || node.tagName === "P") {
      const next = node.nextSibling;
      if (
        next instanceof HTMLElement &&
        (next.tagName === "DIV" || next.tagName === "P")
      ) {
        parts.push("\n");
      }
    }
  }

  editor.childNodes.forEach(visit);
  return parts
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function setPromptEditorText(
  editor: HTMLDivElement | null,
  text: string,
  references: PromptInlineReference[] = []
) {
  if (!editor) {
    return;
  }
  editor.textContent = text;
  syncPromptInlineReferences(editor, references);
  moveCaretToEnd(editor);
}

export function insertTextAtSelection(text: string) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function moveCaretToEnd(editor: HTMLDivElement | null) {
  if (!editor) {
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function createPromptInlineReferenceElement(reference: PromptInlineReference) {
  const chip = document.createElement("span");
  chip.className = `promptInlineReference ${reference.kind}`;
  chip.contentEditable = "false";
  chip.dataset.inlineReferenceId = reference.id;
  chip.dataset.promptLabel = promptInlineReferenceText(reference);

  const marker = document.createElement("span");
  marker.className = "promptInlineReferenceMarker";
  marker.textContent = reference.kind === "directory" ? "dir" : "#";
  chip.appendChild(marker);

  const label = document.createElement("span");
  label.className = "promptInlineReferenceLabel";
  label.textContent = reference.label;
  chip.appendChild(label);

  const detail = promptInlineReferenceDetail(reference);
  if (detail) {
    const detailNode = document.createElement("small");
    detailNode.textContent = detail;
    chip.appendChild(detailNode);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.dataset.removeInlineReference = reference.id;
  button.setAttribute("aria-label", `Remove ${reference.label}`);
  button.textContent = "x";
  chip.appendChild(button);

  return chip;
}

function promptInlineReferenceText(reference: PromptInlineReference) {
  const detail = promptInlineReferenceDetail(reference);
  return detail ? `${reference.label} ${detail}` : reference.label;
}

function promptInlineReferenceInsertionRange(editor: HTMLDivElement) {
  const selection = window.getSelection();
  if (
    selection &&
    selection.rangeCount > 0 &&
    selection.anchorNode &&
    editor.contains(selection.anchorNode)
  ) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    return range;
  }
  return promptInlineReferenceEndRange(editor);
}

function promptInlineReferenceEndRange(editor: HTMLDivElement) {
  const range = document.createRange();
  let node: ChildNode | null = editor.lastChild;

  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, node.textContent?.length ?? 0);
      range.collapse(true);
      return range;
    }
    if (!(node instanceof HTMLElement)) {
      break;
    }
    if (node.dataset.inlineReferenceId) {
      range.setStartAfter(node);
      range.collapse(true);
      return range;
    }
    if (node.tagName === "BR") {
      range.setStartBefore(node);
      range.collapse(true);
      return range;
    }
    if (node.tagName === "DIV" || node.tagName === "P") {
      const last = node.lastChild;
      if (last?.nodeName === "BR") {
        if (node.childNodes.length === 1) {
          node.removeChild(last);
          range.selectNodeContents(node);
          range.collapse(false);
          return range;
        }
        range.setStartBefore(last);
        range.collapse(true);
        return range;
      }
      if (last) {
        node = last;
        continue;
      }
      range.selectNodeContents(node);
      range.collapse(false);
      return range;
    }
    break;
  }

  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

function insertNodeAtRange(range: Range, node: Node) {
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
}

function hasMeaningfulTextBeforeRange(editor: HTMLDivElement, range: Range) {
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(editor);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  return Boolean(beforeRange.toString().replace(/\u00a0/g, " ").trim());
}

function isContentEditablePlaceholderBr(node: ChildNode) {
  if (!(node instanceof HTMLElement) || node.tagName !== "BR") {
    return false;
  }
  const parent = node.parentElement;
  if (!parent || parent === node.ownerDocument?.body) {
    return false;
  }
  if (node !== parent.lastChild) {
    return false;
  }
  const text = (parent.textContent || "").replace(/\u00a0/g, " ");
  return Boolean(text.trim());
}

function promptInlineReferenceDetail(reference: PromptInlineReference) {
  if (reference.source === "externalReference") {
    return reference.detail;
  }
  if (reference.kind === "selection" && reference.detail) {
    return `(${reference.detail})`;
  }
  if (reference.source === "selectedPath") {
    return "";
  }
  return reference.detail ? `(${reference.detail})` : "";
}
