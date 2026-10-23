import { type MockStream, type MockStreamOptions, mockStream } from "./mock-stream.ts";

export type MockStderr = MockStream;

export function mockStderr(options: MockStreamOptions = {}): MockStderr {
  return mockStream("stderr", options);
}
