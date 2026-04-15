import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { getTheme, themeHex } from "../core/theme.ts";
import { Cursor } from "./cursor.ts";

function InputFrame({ children }: { children: ReactNode }) {
  const bg = themeHex(getTheme().chrome.surface);
  return (
    <Box width="100%" paddingX={1} backgroundColor={bg}>
      {children}
    </Box>
  );
}

export type TextInputProps =
  | {
      readOnly?: false;
      value: string;
      onChange: (value: string) => void;
      onSubmit: (value: string) => void;
      placeholder?: string;
      /** Render each character as `•`. Cursor state keeps the real text. */
      masked?: boolean;
    }
  | {
      readOnly: true;
      value: string;
    };

type EditableProps = Extract<TextInputProps, { readOnly?: false }>;

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

function EditableTextInput({ value, onChange, onSubmit, placeholder, masked }: EditableProps) {
  const [cursor, setCursor] = useState(() => new Cursor(value, value.length));
  const killRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setCursor((prev) => (prev.text === value ? prev : new Cursor(value, value.length)));
  }, [value]);

  const apply = (next: Cursor) => {
    if (next.killed !== undefined) killRef.current = next.killed;
    setCursor(next);
    // Movement keys (arrows, home/end, word jumps) return a new Cursor with
    // unchanged text — skip onChange so the parent doesn't re-render for nothing.
    if (next.text !== cursor.text) onChange(next.text);
  };

  useInput((input, key) => {
    if (key.return) {
      onSubmit(cursor.text);
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
    if (key.ctrl) {
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
      apply(cursor.insert(input));
    }
  });

  const showPlaceholder = value === "" && Boolean(placeholder);

  return (
    <InputFrame>
      <Text color={themeHex(getTheme().text.primary)}>
        {masked ? mask(cursor.beforeCursor) : cursor.beforeCursor}
        <Text inverse>
          {masked ? (cursor.charAtCursor === " " ? " " : "•") : cursor.charAtCursor}
        </Text>
        {masked ? mask(cursor.afterCursor) : cursor.afterCursor}
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
