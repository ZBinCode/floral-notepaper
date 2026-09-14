import { describe, expect, it } from "vitest";
import { getFixedT } from "i18next";
import { i18n } from "../../locales";
import type { TodoItem, TodoList } from "./types";
import {
  TODO_TAG_PALETTE,
  arrayMove,
  buildReminderAt,
  filterTodoItemsByTag,
  groupTodoItems,
  hashString,
  parseTodoDate,
  reminderTimeValue,
  reorderIdsAfterDrop,
  sortTodoItems,
  todoCountdown,
  todoCountdownLabel,
  todoRecurrenceLabel,
  todoTagColor,
  toggleTagId,
} from "./todoUtils";

const today = new Date(2026, 8, 14);

function item(overrides: Partial<TodoItem> & Pick<TodoItem, "id">): TodoItem {
  return {
    listId: "list-1",
    title: overrides.id,
    pinned: false,
    sortOrder: 0,
    tagIds: [],
    dueDate: null,
    remindAt: null,
    recurrence: null,
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

describe("parseTodoDate", () => {
  it("parses valid ISO dates as local midnight", () => {
    const date = parseTodoDate("2026-09-14");
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(8);
    expect(date!.getDate()).toBe(14);
  });

  it("rejects malformed and out-of-range values", () => {
    expect(parseTodoDate("2026-9-14")).toBeNull();
    expect(parseTodoDate("2026-02-30")).toBeNull();
    expect(parseTodoDate("")).toBeNull();
    expect(parseTodoDate(null)).toBeNull();
    expect(parseTodoDate(undefined)).toBeNull();
  });
});

describe("todoCountdown", () => {
  it("classifies overdue, today and upcoming dates", () => {
    expect(todoCountdown("2026-09-12", today)).toEqual({ kind: "overdue", days: 2 });
    expect(todoCountdown("2026-09-14", today)).toEqual({ kind: "today", days: 0 });
    expect(todoCountdown("2026-09-16", today)).toEqual({ kind: "upcoming", days: 2 });
    expect(todoCountdown(null, today)).toBeNull();
  });

  it("crosses month boundaries correctly", () => {
    expect(todoCountdown("2026-08-31", today)).toEqual({ kind: "overdue", days: 14 });
    expect(todoCountdown("2026-10-01", today)).toEqual({ kind: "upcoming", days: 17 });
  });
});

describe("todoCountdownLabel", () => {
  it("renders localized labels including tomorrow", () => {
    const translate = getFixedT("zh-CN");
    expect(todoCountdownLabel({ kind: "overdue", days: 2 }, translate)).toBe("已过期 2 天");
    expect(todoCountdownLabel({ kind: "today", days: 0 }, translate)).toBe("今天");
    expect(todoCountdownLabel({ kind: "upcoming", days: 1 }, translate)).toBe("明天");
    expect(todoCountdownLabel({ kind: "upcoming", days: 5 }, translate)).toBe("还有 5 天");
    expect(todoCountdownLabel(null, translate)).toBeNull();
  });
});

describe("sortTodoItems", () => {
  it("places pinned items first then follows sort order", () => {
    const sorted = sortTodoItems([
      item({ id: "c", sortOrder: 2 }),
      item({ id: "pinned", sortOrder: 5, pinned: true }),
      item({ id: "a", sortOrder: 0 }),
      item({ id: "b", sortOrder: 1 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["pinned", "a", "b", "c"]);
  });

  it("breaks ties with createdAt then id", () => {
    const sorted = sortTodoItems([
      item({ id: "z", sortOrder: 1, createdAt: "2026-09-12T00:00:00Z" }),
      item({ id: "a", sortOrder: 1, createdAt: "2026-09-13T00:00:00Z" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["z", "a"]);
  });
});

describe("groupTodoItems", () => {
  it("groups items under lists in list order", () => {
    const lists: TodoList[] = [
      {
        id: "list-2",
        name: "二",
        sortOrder: 1,
        defaultTagIds: [],
        createdAt: "2026-09-10T00:00:00Z",
        updatedAt: "2026-09-10T00:00:00Z",
      },
      {
        id: "list-1",
        name: "一",
        sortOrder: 0,
        defaultTagIds: [],
        createdAt: "2026-09-10T00:00:00Z",
        updatedAt: "2026-09-10T00:00:00Z",
      },
    ];
    const groups = groupTodoItems(
      [item({ id: "x", listId: "list-2" }), item({ id: "m", listId: "list-1" })],
      lists,
    );
    expect(groups.map((group) => group.list.id)).toEqual(["list-2", "list-1"]);
    expect(groups[0].items.map((entry) => entry.id)).toEqual(["x"]);
    expect(groups[1].items.map((entry) => entry.id)).toEqual(["m"]);
  });
});

describe("arrayMove", () => {
  it("moves elements and ignores invalid indices", () => {
    expect(arrayMove(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(arrayMove(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(arrayMove(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(arrayMove(["a"], 0, 5)).toEqual(["a"]);
    expect(arrayMove(["a"], -1, 0)).toEqual(["a"]);
  });
});

describe("reorderIdsAfterDrop", () => {
  it("computes the ordered id list after a drag drop", () => {
    expect(reorderIdsAfterDrop(["a", "b", "c", "d"], "a", 3)).toEqual(["b", "c", "d", "a"]);
    expect(reorderIdsAfterDrop(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorderIdsAfterDrop(["a", "b"], "missing", 1)).toEqual(["a", "b"]);
  });
});

describe("todoTagColor", () => {
  it("prefers the saved color", () => {
    expect(todoTagColor({ name: "工作", color: "#ff0000" })).toBe("#ff0000");
    expect(todoTagColor({ name: "工作", color: "  " })).not.toBe("");
  });

  it("derives a stable palette color from the tag name", () => {
    const first = todoTagColor({ name: "紧急", color: "" });
    const second = todoTagColor({ name: "紧急", color: "" });
    expect(first).toBe(second);
    expect([...TODO_TAG_PALETTE]).toContain(first);
  });

  it("hashString returns stable non-negative values", () => {
    expect(hashString("花笺")).toBe(hashString("花笺"));
    expect(hashString("花笺")).not.toBe(hashString("花信"));
    expect(hashString("")).toBeGreaterThanOrEqual(0);
  });
});

describe("filterTodoItemsByTag and toggleTagId", () => {
  it("filters items by tag id and passes everything when null", () => {
    const entries = [item({ id: "a", tagIds: ["t1"] }), item({ id: "b", tagIds: ["t2"] })];
    expect(filterTodoItemsByTag(entries, "t1").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterTodoItemsByTag(entries, null)).toHaveLength(2);
  });

  it("toggles tag ids without mutating the input", () => {
    const base = ["t1", "t2"];
    expect(toggleTagId(base, "t3")).toEqual(["t1", "t2", "t3"]);
    expect(toggleTagId(base, "t1")).toEqual(["t2"]);
    expect(base).toEqual(["t1", "t2"]);
  });
});

describe("buildReminderAt and reminderTimeValue", () => {
  it("combines a local date and time into a UTC ISO timestamp", () => {
    const iso = buildReminderAt("2026-09-14", "09:30");
    expect(iso).not.toBeNull();
    const parsed = new Date(iso!);
    expect(parsed.getUTCHours() - parsed.getTimezoneOffset() / 60).not.toBeNaN();
    // 本地 09:30 组装回本地时间应还原
    expect(parsed.getHours()).toBe(9);
    expect(parsed.getMinutes()).toBe(30);
    expect(parsed.getFullYear()).toBe(2026);
  });

  it("returns null for missing parts or invalid values", () => {
    expect(buildReminderAt(null, "09:30")).toBeNull();
    expect(buildReminderAt("2026-09-14", "")).toBeNull();
    expect(buildReminderAt("2026-02-30", "09:30")).toBeNull();
    expect(buildReminderAt("2026-09-14", "24:00")).toBeNull();
    expect(buildReminderAt("2026-09-14", "099")).toBeNull();
  });

  it("extracts local HH:mm from an ISO reminder", () => {
    const iso = new Date(2026, 8, 14, 9, 5).toISOString();
    expect(reminderTimeValue(iso)).toBe("09:05");
    expect(reminderTimeValue(null)).toBe("");
    expect(reminderTimeValue("not a date")).toBe("");
  });
});

describe("todoRecurrenceLabel", () => {
  it("labels simple and interval rules", () => {
    const translate = i18n.getFixedT("zh-CN");
    expect(
      todoRecurrenceLabel(
        { freq: "daily", interval: 1, byWeekdays: [], anchorDate: "2026-09-14" },
        translate,
      ),
    ).toBe("每天");
    expect(
      todoRecurrenceLabel(
        { freq: "weekly", interval: 3, byWeekdays: [], anchorDate: "2026-09-14" },
        translate,
      ),
    ).toBe("每 3 周");
  });
});
