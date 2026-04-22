import { Box, Text, useInput, usePaste } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { getTheme, themeHex } from "../core/theme.ts";
import { clampBufferSize } from "./clamp-buffer.ts";
import { Cursor } from "./cursor.ts";

export function InputFrame({ children }: { children: ReactNode }) {
  const bg = themeHex(getTheme().chrome.surface);
  return (
    <Box width="100%" paddingX={1} backgroundColor={bg}>
      {children}
    </Box>
  );
}

type BaseEditable = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
};

export type TextInputProps =
  | { readOnly: true; value: string; editingExternal?: never }
  | (BaseEditable & {
      readOnly?: false;
      editingExternal?: boolean;
      multiline?: false;
      /** Render each character as `•`. Cursor state keeps the real text. Single-line only. */
      masked?: boolean;
    })
  | (BaseEditable & {
      readOnly?: false;
      editingExternal?: boolean;
      multiline: true;
      /** Fires when a paste or editor-return had to be trimmed to fit the 256KB cap. */
      onTruncate?: () => void;
      /** Max visible logical rows. When the buffer has more lines, the view
       *  scrolls to keep the cursor in view. Unset → grow without clipping. */
      maxRows?: number;
    });

type SingleLineEditableProps = BaseEditable & { multiline?: false; masked?: boolean };
type MultilineEditableProps = BaseEditable & {
  multiline: true;
  onTruncate?: () => void;
  maxRows?: number;
};

type KeyHandler = (c: Cursor) => Cursor;

const ctrlKeys = new Map<string, KeyHandler>([
  ["a", (c) => c.home()],
  ["e", (c) => c.end()],
  ["u", (c) => c.killToHome()],
  ["k", (c) => c.killToEnd()],
]);

const metaKeys = new Map<string, KeyHandler>([
  ["b", (c) => c.wordLeft()],
  ["f", (c) => c.wordRight()],
]);

function mask(text: string): string {
  return "•".repeat(text.length);
}

function stripNewlines(s: string): string {
  return s.replace(/[\r\n]/g, "");
}

/**
 * Sanitize a pasted string: collapse CRLF → LF, drop other control bytes
 * (keeps tab, LF). One regex, one allocation.
 */
function sanitizePaste(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the whole point is to filter control chars
  return s.replace(/\r\n|[\x00-\x08\x0B-\x1F\x7F]/g, (m) => (m === "\r\n" ? "\n" : ""));
}

function EditableTextInput(
  props: (SingleLineEditableProps | MultilineEditableProps) & {
    editingExternal?: boolean;
  },
) {
  const { value, onChange, onSubmit, placeholder } = props;
  const multiline = props.multiline === true;
  const masked = !multiline && (props as SingleLineEditableProps).masked === true;
  const editingExternal = props.editingExternal === true;

  const [cursor, setCursor] = useState(() => new Cursor(value, value.length));
  const killRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setCursor((prev) => (prev.text === value ? prev : new Cursor(value, value.length)));
  }, [value]);

  const apply = (next: Cursor) => {
    if (next.killed !== undefined) killRef.current = next.killed;
    setCursor(next);
    if (next.text !== cursor.text) onChange(next.text);
  };

  usePaste(
    (raw) => {
      const cleaned = multiline ? sanitizePaste(raw) : stripNewlines(raw);
      const combined =
        cursor.text.slice(0, cursor.offset) + cleaned + cursor.text.slice(cursor.offset);
      const clamped = clampBufferSize(combined);
      if (multiline && clamped.truncated) {
        (props as MultilineEditableProps).onTruncate?.();
      }
      const newOffset = Math.min(cursor.offset + cleaned.length, clamped.value.length);
      apply(new Cursor(clamped.value, newOffset));
    },
    { isActive: !editingExternal },
  );

  useInput(
    (input, key) => {
      if (key.return) {
        // Shift+Enter in multiline → newline (kitty CSI-u).
        if (multiline && key.shift) {
          apply(cursor.insert("\n"));
          return;
        }
        // Backslash-Enter in multiline → strip trailing "\" then insert \n.
        if (multiline && cursor.text.endsWith("\\") && cursor.offset === cursor.text.length) {
          const stripped = cursor.text.slice(0, -1);
          apply(new Cursor(`${stripped}\n`, stripped.length + 1));
          return;
        }
        // Plain Enter: submit. Empty-buffer Enter in multiline is a no-op.
        if (multiline && cursor.text.length === 0) return;
        onSubmit(cursor.text);
        return;
      }
      // Ctrl+J without kitty: arrives as `\n` with `key.return === false`.
      if (multiline && !key.return && input === "\n") {
        apply(cursor.insert("\n"));
        return;
      }
      if (key.backspace && key.meta) {
        apply(cursor.deleteWord());
        return;
      }
      if (key.delete) {
        apply(cursor.delete());
        return;
      }
      if (key.backspace) {
        apply(cursor.backspace());
        return;
      }
      if (key.leftArrow) {
        apply(key.meta ? cursor.wordLeft() : cursor.left());
        return;
      }
      if (key.rightArrow) {
        apply(key.meta ? cursor.wordRight() : cursor.right());
        return;
      }
      if (multiline && key.upArrow) {
        apply(cursor.upLine());
        return;
      }
      if (multiline && key.downArrow) {
        apply(cursor.downLine());
        return;
      }
      if (key.ctrl) {
        if (multiline && input === "j") {
          apply(cursor.insert("\n"));
          return;
        }
        const handler = input === "y" ? () => cursor.yank(killRef.current) : ctrlKeys.get(input);
        if (handler) apply(handler(cursor));
        return;
      }
      if (key.meta) {
        const handler = metaKeys.get(input);
        if (handler) apply(handler(cursor));
        return;
      }
      if (input) {
        // Multi-char bursts that contain \n need special handling. In multiline
        // mode, let \n through the normal insert path (paste handler usually
        // handles this, but bracketed paste isn't guaranteed from every source).
        // In single-line mode, strip \n from the incoming string.
        const toInsert = multiline ? input : stripNewlines(input);
        if (toInsert.length === 0) return;
        const inserted = cursor.insert(toInsert);
        if (multiline) {
          const clamped = clampBufferSize(inserted.text);
          if (clamped.truncated) {
            (props as MultilineEditableProps).onTruncate?.();
            const newOffset = Math.min(inserted.offset, clamped.value.length);
            apply(new Cursor(clamped.value, newOffset));
            return;
          }
        }
        apply(inserted);
      }
    },
    { isActive: !editingExternal },
  );

  if (editingExternal) {
    return (
      <InputFrame>
        <Box width="100%" justifyContent="center">
          <Text color={themeHex(getTheme().text.muted)}>Save and close editor to continue...</Text>
        </Box>
      </InputFrame>
    );
  }

  const showPlaceholder = cursor.text === "" && Boolean(placeholder);
  const maxRows = multiline ? (props as MultilineEditableProps).maxRows : undefined;

  // Windowed render for multiline+maxRows: keep cursor row inside the visible
  // slice. Long soft-wrapped lines may still visually exceed the slice — that
  // lives with the caller's chrome budget, but the cursor row is guaranteed
  // to be inside.
  if (multiline && maxRows !== undefined) {
    const lines = cursor.text.split("\n");
    const cursorRow = cursor.row;
    // Slide the window just enough to keep cursorRow visible. No persistent
    // scroll position — deriving from cursor keeps state out of sync issues
    // (value prop changes resync cursor, which resyncs scrollTop for free).
    const top = Math.max(0, Math.min(lines.length - maxRows, cursorRow - maxRows + 1));
    const clampedTop = Math.max(0, Math.min(top, cursorRow));
    const visibleLines = lines.slice(clampedTop, clampedTop + maxRows);
    const localRow = cursorRow - clampedTop;
    const localCol = cursor.col;
    // Flatten visible lines to a string so we can slice at the cursor offset.
    let offset = 0;
    for (let i = 0; i < localRow; i++) offset += (visibleLines[i]?.length ?? 0) + 1;
    offset += Math.min(localCol, visibleLines[localRow]?.length ?? 0);
    const flat = visibleLines.join("\n");
    const before = flat.slice(0, offset);
    const at = flat.charAt(offset) || " ";
    const after = flat.slice(offset + 1);
    return (
      <InputFrame>
        <Text color={themeHex(getTheme().text.primary)}>
          {before}
          <Text inverse>{at}</Text>
          {after}
          {showPlaceholder ? (
            <Text color={themeHex(getTheme().text.muted)}>{placeholder}</Text>
          ) : null}
        </Text>
      </InputFrame>
    );
  }

  const renderedBefore = masked ? mask(cursor.beforeCursor) : cursor.beforeCursor;
  const renderedCursor = masked ? (cursor.charAtCursor === " " ? " " : "•") : cursor.charAtCursor;
  const renderedAfter = masked ? mask(cursor.afterCursor) : cursor.afterCursor;

  return (
    <InputFrame>
      <Text color={themeHex(getTheme().text.primary)}>
        {renderedBefore}
        <Text inverse>{renderedCursor}</Text>
        {renderedAfter}
        {showPlaceholder ? (
          <Text color={themeHex(getTheme().text.muted)}>{placeholder}</Text>
        ) : null}
      </Text>
    </InputFrame>
  );
}

export function TextInput(props: TextInputProps) {
  if (props.readOnly) {
    return (
      <InputFrame>
        {/* Empty value would otherwise collapse the row to height 0. */}
        <Text color={themeHex(getTheme().text.primary)}>{props.value || " "}</Text>
      </InputFrame>
    );
  }
  return <EditableTextInput {...props} />;
}
