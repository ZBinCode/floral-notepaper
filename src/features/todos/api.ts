import { t, type TFunction } from "i18next";
import { invoke } from "@tauri-apps/api/core";
import type {
  CreateTodoListRequest,
  CreateTodoTagRequest,
  SaveTodoItemRequest,
  TodoArchiveEntry,
  TodoCompleteResult,
  TodoItem,
  TodoList,
  TodoTag,
  UpdateTodoTagRequest,
} from "./types";

export function listTodoLists(): Promise<TodoList[]> {
  return invoke("todo_lists_list");
}

export function createTodoList(request: CreateTodoListRequest): Promise<TodoList> {
  return invoke("todo_lists_create", { request });
}

export function renameTodoList(id: string, name: string): Promise<TodoList> {
  return invoke("todo_lists_rename", { id, name });
}

export function deleteTodoList(id: string): Promise<void> {
  return invoke("todo_lists_delete", { id });
}

export function reorderTodoLists(orderedIds: string[]): Promise<TodoList[]> {
  return invoke("todo_lists_reorder", { orderedIds });
}

export function listTodoTags(): Promise<TodoTag[]> {
  return invoke("todo_tags_list");
}

export function createTodoTag(request: CreateTodoTagRequest): Promise<TodoTag> {
  return invoke("todo_tags_create", { request });
}

export function updateTodoTag(id: string, request: UpdateTodoTagRequest): Promise<TodoTag> {
  return invoke("todo_tags_update", { id, request });
}

export function deleteTodoTag(id: string): Promise<void> {
  return invoke("todo_tags_delete", { id });
}

export function listTodoItems(listId?: string): Promise<TodoItem[]> {
  return invoke("todo_items_list", { listId: listId ?? null });
}

export function createTodoItem(request: SaveTodoItemRequest): Promise<TodoItem> {
  return invoke("todo_items_create", { request });
}

export function updateTodoItem(id: string, request: SaveTodoItemRequest): Promise<TodoItem> {
  return invoke("todo_items_update", { id, request });
}

export function deleteTodoItem(id: string): Promise<void> {
  return invoke("todo_items_delete", { id });
}

export function reorderTodoItems(listId: string, orderedIds: string[]): Promise<TodoItem[]> {
  return invoke("todo_items_reorder", { listId, orderedIds });
}

export function setTodoItemPinned(id: string, pinned: boolean): Promise<TodoItem> {
  return invoke("todo_items_set_pinned", { id, pinned });
}

export function completeTodoItem(id: string): Promise<TodoCompleteResult> {
  return invoke("todo_items_complete", { id });
}

export function restoreTodoItem(entryId: string): Promise<TodoItem> {
  return invoke("todo_items_restore", { entryId });
}

export function queryTodoArchive(
  from?: string | null,
  to?: string | null,
): Promise<TodoArchiveEntry[]> {
  return invoke("todo_archive_query", { from: from ?? null, to: to ?? null });
}

export function spawnTodoDue(): Promise<TodoItem[]> {
  return invoke("todo_spawn_due");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getTodoErrorMessage(error: unknown, translate: TFunction = t): string {
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    const code = typeof error.code === "string" ? error.code : "";
    switch (code) {
      case "todoListNameEmpty":
        return translate("errors.todoListNameEmpty", { defaultValue: "清单名不能为空" });
      case "todoListNameExists":
        return translate("errors.todoListNameExists", {
          defaultValue: "清单「{{name}}」已存在",
          name:
            isRecord(error.details) && typeof error.details.name === "string"
              ? error.details.name
              : "",
        });
      case "todoListNotFound":
        return translate("errors.todoListNotFound", { defaultValue: "找不到该清单" });
      case "todoTagNameEmpty":
        return translate("errors.todoTagNameEmpty", { defaultValue: "标签名不能为空" });
      case "todoTagNameExists":
        return translate("errors.todoTagNameExists", {
          defaultValue: "标签「{{name}}」已存在",
          name:
            isRecord(error.details) && typeof error.details.name === "string"
              ? error.details.name
              : "",
        });
      case "todoTagNotFound":
        return translate("errors.todoTagNotFound", { defaultValue: "找不到该标签" });
      case "todoItemNotFound":
        return translate("errors.todoItemNotFound", { defaultValue: "找不到该待办" });
      case "todoArchiveEntryNotFound":
        return translate("errors.todoArchiveEntryNotFound", { defaultValue: "找不到该归档条目" });
      case "todoTitleEmpty":
        return translate("errors.todoTitleEmpty", { defaultValue: "待办标题不能为空" });
      case "todoRecurrenceInvalid":
        return translate("errors.todoRecurrenceInvalid", { defaultValue: "重复规则无效" });
      default:
        return error.message;
    }
  }

  if (typeof error === "string" && error) {
    return error;
  }

  return translate("common.operationFailed", { defaultValue: "操作失败" });
}
