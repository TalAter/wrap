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
      /** Max visible VISUAL rows (after hard-wrapping each logical line to
       *  `wrapWidth`). When content exceeds this, the view scrolls to keep
       *  the cursor visible. Unset → grow without clipping. */
      maxRows?: number;
      /** Column width at which to hard-wrap long logical lines so one 80KB
       *  paste becomes many visual rows instead of one Ink-wrapped blob. Omit
       *  to fall back to logical-line windowing (the view may still overflow
       *  if a logical line is very long). */
      wrapWidth?: number;
    });

type SingleLineEditableProps = BaseEditable & { multiline?: false; masked?: boolean };
type MultilineEditableProps = BaseEditable & {
  multiline: true;
  onTruncate?: () => void;
  maxRows?: number;
  wrapWidth?: number;
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
          <Text color={themeHex(getTheme().text.muted)}>
            ... Save and close editor to continue ...
          </Text>
        </Box>
      </InputFrame>
    );
  }

  const showPlaceholder = cursor.text === "" && Boolean(placeholder);
  const maxRows = multiline ? (props as MultilineEditableProps).maxRows : undefined;
  const wrapWidth = multiline ? (props as MultilineEditableProps).wrapWidth : undefined;

  // Windowed render for multiline+maxRows. When `wrapWidth` is provided we
  // hard-wrap each logical line at that width so a single huge paste becomes
  // many visual rows we can slice — otherwise a 50KB single-line paste stays
  // one logical row that Ink soft-wraps past the terminal height, and the
  // dialog blows out past both screen edges. Without wrapWidth we fall back
  // to logical-line windowing (the old behavior).
  if (multiline && maxRows !== undefined) {
    const logicalLines = cursor.text.split("\n");
    // Build visual rows: each row is a text slice paired with its start
    // offset in the underlying buffer so we can map the cursor back in.
    type VisualRow = { text: string; startOffset: number; len: number };
    const visualRows: VisualRow[] = [];
    let offsetWalk = 0;
    for (const line of logicalLines) {
      if (line.length === 0) {
        visualRows.push({ text: "", startOffset: offsetWalk, len: 0 });
      } else if (!wrapWidth || line.length <= wrapWidth) {
        visualRows.push({ text: line, startOffset: offsetWalk, len: line.length });
      } else {
        for (let i = 0; i < line.length; i += wrapWidth) {
          const chunk = line.slice(i, i + wrapWidth);
          visualRows.push({ text: chunk, startOffset: offsetWalk + i, len: chunk.length });
        }
      }
      offsetWalk += line.length + 1; // +1 for the "\n" separator
    }
    // Locate the cursor's visual row via binary-ish linear scan — fine here,
    // visualRows is at most a few thousand entries (capped by 256KB / wrap).
    let cursorVisualRow = visualRows.length - 1;
    for (let i = 0; i < visualRows.length; i++) {
      const row = visualRows[i] as VisualRow;
      const nextStart = visualRows[i + 1]?.startOffset ?? Infinity;
      if (cursor.offset >= row.startOffset && cursor.offset < nextStart) {
        cursorVisualRow = i;
        break;
      }
    }
    const top = Math.max(
      0,
      Math.min(Math.max(0, visualRows.length - maxRows), cursorVisualRow - maxRows + 1),
    );
    const clampedTop = Math.max(0, Math.min(top, cursorVisualRow));
    const visible = visualRows.slice(clampedTop, clampedTop + maxRows);
    const localRow = cursorVisualRow - clampedTop;
    const visRow = visible[localRow];
    const localCol = visRow ? Math.min(cursor.offset - visRow.startOffset, visRow.len) : 0;
    // Flatten visible rows and compute the cursor's position in the flat.
    const flat = visible.map((v) => v.text).join("\n");
    let flatOffset = 0;
    for (let i = 0; i < localRow; i++) flatOffset += (visible[i]?.len ?? 0) + 1;
    flatOffset += localCol;
    const before = flat.slice(0, flatOffset);
    const at = flat.charAt(flatOffset) || " ";
    const after = flat.slice(flatOffset + 1);
    return (
      <InputFrame>
        <Text color={themeHex(getTheme().text.primary)} wrap="truncate-end">
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
