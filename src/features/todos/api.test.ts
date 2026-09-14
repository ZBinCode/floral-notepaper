import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFixedT } from "i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  completeTodoItem,
  createTodoItem,
  getTodoErrorMessage,
  listTodoItems,
  reorderTodoItems,
  spawnTodoDue,
} from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("todo api command wrappers", () => {
  it("lists all items without a list filter", async () => {
    mockedInvoke.mockResolvedValue([]);
    await listTodoItems();
    expect(mockedInvoke).toHaveBeenCalledWith("todo_items_list", { listId: null });
  });

  it("passes camelCase payloads matching the Rust command args", async () => {
    mockedInvoke.mockResolvedValue({});
    await listTodoItems("list-1");
    await createTodoItem({
      listId: "list-1",
      title: "买菜",
      pinned: false,
      tagIds: [],
      dueDate: null,
      remindAt: null,
      recurrence: null,
    });
    await completeTodoItem("item-1");
    await reorderTodoItems("list-1", ["b", "a"]);
    await spawnTodoDue();

    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "todo_items_list", { listId: "list-1" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "todo_items_create", {
      request: {
        listId: "list-1",
        title: "买菜",
        pinned: false,
        tagIds: [],
        dueDate: null,
        remindAt: null,
        recurrence: null,
      },
    });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "todo_items_complete", { id: "item-1" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(4, "todo_items_reorder", {
      listId: "list-1",
      orderedIds: ["b", "a"],
    });
    expect(mockedInvoke).toHaveBeenNthCalledWith(5, "todo_spawn_due");
  });
});

describe("getTodoErrorMessage", () => {
  const translate = getFixedT("zh-CN");

  it("maps structured error codes to localized messages", () => {
    expect(
      getTodoErrorMessage({ code: "todoTitleEmpty", message: "待办标题不能为空" }, translate),
    ).toBe("待办标题不能为空");
    expect(
      getTodoErrorMessage(
        { code: "todoListNameExists", message: "清单「工作」已存在", details: { name: "工作" } },
        translate,
      ),
    ).toBe("清单「工作」已存在");
  });

  it("falls back to the raw message and a generic one", () => {
    expect(getTodoErrorMessage({ code: "io", message: "disk error" }, translate)).toBe(
      "disk error",
    );
    expect(getTodoErrorMessage({ code: "io" }, translate)).toBe("操作失败");
    expect(getTodoErrorMessage("plain string", translate)).toBe("plain string");
    expect(getTodoErrorMessage(undefined, translate)).toBe("操作失败");
  });
});
