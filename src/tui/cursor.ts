const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

export class Cursor {
  readonly text: string;
  readonly offset: number;
  readonly killed: string | undefined;

  constructor(text: string, offset: number, killed?: string) {
    this.text = text;
    this.offset = Math.max(0, Math.min(offset, text.length));
    this.killed = killed;
  }

  // -- Movement --

  right(): Cursor {
    if (this.offset >= this.text.length) return this;
    return new Cursor(this.text, nextGrapheme(this.text, this.offset));
  }

  left(): Cursor {
    if (this.offset <= 0) return this;
    return new Cursor(this.text, prevGrapheme(this.text, this.offset));
  }

  home(): Cursor {
    return new Cursor(this.text, 0);
  }

  end(): Cursor {
    return new Cursor(this.text, this.text.length);
  }

  wordRight(): Cursor {
    if (this.offset >= this.text.length) return this;
    return new Cursor(this.text, wordBoundaryRight(this.text, this.offset));
  }

  wordLeft(): Cursor {
    if (this.offset <= 0) return this;
    return new Cursor(this.text, wordBoundaryLeft(this.text, this.offset));
  }

  // -- Editing --

  insert(str: string): Cursor {
    const text = this.text.slice(0, this.offset) + str + this.text.slice(this.offset);
    return new Cursor(text, this.offset + str.length);
  }

  backspace(): Cursor {
    if (this.offset <= 0) return this;
    const prev = prevGrapheme(this.text, this.offset);
    const text = this.text.slice(0, prev) + this.text.slice(this.offset);
    return new Cursor(text, prev);
  }

  deleteWord(): Cursor {
    if (this.offset <= 0) return this;
    const to = wordBoundaryLeft(this.text, this.offset);
    const killed = this.text.slice(to, this.offset);
    const text = this.text.slice(0, to) + this.text.slice(this.offset);
    return new Cursor(text, to, killed);
  }

  killToHome(): Cursor {
    if (this.offset <= 0) return new Cursor(this.text, 0);
    const killed = this.text.slice(0, this.offset);
    return new Cursor(this.text.slice(this.offset), 0, killed);
  }

  killToEnd(): Cursor {
    if (this.offset >= this.text.length) return new Cursor(this.text, this.offset);
    const killed = this.text.slice(this.offset);
    return new Cursor(this.text.slice(0, this.offset), this.offset, killed);
  }

  yank(text: string | undefined): Cursor {
    if (!text) return this;
    return this.insert(text);
  }

  // -- Rendering helpers --

  get beforeCursor(): string {
    return this.text.slice(0, this.offset);
  }

  get charAtCursor(): string {
    if (this.offset >= this.text.length) return " ";
    return graphemeAt(this.text, this.offset)?.segment ?? " ";
  }

  get afterCursor(): string {
    const end =
      this.offset >= this.text.length ? this.text.length : nextGrapheme(this.text, this.offset);
    return this.text.slice(end);
  }
}

// -- Grapheme helpers --

function graphemeAt(text: string, offset: number): Intl.SegmentData | undefined {
  for (const seg of segmenter.segment(text)) {
    if (seg.index >= offset && seg.index + seg.segment.length > offset) return seg;
  }
  return undefined;
}

function nextGrapheme(text: string, offset: number): number {
  const seg = graphemeAt(text, offset);
  return seg ? seg.index + seg.segment.length : text.length;
}

function prevGrapheme(text: string, offset: number): number {
  let prev = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (index + segment.length >= offset) return prev;
    prev = index + segment.length;
  }
  return prev;
}

// -- Word boundary helpers (using Intl.Segmenter) --
// Readline semantics: M-f lands at end of current/next word, M-b lands at start.

function segmentEnd(seg: Intl.SegmentData | undefined): number {
  return seg ? seg.index + seg.segment.length : 0;
}

function wordBoundaryLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const segments = [...wordSegmenter.segment(text)];
  // Walk backward: skip non-word segments, then land at start of the word segment
  let i = segments.length - 1;
  while (i >= 0 && (segments[i]?.index ?? 0) >= pos) i--;
  while (i >= 0 && !segments[i]?.isWordLike) i--;
  if (i >= 0 && segments[i]?.isWordLike) return segments[i]?.index ?? 0;
  return 0;
}

function wordBoundaryRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const segments = [...wordSegmenter.segment(text)];
  // Find which segment pos falls in
  let i = 0;
  while (i < segments.length - 1 && (segments[i + 1]?.index ?? 0) <= pos) i++;
  // Skip non-word segments forward
  if (!segments[i]?.isWordLike) {
    while (i < segments.length && !segments[i]?.isWordLike) i++;
  } else if (segments[i] && pos >= segmentEnd(segments[i])) {
    // At or past end of current word — skip to next word
    i++;
    while (i < segments.length && !segments[i]?.isWordLike) i++;
  }
  // Land at end of this word segment
  const seg = segments[i];
  if (i < segments.length && seg?.isWordLike) return segmentEnd(seg);
  return text.length;
}
