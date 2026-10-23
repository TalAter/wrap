import { type MockStream, type MockStreamOptions, mockStream } from "./mock-stream.ts";

export function mockStdout(options: MockStreamOptions = {}): MockStream {
  return mockStream("stdout", options);
}
