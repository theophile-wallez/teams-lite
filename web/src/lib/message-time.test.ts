import { describe, expect, it } from "vitest";
import { TIME_MARK_GAP_MS, formatMessageTime, messageTimeMark } from "./message-time";

const at = (iso: string) => ({ compose_time: new Date(iso).getTime() });
const NOW = new Date("2026-08-10T18:00:00").getTime();

describe("messageTimeMark", () => {
  it("marks nothing between messages minutes apart on one day", () => {
    expect(messageTimeMark(at("2026-08-10T14:20:00"), at("2026-08-10T14:02:00"), NOW)).toBeNull();
  });

  it("marks the message that opens a block after a long silence", () => {
    const mark = messageTimeMark(at("2026-08-10T14:00:00"), at("2026-08-10T09:30:00"), NOW);
    expect(mark).not.toBeNull();
  });

  it("takes the gap as it is at the threshold, and not a millisecond below it", () => {
    const previous = at("2026-08-10T09:00:00");
    const exactly = { compose_time: previous.compose_time + TIME_MARK_GAP_MS };
    const justUnder = { compose_time: previous.compose_time + TIME_MARK_GAP_MS - 1 };
    expect(messageTimeMark(exactly, previous, NOW)).not.toBeNull();
    expect(messageTimeMark(justUnder, previous, NOW)).toBeNull();
  });

  it("marks a new DAY even when the two messages are minutes apart", () => {
    // The one case a reader cannot work out from the words.
    const mark = messageTimeMark(at("2026-08-10T00:10:00"), at("2026-08-09T23:55:00"), NOW);
    expect(mark).not.toBeNull();
  });

  it("marks nothing without the message above it", () => {
    // The oldest loaded row: a mark there would be taken away again by the page
    // that arrives above it.
    expect(messageTimeMark(at("2026-08-10T14:00:00"), undefined, NOW)).toBeNull();
  });

  it("marks nothing for a row with no usable time", () => {
    expect(messageTimeMark({ compose_time: 0 }, at("2026-08-09T23:55:00"), NOW)).toBeNull();
    expect(messageTimeMark(at("2026-08-10T14:00:00"), { compose_time: 0 }, NOW)).toBeNull();
    expect(messageTimeMark({ compose_time: Number.NaN }, at("2026-08-10T09:00:00"), NOW)).toBeNull();
  });

  it("does not mark a time that runs backwards on the same day", () => {
    // seq order is the history's order, and it is not always time order.
    expect(messageTimeMark(at("2026-08-10T09:00:00"), at("2026-08-10T14:00:00"), NOW)).toBeNull();
  });
});

describe("formatMessageTime", () => {
  it("says only the time for today", () => {
    const label = formatMessageTime(new Date("2026-08-10T09:05:00").getTime(), NOW);
    expect(label).toMatch(/9[:.]05/);
    expect(label.toLowerCase()).not.toContain("aug");
  });

  it("names yesterday, stepping by calendar day", () => {
    const label = formatMessageTime(new Date("2026-08-09T23:55:00").getTime(), NOW);
    expect(label).toContain("Yesterday");
    expect(label).toMatch(/11[:.]55|23[:.]55/);
  });

  it("names the weekday inside the last week", () => {
    const label = formatMessageTime(new Date("2026-08-06T10:00:00").getTime(), NOW);
    expect(label).not.toContain("Yesterday");
    expect(label).toMatch(/^[A-Za-z]{3,}\.?,? /);
    expect(label).toMatch(/10[:.]00/);
  });

  it("names the date beyond a week, and the year beyond this one", () => {
    const older = formatMessageTime(new Date("2026-05-04T10:00:00").getTime(), NOW);
    expect(older).not.toContain("2026");
    expect(older).toMatch(/10[:.]00/);
    const lastYear = formatMessageTime(new Date("2025-12-31T10:00:00").getTime(), NOW);
    expect(lastYear).toContain("2025");
  });

  it("always says a time, whatever the date it carries", () => {
    for (const iso of [
      "2026-08-10T09:05:00",
      "2026-08-09T23:55:00",
      "2026-08-06T10:00:00",
      "2025-12-31T10:00:00",
    ]) {
      expect(formatMessageTime(new Date(iso).getTime(), NOW)).toMatch(/\d{1,2}[:.]\d{2}/);
    }
  });
});
