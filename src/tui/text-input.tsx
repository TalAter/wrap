import { Box, Text, useInput, useStdin } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Cursor } from "./cursor.ts";

const INPUT_BG = "#232332";
const PLACEHOLDER_COLOR = "#73738c";

function InputFrame({ children }: { children: ReactNode }) {
  return (
    <Box width="100%" paddingX={1} backgroundColor={INPUT_BG}>
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

function EditableTextInput({ value, onChange, onSubmit, placeholder }: EditableProps) {
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

  // Ink maps both Mac backspace (\x7f) and forward delete (\x1b[3~) to
  // key.delete. Track the raw sequence so we can distinguish them.
  const isForwardDelete = useRef(false);
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    const onRaw = (data: string) => {
      isForwardDelete.current = data === "\x1b[3~";
    };
    internal_eventEmitter?.on("input", onRaw);
    return () => {
      internal_eventEmitter?.off("input", onRaw);
    };
  }, [internal_eventEmitter]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit(cursor.text);
      return;
    }
    if ((key.backspace || key.delete) && key.meta) {
      apply(cursor.deleteWord());
      return;
    }
    if (key.delete && isForwardDelete.current) {
      isForwardDelete.current = false;
      apply(cursor.delete());
      return;
    }
    if (key.backspace || key.delete) {
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
      <Text>
        {cursor.beforeCursor}
        <Text inverse>{cursor.charAtCursor}</Text>
        {cursor.afterCursor}
        {showPlaceholder ? <Text color={PLACEHOLDER_COLOR}>{placeholder}</Text> : null}
      </Text>
    </InputFrame>
  );
}

export function TextInput(props: TextInputProps) {
  if (props.readOnly) {
    return (
      <InputFrame>
        {/* Empty value would otherwise collapse the row to height 0. */}
        <Text>{props.value || " "}</Text>
      </InputFrame>
    );
  }
  return <EditableTextInput {...props} />;
}
