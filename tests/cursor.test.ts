import { describe, expect, test } from "bun:test";
import { Cursor } from "../src/tui/cursor.ts";

describe("Cursor — basic construction", () => {
  test("creates from text with offset at end", () => {
    const c = new Cursor("hello", 5);
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(5);
  });

  test("creates from text with offset at start", () => {
    const c = new Cursor("hello", 0);
    expect(c.offset).toBe(0);
  });

  test("clamps offset to valid range", () => {
    expect(new Cursor("hi", -1).offset).toBe(0);
    expect(new Cursor("hi", 99).offset).toBe(2);
  });
});

describe("Cursor — left/right movement", () => {
  test("right moves forward one grapheme", () => {
    const c = new Cursor("hello", 0).right();
    expect(c.offset).toBe(1);
  });

  test("left moves back one grapheme", () => {
    const c = new Cursor("hello", 3).left();
    expect(c.offset).toBe(2);
  });

  test("right at end stays at end", () => {
    const c = new Cursor("hi", 2).right();
    expect(c.offset).toBe(2);
  });

  test("left at start stays at start", () => {
    const c = new Cursor("hi", 0).left();
    expect(c.offset).toBe(0);
  });

  test("right skips multi-codepoint emoji", () => {
    const emoji = "👨‍👩‍👧";
    const c = new Cursor(emoji, 0).right();
    expect(c.offset).toBe(emoji.length);
  });

  test("left skips multi-codepoint emoji", () => {
    const emoji = "👨‍👩‍👧";
    const text = `a${emoji}b`;
    const c = new Cursor(text, 1 + emoji.length).left();
    expect(c.offset).toBe(1);
  });
});

describe("Cursor — home/end", () => {
  test("home moves to offset 0", () => {
    expect(new Cursor("hello", 3).home().offset).toBe(0);
  });

  test("end moves to text length", () => {
    expect(new Cursor("hello", 0).end().offset).toBe(5);
  });
});

describe("Cursor — insert", () => {
  test("inserts text at cursor", () => {
    const c = new Cursor("hllo", 1).insert("e");
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(2);
  });

  test("inserts at start", () => {
    const c = new Cursor("ello", 0).insert("h");
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(1);
  });

  test("inserts at end", () => {
    const c = new Cursor("hell", 4).insert("o");
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(5);
  });

  test("inserts multi-char string", () => {
    const c = new Cursor("hd", 1).insert("ello worl");
    expect(c.text).toBe("hello world");
    expect(c.offset).toBe(10);
  });
});

describe("Cursor — backspace", () => {
  test("deletes char before cursor", () => {
    const c = new Cursor("hello", 3).backspace();
    expect(c.text).toBe("helo");
    expect(c.offset).toBe(2);
  });

  test("no-op at start", () => {
    const c = new Cursor("hello", 0).backspace();
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(0);
  });

  test("deletes multi-codepoint emoji", () => {
    const emoji = "👨‍👩‍👧";
    const text = `a${emoji}b`;
    const c = new Cursor(text, 1 + emoji.length).backspace();
    expect(c.text).toBe("ab");
    expect(c.offset).toBe(1);
  });
});

describe("Cursor — delete (forward)", () => {
  test("deletes char after cursor", () => {
    const c = new Cursor("hello", 2).delete();
    expect(c.text).toBe("helo");
    expect(c.offset).toBe(2);
  });

  test("no-op at end", () => {
    const c = new Cursor("hello", 5).delete();
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(5);
  });

  test("deletes multi-codepoint emoji", () => {
    const emoji = "👨‍👩‍👧";
    const text = `a${emoji}b`;
    const c = new Cursor(text, 1).delete();
    expect(c.text).toBe("ab");
    expect(c.offset).toBe(1);
  });
});

describe("Cursor — word movement", () => {
  test("wordRight jumps to end of current word", () => {
    // Readline M-f: lands at end of "hello"
    const c = new Cursor("hello world", 0).wordRight();
    expect(c.offset).toBe(5);
  });

  test("wordRight from between words jumps to end of next word", () => {
    // From the space, lands at end of "world"
    const c = new Cursor("hello world", 5).wordRight();
    expect(c.offset).toBe(11);
  });

  test("wordLeft jumps to start of current word", () => {
    // Readline M-b: lands at start of "world"
    const c = new Cursor("hello world", 11).wordLeft();
    expect(c.offset).toBe(6);
  });

  test("wordLeft from between words jumps to start of previous word", () => {
    const c = new Cursor("hello world", 6).wordLeft();
    expect(c.offset).toBe(0);
  });

  test("wordRight at end stays at end", () => {
    const c = new Cursor("hello", 5).wordRight();
    expect(c.offset).toBe(5);
  });

  test("wordLeft at start stays at start", () => {
    const c = new Cursor("hello", 0).wordLeft();
    expect(c.offset).toBe(0);
  });

  test("wordLeft skips non-word chars to find word start", () => {
    const c = new Cursor("rm /tmp/file", 12).wordLeft();
    expect(c.offset).toBe(8);
  });

  test("wordRight from start lands at end of first word", () => {
    // Readline M-f: from "rm", lands after "rm"
    const c = new Cursor("rm /tmp/file", 0).wordRight();
    expect(c.offset).toBe(2);
  });

  test("wordRight skips non-word chars to reach next word end", () => {
    // From end of "rm", skips " /" and lands at end of "tmp"
    const c = new Cursor("rm /tmp/file", 2).wordRight();
    expect(c.offset).toBe(7);
  });
});

describe("Cursor — deleteWord", () => {
  test("deletes word before cursor", () => {
    const c = new Cursor("hello world", 11).deleteWord();
    expect(c.text).toBe("hello ");
    expect(c.offset).toBe(6);
  });

  test("no-op at start", () => {
    const c = new Cursor("hello", 0).deleteWord();
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(0);
  });

  test("deletes path segment", () => {
    const c = new Cursor("rm /tmp/file", 12).deleteWord();
    expect(c.text).toBe("rm /tmp/");
    expect(c.offset).toBe(8);
  });
});

describe("Cursor — killToHome / killToEnd", () => {
  test("killToHome deletes from cursor to start", () => {
    const c = new Cursor("hello world", 5).killToHome();
    expect(c.text).toBe(" world");
    expect(c.offset).toBe(0);
  });

  test("killToHome stores killed text", () => {
    const c = new Cursor("hello world", 5).killToHome();
    expect(c.killed).toBe("hello");
  });

  test("killToEnd deletes from cursor to end", () => {
    const c = new Cursor("hello world", 5).killToEnd();
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(5);
  });

  test("killToEnd stores killed text", () => {
    const c = new Cursor("hello world", 5).killToEnd();
    expect(c.killed).toBe(" world");
  });

  test("killToHome at start kills nothing", () => {
    const c = new Cursor("hello", 0).killToHome();
    expect(c.text).toBe("hello");
    expect(c.killed).toBeUndefined();
  });

  test("killToEnd at end kills nothing", () => {
    const c = new Cursor("hello", 5).killToEnd();
    expect(c.text).toBe("hello");
    expect(c.killed).toBeUndefined();
  });
});

describe("Cursor — yank", () => {
  test("yank inserts killed text at cursor", () => {
    const c = new Cursor("hello world", 5).killToEnd().home().yank(" world");
    expect(c.text).toBe(" worldhello");
    expect(c.offset).toBe(6);
  });

  test("yank with nothing does nothing", () => {
    const c = new Cursor("hello", 3).yank(undefined);
    expect(c.text).toBe("hello");
    expect(c.offset).toBe(3);
  });
});

describe("Cursor — deleteWord also stores killed text", () => {
  test("deleteWord stores the deleted word", () => {
    const c = new Cursor("hello world", 11).deleteWord();
    expect(c.killed).toBe("world");
  });

  test("killToHome stores the deleted text", () => {
    const c = new Cursor("rm /tmp/file", 8).killToHome();
    expect(c.killed).toBe("rm /tmp/");
  });
});

describe("Cursor — charAtCursor", () => {
  test("returns grapheme at cursor position", () => {
    const c = new Cursor("hello", 1);
    expect(c.charAtCursor).toBe("e");
  });

  test("returns space when cursor is at end", () => {
    const c = new Cursor("hello", 5);
    expect(c.charAtCursor).toBe(" ");
  });

  test("returns full emoji grapheme", () => {
    const emoji = "👨‍👩‍👧";
    const c = new Cursor(`a${emoji}b`, 1);
    expect(c.charAtCursor).toBe(emoji);
  });
});

describe("Cursor — rendering helpers", () => {
  test("beforeCursor returns text before offset", () => {
    const c = new Cursor("hello", 3);
    expect(c.beforeCursor).toBe("hel");
  });

  test("afterCursor returns text after cursor grapheme", () => {
    const c = new Cursor("hello", 1);
    expect(c.afterCursor).toBe("llo");
  });

  test("afterCursor is empty at last char", () => {
    const c = new Cursor("hello", 4);
    expect(c.afterCursor).toBe("");
  });

  test("afterCursor is empty at end", () => {
    const c = new Cursor("hello", 5);
    expect(c.afterCursor).toBe("");
  });
});
