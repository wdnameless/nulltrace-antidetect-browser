/**
 * Post-input verification for fill/type actions (borrowed from ego-lite
 * driver/page-actions.ts verifyFillOutcome + classifyFillOutcome).
 *
 * Why: a dispatched keystroke is not proof the control kept it. Modern SPAs
 * re-render on input, contenteditable editors ignore synthetic text, and
 * read-only controls drop the value silently. Reading the control back and
 * classifying what landed turns a silent drop into a reported outcome.
 */

export type FillOutcome =
  | 'exact'
  | 'equivalent'
  | 'appended'
  | 'unchanged'
  | 'transformed'
  /** Only a prefix of the text landed; the rest was dropped or still landing. */
  | 'partial'
  /** The control could not be read back; the caller must not claim failure. */
  | 'unverified';

export const FILL_VERIFICATION_ATTEMPTS = 5;
export const FILL_VERIFICATION_INTERVAL_MS = 50;

/** Reads a control's current text: `value` for input/textarea, else innerText. */
export const READ_FILLED_VALUE_FN = `function readFilledValue() {
  if (!this || this.isConnected === false) return { error: "element is not connected" };
  const tag = this.nodeName ? this.nodeName.toLowerCase() : "";
  const observed = tag === "input" || tag === "textarea"
    ? this.value
    : (this.innerText != null ? this.innerText : this.textContent);
  return {
    actual: String(observed == null ? "" : observed),
    type: tag === "input" && this.type ? String(this.type).toLowerCase() : ""
  };
}`;

/**
 * Dispatches a clipboard-shaped `paste` event on the target node with a real
 * DataTransfer, so rich-text editors (ProseMirror, Quill, Slate, Lexical) take
 * the value through their own paste pipeline.
 *
 * Why not the OS clipboard: it is a single user resource, and a crashed host
 * leaves the operator's clipboard clobbered. A synthetic event borrows nothing
 * to restore and inserts nothing at the OS level, so it leaves no fingerprint.
 */
export const DISPATCH_PASTE_FN = `function dispatchPaste(text, html) {
  const target = this;
  if (!target) return { error: "no target" };
  const view = target.ownerDocument && target.ownerDocument.defaultView;
  if (!view || typeof view.DataTransfer !== "function" || typeof view.ClipboardEvent !== "function") {
    return { supported: false };
  }
  const dt = new view.DataTransfer();
  dt.setData("text/plain", String(text));
  if (typeof html === "string" && html.length > 0) dt.setData("text/html", html);
  const event = new view.ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  const dispatched = target.dispatchEvent(event);
  return { supported: true, dispatched: dispatched, accepted: event.defaultPrevented || !dispatched };
}`;

function normalize(text: string): string {
  return String(text).replace(/\r\n?/g, '\n').replace(/\u200b/g, '');
}

/** True when the observed value is a success worth stopping on. */
export function fillOutcomeAccepted(outcome: FillOutcome): boolean {
  return outcome === 'exact' || outcome === 'equivalent' || outcome === 'transformed';
}

/**
 * Classifies what the control holds after dispatch against what was typed.
 * `transformed` covers application-side reformatting (spaces, masking,
 * case folding): the input was accepted, only reshaped.
 */
export function classifyFillOutcome(
  beforeValue: string,
  expectedValue: string,
  actualValue: string,
  clearFirst: boolean,
  inputType: string
): FillOutcome {
  const before = normalize(beforeValue);
  const expected = normalize(expectedValue);
  const actual = normalize(actualValue);

  if (clearFirst ? actual === expected : actual.includes(expected)) {
    return 'exact';
  }
  if (
    inputType === 'number' &&
    expected.trim() !== '' &&
    actual.trim() !== '' &&
    Number(actual) === Number(expected)
  ) {
    return 'equivalent';
  }
  const integerExpected = expected.normalize('NFKC').trim();
  if (/^\d+$/.test(integerExpected)) {
    const actualDigits = actual.normalize('NFKC').replace(/\D/g, '');
    if (actualDigits === integerExpected) return 'equivalent';
    const beforeDigits = before.normalize('NFKC').replace(/\D/g, '');
    if (clearFirst && beforeDigits.length > 0 && actualDigits === beforeDigits + integerExpected) {
      return 'appended';
    }
  }
  if (clearFirst && before.length > 0 && actual === before + expected) {
    return 'appended';
  }
  if (actual === before) return 'unchanged';
  // A prefix means part of the text is in and the rest has not landed (our
  // dispatch types key by key, so mid-flight reads look like this) or was
  // dropped. Either way a retry or a wait is required — never a success.
  if (actual.length > 0 && actual.length < expected.length && expected.startsWith(actual)) {
    return 'partial';
  }
  return 'transformed';
}

/**
 * Re-reads a control until the classification stops changing, then reports it.
 * `read` is supplied by the caller: CDP Runtime.callFunctionOn for a resolved
 * @ref node, or page.evaluate for a CSS selector. A throwing read means the
 * control is unobservable — reported as `unverified`, never as a failure.
 */
export async function verifyFillOutcome(
  read: () => Promise<{ actual?: unknown; type?: unknown; error?: unknown } | null>,
  beforeValue: string,
  expectedValue: string,
  clearFirst: boolean,
  sleep: (ms: number) => Promise<void>
): Promise<FillOutcome> {
  let prior: string | null = null;
  let consecutiveReads = 0;
  let last: FillOutcome = 'unverified';
  let sawRead = false;

  for (let attempt = 0; attempt < FILL_VERIFICATION_ATTEMPTS; attempt += 1) {
    let result: { actual?: unknown; type?: unknown; error?: unknown } | null = null;
    try {
      result = await read();
    } catch {
      return sawRead ? last : 'unverified';
    }
    if (!result) return sawRead ? last : 'unverified';
    if (typeof result.error === 'string') return sawRead ? last : 'unverified';
    sawRead = true;

    const actual = String(result.actual ?? '');
    const outcome = classifyFillOutcome(beforeValue, expectedValue, actual, clearFirst, String(result.type ?? ''));
    last = outcome;

    // An accepted value is final: a later application reformat is accepted too.
    if (fillOutcomeAccepted(outcome)) return outcome;

    const reading = `${outcome}\u0000${actual}`;
    if (reading === prior) {
      consecutiveReads += 1;
      // Two identical rejections mean the control settled on that value.
      if (consecutiveReads >= 2) return outcome;
    } else {
      prior = reading;
      consecutiveReads = 1;
    }
    if (attempt + 1 < FILL_VERIFICATION_ATTEMPTS) await sleep(FILL_VERIFICATION_INTERVAL_MS);
  }
  return last;
}
