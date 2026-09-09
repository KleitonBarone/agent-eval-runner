import { describe, expect, it, vi } from "vitest";

import { EventRecorder } from "../src/events.js";

describe("event recorder", () => {
  it("assigns contiguous sequence numbers and monotonic elapsed times", () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(15);
    const recorder = new EventRecorder();
    recorder.record({ type: "run.started" });
    recorder.record({ type: "agent.started", adapter: "fake" });

    expect(recorder.events.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(recorder.events.map(({ elapsedMs }) => elapsedMs)).toEqual([2, 5]);
  });
});
