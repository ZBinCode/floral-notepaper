import type { TFunction } from "i18next";
import type { TodoItem, TodoList, TodoRecurrenceRule, SaveTodoItemRequest, TodoTag } from "./types";

/** 标签调色板：低饱和的自然色系，与 bamboo 主题色协调 */
export const TODO_TAG_PALETTE = [
  "#7fa98c",
  "#e2a85f",
  "#d97b66",
  "#8f9fd6",
  "#b58cc9",
  "#6fb3c4",
  "#c9a227",
  "#a8a29a",
] as const;

export function hashString(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** 标签颜色：优先使用已保存颜色，缺省时按名字哈希落到调色板（同名稳定） */
export function todoTagColor(tag: Pick<TodoTag, "name" | "color">): string {
  const saved = tag.color?.trim();
  if (saved) return saved;
  return TODO_TAG_PALETTE[hashString(tag.name) % TODO_TAG_PALETTE.length];
}

/** 按标签跨清单筛选（null 表示不过滤） */
export function filterTodoItemsByTag(items: TodoItem[], tagId: string | null): TodoItem[] {
  if (!tagId) return items;
  return items.filter((item) => item.tagIds.includes(tagId));
}

export function toggleTagId(tagIds: readonly string[], tagId: string): string[] {
  return tagIds.includes(tagId) ? tagIds.filter((id) => id !== tagId) : [...tagIds, tagId];
}

export interface TodoCountdown {
  kind: "overdue" | "today" | "upcoming";
  days: number;
}

/** 解析 "YYYY-MM-DD" 为本地时区的当日零点；非法输入返回 null */
export function parseTodoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function todoCountdown(
  dueDate: string | null | undefined,
  today: Date = new Date(),
): TodoCountdown | null {
  const due = parseTodoDate(dueDate);
  if (!due) return null;
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((due.getTime() - todayStart.getTime()) / 86_400_000);
  if (diff < 0) return { kind: "overdue", days: -diff };
  if (diff === 0) return { kind: "today", days: 0 };
  return { kind: "upcoming", days: diff };
}

export function todoCountdownLabel(
  countdown: TodoCountdown | null,
  translate: TFunction,
): string | null {
  if (!countdown) return null;
  if (countdown.kind === "overdue") {
    return translate("todo.countdown.overdue", {
      defaultValue: "已过期 {{count}} 天",
      count: countdown.days,
    });
  }
  if (countdown.kind === "today") {
    return translate("todo.countdown.today", { defaultValue: "今天" });
  }
  if (countdown.days === 1) {
    return translate("todo.countdown.tomorrow", { defaultValue: "明天" });
  }
  return translate("todo.countdown.upcoming", {
    defaultValue: "还有 {{count}} 天",
    count: countdown.days,
  });
}

/** 展示顺序：置顶在前，其余按 sortOrder / createdAt 稳定排序 */
export function sortTodoItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  });
}

export interface TodoListGroup {
  list: TodoList;
  items: TodoItem[];
}

/** 跨清单聚合视图：按清单自身顺序分节，节内按展示顺序 */
export function groupTodoItems(items: TodoItem[], lists: TodoList[]): TodoListGroup[] {
  return lists.map((list) => ({
    list,
    items: sortTodoItems(items.filter((item) => item.listId === list.id)),
  }));
}

/** 数组元素移动（拖拽排序的基础），返回新数组 */
export function arrayMove<T>(array: readonly T[], from: number, to: number): T[] {
  const result = [...array];
  if (from < 0 || from >= result.length || to < 0 || to >= result.length || from === to) {
    return result;
  }
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved!);
  return result;
}

/** 拖拽落点计算：把 dragId 移动到显示序列的 targetIndex 处，得到新的有序 id 列表 */
export function reorderIdsAfterDrop(
  orderedIds: readonly string[],
  dragId: string,
  targetIndex: number,
): string[] {
  const from = orderedIds.indexOf(dragId);
  if (from < 0) return [...orderedIds];
  const target = Math.max(0, Math.min(targetIndex, orderedIds.length - 1));
  return arrayMove(orderedIds, from, target);
}

/** 由本地日期 + "HH:mm" 组装提醒时刻（UTC ISO）；任一为空返回 null */
export function buildReminderAt(dueDate: string | null | undefined, time: string): string | null {
  if (!dueDate || !time) return null;
  const date = parseTodoDate(dueDate);
  if (!date) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
  const iso = local.toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** 从提醒时刻提取本地 "HH:mm" 作为时间输入框的显示值 */
export function reminderTimeValue(remindAt: string | null | undefined): string {
  if (!remindAt) return "";
  const date = new Date(remindAt);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** 以现有待办为基底构造全量更新请求（update 是替换语义） */
export function saveRequestFromItem(
  item: TodoItem,
  overrides: Partial<
    Pick<
      SaveTodoItemRequest,
      "title" | "pinned" | "tagIds" | "dueDate" | "remindAt" | "recurrence" | "listId"
    >
  > = {},
): SaveTodoItemRequest {
  return {
    listId: overrides.listId ?? item.listId,
    title: overrides.title ?? item.title,
    pinned: overrides.pinned ?? item.pinned,
    tagIds: overrides.tagIds ?? [...item.tagIds],
    dueDate: "dueDate" in overrides ? (overrides.dueDate ?? null) : (item.dueDate ?? null),
    remindAt: "remindAt" in overrides ? (overrides.remindAt ?? null) : (item.remindAt ?? null),
    recurrence:
      "recurrence" in overrides ? (overrides.recurrence ?? null) : (item.recurrence ?? null),
  };
}

const RECURRENCE_FREQ_LABEL_KEYS: Record<TodoRecurrenceRule["freq"], string> = {
  daily: "todo.recurrence.daily",
  weekly: "todo.recurrence.weekly",
  monthly: "todo.recurrence.monthly",
  yearly: "todo.recurrence.yearly",
};

const RECURRENCE_UNIT_KEYS: Record<TodoRecurrenceRule["freq"], { label: string; unit: string }> = {
  daily: { label: "todo.recurrence.daily", unit: "todo.recurrence.unitDay" },
  weekly: { label: "todo.recurrence.weekly", unit: "todo.recurrence.unitWeek" },
  monthly: { label: "todo.recurrence.monthly", unit: "todo.recurrence.unitMonth" },
  yearly: { label: "todo.recurrence.yearly", unit: "todo.recurrence.unitYear" },
};

const RECURRENCE_DEFAULTS: Record<TodoRecurrenceRule["freq"], { label: string; unit: string }> = {
  daily: { label: "每天", unit: "天" },
  weekly: { label: "每周", unit: "周" },
  monthly: { label: "每月", unit: "月" },
  yearly: { label: "每年", unit: "年" },
};

export function todoRecurrenceLabel(rule: TodoRecurrenceRule, translate: TFunction): string {
  const unitKeys = RECURRENCE_UNIT_KEYS[rule.freq];
  const defaults = RECURRENCE_DEFAULTS[rule.freq];
  if (rule.interval > 1) {
    return translate("todo.recurrence.everyInterval", {
      defaultValue: "每 {{interval}} {{unit}}",
      interval: rule.interval,
      unit: translate(unitKeys.unit, { defaultValue: defaults.unit }),
    });
  }
  return translate(RECURRENCE_FREQ_LABEL_KEYS[rule.freq], { defaultValue: defaults.label });
}
